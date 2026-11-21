/**
 * steelhead v2: built for the practice squad (one bot vs 15 cooperating house bots that hunt in waves).
 * Points = house bots that die before us, almost all by our hand, so v2 is a fast hunter-killer:
 *   arm up at once (laser / lightning), snipe with the laser at 80-140 m, close in with lightning, focus fire and
 *   finish, grab a kill's cubes (snowball HP and damage), take supply drops, farm cubes between waves, jink and
 *   dodge, retreat only when clearly losing. After a free-for-all is detected (more mechs died than we killed + 1)
 *   it only opens cheap fights.
 * Uses our map model (map.ts) for line of sight, cover and A*.
 */
import { type Action, type ActorObs, draw, type Hello, type Observation, run } from "./mechfight.ts"
import { GameMap } from "./map.ts"

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
// laser and lightning win fights; the mortar is a liability (cook-off) and misses moving targets
const WEAPON_RANK: Record<string, number> = { laser: 3, lightning: 2.8, gun: 1, mortar: -1 }
const UPGRADES = [
  "plating", "armor", "nanites", "laser_damage", "lightning_efficiency", "gun_rate", "laser_charge", "gun_damage",
  "gyros", "capacitor", "reactor", "lightning_range", "gun_mag", "servos", "sensors", "gun_velocity", "jets",
  "lightning_chain", "laser_pierce", "mortar_reload", "mortar_velocity", "mortar_splash",
]

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

type Pick = { id: number; kind: string; pos: number[] }

class Brain {
  name = "steelhead"
  cfg: any
  map: GameMap
  rand: () => number
  // navigation
  path: number[][] | null = null
  pathGoal: number[] | null = null
  pathIdx = 0
  pathTime = -99
  posHist: { t: number; p: V }[] = []
  stuckUntil = 0
  stuckDir: [number, number] = [0, 0]
  // memory
  picks = new Map<number, Pick>()
  attackers = new Map<number, number>()
  dmgLog: { t: number; amt: number }[] = []
  lastHitT = -99
  lastHitBearing = 0
  heardBearing: number | null = null
  heardT = -99
  kills = 0
  ffa = false
  killSpot: { p: number[]; t: number } | null = null
  // combat
  targetId = -1
  strafeSign = 1
  strafeUntil = 0
  recovering = false
  coverGoal: number[] | null = null
  coverT = -99
  peekGoal: number[] | null = null
  peekT = -99
  scan = 0
  mode = ""

  constructor(hello: Hello) {
    this.cfg = hello.config
    this.rand = rng(hello.seed ^ 0x5bd1e995)
    const t0 = performance.now()
    this.map = new GameMap(hello.map.dir)
    if (this.map.ok) {
      for (let i = 0; i < 10; i++) {
        const a = [-300 + i * 50, -200 + i * 30], b = [200 - i * 40, 250 - i * 35]
        this.map.path(a[0], a[1], b[0], b[1], 40000)
        this.map.los([a[0], a[1], 5], [b[0], b[1], 5])
      }
    }
    process.stderr.write(`v2 map ${this.map.ok} in ${(performance.now() - t0).toFixed(0)}ms\n`)
  }

  // ---------------- zone ----------------
  zoneAt(obs: Observation, t: number) {
    const z = obs.zone
    if (t <= z.shrink_start) return { c: z.center, r: z.radius }
    if (t >= z.shrink_end) return { c: z.next_center, r: z.next_radius }
    const f = (t - z.shrink_start) / Math.max(0.01, z.shrink_end - z.shrink_start)
    return {
      c: [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f],
      r: z.radius + (z.next_radius - z.radius) * f,
    }
  }
  zoneSafe(obs: Observation, p: V, margin = 15): boolean {
    const z = obs.zone
    const cur = this.zoneAt(obs, obs.t + 3)
    if (hyp2(p, cur.c) > cur.r - margin) return false
    const dNext = hyp2(p, z.next_center) - (z.next_radius - margin)
    if (dNext > 0 && z.shrink_start - obs.t < dNext / 10 + 12) return false
    return true
  }
  zoneGoal(obs: Observation, me: V): number[] {
    const z = obs.zone, nc = z.next_center
    const keep = Math.min(Math.max(0, z.next_radius) * 0.5, hyp2(me, nc))
    const [ux, uy] = norm2(me[0] - nc[0], me[1] - nc[1])
    return [nc[0] + ux * keep, nc[1] + uy * keep]
  }

  // ---------------- geometry ----------------
  coverFrom(obs: Observation, me: V, threat: ActorObs, maxR = 50): number[] | null {
    if (!this.map.ok) return null
    if (this.coverGoal && obs.t - this.coverT < 1.0 && hyp2(me, this.coverGoal) <= maxR + 3) return this.coverGoal
    const te = [threat.pos[0], threat.pos[1], threat.pos[2] + 8 * (1 + 0.05 * (threat.cubes ?? 0))]
    let best: number[] | null = null, bs = -Infinity
    for (const r of [6, 10, 16, 24, 34, 50]) {
      if (r > maxR) break
      for (let k = 0; k < 16; k++) {
        const a = (k * TAU) / 16
        const x = me[0] + Math.cos(a) * r, y = me[1] + Math.sin(a) * r
        if (this.map.clearAt(x, y) < 3 || !this.zoneSafe(obs, [x, y], 12)) continue
        const gz = this.map.ground(x, y)
        if (this.map.los(te, [x, y, gz + 4.5]) || this.map.los(te, [x, y, gz + 9])) continue
        let s = -r
        if (!this.map.walkLine(me[0], me[1], x, y, 2)) s -= 20
        if (s > bs) { bs = s; best = [x, y] }
      }
    }
    this.coverGoal = best
    this.coverT = obs.t
    return best
  }

  /** a spot within 28 m with a line of fire to the target that other hostiles cannot see */
  peekSpot(obs: Observation, me: V, target: ActorObs, others: ActorObs[]): number[] | null {
    if (!this.map.ok || others.length === 0) return null
    if (obs.t - this.peekT < 0.5) return this.peekGoal
    const tz = target.pos[2] + 4.5 * (1 + 0.05 * (target.cubes ?? 0))
    const eyes = others.slice(0, 4).map((o) => [o.pos[0], o.pos[1], o.pos[2] + 8 * (1 + 0.05 * (o.cubes ?? 0))])
    const muz = obs.self.stats.muzzle_height ?? 7
    let best: number[] | null = null, bs = Infinity
    for (const r of [0, 7, 14, 21, 28]) {
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
    this.peekGoal = best && bs < 100 ? best : null
    this.peekT = obs.t
    return this.peekGoal
  }

  navTo(obs: Observation, me: V, goal: number[], stopDist = 2): [number, number] {
    const d = hyp2(me, goal)
    if (d < stopDist) return [0, 0]
    if (!this.map.ok) return norm2(goal[0] - me[0], goal[1] - me[1])
    if (d < 60 && this.map.walkLine(me[0], me[1], goal[0], goal[1], 2)) return norm2(goal[0] - me[0], goal[1] - me[1])
    if (!this.path || !this.pathGoal || hyp2(this.pathGoal, goal) > 8 || obs.t - this.pathTime > 4 || this.pathIdx >= this.path.length) {
      this.path = this.map.path(me[0], me[1], goal[0], goal[1], 40000)
      this.pathGoal = goal.slice()
      this.pathTime = obs.t
      this.pathIdx = 0
    }
    const p = this.path
    if (!p || p.length < 2) return norm2(goal[0] - me[0], goal[1] - me[1])
    let best = this.pathIdx, bestD = Infinity
    for (let i = this.pathIdx; i < Math.min(p.length, this.pathIdx + 30); i++) {
      const dd = hyp2(me, p[i])
      if (dd < bestD) { bestD = dd; best = i }
    }
    this.pathIdx = best
    if (bestD > 12) this.pathTime = -99
    let tgt = p[Math.min(p.length - 1, best + 1)]
    for (let i = Math.min(p.length - 1, best + 25); i > best; i--) {
      if (this.map.walkLine(me[0], me[1], p[i][0], p[i][1], 2)) { tgt = p[i]; break }
    }
    return norm2(tgt[0] - me[0], tgt[1] - me[1])
  }

  wallSafe(me: V, mv: [number, number]): [number, number] {
    if (!this.map.ok || (mv[0] === 0 && mv[1] === 0)) return mv
    if (this.map.clearAt(me[0] + mv[0] * 5, me[1] + mv[1] * 5) >= 2) return mv
    for (const da of [0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.2, -2.2]) {
      const a = Math.atan2(mv[1], mv[0]) + da
      const c = [Math.cos(a), Math.sin(a)]
      if (this.map.clearAt(me[0] + c[0] * 5, me[1] + c[1] * 5) >= 2) {
        const l = Math.hypot(mv[0], mv[1])
        return [c[0] * l, c[1] * l]
      }
    }
    return mv
  }

  /** lead aim for a projectile of the given speed (Infinity = hitscan); extra = seconds until the shot leaves */
  aim(me: Observation["self"], tgt: ActorObs, speed: number, extra = 0.05) {
    const mz = me.pos[2] + (me.stats.muzzle_height ?? 7)
    const hz = tgt.kind === "mech" ? 4.5 * (1 + 0.05 * (tgt.cubes ?? 0)) : 1.75
    let px = tgt.pos[0], py = tgt.pos[1], pz = tgt.pos[2] + hz
    for (let i = 0; i < 3; i++) {
      const tt = (isFinite(speed) ? Math.hypot(px - me.pos[0], py - me.pos[1], pz - mz) / speed : 0) + extra
      px = tgt.pos[0] + tgt.vel[0] * tt
      py = tgt.pos[1] + tgt.vel[1] * tt
      pz = tgt.pos[2] + hz + (tgt.vel[2] ?? 0) * Math.min(tt, 0.3)
    }
    const dist = Math.hypot(px - me.pos[0], py - me.pos[1])
    return { yaw: Math.atan2(py - me.pos[1], px - me.pos[0]), pitch: Math.atan2(pz - mz, dist), dist }
  }

  /** damage we can put out in the next ~2 s at distance d */
  burst(me: Observation["self"], d: number): number {
    const scale = 1 + (this.cfg.cubes?.damage_per_cube ?? 0.04) * Math.min(me.cubes ?? 0, this.cfg.cubes?.stat_cap ?? 10)
    let b = 0
    for (const w of me.weapons) {
      if (!w) continue
      const s = w.stats as Record<string, number>
      if (w.kind === "gun" && (w.reload ?? 0) <= 0 && d < (s.range ?? 230)) b += Math.min(w.ammo ?? 0, 9) * (s.damage ?? 45) * (d < 50 ? 0.8 : d < 100 ? 0.6 : 0.35)
      else if (w.kind === "laser" && ((w.cooldown ?? 0) < 0.8 || (w.charge ?? 0) > 0) && d < (s.range ?? 280)) b += s.damage ?? 315
      else if (w.kind === "lightning" && d < (s.range ?? 45)) b += Math.min(8, Math.floor(me.energy / (s.energy ?? 3))) * (s.damage ?? 60)
    }
    return b * scale
  }

  /** free-for-all: only open fights that are cheap (close, weakened, already shooting us, or turned away) */
  engageOk(obs: Observation, me: Observation["self"], e: ActorObs, d: number): boolean {
    if (d < 55 || obs.alive <= 4) return true
    if ((e.hp ?? 1400) < 0.55 * (e.max_hp ?? 1400)) return true
    if (obs.t - (this.attackers.get(e.id) ?? -99) < 6 || e.charging) return true
    const toMe = Math.atan2(me.pos[1] - e.pos[1], me.pos[0] - e.pos[0])
    return Math.abs(wrap(e.aim[0] - toMe)) > (75 * Math.PI) / 180
  }

  // ---------------- main ----------------
  act(obs: Observation): Omit<Action, "tick"> {
    const me = obs.self, pos = me.pos, t = obs.t
    const act: Omit<Action, "tick"> = {}
    const slots = me.weapons
    const idx = (k: string) => slots.findIndex((w) => w && w.kind === k)
    const gunI = idx("gun"), laserI = idx("laser"), lightI = idx("lightning")
    const hpFrac = me.hp / me.max_hp
    const muzzle: V = [pos[0], pos[1], pos[2] + (me.stats.muzzle_height ?? 7)]
    const eye: V = [pos[0], pos[1], pos[2] + (me.stats.eye_height ?? 8)]
    const losTo = (m: ActorObs) => {
      const h = m.kind === "mech" ? 4.5 * (1 + 0.05 * (m.cubes ?? 0)) : 1.75
      return this.map.los(muzzle, [m.pos[0], m.pos[1], m.pos[2] + h]) || this.map.los(muzzle, [m.pos[0], m.pos[1], m.pos[2] + h * 1.7])
    }

    // ---- memory ----
    for (const ev of obs.events) {
      if (ev.type === "damaged" && ev.weapon !== "zone") {
        this.lastHitT = t
        if (ev.bearing != null) this.lastHitBearing = ev.bearing
        if (ev.by != null) this.attackers.set(ev.by, t)
        this.dmgLog.push({ t, amt: ev.amount })
      }
      if (ev.type === "kill") {
        this.kills++
        const v = obs.mechs.find((m) => m.id === ev.target)
        if (v) this.killSpot = { p: v.pos.slice(), t }
      }
      if (ev.type === "took" || (ev.type === "take_failed" && (ev.reason === "gone" || ev.reason === "have"))) this.picks.delete(ev.id)
      if (ev.type === "take_failed" || ev.type === "took") this.path = null
    }
    while (this.dmgLog.length && this.dmgLog[0].t < t - 2.5) this.dmgLog.shift()
    for (const s of obs.sounds) if (s.dist !== "far" && ["gun", "laser", "laser_charge", "lightning", "step", "boost", "jet"].includes(s.kind)) { this.heardBearing = s.bearing; this.heardT = t }
    if (!this.ffa && (this.cfg.match?.mechs ?? 16) - obs.alive > this.kills + 1) this.ffa = true
    {
      const vis = new Set<number>()
      for (const p of obs.pickups) { vis.add(p.id); this.picks.set(p.id, { id: p.id, kind: p.kind, pos: p.pos.slice() }) }
      for (const [id, p] of this.picks) if (!vis.has(id) && hyp2(pos, p.pos) < 25) this.picks.delete(id)
    }
    this.posHist.push({ t, p: pos.slice() })
    while (this.posHist.length && this.posHist[0].t < t - 1.2) this.posHist.shift()

    // ---- upgrades ----
    if (obs.offer) {
      let bi = 0, br = 1e9
      obs.offer.choices.forEach((c, i) => {
        const r = UPGRADES.indexOf(c.id)
        if ((r < 0 ? 50 : r) < br) { br = r < 0 ? 50 : r; bi = i }
      })
      act.pick = bi
    }

    // ---- take weapons in reach ----
    {
      const reach = (this.cfg.loot?.pickup_radius ?? 4) - 0.4
      for (const p of obs.pickups) {
        if (hyp2(pos, p.pos) > reach || Math.abs(p.pos[2] - pos[2]) > 3.5 || idx(p.kind) >= 0) continue
        const pv = WEAPON_RANK[p.kind] ?? 0
        if (pv < 0) continue
        if (!slots[1]) { act.take = p.id; break }
        let worst = -1, wv = 1e9
        slots.forEach((w, i) => {
          if (!w || (w.kind === "laser" && (w.charge ?? 0) > 0)) return
          const v = WEAPON_RANK[w.kind] ?? 0
          if (v < wv) { wv = v; worst = i }
        })
        if (worst >= 0 && pv > wv + 0.5) { act.take = p.id; act.drop = worst; break }
      }
    }

    // ---- target ----
    const enemies = obs.mechs.filter((m) => m.kind === "mech")
    let target: ActorObs | null = null, best = Infinity
    for (const e of enemies) {
      const d = hyp2(pos, e.pos)
      if (this.ffa && !this.engageOk(obs, me, e, d)) continue
      const los = losTo(e)
      const killable = (e.hp ?? 1400) <= this.burst(me, d)
      let s = d + (e.hp ?? 1400) * 0.1 - (los ? 40 : 0)
      if (t - (this.attackers.get(e.id) ?? -99) < 3) s -= 50
      if (e.id === this.targetId && los) s -= 60
      if (killable && los) s -= 120
      if (s < best) { best = s; target = e }
    }
    this.targetId = target ? target.id : -1
    const tDist = target ? hyp2(pos, target.pos) : Infinity
    const tLos = target ? losTo(target) : false

    // threats with a line of fire on us
    let shooters = 0
    for (const e of enemies) {
      const toMe = Math.atan2(pos[1] - e.pos[1], pos[0] - e.pos[0])
      if (hyp2(pos, e.pos) < 230 && Math.abs(wrap(toMe - e.aim[0])) < 0.3 && losTo(e)) shooters++
    }
    const dps = this.dmgLog.reduce((a, d) => a + d.amt, 0) / 2.5
    const near = enemies.filter((e) => hyp2(pos, e.pos) < 160).length

    // ---- weapons ----
    const fire: [boolean, boolean] = [false, false]
    let aimYaw = me.aim[0], aimPitch = 0, haveAim = false
    const laser = laserI >= 0 ? slots[laserI]! : null
    const charging = !!laser && (laser.charge ?? 0) > 0
    if (target) {
      const ls = laser?.stats as Record<string, number> | undefined
      const lightS = lightI >= 0 ? (slots[lightI]!.stats as Record<string, number>) : null
      const lightUse = !!lightS && tDist < (lightS.range ?? 45) * 0.97 && me.energy > (lightS.energy ?? 3) + 2
      const gs = gunI >= 0 ? (slots[gunI]!.stats as Record<string, number>) : null
      const size = 2.2 * (1 + 0.05 * (target.cubes ?? 0))
      let a
      if (charging || (laser && (laser.cooldown ?? 0) < 0.25 && tDist < (ls?.range ?? 280) && !lightUse)) a = this.aim(me, target, Infinity, 0.1)
      else if (lightUse) a = this.aim(me, target, Infinity, 0.05)
      else a = this.aim(me, target, gs?.speed ?? 252)
      aimYaw = a.yaw; aimPitch = a.pitch; haveAim = true
      const tol = Math.max(0.01, Math.atan2(size, Math.max(1, tDist)))
      const yawErr = Math.abs(wrap(me.aim[0] - a.yaw)), pitchErr = Math.abs(me.aim[1] - a.pitch)
      // lightning: auto-targets the nearest thing in its cone
      if (lightUse && tLos && yawErr < (((lightS!.cone_deg ?? 30) * Math.PI) / 180) * 0.45) fire[lightI] = true
      // laser: charge, release when full and on target
      if (laser) {
        const full = (ls!.charge ?? 0.75) - 0.03
        if (charging) {
          const ready = (laser.charge ?? 0) >= full
          const on = tLos && yawErr < tol * 0.9 && pitchErr < tol * 1.5 + 0.01
          fire[laserI] = !(ready && on)
          if ((laser.charge ?? 0) > full + (ls!.hold_s ?? 2) - 0.3 && !on) fire[laserI] = true // let it time out rather than waste it
        } else if ((laser.cooldown ?? 0) <= 0.05 && tLos && tDist < (ls!.range ?? 280) * 0.97 && !(lightUse && tDist < 30)) {
          fire[laserI] = true
        }
      }
      // gun: lead and fire when aligned
      if (gunI >= 0) {
        const g = slots[gunI]!
        const ga = this.aim(me, target, gs!.speed ?? 252)
        const gErr = Math.abs(wrap(me.aim[0] - ga.yaw))
        if (tLos && tDist < (gs!.range ?? 230) * 0.97 && (g.reload ?? 0) <= 0 && (g.ammo ?? 1) > 0 && gErr < tol * 1.2 && Math.abs(me.aim[1] - ga.pitch) < tol * 2 + 0.02) fire[gunI] = true
      }
    }
    // keep a charging laser charging if the target slipped out of view
    if (charging && !target) fire[laserI] = true

    // ---- movement ----
    let mv: [number, number] = [0, 0]
    let boost = false, jump = false
    const zoneOk = this.zoneSafe(obs, pos, 10)
    // recovery: only when clearly losing (retreating against a squad that shares vision mostly gets you shot)
    const tFrac = target ? (target.hp ?? 1400) / (target.max_hp ?? 1400) : 1
    const finishing = !!target && tLos && ((target.hp ?? 1400) <= this.burst(me, tDist) || tFrac < 0.2) && hpFrac > 0.15
    const losing = !finishing && ((hpFrac < 0.35 && tFrac > hpFrac + 0.1) || (shooters >= 2 && hpFrac < 0.55) || (shooters >= 3 && hpFrac < 0.8) || (dps > 0 && me.hp / dps < 3))
    if (losing) this.recovering = true
    if (this.recovering && (hpFrac > 0.85 || (t - this.lastHitT > 8 && hpFrac > 0.6))) this.recovering = false
    if (this.recovering && finishing) this.recovering = false

    if (!zoneOk && (!me.in_zone || !target)) {
      this.mode = "zone"
      mv = this.navTo(obs, pos, this.zoneGoal(obs, pos), 5)
      boost = !me.in_zone && me.energy > 10
    } else if (this.recovering) {
      this.mode = "recover"
      const th = target ?? enemies.sort((a, b) => hyp2(pos, a.pos) - hyp2(pos, b.pos))[0]
      const c = th ? this.coverFrom(obs, pos, th, 50) : null
      if (c) { mv = this.navTo(obs, pos, c, 1.5); boost = me.energy > 15 && hyp2(pos, c) > 6 }
      else if (th) { const [rx, ry] = norm2(pos[0] - th.pos[0], pos[1] - th.pos[1]); mv = [rx, ry]; boost = me.energy > 15 }
    } else if (target) {
      this.mode = "fight"
      const lightReady = lightI >= 0 && me.energy > 30
      const laserOk = !!laser
      // range band: lightning brawls close, the laser snipes, the gun sits in between
      let want = 60
      if (lightReady && (!laserOk || tDist < 70)) want = 28
      else if (laserOk) want = 105
      if (finishing) want = Math.min(want, lightReady ? 25 : 45)
      const [rx, ry] = norm2(target.pos[0] - pos[0], target.pos[1] - pos[1])
      let radial = 0
      if (tDist > want + 15) radial = 1
      else if (tDist < want - 15) radial = -0.7
      if (t > this.strafeUntil) {
        this.strafeSign = this.rand() < 0.5 ? -1 : 1
        this.strafeUntil = t + 0.3 + this.rand() * 0.5
      }
      const sw = charging ? 0.5 : 0.9
      mv = norm2(rx * radial - ry * this.strafeSign * sw, ry * radial + rx * this.strafeSign * sw)
      if (radial > 0 && tDist > want + 40 && me.energy > 45) boost = true
      if (!tLos && tDist > 15) mv = this.navTo(obs, pos, target.pos, 4)
      // more than one hostile: fight from a spot only the target can see
      if (tLos) {
        const others = enemies.filter((e) => e.id !== target!.id && hyp2(pos, e.pos) < 200)
        const spot = this.peekSpot(obs, pos, target, others)
        if (spot && hyp2(pos, spot) > 2) { mv = this.navTo(obs, pos, spot, 1); this.mode = "peek" }
      }
    } else {
      // ---- economy: snowball between waves ----
      let goal: number[] | null = null
      this.mode = "roam"
      const armed = laserI >= 0 || lightI >= 0
      // a fresh kill's cubes (dead mechs drop all their cubes + 2)
      let cube: number[] | null = null, cd = Infinity
      for (const c of obs.cubes) {
        const d = hyp2(pos, c.pos)
        if (Math.abs(c.pos[2] - this.map.ground(c.pos[0], c.pos[1])) > 3 || !this.zoneSafe(obs, c.pos, 5)) continue
        if (d < cd) { cd = d; cube = c.pos }
      }
      if (cube && cd < 90) { goal = cube; this.mode = "cube"; if (cd > 25 && me.energy > 40) boost = true }
      // arm up: a laser or lightning first, sprinting if needed
      if (!goal) {
        let bp: Pick | null = null, bs = -Infinity
        for (const p of this.picks.values()) {
          const r = WEAPON_RANK[p.kind] ?? 0
          if (r < 2 || idx(p.kind) >= 0) continue
          const d = hyp2(pos, p.pos)
          if (p.pos[2] - this.map.ground(p.pos[0], p.pos[1]) > 3 && d > 6) continue
          const worstHeld = slots[1] ? Math.min(...slots.map((w) => (w ? WEAPON_RANK[w.kind] ?? 0 : -9))) : -9
          if (r <= worstHeld + 0.5) continue
          if (d > (armed ? 140 : 320) || !this.zoneSafe(obs, p.pos, 5)) continue
          const sc = r * 30 - d
          if (sc > bs) { bs = sc; bp = p }
        }
        if (bp) {
          goal = bp.pos; this.mode = "arm " + bp.kind
          if (!armed && hyp2(pos, bp.pos) > 20 && me.energy > 30) boost = true
          if (hyp2(pos, bp.pos) < (this.cfg.loot?.pickup_radius ?? 4) - 0.5) act.take = bp.id
        }
      }
      // supply drop: 3 cubes, full HP and energy
      if (!goal && obs.drops) {
        for (const d of obs.drops) {
          const dd = hyp2(pos, d.pos)
          if (dd > 260 || (d.holder != null && d.holder !== me.id) || d.lands_in > dd / 11 + 4 || !this.zoneSafe(obs, d.pos, 5)) continue
          goal = dd < d.radius * 0.5 ? null : [d.pos[0], d.pos[1]]
          this.mode = dd < d.radius * 0.5 ? "capture" : "drop"
          if (dd > 30 && me.energy > 40) boost = true
          break
        }
      }
      if (!goal && this.mode !== "capture" && cube && cd < 150) { goal = cube; this.mode = "cube" }
      // crates and drones (cubes) when healthy: walk into range, shooting happens below
      let farm: { pos: number[]; vel: number[]; h: number; id: number } | null = null
      if (!goal && this.mode !== "capture" && hpFrac > 0.5) {
        let fd = Infinity
        for (const n of obs.mechs) {
          if (n.kind !== "npc") continue
          const d = hyp2(pos, n.pos)
          if (d < 140 && d < fd) { fd = d; farm = { pos: n.pos, vel: n.vel, h: 1.75, id: n.id } }
        }
        for (const c of obs.crates) {
          const d = hyp2(pos, c.pos)
          if (Math.abs(c.pos[2] - this.map.ground(c.pos[0], c.pos[1])) > 3) continue
          if (d < 130 && d + 15 < fd) { fd = d; farm = { pos: c.pos, vel: [0, 0, 0], h: 1.2, id: c.id } }
        }
        if (farm) {
          const want = lightI >= 0 ? 32 : 50
          if (fd > want) goal = [farm.pos[0], farm.pos[1]]
          this.mode = "farm"
        }
      }
      if (!goal && !farm && this.mode !== "capture") {
        goal = this.zoneGoal(obs, pos)
        if (hyp2(pos, goal) < 20) goal = null
      }
      if (goal) mv = this.navTo(obs, pos, goal, 1.0)
      // shoot the farm target when nobody is hunting us
      if (farm && t - this.lastHitT > 2) {
        const fp = farm.pos
        const fake = { id: farm.id, kind: "npc", pos: fp, vel: farm.vel, aim: [0, 0] } as unknown as ActorObs
        const a = this.aim(me, fake, gunI >= 0 ? ((slots[gunI]!.stats as Record<string, number>).speed ?? 252) : 252)
        aimYaw = a.yaw; aimPitch = Math.atan2(fp[2] + farm.h - muzzle[2], a.dist); haveAim = true
        const fd = hyp2(pos, fp)
        if (this.map.los(muzzle, [fp[0], fp[1], fp[2] + farm.h])) {
          const err = Math.abs(wrap(me.aim[0] - a.yaw))
          if (gunI >= 0 && (slots[gunI]!.reload ?? 0) <= 0 && err < Math.max(0.01, Math.atan2(1.2, fd))) fire[gunI] = true
          if (lightI >= 0 && fd < 42 && me.energy > 45 && err < 0.2) fire[lightI] = true
        }
        if (fd < 25 && !goal) { const [rx, ry] = norm2(fp[0] - pos[0], fp[1] - pos[1]); mv = [-ry * this.strafeSign * 0.6, rx * this.strafeSign * 0.6] }
      }
      // reload while calm
      if (gunI >= 0) {
        const g = slots[gunI]!
        if ((g.reload ?? 0) <= 0 && (g.ammo ?? 12) < ((g.stats as Record<string, number>).mag ?? 12) * 0.5 && !fire[gunI]) act.reload = true
      }
    }

    // ---- dodge: bullets, shells, a laser being charged at us ----
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
      for (const e of enemies) {
        if (!e.charging) continue
        const toMe = Math.atan2(pos[1] - e.pos[1], pos[0] - e.pos[0])
        const d = hyp2(pos, e.pos)
        if (Math.abs(wrap(e.aim[0] - toMe)) > Math.max(0.06, Math.atan2(6, d)) || !losTo(e)) continue
        // sidestep across its line (it tracks us, so keep changing side)
        const s = this.strafeSign
        dx += -Math.sin(toMe) * s * 1.5; dy += Math.cos(toMe) * s * 1.5; urgent = true
      }
      if (urgent && this.mode !== "capture") {
        const l = Math.hypot(dx, dy)
        if (l > 0.01) {
          mv = [mv[0] * 0.3 + (dx / l) * 0.95, mv[1] * 0.3 + (dy / l) * 0.95]
          const ml = Math.hypot(mv[0], mv[1])
          if (ml > 1) mv = [mv[0] / ml, mv[1] / ml]
          if (me.energy > (lightI >= 0 && target ? 50 : 25)) boost = true
          this.mode += "+dodge"
        }
      }
    }

    mv = this.wallSafe(pos, mv)

    // ---- unstick ----
    if (Math.hypot(mv[0], mv[1]) > 0.3 && this.posHist.length > 8 && t > this.stuckUntil) {
      const old = this.posHist[0]
      if (t - old.t > 0.9 && hyp2(old.p, pos) < 1.2) {
        this.stuckUntil = t + 1.2
        const a = Math.atan2(mv[1], mv[0]) + (this.rand() < 0.5 ? 1 : -1) * (Math.PI / 2 + this.rand() * 0.8)
        this.stuckDir = [Math.cos(a), Math.sin(a)]
        this.path = null
      }
    }
    if (t < this.stuckUntil) {
      if ((this.stuckUntil - t) / 1.2 > 0.5) mv = this.stuckDir
      jump = me.grounded
      boost = !me.grounded ? me.energy > 15 : boost
    }

    // ---- idle aim: face whoever hit us, then sounds, then scan ----
    if (!haveAim) {
      if (t - this.lastHitT < 2.5) aimYaw = this.lastHitBearing
      else if (t - this.heardT < 1.5 && this.heardBearing != null) aimYaw = this.heardBearing
      else {
        const base = Math.hypot(mv[0], mv[1]) > 0.1 ? Math.atan2(mv[1], mv[0]) : me.aim[0]
        this.scan += 0.1
        aimYaw = base + Math.sin(this.scan * 1.8) * 1.2
      }
      aimPitch = 0
    }

    act.move = [mv[0], mv[1]]
    act.boost = boost
    act.jump = jump
    act.aim = [wrap(aimYaw), clamp(aimPitch, this.cfg.mech?.min_pitch ?? -0.7, this.cfg.mech?.max_pitch ?? 1.3)]
    act.fire = fire
    draw.label(`${this.ffa ? "ffa " : ""}${this.mode} hp${Math.round(me.hp)} e${Math.round(me.energy)} ${target ? "T" + target.id : ""}`)
    return act
  }
}

run((hello) => new Brain(hello))
