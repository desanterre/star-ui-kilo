// Integration test: loads the extension in a real VS Code (isolated profile) and runs suite.cjs inside it.
// usage: npm run test:vscode   (VSCODE_PATH=/path/to/Electron to use a local VS Code instead of downloading one)
import { runTests } from "@vscode/test-electron"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "star-vscode-"))
await runTests({
  vscodeExecutablePath: process.env.VSCODE_PATH || undefined,
  extensionDevelopmentPath: resolve("."),
  extensionTestsPath: resolve("test/vscode/suite.cjs"),
  launchArgs: [join(tmp, "workspace"), `--user-data-dir=${join(tmp, "user")}`, `--extensions-dir=${join(tmp, "ext")}`, "--disable-extensions", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"],
  extensionTestsEnv: { STAR_UI_KILO_HOME: join(tmp, "star"), STAR_TEST_KILO_CONFIG: join(tmp, "kilo-config") },
})
