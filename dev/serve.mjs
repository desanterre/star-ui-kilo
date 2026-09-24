// Minimal static server for the dev preview (repository root, localhost only).
import { createReadStream, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, normalize, resolve } from "node:path"

const root = resolve(".")
const port = Number(process.env.PORT || 5317)
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" }

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost")
  const file = normalize(join(root, decodeURIComponent(url.pathname === "/" ? "/dev/out/index.html" : url.pathname)))
  try {
    if (!file.startsWith(root) || !statSync(file).isFile()) throw new Error()
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" })
    createReadStream(file).pipe(res)
  } catch {
    res.writeHead(404).end("not found")
  }
}).listen(port, "localhost", () => console.log(`preview on http://localhost:${port}/`))
