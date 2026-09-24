import { isAbortError, toolState } from "./mapping"
import type {
  AgentDetail,
  BridgeEvent,
  BridgeSource,
  CharacterView,
  ConnectionInfo,
  LogEntry,
  MeetingView,
  OfficeSnapshot,
  OfficeState,
  RosterAgent,
  SessionStatus,
} from "./protocol"

interface ActiveTool {
  tool: string
  hint?: string
  startedAt: number
}

interface SessionRecord {
  id: string
  parentID?: string
  title?: string
  agent?: string
  teammate?: string
  dir?: string
  status: SessionStatus | "unknown"
  statusMessage?: string
  tools: Map<string, ActiveTool>
  seenCalls: Set<string>
  compacting: boolean
  error?: { name?: string; message?: string; at: number }
  asks: Map<string, { kind: "permission" | "question"; label?: string }>
  updatedAt: number
  idleSince?: number
}

/** A running Kilo server with our plugin loaded (one per project directory). */
export interface PluginInstance {
  key: string
  pid?: number
  parentPid?: number
  dir?: string
  client?: string
  commands: boolean
  lastSeen: number
}

export interface OfficeOptions {
  /** How long a finished session keeps its agent "at work" before it goes back to the lounge. */
  lingerMs: number
  /** Sessions untouched for longer than this are forgotten. */
  forgetMs: number
  /** How long an error keeps an agent in the bug zone without new activity. */
  errorMs: number
  /** A plugin instance is considered connected if it said hello within this window. */
  instanceTtlMs: number
  maxGuests: number
  maxLog: number
  showBuiltInAgents: boolean
  /** Decides whether events from a given source/directory belong to this VS Code window. */
  accept: (source: BridgeSource | undefined, dir: string | undefined) => boolean
}

export const DEFAULT_OPTIONS: OfficeOptions = {
  lingerMs: 20_000,
  forgetMs: 30 * 60_000,
  errorMs: 120_000,
  instanceTtlMs: 90_000,
  maxGuests: 8,
  maxLog: 60,
  showBuiltInAgents: true,
  accept: () => true,
}

// Internal agents Kilo uses for housekeeping; never shown as team members.
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"])
const MAX_PAST_MEETINGS = 20

export interface MeetingSession {
  sessionID: string
  dir?: string
  speaker: string
}
const SUBAGENT_SUFFIX = /\s*\(@([\w-]+) subagent\)\s*$/

export class OfficeModel {
  private readonly sessions = new Map<string, SessionRecord>()
  /** Finished meetings whose sessions were forgotten, kept so they can still be read. */
  private readonly archive = new Map<string, { view: MeetingView; sessions: MeetingSession[] }>()
  private readonly rejected = new Set<string>()
  private readonly roster = new Map<string, RosterAgent>()
  private readonly instances = new Map<string, PluginInstance>()
  private log: LogEntry[] = []
  private mainSession: string | null = null
  lastEventAt?: number
  opts: OfficeOptions

  constructor(opts: Partial<OfficeOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts }
  }

  clear(): void {
    this.sessions.clear()
    this.rejected.clear()
    this.roster.clear()
    this.instances.clear()
    this.log = []
    this.mainSession = null
    this.lastEventAt = undefined
  }

  /** Applies one plugin event. Returns true when the visible office may have changed. */
  apply(ev: BridgeEvent, now = Date.now(), source?: BridgeSource): boolean {
    if (!this.opts.accept(source, ev.dir)) {
      if ("sid" in ev && ev.sid) this.rejected.add(ev.sid)
      return false
    }
    this.lastEventAt = now

    if (ev.t === "hello") {
      const key = instanceKey(source?.pid, ev.dir)
      const prev = this.instances.get(key)
      this.instances.set(key, {
        key,
        pid: source?.pid,
        parentPid: source?.parentPid,
        dir: ev.dir,
        client: ev.client,
        commands: !!ev.commands,
        lastSeen: now,
      })
      return !prev
    }
    if (ev.t === "roster") {
      let changed = false
      for (const agent of ev.agents) {
        if (!agent || !agent.name) continue
        const prev = this.roster.get(agent.name)
        if (!prev || JSON.stringify(prev) !== JSON.stringify(agent)) changed = true
        this.roster.set(agent.name, agent)
      }
      return changed
    }
    if (ev.t === "error" && !ev.sid) {
      if (isAbortError(ev.name)) return false
      this.pushLog({ ts: now, kind: "error", message: ev.message ?? ev.name })
      return true
    }

    const sid = ev.sid as string
    if (this.rejected.has(sid)) return false
    if (ev.t === "session.deleted") {
      if (this.mainSession === sid) this.mainSession = null
      return this.sessions.delete(sid)
    }

    const rec = this.ensure(sid, now, ev.dir)
    rec.updatedAt = now

    switch (ev.t) {
      case "session": {
        const isNewSub = !rec.parentID && !!ev.parentID
        if (ev.parentID) rec.parentID = ev.parentID
        if (ev.title) {
          const match = ev.title.match(SUBAGENT_SUFFIX)
          rec.title = match ? ev.title.replace(SUBAGENT_SUFFIX, "") : ev.title
          if (match && !rec.agent) rec.agent = match[1]
        }
        if (ev.agent) rec.agent = ev.agent
        if (ev.teammate) rec.teammate = ev.teammate
        if (isNewSub) this.pushLog({ ts: now, kind: "joined", agent: this.agentOf(rec), title: rec.title })
        return true
      }
      case "agent":
        rec.agent = ev.agent
        return true
      case "status": {
        const wasBusy = rec.status === "busy" || rec.status === "retry"
        rec.status = ev.status
        rec.statusMessage = ev.message
        if (ev.status === "busy") {
          rec.idleSince = undefined
        } else if (ev.status === "idle") {
          rec.idleSince = now
          rec.tools.clear()
          rec.compacting = false
          rec.asks.clear()
          if (wasBusy && !rec.error) this.pushLog({ ts: now, kind: "done", agent: this.agentOf(rec), title: rec.title })
        }
        return true
      }
      case "tool": {
        if (ev.status === "pending" || ev.status === "running") {
          const existing = rec.tools.get(ev.callID)
          rec.tools.set(ev.callID, {
            tool: ev.tool,
            hint: ev.hint ?? existing?.hint,
            startedAt: existing?.startedAt ?? now,
          })
          this.markBusy(rec)
          if (!rec.seenCalls.has(ev.callID)) {
            rec.seenCalls.add(ev.callID)
            if (rec.seenCalls.size > 200) rec.seenCalls.delete(rec.seenCalls.values().next().value as string)
            this.pushLog({ ts: now, kind: "tool", agent: this.agentOf(rec), tool: ev.tool, hint: ev.hint })
          }
        } else {
          rec.tools.delete(ev.callID)
        }
        return true
      }
      case "thinking":
        this.markBusy(rec)
        return true
      case "ask":
        rec.asks.set(ev.rid, { kind: ev.kind, label: ev.label })
        this.pushLog({ ts: now, kind: "waiting", agent: this.agentOf(rec), tool: ev.label, hint: ev.kind })
        return true
      case "answered":
        return rec.asks.delete(ev.rid)
      case "error":
        if (isAbortError(ev.name)) {
          rec.error = undefined
          return true
        }
        rec.error = { name: ev.name, message: ev.message, at: now }
        this.pushLog({ ts: now, kind: "error", agent: this.agentOf(rec), message: ev.message ?? ev.name })
        return true
      case "compaction":
        rec.compacting = ev.phase === "start"
        return true
    }
    return false
  }

  /** Records that the user prompted an agent from the office. */
  notePrompt(agent: string, text: string, now = Date.now()): void {
    this.pushLog({ ts: now, kind: "prompted", agent, message: text.length > 80 ? text.slice(0, 79) + "…" : text })
  }

  /** Forgets sessions that are long gone. Returns true if anything was removed. */
  prune(now = Date.now()): boolean {
    let changed = false
    const doomed = [...this.sessions.values()].filter(
      (rec) => rec.id !== this.mainSession && !this.isBusy(rec) && !rec.asks.size && now - rec.updatedAt > this.opts.forgetMs,
    )
    // Finished meetings stay readable after their sessions are forgotten.
    if (doomed.length) this.archiveMeetings(new Set(doomed.map((rec) => this.rootOf(rec) ?? rec.id)))
    for (const rec of doomed) {
      this.sessions.delete(rec.id)
      changed = true
    }
    for (const [key, inst] of this.instances) {
      if (now - inst.lastSeen > this.opts.instanceTtlMs * 4) {
        this.instances.delete(key)
        changed = true
      }
    }
    return changed
  }

  /** Live plugin instances, best candidates first, for sending prompts. */
  liveInstances(preferDir?: string, ownPid?: number, now = Date.now()): PluginInstance[] {
    const live = [...this.instances.values()].filter((i) => i.commands && now - i.lastSeen < this.opts.instanceTtlMs)
    const score = (i: PluginInstance) =>
      (preferDir && i.dir === preferDir ? 8 : 0) +
      (ownPid && i.parentPid === ownPid ? 4 : 0) +
      (i.client === "vscode" ? 2 : 0)
    return live.sort((a, b) => score(b) - score(a) || b.lastSeen - a.lastSeen)
  }

  /** Sessions of a meeting (root first), with the character who works in each. */
  meetingSessions(rootID: string): MeetingSession[] {
    const fallback = this.defaultAgent()
    const out: MeetingSession[] = []
    for (const rec of this.sessions.values()) {
      if (rec.id === rootID || this.rootOf(rec) === rootID) {
        out.push({ sessionID: rec.id, dir: rec.dir, speaker: rec.teammate ?? rec.agent ?? fallback })
      }
    }
    if (!out.length) return this.archive.get(rootID)?.sessions ?? []
    return out.sort((a, b) => Number(b.sessionID === rootID) - Number(a.sessionID === rootID))
  }

  /** Running sessions of a meeting, the root session included. */
  busySessionsOfMeeting(rootID: string): { sessionID: string; dir?: string }[] {
    return this.meetingSessions(rootID)
      .filter((s) => {
        const rec = this.sessions.get(s.sessionID)
        return !!rec && this.isBusy(rec)
      })
      .map(({ sessionID, dir }) => ({ sessionID, dir }))
  }

  /** Running sessions of one character (or of everyone), sub-agent sessions included. */
  busySessions(name?: string): { sessionID: string; dir?: string }[] {
    const fallback = this.defaultAgent()
    const nameOf = (rec: SessionRecord) => rec.teammate ?? rec.agent ?? fallback
    const busy = [...this.sessions.values()].filter((r) => this.isBusy(r))
    const picked = name === undefined ? busy : busy.filter((r) => nameOf(r) === name)
    // Stopping a session also stops the sub-agents it started.
    const ids = new Set(picked.map((r) => r.id))
    for (const r of busy) if (r.parentID && ids.has(r.parentID)) ids.add(r.id)
    return [...ids].map((id) => ({ sessionID: id, dir: this.sessions.get(id)?.dir }))
  }

  getCharacter(name: string, now = Date.now()): CharacterView | undefined {
    const snap = this.snapshot(
      { pluginInstalled: true, kiloDetected: true, live: true, canPrompt: true, demo: false },
      now,
    )
    return [snap.main, ...snap.guests].find((c) => c?.name === name) ?? undefined
  }

  snapshot(connection: ConnectionInfo, now = Date.now()): OfficeSnapshot {
    const fallback = this.defaultAgent()
    const byAgent = new Map<string, SessionRecord[]>()
    const add = (name: string, rec?: SessionRecord) => {
      if (!byAgent.has(name)) byAgent.set(name, [])
      if (rec) byAgent.get(name)!.push(rec)
    }

    for (const agent of this.roster.values()) {
      if (agent.hidden || INTERNAL_AGENTS.has(agent.name)) continue
      if (agent.builtIn && !this.opts.showBuiltInAgents && agent.name !== fallback) continue
      add(agent.name)
    }
    for (const rec of this.sessions.values()) {
      const name = rec.teammate ?? rec.agent ?? fallback
      if (INTERNAL_AGENTS.has(name)) continue
      add(name, rec)
    }

    const mainRec = this.pickMainSession()
    const mainName = mainRec ? (mainRec.teammate ?? mainRec.agent ?? fallback) : byAgent.has(fallback) ? fallback : undefined

    const characters: CharacterView[] = []
    for (const [name, recs] of byAgent) {
      const known = this.roster.has(name)
      const char = this.character(name, recs, now)
      // Agents that are not part of the roster only appear while they are doing something.
      if (!known && name !== mainName && !char.busy && !char.waiting && char.state !== "error") {
        const last = recs.reduce((m, r) => Math.max(m, r.idleSince ?? r.updatedAt), 0)
        if (now - last > this.opts.lingerMs) continue
      }
      characters.push(char)
    }

    const main = characters.find((c) => c.name === mainName) ?? null
    const guests = characters
      .filter((c) => c !== main)
      .sort(
        (a, b) =>
          Number(b.busy) - Number(a.busy) ||
          Number(!!b.waiting) - Number(!!a.waiting) ||
          Number(!b.builtIn) - Number(!a.builtIn) ||
          b.updatedAt - a.updatedAt ||
          a.name.localeCompare(b.name),
      )
      .slice(0, this.opts.maxGuests)

    const meetings = this.meetings()
    const past = new Map(meetings.filter((m) => !m.busy).map((m) => [m.id, m]))
    for (const [id, archived] of this.archive) if (!past.has(id) && !meetings.some((m) => m.id === id)) past.set(id, archived.view)
    return {
      main,
      guests,
      meetings: meetings.filter((m) => m.busy),
      pastMeetings: [...past.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PAST_MEETINGS),
      log: this.log.slice(-this.opts.maxLog),
      connection: {
        ...connection,
        lastEventAt: this.lastEventAt,
        canPrompt: connection.canPrompt || this.liveInstances(undefined, undefined, now).length > 0,
      },
    }
  }

  private character(name: string, recs: SessionRecord[], now: number): CharacterView {
    const info = this.roster.get(name)
    const rank = (r: SessionRecord) =>
      (r.asks.size ? 8 : 0) + (r.error && now - r.error.at < this.opts.errorMs ? 4 : 0) + (this.isBusy(r) ? 2 : 0)
    const focus = [...recs].sort((a, b) => rank(b) - rank(a) || b.updatedAt - a.updatedAt)[0]
    const base = {
      name,
      displayName: info?.displayName,
      description: info?.description,
      mode: info?.mode,
      color: info?.color,
      builtIn: info?.builtIn,
      teammate: info?.teammate,
      repo: info?.repo,
    }
    if (!focus) {
      return { ...base, state: "idle", detail: { kind: "idle" }, busy: false, activeSessions: 0, isSubagent: false, updatedAt: 0 }
    }
    let [state, detail] = this.derive(focus, now)
    // A finished session keeps its agent at the desk for a moment before the lounge.
    if (state === "idle" && focus.idleSince && now - focus.idleSince < this.opts.lingerMs) state = "writing"
    const ask = focus.asks.values().next().value as CharacterView["waiting"] | undefined
    return {
      ...base,
      state,
      detail: ask ? { kind: "waiting", tool: ask.label, hint: ask.kind } : detail,
      waiting: ask,
      busy: recs.some((r) => this.isBusy(r)),
      activeSessions: recs.filter((r) => this.isBusy(r)).length,
      sessionID: focus.id,
      sessionTitle: focus.title,
      sessionDir: focus.dir,
      isSubagent: !!focus.parentID,
      meetingID: this.meetingOf(focus),
      updatedAt: focus.updatedAt,
    }
  }

  /** Root of the meeting a session belongs to: its root, or itself when it started sub-agents. */
  private meetingOf(rec: SessionRecord): string | undefined {
    const root = this.rootOf(rec)
    if (root) return root
    for (const other of this.sessions.values()) if (other.parentID === rec.id) return rec.id
    return undefined
  }

  private rootOf(rec: SessionRecord): string | undefined {
    let cur: SessionRecord | undefined = rec
    const seen = new Set<string>()
    while (cur?.parentID && !seen.has(cur.id)) {
      seen.add(cur.id)
      const parent = this.sessions.get(cur.parentID)
      if (!parent) return cur.parentID
      cur = parent
    }
    return cur && cur !== rec ? cur.id : undefined
  }

  /** Every conversation tree of the known sessions: a root and the sub-agents it started. */
  private meetings(): MeetingView[] {
    const fallback = this.defaultAgent()
    const groups = new Map<string, SessionRecord[]>()
    for (const rec of this.sessions.values()) {
      const root = this.rootOf(rec)
      if (!root) continue
      if (!groups.has(root)) groups.set(root, [])
      groups.get(root)!.push(rec)
    }
    const out: MeetingView[] = []
    for (const [rootID, children] of groups) {
      const root = this.sessions.get(rootID)
      const all = root ? [root, ...children] : children
      const busy = all.some((r) => this.isBusy(r) || r.asks.size > 0)
      const updatedAt = Math.max(...all.map((r) => r.updatedAt))
      const members: string[] = []
      for (const r of all) {
        const name = r.teammate ?? r.agent ?? fallback
        if (!members.includes(name)) members.push(name)
      }
      out.push({ id: rootID, title: root?.title ?? children[0]?.title, members, busy, updatedAt })
    }
    return out.sort((a, b) => Number(b.busy) - Number(a.busy) || b.updatedAt - a.updatedAt)
  }

  private archiveMeetings(roots: Set<string>): void {
    for (const view of this.meetings()) {
      if (view.busy || !roots.has(view.id)) continue
      this.archive.set(view.id, { view, sessions: this.meetingSessions(view.id) })
    }
    const extra = [...this.archive.values()].sort((a, b) => b.view.updatedAt - a.view.updatedAt).slice(MAX_PAST_MEETINGS)
    for (const old of extra) this.archive.delete(old.view.id)
  }

  private defaultAgent(): string {
    if (this.roster.has("code")) return "code"
    for (const agent of this.roster.values()) {
      if (agent.mode !== "subagent" && !agent.hidden && !INTERNAL_AGENTS.has(agent.name)) return agent.name
    }
    return "code"
  }

  private ensure(sid: string, now: number, dir?: string): SessionRecord {
    let rec = this.sessions.get(sid)
    if (!rec) {
      rec = {
        id: sid,
        dir,
        status: "unknown",
        tools: new Map(),
        seenCalls: new Set(),
        compacting: false,
        asks: new Map(),
        updatedAt: now,
      }
      this.sessions.set(sid, rec)
    }
    if (dir && !rec.dir) rec.dir = dir
    return rec
  }

  private markBusy(rec: SessionRecord): void {
    rec.error = undefined
    rec.idleSince = undefined
    if (rec.status !== "busy" && rec.status !== "retry") rec.status = "busy"
  }

  private isBusy(rec: SessionRecord): boolean {
    return rec.status === "busy" || rec.status === "retry" || rec.tools.size > 0
  }

  private pickMainSession(): SessionRecord | null {
    // Teammate sessions are consultations started by another agent: never the main character.
    const roots = [...this.sessions.values()].filter((r) => !r.parentID && !r.teammate)
    if (!roots.length) {
      this.mainSession = null
      return null
    }
    const current = this.mainSession ? this.sessions.get(this.mainSession) : undefined
    if (current && !current.parentID) {
      const otherBusy = roots.some((r) => r !== current && this.isBusy(r))
      if (this.isBusy(current) || current.asks.size || !otherBusy) return current
    }
    roots.sort((a, b) => Number(this.isBusy(b)) - Number(this.isBusy(a)) || b.updatedAt - a.updatedAt)
    this.mainSession = roots[0].id
    return roots[0]
  }

  private derive(rec: SessionRecord, now: number): [OfficeState, AgentDetail] {
    if (rec.error && now - rec.error.at < this.opts.errorMs) {
      return ["error", { kind: "error", message: rec.error.message ?? rec.error.name }]
    }
    if (rec.compacting) return ["syncing", { kind: "compaction" }]
    if (rec.status === "retry") return ["syncing", { kind: "retry", message: rec.statusMessage }]
    if (rec.status === "offline") return ["syncing", { kind: "offline", message: rec.statusMessage }]
    let latest: ActiveTool | undefined
    for (const tool of rec.tools.values()) if (!latest || tool.startedAt >= latest.startedAt) latest = tool
    if (latest) return [toolState(latest.tool), { kind: "tool", tool: latest.tool, hint: latest.hint }]
    if (rec.status === "busy") return ["writing", { kind: "thinking" }]
    return ["idle", { kind: "idle" }]
  }

  private agentOf(rec: SessionRecord): string {
    return rec.teammate ?? rec.agent ?? this.defaultAgent()
  }

  private pushLog(entry: LogEntry): void {
    this.log.push(entry)
    if (this.log.length > this.opts.maxLog * 2) this.log = this.log.slice(-this.opts.maxLog)
  }
}

export function instanceKey(pid: number | undefined, dir: string | undefined): string {
  return `${pid ?? "?"}|${dir ?? ""}`
}
