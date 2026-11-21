/**
 * Precompute an exposure map: for each 4 m ground cell, the fraction of nearby ground positions (within
 * RANGE m) whose eye can see a mech standing there. Buildings and terrain block; tree crowns block once a
 * line has passed through ~4 m of canopy (world.json rules: canopyDensity / canopyBlockT).
 *
 *   bun tools/mkexposure.ts /path/to/kit/arena exposure.bin
 *
 * Output: 5 little-endian int32 (ox, oy, nx, ny, cell) then nx*ny bytes: 0..254 = exposure * 254, 255 = not walkable.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { GameMap } from "../map.ts"

const dir = process.argv[2], out = process.argv[3] ?? "exposure.bin"
const C = 4, RANGE = 160, SAMPLES = 220
const map = new GameMap(dir)
if (!map.ok) throw new Error("map failed to load")
const world = JSON.parse(readFileSync(join(dir, "v2/world.json"), "utf8"))
const b = world.bounds
const ox = Math.floor(b.minX), oy = Math.floor(b.minY)
const nx = Math.ceil((b.maxX - ox) / C), ny = Math.ceil((b.maxY - oy) / C)

// tree crowns, hashed on an 8 m grid
const tf: string[] = world.trees.fields, td: number[] = world.trees.data, F = tf.length
const col = (n: string) => tf.indexOf(n)
const [cX, cY, cH, cR, cB] = [col("crownX"), col("crownY"), col("height"), col("crownR"), col("crownBase")]
const crowns: number[][] = []
for (let i = 0; i < td.length; i += F) crowns.push([td[i + cX], td[i + cY], td[i + cB], td[i + cH], td[i + cR]])
const H = 8, hash = new Map<number, number[][]>()
for (const c of crowns) {
  for (let gx = Math.floor((c[0] - c[4]) / H); gx <= Math.floor((c[0] + c[4]) / H); gx++)
    for (let gy = Math.floor((c[1] - c[4]) / H); gy <= Math.floor((c[1] + c[4]) / H); gy++) {
      const k = gx * 100003 + gy
      if (!hash.has(k)) hash.set(k, [])
      hash.get(k)!.push(c)
    }
}
const canopyLimit = Math.log(1 / (world.rules?.canopyBlockT ?? 0.25)) / (world.rules?.canopyDensity ?? 0.35)

function sees(a: number[], p: number[]): boolean {
  if (!map.los(a, p)) return false
  const d = Math.hypot(p[0] - a[0], p[1] - a[1]), steps = Math.max(1, Math.ceil(d / 1.5))
  let inCanopy = 0
  for (let s = 1; s < steps; s++) {
    const f = s / steps, x = a[0] + (p[0] - a[0]) * f, y = a[1] + (p[1] - a[1]) * f, z = a[2] + (p[2] - a[2]) * f
    const list = hash.get(Math.floor(x / H) * 100003 + Math.floor(y / H))
    if (!list) continue
    for (const c of list) {
      if (z >= c[2] && z <= c[3] && (x - c[0]) ** 2 + (y - c[1]) ** 2 < c[4] * c[4]) { inCanopy += d / steps; break }
    }
    if (inCanopy > canopyLimit) return false
  }
  return true
}

let seed = 12345
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296)
const walk = (x: number, y: number) => map.clearAt(x, y) >= 2
const grid = new Uint8Array(nx * ny).fill(255)
const t0 = performance.now()
for (let j = 0; j < ny; j++) {
  for (let i = 0; i < nx; i++) {
    const x = ox + (i + 0.5) * C, y = oy + (j + 0.5) * C
    if (!walk(x, y)) continue
    const gz = map.ground(x, y)
    const tgt = [x, y, gz + 4.5], top = [x, y, gz + 9]
    let seen = 0, n = 0
    for (let s = 0; s < SAMPLES * 3 && n < SAMPLES; s++) {
      const r = RANGE * Math.sqrt(rnd()), a = rnd() * Math.PI * 2
      const sx = x + Math.cos(a) * r, sy = y + Math.sin(a) * r
      if (!walk(sx, sy)) continue
      n++
      const eye = [sx, sy, map.ground(sx, sy) + 8]
      if (sees(eye, tgt) || sees(eye, top)) seen++
    }
    grid[j * nx + i] = n ? Math.round((seen / n) * 254) : 255
  }
  if (j % 20 === 0) process.stderr.write(`row ${j}/${ny} ${((performance.now() - t0) / 1000).toFixed(0)}s\n`)
}
const head = new Int32Array([ox, oy, nx, ny, C])
writeFileSync(out, Buffer.concat([Buffer.from(head.buffer), Buffer.from(grid)]))
process.stderr.write(`wrote ${out}: ${nx}x${ny} cells in ${((performance.now() - t0) / 1000).toFixed(0)}s\n`)
