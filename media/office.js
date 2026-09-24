// Star Office for Kilo — webview game.
// Scene layout, sprites and animations are adapted from Star-Office-UI (MIT, Ring Hyacinth & Simon Lee).
// Instead of polling a Flask backend, the office is driven by snapshots posted by the extension.
/* global Phaser, I18N, resolveLanguage, acquireVsCodeApi */
;(function () {
  "use strict"

  const vscode =
    typeof acquireVsCodeApi === "function"
      ? acquireVsCodeApi()
      : { postMessage: (m) => window.parent.postMessage(m, "*"), getState: () => null, setState: () => {} }
  const BOOT = JSON.parse(document.getElementById("boot").textContent)
  // Errors end up in the "Star UI for Kilo" output channel, which helps with bug reports.
  const report = (level, message) => {
    try {
      vscode.postMessage({ type: "log", level, message: String(message) })
    } catch {}
  }
  window.addEventListener("error", (e) => report("error", `${e.message} (${e.filename}:${e.lineno})`))
  window.addEventListener("unhandledrejection", (e) => report("error", e.reason && e.reason.stack ? e.reason.stack : e.reason))
  const asset = (name) => `${BOOT.assets}/${name}`
  const FONT = "ArkPixelLatin, monospace"

  let settings = { language: resolveLanguage(BOOT.language), officeName: BOOT.officeName || "", room: BOOT.room || "office" }
  let L = I18N[settings.language] || I18N.en
  let snapshot = null
  let firstSnapshot = true

  // ---------- i18n helpers ----------
  function lookup(dict, key) {
    return key.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), dict)
  }
  function t(key, vars) {
    let s = lookup(L, key)
    if (s === undefined) s = lookup(I18N.en, key)
    if (typeof s !== "string") return s === undefined ? key : s
    return s
      .replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ""))
      .replace(/\s*[:：]\s*$/, (m) => (/\{\w+\}\s*$/.test(s) ? "" : m))
      .replace(/\s{2,}/g, " ")
      .trim()
  }
  function pick(list) {
    return Array.isArray(list) && list.length ? list[Math.floor(Math.random() * list.length)] : ""
  }
  function label(char) {
    return char ? char.displayName || char.name : ""
  }

  const READ_TOOLS = new Set(["read", "view", "todoread", "lsp"])
  const SEARCH_TOOLS = new Set(["grep", "glob", "list", "ls", "codesearch", "codebase_search", "semantic_search"])
  const BROWSE_TOOLS = new Set(["webfetch", "websearch"])
  const EDIT_TOOLS = new Set(["edit", "patch", "apply_patch", "multiedit"])
  function detailText(char) {
    if (!char) return ""
    const d = char.detail || { kind: "idle" }
    switch (d.kind) {
      case "idle":
        return char.state === "idle" ? t("detail.idle") : t("detail.wrapUp")
      case "thinking":
        return t("detail.thinking")
      case "retry":
        return t("detail.retry", { message: d.message })
      case "offline":
        return t("detail.offline", { message: d.message })
      case "compaction":
        return t("detail.compaction")
      case "error":
        return t("detail.error", { message: d.message })
      case "waiting":
        return d.hint === "question" ? t("detail.waitQuestion") : t("detail.waitPermission", { label: d.tool })
      case "tool": {
        const tool = String(d.tool || "").toLowerCase()
        const vars = { tool: d.tool, hint: d.hint }
        if (READ_TOOLS.has(tool)) return t("detail.read", vars)
        if (SEARCH_TOOLS.has(tool)) return t("detail.search", vars)
        if (BROWSE_TOOLS.has(tool)) return t("detail.browse", vars)
        if (EDIT_TOOLS.has(tool)) return t("detail.edit", vars)
        if (tool === "write") return t("detail.write", vars)
        if (tool === "bash" || tool === "shell") return t("detail.run", vars)
        if (tool === "task") return t("detail.delegate", vars)
        if (tool === "ask_teammate") return t("detail.teammate", vars)
        if (tool === "todowrite") return t("detail.todo", vars)
        return t("detail.tool", vars)
      }
    }
    return ""
  }

  // ---------- game state ----------
  const IDLE_SOFA_ANCHOR = { x: 798, y: 272 }
  // Where characters go: coordinates of their feet on the 1280x720 office.
  const SPOTS = {
    // quiet places for idle agents
    idle: [
      { x: 575, y: 470, pose: "coffee" }, // left of the coffee table
      { x: 745, y: 470, pose: "coffee" }, // right of the coffee table
      { x: 885, y: 335, pose: "sit" }, // next to the armchair
      { x: 130, y: 300, pose: "read" }, // bookshelf, left room
      { x: 610, y: 255, pose: "read" }, // bookshelf, middle room
      { x: 1015, y: 655, pose: "rest" }, // by the plant, bottom-right room
      { x: 505, y: 650, pose: "stand" },
      { x: 855, y: 650, pose: "stand" },
    ],
    // around the lead's desk: agents working in the lead's conversation
    meeting: [
      { x: 300, y: 610 }, { x: 160, y: 605 }, { x: 420, y: 575 }, { x: 235, y: 675 },
      { x: 375, y: 675 }, { x: 95, y: 660 }, { x: 440, y: 665 },
    ],
    // agents busy on another conversation: around the middle table
    work: [
      { x: 560, y: 600 }, { x: 760, y: 600 }, { x: 660, y: 645 }, { x: 490, y: 555 }, { x: 830, y: 555 },
    ],
    error: [
      { x: 960, y: 345 }, { x: 1070, y: 335 }, { x: 1020, y: 385 }, { x: 910, y: 385 }, { x: 1115, y: 385 },
    ],
  }
  const WALK_SPEED = { idle: 32, busy: 90 } // pixels per second
  const PROP = { coffee: "☕", read: "📖" }
  const MAIN_ANCHORS = {
    idle: { x: IDLE_SOFA_ANCHOR.x, y: IDLE_SOFA_ANCHOR.y - 118 },
    work: { x: 217, y: 210 },
    error: { x: 1007, y: 118 },
    syncing: { x: 1157, y: 480 },
  }

  let game = null
  let scene = null
  let star, starWorking, errorBug, serverroom, syncAnimSprite, sofa
  let syncAnimPlayable = false
  let mainTag, mainAlert
  let currentState = "idle"
  let bubble = null
  let catBubble = null
  let lastBubble = 0
  let lastCatBubble = 0
  let lastGuestBubbleAt = 0
  let typewriterTarget = ""
  let typewriterText = ""
  let typewriterIndex = 0
  let lastTypewriter = 0
  const guestSprites = {} // name -> { sprite, nameText, alert, prop, n, zone, spot, target, arrived, nextWanderAt }
  const guestBubbles = {} // name -> container
  let seenGuests = new Set()
  let meetingMarker = null

  function hashIndex(name, mod) {
    let hash = 0
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
    return (hash % mod) + 1
  }

  function preload() {
    const bar = document.getElementById("loading-progress-bar")
    this.load.on("progress", (v) => {
      if (bar) bar.style.width = Math.round(v * 100) + "%"
    })
    this.load.on("complete", hideLoading)
    this.load.on("loaderror", (file) => report("error", `could not load ${file.key} (${file.src})`))
    this.load.image("office_bg", asset(settings.room === "lodge" ? "lodge_bg.webp" : "office_bg.webp"))
    this.load.spritesheet("star_idle", asset("star-idle-v5.png"), { frameWidth: 256, frameHeight: 256 })
    this.load.image("sofa_idle", asset("sofa-idle-v3.png"))
    this.load.image("sofa_shadow", asset("sofa-shadow-v1.png"))
    this.load.spritesheet("plants", asset("plants-spritesheet.webp"), { frameWidth: 160, frameHeight: 160 })
    this.load.spritesheet("posters", asset("posters-spritesheet.webp"), { frameWidth: 160, frameHeight: 160 })
    this.load.spritesheet("coffee_machine", asset("coffee-machine-v3-grid.webp"), { frameWidth: 230, frameHeight: 230 })
    this.load.image("coffee_machine_shadow", asset("coffee-machine-shadow-v1.png"))
    this.load.spritesheet("serverroom", asset("serverroom-spritesheet.webp"), { frameWidth: 180, frameHeight: 251 })
    this.load.spritesheet("error_bug", asset("error-bug-spritesheet-grid.webp"), { frameWidth: 220, frameHeight: 220 })
    this.load.spritesheet("cats", asset("cats-spritesheet.webp"), { frameWidth: 160, frameHeight: 160 })
    this.load.spritesheet("star_working", asset("star-working-spritesheet-grid.webp"), { frameWidth: 300, frameHeight: 300 })
    this.load.spritesheet("sync_anim", asset("sync-animation-v3-grid.webp"), { frameWidth: 256, frameHeight: 256 })
    this.load.image("desk_v2", asset("desk-v3.webp"))
    this.load.spritesheet("flowers", asset("flowers-bloom-v2.webp"), { frameWidth: 128, frameHeight: 128 })
    for (let i = 1; i <= 6; i++) {
      this.load.spritesheet(`guest_anim_${i}`, asset(`guest_anim_${i}.webp`), { frameWidth: 32, frameHeight: 32 })
    }
  }

  function randomFrameSprite(s, x, y, key, depth) {
    const total = Math.max(1, (s.textures.get(key)?.frameTotal || 2) - 1)
    const sprite = s.add.sprite(x, y, key, Math.floor(Math.random() * total)).setOrigin(0.5).setDepth(depth)
    sprite.setInteractive({ useHandCursor: true })
    sprite.on("pointerdown", () => sprite.setFrame(Math.floor(Math.random() * total)))
    return sprite
  }

  function create() {
    scene = this
    const sk = document.getElementById("game-skeleton")
    if (sk) sk.remove()

    this.add.image(640, 360, "office_bg")

    this.add.image(IDLE_SOFA_ANCHOR.x, IDLE_SOFA_ANCHOR.y, "sofa_shadow").setOrigin(0.5).setDepth(9)
    sofa = this.add.sprite(IDLE_SOFA_ANCHOR.x, IDLE_SOFA_ANCHOR.y, "sofa_idle").setOrigin(0.5).setDepth(10)

    const starIdleMax = Math.max(0, (this.textures.get("star_idle")?.frameTotal || 1) - 2)
    this.anims.create({ key: "star_idle", frames: this.anims.generateFrameNumbers("star_idle", { start: 0, end: starIdleMax }), frameRate: 12, repeat: -1 })
    for (let i = 1; i <= 6; i++) {
      const frames = this.anims.generateFrameNumbers(`guest_anim_${i}`, { start: 0, end: 7 })
      this.anims.create({ key: `guest_anim_${i}_walk`, frames, frameRate: 8, repeat: -1 })
      this.anims.create({ key: `guest_anim_${i}_work`, frames, frameRate: 3, repeat: -1 })
    }

    star = this.add.sprite(IDLE_SOFA_ANCHOR.x, IDLE_SOFA_ANCHOR.y, "star_idle").setOrigin(0.5).setAlpha(0.95).setDepth(20)
    star.anims.play("star_idle", true)

    // plaque
    const plaqueBg = this.add.rectangle(640, 684, 420, 44, 0x5d4037)
    plaqueBg.setStrokeStyle(3, 0x3e2723)
    window.officePlaque = this.add
      .text(640, 684, settings.officeName || t("officeName"), {
        fontFamily: FONT,
        fontSize: "18px",
        fill: "#ffd700",
        stroke: "#000",
        strokeThickness: 3,
        align: "center",
        wordWrap: { width: 380 },
      })
      .setOrigin(0.5)
    this.add.text(450, 684, "⭐", { fontFamily: FONT, fontSize: "20px" }).setOrigin(0.5)
    this.add.text(830, 684, "⭐", { fontFamily: FONT, fontSize: "20px" }).setOrigin(0.5)

    // decor (click to shuffle, like the original)
    randomFrameSprite(this, 565, 178, "plants", 5)
    randomFrameSprite(this, 230, 185, "plants", 5)
    randomFrameSprite(this, 977, 496, "plants", 5)
    randomFrameSprite(this, 252, 66, "posters", 4)
    window.catSprite = randomFrameSprite(this, 94, 557, "cats", 2000)

    this.add.image(659, 397, "coffee_machine_shadow").setOrigin(0.5).setDepth(98)
    const coffeeMax = Math.max(0, (this.textures.get("coffee_machine")?.frameTotal || 1) - 2)
    this.anims.create({ key: "coffee_machine", frames: this.anims.generateFrameNumbers("coffee_machine", { start: 0, end: coffeeMax }), frameRate: 12.5, repeat: -1 })
    this.add.sprite(659, 397, "coffee_machine").setOrigin(0.5).setDepth(99).anims.play("coffee_machine", true)

    const serverMax = Math.max(0, (this.textures.get("serverroom")?.frameTotal || 1) - 2)
    this.anims.create({ key: "serverroom_on", frames: this.anims.generateFrameNumbers("serverroom", { start: 0, end: serverMax }), frameRate: 6, repeat: -1 })
    serverroom = this.add.sprite(1021, 142, "serverroom", 0).setOrigin(0.5).setDepth(2)

    this.add.image(218, 417, "desk_v2").setOrigin(0.5).setDepth(1001)
    const flower = randomFrameSprite(this, 310, 390, "flowers", 1100)
    flower.setScale(0.8)

    this.anims.create({ key: "star_working", frames: this.anims.generateFrameNumbers("star_working", { start: 0, end: 37 }), frameRate: 12, repeat: -1 })
    this.anims.create({ key: "error_bug", frames: this.anims.generateFrameNumbers("error_bug", { start: 0, end: 71 }), frameRate: 12, repeat: -1 })

    errorBug = this.add.sprite(1007, 221, "error_bug", 0).setOrigin(0.5).setDepth(50).setScale(0.9).setVisible(false)
    starWorking = this.add.sprite(217, 343, "star_working", 0).setOrigin(0.5).setScale(0.9).setDepth(900).setVisible(false)

    const syncTotal = Number(this.textures.get("sync_anim")?.frameTotal || 0)
    syncAnimPlayable = syncTotal >= 3
    if (syncAnimPlayable) {
      this.anims.create({ key: "sync_anim", frames: this.anims.generateFrameNumbers("sync_anim", { start: 1, end: Math.max(1, syncTotal - 2) }), frameRate: 12, repeat: -1 })
    }
    syncAnimSprite = this.add.sprite(1157, 592, "sync_anim", 0).setOrigin(0.5).setDepth(40)

    // The main character (the agent of the active conversation) is clickable wherever it is.
    for (const s of [star, starWorking, errorBug, syncAnimSprite]) {
      s.setInteractive({ useHandCursor: true })
      s.on("pointerdown", () => snapshot && snapshot.main && openChat({ kind: "agent", name: snapshot.main.name }))
    }

    mainTag = this.add
      .text(MAIN_ANCHORS.idle.x, MAIN_ANCHORS.idle.y, "", {
        fontFamily: FONT,
        fontSize: "16px",
        fill: "#ffffff",
        stroke: "#000",
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(2601)
    mainAlert = this.add
      .text(0, 0, "!", { fontFamily: FONT, fontSize: "22px", fill: "#1a1b2f", backgroundColor: "#ffd700", padding: { x: 6, y: 1 } })
      .setOrigin(0.5)
      .setDepth(2602)
      .setVisible(false)

    meetingMarker = this.add
      .text(395, 322, "", { fontFamily: FONT, fontSize: "14px", fill: "#1a1b2f", backgroundColor: "#ffd700", padding: { x: 6, y: 3 } })
      .setOrigin(0.5)
      .setDepth(2650)
      .setVisible(false)
    meetingMarker.setInteractive({ useHandCursor: true })
    meetingMarker.on("pointerdown", () => meetingMarker.meetingID && openChat({ kind: "meeting", id: meetingMarker.meetingID }))

    if (snapshot) applySnapshot(snapshot)
    report("info", "office ready")
  }

  function applyVisualState(state) {
    currentState = state
    const atDesk = state === "writing" || state === "researching" || state === "executing"
    star.setVisible(state === "idle")
    if (state === "idle") {
      star.setPosition(IDLE_SOFA_ANCHOR.x, IDLE_SOFA_ANCHOR.y)
      star.anims.play("star_idle", true)
    } else {
      star.anims.stop()
    }
    starWorking.setVisible(atDesk)
    if (atDesk) starWorking.anims.play("star_working", true)
    else starWorking.anims.stop()

    errorBug.setVisible(state === "error")
    if (state === "error") errorBug.anims.play("error_bug", true)
    else errorBug.anims.stop()

    if (state === "idle") {
      serverroom.anims.stop()
      serverroom.setFrame(0)
    } else if (!serverroom.anims.isPlaying) {
      serverroom.anims.play("serverroom_on", true)
    }

    if (state === "syncing" && syncAnimPlayable) {
      if (!syncAnimSprite.anims.isPlaying) syncAnimSprite.anims.play("sync_anim", true)
    } else {
      syncAnimSprite.anims.stop()
      syncAnimSprite.setFrame(0)
    }

    const anchor =
      state === "idle" ? MAIN_ANCHORS.idle : state === "error" ? MAIN_ANCHORS.error : state === "syncing" ? MAIN_ANCHORS.syncing : MAIN_ANCHORS.work
    mainTag.setPosition(anchor.x, anchor.y)
  }

  // Which part of the office a character belongs to right now.
  function zoneOf(char) {
    if (char.state === "error") return "error"
    const working = char.busy || char.waiting || char.state !== "idle"
    if (!working) return "idle"
    const main = snapshot && snapshot.main
    return main && char.meetingID && char.meetingID === main.meetingID ? "meeting" : "work"
  }

  function freeSpot(zone, taken, prefer) {
    const spots = SPOTS[zone]
    if (prefer !== undefined && !taken.has(`${zone}:${prefer}`)) return prefer
    const free = spots.map((_, i) => i).filter((i) => !taken.has(`${zone}:${i}`))
    if (!free.length) return Math.floor(Math.random() * spots.length)
    return zone === "idle" ? free[Math.floor(Math.random() * free.length)] : free[0]
  }

  function goTo(g, zone, spot) {
    const p = SPOTS[zone][spot]
    g.zone = zone
    g.spot = spot
    g.target = { x: p.x, y: p.y }
    g.arrived = false
  }

  function renderGuests(guests) {
    if (!scene) return
    const seen = new Set()
    const taken = new Set()
    // Characters that keep their zone keep their spot, so nobody shuffles around needlessly.
    for (const char of guests) {
      const g = guestSprites[char.name]
      if (g && g.zone === zoneOf(char)) taken.add(`${g.zone}:${g.spot}`)
    }
    for (const char of guests) {
      const name = char.name
      seen.add(name)
      const zone = zoneOf(char)
      let g = guestSprites[name]
      if (!g) {
        const spot = freeSpot(zone, taken)
        taken.add(`${zone}:${spot}`)
        const p = SPOTS[zone][spot]
        const n = hashIndex(name, 6)
        const sprite = scene.add.sprite(p.x, p.y, `guest_anim_${n}`, 0).setOrigin(0.5, 1).setScale(4)
        sprite.setInteractive({ useHandCursor: true })
        sprite.on("pointerdown", () => openChat({ kind: "agent", name }))
        const nameText = scene.add
          .text(p.x, p.y - 120, "", { fontFamily: FONT, fontSize: "15px", fill: "#ffffff", stroke: "#000", strokeThickness: 4 })
          .setOrigin(0.5)
          .setDepth(2640)
        nameText.setInteractive({ useHandCursor: true })
        nameText.on("pointerdown", () => openChat({ kind: "agent", name }))
        const alert = scene.add
          .text(p.x, p.y - 145, "!", { fontFamily: FONT, fontSize: "18px", fill: "#1a1b2f", backgroundColor: "#ffd700", padding: { x: 5, y: 1 } })
          .setOrigin(0.5)
          .setDepth(2660)
          .setVisible(false)
        const prop = scene.add.text(p.x + 26, p.y - 70, "", { fontSize: "18px" }).setOrigin(0.5).setDepth(2645)
        g = guestSprites[name] = { sprite, nameText, alert, prop, n, zone, spot, target: { x: p.x, y: p.y }, arrived: false, nextWanderAt: 0 }
      } else if (g.zone !== zone) {
        const spot = freeSpot(zone, taken)
        taken.add(`${zone}:${spot}`)
        goTo(g, zone, spot)
      }
      const count = char.activeSessions > 1 ? ` ×${char.activeSessions}` : ""
      g.nameText.setText(label(char) + count)
      g.nameText.setColor(char.color && /^#[0-9a-f]{6}$/i.test(char.color) ? char.color : "#ffffff")
      g.alert.setVisible(!!char.waiting)
    }
    for (const name of Object.keys(guestSprites)) {
      if (seen.has(name)) continue
      const g = guestSprites[name]
      g.sprite.destroy()
      g.nameText.destroy()
      g.alert.destroy()
      g.prop.destroy()
      delete guestSprites[name]
      if (guestBubbles[name]) {
        guestBubbles[name].destroy()
        delete guestBubbles[name]
      }
    }
  }

  // Calm movement: walk slowly to a spot, then stay still; idle agents change spot now and then.
  function updateGuests(time, delta) {
    const taken = new Set(Object.values(guestSprites).map((g) => `${g.zone}:${g.spot}`))
    for (const g of Object.values(guestSprites)) {
      const dx = g.target.x - g.sprite.x
      const dy = g.target.y - g.sprite.y
      const dist = Math.hypot(dx, dy)
      if (dist > 2) {
        const step = Math.min(dist, ((g.zone === "idle" ? WALK_SPEED.idle : WALK_SPEED.busy) * delta) / 1000)
        g.sprite.x += (dx / dist) * step
        g.sprite.y += (dy / dist) * step
        if (Math.abs(dx) > 1) g.sprite.setFlipX(dx < 0)
        const walk = `guest_anim_${g.n}_walk`
        if (g.sprite.anims.currentAnim?.key !== walk || !g.sprite.anims.isPlaying) g.sprite.anims.play(walk, true)
        g.prop.setText("")
        g.arrived = false
      } else if (!g.arrived) {
        g.arrived = true
        g.sprite.setPosition(g.target.x, g.target.y)
        if (g.zone === "idle") {
          g.sprite.anims.stop()
          g.sprite.setFrame(0)
          g.sprite.setFlipX(g.sprite.x > 640)
          g.prop.setText(PROP[SPOTS.idle[g.spot].pose] || "")
          g.nextWanderAt = time + 25000 + Math.random() * 35000
        } else {
          g.sprite.anims.play(`guest_anim_${g.n}_work`, true)
          g.sprite.setFlipX(g.zone === "meeting" ? g.sprite.x > 217 : g.sprite.x > 660)
        }
      } else if (g.zone === "idle" && time > g.nextWanderAt) {
        g.nextWanderAt = time + 25000 + Math.random() * 35000
        if (Math.random() < 0.5) {
          const spot = freeSpot("idle", taken)
          if (spot !== g.spot) {
            taken.delete(`idle:${g.spot}`)
            taken.add(`idle:${spot}`)
            goTo(g, "idle", spot)
          }
        }
      }
      const x = g.sprite.x
      const y = g.sprite.y
      g.sprite.setDepth(2100 + y / 10)
      g.nameText.setPosition(x, y - 120)
      g.alert.setPosition(x, y - 145)
      g.prop.setPosition(x + (g.sprite.flipX ? -26 : 26), y - 66)
    }
  }

  // Frames stop while the office is hidden: on return, agents are already where they were heading.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return
    for (const g of Object.values(guestSprites)) {
      if (g.arrived) continue
      g.sprite.setPosition(g.target.x, g.target.y)
    }
  })

  function makeBubble(x, y, text, opts) {
    const o = opts || {}
    const fontSize = o.fontSize || 12
    const width = Math.min(460, Math.max(60, text.length * (fontSize * 0.62) + 24))
    const bg = scene.add.rectangle(x, y, width, fontSize + 16, o.fill ?? 0xffffff, 0.95)
    bg.setStrokeStyle(2, o.stroke ?? 0x000000)
    const txt = scene.add
      .text(x, y, text, { fontFamily: FONT, fontSize: fontSize + "px", fill: o.color || "#000", align: "center", wordWrap: { width: width - 12 } })
      .setOrigin(0.5)
    const c = scene.add.container(0, 0, [bg, txt])
    c.setDepth(o.depth || 2700)
    return c
  }

  function clampX(x) {
    return Math.max(120, Math.min(1160, x))
  }

  function showMainBubble(force) {
    if (!scene || !snapshot || !snapshot.main) return
    if (bubble) {
      bubble.destroy()
      bubble = null
    }
    const main = snapshot.main
    let text
    if (force) text = force
    else if (main.waiting) text = pick(L.bubbles.waiting)
    else if (currentState === "idle") return
    else text = Math.random() < 0.6 ? detailText(main) : pick(L.bubbles[currentState] || L.bubbles.writing)
    if (!text) return
    const anchor = mainTag
    bubble = makeBubble(clampX(anchor.x), anchor.y - 34, text, { depth: 2700 })
    const b = bubble
    setTimeout(() => {
      if (bubble === b) {
        b.destroy()
        bubble = null
      }
    }, 3500)
  }

  function showCatBubble() {
    if (!scene || !window.catSprite) return
    if (catBubble) catBubble.destroy()
    catBubble = makeBubble(window.catSprite.x + 40, window.catSprite.y - 70, pick(L.bubbles.cat), {
      fill: 0xfffbeb,
      stroke: 0xd4a574,
      color: "#8b6914",
      fontSize: 11,
      depth: 2650, // above name tags, so agents sitting by the cat bed do not cover its text
    })
    const b = catBubble
    setTimeout(() => {
      if (catBubble === b) {
        b.destroy()
        catBubble = null
      }
    }, 4000)
  }

  function maybeShowGuestBubble(time) {
    if (!snapshot) return
    const main = snapshot.main
    const inMeeting = snapshot.guests.filter((c) => guestSprites[c.name] && main && c.meetingID && c.meetingID === main.meetingID && c.busy)
    // A meeting talks more than people working alone.
    const interval = inMeeting.length ? 4500 : 9000
    if (time - lastGuestBubbleAt < interval) return
    lastGuestBubbleAt = time
    const candidates = inMeeting.length ? inMeeting : snapshot.guests.filter((c) => guestSprites[c.name] && (c.busy || c.waiting))
    if (!candidates.length) return
    const char = pick(candidates)
    const text = char.waiting ? pick(L.bubbles.waiting) : detailText(char)
    showGuestBubble(char.name, text)
  }

  function showGuestBubble(name, text) {
    const g = guestSprites[name]
    if (!g || !text) return
    if (guestBubbles[name]) guestBubbles[name].destroy()
    const b = makeBubble(clampX(g.sprite.x), g.sprite.y - 150, text)
    guestBubbles[name] = b
    setTimeout(() => {
      if (guestBubbles[name] === b) {
        b.destroy()
        delete guestBubbles[name]
      }
    }, 3400)
  }

  function update(time, delta) {
    updateGuests(time, delta)
    if (time - lastBubble > 8000) {
      showMainBubble()
      lastBubble = time
    }
    if (time - lastCatBubble > 18000) {
      showCatBubble()
      lastCatBubble = time
    }
    maybeShowGuestBubble(time)

    const statusEl = document.getElementById("status-text")
    if (statusEl && typewriterIndex < typewriterTarget.length && time - lastTypewriter > 35) {
      typewriterText += typewriterTarget[typewriterIndex++]
      statusEl.textContent = typewriterText
      lastTypewriter = time
    }

    // keep guest bubbles glued to walking guests
    for (const name of Object.keys(guestBubbles)) {
      const g = guestSprites[name]
      const b = guestBubbles[name]
      if (!g || !b || !b.list) continue
      const x = clampX(g.sprite.x)
      const y = g.sprite.y - 150
      b.list[0].setPosition(x, y)
      b.list[1].setPosition(x, y)
    }
    if (mainAlert && mainAlert.visible) {
      mainAlert.setPosition(mainTag.x + mainTag.width / 2 + 16, mainTag.y)
      mainAlert.setAlpha(0.6 + 0.4 * Math.sin(time / 180))
    }
  }

  // ---------- snapshot -> scene + panels ----------
  function applySnapshot(snap) {
    const prev = snapshot
    snapshot = snap
    renderPanels()
    if (!scene) return
    const main = snap.main
    const state = main ? main.state : "idle"
    applyVisualState(state)
    mainTag.setText(main ? label(main) + (main.activeSessions > 1 ? ` ×${main.activeSessions}` : "") : "")
    mainAlert.setVisible(!!(main && main.waiting))

    const line = main
      ? `[${t("states." + state)}] ${label(main)} · ${detailText(main)}${main.sessionTitle ? " — " + main.sessionTitle : ""}`
      : `[${t("states.idle")}] ${t("detail.idle")}`
    if (line !== typewriterTarget) {
      typewriterTarget = line
      typewriterText = ""
      typewriterIndex = 0
    }

    renderGuests(snap.guests)

    // Star welcomes agents that just started working.
    const busyNow = new Set(snap.guests.filter((c) => c.busy).map((c) => c.name))
    if (!firstSnapshot) {
      for (const name of busyNow) {
        if (!seenGuests.has(name)) {
          const char = snap.guests.find((c) => c.name === name)
          showMainBubble(pick(L.welcome).replace("{agent}", label(char)))
          break
        }
      }
    }
    seenGuests = busyNow
    firstSnapshot = false

    if (main && main.waiting && !(prev && prev.main && prev.main.waiting)) showMainBubble(pick(L.bubbles.waiting))
    const meeting = main && main.meetingID && (snap.meetings || []).find((m) => m.id === main.meetingID && m.busy)
    meetingMarker.meetingID = meeting ? meeting.id : undefined
    meetingMarker.setText(meeting ? `🗨 ${t("chat.meetingMarker", { count: meeting.members.length })}` : "")
    meetingMarker.setVisible(!!meeting)
    if (chat.target) refreshChatHeader()
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }

  function timeOf(ts) {
    const d = new Date(ts)
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":")
  }

  // Panels are only rebuilt when their content changes, so clicks never land on a node being replaced.
  const panelKeys = {}
  function changed(name, value) {
    const key = settings.language + JSON.stringify(value)
    if (panelKeys[name] === key) return false
    panelKeys[name] = key
    return true
  }

  function renderPanels() {
    document.getElementById("log-title").textContent = t("logTitle")
    document.getElementById("team-title").textContent = t("teamTitle")
    document.getElementById("link-title").textContent = t("linkTitle")
    if (!snapshot) return
    const entries = snapshot.log.slice(-40).reverse()
    const chars = [snapshot.main, ...snapshot.guests].filter(Boolean)
    const teamView = chars.map((c) => [c.name, c.state, c.waiting, c.busy, c.activeSessions, c.detail, c.description, c.color, c.mode, c.teammate, c === snapshot.main])
    const c = snapshot.connection
    const anyBusy = chars.some((ch) => ch.busy)
    const linkView = [c.demo, c.live, c.pluginInstalled, c.kiloDetected, c.kiloLegacyVersion, c.lastEventAt && timeOf(c.lastEventAt), anyBusy]
    const meetings = snapshot.meetings || []
    if (changed("log", entries)) renderLog(entries)
    if (changed("meetings", meetings.map((m) => [m.id, m.title, m.members, m.busy]))) renderMeetings(meetings)
    if (changed("team", teamView)) renderTeam(chars)
    if (changed("link", linkView)) renderLink(c)
  }

  function renderLog(entries) {
    // activity log, newest first
    const log = document.getElementById("log-list")
    log.replaceChildren()
    if (!entries.length) log.append(el("div", "empty", t("logEmpty")))
    for (const e of entries) {
      const item = el("div", `log-item ${e.kind}`)
      item.append(el("time", "", timeOf(e.ts)))
      item.append(
        document.createTextNode(
          t("log." + e.kind, { agent: e.agent || "kilo", title: e.title || "", tool: e.tool || "", hint: e.hint || "", message: e.message || "", label: e.tool || e.hint || "" }),
        ),
      )
      log.append(item)
    }
  }

  // Rows are updated in place (keyed by agent name) so a click is never lost to a re-render.
  const teamRows = new Map()
  function renderTeam(chars) {
    const team = document.getElementById("team-list")
    if (!chars.length) {
      teamRows.clear()
      team.replaceChildren(el("div", "empty", t("teamEmpty")))
      return
    }
    team.querySelector(".empty")?.remove()
    const seen = new Set()
    chars.forEach((char, index) => {
      seen.add(char.name)
      let row = teamRows.get(char.name)
      if (!row) {
        const item = el("button", "agent-item")
        item.type = "button"
        item.addEventListener("click", () => openChat({ kind: "agent", name: char.name }))
        row = { item, dot: el("span", "agent-dot"), name: el("div", "agent-name"), sub: el("div", "agent-sub"), chip: el("span") }
        const body = el("div", "agent-body")
        body.append(row.name, row.sub)
        item.append(row.dot, body, row.chip)
        teamRows.set(char.name, row)
      }
      row.item.title = char.description || ""
      row.dot.style.background = char.color && /^#/.test(char.color) ? char.color : ""
      const badges = [el("span", "", label(char))]
      if (char === snapshot.main) badges.push(el("span", "badge main", "★"))
      const modeKey = char.teammate ? "teammate" : char.mode
      if (modeKey) badges.push(el("span", "badge", t("modes." + modeKey)))
      if (char.activeSessions > 1) badges.push(el("span", "badge", `×${char.activeSessions}`))
      row.name.replaceChildren(...badges)
      row.sub.textContent = char.busy || char.waiting || char.state !== "idle" ? detailText(char) : char.description || detailText(char)
      row.chip.className = `agent-state ${char.waiting ? "waiting" : char.state}`
      row.chip.textContent = char.waiting ? "!" : t("states." + char.state)
      row.item.setAttribute("aria-label", `${label(char)}: ${t("states." + char.state)}, ${row.sub.textContent}`)
      // Only touch the DOM order when it really changed: re-inserting a node cancels an ongoing click.
      if (team.children[index] !== row.item) team.insertBefore(row.item, team.children[index] || null)
    })
    for (const [name, row] of teamRows) {
      if (seen.has(name)) continue
      row.item.remove()
      teamRows.delete(name)
    }
  }

  function renderMeetings(meetings) {
    const box = document.getElementById("meeting-list")
    box.replaceChildren()
    box.style.display = meetings.length ? "" : "none"
    for (const m of meetings.slice(0, 4)) {
      const item = el("button", `meeting-item${m.busy ? " busy" : ""}`)
      item.type = "button"
      item.addEventListener("click", () => openChat({ kind: "meeting", id: m.id }))
      item.append(el("span", "meeting-icon", "🗨"))
      const body = el("div", "agent-body")
      body.append(el("div", "agent-name", m.title || t("chat.meeting")), el("div", "agent-sub", m.members.join(" · ")))
      item.append(body, el("span", `agent-state ${m.busy ? "writing" : "idle"}`, m.busy ? t("chat.live") : t("states.idle")))
      box.append(item)
    }
  }

  function renderLink(c) {
    const dot = document.getElementById("link-dot")
    const text = document.getElementById("link-text")
    dot.className = c.demo ? "demo" : c.live ? "live" : c.pluginInstalled ? "waiting" : ""
    text.textContent = c.demo
      ? t("linkDemo")
      : c.kiloLegacyVersion
        ? t("linkLegacy", { version: c.kiloLegacyVersion })
        : c.live
        ? t("linkLive")
        : c.pluginInstalled
          ? t("linkWaiting")
          : c.kiloDetected
            ? t("linkMissing")
            : t("linkNoKilo")
    document.getElementById("link-meta").textContent = c.lastEventAt ? `${t("lastEvent")}: ${timeOf(c.lastEventAt)}` : ""

    const buttons = document.getElementById("control-buttons")
    buttons.replaceChildren()
    const add = (key, command, cls) => {
      const b = el("button", `pixel-btn ${cls || ""}`, t(key))
      b.type = "button"
      b.addEventListener("click", () => vscode.postMessage({ type: "command", command }))
      buttons.append(b)
    }
    if (c.pluginInstalled) add("btnDisconnect", "disconnect", "danger")
    else add("btnConnect", "connect", "primary")
    add(c.demo ? "btnDemoOff" : "btnDemoOn", "toggleDemo")
    if (snapshot && [snapshot.main, ...snapshot.guests].some((ch) => ch && ch.busy)) {
      const stop = el("button", "pixel-btn danger", t("chat.stopAll"))
      stop.type = "button"
      stop.addEventListener("click", () => vscode.postMessage({ type: "stop" }))
      buttons.prepend(stop)
    }
    add("btnTeam", "createTeam", "primary")
    add("btnOpenKilo", "openKilo")

    const banner = document.getElementById("connect-banner")
    banner.classList.toggle("show", !c.pluginInstalled && !c.demo)
    document.getElementById("connect-banner-text").textContent = t("connectBanner")
    document.getElementById("connect-banner-btn").textContent = t("btnConnect")
  }

  // ---------- chat panel: one agent's conversation, or a whole meeting ----------
  const chat = { target: null, request: null, pending: null, timer: null, key: "", sessionID: null }

  function findChar(name) {
    if (!snapshot) return null
    return [snapshot.main, ...snapshot.guests].find((c) => c && c.name === name) || null
  }
  function findMeeting(id) {
    return snapshot ? (snapshot.meetings || []).find((m) => m.id === id) || null : null
  }
  function colorOf(name) {
    const c = findChar(name)
    return c && c.color && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : "#cbd5e1"
  }

  function openChat(target) {
    chat.target = target
    chat.key = ""
    chat.sessionID = null
    const result = document.getElementById("chat-result")
    result.textContent = ""
    result.className = ""
    document.getElementById("chat-log").replaceChildren(el("div", "empty", t("chat.loading")))
    const isMeeting = target.kind === "meeting"
    const meeting = isMeeting ? findMeeting(target.id) : null
    document.getElementById("chat-option").checked = isMeeting ? !!(meeting && meeting.busy) : false
    refreshChatHeader()
    document.getElementById("chat-panel").classList.add("open")
    requestTranscript()
    setTimeout(() => document.getElementById("chat-text").focus(), 30)
  }

  function closeChat() {
    document.getElementById("chat-panel").classList.remove("open")
    chat.target = null
    clearTimeout(chat.timer)
  }

  function chatBusy() {
    if (!chat.target) return false
    if (chat.target.kind === "meeting") return !!(findMeeting(chat.target.id) || {}).busy
    return !!(findChar(chat.target.name) || {}).busy
  }

  function refreshChatHeader() {
    const target = chat.target
    if (!target) return
    const connected = snapshot && (snapshot.connection.canPrompt || snapshot.connection.demo)
    const title = document.getElementById("chat-title")
    const sub = document.getElementById("chat-sub")
    const members = document.getElementById("chat-members")
    const avatar = document.getElementById("chat-avatar")
    const optionRow = document.getElementById("chat-option-row")
    const optionLabel = document.getElementById("chat-option-label")
    const text = document.getElementById("chat-text")
    members.replaceChildren()
    if (target.kind === "meeting") {
      const m = findMeeting(target.id)
      title.textContent = t("chat.meetingTitle", { title: (m && m.title) || t("chat.meeting") })
      sub.textContent = m ? (m.busy ? t("chat.live") : t("states.idle")) : ""
      avatar.textContent = "🗨"
      avatar.style.backgroundImage = ""
      for (const name of (m && m.members) || []) {
        const chip = el("button", "member-chip", name)
        chip.type = "button"
        chip.style.borderColor = colorOf(name)
        chip.addEventListener("click", () => openChat({ kind: "agent", name }))
        members.append(chip)
      }
      optionRow.style.display = "flex"
      optionLabel.textContent = t("chat.stopFirst")
      text.placeholder = `${t("chat.placeholderMeeting")}  (${t("chat.hint")})`
      document.getElementById("chat-send").textContent = chat.pending ? t("chat.sending") : t("chat.redirect")
    } else {
      const char = findChar(target.name)
      title.textContent = char ? label(char) : target.name
      const modeKey = char && (char.teammate ? "teammate" : char.mode)
      sub.textContent = char ? [modeKey ? t("modes." + modeKey) : "", `${t("states." + char.state)} · ${detailText(char)}`].filter(Boolean).join(" · ") : ""
      avatar.textContent = ""
      avatar.style.backgroundImage = `url("${asset(`guest_anim_${hashIndex(target.name, 6)}.webp`)}")`
      if (char && char.meetingID && findMeeting(char.meetingID)) {
        const follow = el("button", "member-chip meeting", `🗨 ${t("chat.followMeeting")}`)
        follow.type = "button"
        follow.addEventListener("click", () => openChat({ kind: "meeting", id: char.meetingID }))
        members.append(follow)
      }
      if (char && char.description) members.append(el("div", "chat-desc", char.description))
      const canContinue = !!(char && char.sessionID && !char.isSubagent && char.mode !== "subagent")
      optionRow.style.display = canContinue ? "flex" : "none"
      optionLabel.textContent = t("chat.newConversation")
      text.placeholder = `${t("chat.placeholderAgent", { agent: char ? label(char) : target.name })}  (${t("chat.hint")})`
      document.getElementById("chat-send").textContent = chat.pending ? t("chat.sending") : t("chat.send")
    }
    const stop = document.getElementById("chat-stop")
    stop.textContent = `■ ${t("chat.stop")}`
    stop.style.display = chatBusy() ? "" : "none"
    document.getElementById("chat-open").title = t("chat.open")
    document.getElementById("chat-close").title = t("chat.close")
    document.getElementById("chat-send").disabled = !!chat.pending || !connected
    if (!connected && !chat.pending) {
      const result = document.getElementById("chat-result")
      result.textContent = t("chat.notConnected")
      result.className = "err"
    }
  }

  function requestTranscript() {
    clearTimeout(chat.timer)
    if (!chat.target) return
    chat.request = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    vscode.postMessage({ type: "transcript", requestId: chat.request, target: chat.target })
    // Fallback in case no answer comes back.
    chat.timer = setTimeout(requestTranscript, 12000)
  }

  function sameTarget(a, b) {
    return a && b && a.kind === b.kind && (a.kind === "meeting" ? a.id === b.id : a.name === b.name)
  }

  function onTranscript(msg) {
    if (!chat.target || msg.requestId !== chat.request || !sameTarget(msg.target, chat.target)) return
    clearTimeout(chat.timer)
    chat.sessionID = msg.sessionID || null
    renderTranscript(msg.messages || [], msg.error)
    chat.timer = setTimeout(requestTranscript, chatBusy() ? 1500 : 5000)
  }

  function renderTranscript(messages, error) {
    const log = document.getElementById("chat-log")
    const key = JSON.stringify([messages, error, settings.language, chatBusy()])
    if (key === chat.key) return
    chat.key = key
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60
    const openReasoning = new Set([...log.querySelectorAll("details[open]")].map((d) => d.dataset.key))
    log.replaceChildren()
    if (error) log.append(el("div", "chat-error", error))
    if (!messages.length && !error) log.append(el("div", "empty", t("chat.empty")))
    const busy = chatBusy()
    messages.forEach((m, mi) => {
      const box = el("div", `msg ${m.role}${m.to ? " brief" : ""}`)
      const who = el("div", "msg-who")
      const name = m.role === "user" && !m.to ? t("chat.you") : m.speaker || m.agent || "kilo"
      const dot = el("span", "msg-dot")
      dot.style.background = m.role === "user" && !m.to ? "#e5e7eb" : colorOf(name)
      who.append(dot, el("span", "msg-name", m.to ? t("chat.briefTo", { from: name, to: m.to }) : name))
      if (m.time) who.append(el("time", "", timeOf(m.time)))
      box.append(who)
      m.parts.forEach((part, pi) => {
        const pkey = `${m.id}:${pi}`
        if (part.type === "text") box.append(el("div", "msg-text", part.text || ""))
        else if (part.type === "reasoning") {
          const d = el("details", "msg-reason")
          d.dataset.key = pkey
          const last = mi === messages.length - 1 && pi >= m.parts.length - 2
          if (openReasoning.has(pkey) || (busy && last)) d.open = true
          d.append(el("summary", "", t("chat.reasoning")), el("div", "msg-text", part.text || ""))
          box.append(d)
        } else if (part.type === "tool") {
          const mark = part.status === "completed" ? "✓" : part.status === "error" ? "✗" : "…"
          const line = el("div", `msg-tool ${part.status || ""}`, `🔧 ${part.tool}${part.title ? " · " + part.title : ""} ${mark}`)
          if (part.error) line.title = part.error
          box.append(line)
        } else if (part.type === "subtask") {
          box.append(el("div", "msg-tool", `↳ ${part.tool || ""}: ${part.text || ""}`))
        } else if (part.type === "file") {
          box.append(el("div", "msg-tool", `📎 ${part.title || ""}`))
        }
      })
      if (m.error) box.append(el("div", "chat-error", m.error))
      log.append(box)
    })
    if (nearBottom) log.scrollTop = log.scrollHeight
  }

  function sendChat() {
    const target = chat.target
    const text = document.getElementById("chat-text").value.trim()
    if (!target || !text || chat.pending) return
    chat.pending = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const option = document.getElementById("chat-option").checked && document.getElementById("chat-option-row").style.display !== "none"
    if (target.kind === "meeting") {
      vscode.postMessage({ type: "meetingPrompt", requestId: chat.pending, meetingID: target.id, text, stopFirst: option })
    } else {
      vscode.postMessage({ type: "prompt", requestId: chat.pending, agent: target.name, text, continueSession: !option })
    }
    refreshChatHeader()
  }

  function onPromptResult(msg) {
    if (msg.requestId !== chat.pending) return
    chat.pending = null
    const result = document.getElementById("chat-result")
    if (msg.ok) {
      result.textContent = t("chat.sent")
      result.className = "ok"
      document.getElementById("chat-text").value = ""
      document.getElementById("chat-option").checked = false
      setTimeout(() => {
        if (result.className === "ok") result.textContent = ""
      }, 3000)
      requestTranscript()
    } else {
      result.textContent = msg.error || "Error"
      result.className = "err"
    }
    refreshChatHeader()
  }

  function bindChat() {
    document.getElementById("chat-send").addEventListener("click", sendChat)
    document.getElementById("chat-close").addEventListener("click", closeChat)
    document.getElementById("chat-stop").addEventListener("click", () => {
      const target = chat.target
      if (!target) return
      vscode.postMessage(target.kind === "meeting" ? { type: "stop", meetingID: target.id } : { type: "stop", agent: target.name })
    })
    document.getElementById("chat-open").addEventListener("click", () => {
      const target = chat.target
      if (!target) return
      const agent = target.kind === "meeting" ? ((findMeeting(target.id) || {}).members || [])[0] : target.name
      if (agent) vscode.postMessage({ type: "openSession", agent })
    })
    document.getElementById("chat-text").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        sendChat()
      }
    })
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeChat()
    })
    document.getElementById("connect-banner-btn").addEventListener("click", () => vscode.postMessage({ type: "command", command: "connect" }))
  }

  // ---------- boot ----------
  function hideLoading() {
    const overlay = document.getElementById("loading-overlay")
    if (!overlay) return
    overlay.style.transition = "opacity .35s ease"
    overlay.style.opacity = "0"
    setTimeout(() => overlay.remove(), 380)
  }

  function applySettings(next) {
    const roomChanged = next.room && next.room !== settings.room
    settings = { ...settings, ...next, language: resolveLanguage(next.language || settings.language) }
    L = I18N[settings.language] || I18N.en
    document.documentElement.lang = settings.language
    if (window.officePlaque) window.officePlaque.setText(settings.officeName || t("officeName"))
    if (roomChanged && game) {
      game.destroy(true)
      game = null
      scene = null
      Object.keys(guestSprites).forEach((k) => delete guestSprites[k])
      startGame()
    }
    renderPanels()
  }

  function startGame() {
    game = new Phaser.Game({
      type: Phaser.AUTO,
      width: 1280,
      height: 720,
      parent: "game-container",
      pixelArt: true,
      transparent: false,
      backgroundColor: "#151522",
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: 1280, height: 720 },
      scene: { preload, create, update },
    })
  }

  window.addEventListener("message", (event) => {
    const msg = event.data
    if (!msg || typeof msg !== "object") return
    if (msg.type === "init") {
      applySettings(msg.settings)
      applySnapshot(msg.snapshot)
    } else if (msg.type === "snapshot") {
      applySnapshot(msg.snapshot)
    } else if (msg.type === "settings") {
      applySettings(msg.settings)
    } else if (msg.type === "promptResult") {
      onPromptResult(msg)
    } else if (msg.type === "transcript") {
      onTranscript(msg)
    }
  })

  async function boot() {
    document.getElementById("loading-text").textContent = t("loading")
    document.documentElement.style.setProperty("--memo-bg", `url("${asset("memo-bg.webp")}")`)
    bindChat()
    renderPanels()
    try {
      await Promise.race([document.fonts.load("16px ArkPixelLatin"), new Promise((r) => setTimeout(r, 2500))])
    } catch {}
    startGame()
    setTimeout(hideLoading, 8000)
    vscode.postMessage({ type: "ready" })
  }

  boot()
})()
