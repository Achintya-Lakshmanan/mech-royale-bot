"""Practice-squad simulator on the real game server.

Fills a private room on play.joinbuilders.org with our test bot plus 15 squad hunters (sim/hunter.ts) that, like the
practice house bots, only hunt the test bot, never fight each other, share what they see, and join in waves, weakest
tier first: one at --first-join, then the number of *alive* active hunters is kept at 1 + K * kills (K =
--alive-per-kill: 0, 1 or 2), and all join at --all-at. Inactive hunters are passive (stay in the zone, pick up their
weapon, shoot only drones that attack them), or with --defend-s N fight back for N s when the test bot hits them.

    python3 sim/practice_sim.py --arena <kit>/arena --games 8 --out data/psim -- bun bot.ts

Prints each game's place and the mean of 16 - place (the practice score), and appends one JSON line per game to
<out>/results.jsonl (kills, death time, activation times, hunter deaths and their causes, hunter hit rates).

Calibration (2026-11-21, see sim/calibrate.py --pool): the defaults (--alive-per-kill 0, passive, --noise-scale 1,
intel unseen 8 s +-20 m) fit best: example 1.25 (real 1.15), fe5cfb6 3.9 (2.69), cc22d2d 4.75 (4.81), but per-game
spread is large (SD 2-5: a bot can massacre passive hunters late), so 8 games only separate differences of ~2 points.
Settings tried: K=1 (too hard: 1.0/1.0/2.0), K=0 noise 1.25 (too easy: 1.75/4.6/7.0), --defend-s 6 (too hard).
"""
import argparse, asyncio, gzip, json, math, os, random, secrets, ssl, sys, time, urllib.request

HOST = "play.joinbuilders.org"
HERE = os.path.dirname(os.path.abspath(__file__))
TIER_SIZES = [4, 4, 4, 3]  # easy, medium, hard, expert (weakest first)
TIER_NAMES = ["easy", "medium", "hard", "expert"]


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


def parse_mix(s):
    out = []
    for part in s.split(","):
        k, v = part.split(":")
        out.append((k.strip(), float(v)))
    tot = sum(v for _, v in out)
    return [(k, v / tot) for k, v in out]


class Client:
    def __init__(self, idx, cmd, env, name, tier=None, loadout=None):
        self.idx, self.cmd, self.env, self.name = idx, cmd, env, name
        self.tier, self.loadout = tier, loadout
        self.sid = secrets.token_hex(16)
        self.proc = None
        self.slot = None
        self.dead = False
        self.ready = False
        self.death_t = None
        self.last_dmg = None  # (t, weapon, by) of the last damage this hunter took
        self.hstat = None

    async def feed(self, line):
        try:
            self.proc.stdin.write(line.encode() + b"\n")
            await self.proc.stdin.drain()
        except (ConnectionResetError, BrokenPipeError, AttributeError):
            pass

    async def stop(self):
        p = self.proc
        if p is None or p.returncode is not None:
            return
        try:
            p.terminate()
            await asyncio.wait_for(p.wait(), 2)
        except Exception:
            try:
                p.kill()
                await asyncio.wait_for(p.wait(), 5)
            except Exception:
                pass


async def play_game(n, args, ctx, rnd):
    import websockets
    host_sid = secrets.token_hex(16)
    room, code = new_room(host_sid)
    clients = [Client(0, args.bot, dict(os.environ), args.name)]
    clients[0].sid = host_sid
    mix = parse_mix(args.loadout_mix)
    tiers = [float(x) for x in args.tiers.split(",")]
    hi = 1
    for ti, (size, sg) in enumerate(zip(TIER_SIZES, tiers)):
        for _ in range(size):
            r, lo = rnd.random(), "none"
            for k, v in mix:
                if r < v:
                    lo = k
                    break
                r -= v
            env = dict(os.environ, HUNTER_SIGMA_DEG=str(sg * args.noise_scale), HUNTER_LOADOUT=lo,
                       HUNTER_DEFEND_S=str(args.defend_s), HUNTER_GUN_MAX=str(args.gun_max))
            clients.append(Client(hi, ["bun", os.path.join(HERE, "hunter.ts")], env, f"hunter{hi}", TIER_NAMES[ti], lo))
            hi += 1
    st = {"t": 0.0, "kills": [], "target": None, "pos": None, "true_pos": None, "seen_t": -99.0, "intel_t": -99.0,
          "active": {}, "started": False, "result": None, "kill_targets": set(), "dmg": {}}
    done = asyncio.Event()
    order = list(range(1, 16))  # weakest first

    def jitter(p):
        if not p:
            return p
        a, r = rnd.random() * 2 * math.pi, args.intel_jitter * math.sqrt(rnd.random())
        return [p[0] + r * math.cos(a), p[1] + r * math.sin(a), p[2]]

    def update_intel():
        t = st["t"]
        if st["true_pos"] is None:
            return
        if args.intel_mode == "periodic":
            due = t - st["intel_t"] >= args.intel_period
        else:  # only when no hunter has seen the target for intel_period
            due = t - st["seen_t"] >= args.intel_period and t - st["intel_t"] >= args.intel_period
        if due:
            st["pos"] = jitter(st["true_pos"])
            st["intel_t"] = t

    def update_active():
        t = st["t"]
        want = 0
        if t >= args.first_join:
            want = 1 + args.alive_per_kill * len(st["kills"])
        if t >= args.all_at:
            want = 15
        alive = {c.idx for c in clients[1:] if not c.dead}
        n_act = len(set(st["active"]) & alive)
        for i in order:
            if n_act >= want:
                break
            if i in alive and i not in st["active"]:
                st["active"][i] = round(t, 1)
                n_act += 1

    async def read_stderr(c):
        try:
            while True:
                line = await c.proc.stderr.readline()
                if not line:
                    return
                if line.startswith(b"HSTAT "):
                    try:
                        c.hstat = json.loads(line[6:])
                    except Exception:
                        pass
        except Exception:
            return

    async def run_client(c):
        q = f"token=&sid={c.sid}&name={c.name}&code={code}"
        ws = None
        for attempt in range(3):
            try:
                ws = await websockets.connect(f"wss://{HOST}/r/{room}/play?{q}", ssl=ctx, max_size=None, proxy=True,
                                              open_timeout=30, ping_interval=20)
                break
            except Exception as e:
                print(f"  {c.name}: connect failed ({repr(e)[:80]}); retry", file=sys.stderr, flush=True)
                await asyncio.sleep(2 + 2 * attempt)
        if ws is None:
            return
        c.proc = await asyncio.create_subprocess_exec(
            *c.cmd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE if c.idx else asyncio.subprocess.DEVNULL, env=c.env)
        et = asyncio.create_task(read_stderr(c)) if c.idx else None

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
            await ws.send(json.dumps({"type": "ready", "name": c.name}))
            while not done.is_set():
                try:
                    raw = await asyncio.wait_for(ws.recv(), 1)
                except asyncio.TimeoutError:
                    continue
                m = json.loads(raw)
                ty = m.get("type")
                if ty == "lobby":
                    c.ready = True
                    if c.idx == 0 and not st["started"]:
                        players = m.get("players") or []
                        if len(players) >= 16 and all(p.get("ready") for p in players):
                            await ws.send(json.dumps({"type": "start"}))
                            st["started"] = True
                elif ty == "hello":
                    c.slot = m.get("slot")
                    if c.idx == 0:
                        st["target"] = c.slot
                    m["map"]["dir"] = args.arena
                    await c.feed(json.dumps(m))
                    await ws.send(json.dumps({"type": "loaded"}))
                elif ty == "obs":
                    st["t"] = max(st["t"], m.get("t", 0))
                    t = m.get("t", 0)
                    if c.idx == 0:
                        for e in m.get("events", []):
                            if e.get("type") == "kill":
                                st["kills"].append(round(t, 1))
                                st["kill_targets"].add(e.get("target"))
                            elif e.get("type") == "damaged":  # damage the test bot took, by attacker tier and weapon
                                hc = next((h for h in clients[1:] if h.slot is not None and h.slot == e.get("by")), None)
                                k = f"{hc.tier if hc else 'other'}/{e.get('weapon')}"
                                st["dmg"][k] = round(st["dmg"].get(k, 0) + (e.get("amount") or 0))
                        st["true_pos"] = m["self"]["pos"]
                        update_intel()
                        await c.feed(raw if isinstance(raw, str) else raw.decode())
                    else:
                        tgt = st["target"]
                        for e in m.get("events", []):
                            if e.get("type") == "damaged":
                                c.last_dmg = (round(t, 1), e.get("weapon"), e.get("by"))
                        for mm in m.get("mechs", []):
                            if mm.get("id") == tgt:  # shared vision
                                st["pos"] = mm["pos"]
                                st["seen_t"] = t
                        update_intel()
                        update_active()
                        m["intel"] = {"target": tgt, "active": c.idx in st["active"], "pos": st["pos"]}
                        await c.feed(json.dumps(m))
                elif ty == "end":
                    c.dead = True
                    c.death_t = round(st["t"], 1)
                    await c.feed(json.dumps(m))
                    if c.idx == 0:
                        st["result"] = {"place": m.get("place"), "kills": m.get("kills"), "t": round(st["t"], 1)}
                        done.set()
                    else:
                        update_active()
                elif ty == "results":
                    done.set()
        except Exception as e:
            if not done.is_set():
                print(f"  {c.name}: {repr(e)[:100]}", file=sys.stderr, flush=True)
        finally:
            pt.cancel()
            await c.stop()
            if et:
                try:
                    await asyncio.wait_for(et, 2)
                except Exception:
                    et.cancel()
            try:
                await ws.close()
            except Exception:
                pass

    print(f"{time.strftime('%H:%M:%S')} game {n}: room {room} code {code}", flush=True)

    async def record():
        path = os.path.join(args.out, f"psim-{int(time.time())}-{n}.jsonl.gz")
        q = f"token=&sid={host_sid}&name=rec&code={code}"
        try:
            async with websockets.connect(f"wss://{HOST}/r/{room}/live?{q}", ssl=ctx, max_size=None, proxy=True, open_timeout=30) as ws:
                with gzip.open(path, "wt") as f:
                    while not done.is_set():
                        try:
                            m = await asyncio.wait_for(ws.recv(), 2)
                        except asyncio.TimeoutError:
                            continue
                        if isinstance(m, bytes):
                            m = m.decode()
                        for line in m.split("\n"):
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
    aborted = None
    while not done.is_set():
        if time.time() - t0 > args.timeout:
            aborted = "timeout"
            break
        if tasks[0].done():
            aborted = "test bot disconnected"
            break
        if not st["started"] and time.time() - t0 > args.start_timeout:
            aborted = f"start timeout ({sum(c.ready for c in clients)}/16 joined)"
            break
        await asyncio.sleep(0.5)
    done.set()
    await asyncio.gather(*tasks, return_exceptions=True)
    if rec_task:
        rec_task.cancel()
    if aborted:
        raise RuntimeError(aborted)
    r = st["result"]
    if r is None:
        return None
    # per-game log
    slot2c = {c.slot: c for c in clients[1:]}
    deaths, other = [], []
    for c in clients[1:]:
        if c.dead and c.death_t is not None and c.death_t <= r["t"] + 0.5:
            by_test = c.slot in st["kill_targets"]
            d = {"h": c.idx, "tier": c.tier, "t": c.death_t, "by_test": by_test, "last_dmg": c.last_dmg}
            deaths.append(d)
            if not by_test:
                other.append(d)
    hits = {}
    for c in clients[1:]:
        for w, bins in (c.hstat or {}).items():
            for b, (s, h) in bins.items():
                k = (c.tier, w, int(b))
                a = hits.setdefault(k, [0, 0])
                a[0] += s
                a[1] += h
    r.update(score=16 - r["place"] if r.get("place") else None, kill_times=st["kills"],
             activations={str(i): (clients[i].tier, t) for i, t in sorted(st["active"].items())},
             loadouts=[c.loadout for c in clients[1:]], damage_taken=st["dmg"], hunter_deaths=deaths, other_deaths=len(other),
             hits={f"{k[0]}/{k[1]}/{k[2]}": v for k, v in sorted(hits.items())})
    return r


def summarize_hits(rows):
    """pooled hit rates by tier/weapon/30 m bin over all games"""
    agg = {}
    for r in rows:
        for k, (s, h) in r.get("hits", {}).items():
            a = agg.setdefault(k, [0, 0])
            a[0] += s
            a[1] += h
    out = []
    for k in sorted(agg, key=lambda k: (k.split("/")[0], k.split("/")[1], int(k.split("/")[2]))):
        s, h = agg[k]
        if s >= 10:
            out.append(f"{k}: {h}/{s}={h / s:.2f}")
    return out


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arena", required=True)
    ap.add_argument("--out", default="data/psim")
    ap.add_argument("--games", type=int, default=1)
    ap.add_argument("--name", default="test")
    ap.add_argument("--timeout", type=float, default=600)
    ap.add_argument("--start-timeout", type=float, default=120, help="abort the game if it has not started by then")
    ap.add_argument("--first-join", type=float, default=20)
    ap.add_argument("--alive-per-kill", type=int, default=0, choices=[0, 1, 2],
                    help="alive active hunters = 1 + K * (test bot kills)")
    ap.add_argument("--all-at", type=float, default=240)
    ap.add_argument("--defend-s", type=float, default=0, help="inactive hunters fight back for N s when hit (0: passive)")
    ap.add_argument("--intel-mode", choices=["unseen", "periodic"], default="unseen",
                    help="unseen: true position (with jitter) only after no hunter has seen the target for --intel-period")
    ap.add_argument("--intel-period", type=float, default=8)
    ap.add_argument("--intel-jitter", type=float, default=20)
    ap.add_argument("--tiers", default="2.6,1.5,0.9,0.5", help="aim noise sigma (deg) per tier, easy..expert")
    ap.add_argument("--noise-scale", type=float, default=1.0)
    ap.add_argument("--gun-max", type=float, default=150)
    ap.add_argument("--loadout-mix", default="laser:.37,lightning:.26,mortar:.19,none:.18")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--record", action="store_true", help="save a spectator replay of each game")
    ap.add_argument("bot", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    args.bot = [a for a in args.bot if a != "--"]
    os.makedirs(args.out, exist_ok=True)
    ctx = ssl.create_default_context(cafile=os.environ.get("MF_CA"))
    rnd = random.Random(args.seed)
    rows, n, fails = [], 0, 0
    while len(rows) < args.games and fails < args.games + 3:
        try:
            r = await play_game(n, args, ctx, rnd)
        except Exception as e:
            print(f"{time.strftime('%H:%M:%S')} game {n}: failed {repr(e)[:160]}", flush=True)
            fails += 1
            n += 1
            await asyncio.sleep(10)
            continue
        n += 1
        if r and r.get("place"):
            rows.append(r)
            act = " ".join(f"{t:.0f}" for _, t in r["activations"].values())
            print(f"{time.strftime('%H:%M:%S')} game {n - 1}: place {r['place']} score {r['score']} kills {r['kills']} at {r['kill_times']} "
                  f"died {r['t']:.0f}s  other-deaths {r['other_deaths']}  activations [{act}]", flush=True)
            with open(os.path.join(args.out, "results.jsonl"), "a") as f:
                f.write(json.dumps(r) + "\n")
        else:
            fails += 1
            print(f"game {n - 1}: no result {r}", flush=True)
    if rows:
        sc = [r["score"] for r in rows]
        m = sum(sc) / len(sc)
        sd = (sum((x - m) ** 2 for x in sc) / max(1, len(sc) - 1)) ** 0.5
        print(f"games {len(sc)}  practice-style score (16 - place) {m:.2f} +- {sd / len(sc) ** 0.5:.2f}  scores {sc}")
        print("hit rates: " + "; ".join(summarize_hits(rows)))


if __name__ == "__main__":
    asyncio.run(main())
