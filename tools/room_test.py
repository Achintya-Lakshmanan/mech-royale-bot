"""Play our bot in a private room on play.joinbuilders.org against house bots (free-for-all).

    pip install "websockets>=15"
    python3 tools/room_test.py --arena /path/to/kit/arena --out data/room --games 3 -- bun bot.ts

For each game it creates a private room, starts the match (empty seats are filled with house bots), pipes
hello/obs/end between the server and the bot process, and records the room's spectator feed (full replay of
every mech, mechreplay/1) to <out>/room-<n>.jsonl.gz. Prints place and kills per game.
Set MF_CA=/path/to/ca.pem if behind a TLS-intercepting proxy; HTTPS_PROXY is honoured.
"""
import argparse, asyncio, gzip, json, os, secrets, ssl, sys, time, urllib.request

HOST = "play.joinbuilders.org"


def new_room(sid):
    with urllib.request.urlopen(f"https://{HOST}/mm/code/new?sid={sid}", timeout=15) as r:
        d = json.loads(r.read())
    if "code" not in d:
        raise RuntimeError(f"could not create room: {d}")
    return d["room"], d["code"]


async def record_live(url, ctx, path, stop):
    import websockets
    with gzip.open(path, "wt") as f:
        while not stop.is_set():
            try:
                async with websockets.connect(url, ssl=ctx, max_size=None, proxy=True, open_timeout=20) as ws:
                    while not stop.is_set():
                        try:
                            m = await asyncio.wait_for(ws.recv(), 1)
                        except asyncio.TimeoutError:
                            continue
                        for line in str(m).split("\n"):
                            if line.strip():
                                f.write(f'{{"_rt":{time.time():.2f},"d":{line}}}\n')
            except Exception as e:
                if not stop.is_set():
                    print("live reconnect:", repr(e)[:100], file=sys.stderr)
                    await asyncio.sleep(2)


async def feed(bot, line):
    """write one line to the bot; the bot may already have exited after `end`"""
    try:
        bot.stdin.write(line.encode() + b"\n"); await bot.stdin.drain()
    except (ConnectionResetError, BrokenPipeError):
        pass


async def play_one(n, args, ctx):
    import websockets
    sid = secrets.token_hex(16)
    room, code = new_room(sid)
    q = f"token=&sid={sid}&name={args.name}&code={code}"
    print(f"game {n}: room {room} code {code}", flush=True)
    stop = asyncio.Event()
    live_path = os.path.join(args.out, f"room-{int(time.time())}-{n}.jsonl.gz")
    live = asyncio.create_task(record_live(f"wss://{HOST}/r/{room}/live?{q}", ctx, live_path, stop))
    bot = await asyncio.create_subprocess_exec(*args.bot, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                               stderr=open(os.path.join(args.out, f"bot-{n}.stderr"), "w"))
    result = {"room": room, "code": code, "replay": live_path}
    async with websockets.connect(f"wss://{HOST}/r/{room}/play?{q}", ssl=ctx, max_size=None, proxy=True,
                                  open_timeout=20, ping_interval=20) as ws:

        async def bot_to_server():
            while True:
                line = await bot.stdout.readline()
                if not line:
                    return
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                if msg.get("type") == "ready":
                    continue
                msg.pop("debug", None)
                await ws.send(json.dumps(msg))

        pump = asyncio.create_task(bot_to_server())
        started = False
        t0 = time.time()
        while time.time() - t0 < args.timeout:
            try:
                raw = await asyncio.wait_for(ws.recv(), 30)
            except asyncio.TimeoutError:
                continue
            m = json.loads(raw)
            ty = m.get("type")
            if ty == "lobby":
                you = m.get("you", {})
                if not you.get("ready"):
                    await ws.send(json.dumps({"type": "ready", "name": args.name}))
                if you.get("host") and m.get("phase") == "waiting" and not started:
                    await ws.send(json.dumps({"type": "start"}))
                    started = True
            elif ty == "hello":
                m["map"]["dir"] = args.arena
                await feed(bot, json.dumps(m))
                await ws.send(json.dumps({"type": "loaded"}))
                result["slot"] = m.get("slot")
            elif ty == "obs":
                await feed(bot, raw if isinstance(raw, str) else raw.decode())
            elif ty == "end":
                result.update(place=m.get("place"), kills=m.get("kills"))
                await feed(bot, json.dumps(m))
                print(f"game {n}: place {m.get('place')} kills {m.get('kills')}", flush=True)
                if not args.full:
                    break  # our place is fixed once we are out; skip the rest of the match
            elif ty == "results":
                result["results"] = m
                break
        pump.cancel()
    await asyncio.sleep(3)  # let the spectator feed flush the end of the match
    stop.set(); await live
    try:
        bot.stdin.close(); await asyncio.wait_for(bot.wait(), 5)
    except Exception:
        bot.kill()
    return result


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arena", required=True, help="kit arena folder (holds v2/world.json)")
    ap.add_argument("--out", default="data/room")
    ap.add_argument("--games", type=int, default=1)
    ap.add_argument("--name", default="steelhead-test")
    ap.add_argument("--timeout", type=float, default=600)
    ap.add_argument("--full", action="store_true", help="stay until the match ends (full replay)")
    ap.add_argument("bot", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    args.bot = [a for a in args.bot if a != "--"]
    os.makedirs(args.out, exist_ok=True)
    ctx = ssl.create_default_context(cafile=os.environ.get("MF_CA"))
    res = []
    for n in range(args.games):
        r = await play_one(n, args, ctx)
        res.append(r)
        with open(os.path.join(args.out, "results.jsonl"), "a") as f:
            f.write(json.dumps({k: v for k, v in r.items() if k != "results"}) + "\n")
    places = [r["place"] for r in res if r.get("place")]
    if places:
        print(f"games {len(places)}  mean points (16 - place) {sum(16 - p for p in places) / len(places):.2f}  places {places}")


asyncio.run(main())
