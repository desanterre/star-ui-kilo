// End-to-end check against a real Kilo server — the same engine the Kilo Code extension runs.
// It installs the plugin in an isolated Kilo config, starts `kilo serve`, drives Kilo's HTTP API
// and checks what reaches the office through a real bridge. Nothing touches your own Kilo config.
//
// usage: KILO_BIN=/path/to/kilo node scripts/e2e-kilo.mjs      (npm i @kilocode/cli to get one)
//        E2E_OFFLINE=1 also makes npm unreachable, after preparing the Kilo config folder the way the
//        extension does.
import * as esbuild from "esbuild"
import { spawn } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const require = createRequire(import.meta.url)
const kiloBin = process.env.KILO_BIN || "kilo"
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const check = (ok, label) => {
  console.log(`${ok ? "✔" : "✖"} ${label}`)
  if (!ok) failures.push(label)
}

await esbuild.build({
  entryPoints: ["src/bridge.ts", "src/office.ts", "src/kilo.ts"],
  outdir: "out/e2e",
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "warning",
})
const { Bridge } = require(resolve("out/e2e/bridge.js"))
const { OfficeModel } = require(resolve("out/e2e/office.js"))
const { prepareOfflineConfig } = require(resolve("out/e2e/kilo.js"))
const offline = process.env.E2E_OFFLINE === "1"

const tmp = mkdtempSync(join(tmpdir(), "star-e2e-"))
const xdg = (name) => join(tmp, name)
const project = join(tmp, "project")
mkdirSync(join(xdg("config"), "kilo", "plugin"), { recursive: true })
copyFileSync("plugin/star-ui-kilo.js", join(xdg("config"), "kilo", "plugin", "star-ui-kilo.js"))
mkdirSync(join(project, ".kilo", "agent"), { recursive: true })
// A cross-repo teammate, to check that the ask_teammate tool gets registered.
const otherRepo = join(tmp, "other-repo")
mkdirSync(otherRepo, { recursive: true })
mkdirSync(join(tmp, "star"), { recursive: true })
writeFileSync(
  join(tmp, "star", "team.json"),
  JSON.stringify({ members: [{ name: "other-expert", repo: otherRepo, agent: "ask", description: "Knows the other repo" }] }),
)
// Profiles set in the office: a team context, and a linked folder for the reviewer.
const linked = join(tmp, "linked-repo")
mkdirSync(linked, { recursive: true })
writeFileSync(join(linked, "go.mod"), "module example.com/linked\n\ngo 1.22\n")
writeFileSync(join(linked, "NOTES.txt"), "The deployment window is Tuesday.\n")
writeFileSync(
  join(tmp, "star", "profiles.json"),
  JSON.stringify({
    team: { context: "The team code is ZEBRA-4412." },
    agents: { reviewer: { context: "Always answer in English.", folders: [linked] } },
  }),
)
writeFileSync(
  join(project, ".kilo", "agent", "reviewer.md"),
  "---\ndescription: Reviews changes for bugs.\nmode: all\ncolor: \"#f59e0b\"\n---\nYou review code.\n",
)

if (offline) console.log(`offline mode: Kilo config ${prepareOfflineConfig(join(xdg("config"), "kilo"), "7.7.9")}`)

const model = new OfficeModel()
const seen = []
const bridge = new Bridge(join(tmp, "star"), (payload) => {
  for (const ev of payload.events) {
    seen.push(ev)
    model.apply(ev, Date.now(), payload.source)
  }
})
await bridge.start()

const password = "e2e-" + Math.random().toString(36).slice(2)
const kilo = spawn(kiloBin, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
  cwd: project,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: xdg("config"),
    XDG_DATA_HOME: xdg("data"),
    XDG_STATE_HOME: xdg("state"),
    XDG_CACHE_HOME: xdg("cache"),
    STAR_UI_KILO_HOME: join(tmp, "star"),
    KILO_SERVER_PASSWORD: password,
    KILO_PARENT_PID: String(process.pid),
    KILO_CLIENT: "vscode",
    KILO_TELEMETRY_LEVEL: "off",
    ...(offline ? { npm_config_registry: "http://127.0.0.1:9", NPM_CONFIG_REGISTRY: "http://127.0.0.1:9" } : {}),
  },
  stdio: ["ignore", "pipe", "pipe"],
})
let output = ""
kilo.stdout.on("data", (d) => (output += d))
kilo.stderr.on("data", (d) => (output += d))

try {
  let base
  for (let i = 0; i < 120 && !base; i++) {
    base = output.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0]
    await wait(250)
  }
  if (!base) throw new Error(`kilo serve did not start:\n${output}`)
  console.log(`kilo serve is up on ${base}`)
  const auth = { authorization: "Basic " + Buffer.from(`kilo:${password}`).toString("base64") }
  const api = (path, init = {}) =>
    fetch(`${base}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`, {
      ...init,
      headers: { ...auth, "content-type": "application/json", ...(init.headers || {}) },
    })

  // Touching the project boots a Kilo instance for it, which loads the plugin.
  const bootStart = Date.now()
  const agents = await (await api("/agent")).json()
  const bootMs = Date.now() - bootStart
  console.log(`first Kilo API call answered in ${(bootMs / 1000).toFixed(1)}s`)
  if (offline) check(bootMs < 15000, "Kilo does not wait for npm when it is unreachable")
  check(Array.isArray(agents) && agents.some((a) => a.name === "reviewer"), "Kilo sees the project's custom agent")

  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = await fn()
      if (v) return v
      await wait(100)
    }
  }
  const hello = await until(() => seen.find((e) => e.t === "hello"))
  check(!!hello && hello.client === "vscode" && hello.commands === true, "plugin loaded by Kilo and said hello")
  const live = model.liveInstances(undefined, process.pid)
  check(live.length > 0 && live[0].parentPid === process.pid, "plugin reports the VS Code window that spawned Kilo")

  const roster = await until(() => seen.find((e) => e.t === "roster"))
  check(!!roster && roster.agents.some((a) => a.name === "reviewer" && a.mode === "all"), "roster contains the custom agent")
  check(!!roster && roster.agents.some((a) => a.name === "code" && a.builtIn), "roster flags built-in agents")
  check(!!roster && roster.agents.some((a) => a.name === "other-expert" && a.teammate), "roster contains the cross-repo teammate")
  const tools = await (await api("/experimental/tool/ids")).json()
  check(Array.isArray(tools) && tools.includes("ask_teammate"), "Kilo registered the ask_teammate tool")
  check(Array.isArray(tools) && tools.includes("remember"), "Kilo registered the remember tool")
  const reviewer = agents.find((a) => a.name === "reviewer")
  check(!!reviewer && JSON.stringify(reviewer).includes(JSON.stringify(`${linked}/*`).slice(1, -1)), "the reviewer may read its linked folder")

  const session = await (await api("/session", { method: "POST", body: "{}" })).json()
  const created = await until(() => seen.find((e) => e.t === "session" && e.sid === session.id))
  check(!!created, "session.created reaches the office")

  // Prompt an agent from the office. Whatever model Kilo picks in this sandbox, what matters is that
  // the prompt reaches Kilo and that the outcome comes back as events.
  const target = model.liveInstances(project, process.pid)[0]
  const result = await bridge.sendCommand(
    { pid: target.pid, dir: target.dir },
    { kind: "prompt", agent: "reviewer", mode: "all", text: "Say hi", model: { providerID: "kilo", modelID: "kilo-auto/free" } },
    20000,
  )
  check(result.ok && !!result.sessionID, `prompt accepted by Kilo (${result.error ?? result.sessionID})`)
  const reaction = await until(
    () => seen.find((e) => e.sid === result.sessionID && (e.t === "status" || e.t === "error" || e.t === "agent")),
    20000,
  )
  check(!!reaction, `Kilo reacted to the prompt (${reaction ? reaction.t : "nothing"})`)
  // The office chat reads the conversation through the plugin.
  const transcript = await bridge.sendCommand({ pid: target.pid, dir: target.dir }, { kind: "messages", sessionID: result.sessionID }, 20000)
  check(
    transcript.ok && transcript.data.some((m) => m.role === "user" && m.parts.some((p) => p.type === "text" && p.text === "Say hi")),
    "the office chat reads the conversation",
  )
  // Stop button: abort through the plugin.
  const stop = await bridge.sendCommand({ pid: target.pid, dir: target.dir }, { kind: "abort", sessions: [{ sessionID: result.sessionID }] }, 20000)
  const idle = await until(async () => {
    const status = await (await api("/session/status")).json()
    return !status[result.sessionID] || status[result.sessionID].type === "idle"
  }, 15000)
  check(stop.ok && !!idle, "the Stop button stops the session")
  const messages = await (await api(`/session/${result.sessionID}/message`)).json()
  const user = Array.isArray(messages) ? messages.map((m) => m.info).find((i) => i && i.role === "user") : undefined
  check(
    user && user.model && user.model.providerID === "kilo" && user.model.modelID === "kilo-auto/free",
    `prompt uses Kilo Code's model (${user && user.model ? user.model.providerID + "/" + user.model.modelID : "none"})`,
  )
  // Briefing: what the plugin adds to the reviewer's system prompt.
  const brief = await bridge.sendCommand({ pid: target.pid, dir: target.dir }, { kind: "briefing", agent: "reviewer" }, 20000)
  check(
    brief.ok && brief.text.includes("ZEBRA-4412") && brief.text.includes("Go module example.com/linked") && brief.text.includes("**other-expert**"),
    "the briefing holds the team context, the linked folder and the teammates",
  )
  if (!offline) {
    // The briefing reaches the model: only the system prompt holds the team code.
    const asked = await bridge.sendCommand(
      { pid: target.pid, dir: target.dir },
      {
        kind: "prompt",
        agent: "reviewer",
        mode: "all",
        text: "What is the team code written in your instructions? Reply with the code only.",
        model: { providerID: "kilo", modelID: "kilo-auto/free" },
      },
      20000,
    )
    const answered = await until(async () => {
      const status = await (await api("/session/status")).json()
      if (status[asked.sessionID] && status[asked.sessionID].type !== "idle") return undefined
      const list = await (await api(`/session/${asked.sessionID}/message`)).json()
      const reply = (Array.isArray(list) ? list : []).filter((m) => m.info && m.info.role === "assistant").pop()
      return reply && reply.parts.filter((p) => p.type === "text").map((p) => p.text).join(" ")
    }, 90000)
    check(!!answered && answered.includes("ZEBRA-4412"), `the model received the briefing (${answered ? answered.slice(0, 60) : "no answer"})`)
  }
  const snap = model.snapshot({ pluginInstalled: true, kiloDetected: true, live: true, canPrompt: true, demo: false })
  console.log(
    "office:",
    [snap.main, ...snap.guests].filter(Boolean).map((c) => `${c.name}=${c.state}${c.busy ? "*" : ""}`).join(" "),
  )
  console.log("event types:", [...new Set(seen.map((e) => e.t))].join(", "))
} catch (err) {
  failures.push(String(err))
  console.error(err)
} finally {
  kilo.kill("SIGTERM")
  bridge.dispose()
  await wait(300)
  rmSync(tmp, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("\nAll end-to-end checks passed")
process.exit(0)
