// Browser stand-in for the VS Code extension host, used by `npm run preview`.
// It runs the real OfficeModel + DemoDriver and talks to media/office.js like the extension does.
import { DemoDriver } from "../src/demo"
import { OfficeModel } from "../src/office"
import type { AgentProfile, FromWebview, ToWebview } from "../src/protocol"

const params = new URLSearchParams(location.search)
const language = params.get("lang") ?? "en"
const room = params.get("room") === "lodge" ? "lodge" : "office"
const disconnected = params.get("scenario") === "disconnected"

const model = new OfficeModel({ lingerMs: 6000 })
const demo = new DemoDriver((ev) => {
  model.apply(ev, Date.now(), { pid: -1 })
})
const connection = () => ({
  pluginInstalled: !disconnected,
  kiloDetected: true,
  live: false,
  canPrompt: demo.active,
  demo: demo.active,
})
const send = (msg: ToWebview) => window.postMessage(msg, "*")

// Profiles live in memory in the preview.
const profiles = new Map<string, AgentProfile>([
  [
    "team",
    {
      context: "We build a multi-tenant SaaS in Go and TypeScript. Main branch is protected; every change needs tests.",
      folders: [{ path: "/Users/me/code/platform-docs" }],
      memory: [{ id: "n1", text: "Integration tests need the local Postgres started with make db.", at: Date.now() - 86_400_000, by: "tester" }],
    },
  ],
])
const profileKey = (t: { kind: string; name?: string }) => (t.kind === "team" ? "team" : `agent:${t.name}`)
const profileOf = (t: { kind: string; name?: string }) => profiles.get(profileKey(t)) ?? { context: "", folders: [], memory: [] }

;(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  getState: () => null,
  setState: () => {},
  postMessage(msg: FromWebview) {
    console.log("[host] <-", msg)
    if (msg.type === "ready") {
      send({ type: "init", settings: { language, officeName: "", room }, snapshot: model.snapshot(connection()) })
    } else if (msg.type === "prompt") {
      demo.prompt(msg.agent, msg.text)
      model.notePrompt(msg.agent, msg.text)
      setTimeout(() => send({ type: "promptResult", requestId: msg.requestId, ok: true, sessionID: "demo" }), 500)
    } else if (msg.type === "transcript") {
      const target = msg.target
      if (target.kind === "meeting") {
        const speakers = model.meetingSessions(target.id).map((x) => x.speaker)
        send({ type: "transcript", requestId: msg.requestId, target, sessionID: target.id, messages: demo.meetingTranscript(speakers) })
      } else {
        const char = model.getCharacter(target.name)
        send({ type: "transcript", requestId: msg.requestId, target, sessionID: char?.sessionID, messages: char?.sessionID ? demo.transcript(target.name, char.sessionTitle) : [] })
      }
    } else if (msg.type === "stop") {
      const sessions = msg.meetingID ? model.busySessionsOfMeeting(msg.meetingID) : model.busySessions(msg.agent)
      demo.abort(sessions.map((x) => x.sessionID))
    } else if (msg.type === "meetingPrompt") {
      const root = model.meetingSessions(msg.meetingID)[0]
      if (root) demo.prompt(root.speaker, msg.text)
      setTimeout(() => send({ type: "promptResult", requestId: msg.requestId, ok: true }), 400)
    } else if (msg.type === "profileLoad") {
      setTimeout(() => send({ type: "profile", requestId: msg.requestId, target: msg.target, profile: structuredClone(profileOf(msg.target)) }), 150)
    } else if (msg.type === "profileSave") {
      const before = profileOf(msg.target)
      profiles.set(profileKey(msg.target), { ...before, context: msg.context, folders: msg.folders })
      const reloadNeeded = JSON.stringify(before.folders.map((f) => f.path).sort()) !== JSON.stringify(msg.folders.map((f) => f.path).sort())
      setTimeout(() => send({ type: "profileSaved", requestId: msg.requestId, ok: true, reloadNeeded }), 300)
    } else if (msg.type === "profileForget") {
      const p = profileOf(msg.target)
      profiles.set(profileKey(msg.target), { ...p, memory: p.memory.filter((n) => n.id !== msg.id) })
      send({ type: "profile", requestId: msg.requestId, target: msg.target, profile: structuredClone(profileOf(msg.target)) })
    } else if (msg.type === "pickFolders") {
      setTimeout(() => send({ type: "folders", requestId: msg.requestId, paths: ["/Users/me/code/api", "/Users/me/code/web"] }), 300)
    } else if (msg.type === "briefing") {
      send({ type: "briefing", requestId: msg.requestId, error: "Connect Kilo Code to see the briefing." })
    } else if (msg.type === "command" && msg.command === "toggleDemo") {
      if (demo.active) demo.stop()
      else demo.start()
      model.clear()
      if (demo.active) demo.start()
    }
  },
})

// ?scenario=poses: one agent in each state, to check the guests' rooms and animations.
if (params.get("scenario") === "poses") {
  const at = Date.now()
  const ev = (e: Parameters<typeof model.apply>[0]) => model.apply(e, at, { pid: -1 })
  ev({ t: "hello", version: "demo", project: "demo", client: "demo", commands: true })
  ev({
    t: "roster",
    agents: ["code", "manager", "architect", "developer", "tester", "reviewer", "docs", "sre", "go-developer", "security"].map((name) => ({
      name,
      mode: name === "code" || name === "manager" ? "primary" : "all",
    })),
  })
  const run = (sid: string, agent: string, parentID?: string) => {
    ev({ t: "session", sid, agent, parentID, title: `${agent} task` })
    ev({ t: "status", sid, status: "busy" })
  }
  run("m", "manager")
  ev({ t: "tool", sid: "m", callID: "m1", tool: "task", status: "running", hint: "Design" })
  run("a", "architect", "m")
  ev({ t: "thinking", sid: "a", kind: "reasoning" })
  run("d", "developer", "m")
  ev({ t: "tool", sid: "d", callID: "d1", tool: "edit", status: "running", hint: "main.go" })
  run("t", "tester", "m")
  ev({ t: "tool", sid: "t", callID: "t1", tool: "bash", status: "running", hint: "go test ./..." })
  run("r", "reviewer")
  ev({ t: "tool", sid: "r", callID: "r1", tool: "grep", status: "running", hint: "TODO" })
  run("s", "sre")
  ev({ t: "status", sid: "s", status: "retry", message: "Rate limited" })
  run("g", "go-developer")
  ev({ t: "error", sid: "g", name: "ToolError", message: "build failed" })
  run("x", "security")
  ev({ t: "ask", sid: "x", rid: "x1", kind: "permission", label: "bash" })
} else if (!disconnected) demo.start()
setInterval(() => send({ type: "snapshot", snapshot: model.snapshot(connection()) }), 500)

// Promo screenshots: ?talk=<agent>&say=<text> opens the talk dialog after a while.
const talk = params.get("talk")
if (talk) {
  setTimeout(() => {
    const row = [...document.querySelectorAll<HTMLButtonElement>(".agent-item")].find((b) => b.textContent?.includes(talk))
    row?.click()
    const box = document.getElementById("talk-text") as HTMLTextAreaElement | null
    if (box) box.value = params.get("say") ?? ""
  }, Number(params.get("talkAt") ?? 9000))
}
