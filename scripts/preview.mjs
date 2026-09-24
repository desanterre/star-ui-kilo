// Builds dev/out/index.html: the real office page, driven by dev/host.ts instead of VS Code.
// `node dev/serve.mjs` then serves it at http://localhost:5317/ (see README "Development").
import * as esbuild from "esbuild"
import { mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"

mkdirSync("dev/out", { recursive: true })
await esbuild.build({ entryPoints: ["dev/host.ts"], outfile: "dev/out/host.js", bundle: true, platform: "browser", format: "iife", logLevel: "warning" })
await esbuild.build({ entryPoints: ["src/webview.ts"], outfile: "dev/out/webview.cjs", bundle: true, platform: "node", format: "cjs", logLevel: "warning" })

const { renderOfficeHtml } = createRequire(import.meta.url)("../dev/out/webview.cjs")
let html = renderOfficeHtml({ mediaUri: "/media", cspSource: "", language: "en", officeName: "", room: "office" })
const nonce = html.match(/nonce="([^"]+)"/)[1]
html = html.replace(`<script nonce="${nonce}" src="/media/office.js">`, `<script nonce="${nonce}" src="/dev/out/host.js"></script>\n<script nonce="${nonce}" src="/media/office.js">`)
writeFileSync("dev/out/index.html", html)
console.log("dev/out/index.html ready")
