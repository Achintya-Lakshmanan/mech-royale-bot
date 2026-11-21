/** Mech Royale bot: zone-aware navigation, looting, and a kiting gunfight with weapon-specific aiming. */
import { type Action, type ActorObs, draw, type Hello, type Observation, run } from "./mechfight.ts"
import { GameMap } from "./map.ts"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** precomputed exposure map (tools/mkexposure.ts): how many nearby ground spots can see a mech at each 4 m cell */
class Exposure {
  ox = 0; oy = 0; nx = 0; ny = 0; C = 4
  data: Uint8Array | null = null
  constructor() {
    try {
      const f = join(dirname(fileURLToPath(import.meta.url)), "exposure.bin")
      if (!existsSync(f)) return
      const b = readFileSync(f)
      const h = new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + 20))
      ;[this.ox, this.oy, this.nx, this.ny, this.C] = [h[0], h[1], h[2], h[3], h[4]]
      this.data = new Uint8Array(b.buffer.slice(b.byteOffset + 20, b.byteOffset + 20 + this.nx * this.ny))
    } catch (e) {
      process.stderr.write(`exposure load failed: ${e}\n`)
    }
  }
  /** 0 (hidden) .. 1 (exposed); 1 for unwalkable or unknown */
  at(x: number, y: number): number {
    if (!this.data) return 0.5
    const i = Math.floor((x - this.ox) / this.C), j = Math.floor((y - this.oy) / this.C)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return 1
    const v = this.data[j * this.nx + i]
    return v === 255 ? 1 : v / 254
  }
}

type V = number[]
const TAU = Math.PI * 2
const hyp2 = (a: V, b: V) => Math.hypot(b[0] - a[0], b[1] - a[1])
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const norm2 = (x: number, y: number): [number, number] => {
  const l = Math.hypot(x, y)
  return l < 1e-6 ? [0, 0] : [x / l, y / l]
}

/** experiment switches: regen = disengage to cover and heal; grow = farm drones/crates/cubes more widely */
const V = { regen: true, grow: false }

// lasers deal the most damage to us (38% in our final 10 s) and have the best burst: take one first
// room games: laser games won (1st, 1st, 7th), lightning games lost (9th-14th): the laser is the weapon to have
// ambush: lightning (auto-aim, 240 dps inside 45 m) is the close-range burst weapon
const WEAPON_RANK: Record<string, number> = { lightning: 2.8, laser: 3.2, mortar: -1, gun: 0 }
// practice: plating and armor first, then the laser
const SQUAD_UPGRADES = [
  "plating", "armor", "laser_damage", "laser_charge", "nanites", "gun_damage", "gun_rate", "lightning_efficiency", "lightning_range",
  "servos", "gun_mag", "gun_velocity", "gyros", "lightning_chain", "reactor", "capacitor", "mortar_reload", "mortar_splash",
  "mortar_velocity", "sensors", "jets", "laser_pierce",
]
const UPGRADE_RANK = [
  // survival first (as the 4.1+ bots do), then damage
  "laser_damage", "plating", "laser_charge", "armor", "lightning_efficiency", "nanites", "gun_damage", "gun_rate",
  "gyros", "lightning_range", "gun_mag", "capacitor", "reactor", "servos", "sensors", "gun_velocity",
  "jets", "mortar_reload", "lightning_chain", "mortar_splash", "mortar_velocity", "laser_pierce",
]

// mulberry32
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Brain {
  name = "steelhead"
  cfg: Hello["config"]
  map: GameMap
  expo = new Exposure()
  home: number[] | null = null
  homeScore = Infinity
  homeT = -99
  rand: () => number
  // navigation state
  path: number[][] | null = null
  pathGoal: number[] | null = null
  pathIdx = 0
  pathTime = -99
  posHist: { t: number; p: V }[] = []
  stuckUntil = 0
  stuckDir: [number, number] = [0, 0]
  // combat state
  strafeSign = 1
  strafeUntil = 0
  lastDamageT = -99
  threatBearing: number | null = null
  threatT = -99
  lastSeen = new Map<number, { t: number; m: ActorObs }>()
  heardBearing: number | null = null
  heardT = -99
  targetId = -1
  crateTarget = -1
  scanPhase = 0
  mode = ""
  retreatMode = false
  peekGoal: number[] | null = null
  peekT = -99
  /** free-for-all detected (practice house bots never kill each other): switch to the hiding, ghost behaviour */
  ffa = false
  huntLog = false
  kills = 0
  /** NPC drones that shot us recently: id -> time */
  droneAttackers = new Map<number, number>()
  /** mechs that damaged us: id -> time */
  mechAttackers = new Map<number, number>()
  /** a laser hit us from range and we cannot answer it: get out of its sight until this time */
  losBreakUntil = -99
  losBreakFrom = -1
  /** weapon pickups we have seen (the observation lists them only while visible) */
  knownPickups = new Map<number, { id: number; kind: string; pos: number[] }>()
  coverGoal: number[] | null = null
  coverT = -99

  stickT = -99
  loseT = -99
  constructor(hello: Hello) {
    this.cfg = hello.config
    this.rand = rng(hello.seed ^ 0x9e3779b9)
    const t0 = performance.now()
    this.map = new GameMap(hello.map.dir)
    // warm the JIT on the hot paths so the first real searches are not slow
    if (this.map.ok) {
      for (let i = 0; i < 12; i++) {
        const a = [-300 + i * 50, -200 + i * 30], b = [200 - i * 40, 250 - i * 35]
        this.map.path(a[0], a[1], b[0], b[1], 40000)
        this.map.los([a[0], a[1], 5], [b[0], b[1], 5])
        this.map.walkLine(a[0], a[1], b[0], b[1])
      }
    }
    process.stderr.write(`exposure ${this.expo.data ? "ok" : "missing"}; map ${this.map.ok} in ${(performance.now() - t0).toFixed(0)}ms\n`)
  }

  // ---------- zone helpers ----------
  zoneAt(obs: Observation, t: number): { c: number[]; r: number } {
    const z = obs.zone
    if (t <= z.shrink_start) return { c: z.center, r: z.radius }
    if (t >= z.shrink_end) return { c: z.next_center, r: z.next_radius }
    const f = (t - z.shrink_start) / Math.max(0.01, z.shrink_end - z.shrink_start)
    return {
      c: [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f],
      r: z.radius + (z.next_radius - z.radius) * f,
    }
  }

  /** is point p safe from the zone for the near future */
  zoneSafe(obs: Observation, p: V, margin = 15): boolean {
    const z = obs.zone
    const t = obs.t
    const timeToShrink = z.shrink_start - t
    const cur = this.zoneAt(obs, t + 3)
    if (hyp2(p, cur.c) > cur.r - margin) return false
    const dNext = hyp2(p, z.next_center) - (z.next_radius - margin)
    if (dNext > 0 && timeToShrink < dNext / 10 + 12) return false
    return true
  }

  /** a goal point well inside the zone, biased toward our side */
  zoneGoal(obs: Observation, me: V): number[] {
    const z = obs.zone
    const nc = z.next_center
    const r = Math.max(0, z.next_radius)
    const d = hyp2(me, nc)
    const keep = Math.min(r * 0.45, d)
    const [ux, uy] = norm2(me[0] - nc[0], me[1] - nc[1])
    return [nc[0] + ux * keep, nc[1] + uy * keep]
  }

  /** a nearby walkable, zone-safe point the threat cannot see */
  coverPoint(obs: Observation, me: V, threat: ActorObs, maxR = 55): number[] | null {
    if (!this.map.ok) return null
    if (this.coverGoal && obs.t - this.coverT < 1.0 && hyp2(me, this.coverGoal) <= maxR + 3) return this.coverGoal
    const sc = 1 + 0.05 * (threat.cubes ?? 0)
    const te = [threat.pos[0], threat.pos[1], threat.pos[2] + 8 * sc]
    let best: number[] | null = null, bs = -Infinity
    for (const r of [6, 10, 18, 28, 40, 55]) {
      if (r > maxR) break
      for (let k = 0; k < 16; k++) {
        const a = (k * TAU) / 16
        const x = me[0] + Math.cos(a) * r, y = me[1] + Math.sin(a) * r
        if (this.map.clearAt(x, y) < 3) continue
        if (!this.zoneSafe(obs, [x, y], 12)) continue
        const gz = this.map.ground(x, y)
        if (this.map.los(te, [x, y, gz + 4.5]) || this.map.los(te, [x, y, gz + 9])) continue
        let s = Math.min(hyp2([x, y], threat.pos), 120) * 0.4 - r
        if (!this.map.walkLine(me[0], me[1], x, y, 2)) s -= 25
        if (s > bs) { bs = s; best = [x, y] }
      }
    }
    this.coverGoal = best
    this.coverT = obs.t
    return best
  }

  /** best weapon pickup to go for, from memory; null if none worth it */
  bestPickup(obs: Observation, pos: V, maxD: number) {
    const slots = obs.self.weapons
    const has = (k: string) => slots.some((w) => w && w.kind === k)
    const myWorst = slots[1] ? WEAPON_RANK[slots[1].kind] ?? 0 : -1
    let bp: { id: number; kind: string; pos: number[] } | null = null, bs = -Infinity
    for (const p of this.knownPickups.values()) {
      if (has(p.kind)) continue
      const r = WEAPON_RANK[p.kind] ?? 0
      if (r <= myWorst + 0.3) continue
      const d = hyp2(pos, p.pos)
      const onRoof = p.pos[2] - this.map.ground(p.pos[0], p.pos[1]) > 3
      if (onRoof && d > 6) continue
      if (d > maxD || !this.zoneSafe(obs, p.pos, 5)) continue
      const sc = r * 30 - d
      if (sc > bs) { bs = sc; bp = p }
    }
    return bp
  }

  /**
   * cost of standing at (x, y). Weights come from the danger map of 41 recorded matches: damage taken per second is
   * 34 at the zone centre vs 14.5 near its edge, and 15 with no mech within 60 m vs 70 with one; exposure barely mattered.
   */
  homeCost(obs: Observation, pos: V, x: number, y: number): number {
    let crowd = 0
    for (const { t, m } of this.lastSeen.values())
      if (obs.t - t < 20) crowd += 1.5 * Math.max(0, 80 - Math.hypot(m.pos[0] - x, m.pos[1] - y)) / 80
    for (const d of obs.drops ?? []) crowd += Math.max(0, 60 - Math.hypot(d.pos[0] - x, d.pos[1] - y)) / 60
    for (const n of obs.mechs) if (n.kind === "npc") crowd += Math.max(0, 50 - Math.hypot(n.pos[0] - x, n.pos[1] - y)) / 50
    const z = obs.zone
    const edge = Math.hypot(x - z.next_center[0], y - z.next_center[1]) / Math.max(30, z.next_radius)
    // prefer the outer ring of the next circle (edge ~0.75); the centre is where everyone meets
    return 50 * this.expo.at(x, y) + 0.25 * Math.hypot(x - pos[0], y - pos[1]) + 40 * crowd + 60 * Math.max(0, 0.75 - edge)
  }

  /** a hidden ground spot inside the next circle to wait at; re-picked every few seconds with hysteresis */
  homeGoal(obs: Observation, pos: V): number[] | null {
    if (!this.map.ok || !this.expo.data) return null
    const z = obs.zone
    const valid = (h: number[] | null) => h != null && this.zoneSafe(obs, h, 12)
    if (valid(this.home) && obs.t - this.homeT < 4) return this.home
    let best: number[] | null = null, bs = Infinity
    for (let k = 0; k < 90; k++) {
      const a = this.rand() * Math.PI * 2, r = Math.sqrt(this.rand()) * Math.max(0, z.next_radius) * 0.85
      const x = z.next_center[0] + Math.cos(a) * r, y = z.next_center[1] + Math.sin(a) * r
      if (this.map.clearAt(x, y) < 3) continue
      const c = this.homeCost(obs, pos, x, y)
      if (c < bs) { bs = c; best = [x, y] }
    }
    const cur = valid(this.home) ? this.homeCost(obs, pos, this.home![0], this.home![1]) : Infinity
    if (best && (cur === Infinity || bs < cur - 15)) this.home = best
    else if (cur === Infinity) this.home = null
    this.homeT = obs.t
    return this.home
  }

  /** a spot within 30 m with a line of fire to the target that the other visible hostiles cannot see */
  peekSpot(obs: Observation, me: V, target: ActorObs, others: ActorObs[]): number[] | null {
    if (!this.map.ok || others.length === 0) return null
    if (this.peekGoal && obs.t - this.peekT < 0.5) return this.peekGoal
    const tz = target.pos[2] + 4.5 * (1 + 0.05 * (target.cubes ?? 0))
    const eyes = others.slice(0, 4).map((o) => [o.pos[0], o.pos[1], o.pos[2] + 8 * (1 + 0.05 * (o.cubes ?? 0))])
    const muz = (obs.self.stats.muzzle_height ?? 7)
    let best: number[] | null = null, bs = Infinity
    for (const r of [0, 8, 16, 24, 30]) {
      for (let k = 0; k < (r === 0 ? 1 : 12); k++) {
        const a = (k * TAU) / 12
        const x = me[0] + Math.cos(a) * r, y = me[1] + Math.sin(a) * r
        if (r > 0 && (this.map.clearAt(x, y) < 3 || !this.zoneSafe(obs, [x, y], 10))) continue
        const gz = this.map.ground(x, y)
        if (!this.map.los([x, y, gz + muz], [target.pos[0], target.pos[1], tz])) continue
        let seen = 0
        for (const e of eyes) if (this.map.los(e, [x, y, gz + 4.5]) || this.map.los(e, [x, y, gz + 9])) seen++
        const sc = seen * 100 + r
        if (sc < bs) { bs = sc; best = [x, y] }
      }
    }
    this.peekGoal = best && bs < 100 ? best : null // only if it hides us from every other hostile
    this.peekT = obs.t
    return this.peekGoal
  }

  // ---------- navigation ----------
  /** returns a unit direction toward goal following an A* path */
  navTo(obs: Observation, me: V, goal: number[], stopDist = 2): [number, number] {
    const d = hyp2(me, goal)
    if (d < stopDist) return [0, 0]
    if (!this.map.ok) return norm2(goal[0] - me[0], goal[1] - me[1])
    // direct if clear
    if (d < 60 && this.map.walkLine(me[0], me[1], goal[0], goal[1], 2)) {
      return norm2(goal[0] - me[0], goal[1] - me[1])
    }
    const replan =
      !this.path ||
      !this.pathGoal ||
      hyp2(this.pathGoal, goal) > 8 ||
      obs.t - this.pathTime > 4 ||
      this.pathIdx >= this.path.length
    if (replan) {
      this.path = this.map.path(me[0], me[1], goal[0], goal[1], 40000)
      this.pathGoal = goal.slice()
      this.pathTime = obs.t
      this.pathIdx = 0
    }
    const p = this.path
    if (!p || p.length < 2) return norm2(goal[0] - me[0], goal[1] - me[1])
    // advance index to nearest point ahead
    let best = this.pathIdx, bestD = Infinity
    for (let i = this.pathIdx; i < Math.min(p.length, this.pathIdx + 30); i++) {
      const dd = hyp2(me, p[i])
      if (dd < bestD) { bestD = dd; best = i }
    }
    this.pathIdx = best
    if (bestD > 12) {
      // drifted off: replan next tick
      this.pathTime = -99
    }
    // look ahead for furthest visible waypoint
    let tgt = p[Math.min(p.length - 1, best + 1)]
    for (let i = Math.min(p.length - 1, best + 25); i > best; i--) {
      if (this.map.walkLine(me[0], me[1], p[i][0], p[i][1], 2)) { tgt = p[i]; break }
    }
    draw.line([me[0], me[1], me[2] + 1], [tgt[0], tgt[1], me[2] + 1], "#40c0ff")
    return norm2(tgt[0] - me[0], tgt[1] - me[1])
  }

  /** nudges a desired move away from walls nearby */
  wallSafe(me: V, mv: [number, number]): [number, number] {
    if (!this.map.ok || (mv[0] === 0 && mv[1] === 0)) return mv
    const look = 5
    if (this.map.clearAt(me[0] + mv[0] * look, me[1] + mv[1] * look) >= 2) return mv
    // try rotations
    for (const da of [0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.2, -2.2]) {
      const a = Math.atan2(mv[1], mv[0]) + da
      const c = [Math.cos(a), Math.sin(a)]
      if (this.map.clearAt(me[0] + c[0] * look, me[1] + c[1] * look) >= 2) {
        const l = Math.hypot(mv[0], mv[1])
        return [c[0] * l, c[1] * l]
      }
    }
    return mv
  }

  fsSign = 1
  fsUntil = 0
  /** squad fight step: score 16 short steps (and standing) by range to the target, keeping it in sight,
   *  staying out of sight of the other hunters, zone safety, open ground and a randomised strafe */
  fightStep(obs: Observation, pos: V, tg: ActorObs, enemies: ActorObs[], want: number): [number, number] {
    const t = obs.t
    if (t >= this.fsUntil) {
      if (this.rand() < 0.6) this.fsSign = -this.fsSign
      this.fsUntil = t + 0.3 + this.rand() * 0.7
    }
    const [ux, uy] = norm2(tg.pos[0] - pos[0], tg.pos[1] - pos[1])
    const sx = -uy * this.fsSign, sy = ux * this.fsSign
    const tc = [tg.pos[0], tg.pos[1], tg.pos[2] + 4.5]
    const mh = obs.self.stats.muzzle_height ?? 7
    let best = -Infinity, bm: [number, number] = [0, 0], blockedSide = false
    for (let k = -1; k < 16; k++) {
      let cx = pos[0], cy = pos[1], dx = 0, dy = 0, r = 0
      if (k >= 0) {
        const a = (k * Math.PI) / 8
        r = 6; dx = Math.cos(a); dy = Math.sin(a); cx += dx * r; cy += dy * r
        if (!this.map.walkLine(pos[0], pos[1], cx, cy)) { if (dx * sx + dy * sy > 0.9) blockedSide = true; continue }
      }
      const cz = this.map.ground(cx, cy)
      const d = Math.hypot(tg.pos[0] - cx, tg.pos[1] - cy)
      let sc = -1.1 * Math.abs(d - want) - r * 0.4
      if (this.map.los([cx, cy, cz + mh], tc)) sc += 45
      for (const e of enemies) {
        if (e.id === tg.id || Math.hypot(e.pos[0] - cx, e.pos[1] - cy) > 170) continue
        if (this.map.los([e.pos[0], e.pos[1], e.pos[2] + 8], [cx, cy, cz + 5.4])) sc -= 30
      }
      if (!this.zoneSafe(obs, [cx, cy, cz], 5)) sc -= 60
      const cl = this.map.clearAt(cx, cy)
      if (cl < 4) sc -= (4 - cl) * 2.5
      sc += 9 * (dx * sx + dy * sy)
      if (k < 0) sc -= 8
      if (sc > best) { best = sc; bm = [dx, dy] }
    }
    if (blockedSide) { this.fsSign = -this.fsSign; this.fsUntil = t + 0.5 }
    return bm
  }

  // ---------- aiming ----------
  aimPoint(me: Observation["self"], tgt: ActorObs, speed: number): { yaw: number; pitch: number; dist: number; pt: V } {
    // an action takes effect about one tick later: shoot from where we will be, at where it will be
    const LAT = 0.075
    const ox = me.pos[0] + me.vel[0] * LAT, oy = me.pos[1] + me.vel[1] * LAT
    const mz = me.pos[2] + (me.stats.muzzle_height ?? 7)
    const scale = tgt.kind === "mech" ? 1 + 0.05 * (tgt.cubes ?? 0) : 1
    const hz = tgt.kind === "mech" ? 4.5 * scale : 1.75
    let px = tgt.pos[0], py = tgt.pos[1], pz = tgt.pos[2] + hz
    let tt = 0
    for (let i = 0; i < 3; i++) {
      const d = Math.hypot(px - ox, py - oy, pz - mz)
      tt = Math.max(0, d - 3) / speed + LAT
      px = tgt.pos[0] + tgt.vel[0] * tt
      py = tgt.pos[1] + tgt.vel[1] * tt
      pz = tgt.pos[2] + hz + (tgt.vel[2] ?? 0) * tt * 0.5
    }
    const dx = px - ox, dy = py - oy
    const dist = Math.hypot(dx, dy)
    return { yaw: Math.atan2(dy, dx), pitch: Math.atan2(pz - mz, dist), dist, pt: [px, py, pz] }
  }

  mortarAim(me: Observation["self"], tgt: V, tvel: V, high: boolean): { yaw: number; pitch: number } | null {
    const w = this.weaponStats(me, "mortar")
    const v = w?.speed ?? 72, g = w?.gravity ?? 22
    const lz = me.pos[2] + (me.stats.height ?? 9) + 0.5
    let tx = tgt[0], ty = tgt[1]
    let res: { yaw: number; pitch: number } | null = null
    for (let it = 0; it < 3; it++) {
      const dx = tx - me.pos[0], dy = ty - me.pos[1]
      const d = Math.hypot(dx, dy)
      const h = tgt[2] - lz
      const disc = v ** 4 - g * (g * d * d + 2 * h * v * v)
      if (disc < 0) return null
      const sq = Math.sqrt(disc)
      const th = Math.atan((v * v + (high ? sq : -sq)) / (g * d))
      const flight = d / (v * Math.cos(th))
      res = { yaw: Math.atan2(dy, dx), pitch: th }
      tx = tgt[0] + tvel[0] * flight
      ty = tgt[1] + tvel[1] * flight
    }
    return res
  }

  weaponStats(me: Observation["self"], kind: string): Record<string, number> | null {
    for (const w of me.weapons) if (w && w.kind === kind) return w.stats as Record<string, number>
    return (this.cfg.weapons as Record<string, Record<string, number>>)[kind] ?? null
  }

  // ---------- main ----------
  act(obs: Observation): Omit<Action, "tick"> {
    const me = obs.self
    const pos = me.pos
    const t = obs.t
    const act: Omit<Action, "tick"> = {}
    const slots = me.weapons
    const kinds = slots.map((w) => (w ? w.kind : null))
    const has = (k: string) => kinds.includes(k as never)
    const hpFrac = me.hp / me.max_hp
    // after a fight, let HP regenerate (5 s without dealing damage) before shooting drones or crates
    const healing = hpFrac < 0.85

    // ---- bookkeeping ----
    for (const ev of obs.events) {
      if (ev.type === "damaged") {
        if (ev.by != null && ev.by >= 100) this.droneAttackers.set(ev.by, t)
        if (ev.by != null && ev.by < 16) this.mechAttackers.set(ev.by, t)
        if (ev.weapon === "laser" && ev.by != null && ev.by < 16 && !obs.self.weapons.some((w) => w && w.kind === "laser")) {
          const src = this.lastSeen.get(ev.by)
          if (!src || hyp2(obs.self.pos, src.m.pos) > 60) { this.losBreakUntil = t + 3; this.losBreakFrom = ev.by }
        }
        if (ev.weapon !== "zone") this.lastDamageT = t
        if (ev.bearing != null && ev.weapon !== "zone") {
          this.threatBearing = ev.bearing
          this.threatT = t
        }
      }
      if (ev.type === "take_failed" || ev.type === "took") this.path = null
      if (ev.type === "kill") this.kills++
      if (ev.type === "took" || (ev.type === "take_failed" && (ev.reason === "gone" || ev.reason === "have"))) this.knownPickups.delete(ev.id)
    }
    for (const s of obs.sounds) {
      if (["gun", "laser", "lightning", "laser_charge", "mortar", "step", "boost", "jet"].includes(s.kind) && s.dist !== "far") {
        this.heardBearing = s.bearing
        this.heardT = t
      }
    }
    {
      const vis = new Set<number>()
      for (const p of obs.pickups) { vis.add(p.id); this.knownPickups.set(p.id, { id: p.id, kind: p.kind, pos: p.pos.slice() }) }
      // a remembered pickup close by that we no longer see has been taken
      for (const [id, p] of this.knownPickups) if (!vis.has(id) && hyp2(pos, p.pos) < 25) this.knownPickups.delete(id)
    }
    // practice or free-for-all? In practice the house bots never fight each other, so any death we did not cause,
    // or any beam from one mech that lands on another, means free-for-all (in recorded free-for-alls 88-98% show a
    // mech death by 30 s). Until 30 s play the safe opening; then hunt if it still looks like practice.
    if (!this.ffa && (this.cfg.match.mechs ?? 16) - obs.alive > this.kills) this.ffa = true
    if (!this.ffa) {
      for (const b of obs.beams ?? []) {
        if (b.by === me.id || !b.path || b.path.length < 2) continue
        const end = b.path[1]
        for (const m of obs.mechs) {
          if (m.kind !== "mech" || m.id === b.by || hyp2(pos, m.pos) < 15) continue
          if (Math.hypot(end[0] - m.pos[0], end[1] - m.pos[1]) < 4 && end[2] > m.pos[2] - 1 && end[2] < m.pos[2] + 11) this.ffa = true
        }
      }
    }
    const hunt = !this.ffa && t > 20
    if (hunt !== this.huntLog) { this.huntLog = hunt; console.error(`t=${t.toFixed(1)} hunt=${hunt} ffa=${this.ffa} alive=${obs.alive} kills=${this.kills}`) }
    this.posHist.push({ t, p: pos.slice() })
    while (this.posHist.length && this.posHist[0].t < t - 1.2) this.posHist.shift()

    // ---- upgrades ----
    if (obs.offer) {
      let bi = 0, br = 1e9
      obs.offer.choices.forEach((c, i) => {
        const r = (hunt ? SQUAD_UPGRADES : UPGRADE_RANK).indexOf(c.id)
        const rr = r < 0 ? 50 : r
        if (rr < br) { br = rr; bi = i }
      })
      act.pick = bi
    }

    const enemies = obs.mechs.filter((m) => m.kind === "mech")
    const npcs = obs.mechs.filter((m) => m.kind === "npc")
    for (const e of enemies) this.lastSeen.set(e.id, { t, m: e })
    const eye: V = [pos[0], pos[1], pos[2] + (me.stats.eye_height ?? 8)]
    const muzzle: V = [pos[0], pos[1], pos[2] + (me.stats.muzzle_height ?? 7)]
    const losMemo = new Map<number, boolean>()
    const losTo = (m: ActorObs) => {
      let v = losMemo.get(m.id)
      if (v === undefined) { v = losRaw(m); losMemo.set(m.id, v) }
      return v
    }
    const losRaw = (m: ActorObs) => this.map.los(muzzle, [m.pos[0], m.pos[1], m.pos[2] + (m.kind === "mech" ? 4.5 : 1.75)]) ||
      this.map.los(muzzle, [m.pos[0], m.pos[1], m.pos[2] + (m.kind === "mech" ? 8 : 3)])

    // ---- fight model: who wins this fight? ----
    // Expected damage per second from a mech's weapons at distance d. Hit rates are measured from recorded matches:
    // ours for our bot, the house bots' (much worse with the laser and at range) for everyone else.
    const hitTab = (tab: number[], d: number) => tab[Math.min(tab.length - 1, Math.max(0, Math.floor((d - 30) / 30)))]
    const OUR_GUN = [0.86, 0.86, 0.69, 0.55, 0.47, 0.34, 0.24], THEIR_GUN = [0.83, 0.83, 0.62, 0.36, 0.24, 0.15, 0.12]
    const OUR_LASER = [0.81, 0.81, 0.73, 0.70, 0.56, 0.45, 0.4], THEIR_LASER = [0.45, 0.45, 0.33, 0.24, 0.19, 0.15, 0.12]
    const dps = (kinds: string[], d: number, ours: boolean): number => {
      let v = 0
      for (const k of kinds) {
        if (k === "gun" && d < (ours ? 120 : 230)) v += 102 * hitTab(ours ? OUR_GUN : THEIR_GUN, d) // 12 x 45 per 5.3 s magazine cycle
        else if (k === "laser" && d < 280) v += 131 * hitTab(ours ? OUR_LASER : THEIR_LASER, d) // 315 per 2.4 s
        else if (k === "lightning" && d < 45) v += 140 // 60 per 0.25 s, energy-limited
        else if (k === "mortar" && d > 28 && d < 220) v += 50
      }
      return v
    }
    const showsBack = (aimYaw: number, from: number[], to: number[]) =>
      Math.abs(wrap(Math.atan2(to[1] - from[1], to[0] - from[0]) - aimYaw)) > Math.PI / 2 + 0.1
    const myKinds = slots.filter((w) => w).map((w) => w!.kind as string)
    const myScale = 1 + 0.04 * Math.min(me.cubes ?? 0, 10)
    /** odds of winning a fight against e right now: time for us to kill it vs time for everyone hitting us to kill us */
    const fightOdds = (e: ActorObs) => {
      const d = hyp2(pos, e.pos)
      let ours = dps(myKinds, d, true) * myScale
      if (showsBack(e.aim[0], e.pos, pos)) ours *= 1.5
      let theirs = 0
      for (const o of enemies) {
        const dO = hyp2(pos, o.pos)
        if (o.id !== e.id && (dO > 230 || !losTo(o))) continue
        if (o.id !== e.id) {
          // only count mechs engaged with us: hit us in the last 4 s, or aiming at us
          const hitUs = t - (this.mechAttackers.get(o.id) ?? -99) < 4
          const aimsAtUs = Math.abs(wrap(Math.atan2(pos[1] - o.pos[1], pos[0] - o.pos[0]) - o.aim[0])) < 0.3
          if (!hitUs && !aimsAtUs) continue
        }
        let v = dps((o.weapons ?? ["gun"]) as string[], dO, false) * (1 + 0.04 * Math.min(o.cubes ?? 0, 10))
        if (showsBack(me.aim[0], pos, o.pos)) v *= 1.5
        theirs += v
      }
      const ourTTK = (e.hp ?? 1400) / Math.max(1, ours)
      const theirTTK = me.hp / Math.max(1, theirs)
      const p = 1 / (1 + Math.exp(-1.6 * Math.log(theirTTK / ourTTK)))
      return { p, ourTTK, theirTTK }
    }

    // ---- choose target mech ----
    // magazine-aware finishing: how much damage can we put out in the next couple of seconds?
    const burstAt = (d: number): number => {
      const scale = 1 + (this.cfg.cubes?.damage_per_cube ?? 0.04) * Math.min(me.cubes ?? 0, this.cfg.cubes?.stat_cap ?? 10)
      let b = 0
      for (const w of slots) {
        if (!w) continue
        const ws = w.stats as Record<string, number>
        if (w.kind === "gun" && (w.reload ?? 0) <= 0 && d < (ws.range ?? 230)) {
          const hit = d < 50 ? 0.8 : d < 100 ? 0.6 : 0.35 // measured hit rates by distance
          b += Math.min(w.ammo ?? 0, 9) * (ws.damage ?? 45) * hit
        } else if (w.kind === "laser" && (w.cooldown ?? 0) < 0.8 && d < (ws.range ?? 280)) {
          b += ws.damage ?? 315
        } else if (w.kind === "lightning" && d < (ws.range ?? 45)) {
          b += Math.min(8, Math.floor(me.energy / (ws.energy ?? 3))) * (ws.damage ?? 60)
        }
      }
      return b * scale
    }
    const killable = (e: ActorObs) => (e.hp ?? 1400) <= burstAt(hyp2(pos, e.pos))
    let target: ActorObs | null = null
    let bestScore = Infinity
    const late = obs.zone.next_radius <= 70 || obs.alive <= 3
    const closingSpeed = (e: ActorObs) => {
      const [ux, uy] = norm2(pos[0] - e.pos[0], pos[1] - e.pos[1])
      return e.vel[0] * ux + e.vel[1] * uy
    }
    if (hunt) {
      // practice (squad): fight whatever is coming for us, aiming at us, hurting us or already hurt; finish the weak first
      for (const e of enemies) {
        const d = hyp2(pos, e.pos)
        if (d > 240 || !losTo(e)) continue
        const hitUs = t - (this.mechAttackers.get(e.id) ?? -99)
        const aimed = Math.abs(wrap(Math.atan2(pos[1] - e.pos[1], pos[0] - e.pos[0]) - e.aim[0])) < 0.22
        const hp = e.hp ?? 1400, mhp = e.max_hp ?? 1400
        const closing = closingSpeed(e) > 3
        if (!(d < 60 || hitUs < 6 || late || (closing && d < 180) || (hp < 0.4 * mhp && d < 160) || (aimed && d < 190))) continue
        let s = d + 0.1 * hp
        if (hp <= 0.3 * mhp) s -= 400
        if (e.id === this.targetId && t - this.stickT < 2) s -= 200
        if (hitUs < 4) s -= 40
        if (closing) s -= 15
        if (s < bestScore) { bestScore = s; target = e }
      }
      if (target) this.stickT = t
    }
    for (const e of hunt ? [] : enemies) {
      const d = hyp2(pos, e.pos)
      const canKill = killable(e) && d < 150
      // ghost: leave far mechs alone unless they are fighting us, about to laser us, or nearly dead
      // (a mech within 60 m multiplies our death rate ~6x in recorded matches; picking fights does not pay)
      {
        const attacking = t - (this.mechAttackers.get(e.id) ?? -99) < 4
        const toMe0 = Math.atan2(pos[1] - e.pos[1], pos[0] - e.pos[0])
        const aimedAtMe = Math.abs(wrap(toMe0 - e.aim[0])) < 0.25
        // ambush: let hunters come to us; engage only inside 70 m or when they open fire
        if (!(attacking || d < 70 || (e.charging && aimedAtMe && d < 120) || (hunt && d < 200 && losTo(e) && fightOdds(e).p > 0.5))) continue
      }
      const visible = losTo(e)
      let s = d + (e.hp ?? 1400) * 0.12 - (visible ? 40 : 0)
      if (e.id === this.targetId) s -= visible ? 60 : 25
      if (canKill && visible) s -= 120 // finish what we can finish
      // is it aiming at us?
      const toMe = Math.atan2(pos[1] - e.pos[1], pos[0] - e.pos[0])
      if (Math.abs(wrap(toMe - e.aim[0])) < 0.3) s -= 20
      if (hunt) {
        s -= (1 - (e.hp ?? 1400) / (e.max_hp ?? 1400)) * 150 // finish the hurt ones
        if (Math.abs(wrap(toMe - e.aim[0])) > Math.PI / 2 + 0.1) s -= 40 // its back is to us: x1.5 damage
      }
      if (s < bestScore) { bestScore = s; target = e }
    }
    if (target || !hunt) this.targetId = target ? target.id : -1
    if (V.regen && hunt) {
      // practice: back off only while clearly losing, and only briefly (1.5 s after the last losing moment)
      let near = 0
      for (const e of enemies) if (hyp2(pos, e.pos) < 160) near++
      let losing = (near >= 2 && hpFrac < 0.55) || (near >= 3 && hpFrac < 0.8)
      if (target) {
        const tf = (target.hp ?? 1400) / (target.max_hp ?? 1400)
        if (hpFrac < 0.35 && tf > hpFrac + 0.1) losing = true
        if (tf < 0.25 && hpFrac > 0.2 && near <= 2) losing = false
      }
      if (losing) this.loseT = t
      this.retreatMode = this.loseT > 0 && t - this.loseT < 1.5
    } else if (V.regen) {
      // retreat only when clearly losing: caution cost other bots 0.15-0.5 in practice
      let shooters = 0
      for (const e of enemies) {
        const toMe = Math.atan2(pos[1] - e.pos[1], pos[0] - e.pos[0])
        if (hyp2(pos, e.pos) < 230 && Math.abs(wrap(toMe - e.aim[0])) < 0.3 && losTo(e)) shooters++
      }
      const tFrac = target ? (target.hp ?? 1400) / (target.max_hp ?? 1400) : 1
      if (hunt && target) {
        // practice: leave fights we are losing unless we can finish the target first; come back when the odds turn
        const fo = fightOdds(target)
        if (fo.p < 0.25 && fo.ourTTK > 1.2) this.retreatMode = true
        if (fo.p > 0.6 && hpFrac > 0.5) this.retreatMode = false
      } else if ((hpFrac < 0.35 && tFrac > hpFrac + 0.1) || (shooters >= 2 && hpFrac < 0.55) || (shooters >= 3 && hpFrac < 0.8)) this.retreatMode = true
      if (hpFrac > 0.85 || (t - this.lastDamageT > 8 && hpFrac > 0.6)) this.retreatMode = false
    }
    const tDist = target ? hyp2(pos, target.pos) : Infinity
    const tLos = target ? losTo(target) : false

    // ---- weapon & firing ----
    const fire: [boolean, boolean] = [false, false]
    let aimYaw = me.aim[0]
    let aimPitch = 0
    let haveAim = false

    const gunIdx = kinds.indexOf("gun" as never)
    const lightIdx = kinds.indexOf("lightning" as never)
    const laserIdx = kinds.indexOf("laser" as never)
    const mortarIdx = kinds.indexOf("mortar" as never)

    const aimErrOk = (yaw: number, pitch: number, dist: number, tolMeters: number) => {
      const tol = Math.max(0.012, Math.atan2(tolMeters, Math.max(1, dist)))
      return Math.abs(wrap(me.aim[0] - yaw)) < tol && Math.abs(me.aim[1] - pitch) < tol * 1.3
    }

    // target to shoot: mech first, else npc/crate when farming
    let shootAt: ActorObs | null = target
    let farming = false
    if (!shootAt) {
      // farm NPCs when healthy
      let bn: ActorObs | null = null, bd = Infinity
      for (const n of npcs) {
        const d = hyp2(pos, n.pos)
        const hittingUs = t - (this.droneAttackers.get(n.id) ?? -99) < 4
        const dd = hittingUs ? d - 60 : d // prefer the drone that is shooting us
        if (d < (hittingUs ? 100 : hunt ? 150 : V.grow ? 110 : 70) && dd < bd && (hittingUs || (!this.ffa && (hunt ? hpFrac > 0.5 : !healing) && !this.retreatMode)) /* free-for-all: drones only in self-defence */ && losTo(n)) { bd = dd; bn = n }
      }
      if (bn) { shootAt = bn; farming = true }
    }

    if (shootAt) {
      const gs = this.weaponStats(me, "gun")
      const a = this.aimPoint(me, shootAt, gs?.speed ?? 252)
      aimYaw = a.yaw
      aimPitch = a.pitch
      // hitscan aim for the laser: current position plus ~0.1 s of motion
      const hit = (() => {
        const lead = { ...shootAt, pos: [shootAt.pos[0] + shootAt.vel[0] * 0.05, shootAt.pos[1] + shootAt.vel[1] * 0.05, shootAt.pos[2]] } as ActorObs
        return this.aimPoint(me, lead, 1e9)
      })()
      const lw = laserIdx >= 0 ? slots[laserIdx]! : null
      const lightClose = lightIdx >= 0 && a.dist < 40
      const laserActive = !!lw && !lightClose && ((lw.charge ?? 0) > 0 || ((lw.cooldown ?? 0) <= 0.1 && a.dist < ((lw.stats as Record<string, number>).range ?? 280) * 0.95))
      if (laserActive) { aimYaw = hit.yaw; aimPitch = hit.pitch }
      haveAim = true
      const los = shootAt === target ? tLos : true
      const size = shootAt.kind === "mech" ? 2.2 * (1 + 0.05 * (shootAt.cubes ?? 0)) : 1.6
      // gun
      if (gunIdx >= 0 && los && a.dist < Math.min(hunt ? 1e9 : 120, (gs?.range ?? 230) * 0.95)) { // no long-range gunfire: it misses and gives us away
        const w = slots[gunIdx]!
        if ((w.reload ?? 0) <= 0 && (w.ammo ?? 1) > 0 && aimErrOk(a.yaw, a.pitch, a.dist, size)) fire[gunIdx] = true
      }
      // lightning: wide cone, needs range
      if (lightIdx >= 0) {
        const ls = slots[lightIdx]!.stats as Record<string, number>
        const cone = ((ls.cone_deg ?? 30) * Math.PI) / 180
        const inCone = Math.abs(wrap(me.aim[0] - Math.atan2(shootAt.pos[1] - pos[1], shootAt.pos[0] - pos[0]))) < cone * 0.8
        if (los && a.dist < (ls.range ?? 45) * 0.97 && inCone && me.energy > (ls.energy ?? 3) + (farming ? 30 : 6)) fire[lightIdx] = true
      }
      // laser: hold to charge, release when full and aligned
      if (laserIdx >= 0) {
        const w = slots[laserIdx]!
        const ls = w.stats as Record<string, number>
        const charge = w.charge ?? 0
        const full = (ls.charge ?? 0.75) * 0.97
        const aligned = aimErrOk(hit.yaw, hit.pitch, hit.dist, size * 0.9)
        const minC = ls.min_charge ?? 0.15, minF = ls.min_frac ?? 0.35
        const partial = (ls.damage ?? 315) * (minF + (1 - minF) * Math.min(1, charge / (ls.charge ?? 0.75))) * myScale
        if (hunt && shootAt.kind === "mech" && los && charge >= minC && charge < full && partial * 0.7 >= (shootAt.hp ?? 1400) && aligned) {
          fire[laserIdx] = false
        } else if (a.dist < (ls.range ?? 280) * 0.95 && (los || charge > 0)) {
          if (charge > 0) {
            // keep holding until full and aligned and visible
            fire[laserIdx] = !(charge >= full && aligned && los)
            if (!los && charge >= full + 0.3) fire[laserIdx] = false // target hid: don't crawl at half speed until it times out
          } else if ((w.cooldown ?? 0) <= 0.1 && los && !farming) {
            fire[laserIdx] = true
          } else if (farming && (w.cooldown ?? 0) <= 0.1 && los) fire[laserIdx] = true
        } else if (charge > 0) fire[laserIdx] = charge < full // out of view: finish charging, then let it go
      }
      // mortar
      if (mortarIdx >= 0 && a.dist > 28 && a.dist < 220 && shootAt.kind === "mech") {
        const w = slots[mortarIdx]!
        const tp: V = [shootAt.pos[0], shootAt.pos[1], shootAt.pos[2] + 1]
        const sol = this.mortarAim(me, tp, shootAt.vel, !tLos)
        if (sol && (w.cooldown ?? 0) <= 0.05) {
          // mortar takes over aim only if gun not usable
          const gunBusy = gunIdx < 0 || (slots[gunIdx]!.reload ?? 0) > 0 || !tLos
          if (gunBusy || (w.cooldown ?? 0) <= 0.0) {
            if (!(laserIdx >= 0 && (slots[laserIdx]!.charge ?? 0) > 0)) {
              aimYaw = sol.yaw
              aimPitch = sol.pitch
              fire[mortarIdx] = Math.abs(wrap(me.aim[0] - sol.yaw)) < 0.025 && Math.abs(me.aim[1] - sol.pitch) < 0.025
              if (gunIdx >= 0 && fire[gunIdx] && !fire[mortarIdx]) fire[gunIdx] = false
            }
          }
        }
      }
      draw.line(muzzle, a.pt, shootAt.kind === "mech" ? "#ff5040" : "#ffa040")
    }

    // practice: regen discipline. HP regenerates 45/s only after 5 s without dealing or taking damage, so while hurt and
    // nobody is hitting us, hold fire on mechs that are not fighting us (unless we can finish them)
    if (false && hunt && shootAt && shootAt.kind === "mech" && hpFrac < 0.6 && t - this.lastDamageT > 2 &&
        t - (this.mechAttackers.get(shootAt.id) ?? -99) > 15 && !killable(shootAt) &&
        Math.abs(wrap(Math.atan2(pos[1] - shootAt.pos[1], pos[0] - shootAt.pos[0]) - shootAt.aim[0])) > 0.3) {
      for (let i = 0; i < fire.length; i++) {
        const w = slots[i]
        fire[i] = !!w && w.kind === "laser" && (w.charge ?? 0) > 0 // keep holding a started laser charge; release nothing
      }
      this.mode += "+regen"
    }

    // crates when idle
    if (!shootAt && !this.retreatMode && (hunt ? hpFrac > 0.5 : !healing)) {
      let bc: (typeof obs.crates)[number] | null = null, bd = Infinity
      for (const c of obs.crates) {
        const d = hyp2(pos, c.pos)
        if (d < (V.grow ? 80 : 55) && d < bd && Math.abs(c.pos[2] - this.map.ground(c.pos[0], c.pos[1])) < 3 &&
          this.map.los(muzzle, [c.pos[0], c.pos[1], c.pos[2] + 1.2])) { bd = d; bc = c }
      }
      if (bc && gunIdx >= 0) {
        const dx = bc.pos[0] - pos[0], dy = bc.pos[1] - pos[1]
        const d = Math.hypot(dx, dy)
        aimYaw = Math.atan2(dy, dx)
        aimPitch = Math.atan2(bc.pos[2] + 1.2 - muzzle[2], d)
        haveAim = true
        const w = slots[gunIdx]!
        if ((w.reload ?? 0) <= 0 && aimErrOk(aimYaw, aimPitch, d, 1.0)) fire[gunIdx] = true
        if (lightIdx >= 0 && d < 40 && me.energy > 50 && Math.abs(wrap(me.aim[0] - aimYaw)) < 0.3) fire[lightIdx] = true
        this.crateTarget = bc.id
      }
    }

    // reload when idle and partly empty
    if (gunIdx >= 0) {
      const w = slots[gunIdx]!
      const mag = (w.stats as Record<string, number>).mag ?? 12
      if ((w.reload ?? 0) <= 0 && (w.ammo ?? mag) < mag * 0.5 && !target && !fire[gunIdx]) act.reload = true
    }

    // ---- movement ----
    let mv: [number, number] = [0, 0]
    let boost = false
    let jump = false
    const zoneOk = this.zoneSafe(obs, pos, 10)
    const inZoneNow = me.in_zone
    const recentlyHit = t - this.lastDamageT < 3

    let retreating = target != null && (hpFrac < 0.3 || (hpFrac < 0.45 && (target.hp ?? 0) > me.hp * 1.3))
    if (V.regen && target) {
      // heal behind cover, unless the enemy is nearly dead and in our sights
      retreating = this.retreatMode && !(tLos && ((target.hp ?? 1400) < me.hp * 0.5 || killable(target) || (hunt && tDist < 120 && (target.hp ?? 1400) < 200)))
      // regen needs 5 s without dealing damage: hold fire unless we are in contact
      if (retreating && !tLos) { fire[0] = false; fire[1] = false }
    }
    if (target) {
      this.mode = retreating ? "retreat" : "fight"
      // preferred range depends on weapons
      let want = 70
      // lightning only fires inside 45 m, but charging in to brawl got us killed: hold gun range unless the laser is ours
      if (lightIdx >= 0 && laserIdx >= 0 && me.energy > 25 && tDist < 50) want = 30
      else if (lightIdx >= 0 && laserIdx < 0) want = 28
      else if (laserIdx >= 0) want = 95
      else if (mortarIdx >= 0) want = 85
      // gun only against a laser: our gun misses most shots at 80 m while the laser does not; close in
      const outgunned = laserIdx < 0 && lightIdx < 0 && (target.weapons ?? []).includes("laser")
      if (outgunned && !hunt) want = 30
      if (hunt) {
        want = lightIdx >= 0 && me.energy > 12 ? 28 : laserIdx >= 0 ? 120 : 85
        if (lightIdx < 0 && (target.weapons ?? []).includes("lightning")) want = Math.max(want, 64)
        let crowd = 0
        for (const e of enemies) if (losTo(e) && hyp2(pos, e.pos) < 150) crowd++
        // finish: close right in on a weak target
        if ((target.hp ?? 1400) < 0.38 * (target.max_hp ?? 1400) && hpFrac > 0.42 && crowd <= 2) { want = 20; this.mode = "fight+finish" }
      }
      if (retreating) want = 400
      const [rx, ry] = norm2(target.pos[0] - pos[0], target.pos[1] - pos[1])
      let radial = 0
      if (tDist > want + 12) radial = 1
      else if (tDist < want - 12) radial = -1
      if (retreating) radial = -1
      if (false && hunt && !retreating && tLos) {
        const fo = fightOdds(target)
        if (fo.p > 0.75 && fo.ourTTK < 2.5 && tDist > 25) { radial = 1; if (me.energy > 30) boost = true; this.mode = "fight+finish" }
      }
      if (t > this.strafeUntil) {
        this.strafeSign = this.rand() < 0.5 ? -1 : 1
        this.strafeUntil = t + 0.3 + this.rand() * 0.5
      }
      const tx = -ry * this.strafeSign, ty = rx * this.strafeSign
      const sw = retreating ? 0.5 : 0.9
      mv = norm2(rx * radial + tx * sw, ry * radial + ty * sw)
      // if target not visible and we are not retreating, path toward it instead
      if (!tLos && !retreating && tDist > 20) {
        mv = this.navTo(obs, pos, target.pos, 4)
      }
      const cover = retreating && V.regen ? this.coverPoint(obs, pos, target) : null
      if (cover) {
        mv = this.navTo(obs, pos, cover, 1.5)
        boost = me.energy > 15 && hyp2(pos, cover) > 6
      } else if (retreating) {
        // retreat toward zone goal, away from target
        const zg = this.zoneGoal(obs, pos)
        const toZ = this.navTo(obs, pos, zg, 10)
        mv = norm2(mv[0] * 0.6 + toZ[0] * 0.8, mv[1] * 0.6 + toZ[1] * 0.8)
        boost = me.energy > 15
      }
      // gun only and the enemy is far and not hurting us: get a weapon first
      if (!retreating && !slots[1] && tDist > 90 && t - this.lastDamageT > 3) {
        const bp = this.bestPickup(obs, pos, 200)
        if (bp) {
          mv = this.navTo(obs, pos, bp.pos, 1.0)
          this.mode = "loot " + bp.kind
          if (hyp2(pos, bp.pos) < (this.cfg.loot.pickup_radius ?? 4) - 0.6 && Math.abs(bp.pos[2] - pos[2]) < 3.5) act.take = bp.id
        }
      }
      if (outgunned && !retreating && tDist > 45 && me.energy > 30) boost = true
      // a laser is picking us off from range and we have no laser: break its line of sight (next shot is ~2.4 s away)
      if (!retreating && t < this.losBreakUntil) {
        const th = enemies.find((e) => e.id === this.losBreakFrom) ?? target
        const c = this.coverPoint(obs, pos, th, 30)
        if (c) { mv = this.navTo(obs, pos, c, 1.0); boost = me.energy > 10; this.mode = "break-los" }
      }
      // fight position: with more than one hostile around, fight from a spot only our target can see
      if (!retreating && tLos && !hunt) {
        const others = enemies.filter((e) => e.id !== target.id && hyp2(pos, e.pos) < 200)
        const spot = this.peekSpot(obs, pos, target, others)
        if (spot && hyp2(pos, spot) > 2) { mv = this.navTo(obs, pos, spot, 1.0); this.mode = "peek" }
      }
      // dodge: an enemy is charging a laser at us; in free-for-all step behind cover a few metres away
      if (!retreating && this.ffa) {
        for (const e of enemies) {
          if (!e.charging) continue
          const dE = hyp2(pos, e.pos)
          const toMe = Math.atan2(pos[1] - e.pos[1], pos[0] - e.pos[0])
          if (Math.abs(wrap(toMe - e.aim[0])) > Math.max(0.08, Math.atan2(5, dE)) || !losTo(e)) continue
          const c = this.coverPoint(obs, pos, e, 12)
          if (c) { mv = this.navTo(obs, pos, c, 1.0); boost = me.energy > 10; this.mode = "dodge" }
          break
        }
      }
      if (hunt && !retreating && tLos && t >= this.losBreakUntil) { mv = this.fightStep(obs, pos, target, enemies, want); this.mode += ":step" }
      if (hunt && !retreating) {
        let r = hpFrac <= 0.5 ? 40 : 70, bc: number[] | null = null
        for (const c of obs.cubes) {
          const d = hyp2(pos, c.pos)
          if (d < r && Math.abs(c.pos[2] - pos[2]) < 4) { r = d; bc = c.pos }
        }
        if (bc) { mv = this.navTo(obs, pos, bc, 0.5); this.mode = "fight:cube" }
      }
      // stay inside the zone
      if (!zoneOk) {
        const zg = this.zoneGoal(obs, pos)
        const toZ = this.navTo(obs, pos, zg, 5)
        mv = norm2(mv[0] * 0.4 + toZ[0], mv[1] * 0.4 + toZ[1])
        if (!inZoneNow) boost = me.energy > 10
      }
      // avoid charging when laser user is near and we are fighting from range
      if (!retreating && tDist > want + 40 && me.energy > 50 && (lightIdx < 0 || tDist > 60)) boost = true
      // (no boosting in to lightning range: brawls lost us games)
    } else {
      // no visible mech
      let goal: number[] | null = null
      this.mode = "roam"
      if (!zoneOk) {
        goal = this.homeGoal(obs, pos) ?? this.zoneGoal(obs, pos)
        this.mode = "zone"
        if (!inZoneNow) boost = me.energy > 10
      }
      // supply drop
      if (!goal && obs.drops) {
        for (const d of obs.drops) {
          const dd = hyp2(pos, d.pos)
          if (dd < 220 && d.lands_in < dd / 11 + 5 && this.zoneSafe(obs, d.pos, 5) && (d.holder == null || d.holder === me.id)) {
            goal = [d.pos[0], d.pos[1]]
            this.mode = "drop"
            if (dd > 30 && me.energy > 40) boost = true
            if (dd < d.radius * 0.5) goal = null // stand still inside
            if (dd < d.radius * 0.5) this.mode = "capture"
            break
          }
        }
      }
      // nearby cubes first: a kill drops all the victim's cubes plus two (+4% HP and damage each)
      if (!goal && this.mode !== "capture") {
        let bc: number[] | null = null, bd = Infinity
        for (const c of obs.cubes) {
          const d = hyp2(pos, c.pos)
          if (d > 60 || c.pos[2] - this.map.ground(c.pos[0], c.pos[1]) > 3 || !this.zoneSafe(obs, c.pos, 5)) continue
          if (d < bd) { bd = d; bc = c.pos }
        }
        if (bc) { goal = [bc[0], bc[1]]; this.mode = "cube"; if (bd > 15 && me.energy > 40) boost = true }
      }
      // weapon pickups: with only the gun, a second weapon is worth a long walk
      if (!goal && this.mode !== "capture") {
        const bp = this.bestPickup(obs, pos, slots[1] ? (hunt && laserIdx < 0 ? 240 : 130) : 260)
        if (bp) {
          const d = hyp2(pos, bp.pos)
          if (d < (this.cfg.loot.pickup_radius ?? 4) - 0.6 && Math.abs(bp.pos[2] - pos[2]) < 3.5) {
            act.take = bp.id
            if (slots[1]) act.drop = 1
          }
          goal = [bp.pos[0], bp.pos[1]]
          this.mode = "loot " + bp.kind
          if (!slots[1] && d > 30 && me.energy > 40) boost = true
        }
      }
      // cubes
      if (!goal && this.mode !== "capture") {
        let bc: (typeof obs.cubes)[number] | null = null, bd = Infinity
        for (const c of obs.cubes) {
          const d = hyp2(pos, c.pos)
          const onRoof = c.pos[2] - this.map.ground(c.pos[0], c.pos[1]) > 3
          if (onRoof || d > (V.grow ? 160 : hunt ? 105 : 90) || !this.zoneSafe(obs, c.pos, 5)) continue
          if (d < bd) { bd = d; bc = c }
        }
        if (bc) { goal = [bc.pos[0], bc.pos[1]]; this.mode = "cube" }
      }
      // grow: walk to visible crates to break them
      if ((V.grow || hunt) && !goal && !shootAt && !this.retreatMode && this.mode !== "capture") {
        let bc: (typeof obs.crates)[number] | null = null, bd = Infinity
        for (const c of obs.crates) {
          const d = hyp2(pos, c.pos)
          if (d < 150 && d > 30 && d < bd && Math.abs(c.pos[2] - this.map.ground(c.pos[0], c.pos[1])) < 3 && this.zoneSafe(obs, c.pos, 5)) { bd = d; bc = c }
        }
        if (bc) { goal = [bc.pos[0], bc.pos[1]]; this.mode = "crate" }
      }
      // npc farming: approach to lightning range or hold
      if (!goal && shootAt && farming) {
        const d = hyp2(pos, shootAt.pos)
        const want = lightIdx >= 0 ? 25 : 40
        if (d > want) goal = [shootAt.pos[0], shootAt.pos[1]]
        this.mode = "farm"
      }
      if (hunt && !goal && this.mode !== "capture" && !this.retreatMode && !healing) {
        let best: number[] | null = null, bd = Infinity
        for (const { t: ts, m } of this.lastSeen.values()) {
          const d = hyp2(pos, m.pos)
          if (t - ts < 15 && d < bd && this.zoneSafe(obs, m.pos, 5)) { bd = d; best = m.pos }
        }
        if (false && best && bd > 30) { goal = [best[0], best[1]]; this.mode = "hunt" }
      }
      if (!goal && this.mode !== "capture" && !(this.crateTarget >= 0 && fire.some((f) => f))) {
        const hg = this.homeGoal(obs, pos)
        goal = hg ?? this.zoneGoal(obs, pos)
        if (hyp2(pos, goal) < (hg ? 2.5 : 25)) goal = null
        if (hg) this.mode = goal ? "home" : "hold"
      }
      this.crateTarget = -1
      if (goal) mv = this.navTo(obs, pos, goal, 1.0)
      if (farming && mv[0] === 0 && mv[1] === 0 && shootAt) {
        // strafe lightly around npc
        const [rx, ry] = norm2(shootAt.pos[0] - pos[0], shootAt.pos[1] - pos[1])
        mv = [-ry * this.strafeSign * 0.7, rx * this.strafeSign * 0.7]
        if (t > this.strafeUntil) { this.strafeSign *= -1; this.strafeUntil = t + 1.5 }
      }
      if (recentlyHit && me.energy > 30) boost = true
    }

    // quiet movement: below sound.step_speed a mech makes no footsteps, so hunters cannot hear it.
    // Walk silently whenever nothing is urgent (no target, zone safe, not hit recently, not racing for a first weapon or a drop).
    {
      const urgent = target != null || !zoneOk || t - this.lastDamageT < 5 || this.mode === "drop" || this.mode === "capture" ||
        (this.mode.startsWith("loot") && !slots[1])
      if (!urgent && !boost) {
        const quiet = ((this.cfg.sound?.step_speed ?? 5) * 0.9) / (me.stats.walk_speed ?? 11.7)
        const l = Math.hypot(mv[0], mv[1])
        if (l > quiet) mv = [(mv[0] / l) * quiet, (mv[1] / l) * quiet]
      }
    }
    // dodge: sidestep bullets about to hit, leave mortar landing spots, step off a charging laser's line
    {
      let dx = 0, dy = 0, urgent = false
      const sc = 1 + 0.05 * (me.cubes ?? 0)
      const cz = pos[2] + 4.5 * sc
      const g = (this.cfg.weapons?.mortar?.gravity as number) ?? 22
      for (const p of obs.projectiles) {
        const [px, py, pz] = p.pos, [vx, vy, vz] = p.vel
        if (p.kind === "mortar") {
          const a = -0.5 * g, b = vz, c = pz - pos[2]
          const disc = b * b - 4 * a * c
          if (disc < 0) continue
          const tl = (-b - Math.sqrt(disc)) / (2 * a)
          if (tl < 0 || tl > 3) continue
          const lx = px + vx * tl, ly = py + vy * tl
          if (Math.hypot(pos[0] + me.vel[0] * tl - lx, pos[1] + me.vel[1] * tl - ly) < 11) {
            const l = Math.max(0.5, Math.hypot(pos[0] - lx, pos[1] - ly))
            dx += (pos[0] - lx) / l; dy += (pos[1] - ly) / l; urgent = true
          }
          continue
        }
        const rx = pos[0] - px, ry = pos[1] - py, rz = cz - pz
        const vv = vx * vx + vy * vy + vz * vz
        if (vv < 1) continue
        const tc = (rx * vx + ry * vy + rz * vz) / vv
        if (tc < 0 || tc > 0.9) continue
        const mx = px + vx * tc - pos[0], my = py + vy * tc - pos[1], mz = pz + vz * tc - cz
        if (Math.hypot(mx, my, mz * 0.5) > 3.6 * sc) continue
        const hv = Math.hypot(vx, vy) || 1
        let nx = -vy / hv, ny = vx / hv
        if (nx * -mx + ny * -my < 0) { nx = -nx; ny = -ny }
        dx += nx; dy += ny; urgent = true
      }
      if (!this.ffa) {
        for (const e of enemies) {
          if (!e.charging) continue
          const toMe = Math.atan2(pos[1] - e.pos[1], pos[0] - e.pos[0])
          if (Math.abs(wrap(e.aim[0] - toMe)) > Math.max(0.06, Math.atan2(6, hyp2(pos, e.pos))) || !losTo(e)) continue
          const side = -(Math.sign(wrap(e.aim[0] - toMe)) || 1)
          dx += -Math.sin(toMe) * side * 1.5; dy += Math.cos(toMe) * side * 1.5; urgent = true
        }
      }
      if (urgent && this.mode !== "capture") {
        const l = Math.hypot(dx, dy)
        if (l > 0.01) {
          mv = [mv[0] * 0.3 + (dx / l) * 0.95, mv[1] * 0.3 + (dy / l) * 0.95]
          const ml = Math.hypot(mv[0], mv[1])
          if (ml > 1) mv = [mv[0] / ml, mv[1] / ml]
          if (me.energy > (lightIdx >= 0 && target ? 50 : 25)) boost = true
          this.mode += "+dodge"
        }
      }
    }
    mv = this.wallSafe(pos, mv)

    // ---- stuck handling ----
    const moving = Math.hypot(mv[0], mv[1]) > 0.3
    const fighting = /^(fight|peek|retreat|dodge|break-los)/.test(this.mode) || this.mode.includes("+dodge")
    if (moving && !fighting && this.posHist.length > 8 && t > this.stuckUntil) {
      const old = this.posHist[0]
      if (t - old.t > 0.9 && hyp2(old.p, pos) < 1.2) {
        this.stuckUntil = t + 1.2
        const a = Math.atan2(mv[1], mv[0]) + (this.rand() < 0.5 ? 1 : -1) * (Math.PI / 2 + this.rand() * 0.8)
        this.stuckDir = [Math.cos(a), Math.sin(a)]
        this.path = null
      }
    }
    if (t < this.stuckUntil) {
      const f = (this.stuckUntil - t) / 1.2
      if (f > 0.5) {
        mv = this.stuckDir
        jump = me.grounded
        boost = !me.grounded && me.energy > 20
      } else {
        // jet forward over obstacle
        jump = me.grounded
        boost = me.energy > 20
      }
    }

    // ---- aim when nothing to shoot: face threats or scan ----
    if (!haveAim) {
      let yaw: number
      if (t - this.threatT < 2.5 && this.threatBearing != null) yaw = this.threatBearing
      else if (target) yaw = Math.atan2(target.pos[1] - pos[1], target.pos[0] - pos[0])
      else if (t - this.heardT < 1.5 && this.heardBearing != null) yaw = this.heardBearing
      else {
        const base = Math.hypot(mv[0], mv[1]) > 0.1 ? Math.atan2(mv[1], mv[0]) : me.aim[0]
        this.scanPhase += 0.1
        yaw = base + Math.sin(this.scanPhase * 1.8) * 1.3
      }
      aimYaw = yaw
      aimPitch = 0
    }

    act.move = [mv[0], mv[1]]
    act.boost = boost
    act.jump = jump
    act.aim = [wrap(aimYaw), clamp(aimPitch, this.cfg.mech.min_pitch ?? -0.7, this.cfg.mech.max_pitch ?? 1.3)]
    act.fire = fire

    draw.label(`${this.ffa ? "ffa " : hunt ? "hunt " : ""}${this.mode} hp${Math.round(me.hp)} e${Math.round(me.energy)} ${target ? "T" + target.id : ""}`)
    return act
  }
}

run((hello) => new Brain(hello))
