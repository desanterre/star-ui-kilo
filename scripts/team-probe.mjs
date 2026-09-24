// Dev check: does the manager template really delegate with the task tool?
// Runs a real Kilo server with an isolated config holding the team templates, sends one request to the
// manager and reports the teammates it called. Uses Kilo's free model unless PROBE_MODEL=provider/model.
// usage: KILO_BIN=/path/to/kilo node scripts/team-probe.mjs "request"
import * as esbuild from "esbuild"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const loadOnly = process.env.PROBE_LOAD_ONLY === "1"
const request = process.argv[2] || "Consult each member of the team (architect, ux-designer, developer, tester) and ask them how to improve a pixel-art dashboard for AI agents. Then give me a short summary."
const [providerID, modelID] = (process.env.PROBE_MODEL || "kilo/kilo-auto/free").split(/\/(.*)/)
await esbuild.build({ entryPoints: ["src/team.ts"], outfile: "out/e2e/team.js", bundle: true, platform: "node", format: "cjs", logLevel: "warning" })
const { ROLE_TEMPLATES, writeRoles } = createRequire(import.meta.url)(resolve("out/e2e/team.js"))
const tmp = mkdtempSync(join(tmpdir(), "star-team-probe-"))
const project = join(tmp, "project")
mkdirSync(project, { recursive: true })
const roster = (process.env.PROBE_ROLES || "manager,architect,ux-designer,developer,tester").split(",")
writeRoles(join(tmp, "config", "kilo", "agent"), loadOnly ? ROLE_TEMPLATES : ROLE_TEMPLATES.filter((r) => roster.includes(r.id)))
const password = "probe" + Math.random().toString(36).slice(2)
const kilo = spawn(process.env.KILO_BIN || "kilo", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
  cwd: project,
  env: { ...process.env, XDG_CONFIG_HOME: join(tmp, "config"), XDG_DATA_HOME: join(tmp, "data"), XDG_STATE_HOME: join(tmp, "state"), XDG_CACHE_HOME: join(tmp, "cache"), KILO_SERVER_PASSWORD: password, KILO_TELEMETRY_LEVEL: "off" },
  stdio: ["ignore", "pipe", "pipe"],
})
let out = ""
kilo.stdout.on("data", (d) => (out += d))
kilo.stderr.on("data", (d) => (out += d))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  let base
  for (let i = 0; i < 120 && !base; i++) (base = out.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0]), await wait(250)
  const api = (p, init = {}) =>
    fetch(`${base}${p}${p.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`, {
      ...init,
      headers: { authorization: "Basic " + Buffer.from(`kilo:${password}`).toString("base64"), "content-type": "application/json" },
    })
  if (loadOnly) {
    const agents = await (await api("/agent")).json()
    const byName = new Map(agents.map((a) => [a.name, a]))
    let missing = 0
    for (const role of ROLE_TEMPLATES) {
      const a = byName.get(role.id)
      if (!a) missing++
      console.log(`${a ? "✔" : "✖"} ${role.id}${a ? ` (mode ${a.mode})` : " NOT LOADED"}`)
    }
    const log = out.split("\n").filter((l) => /error|invalid|failed/i.test(l) && /agent|permission|frontmatter/i.test(l))
    if (log.length) console.log(log.slice(0, 10).join("\n"))
    console.log(missing ? `${missing} agent(s) not loaded` : `all ${ROLE_TEMPLATES.length} agents loaded`)
    process.exitCode = missing ? 1 : 0
    throw new Error("__done__")
  }
  const session = await (await api("/session", { method: "POST", body: "{}" })).json()
  await api(`/session/${session.id}/prompt_async`, { method: "POST", body: JSON.stringify({ agent: "manager", model: { providerID, modelID }, parts: [{ type: "text", text: request }] }) })
  let idleSince = 0
  for (let i = 0; i < 240; i++) {
    await wait(1000)
    const status = await (await api("/session/status")).json()
    const busy = Object.values(status || {}).some((s) => s && s.type !== "idle")
    if (!busy && i > 5) {
      if (!idleSince) idleSince = Date.now()
      if (Date.now() - idleSince > 4000) break
    } else idleSince = 0
  }
  const messages = await (await api(`/session/${session.id}/message`)).json()
  const parts = messages.flatMap((m) => m.parts || [])
  const tasks = parts.filter((p) => p.type === "tool" && p.tool === "task").map((p) => p.state?.input?.subagent_type)
  const others = parts.filter((p) => p.type === "tool" && p.tool !== "task").map((p) => p.tool)
  const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n").slice(0, 600)
  console.log(`model: ${providerID}/${modelID}`)
  console.log(`task calls: ${tasks.length} -> ${tasks.join(", ") || "none"}`)
  console.log(`other tools: ${others.join(", ") || "none"}`)
  console.log(`answer: ${text.replace(/\n+/g, " ")}`)
} catch (err) {
  if (err.message !== "__done__") throw err
} finally {
  kilo.kill("SIGTERM")
  await wait(300)
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(process.exitCode ?? 0)
