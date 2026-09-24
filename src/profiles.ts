import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { AgentProfile, MemoryNote, ProfileTarget } from "./protocol"

// ~/.star-ui-kilo/profiles.json: what every agent is told at each turn (see the Kilo plugin).
// The plugin appends notes saved with the `remember` tool to the same file.

export const MAX_CONTEXT_CHARS = 8000
export const MAX_FOLDERS = 20

interface ProfilesFile {
  team?: RawProfile
  agents?: Record<string, RawProfile>
  [key: string]: unknown
}

interface RawProfile {
  context?: unknown
  folders?: unknown
  memory?: unknown
  [key: string]: unknown
}

export function profilesFile(home: string): string {
  return path.join(home, "profiles.json")
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p
}

function readRaw(file: string): ProfilesFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function normalize(raw: RawProfile | undefined): AgentProfile {
  const context = typeof raw?.context === "string" ? raw.context.slice(0, MAX_CONTEXT_CHARS) : ""
  const folders = (Array.isArray(raw?.folders) ? raw!.folders : [])
    .map((f: unknown) => (typeof f === "string" ? { path: f } : (f as { path?: unknown; note?: unknown })))
    .filter((f): f is { path: string; note?: unknown } => !!f && typeof f.path === "string" && !!f.path.trim())
    .slice(0, MAX_FOLDERS)
    .map((f) => ({ path: path.resolve(expandHome(f.path.trim())), note: typeof f.note === "string" && f.note ? f.note.slice(0, 200) : undefined }))
  const memory: MemoryNote[] = (Array.isArray(raw?.memory) ? raw!.memory : [])
    .filter((n: unknown): n is { id?: unknown; text: string; at?: unknown; by?: unknown } => !!n && typeof (n as { text?: unknown }).text === "string")
    .map((n) => ({ id: String(n.id ?? ""), text: n.text, at: Number(n.at) || 0, by: typeof n.by === "string" ? n.by : undefined }))
  return { context, folders, memory }
}

function holderOf(raw: ProfilesFile, target: ProfileTarget, create: boolean): RawProfile | undefined {
  if (target.kind === "team") {
    if (!raw.team || typeof raw.team !== "object") {
      if (!create) return undefined
      raw.team = {}
    }
    return raw.team
  }
  if (!/^[\w.-]{1,60}$/.test(target.name)) throw new Error(`Invalid agent name: ${target.name}`)
  if (!raw.agents || typeof raw.agents !== "object") {
    if (!create) return undefined
    raw.agents = {}
  }
  if (!raw.agents[target.name] || typeof raw.agents[target.name] !== "object") {
    if (!create) return undefined
    raw.agents[target.name] = {}
  }
  return raw.agents[target.name]
}

export function readProfile(file: string, target: ProfileTarget): AgentProfile {
  return normalize(holderOf(readRaw(file), target, false))
}

function write(file: string, raw: ProfilesFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Saves the context and folders of one profile; notes and the other profiles are kept as they are. */
export function saveProfile(
  file: string,
  target: ProfileTarget,
  update: { context: string; folders: { path: string; note?: string }[] },
): { foldersChanged: boolean } {
  const raw = readRaw(file)
  const before = normalize(holderOf(raw, target, false))
  const holder = holderOf(raw, target, true)!
  const next = normalize({ context: update.context, folders: update.folders })
  holder.context = next.context
  holder.folders = next.folders.map((f) => (f.note ? { path: f.path, note: f.note } : { path: f.path }))
  write(file, raw)
  const key = (p: AgentProfile) => JSON.stringify(p.folders.map((f) => f.path).sort())
  return { foldersChanged: key(before) !== key(next) }
}

export function forgetNote(file: string, target: ProfileTarget, id: string): void {
  const raw = readRaw(file)
  const holder = holderOf(raw, target, false)
  if (!holder || !Array.isArray(holder.memory)) return
  holder.memory = holder.memory.filter((n: unknown) => String((n as { id?: unknown })?.id ?? "") !== id)
  write(file, raw)
}
