"""Calibrate the practice simulator against real practice scores.

For every submitted commit with a known practice score, rebuild the bot the way that commit's Dockerfile does (same
files, same entrypoint), play N simulated practice games, and compare simulated with real scores (rank correlation,
mean error). Squad settings are passed through to sim/practice_sim.py.

    python3 sim/calibrate.py --arena <kit>/arena --work /tmp/calib --games 8 --only example,fe5cfb6,cc22d2d -- --alive-per-kill 1

"example" is the kit's example bot (--kit, default <arena>/..), an anchor at the bottom of the scale. Each run writes to a
fresh directory <work>/run-<time>-<settings>/<commit>/ (results.jsonl, log.txt). Run one simulation at a time
(--parallel 1, the default) on a 4-core machine: 16 bots per game already use it fully.
"""
import argparse, json, os, re, subprocess, sys, time, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
# commit -> real practice score (from the submissions page)
REAL = {
    "734a0cf": 3.29, "fe5cfb6": 2.69, "fc21aee": 3.21, "3693d2f": 3.71, "dec7233": 3.90, "0111c47": 4.54,
    "588ec6a": 3.92, "0d85ce7": 4.60, "6c86f03": 3.73, "c2c6bf8": 3.63, "36cd38c": 4.77, "f64f13c": 4.02,
    "e31a64e": 3.94, "e38deba": 4.42, "cc22d2d": 4.81, "example": 1.15,
    # ambush variants
    "facf3b8": 4.79, "fa001fe": 4.58, "12eb21b": 4.75, "c364e2b": 4.73, "1cbdfad": 4.33,
}


def export(commit, work, kit):
    """copy the files the commit's Dockerfile copies into work/<commit>/ and return the command to run the bot"""
    if commit == "example":
        return ["bun", os.path.join(kit, "ts", "example.ts")]
    d = os.path.join(work, commit)
    os.makedirs(d, exist_ok=True)
    df = subprocess.check_output(["git", "-C", REPO, "show", f"{commit}:Dockerfile"], text=True)
    for line in df.splitlines():
        m = re.match(r"\s*COPY\s+(.+)\s+(\S+)\s*$", line)
        if not m:
            continue
        for src in m.group(1).split():
            data = subprocess.check_output(["git", "-C", REPO, "show", f"{commit}:{src}"])
            open(os.path.join(d, os.path.basename(src)), "wb").write(data)
    ep = re.search(r"ENTRYPOINT\s*\[(.*)\]", df).group(1)
    cmd = [x.strip().strip('"') for x in ep.split(",")]
    return [c.replace("/bot/", d + "/") for c in cmd]


def spearman(a, b):
    def ranks(x):
        order = sorted(range(len(x)), key=lambda i: x[i])
        r = [0.0] * len(x)
        for k, i in enumerate(order):
            r[i] = k
        return r
    ra, rb = ranks(a), ranks(b)
    ma, mb = st.mean(ra), st.mean(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    den = (sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb)) ** 0.5
    return num / den if den else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arena", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--games", type=int, default=6)
    ap.add_argument("--parallel", type=int, default=1)
    ap.add_argument("--kit", default="", help="kit folder (holds ts/example.ts); default: parent of --arena")
    ap.add_argument("--only", default="", help="comma-separated commits to run (default: all)")
    ap.add_argument("--pool", default="", help="no games: pool every <work>/run-*-<TAG> directory with this exact settings tag and print the table")
    ap.add_argument("simargs", nargs=argparse.REMAINDER, help="extra args for practice_sim.py, after --")
    a = ap.parse_args()
    if a.pool:
        dirs = [os.path.join(a.work, d) for d in sorted(os.listdir(a.work)) if re.fullmatch(r"run-\d{4}-\d{6}-" + re.escape(a.pool), d)]
        report(a.pool, dirs, [c for c in REAL if any(os.path.exists(os.path.join(d, c, "results.jsonl")) for d in dirs)])
        return
    extra = [x for x in a.simargs if x != "--"]
    commits = [c for c in REAL if not a.only or c in a.only.split(",")]
    if a.only:
        commits = [c for c in a.only.split(",") if c in REAL]
    kit = a.kit or os.path.dirname(os.path.abspath(a.arena))
    procs = []
    os.makedirs(a.work, exist_ok=True)
    tag = "_".join(extra).replace("--", "").replace(" ", "") or "default"
    run_dir = os.path.join(a.work, f"run-{time.strftime('%m%d-%H%M%S')}-{tag}"[:120])
    for c in commits:
        cmd = export(c, a.work, kit)
        out = os.path.join(run_dir, c)
        os.makedirs(out, exist_ok=True)
        argv = [sys.executable, "-I", os.path.join(HERE, "practice_sim.py"), "--arena", a.arena, "--out", out,
                "--games", str(a.games), "--name", f"cal{c}"] + extra + ["--"] + cmd
        procs.append((c, argv, out))
    running = []
    while procs or running:
        while procs and len(running) < a.parallel:
            c, argv, out = procs.pop(0)
            log = open(os.path.join(out, "log.txt"), "w")
            running.append((c, subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT), out))
        for item in list(running):
            if item[1].poll() is not None:
                running.remove(item)
        time.sleep(5)
    report(tag, [run_dir], commits)


def report(tag, dirs, commits):
    rows = []
    for c in commits:
        sc = []
        for d in dirs:
            f = os.path.join(d, c, "results.jsonl")
            if os.path.exists(f):
                sc += [16 - json.loads(l)["place"] for l in open(f)]
        if sc:
            se = (st.stdev(sc) / len(sc) ** 0.5) if len(sc) > 1 else 0
            rows.append((c, REAL[c], st.mean(sc), len(sc), se, st.median(sc)))
    rows.sort(key=lambda r: -r[1])
    print(f"settings: {tag}  ({', '.join(dirs)})")
    print(f"{'commit':9}{'real':>6}{'sim':>7}{'+-se':>6}{'median':>7}{'games':>6}")
    for c, r, s, n, se, md in rows:
        print(f"{c:9}{r:6.2f}{s:7.2f}{se:6.2f}{md:7.1f}{n:6}")
    if len(rows) >= 3:
        real = [r[1] for r in rows]; sim = [r[2] for r in rows]
        print(f"rank correlation {spearman(real, sim):.2f}  mean abs error {st.mean(abs(x - y) for x, y in zip(real, sim)):.2f}"
              f"  bias (sim - real) {st.mean(y - x for x, y in zip(real, sim)):+.2f}")


if __name__ == "__main__":
    main()
