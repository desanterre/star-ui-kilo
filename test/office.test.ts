import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { toolState } from "../src/mapping"
import { OfficeModel } from "../src/office"
import type { BridgeEvent, ConnectionInfo } from "../src/protocol"

const CONN: ConnectionInfo = { pluginInstalled: true, kiloDetected: true, live: true, canPrompt: false, demo: false }
const T0 = 1_000_000

function model(events: BridgeEvent[], opts = {}) {
  const m = new OfficeModel(opts)
  events.forEach((ev, i) => m.apply(ev, T0 + i))
  return m
}

describe("toolState", () => {
  it("maps Kilo tools to Star Office areas", () => {
    assert.equal(toolState("read"), "researching")
    assert.equal(toolState("grep"), "researching")
    assert.equal(toolState("webfetch"), "researching")
    assert.equal(toolState("ask_teammate"), "researching")
    assert.equal(toolState("edit"), "writing")
    assert.equal(toolState("write"), "writing")
    assert.equal(toolState("bash"), "executing")
    assert.equal(toolState("task"), "executing")
  })

  it("guesses MCP tools from their name", () => {
    assert.equal(toolState("github_search_issues"), "researching")
    assert.equal(toolState("linear_create_issue"), "writing")
    assert.equal(toolState("playwright_click"), "executing")
  })
})

describe("OfficeModel", () => {
  it("makes the active root session's agent the main character", () => {
    const m = model([
      { t: "session", sid: "s1", title: "Add login", agent: "code" },
      { t: "status", sid: "s1", status: "busy" },
      { t: "tool", sid: "s1", callID: "c1", tool: "read", status: "running", hint: "auth.ts" },
    ])
    const snap = m.snapshot(CONN, T0 + 10)
    assert.equal(snap.main?.name, "code")
    assert.equal(snap.main?.state, "researching")
    assert.deepEqual(snap.main?.detail, { kind: "tool", tool: "read", hint: "auth.ts" })
    assert.equal(snap.main?.sessionID, "s1")
    assert.equal(snap.main?.busy, true)
  })

  it("shows sub-agents as guests and strips Kilo's subagent title suffix", () => {
    const m = model([
      { t: "session", sid: "s1", agent: "code" },
      { t: "status", sid: "s1", status: "busy" },
      { t: "session", sid: "s2", parentID: "s1", title: "Find the router (@explore subagent)" },
      { t: "status", sid: "s2", status: "busy" },
      { t: "tool", sid: "s2", callID: "c1", tool: "grep", status: "running", hint: "router" },
    ])
    const snap = m.snapshot(CONN, T0 + 10)
    assert.equal(snap.guests.length, 1)
    const guest = snap.guests[0]
    assert.equal(guest.name, "explore")
    assert.equal(guest.sessionTitle, "Find the router")
    assert.equal(guest.isSubagent, true)
    assert.equal(guest.state, "researching")
    assert.ok(snap.log.some((l) => l.kind === "joined" && l.agent === "explore"))
  })

  it("keeps idle roster agents in the office as team members", () => {
    const m = model([
      {
        t: "roster",
        agents: [
          { name: "code", mode: "primary", builtIn: true },
          { name: "reviewer", mode: "all", description: "Reviews code", color: "#f59e0b" },
          { name: "title", mode: "primary", hidden: true },
          { name: "compaction", mode: "primary" },
        ],
      },
    ])
    const snap = m.snapshot(CONN, T0 + 10)
    assert.equal(snap.main?.name, "code")
    assert.deepEqual(
      snap.guests.map((g) => g.name),
      ["reviewer"],
    )
    assert.equal(snap.guests[0].state, "idle")
    assert.equal(snap.guests[0].description, "Reviews code")
  })

  it("can hide idle built-in agents", () => {
    const m = model(
      [
        {
          t: "roster",
          agents: [
            { name: "code", mode: "primary", builtIn: true },
            { name: "plan", mode: "primary", builtIn: true },
            { name: "tester", mode: "all" },
          ],
        },
      ],
      { showBuiltInAgents: false },
    )
    const names = m.snapshot(CONN, T0 + 10).guests.map((g) => g.name)
    assert.deepEqual(names, ["tester"])
  })

  it("flags agents waiting for approval, and clears it once answered", () => {
    const m = model([
      { t: "session", sid: "s1", agent: "code" },
      { t: "status", sid: "s1", status: "busy" },
      { t: "ask", sid: "s1", rid: "p1", kind: "permission", label: "bash" },
    ])
    let snap = m.snapshot(CONN, T0 + 10)
    assert.deepEqual(snap.main?.waiting, { kind: "permission", label: "bash" })
    assert.equal(snap.main?.detail.kind, "waiting")
    m.apply({ t: "answered", sid: "s1", rid: "p1" }, T0 + 20)
    snap = m.snapshot(CONN, T0 + 21)
    assert.equal(snap.main?.waiting, undefined)
  })

  it("sends errored agents to the bug zone until they work again", () => {
    const m = model([
      { t: "session", sid: "s1", agent: "code" },
      { t: "status", sid: "s1", status: "busy" },
      { t: "error", sid: "s1", name: "APIError", message: "Rate limited" },
      { t: "status", sid: "s1", status: "idle" },
    ])
    assert.equal(m.snapshot(CONN, T0 + 10).main?.state, "error")
    m.apply({ t: "thinking", sid: "s1", kind: "text" }, T0 + 20)
    assert.equal(m.snapshot(CONN, T0 + 21).main?.state, "writing")
  })

  it("ignores aborts (the user pressed stop)", () => {
    const m = model([
      { t: "session", sid: "s1", agent: "code" },
      { t: "status", sid: "s1", status: "busy" },
      { t: "error", sid: "s1", name: "MessageAbortedError", message: "Aborted" },
      { t: "status", sid: "s1", status: "idle" },
    ])
    const snap = m.snapshot(CONN, T0 + 60_000)
    assert.equal(snap.main?.state, "idle")
    assert.ok(!snap.log.some((l) => l.kind === "error"))
  })

  it("maps retries and compaction to the sync corner", () => {
    const m = model([
      { t: "session", sid: "s1", agent: "code" },
      { t: "status", sid: "s1", status: "retry", message: "429" },
    ])
    assert.equal(m.snapshot(CONN, T0 + 5).main?.state, "syncing")
    m.apply({ t: "status", sid: "s1", status: "busy" }, T0 + 6)
    m.apply({ t: "compaction", sid: "s1", phase: "start" }, T0 + 7)
    assert.equal(m.snapshot(CONN, T0 + 8).main?.detail.kind, "compaction")
  })

  it("lets a finished agent linger at the desk, then go back to the lounge", () => {
    const m = model(
      [
        { t: "session", sid: "s1", agent: "code" },
        { t: "status", sid: "s1", status: "busy" },
        { t: "status", sid: "s1", status: "idle" },
      ],
      { lingerMs: 10_000 },
    )
    assert.equal(m.snapshot(CONN, T0 + 5_000).main?.state, "writing")
    assert.equal(m.snapshot(CONN, T0 + 20_000).main?.state, "idle")
  })

  it("groups several sessions of the same agent into one character", () => {
    const m = model([
      { t: "session", sid: "s1", agent: "code" },
      { t: "status", sid: "s1", status: "busy" },
      { t: "session", sid: "a", parentID: "s1", agent: "explore" },
      { t: "status", sid: "a", status: "busy" },
      { t: "session", sid: "b", parentID: "s1", agent: "explore" },
      { t: "status", sid: "b", status: "busy" },
    ])
    const explore = m.snapshot(CONN, T0 + 10).guests.find((g) => g.name === "explore")
    assert.equal(explore?.activeSessions, 2)
  })

  it("names cross-repo teammates after the teammate, not the underlying agent", () => {
    const m = model([
      { t: "roster", agents: [{ name: "code", mode: "primary", builtIn: true }, { name: "api-expert", mode: "all", teammate: true, repo: "/r/api" }] },
      { t: "session", sid: "s1", agent: "code" },
      { t: "status", sid: "s1", status: "busy" },
      { t: "session", sid: "t1", agent: "code", teammate: "api-expert", dir: "/r/api" },
      { t: "status", sid: "t1", status: "busy" },
    ])
    const snap = m.snapshot(CONN, T0 + 10)
    assert.equal(snap.main?.name, "code")
    const mate = snap.guests.find((g) => g.name === "api-expert")
    assert.equal(mate?.teammate, true)
    assert.equal(mate?.busy, true)
    assert.equal(mate?.repo, "/r/api")
  })

  it("keeps the current main character while it works, even if another session starts", () => {
    const m = model([
      { t: "session", sid: "s1", agent: "code" },
      { t: "status", sid: "s1", status: "busy" },
    ])
    assert.equal(m.snapshot(CONN, T0 + 5).main?.name, "code")
    m.apply({ t: "session", sid: "s2", agent: "plan" }, T0 + 6)
    m.apply({ t: "status", sid: "s2", status: "busy" }, T0 + 7)
    assert.equal(m.snapshot(CONN, T0 + 10).main?.name, "code")
    m.apply({ t: "status", sid: "s1", status: "idle" }, T0 + 20)
    assert.equal(m.snapshot(CONN, T0 + 21).main?.name, "plan")
  })

  it("groups a lead and the sub-agents it started into a meeting", () => {
    const m = model([
      { t: "session", sid: "root", agent: "manager", title: "Ship the feature" },
      { t: "status", sid: "root", status: "busy" },
      { t: "session", sid: "a", parentID: "root", agent: "architect" },
      { t: "status", sid: "a", status: "busy" },
      { t: "session", sid: "d", parentID: "root", agent: "developer" },
      { t: "status", sid: "d", status: "idle" },
      { t: "session", sid: "other", agent: "code" },
      { t: "status", sid: "other", status: "busy" },
    ])
    const snap = m.snapshot(CONN, T0 + 10)
    assert.equal(snap.meetings.length, 1)
    assert.deepEqual(snap.meetings[0], { id: "root", title: "Ship the feature", members: ["manager", "architect", "developer"], busy: true, updatedAt: T0 + 5 })
    const byName = Object.fromEntries([snap.main!, ...snap.guests].map((c) => [c.name, c]))
    assert.equal(byName.manager.meetingID, "root")
    assert.equal(byName.architect.meetingID, "root")
    assert.equal(byName.code.meetingID, undefined)
    assert.deepEqual(
      m.meetingSessions("root").map((x) => [x.sessionID, x.speaker]),
      [
        ["root", "manager"],
        ["a", "architect"],
        ["d", "developer"],
      ],
    )
    assert.deepEqual(
      m.busySessionsOfMeeting("root").map((x) => x.sessionID),
      ["root", "a"],
    )
  })

  it("stops a character together with the sub-agents it started", () => {
    const m = model([
      { t: "session", sid: "root", agent: "manager" },
      { t: "status", sid: "root", status: "busy" },
      { t: "session", sid: "a", parentID: "root", agent: "architect" },
      { t: "status", sid: "a", status: "busy" },
      { t: "session", sid: "x", agent: "code" },
      { t: "status", sid: "x", status: "busy" },
    ])
    assert.deepEqual(m.busySessions("manager").map((s) => s.sessionID).sort(), ["a", "root"])
    assert.deepEqual(m.busySessions("architect").map((s) => s.sessionID), ["a"])
    assert.deepEqual(m.busySessions().map((s) => s.sessionID).sort(), ["a", "root", "x"])
  })

  it("drops events rejected by the scope filter", () => {
    const m = new OfficeModel({ accept: (_src, dir) => !dir || dir.startsWith("/work") })
    m.apply({ t: "session", sid: "x", agent: "code", dir: "/elsewhere" }, T0)
    m.apply({ t: "status", sid: "x", status: "busy" }, T0 + 1)
    m.apply({ t: "session", sid: "y", agent: "code", dir: "/work/app" }, T0 + 2)
    const snap = m.snapshot(CONN, T0 + 3)
    assert.equal(snap.main?.sessionID, "y")
    assert.equal(snap.main?.busy, false)
  })

  it("ranks live plugin instances for prompts", () => {
    const m = new OfficeModel()
    m.apply({ t: "hello", version: "1", client: "cli", commands: true, dir: "/a" }, T0, { pid: 1 })
    m.apply({ t: "hello", version: "1", client: "vscode", commands: true, dir: "/b" }, T0, { pid: 2, parentPid: 42 })
    m.apply({ t: "hello", version: "1", client: "vscode", commands: false, dir: "/c" }, T0, { pid: 3 })
    assert.deepEqual(
      m.liveInstances(undefined, 42, T0 + 1).map((i) => i.pid),
      [2, 1],
    )
    assert.deepEqual(
      m.liveInstances("/a", 42, T0 + 1).map((i) => i.pid),
      [1, 2],
    )
    assert.equal(m.liveInstances(undefined, 42, T0 + 10 * 60_000).length, 0)
  })

  it("forgets old idle sessions", () => {
    const m = model(
      [
        { t: "session", sid: "s1", agent: "code" },
        { t: "session", sid: "s2", parentID: "s1", agent: "explore" },
        { t: "status", sid: "s2", status: "idle" },
      ],
      { forgetMs: 1000 },
    )
    assert.equal(m.prune(T0 + 5000), true)
    assert.equal(
      m.snapshot(CONN, T0 + 5000).guests.find((g) => g.name === "explore"),
      undefined,
    )
  })
})
