import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, it } from "node:test"
import { PLUGIN_FILE, prepareOfflineConfig } from "../src/kilo"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "star-kilo-"))
const json = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"))

describe("prepareOfflineConfig", () => {
  it("marks @kilocode/plugin as installed so Kilo never downloads it", () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, "plugin"))
    fs.writeFileSync(path.join(dir, "plugin", PLUGIN_FILE), "")
    assert.equal(prepareOfflineConfig(dir, "7.7.9"), "prepared")
    assert.ok(fs.existsSync(path.join(dir, "node_modules")))
    assert.equal(json(path.join(dir, "package.json")).dependencies["@kilocode/plugin"], "7.7.9")
    assert.equal(json(path.join(dir, "package-lock.json")).packages[""].dependencies["@kilocode/plugin"], "7.7.9")
    assert.equal(prepareOfflineConfig(dir, "7.7.9"), "already")
  })

  it("keeps the user's own package.json and lock entries", () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "mine", dependencies: { left: "1.0.0" } }))
    fs.writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { left: "1.0.0" } }, "node_modules/left": { version: "1.0.0" } } }),
    )
    assert.equal(prepareOfflineConfig(dir, "7.7.9"), "prepared")
    const pkg = json(path.join(dir, "package.json"))
    assert.equal(pkg.name, "mine")
    assert.deepEqual(pkg.dependencies, { left: "1.0.0", "@kilocode/plugin": "7.7.9" })
    const lock = json(path.join(dir, "package-lock.json"))
    assert.equal(lock.packages["node_modules/left"].version, "1.0.0")
    assert.deepEqual(lock.packages[""].dependencies, { left: "1.0.0", "@kilocode/plugin": "7.7.9" })
  })

  it("leaves Kilo alone when other plugins may need the real package, or when it is installed", () => {
    const withOther = tmp()
    fs.mkdirSync(path.join(withOther, "plugins"))
    fs.writeFileSync(path.join(withOther, "plugins", "theirs.ts"), "")
    assert.equal(prepareOfflineConfig(withOther, "7.7.9"), "other-plugins")
    assert.ok(!fs.existsSync(path.join(withOther, "package.json")))

    const installed = tmp()
    fs.mkdirSync(path.join(installed, "node_modules", "@kilocode", "plugin"), { recursive: true })
    assert.equal(prepareOfflineConfig(installed, "7.7.9"), "installed")
  })

  it("never overwrites an unreadable package.json", () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, "package.json"), "{ not json")
    assert.equal(prepareOfflineConfig(dir, "7.7.9"), "unreadable")
    assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), "{ not json")
  })
})
