// Star Office for Kilo — guests: every agent other than the main character.
// Each guest is a small pixel character that walks around walls and furniture, goes to the room that
// matches what it does, and acts it out, like Star does:
//   working -> the office (left room), around the lead's desk: laptop, terminal, book, magnifier
//   idle    -> the lounge (middle room): coffee, reading, beanbag, stretching
//   error   -> the server room (top right): confused, question marks
//   syncing -> the bedroom (bottom right): asleep on a futon, like Star in her bed
// Plain script: the webview loads it before office.js, and the unit tests require it.
;(function (root) {
  "use strict"

  // ---------- office map: 1280x720, where the characters' feet can go ----------
  // Same layout for the "office" and "lodge" rooms. Rectangles are [x0, y0, x1, y1].
  const FLOOR = [
    [30, 262, 420, 700], // office (left room)
    [420, 600, 505, 650], // passage under the brick wall
    [505, 262, 868, 655], // lounge (middle room)
    [860, 322, 950, 352], // passage to the server room
    [950, 262, 1140, 352], // server room
    [860, 640, 950, 700], // passage to the bedroom
    [950, 575, 1045, 700], // bedroom
    [1045, 672, 1235, 700], // foot of the bed
  ]
  // Furniture footprints. Sprites drawn over the floor hide whoever stands behind them.
  const OBSTACLES = [
    [60, 292, 375, 535], // lead's desk
    [15, 495, 180, 625], // cat bed
    [553, 290, 770, 486], // coffee table
    [715, 290, 862, 385], // armchair
    [465, 440, 560, 595], // lamp table, lounge
    [912, 425, 1035, 572], // plant, bedroom
  ]
  const CELL = 10
  const COLS = 128
  const ROWS = 72

  // Where guests stand, with the way they face (1 = right) and what they do there.
  const SPOTS = {
    // the office, nearest to the lead's desk first: meeting members take the first ones
    work: [
      { x: 395, y: 430, face: -1 },
      { x: 45, y: 430, face: 1 },
      { x: 300, y: 590, face: -1 },
      { x: 395, y: 300, face: -1 },
      { x: 45, y: 290, face: 1, shelf: true },
      { x: 215, y: 650, face: 1 },
      { x: 370, y: 680, face: -1 },
      { x: 110, y: 680, face: 1 },
    ],
    idle: [
      { x: 545, y: 420, face: 1, pose: "coffee" },
      { x: 795, y: 470, face: -1, pose: "coffee" },
      { x: 668, y: 272, face: 1, pose: "read" },
      { x: 645, y: 600, face: 1, pose: "sit" },
      { x: 765, y: 600, face: -1, pose: "sit" },
      { x: 852, y: 548, face: -1, pose: "stretch" },
      { x: 528, y: 335, face: 1, pose: "stand" },
    ],
    error: [
      { x: 990, y: 340, face: 1 },
      { x: 1070, y: 340, face: -1 },
      { x: 1120, y: 290, face: -1 },
      { x: 975, y: 285, face: 1 },
    ],
    sync: [
      { x: 1035, y: 615, face: -1 },
      { x: 1035, y: 685, face: -1 },
      { x: 1215, y: 692, face: -1 },
    ],
  }

  const inRect = (r, x, y) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3]
  function walkable(x, y) {
    return FLOOR.some((r) => inRect(r, x, y)) && !OBSTACLES.some((r) => inRect(r, x, y))
  }

  function buildGrid() {
    const grid = new Uint8Array(COLS * ROWS)
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) grid[r * COLS + c] = walkable(c * CELL + CELL / 2, r * CELL + CELL / 2) ? 1 : 0
    return grid
  }

  const cellOf = (x, y) => [Math.max(0, Math.min(COLS - 1, Math.floor(x / CELL))), Math.max(0, Math.min(ROWS - 1, Math.floor(y / CELL)))]

  // Nearest walkable cell, searching in growing squares.
  function nearestCell(grid, x, y) {
    const [c0, r0] = cellOf(x, y)
    for (let d = 0; d < 40; d++) {
      let best = -1
      let bestDist = Infinity
      for (let r = r0 - d; r <= r0 + d; r++) {
        for (let c = c0 - d; c <= c0 + d; c++) {
          if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== d || r < 0 || c < 0 || r >= ROWS || c >= COLS) continue
          if (!grid[r * COLS + c]) continue
          const dist = (c * CELL + CELL / 2 - x) ** 2 + (r * CELL + CELL / 2 - y) ** 2
          if (dist < bestDist) {
            bestDist = dist
            best = r * COLS + c
          }
        }
      }
      if (best >= 0) return best
    }
    return -1
  }

  function clearLine(grid, a, b) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y)
    const steps = Math.ceil(dist / 4)
    for (let i = 1; i < steps; i++) {
      const t = i / steps
      // The first and last few pixels may sit on the edge of a spot.
      if (t * dist < 6 || (1 - t) * dist < 6) continue
      const x = a.x + (b.x - a.x) * t
      const y = a.y + (b.y - a.y) * t
      const [c, r] = cellOf(x, y)
      if (!grid[r * COLS + c] || !walkable(x, y)) return false
    }
    return true
  }

  // A* over the grid (8 directions, no corner cutting), then straightened: the waypoints to walk to.
  function findPath(grid, from, to) {
    const start = nearestCell(grid, from.x, from.y)
    const goal = nearestCell(grid, to.x, to.y)
    if (start < 0 || goal < 0) return null
    const n = COLS * ROWS
    const g = new Float64Array(n).fill(Infinity)
    const came = new Int32Array(n).fill(-1)
    const closed = new Uint8Array(n)
    const gc = goal % COLS
    const gr = Math.floor(goal / COLS)
    const h = (i) => {
      const dx = Math.abs((i % COLS) - gc)
      const dy = Math.abs(Math.floor(i / COLS) - gr)
      return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy)
    }
    const heap = [[h(start), start]]
    const push = (item) => {
      heap.push(item)
      let i = heap.length - 1
      while (i > 0) {
        const p = (i - 1) >> 1
        if (heap[p][0] <= heap[i][0]) break
        ;[heap[p], heap[i]] = [heap[i], heap[p]]
        i = p
      }
    }
    const pop = () => {
      const top = heap[0]
      const last = heap.pop()
      if (heap.length) {
        heap[0] = last
        let i = 0
        for (;;) {
          const l = 2 * i + 1
          const r = l + 1
          let m = i
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r
          if (m === i) break
          ;[heap[m], heap[i]] = [heap[i], heap[m]]
          i = m
        }
      }
      return top
    }
    g[start] = 0
    while (heap.length) {
      const [, cur] = pop()
      if (closed[cur]) continue
      if (cur === goal) break
      closed[cur] = 1
      const c = cur % COLS
      const r = Math.floor(cur / COLS)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nc = c + dx
          const nr = r + dy
          if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue
          const next = nr * COLS + nc
          if (!grid[next] || closed[next]) continue
          if (dx && dy && (!grid[r * COLS + nc] || !grid[nr * COLS + c])) continue
          const cost = g[cur] + (dx && dy ? 14 : 10)
          if (cost < g[next]) {
            g[next] = cost
            came[next] = cur
            push([cost + h(next), next])
          }
        }
      }
    }
    if (start !== goal && came[goal] < 0) return null
    const cells = []
    for (let i = goal; i !== start && i >= 0; i = came[i]) cells.push(i)
    cells.reverse()
    const points = [{ x: from.x, y: from.y }]
    for (const i of cells.slice(0, -1)) points.push({ x: (i % COLS) * CELL + CELL / 2, y: Math.floor(i / COLS) * CELL + CELL / 2 })
    points.push({ x: to.x, y: to.y })
    const out = []
    let i = 0
    while (i < points.length - 1) {
      let j = points.length - 1
      while (j > i + 1 && !clearLine(grid, points[i], points[j])) j--
      out.push(points[j])
      i = j
    }
    return out
  }

  // ---------- pixel props, drawn at the guests' scale (1 pixel = 4 screen pixels) ----------
  const PALETTE = {
    k: "#1a1b2f", d: "#1b2a3a", b: "#5ec8ff", c: "#d7f3ff", G: "#39ff88", g: "#1f7a45",
    L: "#c9ced9", M: "#7d8597", w: "#ffffff", r: "#e4572e", n: "#6f4518", p: "#fff4d6",
    P: "#d9c7a0", s: "#e8e8f0", o: "#ff9f43", O: "#c9712b", y: "#ffd166", Y: "#c99a2e",
    B: "#5b7fc7", C: "#3d5a99", m: "#b08968", q: "#8a6a4d",
  }
  const row = (edge, fill, width) => edge + fill.repeat(width - 2) + edge
  const laptopFrame = (lines) => [".kkkkkkkkk.", ".kdddddddk.", ...lines, ".kdddddddk.", ".kkkkkkkkk.", "kMLLLLLLLMk", ".kkkkkkkkk."]
  const ART = {
    laptop: [
      laptopFrame([".kdbbcddck.", ".kddcbbbdk.", ".kdbcddddk."]),
      laptopFrame([".kddcbbbdk.", ".kdbcddddk.", ".kdbbbcddk."]),
      laptopFrame([".kdbcddddk.", ".kdbbbcddk.", ".kdcbddbdk."]),
    ],
    terminal: [
      laptopFrame([".kdGGgdddk.", ".kdgGGGddk.", ".kdGdddddk."]),
      laptopFrame([".kdgGGGddk.", ".kdGdddddk.", ".kdGGgGGdk."]),
      laptopFrame([".kdGdddddk.", ".kdGGgGGdk.", ".kdGwddddk."]),
    ],
    mug: [
      ["..s....", ".s.....", "..s....", "...s...", "kkkkk..", "knnnkkk", "krrrk.k", "krrrkkk", "kkkkk.."],
      ["...s...", "..s....", ".s.....", "..s....", "kkkkk..", "knnnkkk", "krrrk.k", "krrrkkk", "kkkkk.."],
    ],
    book: [
      ["kkkkk.kkkkk", "kppppkppppk", "kpPPpkpPPpk", "kppppkppppk", "kpPPpkpPPpk", "knnnnknnnnk"],
      ["kkkkk..kk..", "kppppkkppk.", "kpPPpkpPpk.", "kppppkppppk", "kpPPpkpPPpk", "knnnnknnnnk"],
    ],
    magnifier: [[".kkk...", "kwcck..", "kccck..", "kccck..", ".kkkq..", "....qq.", ".....qq"]],
    gear: [
      ["...k...", ".kyyyk.", ".yYkYy.", "kyk.kyk", ".yYkYy.", ".kyyyk.", "...k..."],
      [".k...k.", "..yyy..", ".yYkYy.", ".yk.ky.", ".yYkYy.", "..yyy..", ".k...k."],
    ],
    thought: [1, 2, 3].map((dots) => [
      "..kkkkkkk..",
      ".kwwwwwwwk.",
      "kwwwwwwwwwk",
      "kw" + "kw".repeat(dots) + "ww".repeat(4 - dots) + "k",
      "kwwwwwwwwwk",
      ".kwwwwwwwk.",
      "..kkkkkkk..",
    ]),
    beanbag: [["....kkkkkkkk....", "..kkookoooookk..", ".kooooyoooooooOk", "koooooooooooooOk", "kOoooooooooooOOk", ".kOOOOOOOOOOOOk.", "..kkkkkkkkkkkk.."]],
    // futon, pillow and blanket for a guest lying on its side (seen from above)
    mat: [[row(".", "k", 38), ...Array.from({ length: 26 }, (_, i) => row("k", i % 6 === 5 ? "P" : "p", 38)), row(".", "k", 38)]],
    pillow: [[row(".", "k", 8), ...Array.from({ length: 12 }, () => row("k", "w", 8)), row(".", "k", 8)]],
    blanket: [[row(".", "k", 16), ...Array.from({ length: 20 }, (_, i) => "kc" + (i % 4 === 1 ? "BBwBBBwBBBwB" : "BBBBBBBBBBBB") + "Ck"), row(".", "k", 16)]],
    sync: [["..kkkkk..", ".kbbbbbk.", "kbk...kbk", "kbk....k.", ".........", ".k....kbk", "kbk...kbk", ".kbbbbbk.", "..kkkkk.."]],
    spark: [[".w.", "wyw", ".w."]],
    drop: [[".b.", "bcb", "bbb", ".b."]],
  }

  function makeTextures(scene) {
    for (const [name, frames] of Object.entries(ART)) {
      const key = `prop_${name}`
      if (scene.textures.exists(key)) continue
      const w = frames[0][0].length
      const h = frames[0].length
      const tex = scene.textures.createCanvas(key, w * frames.length, h)
      const ctx = tex.getContext()
      frames.forEach((rows, f) =>
        rows.forEach((line, y) =>
          [...line].forEach((ch, x) => {
            if (ch === "." || !PALETTE[ch]) return
            ctx.fillStyle = PALETTE[ch]
            ctx.fillRect(f * w + x, y, 1, 1)
          }),
        ),
      )
      tex.refresh()
      frames.forEach((_, f) => tex.add(f, 0, f * w, 0, w, h))
    }
  }

  // ---------- guest sprites: 32x32 frames, 0-3 face right, 4-7 face left ----------
  // Where the feet, the top of the head, the body's centre and the hands are, in frame pixels.
  const META = {
    // lie: how far below the feet line the body's middle ends up when the guest lies down
    1: { foot: 32, top: 4, cx: 16, belly: 25, lie: 6 },
    2: { foot: 32, top: 13, cx: 16, belly: 27, lie: 4 },
    3: { foot: 32, top: 6, cx: 15, belly: 25, lie: 6 },
    4: { foot: 27, top: 7, cx: 14, belly: 21, lie: 20 },
    5: { foot: 27, top: 6, cx: 16, belly: 21, lie: 0 },
    6: { foot: 27, top: 6, cx: 16, belly: 21, lie: 0 },
  }
  const SCALE = 4
  const SPEED = { idle: 42, busy: 100 } // pixels per second: calm, never hurried

  function makeAnims(scene) {
    for (let n = 1; n <= 6; n++) {
      const sheet = `guest_anim_${n}`
      const add = (key, start, rate) => {
        if (scene.anims.exists(key)) return
        scene.anims.create({ key, frames: scene.anims.generateFrameNumbers(sheet, { start, end: start + 3 }), frameRate: rate, repeat: -1 })
      }
      add(`g${n}_walk_r`, 0, 8)
      add(`g${n}_walk_l`, 4, 8)
      add(`g${n}_idle_r`, 0, 2.5)
      add(`g${n}_idle_l`, 4, 2.5)
      add(`g${n}_busy_r`, 0, 5)
      add(`g${n}_busy_l`, 4, 5)
    }
  }

  function hashIndex(name, mod) {
    let hash = 0
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
    return (hash % mod) + 1
  }

  function zoneOf(char) {
    if (char.state === "error") return "error"
    if (char.state === "syncing") return "sync"
    return char.busy || char.waiting || char.state !== "idle" ? "work" : "idle"
  }

  function createGuests(scene, opts) {
    const font = (opts && opts.font) || "monospace"
    const onClick = (opts && opts.onClick) || (() => {})
    const grid = buildGrid()
    const guests = new Map()
    makeTextures(scene)
    makeAnims(scene)

    const spotKey = (zone, spot) => `${zone}:${spot}`
    function occupancy() {
      const taken = new Map()
      for (const g of guests.values()) taken.set(spotKey(g.zone, g.spot), (taken.get(spotKey(g.zone, g.spot)) || 0) + 1)
      return taken
    }

    // Meeting members get the spots nearest to the lead's desk, other workers the farthest ones.
    function pickSpot(zone, near, taken, exclude) {
      const spots = SPOTS[zone]
      const order = spots.map((_, i) => i)
      if (zone === "work" && !near) order.reverse()
      if (zone === "idle") order.sort(() => Math.random() - 0.5)
      const free = order.filter((i) => i !== exclude && !taken.get(spotKey(zone, i)))
      if (free.length) return { spot: free[0], extra: 0 }
      // Crowded: share the least busy spot, a step aside.
      const spot = order.reduce((a, b) => ((taken.get(spotKey(zone, b)) || 0) < (taken.get(spotKey(zone, a)) || 0) ? b : a))
      return { spot, extra: taken.get(spotKey(zone, spot)) || 1 }
    }

    function spotPoint(zone, spot, extra) {
      const s = SPOTS[zone][spot]
      for (const dx of extra ? [28 * extra, -28 * extra, 20 * extra] : [0]) {
        if (walkable(s.x + dx, s.y)) return { x: s.x + dx, y: s.y }
      }
      return { x: s.x, y: s.y }
    }

    function head(g) {
      if (g.pose === "sleep") return { x: g.x - g.h + 16, y: g.y + g.meta.lie - 30 }
      return { x: g.x, y: g.y + g.oy - g.h }
    }

    function setFacing(g, face) {
      g.face = face
      const m = g.meta
      g.sprite.setOrigin((face > 0 ? m.cx : 32 - m.cx) / 32, m.foot / 32)
    }

    function play(g, kind) {
      const key = `g${g.n}_${kind}_${g.face > 0 ? "r" : "l"}`
      if (g.sprite.anims.currentAnim?.key !== key || !g.sprite.anims.isPlaying) g.sprite.anims.play(key, true)
    }

    // ---------- poses ----------
    function prop(g, name, frame, depthOffset) {
      const img = scene.add.image(g.x, g.y, `prop_${name}`, frame || 0).setScale(SCALE).setOrigin(0.5)
      img.depthOffset = depthOffset || 0.2
      img.setInteractive({ useHandCursor: true })
      img.on("pointerdown", () => onClick(g.name))
      g.props.push(img)
      return img
    }
    function mark(g, text, color, size) {
      const t = scene.add
        .text(g.x, g.y, text, { fontFamily: font, fontSize: `${size || 16}px`, fill: color, stroke: "#1a1b2f", strokeThickness: 3 })
        .setOrigin(0.5)
      t.depthOffset = 0.4
      g.props.push(t)
      return t
    }

    function clearPose(g) {
      for (const p of g.props) p.destroy()
      g.props = []
      g.pose = null
      g.tick = null
      g.ox = 0
      g.oy = 0
      g.sprite.setAngle(0)
      g.sprite.setScale(SCALE)
      g.sprite.clearTint()
    }

    function setPose(g, pose) {
      clearPose(g)
      g.pose = pose
      g.poseAt = scene.time.now
      const hand = (g.meta.foot - g.meta.belly) * SCALE
      const hands = () => ({ x: g.x + g.face * 24, y: g.y + g.oy - hand })
      switch (pose) {
        case "laptop":
        case "terminal": {
          const screen = prop(g, pose === "laptop" ? "laptop" : "terminal")
          const spark = prop(g, "spark")
          const gear = pose === "terminal" ? prop(g, "gear") : null
          play(g, "busy")
          g.tick = (t) => {
            g.oy = Math.floor(t / 130) % 2 ? -2 : 0 // typing
            const p = hands()
            screen.setFrame(Math.floor(t / 260) % 3).setPosition(p.x, p.y + 4)
            const phase = t % 700
            spark.setVisible(phase < 140).setPosition(p.x + ((Math.floor(t / 700) * 7) % 17) - 8, p.y - 14 - phase / 20)
            if (gear) {
              const hd = head(g)
              gear.setFrame(Math.floor(t / 180) % 2).setPosition(hd.x - g.face * 30, hd.y + 10)
            }
          }
          break
        }
        case "think": {
          const cloud = prop(g, "thought")
          play(g, "idle")
          g.tick = (t) => {
            const hd = head(g)
            cloud.setFrame(Math.floor(t / 450) % 3).setPosition(hd.x + g.face * 34, hd.y - 44 + Math.sin(t / 500) * 2)
          }
          break
        }
        case "search": {
          const glass = prop(g, "magnifier")
          const q = mark(g, "?", "#ffd166", 18)
          play(g, "busy")
          g.tick = (t) => {
            const p = hands()
            glass.setPosition(p.x + Math.sin(t / 350) * 12, p.y - 4 + Math.cos(t / 280) * 3)
            const phase = t % 3500
            const hd = head(g)
            q.setVisible(phase < 1200).setPosition(hd.x + g.face * 30, hd.y + 4 - phase / 60).setAlpha(1 - phase / 1400)
          }
          break
        }
        case "read": {
          const book = prop(g, "book")
          play(g, "idle")
          g.tick = (t) => {
            const p = hands()
            book.setFrame(t % 3200 < 260 ? 1 : 0).setPosition(p.x - g.face * 4, p.y + 2)
          }
          break
        }
        case "wave": {
          play(g, "idle")
          g.tick = (t) => {
            const phase = t % 1400
            g.oy = phase < 400 ? -Math.sin((phase / 400) * Math.PI) * 10 : 0
          }
          break
        }
        case "coffee": {
          const mug = prop(g, "mug")
          play(g, "idle")
          g.tick = (t) => {
            const p = hands()
            const phase = (t + g.seed) % 6500
            const sip = phase < 900 ? Math.sin((phase / 900) * Math.PI) : 0
            const hd = head(g)
            mug.setFrame(Math.floor(t / 350) % 2).setPosition(p.x - g.face * 8 * sip, p.y - 8 - sip * (p.y - hd.y - 40))
          }
          break
        }
        case "sit": {
          const bag = prop(g, "beanbag", 0, 0.5)
          play(g, "idle")
          g.oy = 10
          g.tick = () => bag.setPosition(g.x, g.y + 2)
          break
        }
        case "stretch": {
          play(g, "idle")
          g.tick = (t) => {
            const phase = (t + g.seed) % 7000
            const s = phase < 800 ? Math.sin((phase / 800) * Math.PI) : 0
            g.sprite.setScale(SCALE - s * 0.25, SCALE + s * 0.45)
          }
          break
        }
        case "confused": {
          const marks = [0, 1, 2].map(() => mark(g, "?", "#c9712b", 18))
          const drop = prop(g, "drop")
          play(g, "idle")
          g.tick = (t) => {
            const hd = head(g)
            marks.forEach((m, i) => {
              const a = t / 600 + (i * Math.PI * 2) / 3
              m.setPosition(hd.x + Math.cos(a) * 34, hd.y + 12 + Math.sin(a) * 10).setAlpha(0.55 + 0.45 * Math.sin(t / 300 + i))
            })
            const shake = t % 2000 < 500
            g.ox = shake ? Math.sin(t / 30) * 2 : 0
            if (shake && Math.floor(t / 2000) % 2) g.sprite.setTint(0xffb4b4)
            else g.sprite.clearTint()
            const fall = (t + g.seed) % 2600
            drop.setVisible(fall < 900).setPosition(hd.x - g.face * 16, hd.y + 12 + fall / 30).setAlpha(1 - fall / 900)
          }
          break
        }
        case "sleep": {
          const mat = prop(g, "mat", 0, -0.6)
          const pillow = prop(g, "pillow", 0, -0.3)
          const blanket = prop(g, "blanket", 0, 0.5)
          const spin = prop(g, "sync")
          const zs = [0, 1, 2].map(() => mark(g, "z", "#dbeafe", 16))
          g.sprite.anims.stop()
          g.sprite.setFrame(4)
          setFacing(g, -1)
          g.sprite.setAngle(-90)
          g.tick = (t) => {
            const mid = g.y + g.meta.lie
            const breathe = Math.sin(t / 700) * 1.5
            mat.setPosition(g.x - g.h / 2 + 4, mid + 6)
            pillow.setPosition(g.x - g.h + 10, mid)
            blanket.setPosition(g.x - 26, mid + breathe)
            spin.setPosition(g.x - g.h / 2, mid - 62).setAngle((t / 6) % 360)
            zs.forEach((z, i) => {
              const k = ((t / 1000 + i * 0.8) % 2.4) / 2.4
              z.setPosition(g.x - g.h + 4 + k * 22, mid - 40 - k * 40).setAlpha(1 - k).setFontSize(12 + k * 10)
            })
          }
          break
        }
        default: {
          // stand: breathe, and look around now and then
          play(g, "idle")
          g.tick = (t) => {
            const look = Math.floor((t + g.seed) / 4500) % 3 === 2 ? -g.spotFace : g.spotFace
            if (look !== g.face) {
              setFacing(g, look)
              play(g, "idle")
            }
          }
        }
      }
    }

    function poseFor(g) {
      const char = g.char
      const spot = SPOTS[g.zone][g.spot]
      if (g.zone === "error") return "confused"
      if (g.zone === "sync") return "sleep"
      if (g.zone === "idle") return spot.pose || "stand"
      if (char.waiting) return "wave"
      if (char.state === "researching") return spot.shelf ? "read" : "search"
      if (char.state === "executing") return "terminal"
      if (char.detail && char.detail.kind === "thinking") return "think"
      return "laptop"
    }

    // ---------- movement ----------
    function goTo(g, zone, choice) {
      g.zone = zone
      g.spot = choice.spot
      g.spotFace = SPOTS[zone][choice.spot].face || 1
      const dest = spotPoint(zone, choice.spot, choice.extra)
      clearPose(g)
      g.arrived = false
      g.path = findPath(grid, { x: g.x, y: g.y }, dest) || [dest]
    }

    function arrive(g) {
      g.arrived = true
      g.nextWanderAt = scene.time.now + 25000 + Math.random() * 35000
      setFacing(g, g.spotFace)
      setPose(g, poseFor(g))
    }

    function spawn(char, zone, taken) {
      const n = hashIndex(char.name, 6)
      const choice = pickSpot(zone, char.inMeeting, taken)
      taken.set(spotKey(zone, choice.spot), (taken.get(spotKey(zone, choice.spot)) || 0) + 1)
      const at = spotPoint(zone, choice.spot, choice.extra)
      const sprite = scene.add.sprite(at.x, at.y, `guest_anim_${n}`, 0).setScale(SCALE)
      sprite.setInteractive({ useHandCursor: true })
      sprite.on("pointerdown", () => onClick(char.name))
      const nameText = scene.add
        .text(at.x, at.y, "", { fontFamily: font, fontSize: "15px", fill: "#ffffff", stroke: "#000", strokeThickness: 4 })
        .setOrigin(0.5)
        .setDepth(2640)
      nameText.setInteractive({ useHandCursor: true })
      nameText.on("pointerdown", () => onClick(char.name))
      const alert = scene.add
        .text(at.x, at.y, "!", { fontFamily: font, fontSize: "18px", fill: "#1a1b2f", backgroundColor: "#ffd700", padding: { x: 5, y: 1 } })
        .setOrigin(0.5)
        .setDepth(2660)
        .setVisible(false)
      const meta = META[n]
      const g = {
        name: char.name,
        n,
        meta,
        h: (meta.foot - meta.top) * SCALE,
        sprite,
        nameText,
        alert,
        char,
        x: at.x,
        y: at.y,
        ox: 0,
        oy: 0,
        face: 1,
        zone,
        spot: choice.spot,
        spotFace: SPOTS[zone][choice.spot].face || 1,
        path: [],
        arrived: false,
        props: [],
        pose: null,
        tick: null,
        seed: Math.floor(Math.random() * 5000),
        nextWanderAt: 0,
      }
      guests.set(char.name, g)
      arrive(g)
      return g
    }

    function remove(g) {
      clearPose(g)
      g.sprite.destroy()
      g.nameText.destroy()
      g.alert.destroy()
      guests.delete(g.name)
    }

    function render(chars, main) {
      const seen = new Set()
      const taken = new Map()
      for (const char of chars) {
        const g = guests.get(char.name)
        if (g && g.zone === zoneOf(char)) taken.set(spotKey(g.zone, g.spot), (taken.get(spotKey(g.zone, g.spot)) || 0) + 1)
      }
      for (const char of chars) {
        seen.add(char.name)
        const view = { ...char, inMeeting: !!(main && char.meetingID && char.meetingID === main.meetingID) }
        const zone = zoneOf(view)
        let g = guests.get(char.name)
        if (!g) {
          g = spawn(view, zone, taken)
        } else {
          g.char = view
          if (g.zone !== zone) {
            const choice = pickSpot(zone, view.inMeeting, taken)
            taken.set(spotKey(zone, choice.spot), (taken.get(spotKey(zone, choice.spot)) || 0) + 1)
            goTo(g, zone, choice)
          } else if (g.arrived) {
            const pose = poseFor(g)
            if (pose !== g.pose) setPose(g, pose)
          }
        }
        const count = char.activeSessions > 1 ? ` ×${char.activeSessions}` : ""
        g.nameText.setText((char.displayName || char.name) + count)
        g.nameText.setColor(char.color && /^#[0-9a-f]{6}$/i.test(char.color) ? char.color : "#ffffff")
        g.alert.setVisible(!!char.waiting)
      }
      for (const g of [...guests.values()]) if (!seen.has(g.name)) remove(g)
    }

    function update(time, delta) {
      for (const g of guests.values()) {
        if (g.path.length) {
          const target = g.path[0]
          const dx = target.x - g.x
          const dy = target.y - g.y
          const dist = Math.hypot(dx, dy)
          const step = ((g.zone === "idle" ? SPEED.idle : SPEED.busy) * Math.min(delta, 100)) / 1000
          if (dist <= step) {
            g.x = target.x
            g.y = target.y
            g.path.shift()
          } else {
            g.x += (dx / dist) * step
            g.y += (dy / dist) * step
          }
          if (Math.abs(dx) > 1) setFacing(g, dx > 0 ? 1 : -1)
          play(g, "walk")
          g.ox = 0
          g.oy = -Math.abs(Math.sin(time / 95)) * 3 // steps
        } else if (!g.arrived) {
          arrive(g)
        } else if (g.zone === "idle" && time > g.nextWanderAt) {
          // Idle agents change spot now and then, calmly.
          g.nextWanderAt = time + 25000 + Math.random() * 35000
          if (Math.random() < 0.5) {
            const choice = pickSpot("idle", false, occupancy(), g.spot)
            if (choice.spot !== g.spot && !choice.extra) goTo(g, "idle", choice)
          }
        } else if (g.tick) {
          g.tick(time)
        }
        g.sprite.setPosition(g.x + g.ox, g.y + g.oy)
        g.sprite.setDepth(g.y)
        for (const p of g.props) p.setDepth(g.y + (p.depthOffset || 0))
        const hd = head(g)
        g.nameText.setPosition(hd.x, hd.y - 14)
        g.alert.setPosition(hd.x, hd.y - 38)
      }
      separateLabels()
    }

    // Two characters side by side: the name of the one further back moves up, so both stay readable.
    function separateLabels() {
      const list = [...guests.values()].sort((a, b) => b.y - a.y)
      for (let i = 1; i < list.length; i++) {
        const t = list[i].nameText
        for (let j = 0; j < i; j++) {
          const o = list[j].nameText
          if (Math.abs(t.x - o.x) < (t.width + o.width) / 2 + 4 && Math.abs(t.y - o.y) < 16) {
            t.setY(o.y - 16)
            list[i].alert.setY(t.y - 24)
          }
        }
      }
    }

    // Frames stop while the office is hidden: on return, agents are already where they were heading.
    function snapToTargets() {
      for (const g of guests.values()) {
        if (!g.path.length) continue
        const last = g.path[g.path.length - 1]
        g.x = last.x
        g.y = last.y
        g.path = []
      }
    }

    return {
      render,
      update,
      snapToTargets,
      has: (name) => guests.has(name),
      headOf: (name) => (guests.has(name) ? head(guests.get(name)) : null),
    }
  }

  const api = { FLOOR, OBSTACLES, SPOTS, ART, PALETTE, META, walkable, buildGrid, findPath, zoneOf, createGuests }
  if (typeof module === "object" && module.exports) module.exports = api
  else root.StarGuests = api
})(typeof window !== "undefined" ? window : globalThis)
