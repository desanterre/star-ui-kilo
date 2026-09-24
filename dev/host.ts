// Browser stand-in for the VS Code extension host, used by `npm run preview`.
// It runs the real OfficeModel + DemoDriver and talks to media/office.js like the extension does.
import { DemoDriver } from "../src/demo"
import { OfficeModel } from "../src/office"
import type { FromWebview, ToWebview } from "../src/protocol"

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
    } else if (msg.type === "command" && msg.command === "toggleDemo") {
      if (demo.active) demo.stop()
      else demo.start()
      model.clear()
      if (demo.active) demo.start()
    }
  },
})

if (!disconnected) demo.start()
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
