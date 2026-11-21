"""Analyze one mech (default: our slot, the 'human' seat) in mechreplay/1 recordings from tools/room_test.py.

    python3 tools/ourmech.py data/room/room-*.jsonl.gz [--slot N]
"""
import gzip, json, math, sys, bisect
from collections import Counter, defaultdict

W = ['gun', 'mortar', 'laser', 'lightning']


def load(path):
    h = None; fr = []
    try:
        for line in gzip.open(path, 'rt'):
            try: o = json.loads(line)
            except Exception: continue
            d = o['d'] if isinstance(o, dict) and '_rt' in o else o
            if not isinstance(d, dict): continue
            if d.get('type') == 'header': h = d; fr = []
            elif h is not None and 'm' in d and 't' in d: fr.append(d)
    except EOFError: pass
    return h, fr


def analyze(path, slot=None):
    h, fr = load(path)
    if not h or not fr: print(path, 'no match data'); return None
    if slot is None: slot = h['bots'].index('human') if 'human' in h['bots'] else 0
    typ = {m['id']: b.replace('house:', '') for m, b in zip(h['mechs'], h['bots'])}
    ev = [e for f in fr for e in f.get('ev', [])]
    ts = [f['t'] for f in fr]; F = {f['t']: {m[0]: m for m in f['m']} for f in fr}
    def st(t):
        i = min(bisect.bisect_left(ts, t), len(ts) - 1); return F[ts[i]]
    mine = [(f['t'], F[f['t']][slot]) for f in fr if slot in F[f['t']]]
    death = next((e for e in ev if e['e'] == 'death' and e['id'] == slot), None)
    end = next((e for e in ev if e['e'] == 'end'), None)
    place = end['places'][slot] if end and 'places' in end else (death or {}).get('place')
    print(f"\n### {path.split('/')[-1]}  slot {slot}  place {place}  "
          f"died t={death['t']/20 if death else None} by {typ.get((death or {}).get('by'), (death or {}).get('by'))}  match len {fr[-1]['t']/20:.0f}s")
    # shots / hits
    shots = Counter(); hits = Counter(); dmg = Counter(); hitdist = defaultdict(list); npc_dmg = 0; crate_dmg = 0
    for e in ev:
        if e['e'] == 'fire' and e.get('id') == slot: shots[e['w']] += 1
        if e['e'] == 'laser' and e.get('id') == slot: shots['laser'] += 1
        if e['e'] == 'zap' and e.get('id') == slot: shots['lightning'] += 1
        if e['e'] == 'hit' and e.get('src') == slot:
            d = e.get('dst')
            if d is not None and d < 16:
                hits[e['w']] += 1; dmg[e['w']] += e['amt']
                S = st(e['t'])
                if slot in S and d in S: hitdist[e['w']].append(math.dist(S[slot][1:3], S[d][1:3]))
            elif d is not None and 100 <= d < 1000: npc_dmg += e['amt']
            else: crate_dmg += e['amt']
    for w in W:
        if shots[w] or hits[w]:
            hd = sorted(hitdist[w]); md = hd[len(hd)//2] if hd else 0
            print(f"  {w:9} shots {shots[w]:4}  mech hits {hits[w]:4}  dmg {dmg[w]:6.0f}  median hit dist {md:4.0f} m")
    print(f"  damage to drones {npc_dmg:.0f}, to crates {crate_dmg:.0f}")
    # damage taken
    taken = Counter(); takenw = Counter(); first_hit = None
    for e in ev:
        if e['e'] == 'hit' and e.get('dst') == slot:
            taken[typ.get(e.get('src'), e.get('src'))] += e['amt']; takenw[e['w']] += e['amt']
            first_hit = first_hit or e['t'] / 20
    print(f"  damage taken {sum(taken.values()):.0f}  by attacker {dict(taken.most_common(6))}  by weapon {dict(takenw)}")
    kills = [e for e in ev if e['e'] == 'death' and e.get('by') == slot and e['id'] < 16]
    print(f"  kills {len(kills)}: " + ", ".join(f"{typ[k['id']]}@{k['t']/20:.0f}s" for k in kills))
    # movement
    still = 0; boost = 0; air = 0; dist = 0
    for (t0, a), (t1, b) in zip(mine, mine[1:]):
        step = math.dist(a[1:3], b[1:3]); dist += step
        still += step < 0.1; boost += bool(int(b[8]) & 2); air += not (int(b[8]) & 1)
    n = max(1, len(mine) - 1)
    print(f"  moved {dist:.0f} m; standing {still/n*100:.0f}%  boosting {boost/n*100:.0f}%  airborne {air/n*100:.0f}%")
    wp = [e for e in ev if e['e'] == 'weapon' and e.get('by') == slot]
    print(f"  weapon events: " + ", ".join(f"{e['op']} {e.get('kind')}@{e['t']/20:.0f}s" for e in wp))
    print(f"  max cubes {max(m[9] for _, m in mine)}  upgrades {[e['up'] for e in ev if e['e']=='upgrade' and e['id']==slot]}")
    # stuck periods: >3 s with <3 m displacement
    i = 0; stuck = []
    while i < len(mine):
        j = i
        while j < len(mine) and math.dist(mine[i][1][1:3], mine[j][1][1:3]) < 3: j += 1
        if (mine[min(j, len(mine)-1)][0] - mine[i][0]) / 20 > 3: stuck.append((mine[i][0]/20, (mine[min(j, len(mine)-1)][0]-mine[i][0])/20, mine[i][1][1:3]))
        i = max(j, i + 1)
    print(f"  still >3 s: " + ", ".join(f"t={a:.0f}s for {d:.0f}s at ({p[0]:.0f},{p[1]:.0f})" for a, d, p in stuck[:10]))
    # timeline of hp every 10 s + last 15 s before death
    print("  hp timeline: " + " ".join(f"{t/20:.0f}s:{m[6]:.0f}" for t, m in mine[::100]))
    if death:
        td = death['t']; win = [e for e in ev if e['e'] == 'hit' and td - 300 <= e['t'] <= td and (e.get('dst') == slot or e.get('src') == slot) and e.get('dst') is not None and e['dst'] < 16]
        att = Counter(typ.get(e['src']) for e in win if e.get('dst') == slot)
        dealt = sum(e['amt'] for e in win if e.get('src') == slot)
        S = st(td - 300); hp15 = S.get(slot, [0]*7)[6]
        print(f"  last 15 s: hp {hp15:.0f} -> 0; attackers {dict(att)}; we dealt {dealt:.0f}")
    return place


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--slot')]
    slot = None
    for a in sys.argv[1:]:
        if a.startswith('--slot='): slot = int(a.split('=')[1])
    for p in args: analyze(p, slot)
