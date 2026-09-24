// star-ui-kilo-plugin v0.1.4
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
//      other repositories, so an agent can consult another repo's agent and get its answer.
//
// - Traffic only goes to 127.0.0.1, to bridges registered in ~/.star-ui-kilo/bridges/.
// - No file contents, model outputs or credentials are ever sent to the panel.
// - Every error is swallowed: this plugin must never break Kilo.
// - Safe to delete at any time (or run "Star UI: Disconnect from Kilo" in VS Code).

import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

const VERSION = "0.1.4"
const HOME = process.env.STAR_UI_KILO_HOME || path.join(os.homedir(), ".star-ui-kilo")
const REGISTRY_DIR = path.join(HOME, "bridges")
const TEAM_FILE = path.join(HOME, "team.json")
const FLUSH_MS = 120
const REGISTRY_TTL_MS = 3000
const HEARTBEAT_MS = 30000
const THINKING_THROTTLE_MS = 1500
const MAX_QUEUE = 500
const MAX_CACHED_SESSIONS = 60
const ROSTER_REFRESH_MS = 60000
const POLL_TIMEOUT_MS = 25000
const MAX_PROMPT_CHARS = 20000
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
    tools = teammateTools(ctx)
  } catch {}
  return {
    ...(tools ? { tool: tools } : {}),
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
StarUiKiloPlugin.__test = { askTeammate, readTeam, runCommand, resolveModel, transcript }
