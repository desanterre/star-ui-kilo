import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import { Bridge } from "./bridge"
import { DemoDriver } from "./demo"
import { KILO_EXTENSION_ID, PluginInstaller, isLegacyKilo, kiloConfigDir, starHome } from "./kilo"
import { OfficeModel } from "./office"
import type {
  BridgeEvent,
  BridgeSource,
  ConnectionInfo,
  FromWebview,
  OfficeSnapshot,
  PluginResult,
  ToWebview,
  TranscriptMessage,
  WebviewCommand,
  WebviewSettings,
} from "./protocol"
import { ROLE_TEMPLATES, TEAMMATE_NAME, TEAM_PRESETS, upsertTeammate, writeRoles } from "./team"
import { renderOfficeHtml } from "./webview"

const VIEW_ID = "starUiKilo.office"
const CONFIG = "starUiKilo"

export function activate(context: vscode.ExtensionContext): void {
  const office = new StarOffice(context)
  context.subscriptions.push(office)
  void office.start()
}

export function deactivate(): void {}

// Plugins older than 0.1.4 answer "invalid command" to the chat and stop commands.
const OUTDATED_PLUGIN_ERROR = "invalid command"
const OUTDATED_PLUGIN = "Kilo Code is still running the previous Star UI plugin: reload the window to use the new one."
const explainError = (error?: string) => (error === OUTDATED_PLUGIN_ERROR ? OUTDATED_PLUGIN : error)

class StarOffice implements vscode.Disposable, vscode.WebviewViewProvider {
  private readonly output = vscode.window.createOutputChannel("Star UI for Kilo")
  private readonly model: OfficeModel
  private readonly bridge: Bridge
  private readonly installer: PluginInstaller
  private readonly demo: DemoDriver
  private readonly webviews = new Set<vscode.Webview>()
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  private panel?: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []
  private broadcastTimer?: NodeJS.Timeout
  private ticker?: NodeJS.Timeout
  private lastSent = ""
  private readonly diagnostics = { webviewReady: 0, webviewErrors: [] as string[] }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.model = new OfficeModel({ accept: (source, dir) => this.accept(source, dir) })
    this.applyModelOptions()
    this.bridge = new Bridge(starHome(), (payload) => this.onPayload(payload.events, payload.source), context.extension.packageJSON.version)
    this.installer = new PluginInstaller(
      path.join(context.extensionPath, "plugin", "star-ui-kilo.js"),
      () => kiloConfigDir(this.cfg().get<string>("kiloConfigDir")),
    )
    this.demo = new DemoDriver((ev) => this.onPayload([ev], { pid: -1, parentPid: process.pid }))
  }

  async start(): Promise<void> {
    const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
      this.disposables.push(vscode.commands.registerCommand(id, fn))
    reg("starUiKilo.openOffice", () => this.openPanel())
    reg("starUiKilo.connect", () => this.connect())
    reg("starUiKilo.disconnect", () => this.disconnect())
    reg("starUiKilo.toggleDemo", () => this.toggleDemo())
    reg("starUiKilo.createTeam", () => this.createTeam())
    reg("starUiKilo.addTeammate", () => this.addTeammate())
    reg("starUiKilo.editTeamFile", () => this.editTeamFile())
    reg("starUiKilo.openKilo", () => this.openKilo())
    reg("starUiKilo.showLog", () => this.output.show())
    // Not contributed to the palette: used by the integration tests and for bug reports.
    reg("starUiKilo.diagnostics", () => ({ ...this.diagnostics, bridgePort: this.bridge.port, snapshot: this.snapshot() }))

    // Activity bar entry: an empty view whose welcome content holds the main actions.
    // Clicking the ★ icon opens the office itself.
    const home = vscode.window.createTreeView("starUiKilo.home", { treeDataProvider: { getTreeItem: (e: vscode.TreeItem) => e, getChildren: () => [] } })
    home.onDidChangeVisibility((e) => {
      if (e.visible) this.openPanel(true)
    })
    this.disposables.push(
      home,
      vscode.window.registerWebviewViewProvider(VIEW_ID, this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(CONFIG)) return
        this.applyModelOptions()
        this.post({ type: "settings", settings: this.settings() })
        this.scheduleBroadcast()
      }),
    )

    this.statusBar.command = "starUiKilo.openOffice"
    this.updateStatusBar(this.snapshot())

    try {
      await this.bridge.start()
      this.log(`Bridge listening on 127.0.0.1:${this.bridge.port} (${this.bridge.registryFile})`)
    } catch (err) {
      this.log(`Could not start the local bridge: ${String(err)}`)
      void vscode.window.showErrorMessage(`Star UI for Kilo: could not start the local bridge (${String(err)}).`)
    }

    this.ticker = setInterval(() => {
      this.model.prune()
      this.scheduleBroadcast()
    }, 1000)

    await this.maybeUpdatePlugin()
    if (!this.context.globalState.get("welcomed")) {
      await this.context.globalState.update("welcomed", true)
      this.openPanel(true)
    }
    await this.warnLegacyKilo()
    await this.maybeOfferConnect()
  }

  dispose(): void {
    this.demo.stop()
    this.bridge.dispose()
    if (this.ticker) clearInterval(this.ticker)
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer)
    this.panel?.dispose()
    this.statusBar.dispose()
    this.output.dispose()
    for (const d of this.disposables) d.dispose()
  }

  // ---------- webviews ----------
  resolveWebviewView(view: vscode.WebviewView): void {
    this.attach(view.webview)
    view.onDidDispose(() => this.webviews.delete(view.webview))
  }

  private openPanel(preserveFocus = false): void {
    if (this.panel) {
      try {
        this.panel.reveal(undefined, preserveFocus)
        return
      } catch {
        // Closed a moment ago: its dispose event has not reached us yet.
        this.panel = undefined
      }
    }
    const panel = vscode.window.createWebviewPanel("starUiKilo.officePanel", "Star Office", { viewColumn: vscode.ViewColumn.Active, preserveFocus }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    })
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "images", "icon.png")
    this.panel = panel
    this.attach(panel.webview)
    panel.onDidDispose(() => {
      this.webviews.delete(panel.webview)
      this.panel = undefined
    })
  }

  private attach(webview: vscode.Webview): void {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media")
    webview.options = { enableScripts: true, localResourceRoots: [media] }
    const settings = this.settings()
    webview.html = renderOfficeHtml({
      mediaUri: webview.asWebviewUri(media).toString(),
      cspSource: webview.cspSource,
      language: settings.language,
      officeName: settings.officeName,
      room: settings.room,
    })
    webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(webview, msg))
    this.webviews.add(webview)
  }

  private async onMessage(webview: vscode.Webview, msg: FromWebview): Promise<void> {
    switch (msg?.type) {
      case "ready":
        await webview.postMessage({ type: "init", settings: this.settings(), snapshot: this.snapshot() } satisfies ToWebview)
        return
      case "command":
        await this.runWebviewCommand(msg.command)
        return
      case "prompt": {
        const result = await this.prompt(msg.agent, msg.text, msg.continueSession)
        await webview.postMessage({
          type: "promptResult",
          requestId: msg.requestId,
          ok: result.ok,
          error: result.error,
          sessionID: result.sessionID,
        } satisfies ToWebview)
        return
      }
      case "openSession":
        return this.openSession(msg.agent)
      case "stop":
        await this.stop(msg.agent, msg.meetingID)
        return
      case "transcript": {
        const reply = msg.target.kind === "meeting" ? await this.meetingTranscript(msg.target.id) : await this.transcript(msg.target.name)
        await webview.postMessage({ type: "transcript", requestId: msg.requestId, target: msg.target, ...reply } satisfies ToWebview)
        return
      }
      case "meetingPrompt": {
        const result = await this.meetingPrompt(msg.meetingID, msg.text, msg.stopFirst)
        await webview.postMessage({
          type: "promptResult",
          requestId: msg.requestId,
          ok: result.ok,
          error: result.error,
          sessionID: result.sessionID,
        } satisfies ToWebview)
        return
      }
      case "log":
        if (msg.level === "error") this.diagnostics.webviewErrors.push(String(msg.message).slice(0, 500))
        else if (msg.message === "office ready") this.diagnostics.webviewReady++
        this.log(`[webview] ${msg.level}: ${String(msg.message).slice(0, 500)}`)
        return
    }
  }

  private runWebviewCommand(command: WebviewCommand): unknown {
    switch (command) {
      case "connect":
        return this.connect()
      case "disconnect":
        return this.disconnect()
      case "toggleDemo":
        return this.toggleDemo()
      case "openKilo":
        return this.openKilo()
      case "createTeam":
        return this.createTeam()
      case "openSettings":
        return vscode.commands.executeCommand("workbench.action.openSettings", CONFIG)
    }
  }

  private post(msg: ToWebview): void {
    for (const webview of this.webviews) void webview.postMessage(msg)
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined
      const snapshot = this.snapshot()
      // The timestamp moves on every event; compare without it to avoid useless repaints.
      const key = JSON.stringify({ ...snapshot, connection: { ...snapshot.connection, lastEventAt: 0 } })
      this.updateStatusBar(snapshot)
      if (key === this.lastSent) return
      this.lastSent = key
      this.post({ type: "snapshot", snapshot })
    }, 120)
  }

  // ---------- model ----------
  private onPayload(events: BridgeEvent[], source: BridgeSource | undefined): void {
    let changed = false
    const now = Date.now()
    for (const ev of events) {
      try {
        if (this.model.apply(ev, now, source)) changed = true
      } catch (err) {
        this.log(`Ignored malformed event: ${String(err)}`)
      }
    }
    if (changed) this.scheduleBroadcast()
  }

  private accept(source: BridgeSource | undefined, dir: string | undefined): boolean {
    if (this.cfg().get<string>("scope", "workspace") === "all") return true
    // Kilo Code started by this very VS Code window (same extension host).
    if (source?.parentPid && source.parentPid === process.pid) return true
    const folders = vscode.workspace.workspaceFolders ?? []
    if (!dir || !folders.length) return true
    return folders.some((f) => isInside(dir, f.uri.fsPath))
  }

  private applyModelOptions(): void {
    const cfg = this.cfg()
    this.model.opts.showBuiltInAgents = cfg.get<boolean>("showBuiltInAgents", true)
    this.model.opts.lingerMs = Math.max(0, cfg.get<number>("lingerSeconds", 20)) * 1000
  }

  private connection(): ConnectionInfo {
    const lastEventAt = this.model.lastEventAt
    const live = this.model.liveInstances().length > 0 || (!!lastEventAt && Date.now() - lastEventAt < 90_000)
    const kiloVersion = vscode.extensions.getExtension(KILO_EXTENSION_ID)?.packageJSON?.version as string | undefined
    return {
      pluginInstalled: this.installer.isInstalled(),
      kiloDetected: !!kiloVersion || fs.existsSync(kiloConfigDir(this.cfg().get("kiloConfigDir"))),
      kiloLegacyVersion: isLegacyKilo(kiloVersion) ? kiloVersion : undefined,
      live: live && !this.demo.active,
      canPrompt: this.demo.active,
      demo: this.demo.active,
    }
  }

  private snapshot(): OfficeSnapshot {
    return this.model.snapshot(this.connection())
  }

  private settings(): WebviewSettings {
    const cfg = this.cfg()
    const pref = cfg.get<string>("language", "en")
    return {
      language: pref === "auto" ? (vscode.env.language.startsWith("fr") ? "fr" : "en") : pref === "fr" ? "fr" : "en",
      officeName: cfg.get<string>("officeName", ""),
      room: cfg.get<string>("room", "office") === "lodge" ? "lodge" : "office",
    }
  }

  private updateStatusBar(snapshot: OfficeSnapshot): void {
    if (!this.cfg().get<boolean>("statusBar", true)) {
      this.statusBar.hide()
      return
    }
    const chars = [snapshot.main, ...snapshot.guests].filter((c) => !!c)
    const busy = chars.filter((c) => c!.busy).length
    const waiting = chars.filter((c) => c!.waiting).length
    this.statusBar.text = waiting ? `$(bell-dot) Star Office · ${waiting}` : busy ? `$(sync~spin) Star Office · ${busy}` : "$(star-full) Star Office"
    this.statusBar.tooltip = waiting
      ? `${waiting} agent(s) waiting for you in Kilo Code`
      : busy
        ? `${busy} agent(s) at work`
        : snapshot.connection.pluginInstalled
          ? "Open the Star Office"
          : "Star Office is not connected to Kilo Code"
    this.statusBar.backgroundColor = waiting ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined
    this.statusBar.show()
  }

  // ---------- prompting ----------
  private async prompt(agent: string, text: string, continueSession: boolean): Promise<PluginResult> {
    const clean = String(text ?? "").trim()
    if (!clean) return { id: "", ok: false, error: "Empty prompt" }
    const char = this.model.getCharacter(agent)
    const sessionID = continueSession && char && !char.isSubagent ? char.sessionID : undefined
    return this.sendPrompt(agent, clean, sessionID, char && !char.teammate ? char.sessionDir : undefined)
  }

  private async sendPrompt(agent: string, clean: string, sessionID?: string, dir?: string): Promise<PluginResult> {
    if (this.demo.active) {
      const sid = this.demo.prompt(agent, clean)
      this.model.notePrompt(agent, clean)
      this.scheduleBroadcast()
      return { id: "", ok: true, sessionID: sid }
    }
    const char = this.model.getCharacter(agent)
    const target = this.model.liveInstances(dir, process.pid)[0]
    if (!target) {
      return {
        id: "",
        ok: false,
        error: this.installer.isInstalled()
          ? "Kilo Code is not answering yet. Open Kilo Code once (or reload the window) and try again."
          : "Star Office is not connected to Kilo Code. Click “Connect Kilo” first.",
      }
    }
    this.log(`Prompting ${agent} via Kilo pid ${target.pid} (${target.dir ?? "?"})${sessionID ? ` in ${sessionID}` : ""}`)
    const result = await this.bridge.sendCommand(
      { pid: target.pid, dir: target.dir },
      { kind: "prompt", agent, mode: char?.mode ?? "primary", text: clean, sessionID, model: this.kiloDefaultModel() },
    )
    if (result.ok) {
      this.model.notePrompt(agent, clean)
      this.scheduleBroadcast()
      if (result.sessionID && this.cfg().get<boolean>("openConversationAfterPrompt", false)) {
        void this.openKiloSession(result.sessionID, agent, char?.teammate ? char.repo : target.dir)
      }
    } else {
      this.log(`Prompt to ${agent} failed: ${result.error}`)
    }
    return result
  }

  /** Kilo Code's "default model for new sessions" settings (kilo-code.new.model.*). */
  private kiloDefaultModel(): { providerID: string; modelID: string } | undefined {
    const cfg = vscode.workspace.getConfiguration("kilo-code.new.model")
    const providerID = cfg.get<string>("providerID")
    const modelID = cfg.get<string>("modelID")
    return providerID && modelID ? { providerID, modelID } : undefined
  }

  /** Stops a meeting, one character's running sessions, or everyone's. */
  private async stop(agent?: string, meetingID?: string): Promise<void> {
    const sessions = meetingID ? this.model.busySessionsOfMeeting(meetingID) : this.model.busySessions(agent)
    if (!sessions.length) return
    this.log(`Stopping ${meetingID ? `meeting ${meetingID}` : (agent ?? "everyone")}: ${sessions.map((s) => s.sessionID).join(", ")}`)
    if (this.demo.active) {
      this.demo.abort(sessions.map((s) => s.sessionID))
      return
    }
    const target = this.model.liveInstances(sessions[0].dir, process.pid)[0]
    if (!target) {
      void vscode.window.showWarningMessage("Kilo Code is not connected: nothing was stopped.")
      return
    }
    const result = await this.bridge.sendCommand({ pid: target.pid, dir: target.dir }, { kind: "abort", sessions })
    if (result.ok) return
    this.log(`Stop failed: ${result.error}`)
    if (result.error === OUTDATED_PLUGIN_ERROR) {
      const pick = await vscode.window.showWarningMessage(`Nothing was stopped. ${OUTDATED_PLUGIN}`, "Reload Window")
      if (pick) await vscode.commands.executeCommand("workbench.action.reloadWindow")
    }
  }

  /** Conversation of a character's current session, for the office chat. */
  private async transcript(agent: string): Promise<{ sessionID?: string; messages?: TranscriptMessage[]; error?: string }> {
    const char = this.model.getCharacter(agent)
    if (!char?.sessionID) return { messages: [] }
    if (this.demo.active) return { sessionID: char.sessionID, messages: this.demo.transcript(agent, char.sessionTitle) }
    const target = this.model.liveInstances(char.teammate ? undefined : char.sessionDir, process.pid)[0]
    if (!target) return { sessionID: char.sessionID, error: "Kilo Code is not connected." }
    const result = await this.bridge.sendCommand(
      { pid: target.pid, dir: target.dir },
      { kind: "messages", sessionID: char.sessionID, dir: char.sessionDir },
      10_000,
    )
    if (!result.ok) return { sessionID: char.sessionID, error: explainError(result.error) }
    const messages = (result.data ?? []).map((m) => ({ ...m, speaker: m.role === "user" ? undefined : agent }))
    return { sessionID: char.sessionID, messages }
  }

  /** Every conversation of a meeting, merged in time order, with who talks to whom. */
  private async meetingTranscript(meetingID: string): Promise<{ sessionID?: string; messages?: TranscriptMessage[]; error?: string }> {
    const sessions = this.model.meetingSessions(meetingID)
    if (!sessions.length) return { messages: [] }
    const rootSpeaker = sessions[0].sessionID === meetingID ? sessions[0].speaker : undefined
    if (this.demo.active) return { sessionID: meetingID, messages: this.demo.meetingTranscript(sessions.map((s) => s.speaker)) }
    const target = this.model.liveInstances(sessions[0].dir, process.pid)[0]
    if (!target) return { sessionID: meetingID, error: "Kilo Code is not connected." }
    const results = await Promise.all(
      sessions.map((s) =>
        this.bridge.sendCommand({ pid: target.pid, dir: target.dir }, { kind: "messages", sessionID: s.sessionID, dir: s.dir }, 10_000),
      ),
    )
    const merged: TranscriptMessage[] = []
    results.forEach((result, i) => {
      const s = sessions[i]
      const isRoot = s.sessionID === meetingID
      for (const m of result.ok ? (result.data ?? []) : []) {
        if (m.role === "assistant") merged.push({ ...m, speaker: s.speaker })
        else if (isRoot) merged.push({ ...m, speaker: undefined })
        else merged.push({ ...m, speaker: rootSpeaker ?? "manager", to: s.speaker })
      }
    })
    merged.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
    const failed = results.find((r) => !r.ok)
    return { sessionID: meetingID, messages: merged, error: merged.length ? undefined : explainError(failed?.error) }
  }

  /** Talks to a whole meeting through its root agent; optionally stops the team first to redirect it. */
  private async meetingPrompt(meetingID: string, text: string, stopFirst: boolean): Promise<PluginResult> {
    const clean = String(text ?? "").trim()
    if (!clean) return { id: "", ok: false, error: "Empty message" }
    const root = this.model.meetingSessions(meetingID).find((s) => s.sessionID === meetingID)
    if (!root) return { id: "", ok: false, error: "This conversation is not available any more." }
    if (stopFirst) {
      await this.stop(undefined, meetingID)
      await new Promise((r) => setTimeout(r, 600))
    }
    return this.sendPrompt(root.speaker, clean, meetingID, root.dir)
  }

  private async openSession(agent: string): Promise<void> {
    const char = this.model.getCharacter(agent)
    if (!char?.sessionID) return this.openKilo()
    await this.openKiloSession(char.sessionID, char.sessionTitle ?? agent, char.sessionDir)
  }

  private async openKiloSession(sessionID: string, title: string, dir?: string): Promise<void> {
    try {
      await vscode.commands.executeCommand("kilo-code.new.openSubAgentViewer", sessionID, title, dir)
    } catch (err) {
      this.log(`Could not open session ${sessionID} in Kilo Code: ${String(err)}`)
      await this.openKilo()
    }
  }

  private async openKilo(): Promise<void> {
    if (!vscode.extensions.getExtension(KILO_EXTENSION_ID)) {
      const pick = await vscode.window.showInformationMessage("Kilo Code is not installed in this VS Code.", "Show Kilo Code")
      if (pick) await vscode.commands.executeCommand("workbench.extensions.search", KILO_EXTENSION_ID)
      return
    }
    try {
      await vscode.commands.executeCommand("kilo-code.SidebarProvider.focus")
    } catch {
      await vscode.commands.executeCommand("workbench.view.extension.kilo-code-ActivityBar")
    }
  }

  // ---------- plugin install ----------
  private kiloVersion(): string {
    return vscode.extensions.getExtension(KILO_EXTENSION_ID)?.packageJSON?.version ?? "latest"
  }

  private prepareOffline(): void {
    try {
      this.log(`Kilo config dependency check: ${this.installer.prepareOffline(this.kiloVersion())}`)
    } catch (err) {
      this.log(`Could not prepare the Kilo config folder: ${String(err)}`)
    }
  }

  private async connect(): Promise<void> {
    try {
      const file = this.installer.install()
      this.prepareOffline()
      this.log(`Installed Kilo plugin at ${file}`)
      await this.context.globalState.update("pluginVersion", this.context.extension.packageJSON.version)
      this.scheduleBroadcast()
      const pick = await vscode.window.showInformationMessage(
        `Star Office is connected: the Kilo plugin was installed in ${file}. Reload the window so Kilo Code loads it.`,
        "Reload Window",
      )
      if (pick) await vscode.commands.executeCommand("workbench.action.reloadWindow")
    } catch (err) {
      void vscode.window.showErrorMessage(`Star UI for Kilo: could not install the Kilo plugin (${String(err)}).`)
    }
  }

  private async disconnect(): Promise<void> {
    const removed = this.installer.uninstall()
    this.log(removed ? `Removed ${this.installer.target}` : "Plugin was not installed")
    this.scheduleBroadcast()
    const pick = await vscode.window.showInformationMessage(
      removed ? "The Kilo plugin was removed. Reload the window to stop it." : "The Kilo plugin was not installed.",
      ...(removed ? ["Reload Window"] : []),
    )
    if (pick) await vscode.commands.executeCommand("workbench.action.reloadWindow")
  }

  private async maybeUpdatePlugin(): Promise<void> {
    if (!this.installer.isInstalled()) return
    this.prepareOffline()
    if (!this.installer.isOutdated()) return
    try {
      this.installer.install()
      this.log("Updated the Kilo plugin to the version bundled with this extension")
      const pick = await vscode.window.showInformationMessage(
        "Star UI for Kilo updated its Kilo plugin. Reload the window to use the new version.",
        "Reload Window",
      )
      if (pick) await vscode.commands.executeCommand("workbench.action.reloadWindow")
    } catch (err) {
      this.log(`Could not update the Kilo plugin: ${String(err)}`)
    }
  }

  private async maybeOfferConnect(): Promise<void> {
    if (this.installer.isInstalled() || this.context.globalState.get("connectOffered")) return
    if (!this.connection().kiloDetected) return
    await this.context.globalState.update("connectOffered", true)
    const pick = await vscode.window.showInformationMessage(
      "Star UI for Kilo: connect the pixel office to Kilo Code? This installs a small local plugin in your Kilo config folder.",
      "Connect",
      "Try the demo",
      "Not now",
    )
    if (pick === "Connect") await this.connect()
    if (pick === "Try the demo") {
      if (!this.demo.active) this.toggleDemo()
      this.openPanel()
    }
  }

  private async warnLegacyKilo(): Promise<void> {
    const version = this.connection().kiloLegacyVersion
    if (!version) return
    this.log(`Kilo Code ${version} predates the Kilo engine (7.0); it cannot load the Star UI plugin`)
    const pick = await vscode.window.showWarningMessage(
      `Star UI needs Kilo Code 7 or later. This VS Code has Kilo Code ${version}, which uses the legacy engine without plugins.`,
      "Update Kilo Code",
    )
    if (pick) await vscode.commands.executeCommand("workbench.extensions.search", KILO_EXTENSION_ID)
  }

  private toggleDemo(): void {
    if (this.demo.active) {
      this.demo.stop()
      this.model.clear()
    } else {
      this.model.clear()
      this.demo.start()
    }
    this.scheduleBroadcast()
  }

  // ---------- team ----------
  private async createTeam(): Promise<void> {
    const preset = await vscode.window.showQuickPick(
      TEAM_PRESETS.map((p) => ({ label: p.label, detail: p.detail, preset: p })),
      { title: "Create a virtual team of Kilo agents", placeHolder: "Pick a kind of team" },
    )
    if (!preset) return
    const roles = preset.preset.roles.map((id) => ROLE_TEMPLATES.find((r) => r.id === id)).filter((r) => !!r)
    const picks = await vscode.window.showQuickPick(
      roles.map((r) => ({ label: r.label, description: r.id, detail: r.description, picked: preset.preset.selected.includes(r.id), role: r })),
      { canPickMany: true, title: `${preset.preset.label}: team members`, placeHolder: "Pick the team members" },
    )
    if (!picks?.length) return
    const folders = vscode.workspace.workspaceFolders ?? []
    const targets: { label: string; description: string; dir: string }[] = folders.map((f) => ({
      label: `Project: ${f.name}`,
      description: ".kilo/agent/ (can be committed and shared)",
      dir: path.join(f.uri.fsPath, ".kilo", "agent"),
    }))
    targets.push({
      label: "Global",
      description: "~/.config/kilo/agent/ (all your projects)",
      dir: path.join(kiloConfigDir(this.cfg().get("kiloConfigDir")), "agent"),
    })
    const target = targets.length === 1 ? targets[0] : await vscode.window.showQuickPick(targets, { title: "Where should the team live?" })
    if (!target) return
    try {
      const { created, skipped } = writeRoles(
        target.dir,
        picks.map((p) => p.role),
      )
      this.log(`Team written to ${target.dir}: created ${created.join(", ") || "none"}, kept ${skipped.join(", ") || "none"}`)
      const pick = await vscode.window.showInformationMessage(
        `Team ready in ${target.dir}` +
          (created.length ? ` (new: ${created.join(", ")})` : "") +
          (skipped.length ? ` (already there: ${skipped.join(", ")})` : "") +
          ". Reload the window so Kilo Code meets them.",
        "Reload Window",
        "Open folder",
      )
      if (pick === "Reload Window") await vscode.commands.executeCommand("workbench.action.reloadWindow")
      if (pick === "Open folder") await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(target.dir))
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not create the team: ${String(err)}`)
    }
  }

  private async addTeammate(): Promise<void> {
    const folder = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: "Pick the repository this teammate specializes in",
      openLabel: "Select repository",
    })
    if (!folder?.[0]) return
    const repo = folder[0].fsPath
    const name = await vscode.window.showInputBox({
      title: "Teammate name",
      value: `${path.basename(repo).replace(/[^\w.-]/g, "-")}-expert`.slice(0, 40),
      validateInput: (v) => (TEAMMATE_NAME.test(v) ? undefined : "Letters, digits, dot, dash or underscore (max 40)"),
    })
    if (!name) return
    const agent = await vscode.window.showInputBox({
      title: "Kilo agent used by this teammate (in its repository)",
      value: "code",
      prompt: "Use a read-only agent (e.g. 'ask' or a custom agent with edit: deny) for a safe consultant.",
    })
    if (agent === undefined) return
    const description = await vscode.window.showInputBox({
      title: "What does this teammate know? (shown to the other agents)",
      value: `Specialist of the ${path.basename(repo)} repository`,
    })
    if (description === undefined) return
    const file = path.join(starHome(), "team.json")
    try {
      upsertTeammate(file, { name, repo, agent: agent || "code", description })
      const pick = await vscode.window.showInformationMessage(
        `${name} joined the team (${file}). Reload the window so Kilo Code gets the ask_teammate tool.`,
        "Reload Window",
        "Edit team file",
      )
      if (pick === "Reload Window") await vscode.commands.executeCommand("workbench.action.reloadWindow")
      if (pick === "Edit team file") await this.editTeamFile()
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not add the teammate: ${String(err)}`)
    }
  }

  private async editTeamFile(): Promise<void> {
    const file = path.join(starHome(), "team.json")
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(
        file,
        JSON.stringify(
          {
            members: [
              { name: "api-expert", repo: "~/code/my-api", agent: "code", description: "Specialist of the backend API repository" },
            ],
          },
          null,
          2,
        ) + "\n",
      )
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file))
  }

  // ---------- misc ----------
  private cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG)
  }

  private log(line: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${line}`)
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}
