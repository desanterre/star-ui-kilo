// Integration test with the real Kilo Code extension: VS Code + Kilo Code + Star UI, isolated profile and
// Kilo config (plugin pre-installed and the config folder prepared exactly like "Connect to Kilo Code" does).
// usage: code --extensions-dir /tmp/kilo-ext --install-extension kilocode.kilo-code
//        KILO_EXTENSIONS_DIR=/tmp/kilo-ext VSCODE_PATH=... npm run test:kilo
import { runTests } from "@vscode/test-electron"
import * as esbuild from "esbuild"
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const extensionsDir = process.env.KILO_EXTENSIONS_DIR
if (!extensionsDir) throw new Error("Set KILO_EXTENSIONS_DIR to a folder where kilocode.kilo-code is installed")

await esbuild.build({ entryPoints: ["src/kilo.ts"], outfile: "out/e2e/kilo.js", bundle: true, platform: "node", format: "cjs", logLevel: "warning" })
const { prepareOfflineConfig } = createRequire(import.meta.url)(resolve("out/e2e/kilo.js"))

const tmp = mkdtempSync(join(tmpdir(), "star-kilo-vscode-"))
const kiloConfig = join(tmp, "config", "kilo")
mkdirSync(join(kiloConfig, "plugin"), { recursive: true })
copyFileSync("plugin/star-ui-kilo.js", join(kiloConfig, "plugin", "star-ui-kilo.js"))
console.log(`Kilo config folder: ${prepareOfflineConfig(kiloConfig, "7.7.9")}`)
const workspace = join(tmp, "workspace")
mkdirSync(join(workspace, ".kilo", "agent"), { recursive: true })
writeFileSync(join(workspace, ".kilo", "agent", "reviewer.md"), "---\ndescription: Reviews changes.\nmode: all\n---\nYou review code.\n")

await runTests({
  vscodeExecutablePath: process.env.VSCODE_PATH || undefined,
  extensionDevelopmentPath: resolve("."),
  extensionTestsPath: resolve("test/vscode/suite-kilo.cjs"),
  launchArgs: [workspace, `--user-data-dir=${join(tmp, "user")}`, `--extensions-dir=${extensionsDir}`, "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"],
  extensionTestsEnv: {
    XDG_CONFIG_HOME: join(tmp, "config"),
    XDG_DATA_HOME: join(tmp, "data"),
    XDG_STATE_HOME: join(tmp, "state"),
    XDG_CACHE_HOME: join(tmp, "cache"),
    STAR_UI_KILO_HOME: join(tmp, "star"),
    npm_config_registry: "http://127.0.0.1:9",
  },
})
