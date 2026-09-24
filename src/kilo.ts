import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const PLUGIN_FILE = "star-ui-kilo.js"
export const KILO_EXTENSION_ID = "kilocode.kilo-code"
const SDK_PACKAGE = "@kilocode/plugin"

/** Kilo Code 7.0 moved to the Kilo engine (kilo serve + plugins); 4.x/5.x cannot load our plugin. */
export function isLegacyKilo(version: string | undefined): boolean {
  const major = Number(String(version ?? "").split(".")[0])
  return Number.isFinite(major) && major > 0 && major < 7
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p
}

/** Same resolution as Kilo itself: KILO_CONFIG_DIR, else $XDG_CONFIG_HOME/kilo, else ~/.config/kilo. */
export function kiloConfigDir(override?: string): string {
  if (override && override.trim()) return path.resolve(expandHome(override.trim()))
  if (process.env.KILO_CONFIG_DIR) return process.env.KILO_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, "kilo")
}

/** Where the extension and the plugin exchange files (bridge registry, team.json). */
export function starHome(): string {
  return process.env.STAR_UI_KILO_HOME || path.join(os.homedir(), ".star-ui-kilo")
}

export class PluginInstaller {
  constructor(
    private readonly bundledPlugin: string,
    private readonly configDir: () => string,
  ) {}

  get target(): string {
    return path.join(this.configDir(), "plugin", PLUGIN_FILE)
  }

  isInstalled(): boolean {
    return fs.existsSync(this.target)
  }

  isOutdated(): boolean {
    try {
      return fs.readFileSync(this.target, "utf8") !== fs.readFileSync(this.bundledPlugin, "utf8")
    } catch {
      return false
    }
  }

  install(): string {
    fs.mkdirSync(path.dirname(this.target), { recursive: true })
    fs.copyFileSync(this.bundledPlugin, this.target)
    return this.target
  }

  /** See prepareOfflineConfig. */
  prepareOffline(kiloVersion: string): OfflinePrep {
    return prepareOfflineConfig(this.configDir(), kiloVersion)
  }

  uninstall(): boolean {
    if (!this.isInstalled()) return false
    fs.rmSync(this.target, { force: true })
    return true
  }
}

export type OfflinePrep = "prepared" | "already" | "installed" | "other-plugins" | "unreadable"

function readJson(file: string): Record<string, any> | undefined {
  if (!fs.existsSync(file)) return undefined
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

/**
 * As soon as a Kilo config folder holds a local plugin, Kilo runs `npm install @kilocode/plugin` there and
 * waits for it before loading plugins: 70 s or more on every start when npm is unreachable. Our plugin does not use that package, so when it is the only plugin we
 * record the package as installed and Kilo skips the download. Other plugins may need the real package:
 * then, and whenever it is already installed, nothing is touched.
 */
export function prepareOfflineConfig(configDir: string, kiloVersion: string): OfflinePrep {
  const nodeModules = path.join(configDir, "node_modules")
  if (fs.existsSync(path.join(nodeModules, ...SDK_PACKAGE.split("/")))) return "installed"
  const others = ["plugin", "plugins"].flatMap((dir) => {
    try {
      return fs.readdirSync(path.join(configDir, dir)).filter((f) => /\.(js|ts)$/.test(f) && f !== PLUGIN_FILE)
    } catch {
      return []
    }
  })
  if (others.length) return "other-plugins"

  const pkgFile = path.join(configDir, "package.json")
  const lockFile = path.join(configDir, "package-lock.json")
  let pkg: Record<string, any>
  let lock: Record<string, any>
  try {
    pkg = readJson(pkgFile) ?? {}
    lock = readJson(lockFile) ?? { lockfileVersion: 3, requires: true, packages: {} }
  } catch {
    return "unreadable"
  }
  const root = ((lock.packages ??= {})[""] ??= {})
  const locked = (root.dependencies ??= {})
  const declared = (pkg.dependencies ??= {})
  if (locked[SDK_PACKAGE] && declared[SDK_PACKAGE] && fs.existsSync(nodeModules)) return "already"
  declared[SDK_PACKAGE] ??= kiloVersion
  locked[SDK_PACKAGE] ??= declared[SDK_PACKAGE]
  fs.mkdirSync(nodeModules, { recursive: true })
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n")
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n")
  return "prepared"
}
