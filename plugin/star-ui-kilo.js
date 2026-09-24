// star-ui-kilo-plugin v0.1.5
//
// Installed by the "Star UI for Kilo" VS Code extension (https://github.com/desanterre/star-ui-kilo).
//
// Kilo loads every file in ~/.config/kilo/plugin/ at startup (including the server started
// by the Kilo Code VS Code extension). This plugin:
//   1. forwards a *lightweight summary* of agent activity (session status, tool names,
//      sub-agents, pending approvals, list of agents) to the Star Office panel in VS Code;
//   2. lets you prompt an agent from the office: the panel queues a prompt, this plugin
//      picks it up and sends it through Kilo's own authenticated client;
//   3. adds an `ask_teammate` tool when ~/.star-ui-kilo/team.json lists specialists of
//      other repositories, so an agent can consult another repo's agent and get its answer;
//   4. briefs every agent at each turn: its role, its teammates, the custom context and the
//      linked folders set in the office (~/.star-ui-kilo/profiles.json), and the notes saved
//      with the `remember` tool. Linked folders are readable without asking.
//
// - Traffic only goes to 127.0.0.1, to bridges registered in ~/.star-ui-kilo/bridges/.
// - No file contents, model outputs or credentials are ever sent to the panel.
// - Every error is swallowed: this plugin must never break Kilo.
// - Safe to delete at any time (or run "Star UI: Disconnect from Kilo" in VS Code).

import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

const VERSION = "0.1.5"
const HOME = process.env.STAR_UI_KILO_HOME || path.join(os.homedir(), ".star-ui-kilo")
const REGISTRY_DIR = path.join(HOME, "bridges")
const TEAM_FILE = path.join(HOME, "team.json")
const PROFILES_FILE = path.join(HOME, "profiles.json")
const FLUSH_MS = 120
const REGISTRY_TTL_MS = 3000
const HEARTBEAT_MS = 30000
const THINKING_THROTTLE_MS = 1500
const MAX_QUEUE = 500
const MAX_CACHED_SESSIONS = 60
const ROSTER_REFRESH_MS = 60000
const POLL_TIMEOUT_MS = 25000
const MAX_PROMPT_CHARS = 20000
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"])
const MAX_CONTEXT_CHARS = 8000
const MAX_FOLDERS = 20
const MAX_NOTES = 40
const MAX_NOTE_CHARS = 500
const MAX_BRIEFING_CHARS = 24000
const FOLDER_CARD_TTL_MS = 5 * 60000
const PARENT_PID = Number(process.env.KILO_PARENT_PID) || undefined
const CLIENT = process.env.KILO_CLIENT || "cli"

// Kilo Code forwards VS Code's http.proxy to its server as HTTP(S)_PROXY. A proxy cannot reach this
// machine's loopback, so calls to 127.0.0.1 (our bridge, and Kilo's own API used through the plugin
// client) must bypass it.
{
  const current = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((s) => s.trim()).filter(Boolean)
  const merged = [...new Set([...current, "127.0.0.1", "localhost", "::1"])].join(",")
  process.env.NO_PROXY = merged
  process.env.no_proxy = merged
}

let queue = []
let flushTimer = null
let registry = { at: 0, bridges: [] }
const knownBridges = new Set()
// Latest meaningful events per session, replayed to bridges that appear later
// (e.g. VS Code window opened after `kilo` was already running in a terminal).
const cache = new Map()
const lastThinking = new Map()
const lastAgent = new Map()
// Sessions started for a teammate (sid -> teammate name). Used for display and loop protection.
const teammateSessions = new Map()

function short(value, max) {
  if (value === undefined || value === null) return undefined
  const s = String(value).replace(/\s+/g, " ").trim()
  if (!s) return undefined
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

function hostOf(url) {
  try {
    return new URL(String(url)).host
  } catch {
    return undefined
  }
}

function toolHint(state) {
  const input = (state && state.input) || {}
  const file = input.filePath || input.file_path || input.path
  return short(
    (state && state.title) ||
      input.description ||
      (file && path.basename(String(file))) ||
      input.pattern ||
      input.query ||
      (input.url && hostOf(input.url)) ||
      input.command ||
      input.teammate ||
      input.subagent_type,
    60,
  )
}

function remember(ev) {
  if (!ev.sid) return
  let entry = cache.get(ev.sid)
  if (!entry) {
    if (cache.size >= MAX_CACHED_SESSIONS) cache.delete(cache.keys().next().value)
    entry = {}
    cache.set(ev.sid, entry)
  }
  if (ev.t === "session" || ev.t === "status" || ev.t === "agent" || ev.t === "tool") entry[ev.t] = ev
  if (ev.t === "session.deleted") cache.delete(ev.sid)
}

function push(ev, ctx) {
  if (!ev || (ev.t !== "hello" && ev.t !== "roster" && ev.t !== "error" && !ev.sid)) return
  ev.ts = Date.now()
  if (ctx && !ev.dir) ev.dir = ctx.directory
  remember(ev)
  queue.push(ev)
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS)
}

function alive(pid) {
  if (!pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === "EPERM"
  }
}

function readRegistry() {
  const now = Date.now()
  if (now - registry.at < REGISTRY_TTL_MS) return registry.bridges
  const bridges = []
  try {
    for (const name of fs.readdirSync(REGISTRY_DIR)) {
      if (!name.endsWith(".json")) continue
      try {
        const info = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, name), "utf8"))
        if (info && Number.isInteger(info.port) && typeof info.token === "string" && alive(info.pid)) {
          bridges.push({ key: name, port: info.port, token: info.token })
        }
      } catch {}
    }
  } catch {}
  registry = { at: now, bridges }
  return bridges
}

const hellos = new Map()
const rosters = new Map()

function replayFor() {
  const events = [...hellos.values(), ...rosters.values()]
  for (const entry of cache.values()) {
    for (const key of ["session", "agent", "status", "tool"]) if (entry[key]) events.push(entry[key])
  }
  return events
}

// Plain node:http without an agent: never routed through HTTP(S)_PROXY, whatever the runtime does with fetch.
function bridgeRequest(bridge, method, urlPath, body, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        host: "127.0.0.1",
        port: bridge.port,
        path: urlPath,
        method,
        agent: false,
        headers: {
          authorization: `Bearer ${bridge.token}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("error", reject)
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`bridge answered ${res.statusCode}`))
          try {
            resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined)
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    const abort = () => req.destroy(new Error("aborted"))
    const timer = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs)
    req.on("error", reject)
    req.on("close", () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", abort)
    })
    if (signal) {
      if (signal.aborted) return abort()
      signal.addEventListener("abort", abort, { once: true })
    }
    req.end(payload)
  })
}

async function send(bridge, events) {
  try {
    await bridgeRequest(
      bridge,
      "POST",
      "/v1/events",
      { source: { plugin: VERSION, pid: process.pid, parentPid: PARENT_PID }, events },
      1500,
    )
  } catch {}
}

function flush() {
  flushTimer = null
  const events = queue
  queue = []
  const bridges = readRegistry()
  for (const bridge of bridges) {
    if (!knownBridges.has(bridge.key)) {
      knownBridges.add(bridge.key)
      const replay = replayFor().filter((ev) => !events.includes(ev))
      void send(bridge, replay.concat(events))
      continue
    }
    if (events.length) void send(bridge, events)
  }
}

function thinking(sid, kind, ctx) {
  const now = Date.now()
  if (now - (lastThinking.get(sid) || 0) < THINKING_THROTTLE_MS) return
  lastThinking.set(sid, now)
  push({ t: "thinking", sid, kind }, ctx)
}

function sessionEvent(info, ctx) {
  if (!info || !info.id) return
  push(
    {
      t: "session",
      sid: info.id,
      parentID: info.parentID || undefined,
      title: short(info.title, 80),
      agent: short(info.agent, 40),
      teammate: teammateSessions.get(info.id),
      dir: info.directory || ctx.directory,
    },
    ctx,
  )
}

function handle(event, ctx) {
  const type = event && event.type
  const p = (event && event.properties) || {}
  switch (type) {
    case "session.created":
    case "session.updated":
      return sessionEvent(p.info, ctx)
    case "session.deleted":
      return push({ t: "session.deleted", sid: (p.info && p.info.id) || p.sessionID }, ctx)
    case "session.status": {
      const status = p.status && p.status.type
      if (!status) return
      return push(
        {
          t: "status",
          sid: p.sessionID,
          status,
          message: status === "retry" || status === "offline" ? short(p.status.message, 120) : undefined,
        },
        ctx,
      )
    }
    case "session.idle":
      return push({ t: "status", sid: p.sessionID, status: "idle" }, ctx)
    case "session.error": {
      const err = p.error || {}
      return push(
        {
          t: "error",
          sid: p.sessionID,
          name: short(err.name, 40),
          message: short((err.data && err.data.message) || err.message, 160),
        },
        ctx,
      )
    }
    case "session.compacted":
    case "session.next.compaction.ended":
      return push({ t: "compaction", sid: p.sessionID, phase: "end" }, ctx)
    case "session.next.compaction.started":
      return push({ t: "compaction", sid: p.sessionID, phase: "start" }, ctx)
    case "message.updated": {
      const info = p.info
      if (!info || info.role !== "assistant") return
      const agent = short(info.agent || info.mode, 40)
      if (agent) rememberAgent(info.sessionID, agent)
      if (!agent || lastAgent.get(info.sessionID) === agent) return
      lastAgent.set(info.sessionID, agent)
      return push({ t: "agent", sid: info.sessionID, agent }, ctx)
    }
    case "message.part.updated": {
      const part = p.part
      if (!part) return
      if (part.type === "tool") {
        const state = part.state || {}
        return push(
          {
            t: "tool",
            sid: part.sessionID,
            callID: part.callID || part.id,
            tool: short(part.tool, 60) || "tool",
            status: state.status || "running",
            hint: toolHint(state),
            error: state.status === "error" ? short(state.error, 120) : undefined,
          },
          ctx,
        )
      }
      if (part.type === "text" || part.type === "reasoning") return thinking(part.sessionID, part.type, ctx)
      if (part.type === "compaction") return push({ t: "compaction", sid: part.sessionID, phase: "start" }, ctx)
      return
    }
    case "message.part.delta":
      return thinking(p.sessionID, p.field === "reasoning" ? "reasoning" : "text", ctx)
    case "session.next.tool.called":
      return push(
        { t: "tool", sid: p.sessionID, callID: p.callID, tool: short(p.tool, 60) || "tool", status: "running", hint: toolHint({ input: p.input }) },
        ctx,
      )
    case "session.next.tool.success":
      return push({ t: "tool", sid: p.sessionID, callID: p.callID, tool: short(p.tool, 60) || "tool", status: "completed" }, ctx)
    case "session.next.tool.failed":
      return push({ t: "tool", sid: p.sessionID, callID: p.callID, tool: short(p.tool, 60) || "tool", status: "error" }, ctx)
    case "permission.asked":
    case "permission.updated":
      return push(
        { t: "ask", sid: p.sessionID, rid: p.id, kind: "permission", label: short(p.permission || p.type || p.title, 60) },
        ctx,
      )
    case "permission.replied":
      return push({ t: "answered", sid: p.sessionID, rid: p.requestID || p.permissionID || p.id }, ctx)
    case "question.asked": {
      const q = Array.isArray(p.questions) ? p.questions[0] : undefined
      return push({ t: "ask", sid: p.sessionID, rid: p.id, kind: "question", label: short(q && (q.header || q.question), 60) }, ctx)
    }
    case "question.replied":
    case "question.rejected":
      return push({ t: "answered", sid: p.sessionID, rid: p.requestID || p.id }, ctx)
    default:
      return
  }
}

function unwrap(res) {
  if (res && res.error) {
    const err = res.error
    throw new Error(short((err.data && err.data.message) || err.message || err.name || JSON.stringify(err), 200))
  }
  return res && typeof res === "object" && "data" in res ? res.data : res
}

function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p
}

function readTeam() {
  try {
    const raw = JSON.parse(fs.readFileSync(TEAM_FILE, "utf8"))
    const members = Array.isArray(raw && raw.members) ? raw.members : []
    return members
      .filter((m) => m && typeof m.name === "string" && typeof m.repo === "string" && /^[\w.-]{1,40}$/.test(m.name))
      .map((m) => ({
        name: m.name,
        repo: path.resolve(expandHome(m.repo)),
        agent: short(m.agent, 40) || "code",
        description: short(m.description, 200),
        color: short(m.color, 30),
      }))
  } catch {
    return []
  }
}

function findTeammate(name) {
  const wanted = String(name || "").toLowerCase()
  return readTeam().find((m) => m.name.toLowerCase() === wanted)
}

async function refreshRoster(ctx) {
  const list = unwrap(await ctx.client.app.agents({ query: { directory: ctx.directory } }))
  if (!Array.isArray(list)) return
  ctx.agentModels = new Map(list.filter((a) => a && a.name).map((a) => [a.name, !!a.model]))
  ctx.roster = list.filter((a) => a && typeof a.name === "string")
  const agents = list
    .filter((a) => a && typeof a.name === "string")
    .map((a) => ({
      name: short(a.name, 40),
      displayName: short(a.displayName, 40),
      description: short(a.description, 200),
      mode: a.mode === "subagent" || a.mode === "all" ? a.mode : "primary",
      color: short(a.color, 30),
      builtIn: !!(a.builtIn || a.native),
      hidden: !!a.hidden,
    }))
  for (const m of readTeam()) {
    agents.push({
      name: m.name,
      description: m.description || `Specialist of ${path.basename(m.repo)}`,
      mode: "all",
      color: m.color,
      teammate: true,
      repo: m.repo,
    })
  }
  const ev = { t: "roster", agents }
  push(ev, ctx)
  rosters.set(ctx.directory, ev)
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

function asModel(value) {
  if (value && typeof value.providerID === "string" && typeof value.modelID === "string" && value.providerID && value.modelID) {
    return { providerID: value.providerID, modelID: value.modelID }
  }
  if (typeof value === "string" && value.includes("/")) {
    const i = value.indexOf("/")
    return { providerID: value.slice(0, i), modelID: value.slice(i + 1) }
  }
  return undefined
}

// Same choice as Kilo Code's model picker: the agent's own model is left to Kilo; otherwise the model
// picked for this agent (model.json), the last picked model (vscode-model.json), `model` from the Kilo
// config, then Kilo Code's default-model settings sent by the extension.
async function resolveModel(ctx, agent, fallback) {
  if (!ctx.agentModels) {
    try {
      await refreshRoster(ctx)
    } catch {}
  }
  if (ctx.agentModels && ctx.agentModels.get(agent)) return undefined
  if (ctx.stateDir === undefined) {
    try {
      ctx.stateDir = (unwrap(await ctx.client.path.get({ query: { directory: ctx.directory } })) || {}).state || null
    } catch {
      ctx.stateDir = null
    }
  }
  if (ctx.stateDir) {
    const selections = readJsonFile(path.join(ctx.stateDir, "model.json"))
    const picked = asModel(selections && selections.model && selections.model[agent])
    if (picked) return picked
    const prefs = readJsonFile(path.join(ctx.stateDir, "vscode-model.json"))
    const preferred = asModel(prefs && prefs.preferred)
    if (preferred) return preferred
  }
  try {
    const configured = asModel((unwrap(await ctx.client.config.get({ query: { directory: ctx.directory } })) || {}).model)
    if (configured) return configured
  } catch {}
  return asModel(fallback)
}

const MAX_TRANSCRIPT_MESSAGES = 60
const MAX_PART_CHARS = 6000
const MAX_TRANSCRIPT_CHARS = 400000

function transcript(list) {
  const out = []
  for (const entry of Array.isArray(list) ? list.slice(-MAX_TRANSCRIPT_MESSAGES) : []) {
    const info = (entry && entry.info) || {}
    const parts = []
    for (const part of (entry && entry.parts) || []) {
      if (!part || part.synthetic || part.ignored) continue
      if (part.type === "text" || part.type === "reasoning") {
        if (part.text) parts.push({ type: part.type, text: String(part.text).slice(-MAX_PART_CHARS) })
      } else if (part.type === "tool") {
        const state = part.state || {}
        parts.push({ type: "tool", tool: part.tool, status: state.status, title: toolHint(state), error: short(state.error, 300) })
      } else if (part.type === "file") {
        parts.push({ type: "file", title: short(part.filename || part.url, 120) })
      } else if (part.type === "subtask") {
        parts.push({ type: "subtask", tool: part.agent, text: short(part.prompt, 2000) })
      }
    }
    const error = info.error ? short((info.error.data && info.error.data.message) || info.error.name, 300) : undefined
    if (!parts.length && !error) continue
    out.push({ id: info.id, role: info.role === "user" ? "user" : "assistant", agent: info.agent || info.mode, time: info.time && info.time.created, error, parts })
  }
  // Keep the payload small: drop the oldest messages first.
  while (out.length > 1 && JSON.stringify(out).length > MAX_TRANSCRIPT_CHARS) out.shift()
  return out
}

async function runCommand(cmd, ctx) {
  if (!cmd || typeof cmd.id !== "string") return undefined
  if (cmd.kind === "roster") {
    await refreshRoster(ctx)
    return { id: cmd.id, ok: true }
  }
  if (cmd.kind === "abort") {
    const sessions = Array.isArray(cmd.sessions) ? cmd.sessions.slice(0, 50) : []
    for (const s of sessions) {
      if (!s || typeof s.sessionID !== "string") continue
      try {
        unwrap(await ctx.client.session.abort({ path: { id: s.sessionID }, query: { directory: s.dir || ctx.directory } }))
      } catch {}
    }
    return { id: cmd.id, ok: true }
  }
  if (cmd.kind === "briefing") {
    if (typeof cmd.agent !== "string") return { id: cmd.id, ok: false, error: "invalid command" }
    return { id: cmd.id, ok: true, text: await briefing(cmd.agent, ctx) }
  }
  if (cmd.kind === "messages") {
    if (typeof cmd.sessionID !== "string") return { id: cmd.id, ok: false, error: "invalid command" }
    const list = unwrap(
      await ctx.client.session.messages({ path: { id: cmd.sessionID }, query: { directory: cmd.dir || ctx.directory } }),
    )
    return { id: cmd.id, ok: true, sessionID: cmd.sessionID, data: transcript(list) }
  }
  if (cmd.kind !== "prompt" || typeof cmd.agent !== "string" || typeof cmd.text !== "string" || !cmd.text.trim()) {
    return { id: cmd.id, ok: false, error: "invalid command" }
  }
  const text = cmd.text.slice(0, MAX_PROMPT_CHARS)
  if (asModel(cmd.model)) ctx.fallbackModel = asModel(cmd.model)
  const teammate = findTeammate(cmd.agent)
  const agent = teammate ? teammate.agent : cmd.agent
  const query = { directory: teammate ? teammate.repo : ctx.directory }
  let sessionID = typeof cmd.sessionID === "string" && cmd.sessionID ? cmd.sessionID : undefined
  if (!sessionID) {
    const created = unwrap(await ctx.client.session.create({ body: {}, query }))
    sessionID = created && created.id
    if (!sessionID) throw new Error("Kilo did not return a session id")
  }
  if (teammate) {
    teammateSessions.set(sessionID, teammate.name)
    push({ t: "session", sid: sessionID, agent, teammate: teammate.name, dir: teammate.repo }, ctx)
  }
  // A continued conversation keeps its own model, like in Kilo Code.
  const model = typeof cmd.sessionID === "string" && cmd.sessionID ? undefined : await resolveModel(ctx, agent, cmd.model)
  // Sub-agents cannot drive a conversation themselves: start them as a sub-task, like an @mention.
  const body =
    cmd.mode === "subagent" && !teammate
      ? { parts: [{ type: "subtask", agent, prompt: text, description: short(text, 60) || agent }] }
      : { agent, parts: [{ type: "text", text }] }
  if (model) body.model = model
  unwrap(await ctx.client.session.promptAsync({ path: { id: sessionID }, body, query }))
  return { id: cmd.id, ok: true, sessionID }
}

function answerText(result) {
  const parts = (result && result.parts) || []
  return parts
    .filter((p) => p && p.type === "text" && !p.synthetic && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

async function askTeammate(ctx, args, toolCtx) {
  toolCtx = toolCtx || {}
  if (toolCtx.sessionID && teammateSessions.has(toolCtx.sessionID)) {
    return "Loop protection: a teammate cannot consult other teammates. Answer with what you know."
  }
  const team = readTeam()
  const member = findTeammate(args.teammate)
  if (!member) return `Unknown teammate "${args.teammate}". Available teammates: ${team.map((m) => m.name).join(", ") || "none"}.`
  if (!fs.existsSync(member.repo)) return `The repository of ${member.name} was not found: ${member.repo}`
  const query = { directory: member.repo }
  const created = unwrap(
    await ctx.client.session.create({ body: { title: `${short(args.question, 60)} (@${member.name} teammate)` }, query }),
  )
  const sid = created && created.id
  if (!sid) throw new Error("Kilo did not return a session id")
  teammateSessions.set(sid, member.name)
  push({ t: "session", sid, agent: member.agent, teammate: member.name, title: short(args.question, 80), dir: member.repo }, ctx)
  if (typeof toolCtx.metadata === "function") toolCtx.metadata({ title: `Asking ${member.name}` })
  const abort = () => void Promise.resolve(ctx.client.session.abort({ path: { id: sid }, query })).catch(() => {})
  if (toolCtx.abort) toolCtx.abort.addEventListener("abort", abort, { once: true })
  const from = toolCtx.directory || ctx.directory
  const text =
    `You are "${member.name}", the specialist of this repository (${member.repo}). ` +
    `An agent working on another repository (${from}) asks you the following. ` +
    `Answer precisely and concisely, citing files and symbols from your repository.\n\n${args.question}`
  try {
    const model = await resolveModel(ctx, member.agent, ctx.fallbackModel)
    const body = { agent: member.agent, parts: [{ type: "text", text }], ...(model ? { model } : {}) }
    const result = unwrap(await ctx.client.session.prompt({ path: { id: sid }, body, query }))
    return {
      title: `${member.name} answered`,
      output: answerText(result) || `${member.name} did not return any text.`,
      metadata: { teammate: member.name, sessionID: sid },
    }
  } finally {
    if (toolCtx.abort) toolCtx.abort.removeEventListener("abort", abort)
  }
}

// Plain object with JSON Schema args: Kilo accepts it without the @kilocode/plugin package,
// which keeps this plugin dependency-free.
function teammateTools(ctx) {
  const team = readTeam()
  if (!team.length || !ctx.client) return undefined
  const list = team.map((m) => `- ${m.name}: ${m.description || "specialist"} (repository: ${m.repo})`).join("\n")
  return {
    ask_teammate: {
      description:
        "Ask a teammate agent that specializes in another repository, and wait for its answer. " +
        "Use it when you need knowledge about code that lives outside the current project.\n" +
        `Teammates:\n${list}`,
      args: {
        teammate: { type: "string", description: "Name of the teammate to ask" },
        question: { type: "string", description: "Self-contained question, with all the context the teammate needs" },
      },
      execute: (args, toolCtx) => askTeammate(ctx, args, toolCtx),
    },
  }
}

// ---------- profiles: team awareness, custom context, linked folders, memory ----------

let profilesCache = { mtime: -1, value: emptyProfiles() }

function emptyProfiles() {
  return { team: { context: "", folders: [], memory: [] }, agents: {} }
}

function cleanProfile(raw) {
  const p = raw && typeof raw === "object" ? raw : {}
  const folders = (Array.isArray(p.folders) ? p.folders : [])
    .map((f) => (typeof f === "string" ? { path: f } : f))
    .filter((f) => f && typeof f.path === "string" && f.path.trim())
    .slice(0, MAX_FOLDERS)
    .map((f) => ({ path: path.resolve(expandHome(f.path.trim())), note: short(f.note, 200) }))
  const memory = (Array.isArray(p.memory) ? p.memory : [])
    .filter((n) => n && typeof n.text === "string" && n.text.trim())
    .slice(-MAX_NOTES)
    .map((n) => ({ id: String(n.id || ""), text: String(n.text).slice(0, MAX_NOTE_CHARS), at: Number(n.at) || 0, by: short(n.by, 40) }))
  return { context: typeof p.context === "string" ? p.context.slice(0, MAX_CONTEXT_CHARS) : "", folders, memory }
}

function readProfiles() {
  try {
    const mtime = fs.statSync(PROFILES_FILE).mtimeMs
    if (mtime === profilesCache.mtime) return profilesCache.value
    const raw = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"))
    const agents = {}
    for (const [name, value] of Object.entries((raw && raw.agents) || {})) {
      if (/^[\w.-]{1,60}$/.test(name)) agents[name] = cleanProfile(value)
    }
    profilesCache = { mtime, value: { team: cleanProfile(raw && raw.team), agents } }
  } catch {
    profilesCache = { mtime: -1, value: emptyProfiles() }
  }
  return profilesCache.value
}

// Read-modify-write with an atomic rename, so the office and the plugin never lose each other's changes.
function updateProfiles(mutate) {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")) || {}
  } catch {}
  mutate(raw)
  fs.mkdirSync(HOME, { recursive: true })
  const tmp = `${PROFILES_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, PROFILES_FILE)
  profilesCache.mtime = -1
}

// sid -> agent, learned from Kilo hooks and events; bounded.
const sessionAgents = new Map()
function rememberAgent(sid, agent) {
  if (!sid || !agent) return
  if (!sessionAgents.has(sid) && sessionAgents.size >= 500) sessionAgents.delete(sessionAgents.keys().next().value)
  sessionAgents.set(sid, agent)
}

async function agentOf(sid, ctx) {
  if (teammateSessions.has(sid)) return teammateSessions.get(sid)
  if (sessionAgents.has(sid)) return sessionAgents.get(sid)
  if (!ctx.client) return undefined
  try {
    const list = unwrap(
      await Promise.race([
        ctx.client.session.messages({ path: { id: sid }, query: { directory: ctx.directory } }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]),
    )
    const last = (Array.isArray(list) ? list : []).map((m) => m && m.info).filter((i) => i && (i.agent || i.mode)).pop()
    const agent = last && (last.agent || last.mode)
    if (agent) rememberAgent(sid, agent)
    return agent
  } catch {
    return undefined
  }
}

function readText(file, max) {
  try {
    const fd = fs.openSync(file, "r")
    try {
      const buf = Buffer.alloc(max)
      const n = fs.readSync(fd, buf, 0, max, 0)
      return buf.subarray(0, n).toString("utf8")
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}

// What a linked folder is, in a few lines: stack, layout and the start of its instructions.
const folderCards = new Map()
function folderCard(dir) {
  const cached = folderCards.get(dir)
  if (cached && Date.now() - cached.at < FOLDER_CARD_TTL_MS) return cached.text
  let text
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith(".") || e.name === ".github")
    const names = new Set(entries.map((e) => e.name))
    const facts = []
    const goMod = names.has("go.mod") && readText(path.join(dir, "go.mod"), 4000)
    if (goMod) {
      const mod = /^module\s+(\S+)/m.exec(goMod)
      const ver = /^go\s+(\S+)/m.exec(goMod)
      facts.push(`Go module ${mod ? mod[1] : "?"}${ver ? ` (go ${ver[1]})` : ""}`)
      for (const dep of ["sigs.k8s.io/controller-runtime", "k8s.io/client-go", "github.com/operator-framework"]) {
        if (goMod.includes(dep)) facts.push(`uses ${dep}`)
      }
    }
    if (names.has("PROJECT")) {
      const project = readText(path.join(dir, "PROJECT"), 2000) || ""
      const domain = /^domain:\s*(\S+)/m.exec(project)
      facts.push(`Kubebuilder project${domain ? ` (domain ${domain[1]})` : ""}`)
    }
    const pkg = names.has("package.json") && readJsonFile(path.join(dir, "package.json"))
    if (pkg) facts.push(`Node package ${pkg.name || "?"}`)
    if (names.has("Cargo.toml")) facts.push("Rust crate")
    if (names.has("pyproject.toml") || names.has("requirements.txt")) facts.push("Python project")
    if (names.has("Chart.yaml")) facts.push("Helm chart")
    if (names.has("Dockerfile")) facts.push("Dockerfile")
    if (names.has("Makefile")) facts.push("Makefile")
    const layout = entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 30)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    const lines = []
    if (facts.length) lines.push(`Stack: ${facts.join(", ")}.`)
    lines.push(`Top level: ${layout.join(" ") || "(empty)"}`)
    const doc = ["AGENTS.md", "README.md", "readme.md"].find((n) => names.has(n))
    if (doc) {
      const excerpt = (readText(path.join(dir, doc), 1500) || "").trim()
      if (excerpt) lines.push(`${doc} (start):\n${excerpt.split("\n").map((l) => `> ${l}`).join("\n")}`)
    }
    text = lines.join("\n")
  } catch {
    text = "Not found on this machine."
  }
  folderCards.set(dir, { at: Date.now(), text })
  return text
}

function listTeam(ctx, self) {
  const roster = Array.isArray(ctx.roster) ? ctx.roster : []
  return roster.filter(
    (a) => a.name !== self && !INTERNAL_AGENTS.has(a.name) && !a.hidden && !(a.builtIn || a.native),
  )
}

// The text added to an agent's system prompt at every turn.
async function briefing(agent, ctx) {
  if (!ctx.roster) {
    try {
      await refreshRoster(ctx)
    } catch {}
  }
  const roster = Array.isArray(ctx.roster) ? ctx.roster : []
  const mates = readTeam()
  const mate = mates.find((m) => m.name === agent)
  const me = roster.find((a) => a.name === agent)
  const profiles = readProfiles()
  const own = profiles.agents[agent] || cleanProfile({})
  const team = listTeam(ctx, agent)
  const lead = me && me.mode === "primary"
  const out = ["# Team briefing (Star UI)"]
  const role = (mate && mate.description) || (me && me.description)
  out.push(`You are **${agent}**${role ? `: ${short(role, 400)}` : "."}${mate ? ` You are the expert of ${mate.repo}.` : ""}`)
  if (team.length) {
    out.push("", "## Your team", "These AI agents work with you. Each one owns its role:")
    for (const a of team) out.push(`- **${a.name}**${a.mode === "primary" ? " (lead)" : ""}: ${short(a.description, 240) || "no description"}`)
    out.push(
      "",
      lead
        ? "Delegate each part of the work to the teammate whose role fits best, with the `task` tool (`subagent_type` = its name), and give it everything it needs: it does not see this conversation."
        : "Stay within your role. When part of the work belongs to another role, say so in your answer and name the teammate who should take it; if you have the `task` tool, you may ask that teammate directly.",
    )
  }
  const others = mates.filter((m) => m.name !== agent)
  if (others.length && !mate) {
    out.push("", "## Experts of other repositories", "Ask them with the `ask_teammate` tool:")
    for (const m of others) out.push(`- **${m.name}**: ${short(m.description, 200) || "specialist"} (${m.repo})`)
  }
  if (profiles.team.context.trim()) out.push("", "## Team context", profiles.team.context.trim())
  if (own.context.trim()) out.push("", "## Your context", own.context.trim())
  const notes = [...profiles.team.memory.map((n) => ({ ...n, scope: "team" })), ...own.memory.map((n) => ({ ...n, scope: "you" }))]
  if (notes.length) {
    out.push("", "## Memory", "Notes saved in earlier conversations (newest last):")
    for (const n of notes.slice(-MAX_NOTES)) out.push(`- [${n.scope}${n.by && n.scope === "team" ? `, by ${n.by}` : ""}] ${n.text}`)
  }
  const folders = []
  for (const f of [...profiles.team.folders, ...(mate ? [] : own.folders)]) if (!folders.some((x) => x.path === f.path)) folders.push(f)
  if (folders.length) {
    out.push("", "## Linked folders", "Besides the current project, you can read these folders without asking; use absolute paths with your tools:")
    for (const f of folders) out.push("", `### ${path.basename(f.path)}: ${f.path}${f.note ? ` (${f.note})` : ""}`, folderCard(f.path))
  }
  out.push(
    "",
    "Use the `remember` tool to save a durable fact for future conversations (a decision, a convention, a pitfall): for yourself, or for the whole team. Do not save task progress.",
  )
  const text = out.join("\n")
  return text.length > MAX_BRIEFING_CHARS ? text.slice(0, MAX_BRIEFING_CHARS - 1) + "…" : text
}

// Linked folders need no approval: Kilo's own permission rules, added when Kilo starts.
function addFolderRules(target, folders) {
  if (!folders.length || !target || typeof target !== "object") return
  if (target.permission !== undefined && (typeof target.permission !== "object" || target.permission === null)) return
  const permission = target.permission || (target.permission = {})
  const current = permission.external_directory
  const rules = typeof current === "string" ? { "*": current } : current && typeof current === "object" ? { ...current } : {}
  for (const f of folders) {
    const dir = f.path.replace(/[\\/]+$/, "")
    rules[`${dir}/*`] = "allow"
    if (dir.includes("\\")) rules[`${dir.replace(/\\/g, "/")}/*`] = "allow"
  }
  permission.external_directory = rules
}

function applyFolderAccess(config) {
  if (!config || typeof config !== "object") return
  const profiles = readProfiles()
  addFolderRules(config, profiles.team.folders)
  for (const [name, profile] of Object.entries(profiles.agents)) {
    if (!profile.folders.length) continue
    if (!config.agent || typeof config.agent !== "object") config.agent = {}
    if (!config.agent[name] || typeof config.agent[name] !== "object") config.agent[name] = {}
    addFolderRules(config.agent[name], profile.folders)
  }
}

async function rememberNote(ctx, args, toolCtx) {
  toolCtx = toolCtx || {}
  const note = String((args && args.note) || "").trim()
  if (!note) return "Nothing to remember: the note is empty."
  const agent = toolCtx.agent || (toolCtx.sessionID && (await agentOf(toolCtx.sessionID, ctx))) || "agent"
  const scope = args && args.scope === "team" ? "team" : "self"
  const entry = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: note.slice(0, MAX_NOTE_CHARS), at: Date.now(), by: agent }
  updateProfiles((raw) => {
    const holder =
      scope === "team"
        ? (raw.team = raw.team && typeof raw.team === "object" ? raw.team : {})
        : ((raw.agents = raw.agents && typeof raw.agents === "object" ? raw.agents : {}),
          (raw.agents[agent] = raw.agents[agent] && typeof raw.agents[agent] === "object" ? raw.agents[agent] : {}))
    holder.memory = [...(Array.isArray(holder.memory) ? holder.memory : []), entry].slice(-MAX_NOTES)
  })
  return scope === "team" ? "Saved in the team memory." : `Saved in the memory of ${agent}.`
}

function memoryTools(ctx) {
  return {
    remember: {
      description:
        "Save a short, durable note that will be part of your briefing in future conversations: a decision, a convention, a pitfall to avoid. " +
        'Use scope "team" when every teammate should know it. Do not save task progress or temporary state.',
      args: {
        note: { type: "string", description: "The fact to remember, self-contained, in one or two sentences" },
        scope: { type: "string", enum: ["self", "team"], description: 'Who needs it: "self" (default) or "team"' },
      },
      execute: (args, toolCtx) => rememberNote(ctx, args, toolCtx),
    },
  }
}

async function pollBridge(bridge, ctx) {
  const payload = await bridgeRequest(
    bridge,
    "GET",
    `/v1/commands?pid=${process.pid}&dir=${encodeURIComponent(ctx.directory)}`,
    undefined,
    POLL_TIMEOUT_MS + 5000,
    ctx.abort.signal,
  )
  const commands = Array.isArray(payload && payload.commands) ? payload.commands : []
  if (!commands.length) return
  const results = []
  for (const cmd of commands) {
    try {
      const result = await runCommand(cmd, ctx)
      if (result) results.push(result)
    } catch (err) {
      results.push({ id: cmd && cmd.id, ok: false, error: short(err && err.message, 200) || "failed" })
    }
  }
  await bridgeRequest(bridge, "POST", "/v1/results", { results }, 3000)
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer && typeof timer.unref === "function") timer.unref()
    if (signal) signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
  })

// One long-poll loop per bridge (VS Code window), started lazily and stopped on dispose.
function startCommandLoops(ctx) {
  const running = new Set()
  const tick = async () => {
    while (!ctx.abort.signal.aborted) {
      try {
        for (const bridge of readRegistry()) {
          if (running.has(bridge.key)) continue
          running.add(bridge.key)
          void (async () => {
            let failures = 0
            while (!ctx.abort.signal.aborted && failures < 3) {
              try {
                await pollBridge(bridge, ctx)
                failures = 0
              } catch {
                failures++
                await sleep(2000, ctx.abort.signal)
              }
            }
            running.delete(bridge.key)
          })()
        }
      } catch {}
      await sleep(REGISTRY_TTL_MS, ctx.abort.signal)
    }
  }
  void tick()
}

export const StarUiKiloPlugin = async (input) => {
  const ctx = {
    directory: (input && (input.directory || input.worktree)) || process.cwd(),
    client: input && input.client,
    abort: new AbortController(),
  }
  const hello = () => {
    const ev = { t: "hello", version: VERSION, project: path.basename(ctx.directory), client: CLIENT, commands: !!ctx.client }
    push(ev, ctx)
    hellos.set(ctx.directory, ev)
  }
  try {
    hello()
    const beat = setInterval(() => {
      try {
        if (readRegistry().length) hello()
      } catch {}
    }, HEARTBEAT_MS)
    if (beat && typeof beat.unref === "function") beat.unref()
    ctx.abort.signal.addEventListener("abort", () => clearInterval(beat), { once: true })
    if (ctx.client) {
      // Wait for Kilo to finish booting before calling back into its API.
      void (async () => {
        await sleep(2000, ctx.abort.signal)
        while (!ctx.abort.signal.aborted) {
          try {
            await refreshRoster(ctx)
          } catch {}
          await sleep(ROSTER_REFRESH_MS, ctx.abort.signal)
        }
      })()
      startCommandLoops(ctx)
    }
  } catch {}
  let tools
  try {
    tools = { ...memoryTools(ctx), ...(teammateTools(ctx) || {}) }
  } catch {}
  return {
    ...(tools ? { tool: tools } : {}),
    config: async (config) => {
      try {
        applyFolderAccess(config)
      } catch {}
    },
    "chat.message": async (input) => {
      try {
        if (input && input.sessionID && input.agent) rememberAgent(input.sessionID, input.agent)
      } catch {}
    },
    "chat.params": async (input) => {
      try {
        if (input && input.sessionID && input.agent) rememberAgent(input.sessionID, String(input.agent))
      } catch {}
    },
    "experimental.chat.system.transform": async (input, output) => {
      try {
        const sid = input && input.sessionID
        if (!sid || !output || !Array.isArray(output.system)) return
        const agent = await agentOf(sid, ctx)
        if (!agent || INTERNAL_AGENTS.has(agent)) return
        output.system.push(await briefing(agent, ctx))
      } catch {}
    },
    event: async ({ event }) => {
      try {
        handle(event, ctx)
      } catch {}
    },
    dispose: async () => {
      try {
        ctx.abort.abort()
      } catch {}
    },
  }
}

// Internals exposed for the extension's test-suite. Not a function export, so Kilo ignores it.
StarUiKiloPlugin.__test = { askTeammate, readTeam, runCommand, resolveModel, transcript, briefing, applyFolderAccess, rememberNote, readProfiles }
