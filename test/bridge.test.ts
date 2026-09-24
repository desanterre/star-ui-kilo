import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, before, describe, it } from "node:test"
import { Bridge } from "../src/bridge"
import type { BridgePayload } from "../src/protocol"

describe("Bridge", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "star-bridge-"))
  const received: BridgePayload[] = []
  const bridge = new Bridge(home, (p) => received.push(p), "test")
  let base = ""
  const auth = () => ({ authorization: `Bearer ${bridge.token}` })

  before(async () => {
    await bridge.start()
    base = `http://127.0.0.1:${bridge.port}`
  })
  after(() => bridge.dispose())

  it("publishes a private registry file for the plugin", () => {
    const file = bridge.registryFile!
    const info = JSON.parse(fs.readFileSync(file, "utf8"))
    assert.equal(info.port, bridge.port)
    assert.equal(info.token, bridge.token)
    assert.equal(info.pid, process.pid)
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  })

  it("rejects requests without the token or coming from a browser", async () => {
    assert.equal((await fetch(`${base}/v1/health`)).status, 401)
    assert.equal((await fetch(`${base}/v1/health`, { headers: { authorization: "Bearer nope" } })).status, 401)
    assert.equal((await fetch(`${base}/v1/health`, { headers: { ...auth(), origin: "https://evil.example" } })).status, 401)
    assert.equal((await fetch(`${base}/v1/health`, { headers: auth() })).status, 200)
  })

  it("delivers event batches", async () => {
    const res = await fetch(`${base}/v1/events`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ source: { pid: 7 }, events: [{ t: "status", sid: "s", status: "busy" }] }),
    })
    assert.equal(res.status, 200)
    assert.equal(received.at(-1)?.source?.pid, 7)
    assert.equal(received.at(-1)?.events[0].t, "status")
  })

  it("hands commands to the matching long-poll and resolves with the plugin's result", async () => {
    const poll = fetch(`${base}/v1/commands?pid=7&dir=${encodeURIComponent("/proj")}`, { headers: auth() }).then((r) => r.json())
    await new Promise((r) => setTimeout(r, 50))
    const result = bridge.sendCommand({ pid: 7, dir: "/proj" }, { kind: "prompt", agent: "code", mode: "primary", text: "hi" })
    const { commands } = (await poll) as { commands: { id: string; kind: string; text: string }[] }
    assert.equal(commands.length, 1)
    assert.equal(commands[0].text, "hi")
    await fetch(`${base}/v1/results`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ results: [{ id: commands[0].id, ok: true, sessionID: "ses_1" }] }),
    })
    assert.deepEqual(await result, { id: commands[0].id, ok: true, sessionID: "ses_1" })
  })

  it("queues commands until the plugin polls, and times out if it never does", async () => {
    const pending = bridge.sendCommand({ pid: 8, dir: "/q" }, { kind: "roster" }, 300)
    const res = await fetch(`${base}/v1/commands?pid=8&dir=${encodeURIComponent("/q")}`, { headers: auth() })
    const { commands } = (await res.json()) as { commands: { kind: string }[] }
    assert.equal(commands[0].kind, "roster")
    const late = await pending
    assert.equal(late.ok, false)
  })

  it("removes its registry file on dispose", () => {
    const other = new Bridge(home, () => {})
    return other.start().then(() => {
      const file = other.registryFile!
      assert.ok(fs.existsSync(file))
      other.dispose()
      assert.ok(!fs.existsSync(file))
    })
  })
})
