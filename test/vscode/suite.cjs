// Runs inside the VS Code extension host (see run.mjs).
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vscode = require("vscode")

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await wait(100)
  }
  throw new Error("timed out")
}

exports.run = async function run() {
  const results = []
  const test = async (name, fn) => {
    try {
      await fn()
      results.push(`✔ ${name}`)
    } catch (err) {
      results.push(`✖ ${name}: ${err && err.stack}`)
    }
  }
  const home = process.env.STAR_UI_KILO_HOME
  const kiloConfig = process.env.STAR_TEST_KILO_CONFIG
  await vscode.workspace.getConfiguration("starUiKilo").update("kiloConfigDir", kiloConfig, vscode.ConfigurationTarget.Global)

  await test("activates", async () => {
    const ext = vscode.extensions.getExtension("desanterre.star-ui-kilo")
    assert.ok(ext, "extension found")
    await ext.activate()
    assert.equal(ext.isActive, true)
  })

  await test("registers its commands", async () => {
    const all = await vscode.commands.getCommands(true)
    for (const id of ["openOffice", "connect", "disconnect", "createTeam", "addTeammate", "editTeamFile", "toggleDemo", "openKilo", "showLog"]) {
      assert.ok(all.includes(`starUiKilo.${id}`), id)
    }
  })

  let bridge
  await test("publishes a bridge for the Kilo plugin", async () => {
    const dir = path.join(home, "bridges")
    const file = await until(() => fs.existsSync(dir) && fs.readdirSync(dir).find((f) => f.startsWith(`${process.pid}-`)))
    bridge = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))
    const res = await fetch(`http://127.0.0.1:${bridge.port}/v1/health`, { headers: { authorization: `Bearer ${bridge.token}` } })
    assert.equal(res.status, 200)
  })

  await test("accepts plugin events from this window's Kilo", async () => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        source: { pid: 4242, parentPid: process.pid },
        events: [
          { t: "hello", version: "0.1.0", client: "vscode", commands: true, dir: "/w" },
          { t: "session", sid: "s1", agent: "code", title: "Hello" },
          { t: "status", sid: "s1", status: "busy" },
          { t: "ask", sid: "s1", rid: "p1", kind: "permission", label: "bash" },
        ],
      }),
    })
    assert.equal(res.status, 200)
  })

  await test("opens the office in an editor tab", async () => {
    await vscode.commands.executeCommand("starUiKilo.openOffice")
    await until(() =>
      vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === "Star Office")),
    )
  })

  await test("the office webview loads its scene without errors", async () => {
    const diag = await until(async () => {
      const d = await vscode.commands.executeCommand("starUiKilo.diagnostics")
      return d.webviewReady > 0 || d.webviewErrors.length ? d : undefined
    }, 20000)
    assert.deepEqual(diag.webviewErrors, [])
    assert.ok(diag.webviewReady > 0)
    assert.ok(diag.snapshot.main && diag.snapshot.main.name === "code", "main character from the plugin events")
    assert.deepEqual(diag.snapshot.main.waiting, { kind: "permission", label: "bash" })
  })

  await test("the ★ activity bar entry opens the office", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    await until(() => !vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === "Star Office")))
    await vscode.commands.executeCommand("starUiKilo.home.focus")
    await until(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === "Star Office")))
  })

  await test("opens the office panel view", async () => {
    await vscode.commands.executeCommand("starUiKilo.office.focus")
  })

  await test("toggles the demo", async () => {
    await vscode.commands.executeCommand("starUiKilo.toggleDemo")
    await wait(500)
    await vscode.commands.executeCommand("starUiKilo.toggleDemo")
  })

  await test("installs and removes the Kilo plugin", async () => {
    const target = path.join(kiloConfig, "plugin", "star-ui-kilo.js")
    void vscode.commands.executeCommand("starUiKilo.connect") // resolves when the notification is dismissed
    await until(() => fs.existsSync(target))
    const shipped = fs.readFileSync(path.join(vscode.extensions.getExtension("desanterre.star-ui-kilo").extensionPath, "plugin", "star-ui-kilo.js"), "utf8")
    assert.equal(fs.readFileSync(target, "utf8"), shipped)
    void vscode.commands.executeCommand("starUiKilo.disconnect")
    await until(() => !fs.existsSync(target))
  })

  console.log("\n" + results.join("\n"))
  const failed = results.filter((r) => r.startsWith("✖"))
  if (failed.length) throw new Error(`${failed.length} integration test(s) failed`)
}
