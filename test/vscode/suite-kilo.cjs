// Runs inside VS Code next to the real Kilo Code extension (see run-kilo.mjs).
const assert = require("node:assert/strict")
const vscode = require("vscode")

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await wait(500)
  }
  throw new Error("timed out")
}

exports.run = async function run() {
  const lines = []
  const log = (l) => (lines.push(l), console.log(l))
  const kilo = vscode.extensions.getExtension("kilocode.kilo-code")
  assert.ok(kilo, "Kilo Code is installed")
  log(`Kilo Code ${kilo.packageJSON.version}`)
  await vscode.extensions.getExtension("desanterre.star-ui-kilo").activate()
  await kilo.activate()
  // Opening Kilo Code makes it talk to its server about this workspace, which boots the Kilo instance.
  await vscode.commands.executeCommand("kilo-code.SidebarProvider.focus").then(undefined, () => {})
  await vscode.commands.executeCommand("starUiKilo.openOffice")

  const started = Date.now()
  const diag = await until(async () => {
    const d = await vscode.commands.executeCommand("starUiKilo.diagnostics")
    const names = [d.snapshot.main, ...d.snapshot.guests].filter(Boolean).map((c) => c.name)
    return d.snapshot.connection.canPrompt && names.includes("reviewer") ? { d, names } : undefined
  }, 120000)
  log(`✔ Kilo Code's own server loaded the plugin and the office is connected (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  log(`✔ team in the office: ${diag.names.join(", ")}`)
  assert.equal(diag.d.webviewErrors.length, 0, diag.d.webviewErrors.join("\n"))
  log(`✔ office webview: ready=${diag.d.webviewReady}, errors=0`)
  console.log("\n" + lines.join("\n"))
}
