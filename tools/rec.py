"""Record a websocket feed to a gzip JSON-lines file.

    pip install "websockets>=15"
    python3 tools/rec.py wss://watch.joinbuilders.org/live data/live.jsonl.gz 3600   # cast: full matches
    python3 tools/rec.py wss://watch.joinbuilders.org/state data/state.jsonl.gz 3600 # what is airing / schedule

Each line is {"_rt": <unix time received>, "d": <message>}. Reconnects on drops.
Set MF_CA=/path/to/ca.pem if you are behind a TLS-intercepting proxy; HTTPS_PROXY is honoured.
"""
import asyncio, gzip, os, ssl, sys, time
import websockets

async def main(url, out, secs):
    ctx = ssl.create_default_context(cafile=os.environ.get("MF_CA"))
    t0 = time.time(); n = 0
    with gzip.open(out, "at") as f:
        while time.time() - t0 < secs:
            try:
                async with websockets.connect(url, ssl=ctx, max_size=None, proxy=True, open_timeout=20, ping_interval=20) as ws:
                    while time.time() - t0 < secs:
                        m = await asyncio.wait_for(ws.recv(), timeout=max(1, secs - (time.time() - t0)))
                        s = m if isinstance(m, str) else m.decode(errors="replace")
                        for line in s.split("\n"):
                            if line.strip():
                                f.write(f'{{"_rt":{time.time():.2f},"d":{line}}}\n'); n += 1
                        f.flush()
            except asyncio.TimeoutError:
                break
            except Exception as e:
                print("reconnect after", repr(e)[:120], file=sys.stderr, flush=True); await asyncio.sleep(3)
    print(url, "lines", n)

asyncio.run(main(sys.argv[1], sys.argv[2], float(sys.argv[3])))
