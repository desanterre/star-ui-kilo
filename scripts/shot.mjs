// Dev helper: screenshot a page of the preview server with headless Chrome.
// usage: node scripts/shot.mjs <url> <out.png> <width> <height> [budgetMs]
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [url, out, width, height, budget = "4000"] = process.argv.slice(2)
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const profile = mkdtempSync(join(tmpdir(), "star-shot-"))
const before = existsSync(out) ? statSync(out).mtimeMs : 0
const proc = spawn(chrome, [
  "--headless=new", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--default-background-color=00000000",
  `--window-size=${width},${height}`, "--force-device-scale-factor=1",
  `--virtual-time-budget=${budget}`, `--user-data-dir=${profile}`, `--screenshot=${out}`, url,
], { stdio: "ignore" })
const started = Date.now()
const timer = setInterval(() => {
  const done = existsSync(out) && statSync(out).mtimeMs > before
  if (done || Date.now() - started > 90_000) {
    clearInterval(timer)
    proc.kill("SIGKILL")
    rmSync(profile, { recursive: true, force: true })
    console.log(done ? `wrote ${out}` : "timed out")
    process.exit(done ? 0 : 1)
  }
}, 250)
