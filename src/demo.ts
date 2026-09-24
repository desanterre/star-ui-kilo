import type { BridgeEvent, RosterAgent, TranscriptMessage } from "./protocol"

type Emit = (ev: BridgeEvent) => void
type Step = [delayMs: number, run: () => void]

export const DEMO_ROSTER: RosterAgent[] = [
  { name: "code", mode: "primary", builtIn: true, description: "Default agent: writes and edits code." },
  { name: "plan", mode: "primary", builtIn: true, description: "Plans changes without editing files." },
  { name: "explore", mode: "subagent", builtIn: true, description: "Fast read-only codebase exploration." },
  { name: "architect", mode: "all", color: "#a78bfa", description: "Designs solutions and reviews structure." },
  { name: "developer", mode: "all", color: "#34d399", description: "Implements features with tested changes." },
  { name: "reviewer", mode: "all", color: "#f59e0b", description: "Reviews changes for bugs and security." },
  { name: "tester", mode: "all", color: "#60a5fa", description: "Writes and runs tests." },
  {
    name: "api-expert",
    mode: "all",
    teammate: true,
    repo: "~/code/api",
    description: "Specialist of the backend API repository.",
  },
]

/** Scripted, looping fake Kilo activity, used by "Star UI: Toggle demo" and for screenshots. */
export class DemoDriver {
  private timers: ReturnType<typeof setTimeout>[] = []
  private round = 0
  private running = false

  constructor(private readonly emit: Emit) {}

  get active(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.emit({ t: "hello", version: "demo", project: "demo", client: "demo", commands: true })
    this.emit({ t: "roster", agents: DEMO_ROSTER })
    this.loop()
  }

  stop(): void {
    this.running = false
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  /** Simulates stopping sessions. */
  abort(sessionIDs: string[]): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    for (const sid of sessionIDs) {
      this.emit({ t: "error", sid, name: "MessageAbortedError", message: "Aborted" })
      this.emit({ t: "status", sid, status: "idle" })
    }
    // The script stops with the agents, and starts again a little later.
    if (this.running) this.play([[10_000, () => this.loop()]])
  }

  /** A plausible conversation for the office chat in demo mode. */
  transcript(agent: string, title?: string): TranscriptMessage[] {
    const now = Date.now()
    return [
      { id: "u1", role: "user", time: now - 60_000, parts: [{ type: "text", text: title ?? "Improve the login flow" }] },
      {
        id: "a1",
        role: "assistant",
        agent,
        time: now - 50_000,
        parts: [
          { type: "reasoning", text: "Let me look at how authentication is wired before changing anything." },
          { type: "tool", tool: "read", status: "completed", title: "auth.ts" },
          { type: "tool", tool: "grep", status: "completed", title: "validateToken" },
          { type: "text", text: "The token check lives in auth.ts. I will add the OAuth callback next to it and keep the existing session handling." },
          { type: "tool", tool: "edit", status: "running", title: "auth.ts" },
        ],
      },
    ]
  }

  /** A plausible meeting for the office chat in demo mode. */
  meetingTranscript(members: string[]): TranscriptMessage[] {
    const now = Date.now()
    const [lead = "code", ...others] = members
    const out: TranscriptMessage[] = [
      { id: "m0", role: "user", time: now - 90_000, parts: [{ type: "text", text: "Add OAuth login, and ask the team for their input." }] },
      {
        id: "m1",
        role: "assistant",
        speaker: lead,
        time: now - 85_000,
        parts: [{ type: "reasoning", text: "Design first, then implementation, then tests." }, { type: "text", text: `Briefing ${others.join(", ") || "the team"}.` }],
      },
    ]
    others.forEach((name, i) => {
      out.push({ id: `b${i}`, role: "user", speaker: lead, to: name, time: now - 80_000 + i * 1000, parts: [{ type: "text", text: `${name}: your part of the OAuth login, with acceptance criteria.` }] })
      out.push({
        id: `r${i}`,
        role: "assistant",
        speaker: name,
        time: now - 60_000 + i * 5000,
        parts: [
          { type: "tool", tool: "read", status: "completed", title: "auth.ts" },
          { type: "text", text: `${name}: looked at auth.ts, proposal ready.` },
        ],
      })
    })
    return out.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
  }

  /** Simulates Kilo answering a prompt sent from the office. */
  prompt(agent: string, text: string): string {
    const sid = `demo-prompt-${Date.now()}`
    const e = this.emit
    this.play([
      [0, () => e({ t: "session", sid, agent, title: text.slice(0, 60) })],
      [0, () => e({ t: "status", sid, status: "busy" })],
      [0, () => e({ t: "thinking", sid, kind: "reasoning" })],
      [2500, () => e({ t: "tool", sid, callID: `${sid}-1`, tool: "read", status: "running", hint: "README.md" })],
      [2500, () => e({ t: "tool", sid, callID: `${sid}-1`, tool: "read", status: "completed" })],
      [0, () => e({ t: "tool", sid, callID: `${sid}-2`, tool: "grep", status: "running", hint: "TODO" })],
      [2500, () => e({ t: "tool", sid, callID: `${sid}-2`, tool: "grep", status: "completed" })],
      [0, () => e({ t: "thinking", sid, kind: "text" })],
      [2500, () => e({ t: "status", sid, status: "idle" })],
    ])
    return sid
  }

  private loop(): void {
    if (!this.running) return
    const r = ++this.round
    const main = `demo-${r}-main`
    const arch = `demo-${r}-architect`
    const expl = `demo-${r}-explore`
    const mate = `demo-${r}-api`
    const test = `demo-${r}-tester`
    const rev = `demo-${r}-reviewer`
    const e = this.emit
    const tool = (sid: string, id: string, name: string, hint?: string) => {
      e({ t: "tool", sid, callID: `${sid}-${id}`, tool: name, status: "running", hint })
    }
    const done = (sid: string, id: string, name: string) => {
      e({ t: "tool", sid, callID: `${sid}-${id}`, tool: name, status: "completed" })
    }

    this.play([
      [0, () => e({ t: "session", sid: main, agent: "code", title: "Add OAuth login" })],
      [0, () => e({ t: "status", sid: main, status: "busy" })],
      [0, () => e({ t: "thinking", sid: main, kind: "reasoning" })],
      [2000, () => tool(main, "1", "read", "auth.ts")],
      [2000, () => (done(main, "1", "read"), tool(main, "2", "grep", "validateToken"))],
      [2000, () => (done(main, "2", "grep"), tool(main, "3", "task", "Design the OAuth flow"))],
      [0, () => e({ t: "session", sid: arch, parentID: main, agent: "architect", title: "Design the OAuth flow" })],
      [0, () => (e({ t: "status", sid: arch, status: "busy" }), tool(arch, "1", "read", "routes.ts"))],
      [2000, () => (done(arch, "1", "read"), tool(arch, "2", "glob", "src/**/*.ts"))],
      [0, () => e({ t: "session", sid: expl, parentID: main, agent: "explore", title: "Find session storage" })],
      [0, () => (e({ t: "status", sid: expl, status: "busy" }), tool(expl, "1", "grep", "session"))],
      [2000, () => (done(arch, "2", "glob"), e({ t: "status", sid: arch, status: "idle" }))],
      [0, () => (done(main, "3", "task"), tool(main, "4", "edit", "auth.ts"))],
      [2000, () => (done(main, "4", "edit"), tool(main, "5", "ask_teammate", "Asking api-expert"))],
      [0, () => e({ t: "session", sid: mate, agent: "code", teammate: "api-expert", title: "Which OAuth endpoints exist?" })],
      [0, () => (e({ t: "status", sid: mate, status: "busy" }), tool(mate, "1", "read", "openapi.yaml"))],
      [3000, () => (done(mate, "1", "read"), tool(mate, "2", "grep", "/oauth/token"))],
      [0, () => (done(expl, "1", "grep"), e({ t: "status", sid: expl, status: "idle" }))],
      [2000, () => (done(mate, "2", "grep"), e({ t: "status", sid: mate, status: "idle" }))],
      [0, () => (done(main, "5", "ask_teammate"), tool(main, "6", "edit", "login.tsx"))],
      [2000, () => e({ t: "session", sid: test, parentID: main, agent: "tester", title: "Run the auth tests" })],
      [0, () => (e({ t: "status", sid: test, status: "busy" }), tool(test, "1", "bash", "npm test"))],
      [3000, () => (done(main, "6", "edit"), e({ t: "ask", sid: main, rid: `${main}-p1`, kind: "permission", label: "bash" }))],
      [3000, () => e({ t: "answered", sid: main, rid: `${main}-p1` })],
      [0, () => (done(test, "1", "bash"), e({ t: "error", sid: test, name: "ToolError", message: "2 tests failing" }))],
      [2000, () => e({ t: "status", sid: main, status: "retry", message: "Rate limited, retrying in 5s" })],
      [3000, () => e({ t: "status", sid: main, status: "busy" })],
      [0, () => tool(test, "2", "edit", "auth.test.ts")],
      [2000, () => e({ t: "session", sid: rev, parentID: main, agent: "reviewer", title: "Review the OAuth change" })],
      [0, () => (e({ t: "status", sid: rev, status: "busy" }), tool(rev, "1", "read", "auth.ts"))],
      [2000, () => e({ t: "compaction", sid: main, phase: "start" })],
      [2000, () => (e({ t: "compaction", sid: main, phase: "end" }), done(test, "2", "edit"))],
      [0, () => e({ t: "status", sid: test, status: "idle" })],
      [2000, () => (done(rev, "1", "read"), e({ t: "status", sid: rev, status: "idle" }))],
      [0, () => tool(main, "7", "write", "CHANGELOG.md")],
      [3000, () => (done(main, "7", "write"), e({ t: "status", sid: main, status: "idle" }))],
      [8000, () => this.loop()],
    ])
  }

  private play(steps: Step[]): void {
    let at = 0
    for (const [delay, run] of steps) {
      at += delay
      this.timers.push(
        setTimeout(() => {
          if (this.running) run()
        }, at),
      )
    }
    // Keep the timer list from growing forever across loops.
    if (this.timers.length > 400) this.timers = this.timers.slice(-200)
  }
}
