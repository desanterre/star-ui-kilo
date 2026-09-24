// Bundles the extension (and the tests / dev preview) with esbuild.
import * as esbuild from "esbuild"
import { readdirSync } from "node:fs"

const args = new Set(process.argv.slice(2))
const production = args.has("--production")

const extension = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
}

if (args.has("--tests")) {
  await esbuild.build({
    entryPoints: readdirSync("test")
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => `test/${f}`),
    outdir: "out/test",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: true,
    logLevel: "warning",
  })
} else if (args.has("--watch")) {
  const ctx = await esbuild.context(extension)
  await ctx.watch()
} else {
  await esbuild.build(extension)
}
