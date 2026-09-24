// Runs the real Kilo plugin (plugin/star-ui-kilo.js) against the real bridge, with a fake Kilo client.
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { after, before, describe, it } from "node:test"
import { Bridge } from "../src/bridge"
import type { BridgeEvent, BridgePayload } from "../src/protocol"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "star-plugin-"))
process.env.STAR_UI_KILO_HOME = home

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error("timed out")
    await wait(25)
  }
}

describe("Kilo plugin", () => {
  const payloads: BridgePayload[] = []
  const events = () => payloads.flatMap((p) => p.events)
  const bridge = new Bridge(home, (p) => payloads.push(p))
  const calls: [string, any][] = []
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "star-state-"))
  let configModel: string | undefined
  const client = {
    app: {
      agents: async () => ({
        data: [
          { name: "code", mode: "primary", builtIn: true, native: true },
          { name: "reviewer", mode: "all", description: "Reviews code", color: "#f59e0b" },
          { name: "pinned", mode: "all", model: { providerID: "openai", modelID: "gpt-5" } },
        ],
      }),
    },
    path: { get: async () => ({ data: { state: stateDir } }) },
    config: { get: async () => ({ data: configModel ? { model: configModel } : {} }) },
    session: {
      create: async (opts: any) => (calls.push(["create", opts]), { data: { id: `ses_${calls.length}` } }),
      promptAsync: async (opts: any) => (calls.push(["promptAsync", opts]), { data: undefined }),
      prompt: async (opts: any) => (
        calls.push(["prompt", opts]),
        { data: { info: {}, parts: [{ type: "text", text: "Use POST /oauth/token." }, { type: "text", text: "x", synthetic: true }] } }
      ),
      abort: async (opts: any) => (calls.push(["abort", opts]), { data: true }),
      messages: async (opts: any) => (
        calls.push(["messages", opts]),
        {
          data: [
            { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "Plan the release" }] },
            {
              info: { id: "m2", role: "assistant", agent: "manager", time: { created: 2 } },
              parts: [
                { type: "reasoning", text: "Split the work." },
                { type: "tool", tool: "task", state: { status: "completed", input: { description: "Design", subagent_type: "architect" } } },
                { type: "text", text: "x".repeat(10_000) },
                { type: "text", text: "hidden", synthetic: true },
                { type: "step-start" },
              ],
            },
          ],
        }
      ),
    },
  }
  let plugin: any
  let hooks: any

  before(async () => {
    await bridge.start()
    const mod = await import(pathToFileURL(path.resolve("plugin/star-ui-kilo.js")).href)
    plugin = mod.StarUiKiloPlugin
    assert.equal(Object.values(mod).filter((v) => typeof v === "function").length, 1, "only one function export")
    hooks = await plugin({ directory: "/work/app", client })
  })

  after(async () => {
    await hooks?.dispose?.()
    bridge.dispose()
  })

  it("says hello with its identity", async () => {
    const hello = await until(() => events().find((e) => e.t === "hello") as Extract<BridgeEvent, { t: "hello" }>)
    assert.equal(hello.dir, "/work/app")
    assert.equal(hello.commands, true)
    assert.equal(payloads[0].source?.pid, process.pid)
  })

  it("forwards a lightweight summary of Kilo events", async () => {
    const send = (type: string, properties: any) => hooks.event({ event: { type, properties } })
    await send("session.created", { info: { id: "s1", title: "Add login", directory: "/work/app" } })
    await send("session.status", { sessionID: "s1", status: { type: "busy" } })
    await send("message.updated", { info: { role: "assistant", sessionID: "s1", agent: "code" } })
    await send("message.part.updated", {
      part: {
        type: "tool",
        sessionID: "s1",
        callID: "c1",
        tool: "read",
        state: { status: "running", input: { filePath: "/work/app/src/secret-heavy-file.ts" } },
      },
    })
    await send("message.part.updated", { part: { type: "text", sessionID: "s1", text: "SECRET MODEL OUTPUT" } })
    await send("permission.asked", { id: "p1", sessionID: "s1", permission: "bash", patterns: ["rm -rf"] })
    await send("session.error", { sessionID: "s1", error: { name: "APIError", data: { message: "Rate limited" } } })
    await send("lsp.updated", {})

    const tool = await until(() => events().find((e) => e.t === "tool") as Extract<BridgeEvent, { t: "tool" }>)
    assert.equal(tool.hint, "secret-heavy-file.ts")
    assert.equal(tool.status, "running")
    await until(() => events().find((e) => e.t === "error"))
    const types = events().map((e) => e.t)
    for (const t of ["session", "status", "agent", "thinking", "ask"]) assert.ok(types.includes(t as BridgeEvent["t"]), t)
    const raw = JSON.stringify(payloads)
    assert.ok(!raw.includes("SECRET MODEL OUTPUT"), "model output must not leave Kilo")
    assert.ok(!raw.includes("/work/app/src"), "full file paths are reduced to file names")
  })

  it("refreshes the agent roster on demand", async () => {
    const result = await bridge.sendCommand({ pid: process.pid, dir: "/work/app" }, { kind: "roster" }, 8000)
    assert.equal(result.ok, true)
    const roster = await until(() => events().find((e) => e.t === "roster") as Extract<BridgeEvent, { t: "roster" }>)
    assert.deepEqual(
      roster.agents.map((a) => [a.name, a.mode, !!a.builtIn]),
      [
        ["code", "primary", true],
        ["reviewer", "all", false],
        ["pinned", "all", false],
      ],
    )
  })

  it("prompts an agent in a new session through Kilo's client", async () => {
    calls.length = 0
    const result = await bridge.sendCommand(
      { pid: process.pid, dir: "/work/app" },
      { kind: "prompt", agent: "reviewer", mode: "all", text: "Review the login change" },
      8000,
    )
    assert.equal(result.ok, true)
    assert.ok(result.sessionID)
    const [create, prompt] = calls
    assert.equal(create[0], "create")
    assert.equal(create[1].query.directory, "/work/app")
    assert.equal(prompt[0], "promptAsync")
    assert.equal(prompt[1].path.id, result.sessionID)
    assert.equal(prompt[1].body.agent, "reviewer")
    assert.deepEqual(prompt[1].body.parts, [{ type: "text", text: "Review the login change" }])
  })

  it("picks the model like Kilo Code does", async () => {
    const { resolveModel } = plugin.__test
    const ctx = { directory: "/work/app", client, abort: new AbortController() }
    const fallback = { providerID: "kilo", modelID: "kilo-auto/free" }
    assert.deepEqual(await resolveModel(ctx, "reviewer", fallback), fallback, "Kilo Code default-model settings")
    configModel = "zai/glm-5"
    assert.deepEqual(await resolveModel(ctx, "reviewer", fallback), { providerID: "zai", modelID: "glm-5" }, "model from the Kilo config")
    fs.writeFileSync(path.join(stateDir, "vscode-model.json"), JSON.stringify({ preferred: { providerID: "custom", modelID: "glm", variant: "" } }))
    assert.deepEqual(await resolveModel(ctx, "reviewer", fallback), { providerID: "custom", modelID: "glm" }, "last model picked in Kilo Code")
    fs.writeFileSync(path.join(stateDir, "model.json"), JSON.stringify({ model: { reviewer: { providerID: "zai", modelID: "glm-5-air" } } }))
    assert.deepEqual(await resolveModel(ctx, "reviewer", fallback), { providerID: "zai", modelID: "glm-5-air" }, "model picked for this agent")
    assert.equal(await resolveModel(ctx, "pinned", fallback), undefined, "an agent with its own model keeps it")
    configModel = undefined
    fs.rmSync(path.join(stateDir, "model.json"))
    fs.rmSync(path.join(stateDir, "vscode-model.json"))
  })

  it("sends the chosen model with new prompts, not when continuing a conversation", async () => {
    calls.length = 0
    await bridge.sendCommand(
      { pid: process.pid, dir: "/work/app" },
      { kind: "prompt", agent: "reviewer", mode: "all", text: "hi", model: { providerID: "kilo", modelID: "kilo-auto/free" } },
      8000,
    )
    assert.deepEqual(calls.find((c) => c[0] === "promptAsync")![1].body.model, { providerID: "kilo", modelID: "kilo-auto/free" })
    calls.length = 0
    await bridge.sendCommand(
      { pid: process.pid, dir: "/work/app" },
      { kind: "prompt", agent: "reviewer", mode: "all", text: "again", sessionID: "ses_x", model: { providerID: "kilo", modelID: "kilo-auto/free" } },
      8000,
    )
    assert.equal(calls.find((c) => c[0] === "promptAsync")![1].body.model, undefined)
  })

  it("stops sessions, each in its own directory", async () => {
    calls.length = 0
    const result = await bridge.sendCommand(
      { pid: process.pid, dir: "/work/app" },
      { kind: "abort", sessions: [{ sessionID: "s1" }, { sessionID: "t1", dir: "/other/repo" }] },
      8000,
    )
    assert.equal(result.ok, true)
    assert.deepEqual(
      calls.filter((c) => c[0] === "abort").map((c) => [c[1].path.id, c[1].query.directory]),
      [
        ["s1", "/work/app"],
        ["t1", "/other/repo"],
      ],
    )
  })

  it("returns a trimmed transcript of a conversation", async () => {
    const result = await bridge.sendCommand({ pid: process.pid, dir: "/work/app" }, { kind: "messages", sessionID: "s1" }, 8000)
    assert.equal(result.ok, true)
    const [user, assistant] = result.data!
    assert.deepEqual(user, { id: "m1", role: "user", time: 1, parts: [{ type: "text", text: "Plan the release" }] })
    assert.equal(assistant.agent, "manager")
    assert.deepEqual(
      assistant.parts.map((p) => p.type),
      ["reasoning", "tool", "text"],
    )
    assert.equal(assistant.parts[1].title, "Design")
    assert.equal(assistant.parts[2].text!.length, 6000, "long texts are truncated")
  })

  it("starts sub-agents as a sub-task, and can continue an existing session", async () => {
    calls.length = 0
    const sub = await bridge.sendCommand(
      { pid: process.pid, dir: "/work/app" },
      { kind: "prompt", agent: "explore", mode: "subagent", text: "Where is auth?" },
      8000,
    )
    assert.equal(sub.ok, true)
    const part = calls.find((c) => c[0] === "promptAsync")![1].body.parts[0]
    assert.equal(part.type, "subtask")
    assert.equal(part.agent, "explore")

    calls.length = 0
    const cont = await bridge.sendCommand(
      { pid: process.pid, dir: "/work/app" },
      { kind: "prompt", agent: "code", mode: "primary", text: "and now?", sessionID: "ses_existing" },
      8000,
    )
    assert.equal(cont.sessionID, "ses_existing")
    assert.deepEqual(
      calls.map((c) => c[0]),
      ["promptAsync"],
    )
  })

  it("lets an agent ask a teammate from another repository, with loop protection", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "star-api-"))
    fs.writeFileSync(
      path.join(home, "team.json"),
      JSON.stringify({ members: [{ name: "api-expert", repo, agent: "ask", description: "Knows the API" }, { name: "bad name!", repo }] }),
    )
    const { askTeammate, readTeam } = plugin.__test
    assert.deepEqual(
      readTeam().map((m: any) => m.name),
      ["api-expert"],
    )

    calls.length = 0
    const ctx = { directory: "/work/app", client, abort: new AbortController() }
    const answer = await askTeammate(ctx, { teammate: "API-EXPERT", question: "Which OAuth endpoint?" }, { sessionID: "s1" })
    assert.equal(answer.output, "Use POST /oauth/token.")
    const create = calls.find((c) => c[0] === "create")![1]
    assert.equal(create.query.directory, repo)
    const prompt = calls.find((c) => c[0] === "prompt")![1]
    assert.equal(prompt.body.agent, "ask")
    assert.ok(prompt.body.parts[0].text.includes("Which OAuth endpoint?"))

    const teammateSession = answer.metadata.sessionID
    const loop = await askTeammate(ctx, { teammate: "api-expert", question: "?" }, { sessionID: teammateSession })
    assert.match(loop, /Loop protection/)

    const unknown = await askTeammate(ctx, { teammate: "nobody", question: "?" }, { sessionID: "s1" })
    assert.match(unknown, /Unknown teammate/)

    // The teammate shows up in the office under its own name.
    const tagged = await until(() => events().find((e) => e.t === "session" && e.teammate === "api-expert"))
    assert.equal(tagged.dir, repo)
  })

  it("briefs every agent with its role, its teammates, the contexts and the linked folders", async () => {
    const operator = fs.mkdtempSync(path.join(os.tmpdir(), "star-operator-"))
    fs.writeFileSync(path.join(operator, "go.mod"), "module example.com/operator\n\ngo 1.22\n\nrequire sigs.k8s.io/controller-runtime v0.18.0\n")
    fs.writeFileSync(path.join(operator, "README.md"), "# Operator\nReconciles Widgets.\n")
    fs.mkdirSync(path.join(operator, "api"))
    const docs = fs.mkdtempSync(path.join(os.tmpdir(), "star-docs-"))
    fs.writeFileSync(
      path.join(home, "profiles.json"),
      JSON.stringify({
        team: { context: "We ship Kubernetes operators.", folders: [docs] },
        agents: { reviewer: { context: "Check RBAC first.", folders: [{ path: operator, note: "main repo" }] } },
      }),
    )
    await hooks["chat.message"]({ sessionID: "sb1", agent: "reviewer" }, { message: {}, parts: [] })
    const output = { system: ["base prompt"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "sb1", model: {} }, output)
    assert.equal(output.system.length, 2)
    const text = output.system[1]
    assert.match(text, /You are \*\*reviewer\*\*: Reviews code/)
    assert.match(text, /## Your team\n[^#]*\*\*pinned\*\*/)
    assert.ok(!/\*\*code\*\*/.test(text), "built-in agents are not listed as teammates")
    assert.match(text, /\*\*api-expert\*\*: Knows the API/)
    assert.match(text, /## Team context\nWe ship Kubernetes operators\./)
    assert.match(text, /## Your context\nCheck RBAC first\./)
    assert.ok(text.includes(`: ${operator} (main repo)`))
    assert.match(text, /Go module example\.com\/operator \(go 1\.22\), uses sigs\.k8s\.io\/controller-runtime/)
    assert.match(text, /> Reconciles Widgets\./)
    assert.ok(text.includes(docs))

    // Kilo's internal agents get nothing; unknown sessions are looked up.
    await hooks["chat.message"]({ sessionID: "st", agent: "title" }, { message: {}, parts: [] })
    const internal = { system: ["base"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "st", model: {} }, internal)
    assert.equal(internal.system.length, 1)
    const unknown = { system: ["base"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_unknown", model: {} }, unknown)
    assert.match(unknown.system[1], /You are \*\*manager\*\*/)

    const viaBridge = await bridge.sendCommand({ pid: process.pid, dir: "/work/app" }, { kind: "briefing", agent: "reviewer" }, 8000)
    assert.equal(viaBridge.ok, true)
    assert.equal(viaBridge.text, text)
  })

  it("lets agents read their linked folders through Kilo's permission rules", async () => {
    const profiles = JSON.parse(fs.readFileSync(path.join(home, "profiles.json"), "utf8"))
    const [docs] = profiles.team.folders
    const operator = profiles.agents.reviewer.folders[0].path
    // Windows paths are allowed with both separators.
    const rules = (dir: string) => ({ [`${dir}/*`]: "allow", ...(dir.includes("\\") ? { [`${dir.replace(/\\/g, "/")}/*`]: "allow" } : {}) })
    const config: any = { permission: { external_directory: "ask", edit: "ask" }, agent: { reviewer: { permission: { edit: "deny" } } } }
    await hooks.config(config)
    assert.deepEqual(config.permission, { external_directory: { "*": "ask", ...rules(docs) }, edit: "ask" })
    assert.deepEqual(config.agent.reviewer.permission, { edit: "deny", external_directory: rules(operator) })
    // A whole-config permission string is left alone.
    const strict: any = { permission: "deny" }
    await hooks.config(strict)
    assert.equal(strict.permission, "deny")
  })

  it("saves notes with the remember tool, without touching the rest of the profiles", async () => {
    const file = path.join(home, "profiles.json")
    const team = await hooks.tool.remember.execute({ note: "Run make test before pushing.", scope: "team" }, { agent: "reviewer", sessionID: "sb1" })
    assert.equal(team, "Saved in the team memory.")
    const own = await hooks.tool.remember.execute({ note: "Webhooks live in api/webhook." }, { sessionID: "sb1" })
    assert.equal(own, "Saved in the memory of reviewer.")
    const saved = JSON.parse(fs.readFileSync(file, "utf8"))
    assert.equal(saved.team.context, "We ship Kubernetes operators.")
    assert.equal(saved.team.memory[0].by, "reviewer")
    assert.equal(saved.agents.reviewer.memory[0].text, "Webhooks live in api/webhook.")
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "sb1", model: {} }, output)
    assert.match(output.system[0], /## Memory\n.*\n- \[team, by reviewer\] Run make test before pushing\.\n- \[you\] Webhooks live in api\/webhook\./)
  })

  it("prompts a teammate in its own repository", async () => {
    calls.length = 0
    const result = await bridge.sendCommand(
      { pid: process.pid, dir: "/work/app" },
      { kind: "prompt", agent: "api-expert", mode: "all", text: "List the endpoints" },
      8000,
    )
    assert.equal(result.ok, true)
    const create = calls.find((c) => c[0] === "create")![1]
    assert.notEqual(create.query.directory, "/work/app")
    assert.equal(calls.find((c) => c[0] === "promptAsync")![1].body.agent, "ask")
  })
})
