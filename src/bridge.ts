import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"
import { instanceKey } from "./office"
import type { BridgePayload, PluginCommand, PluginResult } from "./protocol"

const MAX_BODY = 1024 * 1024
const POLL_HOLD_MS = 25_000

type CommandInput = PluginCommand extends infer C ? (C extends { id: string } ? Omit<C, "id"> : never) : never

interface Waiter {
  res: http.ServerResponse
  timer: NodeJS.Timeout
}

/**
 * Local HTTP endpoint the Kilo plugin talks to.
 * Listens on 127.0.0.1 only, on a random port, and requires a random bearer token.
 * Port and token are published in <home>/bridges/<pid>-<id>.json (mode 0600) for the plugin.
 */
export class Bridge {
  readonly token = crypto.randomBytes(24).toString("hex")
  port = 0
  private server?: http.Server
  private file?: string
  private readonly queues = new Map<string, PluginCommand[]>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly pending = new Map<string, { resolve: (r: PluginResult) => void; timer: NodeJS.Timeout }>()

  constructor(
    private readonly home: string,
    private readonly onEvents: (payload: BridgePayload) => void,
    private readonly version = "0",
  ) {}

  get registryFile(): string | undefined {
    return this.file
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => this.handle(req, res))
    server.keepAliveTimeout = 5_000
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    this.server = server
    this.port = (server.address() as { port: number }).port
    const dir = path.join(this.home, "bridges")
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = path.join(dir, `${process.pid}-${crypto.randomBytes(4).toString("hex")}.json`)
    fs.writeFileSync(
      this.file,
      JSON.stringify({ port: this.port, token: this.token, pid: process.pid, version: this.version }),
      { mode: 0o600 },
    )
    this.cleanupStale(dir)
  }

  /** Queues a command for one plugin instance and resolves with its result. */
  sendCommand(target: { pid?: number; dir?: string }, command: CommandInput, timeoutMs = 30_000): Promise<PluginResult> {
    const id = crypto.randomUUID()
    const cmd = { ...command, id } as PluginCommand
    const key = instanceKey(target.pid, target.dir)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const queue = this.queues.get(key)
        if (queue) this.queues.set(key, queue.filter((c) => c.id !== id))
        resolve({ id, ok: false, error: "Kilo did not pick up the request (is Kilo Code running?)" })
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      const queue = this.queues.get(key) ?? []
      queue.push(cmd)
      this.queues.set(key, queue)
      this.release(key)
    })
  }

  dispose(): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.res.end()
    }
    this.waiters.clear()
    for (const p of this.pending.values()) clearTimeout(p.timer)
    this.pending.clear()
    this.server?.close()
    this.server = undefined
    if (this.file) {
      try {
        fs.unlinkSync(this.file)
      } catch {}
    }
  }

  private release(key: string): void {
    const waiter = this.waiters.get(key)
    const queue = this.queues.get(key)
    if (!waiter || !queue?.length) return
    this.waiters.delete(key)
    clearTimeout(waiter.timer)
    this.queues.delete(key)
    json(waiter.res, 200, { commands: queue })
  }

  private authorized(req: http.IncomingMessage): boolean {
    // Browsers always send Origin on cross-site requests; the plugin never does.
    if (req.headers.origin) return false
    const header = req.headers.authorization ?? ""
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "")
    const expected = Buffer.from(this.token)
    return given.length === expected.length && crypto.timingSafeEqual(given, expected)
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.authorized(req)) return json(res, 401, { error: "unauthorized" })
    const url = new URL(req.url ?? "/", "http://127.0.0.1")

    if (req.method === "GET" && url.pathname === "/v1/health") return json(res, 200, { ok: true, name: "star-ui-kilo" })

    if (req.method === "GET" && url.pathname === "/v1/commands") {
      const key = instanceKey(Number(url.searchParams.get("pid")) || undefined, url.searchParams.get("dir") ?? undefined)
      const previous = this.waiters.get(key)
      if (previous) {
        clearTimeout(previous.timer)
        json(previous.res, 200, { commands: [] })
      }
      const timer = setTimeout(() => {
        if (this.waiters.get(key)?.res === res) this.waiters.delete(key)
        json(res, 200, { commands: [] })
      }, POLL_HOLD_MS)
      this.waiters.set(key, { res, timer })
      req.on("close", () => {
        if (this.waiters.get(key)?.res === res) {
          clearTimeout(timer)
          this.waiters.delete(key)
        }
      })
      this.release(key)
      return
    }

    if (req.method === "POST" && (url.pathname === "/v1/events" || url.pathname === "/v1/results")) {
      readJson(req)
        .then((body) => {
          if (url.pathname === "/v1/events") {
            const payload = body as BridgePayload
            if (payload && Array.isArray(payload.events)) this.onEvents(payload)
          } else {
            const results = (body as { results?: PluginResult[] })?.results
            for (const result of Array.isArray(results) ? results : []) {
              const pending = result && this.pending.get(result.id)
              if (!pending) continue
              clearTimeout(pending.timer)
              this.pending.delete(result.id)
              pending.resolve(result)
            }
          }
          json(res, 200, { ok: true })
        })
        .catch(() => json(res, 400, { error: "bad request" }))
      return
    }

    json(res, 404, { error: "not found" })
  }

  /** Removes registry files left behind by crashed VS Code windows. */
  private cleanupStale(dir: string): void {
    try {
      for (const name of fs.readdirSync(dir)) {
        const pid = Number(name.split("-")[0])
        if (!pid || pid === process.pid) continue
        try {
          process.kill(pid, 0)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") fs.rmSync(path.join(dir, name), { force: true })
        }
      }
    } catch {}
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error("payload too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (err) {
        reject(err)
      }
    })
    req.on("error", reject)
  })
}
