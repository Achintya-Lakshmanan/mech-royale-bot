# Mech Royale: what we've learned (Sat 21 Nov, ~midnight ET)

For the team. Everything here comes from data we recorded or measured, or from other teams' public repos. Sources and
tools are at the end.

## 1. Where we stand

| | |
|---|---|
| Our best practice score | **3.71** (`3693d2f`, `exp-loot`), rank **66 of 137** |
| Qualifying cutoff (32nd place) | **4.23** and rising (3.94 at 9 PM ET) |
| Leader | 5.58 |
| Cutoff for submissions | **Sun 22 Nov, 11:00 AM ET** |
| Submission limit | 4 per rolling hour: each slot frees one hour after that submission |

**We are not qualifying right now.** We need about **4.3–4.5** in practice. Nothing else matters until that is fixed.

## 2. How scoring really works

- Points per match = `16 − place` = the number of mechs that died before us. Kills only matter because they make other
  mechs die before us.
- **Practice** (the leaderboard): us against 15 house bots acting as one squad. They share vision, never fight each
  other, and send hunters (one early, more as we kill them, all of them late). So **practice points ≈ house bots we kill
  before we die**. Hiding does not score.
- **Qualifying (16 matches) and final (64 matches)**: real 16-way free-for-alls against other qualifiers' bots, Expert
  house bots fill empty seats. Here **survival** scores, because the others kill each other.
- Practice replays the **same 48 seeds** every time: identical code gets an identical score (another team confirmed
  4.44 twice). But any code change reshuffles the matches chaotically, so ±0.4 swings between versions are normal.
- The version that plays the final is your **chosen** submission: the best practice score unless you pick another on
  the track page before the cutoff.

## 3. What the match recordings showed

We recorded ~200 matches: the public cast (lobby matches, sample replays), **11 Top 16 Showdown matches** (real team bots
in free-for-all), and ~300 of our own private-room games (our bot against 15 house bots, free-for-all).

### How mechs die (75 deaths, house bots and humans)
- **55% of deaths involve 2+ attackers.** Being caught by a second mech is the main killer, not losing a fair duel.
- Death is fast: 10 s before dying, the typical victim still had **888 of 1400 HP**.
- Median kill distance **44 m**; damage in the last 10 s: gun 46%, laser 26%, lightning 19%, mortar 4%.
- Bots move constantly (only 9% standing still), boost 20–30% of the time, jet a lot in fights.

### Weapons (burst = damage dealt to one target in 3 s)
| Weapon | Typical 3-s burst | Note |
|---|---|---|
| Laser | **432** | Hitscan, 280 m, telegraphed while charging |
| Lightning | 348 | Auto-aims, 45 m only, burns energy |
| Mortar | 163 | Only 11% direct hits: shells take 1–3 s and targets move ~10 m/s |
| Gun | 121 | Our aim hits **60–80%** at 70–100 m (measured in our own games) |

Gun + mortar barely beats gun alone; gun + laser roughly doubles burst. **Laser > lightning >> mortar.**

### Danger map (41 matches, 49,000 mech-seconds)
| Where you are | Deaths per minute | 3-s bursts ≥ 400 dmg |
|---|---|---|
| Zone centre (0–20% of radius) | 0.85 | 9.3% |
| Near the zone edge (80–100%) | **0.55** | **3.5%** |
| No other mech within 60 m | **0.36** | 3.6% |
| One mech within 60 m | 2.02 (5.6×) | 19% |
| Two mechs within 60 m | 4.58 (13×) | 30% |

Exposure (how many spots can see you) did **not** predict damage; crowding and centrality did.

### Our own deaths (private rooms, free-for-all)
- Early on: **no second weapon** (we ignored pickups beyond 130 m), **NPC drones** killed us while we refused to shoot
  them, and we **retreated across open ground** into laser fire.
- Later version (ghost): 56% of deaths by 2+ mechs, **lasers 38% of damage in our last 10 s**, and in 22 of 39 deaths no
  mech was within 60 m 10 s earlier: we get picked off from range.
- **probe-astra-finalist** (the house bot built like GT Goats' "Astra") killed us 16 of 39 times.

### Top 16 Showdown (real team bots, free-for-all)
- **A high practice score does not make a good free-for-all bot.** Practice #1–#4 (BobBuildIt, AT, Wolverines,
  314159265) averaged 8th, 9th, 6th and 12th place.
- **Aggressive boosters die first** (314159265: 41% boosting, lives 36 s, avg 12th). Calm bots last (Bob the builder:
  standing 74% of the time, lives 3 min, avg 4.8th).
- **Expert house bots are strong** (House 2 averaged 4.2th) and fill empty final seats.
- Winners hold many cubes (House 2: 17, Bob the builder: 9.5).

## 4. What other teams learned (public repos)

| Team / repo | Practice | Lesson |
|---|---|---|
| nullat0m7 | 4.44–4.46 | **Passive changes cost ~0.45** ("time spent hiding gives hunters time to gather and regen"). Wins come from focus fire (stick to a target, prefer low HP), fight spots that keep a line of fire on the target but hide us from other hunters, fight above 40% HP +15% per extra shooter. Economy tweaks (crate/cube range, drop chasing) are ±0.1. |
| LanceHuang245 | ~4.54 | **Quiet movement ("sneak") +0.2 to +0.65.** "Patient" (hide, hold fire at range) cost 0.5 in practice (4.04 vs 4.54). |
| BackwardsDeployeds | 4.10, 4.54 | Runs GT Goats' MIT bot; **magazine-aware finishing** (pick targets our current burst can kill) took it 3.71 → 4.10. |
| GT Goats | 3.60–3.71 | Rooftop camping dropped them to 3.23. |
| jackbalseca | 3.81 | Engaging only mechs that shoot or aim at us: +0.23 in practice; switches behaviour once free-for-all is detected. |
| whyMiso | 4.13 | "Ghost" posture, precomputed exposure map, home spot in the next circle, quiet 4.6 m/s walking, auto-switch to ghost in free-for-all. |

## 5. Our submissions

| Commit | What | Practice |
|---|---|---|
| `734a0cf` | First bot | 3.29 |
| `fe5cfb6` | Combined caution (break off when 2 aim at us, duck on reload, 45 m) | **2.69** |
| `fc21aee` | Regen behind cover | 3.21 |
| `3693d2f` | Pickup memory, laser dodge, gun-only tactics | **3.71** (best) |
| `5d61b93` | + ghost, home base, quiet, laser awareness | (pending) |
| `7269a80` | + magazine-aware finishing | (on `main`) |

Lesson: anything that makes us fight less loses practice points.

## 6. Private-room results (free-for-all vs 15 house bots, 48 games each)

| Branch | Avg points (16 − place) | 12th or worse | Kills |
|---|---|---|---|
| `exp-loot` (3.71) | 9.33 ± 0.66 | 16% | 1.90 |
| `exp-ghost` | 10.23 ± 0.61 | 15% | 1.69 |
| `exp-laser` | 10.35 ± 0.60 | 10% | 1.54 |
| `exp-quiet` | **10.75 ± 0.51** | **4%** | 1.21 |

Hiding wins free-for-all and loses practice. Hence the plan below.

## 7. Plan

1. **One bot, two modes** (`exp-mode`, `02d43bd`): practice behaviour until more mechs have died than we killed plus
   one (impossible in practice, where house bots never kill each other), then free-for-all behaviour (ghost, home base).
   Detection verified on a recorded free-for-all: switched at 22.7 s.
2. **Practice mode** next steps, in order of evidence: focus fire + fight spots hidden from other hunters (nullat0m7),
   magazine-aware finishing (done), quiet movement when no enemy (done), fight threshold rising with extra shooters.
3. **Free-for-all mode**: keep `exp-quiet` behaviour; test safe cube farming (winners hold many cubes).
4. Before Sunday 11 AM: choose the submission for the final by free-for-all strength, provided practice stays in the top 32.

## Tools (all in `tools/`)

| Tool | Use |
|---|---|
| `room_test.py` | Play our bot in private rooms on play.joinbuilders.org against 15 house bots; records full replays |
| `ourmech.py` | Our mech's accuracy, damage, killers, stuck spots, last 15 s |
| `rec.py` | Record the public cast (`wss://watch.joinbuilders.org/live`) |
| `deaths.py` | Who died when, killed by whom |
| `mkexposure.ts` | Build `exposure.bin` from the map |
