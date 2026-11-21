# Team notes: Mech Royale

Shared working notes. Read this first, then `docs/protocol.md` (the full rulebook, copied from the kit).

## Status

| | |
|---|---|
| Submitted bot | commit `734a0cf` (`bot.ts`, `map.ts`, `mechfight.ts`) |
| Practice score | **3.29** over 48 matches (baseline 1.15). Leader ~4.77 at time of writing |
| Submissions | 4 per hour per team; scoring takes ~2 min |
| Cutoff | **Sun 22 Nov, 11:00 AM ET**. Final at 1:30 PM ET |

Track page: https://www.joinbuilders.org/buildathon/tracks/builders (kit download, submit, scores).

## How scoring really works (read this before changing strategy)

Score per match = `16 - place`, i.e. **the number of mechs that died before you**. Kills only count indirectly.

There are two very different stages:

1. **Practice (the board score):** 48 matches, us vs **15 house bots that act as one squad**. They share
   vision, **never fight each other**, and hunt us: one hunter early, more as we kill them, all of them late.
   So house bots only die to *our* weapons (or the zone). Practice score ≈ how many we kill before we die.
   Hiding does not help here.
2. **Qualifying + final (what wins):** real **16-team free-for-all**, no squad. With only ~23 teams entered and
   32 qualifying spots, **every team plays qualifying**; top 16 go to a 64-match final series. Here survival
   wins: avoid bad fights, stay in the zone, let others trade, finish weakened mechs.

So the practice score is a rough health check; the bot should be built to survive a free-for-all.

## Observations from recorded matches

- **Matches are short.** A 16-house-bot FFA ended at 3:30, a lobby match (2 humans + 14 house bots) at 1:53.
  The zone takes ~7 min to close, so almost every death is mech-on-mech, not zone.
- House bot types seen: `expert`, `hard`, `medium`, `brawler`, `sniper`, `thirdparty`, `farmer` (older sample
  replay) and `probe-astra-finalist`, `probe-red-best`, `probe-red-honest`, `probe-astra-skirmish`, `expert`
  (current lobby matches; likely what practice uses). `expert` won the lobby match with 6 kills.
- Bots kill themselves with their own mortar splash (50% self-damage + knockback).

## Weak spots in the current bot (hypotheses, not yet verified on data)

- Ignores enemies it has stopped seeing (`lastSeen` is filled but unused), though the server keeps
  tracking a seen mech for 5 s.
- With lightning it closes to 26 m, which is risky against mortar (concussion drains energy) and guns.
- Mortar takes over aim whenever off cooldown, which can stop the gun firing.
- Ignores rooftop cubes and pickups even though it can jet up ~60 m.
- Does not track facing: hits from behind do **1.5x**; keep the torso toward the main threat.

## Data sources

| What | Where |
|---|---|
| Kit (rules, wrappers, checker, map) | `https://www.joinbuilders.org/buildathon/tracks/builders/files/mechfight-kit.tar.gz` |
| Sample replay, 16 house bots | `https://play.joinbuilders.org/replays/mechanics-v2-16.jsonl.gz` (copy: `data/house16-seed16.jsonl.gz`) |
| **Cast, live matches** | `wss://watch.joinbuilders.org/live`. On connect it sends the airing match from its start, then streams it. Showdowns (submitted bots) air from Fri 9 PM ET to Sun 10 AM ET; otherwise it airs lobby matches |
| Cast schedule / what is airing | `wss://watch.joinbuilders.org/state` |
| Human-play lobby rooms | `wss://play.joinbuilders.org/r/<1..N>/live`, N from `https://play.joinbuilders.org/rooms.json` |
| Browser viewer for a replay | `https://play.joinbuilders.org/?replay=<url>` |

### Replay format (`mechreplay/1`)

Line 1 is a `header` (`bots`, `mechs` with names and spawns, `fields` describing the arrays). Then one
frame per 2 ticks (0.1 s), `t` in ticks (20/s):

- `m`: mechs `[id, x, y, z, aim_yaw, aim_pitch, hp, energy, flags, cubes, max_hp, slot0, slot1]`
  (flags: 1 grounded, 2 boosting, 4 laser charging; slots index into gun/mortar/laser/lightning, -1 empty)
- `n`: NPC drones `[id, x, y, z, yaw, hp]`; `p`: projectiles; `z`: zone `[cx, cy, r]`; `d`: supply drops
- `ev`: events: `fire`, `hit {src,dst,amt,w}`, `death {id,by,place}`, `pickup`, `cube`, `upgrade`,
  `laser`, `zap`, `boom`, `concuss`, `cookoff`, `short`, `drop`, `end`, ...

`data/lobby-874317388.jsonl.gz` was recorded with `tools/rec.py`, so each line is wrapped as `{"_rt": ..., "d": ...}`.

## Tools

```sh
pip install "websockets>=15"
python3 tools/rec.py wss://watch.joinbuilders.org/live data/live.jsonl.gz 3600   # record the cast for an hour
python3 tools/deaths.py data/*.jsonl.gz                                          # who died when, killed by whom
```

Local conformance check (from the kit folder): `python3 check/check.py -- bun /path/to/bot.ts`.

## Plan

1. Record more cast matches, especially showdowns with submitted bots.
2. Per-bot analysis: weapons taken, fight distances, accuracy, cause and time of death.
3. Turn findings into concrete bot changes, check them, then spend submissions.

Machine learning: trial-and-error (RL) training is not realistic before the cutoff. There is no game engine to
train against, and the recordings cannot show what would have happened if a bot had acted differently. Use the
data to tune hand-written rules instead.
