"""List every death (time, place, victim <- killer) in mechreplay/1 files.

    python3 tools/deaths.py data/*.jsonl.gz

Accepts raw replay lines and rec.py-wrapped lines ({"_rt":..,"d":..}); a file may hold several matches.
"""
import gzip, json, sys
from collections import Counter
def matches(path):
    cur=None
    for line in gzip.open(path,'rt'):
        o=json.loads(line)
        d=o['d'] if isinstance(o,dict) and '_rt' in o else o  # rec.py wrapper (frames also have a 'd' key: drops)
        if not isinstance(d,dict): continue
        if d.get('type')=='header':
            if cur: yield cur
            cur={'h':d,'frames':[], 'ev':[]}
        elif cur is not None and 't' in d and 'm' in d:
            cur['frames'].append(d); cur['ev'] += d.get('ev',[])
    if cur: yield cur
for path in sys.argv[1:]:
  for M in matches(path):
    h=M['h']; names={m['id']:f"{m['name']}({b.replace('house:','')})" for m,b in zip(h['mechs'],h['bots'])}
    fr=M['frames']; print(f"\n### {path.split('/')[-1]} seed={h['seed']} frames={len(fr)} last_t={fr[-1]['t']/20 if fr else 0:.0f}s")
    ec=Counter(e['e'] for e in M['ev']); print('events:',dict(ec))
    for e in M['ev']:
        if e['e']=='death':
            by=e.get('by'); print(f"  t={e['t']/20:6.1f} place={e.get('place')} {names.get(e['id'],e['id'])} <- {names.get(by,by)}")
    for e in M['ev'][:0]: pass
