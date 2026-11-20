# steelhead — Mech Royale bot

A TypeScript bot for the Builders Buildathon *Mech Royale* track (`mechfight/1` protocol), run with Bun.

- **map.ts** loads `/arena/v2` at startup and builds a 2 m walkability grid (buildings, slopes, map edge), a clearance field, a solid-height field for line-of-sight checks, and A* pathfinding.
- **bot.ts** is the brain: stays ahead of the zone, loots weapons (lightning > laser > mortar), cubes, crates and supply drops, farms NPC drones, and fights by strafing at a weapon-dependent range with lead-corrected gun aim, cone-checked lightning, charge-and-release laser and ballistic mortar lobs. It retreats to regenerate when low.
- **mechfight.ts** is the kit's protocol wrapper, unchanged.

Check locally (from the kit folder): `python3 check/check.py -- node /path/to/bot.ts`
