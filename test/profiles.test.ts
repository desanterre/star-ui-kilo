import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, it } from "node:test"
import { forgetNote, profilesFile, readProfile, saveProfile } from "../src/profiles"

describe("profiles", () => {
  it("saves one profile and keeps notes, other profiles and unknown keys", () => {
    const file = profilesFile(fs.mkdtempSync(path.join(os.tmpdir(), "star-profiles-")))
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        team: { context: "old", memory: [{ id: "n1", text: "keep me", at: 1, by: "tester" }] },
        agents: { architect: { context: "arch" } },
      }),
    )
    const first = saveProfile(file, { kind: "team" }, { context: "new", folders: [{ path: "/repos/api" }, { path: "  " }] })
    assert.deepEqual(first, { foldersChanged: true })
    const again = saveProfile(file, { kind: "team" }, { context: "newer", folders: [{ path: "/repos/api" }] })
    assert.deepEqual(again, { foldersChanged: false })
    assert.deepEqual(readProfile(file, { kind: "team" }), {
      context: "newer",
      folders: [{ path: path.resolve("/repos/api"), note: undefined }],
      memory: [{ id: "n1", text: "keep me", at: 1, by: "tester" }],
    })
    assert.equal(readProfile(file, { kind: "agent", name: "architect" }).context, "arch")
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 1)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)

    forgetNote(file, { kind: "team" }, "n1")
    assert.deepEqual(readProfile(file, { kind: "team" }).memory, [])
  })

  it("reads missing profiles as empty and rejects invalid agent names", () => {
    const file = profilesFile(fs.mkdtempSync(path.join(os.tmpdir(), "star-profiles-")))
    assert.deepEqual(readProfile(file, { kind: "agent", name: "developer" }), { context: "", folders: [], memory: [] })
    assert.throws(() => saveProfile(file, { kind: "agent", name: "../x" }, { context: "", folders: [] }))
  })
})
