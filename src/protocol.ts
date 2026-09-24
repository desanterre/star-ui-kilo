// Wire format between the Kilo plugin (plugin/star-ui-kilo.js), the extension and the webview.
// The plugin only sends short metadata: never file contents, prompts or model output.

export type OfficeState = "idle" | "writing" | "researching" | "executing" | "syncing" | "error"

export type SessionStatus = "busy" | "idle" | "retry" | "offline"
export type ToolStatus = "pending" | "running" | "completed" | "error"
export type AgentMode = "primary" | "subagent" | "all"

export interface RosterAgent {
  name: string
  displayName?: string
  description?: string
  mode: AgentMode
  color?: string
  builtIn?: boolean
  hidden?: boolean
  /** Cross-repo specialist declared in ~/.star-ui-kilo/team.json. */
  teammate?: boolean
  repo?: string
}

interface Base {
  ts?: number
  dir?: string
}

export type BridgeEvent = Base &
  (
    | { t: "hello"; version: string; project?: string; client?: string; commands?: boolean }
    | { t: "roster"; agents: RosterAgent[] }
    | { t: "session"; sid: string; parentID?: string; title?: string; agent?: string; teammate?: string }
    | { t: "session.deleted"; sid: string }
    | { t: "status"; sid: string; status: SessionStatus; message?: string }
    | { t: "tool"; sid: string; callID: string; tool: string; status: ToolStatus; hint?: string; error?: string }
    | { t: "thinking"; sid: string; kind: "text" | "reasoning" }
    | { t: "agent"; sid: string; agent: string }
    | { t: "ask"; sid: string; rid: string; kind: "permission" | "question"; label?: string }
    | { t: "answered"; sid: string; rid: string }
    | { t: "error"; sid?: string; name?: string; message?: string }
    | { t: "compaction"; sid: string; phase: "start" | "end" }
  )

export interface BridgeSource {
  plugin?: string
  pid?: number
  /** KILO_PARENT_PID: the VS Code extension host that spawned this Kilo server, if any. */
  parentPid?: number
}

export interface BridgePayload {
  source?: BridgeSource
  events: BridgeEvent[]
}

/** Extension -> plugin, delivered through the plugin's long-poll on the bridge. */
export type PluginCommand =
  | {
      id: string
      kind: "prompt"
      agent: string
      /** "subagent" agents are started as a sub-task of a new session. */
      mode: AgentMode
      text: string
      /** Continue this session instead of creating a new one. */
      sessionID?: string
      /** Kilo Code's default model settings, used when nothing more specific is set. */
      model?: { providerID: string; modelID: string }
    }
  | { id: string; kind: "roster" }
  | { id: string; kind: "abort"; sessions: { sessionID: string; dir?: string }[] }
  | { id: string; kind: "messages"; sessionID: string; dir?: string }

export interface PluginResult {
  id: string
  ok: boolean
  sessionID?: string
  error?: string
  /** Transcript for "messages" commands. */
  data?: TranscriptMessage[]
}

/** A conversation as shown in the office chat (texts are truncated by the plugin). */
export interface TranscriptPart {
  type: "text" | "reasoning" | "tool" | "file" | "subtask"
  text?: string
  tool?: string
  status?: string
  title?: string
  error?: string
}

/** What the office chat shows: one character's conversation, or a whole meeting. */
export type ChatTarget = { kind: "agent"; name: string } | { kind: "meeting"; id: string }

export interface TranscriptMessage {
  id: string
  role: "user" | "assistant"
  /** Character who wrote it; for a brief sent to a sub-agent, the character who delegated. */
  speaker?: string
  /** Addressee of a brief sent to a sub-agent. */
  to?: string
  agent?: string
  time?: number
  error?: string
  parts: TranscriptPart[]
}

export type DetailKind = "idle" | "thinking" | "tool" | "retry" | "error" | "compaction" | "waiting" | "offline"

export interface AgentDetail {
  kind: DetailKind
  tool?: string
  hint?: string
  message?: string
}

/** One character in the office = one Kilo agent (code, plan, explore, your custom team...). */
export interface CharacterView {
  name: string
  displayName?: string
  description?: string
  mode?: AgentMode
  color?: string
  builtIn?: boolean
  teammate?: boolean
  repo?: string
  state: OfficeState
  detail: AgentDetail
  waiting?: { kind: "permission" | "question"; label?: string }
  busy: boolean
  /** Number of sessions currently running with this agent. */
  activeSessions: number
  /** Most relevant session for this agent (running, waiting, or last one). */
  sessionID?: string
  sessionTitle?: string
  sessionDir?: string
  isSubagent: boolean
  /** Root session of the conversation this character takes part in, when others take part too. */
  meetingID?: string
  updatedAt: number
}

/** A conversation where several agents work together: a root session and the sub-agents it started. */
export interface MeetingView {
  id: string
  title?: string
  /** Character names, the agent of the root session first. */
  members: string[]
  busy: boolean
  updatedAt: number
}

export type LogKind = "joined" | "tool" | "done" | "error" | "waiting" | "prompted"

export interface LogEntry {
  ts: number
  kind: LogKind
  agent?: string
  title?: string
  tool?: string
  hint?: string
  message?: string
}

export interface ConnectionInfo {
  pluginInstalled: boolean
  kiloDetected: boolean
  /** Version of Kilo Code when it predates the plugin engine (7.0), which Star UI needs. */
  kiloLegacyVersion?: string
  live: boolean
  canPrompt: boolean
  lastEventAt?: number
  demo: boolean
}

export interface OfficeSnapshot {
  main: CharacterView | null
  guests: CharacterView[]
  meetings: MeetingView[]
  log: LogEntry[]
  connection: ConnectionInfo
}

export interface WebviewSettings {
  language: string
  officeName: string
  room: "office" | "lodge"
}

export type ToWebview =
  | { type: "init"; settings: WebviewSettings; snapshot: OfficeSnapshot }
  | { type: "snapshot"; snapshot: OfficeSnapshot }
  | { type: "settings"; settings: WebviewSettings }
  | { type: "promptResult"; requestId: string; ok: boolean; error?: string; sessionID?: string }
  | {
      type: "transcript"
      requestId: string
      target: ChatTarget
      sessionID?: string
      messages?: TranscriptMessage[]
      error?: string
    }

export type WebviewCommand =
  | "connect"
  | "disconnect"
  | "toggleDemo"
  | "openKilo"
  | "openSettings"
  | "createTeam"

export type FromWebview =
  | { type: "ready" }
  | { type: "command"; command: WebviewCommand }
  | { type: "prompt"; requestId: string; agent: string; text: string; continueSession: boolean }
  | { type: "meetingPrompt"; requestId: string; meetingID: string; text: string; stopFirst: boolean }
  | { type: "openSession"; agent: string }
  | { type: "stop"; agent?: string; meetingID?: string }
  | { type: "transcript"; requestId: string; target: ChatTarget }
  | { type: "log"; level: "info" | "error"; message: string }
