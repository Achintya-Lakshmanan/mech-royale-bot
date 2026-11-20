/** Static map model: terrain heights, a walkability grid, line-of-sight and A* pathfinding. */
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const CELL = 2 // meters per planning cell

type Prism = { kind: string; base: number; top: number; ring: number[]; holes: number[][] | number[] }

export class GameMap {
  tnx = 0
  tny = 0
  tminX = 0
  tminY = 0
  terr!: Int16Array
  gw = 0
  gh = 0
  ox = 0
  oy = 0
  /** 1 = blocked for walking */
  blocked!: Uint8Array
  /** distance (cells) to nearest blocked cell, capped */
  clear!: Uint8Array
  /** top height of solid geometry standing on the ground at this cell (for line of sight), or -1e9 */
  solidTop!: Float32Array
  ok = false

  constructor(dir: string) {
    try {
      this.load(dir)
      this.ok = true
    } catch (e) {
      process.stderr.write(`map load failed: ${e}\n`)
    }
  }

  private load(dir: string) {
    const world = JSON.parse(readFileSync(join(dir, "v2/world.json"), "utf8"))
    const t = world.terrain
    this.tnx = t.nx
    this.tny = t.ny
    this.tminX = t.minX
    this.tminY = t.minY
    const buf = readFileSync(join(dir, "v2/" + (t.file ?? "terrain.i16")))
    this.terr = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + this.tnx * this.tny * 2))

    const b = world.bounds
    this.ox = b.minX
    this.oy = b.minY
    this.gw = Math.ceil((b.maxX - b.minX) / CELL)
    this.gh = Math.ceil((b.maxY - b.minY) / CELL)
    const n = this.gw * this.gh
    this.blocked = new Uint8Array(n)
    this.solidTop = new Float32Array(n).fill(-1e9)
    const ground = new Float32Array(n)
    for (let j = 0; j < this.gh; j++)
      for (let i = 0; i < this.gw; i++) ground[j * this.gw + i] = this.ground(this.ox + (i + 0.5) * CELL, this.oy + (j + 0.5) * CELL)

    for (const p of world.prisms as Prism[]) {
      const ring = p.ring
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (let k = 0; k < ring.length; k += 2) {
        x0 = Math.min(x0, ring[k]); x1 = Math.max(x1, ring[k])
        y0 = Math.min(y0, ring[k + 1]); y1 = Math.max(y1, ring[k + 1])
      }
      const holes: number[][] = Array.isArray(p.holes) && p.holes.length && Array.isArray(p.holes[0]) ? (p.holes as number[][]) : []
      const i0 = Math.max(0, Math.floor((x0 - this.ox) / CELL)), i1 = Math.min(this.gw - 1, Math.floor((x1 - this.ox) / CELL))
      const j0 = Math.max(0, Math.floor((y0 - this.oy) / CELL)), j1 = Math.min(this.gh - 1, Math.floor((y1 - this.oy) / CELL))
      for (let j = j0; j <= j1; j++) {
        const cy = this.oy + (j + 0.5) * CELL
        for (let i = i0; i <= i1; i++) {
          const cx = this.ox + (i + 0.5) * CELL
          if (!pip(ring, cx, cy)) continue
          let inHole = false
          for (const h of holes) if (pip(h, cx, cy)) { inHole = true; break }
          if (inHole) continue
          const idx = j * this.gw + i
          const g = ground[idx]
          if (p.base < g + 9.5 && p.top > g + 1.2) this.blocked[idx] = 1
          if (p.base < g + 3 && p.top > this.solidTop[idx]) this.solidTop[idx] = p.top
        }
      }
    }
    // steep slopes and map edge
    const maxTan = Math.tan((48 * Math.PI) / 180)
    for (let j = 0; j < this.gh; j++)
      for (let i = 0; i < this.gw; i++) {
        const idx = j * this.gw + i
        if (i === 0 || j === 0 || i === this.gw - 1 || j === this.gh - 1) { this.blocked[idx] = 1; continue }
        const dx = (ground[idx + 1] - ground[idx - 1]) / (2 * CELL)
        const dy = (ground[idx + this.gw] - ground[idx - this.gw]) / (2 * CELL)
        if (Math.hypot(dx, dy) > maxTan) this.blocked[idx] = 1
      }
    // clearance transform (chamfer, cells)
    const c = new Uint8Array(n).fill(255)
    for (let k = 0; k < n; k++) if (this.blocked[k]) c[k] = 0
    const W = this.gw
    for (let j = 1; j < this.gh; j++)
      for (let i = 1; i < W - 1; i++) {
        const k = j * W + i
        c[k] = Math.min(c[k], c[k - 1] + 1, c[k - W] + 1, c[k - W - 1] + 1, c[k - W + 1] + 1)
      }
    for (let j = this.gh - 2; j >= 0; j--)
      for (let i = W - 2; i >= 1; i--) {
        const k = j * W + i
        c[k] = Math.min(c[k], c[k + 1] + 1, c[k + W] + 1, c[k + W + 1] + 1, c[k + W - 1] + 1)
      }
    this.clear = c
  }

  /** ground height (bilinear terrain) */
  ground(x: number, y: number): number {
    if (!this.terr) return 0
    let fx = x - this.tminX, fy = y - this.tminY
    fx = Math.max(0, Math.min(this.tnx - 1.001, fx))
    fy = Math.max(0, Math.min(this.tny - 1.001, fy))
    const i = Math.floor(fx), j = Math.floor(fy)
    const ax = fx - i, ay = fy - j
    const k = j * this.tnx + i
    const t = this.terr
    const h = (t[k] * (1 - ax) + t[k + 1] * ax) * (1 - ay) + (t[k + this.tnx] * (1 - ax) + t[k + this.tnx + 1] * ax) * ay
    return h * 0.01
  }

  ci(x: number) { return Math.floor((x - this.ox) / CELL) }
  cj(y: number) { return Math.floor((y - this.oy) / CELL) }
  idx(x: number, y: number) {
    const i = this.ci(x), j = this.cj(y)
    if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) return -1
    return j * this.gw + i
  }
  clearAt(x: number, y: number): number {
    const k = this.idx(x, y)
    return k < 0 ? 0 : this.clear[k]
  }
  cx(i: number) { return this.ox + (i + 0.5) * CELL }
  cy(j: number) { return this.oy + (j + 0.5) * CELL }

  /** true if the straight segment is unobstructed for a walking mech (clearance >= minClear cells) */
  walkLine(ax: number, ay: number, bx: number, by: number, minClear = 2): boolean {
    if (!this.ok) return true
    const d = Math.hypot(bx - ax, by - ay)
    const steps = Math.max(1, Math.ceil(d / 1.0))
    for (let s = 1; s <= steps; s++) {
      const f = s / steps
      if (this.clearAt(ax + (bx - ax) * f, ay + (by - ay) * f) < minClear) return false
    }
    return true
  }

  /** line of sight between two 3D points against buildings and terrain */
  los(a: number[], b: number[]): boolean {
    if (!this.ok) return true
    const d = Math.hypot(b[0] - a[0], b[1] - a[1])
    const steps = Math.max(1, Math.ceil(d / 1.5))
    for (let s = 1; s < steps; s++) {
      const f = s / steps
      const x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f, z = a[2] + (b[2] - a[2]) * f
      const k = this.idx(x, y)
      if (k < 0) return false
      if (z < this.solidTop[k] - 0.3) return false
      if (z < this.ground(x, y) - 0.2) return false
    }
    return true
  }

  /** nearest walkable cell (clearance >= minClear) to a point, via a small spiral search */
  nearestFree(x: number, y: number, minClear = 2, maxR = 40): number {
    const i0 = this.ci(x), j0 = this.cj(y)
    for (let r = 0; r <= maxR; r++) {
      let best = -1, bestD = Infinity
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
          const i = i0 + di, j = j0 + dj
          if (i < 1 || j < 1 || i >= this.gw - 1 || j >= this.gh - 1) continue
          const k = j * this.gw + i
          if (this.clear[k] >= minClear) {
            const dd = di * di + dj * dj
            if (dd < bestD) { bestD = dd; best = k }
          }
        }
      if (best >= 0) return best
    }
    return -1
  }

  private gScore?: Float32Array
  private came?: Int32Array
  private stamp?: Uint32Array
  private closedStamp?: Uint32Array
  private curStamp = 0

  /** A* from (sx,sy) to (tx,ty); returns world waypoints, or null. maxExpand bounds the cost. */
  path(sx: number, sy: number, tx: number, ty: number, maxExpand = 60000): number[][] | null {
    if (!this.ok) return null
    const W = this.gw
    const n = W * this.gh
    if (!this.gScore) {
      this.gScore = new Float32Array(n)
      this.came = new Int32Array(n)
      this.stamp = new Uint32Array(n)
      this.closedStamp = new Uint32Array(n)
    }
    const g = this.gScore, came = this.came!, stamp = this.stamp!, closed = this.closedStamp!
    const st = ++this.curStamp
    const s = this.nearestFree(sx, sy, 2, 15)
    const t = this.nearestFree(tx, ty, 2, 30)
    if (s < 0 || t < 0) return null
    const ti = t % W, tj = (t / W) | 0
    const h = (k: number) => {
      const dx = Math.abs((k % W) - ti), dy = Math.abs(((k / W) | 0) - tj)
      return (dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)) * 1.0
    }
    const heap = new Heap()
    g[s] = 0; came[s] = -1; stamp[s] = st
    heap.push(s, h(s))
    let found = false, expanded = 0, bestK = s, bestH = h(s)
    const DI = [1, -1, 0, 0, 1, 1, -1, -1]
    const DJ = [0, 0, 1, -1, 1, -1, 1, -1]
    const DC = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2]
    while (heap.size) {
      const k = heap.pop()
      if (closed[k] === st) continue
      closed[k] = st
      if (k === t) { found = true; break }
      const hk = h(k)
      if (hk < bestH) { bestH = hk; bestK = k }
      if (++expanded > maxExpand) break
      const ki = k % W, kj = (k / W) | 0
      for (let d = 0; d < 8; d++) {
        const ni = ki + DI[d], nj = kj + DJ[d]
        if (ni < 1 || nj < 1 || ni >= W - 1 || nj >= this.gh - 1) continue
        const nk = nj * W + ni
        const cl = this.clear[nk]
        if (cl < 2) continue
        if (d >= 4 && (this.clear[kj * W + ni] < 2 || this.clear[nj * W + ki] < 2)) continue
        const pen = cl === 2 ? 1.6 : cl === 3 ? 0.5 : 0
        const ng = g[k] + DC[d] * (1 + pen)
        if (stamp[nk] !== st || ng < g[nk]) {
          stamp[nk] = st
          g[nk] = ng
          came[nk] = k
          heap.push(nk, ng + h(nk))
        }
      }
    }
    let k = found ? t : bestK
    const pts: number[][] = []
    let guard = 0
    while (k >= 0 && guard++ < n) {
      pts.push([this.cx(k % W), this.cy((k / W) | 0)])
      if (k === s) break
      k = came[k]
    }
    pts.reverse()
    return pts
  }
}

function pip(ring: number[], x: number, y: number): boolean {
  let inside = false
  const n = ring.length / 2
  for (let a = 0, b = n - 1; a < n; b = a++) {
    const xa = ring[2 * a], ya = ring[2 * a + 1], xb = ring[2 * b], yb = ring[2 * b + 1]
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside
  }
  return inside
}

class Heap {
  k: number[] = []
  p: number[] = []
  get size() { return this.k.length }
  push(key: number, pri: number) {
    const K = this.k, P = this.p
    let i = K.length
    K.push(key); P.push(pri)
    while (i > 0) {
      const par = (i - 1) >> 1
      if (P[par] <= pri) break
      K[i] = K[par]; P[i] = P[par]; i = par
    }
    K[i] = key; P[i] = pri
  }
  pop(): number {
    const K = this.k, P = this.p
    const top = K[0]
    const lk = K.pop()!, lp = P.pop()!
    const n = K.length
    if (n) {
      let i = 0
      while (true) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && P[c + 1] < P[c]) c++
        if (P[c] >= lp) break
        K[i] = K[c]; P[i] = P[c]; i = c
      }
      K[i] = lk; P[i] = lp
    }
    return top
  }
}
