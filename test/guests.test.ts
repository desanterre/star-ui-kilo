// The office map used by the guests (media/guests.js): every spot is reachable, and nobody walks
// through walls or furniture.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import * as path from "node:path"
import { describe, it } from "node:test"

const G = createRequire(__filename)(path.resolve("media/guests.js"))

describe("office map", () => {
  const grid = G.buildGrid()
  const spots = Object.entries(G.SPOTS as Record<string, { x: number; y: number }[]>).flatMap(([zone, list]) =>
    list.map((s, i) => ({ ...s, label: `${zone}${i}` })),
  )
  // How far a point is from the walkable floor, in pixels (0 when it is on it).
  const off = (x: number, y: number) => {
    if (G.walkable(x, y)) return 0
    for (let d = 1; d < 30; d++) {
      for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]) if (G.walkable(x + dx, y + dy)) return d
    }
    return 99
  }

  it("puts every spot on the floor", () => {
    for (const s of spots) assert.ok(G.walkable(s.x, s.y), s.label)
  })

  it("finds a way between any two spots, around walls and furniture", () => {
    let worst = 0
    for (const a of spots) {
      for (const b of spots) {
        if (a === b) continue
        const way = G.findPath(grid, a, b)
        assert.ok(way && way.length, `${a.label} -> ${b.label}`)
        assert.deepEqual(way[way.length - 1], { x: b.x, y: b.y })
        let prev = a
        for (const p of way) {
          const d = Math.hypot(p.x - prev.x, p.y - prev.y)
          for (let k = 1; k < d; k += 2) worst = Math.max(worst, off(prev.x + ((p.x - prev.x) * k) / d, prev.y + ((p.y - prev.y) * k) / d))
          prev = p
        }
      }
    }
    assert.ok(worst <= 3, `a path leaves the floor by ${worst}px`)
  })

  it("sends each agent to the room that matches what it does", () => {
    assert.equal(G.zoneOf({ state: "writing", busy: true }), "work")
    assert.equal(G.zoneOf({ state: "idle", busy: false, waiting: { kind: "permission" } }), "work")
    assert.equal(G.zoneOf({ state: "idle", busy: false }), "idle")
    assert.equal(G.zoneOf({ state: "error", busy: true }), "error")
    assert.equal(G.zoneOf({ state: "syncing", busy: true }), "sync")
  })

  it("draws props as rectangles with known colors", () => {
    for (const [name, frames] of Object.entries(G.ART as Record<string, string[][]>)) {
      const w = frames[0][0].length
      for (const frame of frames) {
        assert.equal(frame.length, frames[0].length, name)
        for (const line of frame) {
          assert.equal(line.length, w, `${name}: ${line}`)
          for (const ch of line) assert.ok(ch === "." || G.PALETTE[ch], `${name}: ${ch}`)
        }
      }
    }
  })
})
