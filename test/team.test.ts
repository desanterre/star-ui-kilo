import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, it } from "node:test"
import { ROLE_TEMPLATES, TEAM_PRESETS, readTeamFile, renderAgent, upsertTeammate, writeRoles } from "../src/team"
import { renderOfficeHtml } from "../src/webview"

describe("team templates", () => {
  it("renders Kilo agent files usable as primary agents and sub-agents", () => {
    const reviewer = ROLE_TEMPLATES.find((r) => r.id === "reviewer")!
    const md = renderAgent(reviewer)
    assert.match(md, /^---\ndescription: .+\nmode: all\ncolor: "#f59e0b"\npermission:\n {2}edit: deny\n---\n/)
  })

  it("makes the manager a primary agent that only delegates", () => {
    const md = renderAgent(ROLE_TEMPLATES.find((r) => r.id === "manager")!)
    assert.match(md, /\nmode: primary\n/)
    assert.match(md, /permission:\n {2}edit: deny\n {2}bash: deny\n/)
    assert.match(md, /`task` tool/)
  })

  it("offers presets whose roles all exist, with the manager selected", () => {
    for (const preset of TEAM_PRESETS) {
      for (const id of preset.roles) assert.ok(ROLE_TEMPLATES.find((r) => r.id === id), `${preset.id}: ${id}`)
      for (const id of preset.selected) assert.ok(preset.roles.includes(id), `${preset.id}: ${id} selected but not offered`)
      assert.ok(preset.selected.includes("manager"))
    }
    const ids = ROLE_TEMPLATES.map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length, "role ids are unique")
  })

  it("gives every teammate the shared report format", () => {
    for (const role of ROLE_TEMPLATES.filter((r) => r.id !== "manager")) assert.match(role.prompt, /## Report back/, role.id)
  })

  it("never overwrites an existing agent file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-team-"))
    fs.writeFileSync(path.join(dir, "reviewer.md"), "mine")
    const roles = ["architect", "developer", "reviewer"].map((id) => ROLE_TEMPLATES.find((r) => r.id === id)!)
    const { created, skipped } = writeRoles(dir, roles)
    assert.deepEqual(created, ["architect", "developer"])
    assert.deepEqual(skipped, ["reviewer"])
    assert.equal(fs.readFileSync(path.join(dir, "reviewer.md"), "utf8"), "mine")
  })

  it("adds and replaces cross-repo teammates by name", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "star-mates-")), "team.json")
    upsertTeammate(file, { name: "api", repo: "/a" })
    upsertTeammate(file, { name: "web", repo: "/w" })
    upsertTeammate(file, { name: "API", repo: "/a2", agent: "ask" })
    assert.deepEqual(readTeamFile(file).members, [
      { name: "web", repo: "/w" },
      { name: "API", repo: "/a2", agent: "ask" },
    ])
    assert.throws(() => upsertTeammate(file, { name: "no spaces", repo: "/x" }))
  })
})

describe("webview html", () => {
  it("locks scripts to a nonce and escapes boot data", () => {
    const html = renderOfficeHtml({
      mediaUri: "https://example/media/",
      cspSource: "https://example",
      language: "fr",
      officeName: "</script><script>alert(1)</script>",
      room: "office",
    })
    const nonce = html.match(/'nonce-([^']+)'/)![1]
    assert.equal((html.match(new RegExp(`nonce="${nonce.replace(/[+/=]/g, "\\$&")}"`, "g")) || []).length, 4)
    assert.ok(!html.includes("</script><script>alert(1)"))
    assert.match(html, /<html lang="fr">/)
    assert.match(html, /src="https:\/\/example\/media\/office\.js"/)
  })
})
