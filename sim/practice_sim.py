"""Practice-squad simulator on the real game server.

Fills a private room on play.joinbuilders.org with our test bot plus 15 squad hunters (sim/hunter.ts) that, like the
practice house bots, only hunt the test bot, never fight each other, share what they see, and join in waves:
one at 20 s, two more per hunter the test bot kills, all at 240 s; weakest tier first.

    python3 sim/practice_sim.py --arena <kit>/arena --games 4 --out data/psim -- bun bot.ts

Prints each game's place and the mean of 16 - place (the practice score).
"""
import argparse, asyncio, gzip, json, os, random, secrets, ssl, sys, time, urllib.request

HOST = "play.joinbuilders.org"
HERE = os.path.dirname(os.path.abspath(__file__))
TIERS = [2.6] * 4 + [1.5] * 4 + [0.9] * 4 + [0.5] * 3  # aim noise (deg): easy, medium, hard, expert


def new_room(sid):
    for attempt in range(6):
        try:
            with urllib.request.urlopen(f"https://{HOST}/mm/code/new?sid={sid}", timeout=15) as r:
                d = json.loads(r.read())
            if "code" in d:
                return d["room"], d["code"]
        except Exception as e:
            print(f"room create failed ({e}); retry {attempt + 1}", file=sys.stderr, flush=True)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError("could not create a room")


class Client:
    def __init__(self, idx, cmd, env, name):
        self.idx, self.cmd, self.env, self.name = idx, cmd, env, name
        self.sid = secrets.token_hex(16)
        self.ws = None
        self.proc = None
        self.slot = None
        self.end = None
        self.dead = False

    async def feed(self, line):
        try:
            self.proc.stdin.write(line.encode() + b"\n")
            await self.proc.stdin.drain()
        except (ConnectionResetError, BrokenPipeError, AttributeError):
            pass


async def play_game(n, args, ctx):
    import websockets
    host_sid = secrets.token_hex(16)
    room, code = new_room(host_sid)
    clients = [Client(0, args.bot, dict(os.environ), args.name)]
    clients[0].sid = host_sid
    for i, sg in enumerate(TIERS):
        env = dict(os.environ, HUNTER_SIGMA_DEG=str(sg * args.noise_scale))
        clients.append(Client(i + 1, ["bun", os.path.join(HERE, "hunter.ts")], env, f"hunter{i + 1}"))
    state = {"t": 0.0, "kills": 0, "target": None, "pos": None, "seen_t": -99.0, "intel_t": -99.0,
             "active": set(), "started": False, "done": False, "result": None}
    order = list(range(1, 16))  # weakest first

    def update_active():
        want = 0
        if state["t"] >= args.first_join:
            want = 1 + args.per_kill * state["kills"]
        if state["t"] >= args.all_at:
            want = 15
        alive = [c.idx for c in clients[1:] if not c.dead]
        for i in order:
            if len(state["active"] & set(alive)) >= want:
                break
            if i in alive:
                state["active"].add(i)

    async def run_client(c):
        q = f"token=&sid={c.sid}&name={c.name}&code={code}"
        c.proc = await asyncio.create_subprocess_exec(*c.cmd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                      stderr=asyncio.subprocess.DEVNULL, env=c.env)
        async with websockets.connect(f"wss://{HOST}/r/{room}/play?{q}", ssl=ctx, max_size=None, proxy=True,
                                      open_timeout=30, ping_interval=20) as ws:
            c.ws = ws
            await ws.send(json.dumps({"type": "ready", "name": c.name}))

            async def pump():
                while True:
                    line = await c.proc.stdout.readline()
                    if not line:
                        return
                    try:
                        msg = json.loads(line)
                    except Exception:
                        continue
                    if msg.get("type") == "ready":
                        continue
                    msg.pop("debug", None)
                    try:
                        await ws.send(json.dumps(msg))
                    except Exception:
                        return
            pt = asyncio.create_task(pump())
            try:
                while not state["done"]:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), 5)
                    except asyncio.TimeoutError:
                        continue
                    m = json.loads(raw)
                    ty = m.get("type")
                    if ty == "lobby":
                        if c.idx == 0 and not state["started"]:
                            players = m.get("players") or []
                            if len(players) >= 16 and all(p.get("ready") for p in players):
                                await ws.send(json.dumps({"type": "start"}))
                                state["started"] = True
                    elif ty == "hello":
                        c.slot = m.get("slot")
                        if c.idx == 0:
                            state["target"] = c.slot
                        m["map"]["dir"] = args.arena
                        await c.feed(json.dumps(m))
                        await ws.send(json.dumps({"type": "loaded"}))
                    elif ty == "obs":
                        state["t"] = max(state["t"], m.get("t", 0))
                        if c.idx == 0:
                            for e in m.get("events", []):
                                if e.get("type") == "kill":
                                    state["kills"] += 1
                            # squad position intel every 8 s
                            if m["t"] - state["intel_t"] >= args.intel_period:
                                state["pos"] = m["self"]["pos"]
                                state["intel_t"] = m["t"]
                            await c.feed(raw if isinstance(raw, str) else raw.decode())
                        else:
                            tgt = state["target"]
                            for mm in m.get("mechs", []):
                                if mm.get("id") == tgt:  # shared vision
                                    state["pos"] = mm["pos"]
                                    state["seen_t"] = m["t"]
                            update_active()
                            m["intel"] = {"target": tgt, "active": c.idx in state["active"], "pos": state["pos"]}
                            await c.feed(json.dumps(m))
                    elif ty == "end":
                        c.end = m
                        c.dead = True
                        await c.feed(json.dumps(m))
                        if c.idx == 0:
                            state["result"] = {"place": m.get("place"), "kills": m.get("kills"), "t": state["t"]}
                            state["done"] = True
                        else:
                            update_active()
                    elif ty == "results":
                        state["done"] = True
            finally:
                pt.cancel()
                try:
                    c.proc.kill()
                except Exception:
                    pass

    print(f"game {n}: room {room} code {code}", flush=True)

    async def record():
        path = os.path.join(args.out, f"psim-{int(time.time())}-{n}.jsonl.gz")
        q = f"token=&sid={host_sid}&name=rec&code={code}"
        try:
            async with websockets.connect(f"wss://{HOST}/r/{room}/live?{q}", ssl=ctx, max_size=None, proxy=True, open_timeout=30) as ws:
                with gzip.open(path, "wt") as f:
                    while not state["done"]:
                        try:
                            m = await asyncio.wait_for(ws.recv(), 2)
                        except asyncio.TimeoutError:
                            continue
                        for line in str(m).split("\n"):
                            if line.strip():
                                f.write(f'{{"_rt":{time.time():.2f},"d":{line}}}\n')
        except Exception as e:
            print(f"recorder: {repr(e)[:100]}", file=sys.stderr)
    rec_task = asyncio.create_task(record()) if args.record else None
    tasks = [asyncio.create_task(run_client(clients[0]))]
    await asyncio.sleep(2)  # the test bot joins first and is the host
    for c in clients[1:]:
        tasks.append(asyncio.create_task(run_client(c)))
        await asyncio.sleep(0.15)
    t0 = time.time()
    while not state["done"] and time.time() - t0 < args.timeout:
        await asyncio.sleep(1)
    state["done"] = True
    await asyncio.sleep(2)
    for tk in tasks + ([rec_task] if rec_task else []):
        tk.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    return state["result"]


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arena", required=True)
    ap.add_argument("--out", default="data/psim")
    ap.add_argument("--games", type=int, default=1)
    ap.add_argument("--name", default="test")
    ap.add_argument("--timeout", type=float, default=600)
    ap.add_argument("--first-join", type=float, default=20)
    ap.add_argument("--per-kill", type=int, default=2)
    ap.add_argument("--all-at", type=float, default=240)
    ap.add_argument("--intel-period", type=float, default=8)
    ap.add_argument("--noise-scale", type=float, default=1.0)
    ap.add_argument("--record", action="store_true", help="save a spectator replay of each game")
    ap.add_argument("bot", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    args.bot = [a for a in args.bot if a != "--"]
    os.makedirs(args.out, exist_ok=True)
    ctx = ssl.create_default_context(cafile=os.environ.get("MF_CA"))
    places = []
    for n in range(args.games):
        try:
            r = await play_game(n, args, ctx)
        except Exception as e:
            print(f"game {n}: failed {repr(e)[:160]}", flush=True)
            await asyncio.sleep(15)
            continue
        if r and r.get("place"):
            places.append(r["place"])
            print(f"game {n}: place {r['place']} kills {r['kills']} died at {r['t']:.0f}s", flush=True)
            with open(os.path.join(args.out, "results.jsonl"), "a") as f:
                f.write(json.dumps(r) + "\n")
        else:
            print(f"game {n}: no result {r}", flush=True)
    if places:
        print(f"games {len(places)}  practice-style score (16 - place) {sum(16 - p for p in places) / len(places):.2f}  places {places}")


asyncio.run(main())
