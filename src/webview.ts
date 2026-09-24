import * as crypto from "node:crypto"

export interface HtmlOptions {
  /** Base URI of the extension's media/ folder, as seen from the webview. */
  mediaUri: string
  /** webview.cspSource, or "" outside VS Code. */
  cspSource: string
  language: string
  officeName: string
  room: "office" | "lodge"
}

/** Builds the office page. Pure function so the dev preview can reuse it outside VS Code. */
export function renderOfficeHtml(opts: HtmlOptions): string {
  const nonce = crypto.randomBytes(16).toString("base64")
  const media = opts.mediaUri.replace(/\/$/, "")
  const src = opts.cspSource || "'self'"
  const csp = [
    "default-src 'none'",
    `img-src ${src} data: blob:`,
    `font-src ${src}`,
    `style-src ${src} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${src} data: blob:`,
  ].join("; ")
  const boot = JSON.stringify({
    assets: `${media}/assets`,
    language: opts.language,
    officeName: opts.officeName,
    room: opts.room,
  }).replace(/</g, "\\u003c")

  return `<!DOCTYPE html>
<html lang="${opts.language === "fr" ? "fr" : "en"}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Star Office</title>
<link rel="stylesheet" href="${media}/office.css">
<style>#loading-overlay{position:fixed;inset:0;background:#1a1a2e;display:flex;flex-direction:column;justify-content:center;align-items:center;z-index:100000}#loading-text{color:#ffd700;font-size:16px;margin-bottom:16px}#loading-progress-container{width:260px;height:18px;background:#333;border:2px solid #555}#loading-progress-bar{height:100%;width:0;background:linear-gradient(90deg,#e94560,#ffd700);transition:width .3s}</style>
</head>
<body>
<div id="loading-overlay">
  <div id="loading-text">Loading…</div>
  <div id="loading-progress-container"><div id="loading-progress-bar"></div></div>
</div>
<div id="app">
  <div id="game-area">
    <div id="game-container">
      <div id="game-skeleton"><div class="hint">★</div></div>
      <div id="status-text"></div>
      <div id="connect-banner"><span id="connect-banner-text"></span><button id="connect-banner-btn" type="button"></button></div>
    </div>
  </div>
  <div id="bottom-panels">
    <nav id="panel-tabs" role="tablist">
      <button type="button" role="tab" data-panel="memo-panel" id="tab-memo-panel"></button>
      <button type="button" role="tab" data-panel="team-panel" id="tab-team-panel"></button>
      <button type="button" role="tab" data-panel="control-bar" id="tab-control-bar"></button>
    </nav>
    <section id="memo-panel" class="pixel-panel">
      <div class="memo-inner">
        <div id="log-title" class="panel-title"></div>
        <div id="log-list" class="scroll"></div>
      </div>
    </section>
    <section id="team-panel" class="pixel-panel">
      <div id="team-title" class="panel-title"></div>
      <div class="scroll">
        <button id="team-profile-btn" type="button"></button>
        <div id="meeting-list" style="display:none"></div>
        <div id="team-list"></div>
        <details id="past-meetings" style="display:none"><summary id="past-title"></summary><div id="past-list"></div></details>
      </div>
    </section>
    <section id="control-bar" class="pixel-panel">
      <div id="link-title" class="panel-title"></div>
      <div id="link-status"><span id="link-dot"></span><span id="link-text"></span></div>
      <div id="link-meta"></div>
      <div id="control-buttons"></div>
    </section>
  </div>
</div>
<aside id="chat-panel" class="pixel-panel" role="dialog" aria-labelledby="chat-title">
  <header id="chat-head">
    <div id="chat-avatar"></div>
    <div id="chat-heading"><div id="chat-title"></div><div id="chat-sub"></div></div>
    <button id="chat-stop" class="pixel-btn danger" type="button"></button>
    <button id="chat-open" class="pixel-btn" type="button">↗</button>
    <button id="chat-close" class="pixel-btn" type="button">✕</button>
  </header>
  <nav id="chat-tabs" role="tablist">
    <button type="button" role="tab" data-view="chat" id="chat-tab-chat"></button>
    <button type="button" role="tab" data-view="profile" id="chat-tab-profile"></button>
  </nav>
  <div id="chat-members"></div>
  <div id="chat-log" class="scroll" aria-live="polite"></div>
  <footer id="chat-compose">
    <textarea id="chat-text" maxlength="20000"></textarea>
    <div id="chat-row">
      <label id="chat-option-row"><input id="chat-option" type="checkbox"><span id="chat-option-label"></span></label>
      <div id="chat-result" aria-live="polite"></div>
      <button id="chat-send" class="pixel-btn primary" type="button"></button>
    </div>
  </footer>
  <div id="profile-view" class="scroll" hidden>
    <p id="profile-role"></p>
    <label class="profile-label" for="profile-context" id="profile-context-label"></label>
    <textarea id="profile-context" maxlength="8000"></textarea>
    <div class="profile-label" id="profile-folders-label"></div>
    <p class="profile-hint" id="profile-folders-hint"></p>
    <div id="profile-folders"></div>
    <button id="profile-add-folders" class="pixel-btn" type="button"></button>
    <div class="profile-label" id="profile-memory-label"></div>
    <p class="profile-hint" id="profile-memory-hint"></p>
    <div id="profile-memory"></div>
    <div id="profile-actions">
      <button id="profile-preview" class="pixel-btn" type="button"></button>
      <span id="profile-result" aria-live="polite"></span>
      <button id="profile-save" class="pixel-btn primary" type="button"></button>
    </div>
    <pre id="profile-briefing" hidden></pre>
  </div>
</aside>
<script id="boot" type="application/json">${boot}</script>
<script nonce="${nonce}" src="${media}/vendor/phaser-3.80.1.min.js"></script>
<script nonce="${nonce}" src="${media}/i18n.js"></script>
<script nonce="${nonce}" src="${media}/guests.js"></script>
<script nonce="${nonce}" src="${media}/office.js"></script>
</body>
</html>`
}
