import * as vscode from "vscode";
import { readAllMcpSources, McpSource, McpServerEntry, ensureMcpJsonExists } from "./mcpConfig";
import { TokenStorage } from "./tokenStorage";
import { getConfig, getEffectiveServers } from "./config";
import { ServerStateManager } from "./serverStateManager";
import { getLogger } from "./logger";

export class LensPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = "mcpAuthLens";

  private view?: vscode.WebviewView;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private _cachedTokens: { expiresAt: number; accessToken?: string; tokenType?: string } | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storage: TokenStorage,
    private readonly serverState: ServerStateManager
  ) {
    serverState.onStateChange(() => this.render());
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    const cfgListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("mcp") || e.affectsConfiguration("mcpAuth")) {
        this.render();
      }
    });

    webviewView.onDidDispose(() => {
      cfgListener.dispose();
      if (this.refreshTimer) clearInterval(this.refreshTimer);
    });

    this.refreshTimer = setInterval(() => this.render(), 30_000);

    // ── Message handler ────────────────────────────────────────────────────
    // payload for server actions is JSON — parse it once here, not in the webview
    webviewView.webview.onDidReceiveMessage(
      async (msg: { command: string; payload?: string }) => {
        try {
          switch (msg.command) {

            case "openGlobalSettings":
              await vscode.commands.executeCommand("workbench.action.openSettings", "mcp.servers");
              break;

            case "openMcpSettings":
              await vscode.commands.executeCommand("workbench.action.openSettings", "mcpAuth");
              break;

            case "openFile": {
              // payload is a raw file-path string — opens settings.json / any file
              const filePath = msg.payload;
              if (!filePath) break;
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
              await vscode.window.showTextDocument(doc);
              break;
            }

            case "openMcpFile": {
              // payload is the mcpJsonPath — scaffold with empty skeleton if missing
              const mcpPath = msg.payload;
              if (!mcpPath) break;
              ensureMcpJsonExists(mcpPath);
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mcpPath));
              await vscode.window.showTextDocument(doc);
              break;
            }

            case "signIn":
              await vscode.commands.executeCommand("mcpAuth.authenticate");
              break;

            case "signOut":
              getLogger().info("Lens: Sign Out requested");
              await vscode.commands.executeCommand("mcpAuth.logout");
              break;

            case "serverConnect": {
              const d = JSON.parse(msg.payload ?? "{}") as { key: string; entry: McpServerEntry };
              getLogger().info(`Lens: ▶ Start  [${d.key}]`);
              await this.serverState.connect(d.key, d.entry, this.authHeaders());
              break;
            }

            case "serverStop": {
              const d = JSON.parse(msg.payload ?? "{}") as { key: string };
              getLogger().info(`Lens: ■ Stop   [${d.key}]`);
              this.serverState.stop(d.key);
              break;
            }

            case "serverRefresh": {
              const d = JSON.parse(msg.payload ?? "{}") as { key: string; entry: McpServerEntry };
              getLogger().info(`Lens: ⟳ Refresh [${d.key}]`);
              this.serverState.reset(d.key);
              await this.serverState.connect(d.key, d.entry, this.authHeaders());
              break;
            }

            case "refresh":
              this.render();
              break;
          }
        } catch (err) {
          const msg2 = err instanceof Error ? err.message : String(err);
          getLogger().error(`Lens message handler error [${msg.command}]: ${msg2}`);
          vscode.window.showErrorMessage(`MCP Auth Lens: ${msg2}`);
        }
      }
    );

    this.render();
  }

  refresh(): void { this.render(); }

  setTokenState(tokens: { expiresAt: number; accessToken?: string; tokenType?: string } | null): void {
    this._cachedTokens = tokens;
    this.render();
  }

  private authHeaders(): Record<string, string> {
    if (!this._cachedTokens?.accessToken) return {};
    return { Authorization: `${this._cachedTokens.tokenType ?? "Bearer"} ${this._cachedTokens.accessToken}` };
  }

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = this.buildHtml();
  }

  // ─── HTML ─────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    const sources  = readAllMcpSources();
    const tokens   = this._cachedTokens;
    const config   = getConfig();
    const signedIn = !!tokens;

    // Build the entries lookup table that will live in the webview JS.
    // Keys → McpServerEntry objects.  No inline JSON in onclick — buttons use data-key only.
    const entryMap: Record<string, McpServerEntry> = {};
    for (const src of sources) {
      for (const [name, entry] of Object.entries(src.servers)) {
        const key = serverKey(src, name);
        entryMap[key] = entry;
      }
    }
    const entriesJson = JSON.stringify(entryMap);

    const authServerNames = new Set(getEffectiveServers(config).map((t) => t.name));

    const totalServers = sources.reduce((n, s) => n + Object.keys(s.servers).length, 0);
    const sectionsHtml = totalServers > 0
      ? sources.map((src) => this.renderSource(src, authServerNames, signedIn)).join("")
      : `<div class="empty-state">
           <div class="empty-icon">🔌</div>
           <div class="empty-title">No MCP servers configured</div>
           <div class="empty-sub">Add servers to <code>mcp.servers</code> in VS Code settings or a workspace <code>.vscode/mcp.json</code>.</div>
         </div>`;

    const expiryText = tokens ? this.formatExpiry(tokens.expiresAt) : "";

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
/* ── Reset ── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* ── Base ── */
body {
  font-family: var(--vscode-font-family);
  font-size: 12px;
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  padding-bottom: 24px;
  line-height: 1.4;
}

/* ── Header ── */
.header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px 9px;
  background: linear-gradient(135deg, #00233D 0%, #004080 100%);
  border-bottom: 2px solid #F5A623;
}
.header-logo { font-size: 16px; flex-shrink: 0; }
.header-title {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .1em; flex: 1;
  color: #ffffff;
}
.header-version {
  font-size: 9px; color: rgba(255,255,255,.45);
  font-weight: 400; letter-spacing: .02em;
}
.header-refresh {
  background: none; border: none; cursor: pointer;
  color: rgba(255,255,255,.7); font-size: 14px; padding: 2px 4px;
  border-radius: 3px; line-height: 1;
}
.header-refresh:hover { color: #F5A623; background: rgba(255,255,255,.1); }

/* ── Auth strip ── */
.auth-strip {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px;
  background: var(--vscode-sideBarSectionHeader-background);
  border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(255,255,255,.08));
}
.auth-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.auth-dot.on  { background: #4ec94e; box-shadow: 0 0 5px #4ec94e88; }
.auth-dot.off { background: #888; }
.auth-info { flex: 1; min-width: 0; }
.auth-status  { font-size: 11px; font-weight: 600; }
.auth-status.signed-in  { color: #4ec94e; }
.auth-status.signed-out { color: var(--vscode-descriptionForeground); }
.auth-expiry  { font-size: 10px; color: var(--vscode-descriptionForeground); }

/* ── Pill buttons (auth strip) ── */
.pill-btn {
  border: none; border-radius: 12px; padding: 3px 11px;
  font-size: 11px; font-weight: 600; cursor: pointer;
  font-family: inherit; flex-shrink: 0; white-space: nowrap;
}
.pill-signin  { background: #F5A623; color: #000; }
.pill-signin:hover  { background: #ffc04d; }
.pill-signout { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.pill-signout:hover { background: var(--vscode-button-secondaryHoverBackground); }

/* ── Source section ── */
.source-section { margin-top: 10px; }
.source-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 3px 12px 3px 10px;
  background: var(--vscode-sideBarSectionHeader-background);
  border-left: 3px solid transparent;
}
.source-header.global    { border-left-color: #F5A623; }
.source-header.workspace { border-left-color: #7eb8f7; }
.source-header-left { display: flex; align-items: center; gap: 6px; }

.scope-chip {
  font-size: 9px; padding: 1px 6px; border-radius: 10px;
  font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
}
.chip-global    { background: #F5A62322; color: #F5A623; border: 1px solid #F5A62366; }
.chip-workspace { background: #7eb8f722; color: #7eb8f7; border: 1px solid #7eb8f766; }

.source-label { font-size: 11px; font-weight: 600; color: var(--vscode-sideBarSectionHeader-foreground); }

.cfg-btns { display: flex; gap: 4px; }
.cfg-link {
  font-size: 10px; background: none; border: 1px solid rgba(255,255,255,.12);
  cursor: pointer; color: var(--vscode-textLink-foreground, #7eb8f7);
  padding: 1px 6px; border-radius: 3px; font-family: inherit; white-space: nowrap;
}
.cfg-link:hover { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.25); }
.cfg-link.mcp   { color: #F5A623; border-color: rgba(245,166,35,.3); }
.cfg-link.mcp:hover { background: rgba(245,166,35,.12); border-color: #F5A623; }

/* ── Tool tooltip (JS-positioned, fixed — escapes all overflow/clip containers) ── */
#tool-tip {
  display: none;
  position: fixed; z-index: 9999;
  width: 260px; max-width: calc(100vw - 16px);
  background: #1a2535; border: 1px solid rgba(245,166,35,.45);
  border-radius: 7px; padding: 9px 11px; font-size: 11px;
  box-shadow: 0 8px 24px rgba(0,0,0,.6); line-height: 1.5;
  pointer-events: none;
}
.tt-name {
  font-family: var(--vscode-editor-font-family, monospace);
  font-weight: 700; font-size: 12px; color: #7eb8f7; margin-bottom: 4px;
  word-break: break-all;
}
.tt-desc { color: var(--vscode-foreground); margin-bottom: 6px; white-space: pre-wrap; }
.tt-params-label { font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing:.05em; color: #F5A623; margin-bottom: 4px; }
.tt-param { padding: 2px 0; border-top: 1px solid rgba(255,255,255,.06); }
.tt-param code {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px; color: #b39dff;
}
.tt-param-type { font-size: 10px; color: #888; margin-left: 4px; }
.tt-param-req  { font-size: 9px;  color: #F5A623; margin-left: 4px; font-weight:700; }
.tt-param-desc { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 1px; }
.tt-no-params  { font-size: 10px; color: #555; font-style: italic; }

/* ── Server card ── */
.server-list { padding: 4px 10px 0; }

.server-card {
  margin-bottom: 8px;
  border-radius: 6px;
  /* NO overflow:hidden — it clips tooltips. Round corners via child selectors instead. */
  border: 1px solid var(--vscode-widget-border, rgba(255,255,255,.1));
  background: var(--vscode-editor-background, #1e1e1e);
  transition: border-color .15s;
}
.server-card > :first-child { border-radius: 5px 5px 0 0; }
.server-card > :last-child  { border-radius: 0 0 5px 5px; }
.server-card > :only-child  { border-radius: 5px; }
.server-card:hover         { border-color: rgba(255,255,255,.22); }
.server-card.has-auth      { border-color: #F5A62366; }
.server-card.is-connected  { border-color: #4ec94e66; }
.server-card.is-error      { border-color: #f4444466; }

/* topbar gradient depends on status */
.card-top {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(255,255,255,.06);
}
.card-top.status-idle       { background: rgba(255,255,255,.04); }
.card-top.status-connecting { background: linear-gradient(90deg,rgba(229,192,123,.12) 0%,rgba(255,255,255,.04) 100%); }
.card-top.status-connected  { background: linear-gradient(90deg,rgba(78,201,78,.14) 0%,rgba(255,255,255,.04) 100%); }
.card-top.status-error      { background: linear-gradient(90deg,rgba(244,68,68,.14) 0%,rgba(255,255,255,.04) 100%); }
.card-top.status-stopped    { background: rgba(255,255,255,.02); }

.status-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.dot-idle       { background: rgba(255,255,255,.25); }
.dot-connecting { background: #e5c07b; box-shadow: 0 0 6px #e5c07b88; animation: blink 1.1s ease-in-out infinite; }
.dot-connected  { background: #4ec94e; box-shadow: 0 0 6px #4ec94e88; }
.dot-error      { background: #f44444; box-shadow: 0 0 6px #f4444488; }
.dot-stopped    { background: rgba(255,255,255,.15); }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }

.card-name {
  flex: 1; font-weight: 700; font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--vscode-foreground);
}
.type-badge {
  font-size: 9px; padding: 2px 7px; border-radius: 10px;
  font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
  flex-shrink: 0;
}
.badge-http  { background: #007acc22; color: #7eb8f7; border: 1px solid #007acc55; }
.badge-stdio { background: #8b6cef22; color: #b39dff; border: 1px solid #8b6cef55; }
.badge-sse   { background: #e5953322; color: #f5a623; border: 1px solid #e5953355; }
.badge-other { background: rgba(255,255,255,.08); color: var(--vscode-descriptionForeground); border: 1px solid rgba(255,255,255,.12); }

/* ── Action buttons row ── */
.card-actions {
  display: flex; gap: 5px;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(255,255,255,.06);
  background: rgba(0,0,0,.15);
}
.act-btn {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid rgba(255,255,255,.15); border-radius: 4px;
  padding: 3px 9px; font-size: 11px; font-weight: 600;
  cursor: pointer; font-family: inherit; background: rgba(255,255,255,.05);
  color: var(--vscode-foreground); transition: background .12s, border-color .12s;
  white-space: nowrap;
}
.act-btn:hover   { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.3); }
.act-btn:active  { background: rgba(255,255,255,.06); }
.act-btn:disabled { opacity: .35; cursor: not-allowed; pointer-events: none; }

.act-start   { border-color: #4ec94e55; color: #4ec94e; }
.act-start:hover   { background: rgba(78,201,78,.15); border-color: #4ec94e; }
.act-stop    { border-color: #f4444455; color: #f44; }
.act-stop:hover    { background: rgba(244,68,68,.15);  border-color: #f44; }
.act-refresh { border-color: rgba(255,255,255,.15); }

/* ── Server info props ── */
.card-props { padding: 6px 10px 4px; border-bottom: 1px solid rgba(255,255,255,.05); }
.prop-row   { display: flex; gap: 8px; padding: 2px 0; font-size: 11px; }
.prop-key   {
  color: var(--vscode-descriptionForeground); min-width: 64px;
  flex-shrink: 0; font-size: 10px; text-transform: uppercase;
  letter-spacing: .04em; padding-top: 1px;
}
.prop-val {
  color: var(--vscode-foreground); word-break: break-all;
  font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
}
.prop-val.redacted { color: var(--vscode-descriptionForeground); font-style: italic; }

/* ── Error banner ── */
.error-box {
  margin: 6px 10px 8px; padding: 6px 10px;
  background: rgba(244,68,68,.12); border: 1px solid rgba(244,68,68,.35);
  border-radius: 4px; font-size: 11px; color: #f88;
  word-break: break-word; line-height: 1.5;
}
.error-box .err-label { font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 3px; color: #f44; }

/* ── Tools section ── */
.tools-section { border-top: 1px solid rgba(255,255,255,.06); }

.tools-toggle {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; cursor: pointer; user-select: none;
  background: none; border: none; width: 100%; text-align: left;
  color: var(--vscode-foreground); font-family: inherit;
}
.tools-toggle:hover { background: rgba(255,255,255,.04); }

.tools-label {
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .06em; color: var(--vscode-descriptionForeground);
  flex: 1;
}
.tools-count-badge {
  font-size: 9px; padding: 1px 6px; border-radius: 10px; font-weight: 700;
  background: #F5A62333; color: #F5A623; border: 1px solid #F5A62366;
}
.chevron {
  font-size: 9px; color: var(--vscode-descriptionForeground);
  transition: transform .15s; flex-shrink: 0;
}
.chevron.open { transform: rotate(90deg); }

.tools-list { border-top: 1px solid rgba(255,255,255,.05); }

.tool-item {
  display: flex; align-items: flex-start; gap: 9px;
  padding: 6px 10px 5px;
  border-bottom: 1px solid rgba(255,255,255,.04);
  transition: background .1s;
}
.tool-item:hover { background: rgba(255,255,255,.03); }
.tool-item:last-child { border-bottom: none; }

.tool-icon-wrap {
  width: 22px; height: 22px; border-radius: 5px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(245,166,35,.15); border: 1px solid rgba(245,166,35,.25);
  font-size: 12px;
}
.tool-body { flex: 1; min-width: 0; }
.tool-name {
  font-size: 11px; font-weight: 700;
  font-family: var(--vscode-editor-font-family, monospace);
  color: #7eb8f7;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tool-desc {
  font-size: 10px; color: var(--vscode-descriptionForeground);
  margin-top: 2px; line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden;
}

/* ── Connecting / idle placeholder ── */
.card-placeholder {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; font-size: 11px;
  color: var(--vscode-descriptionForeground); font-style: italic;
}

/* ── Empty state ── */
.empty-state {
  margin: 28px 16px; text-align: center;
}
.empty-icon  { font-size: 36px; margin-bottom: 8px; }
.empty-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.empty-sub   { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.6; }
.empty-sub code {
  font-family: var(--vscode-editor-font-family, monospace); font-size: 10px;
  background: rgba(255,255,255,.08); padding: 1px 4px; border-radius: 3px;
}
</style>
</head>
<body>

<!-- ── Header ── -->
<div class="header">
  <span class="header-logo">🔍</span>
  <span class="header-title">MCP Server Lens</span>
  <button class="header-refresh" data-action="refresh" title="Refresh panel">⟳</button>
</div>

<!-- ── Auth strip ── -->
<div class="auth-strip">
  <div class="auth-dot ${signedIn ? "on" : "off"}"></div>
  <div class="auth-info">
    <div class="auth-status ${signedIn ? "signed-in" : "signed-out"}">
      ${signedIn ? "Signed in" : "Not signed in"}
    </div>
    ${signedIn ? `<div class="auth-expiry">${expiryText}</div>` : ""}
  </div>
  ${signedIn
    ? `<button class="pill-btn pill-signout" data-action="signOut">Sign Out</button>`
    : `<button class="pill-btn pill-signin"  data-action="signIn">Sign In</button>`
  }
</div>

<!-- ── Servers ── -->
${sectionsHtml}

<!-- Singleton floating tooltip — JS positions it to avoid all clipping -->
<div id="tool-tip"></div>

<script>
const ENTRIES = ${entriesJson};

const vscode = acquireVsCodeApi();

function post(command, payload) {
  vscode.postMessage({ command, payload });
}

// ── Click handler ─────────────────────────────────────────────────────────
document.addEventListener('click', function(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  const action = btn.dataset.action;
  switch (action) {
    case 'refresh':            post('refresh');            break;
    case 'signIn':             post('signIn');             break;
    case 'signOut':            post('signOut');            break;
    case 'openGlobalSettings': post('openGlobalSettings'); break;
    case 'openMcpSettings':    post('openMcpSettings');    break;
    case 'openFile':           post('openFile',    btn.dataset.path); break;
    case 'openMcpFile':        post('openMcpFile', btn.dataset.path); break;
    case 'serverConnect':
      post('serverConnect', JSON.stringify({ key: btn.dataset.key, entry: ENTRIES[btn.dataset.key] }));
      break;
    case 'serverStop':
      post('serverStop', JSON.stringify({ key: btn.dataset.key }));
      break;
    case 'serverRefresh':
      post('serverRefresh', JSON.stringify({ key: btn.dataset.key, entry: ENTRIES[btn.dataset.key] }));
      break;
    case 'toggleTools': {
      const card = btn.closest('.server-card');
      const list = card && card.querySelector('.tools-list');
      const chev = btn.querySelector('.chevron');
      if (!list) break;
      const open = list.style.display !== 'none';
      list.style.display = open ? 'none' : 'block';
      if (chev) chev.classList.toggle('open', !open);
      break;
    }
  }
});

// ── Tooltip — JS-positioned fixed overlay, immune to overflow:hidden ──────
const tip = document.getElementById('tool-tip');

document.addEventListener('mouseover', function(e) {
  const item = e.target.closest('.tool-item[data-tip]');
  if (!item || !tip) return;
  const data = JSON.parse(item.dataset.tip);
  tip.innerHTML = buildTip(data);
  tip.style.display = 'block';
  positionTip(item);
});

document.addEventListener('mouseout', function(e) {
  const item = e.target.closest('.tool-item[data-tip]');
  if (!item || !tip) return;
  if (!item.contains(e.relatedTarget)) {
    tip.style.display = 'none';
  }
});

document.addEventListener('scroll', function() {
  if (tip) tip.style.display = 'none';
}, true);

function positionTip(anchor) {
  const r   = anchor.getBoundingClientRect();
  const tw  = tip.offsetWidth  || 260;
  const th  = tip.offsetHeight || 120;
  const vw  = window.innerWidth;
  const vh  = window.innerHeight;
  const PAD = 6;

  // Prefer below; flip above if not enough room
  let top = r.bottom + PAD;
  if (top + th > vh - PAD) top = r.top - th - PAD;
  if (top < PAD) top = PAD;

  // Align left edge with anchor, clamp to viewport
  let left = r.left;
  if (left + tw > vw - PAD) left = vw - tw - PAD;
  if (left < PAD) left = PAD;

  tip.style.top  = top  + 'px';
  tip.style.left = left + 'px';
}

function buildTip(t) {
  let html = '<div class="tt-name">' + esc(t.name) + '</div>'
           + '<div class="tt-desc">' + esc(t.description) + '</div>';

  const props    = t.inputSchema && t.inputSchema.properties;
  const required = (t.inputSchema && t.inputSchema.required) || [];

  if (props && Object.keys(props).length > 0) {
    html += '<div class="tt-params-label">Parameters</div>';
    for (const [pname, pdef] of Object.entries(props)) {
      const req  = required.includes(pname) ? '<span class="tt-param-req">required</span>' : '';
      const type = pdef.type ? '<span class="tt-param-type">' + esc(pdef.type) + '</span>' : '';
      const desc = pdef.description ? '<div class="tt-param-desc">' + esc(pdef.description) + '</div>' : '';
      html += '<div class="tt-param"><code>' + esc(pname) + '</code>' + type + req + desc + '</div>';
    }
  } else {
    html += '<div class="tt-no-params">No input parameters</div>';
  }
  return html;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;
  }

  // ─── Source section ───────────────────────────────────────────────────────

  private renderSource(src: McpSource, authServerNames: Set<string>, signedIn: boolean): string {
    const keys = Object.keys(src.servers);
    const isGlobal = src.scope === "global";

    const chip = isGlobal
      ? `<span class="scope-chip chip-global">global</span>`
      : `<span class="scope-chip chip-workspace">workspace</span>`;

    // Two configure buttons: VS Code Settings + dedicated mcp.json
    const mcpJsonPath = src.mcpJsonPath;
    const mcpConfigBtn = mcpJsonPath
      ? `<button class="cfg-link mcp" data-action="openMcpFile" data-path="${escAttrVal(mcpJsonPath)}" title="${escAttrVal(mcpJsonPath)}">📄 mcp.json</button>`
      : `<button class="cfg-link mcp" data-action="openGlobalSettings" title="Open MCP config in Settings">📄 mcp.json</button>`;

    const cfgBtns = `<div class="cfg-btns">
      <button class="cfg-link" data-action="openMcpSettings" title="Open MCP Auth extension settings">⚙ Settings</button>
      ${mcpConfigBtn}
    </div>`;

    const body = keys.length === 0
      ? `<div class="server-list"><div class="card-placeholder" style="padding:10px 12px">No servers configured</div></div>`
      : `<div class="server-list">${keys.map((n) => this.renderCard(n, src.servers[n]!, src, authServerNames, signedIn)).join("")}</div>`;

    return `
<div class="source-section">
  <div class="source-header ${isGlobal ? "global" : "workspace"}">
    <div class="source-header-left">
      ${chip}
      <span class="source-label">${escHtml(src.label)}</span>
    </div>
    ${cfgBtns}
  </div>
  ${body}
</div>`;
  }

  // ─── Server card ──────────────────────────────────────────────────────────

  private renderCard(
    name: string,
    entry: McpServerEntry,
    src: McpSource,
    authServerNames: Set<string>,
    signedIn: boolean
  ): string {
    const key      = serverKey(src, name);
    const state    = this.serverState.getState(key);
    const type     = ((entry.type as string | undefined) ?? "http").toLowerCase();
    const isAuth   = authServerNames.has(name) && signedIn;
    const status   = state.status;

    // card class
    let cardClass = "server-card";
    if (status === "connected") cardClass += " is-connected";
    else if (status === "error") cardClass += " is-error";
    else if (isAuth) cardClass += " has-auth";

    // type badge
    const badgeClass = type === "http" || type === "streamable-http" ? "badge-http"
      : type === "stdio" ? "badge-stdio"
      : type === "sse"   ? "badge-sse"
      : "badge-other";

    // action buttons — just data-key, no JSON in the HTML
    const isConnecting = status === "connecting";
    const isConnected  = status === "connected";

    const startBtn = `<button class="act-btn act-start" data-action="serverConnect" data-key="${escAttrVal(key)}" ${isConnecting ? "disabled" : ""}>▶ Start</button>`;
    const stopBtn  = isConnected
      ? `<button class="act-btn act-stop"    data-action="serverStop"    data-key="${escAttrVal(key)}">■ Stop</button>`
      : "";
    const refrBtn  = isConnected
      ? `<button class="act-btn act-refresh" data-action="serverRefresh" data-key="${escAttrVal(key)}">⟳ Refresh</button>`
      : "";

    // props
    const props: string[] = [];
    if (entry.url)     props.push(propRow("url",     String(entry.url)));
    if (entry.command) props.push(propRow("cmd",     String(entry.command)));
    if (Array.isArray(entry.args) && (entry.args as string[]).length)
      props.push(propRow("args", (entry.args as string[]).join(" ")));
    if (entry.headers) {
      for (const [k, v] of Object.entries(entry.headers as Record<string, string>)) {
        const auth = k.toLowerCase() === "authorization";
        props.push(propRow(k, auth ? `${v.slice(0, 14)}… <em>(redacted)</em>` : v, auth ? " redacted" : ""));
      }
    }

    // body below topbar
    let body = "";

    if (props.length) {
      body += `<div class="card-props">${props.join("")}</div>`;
    }

    body += `<div class="card-actions">${startBtn}${stopBtn}${refrBtn}</div>`;

    if (status === "connecting") {
      body += `<div class="card-placeholder">⏳ Connecting to server…</div>`;
    } else if (status === "connected") {
      const count = state.tools.length;
      const rows = state.tools.map((t) => {
        // Embed tool metadata as JSON in data-tip; the JS tooltip reads it on hover
        const tipData = JSON.stringify({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema ?? {},
        });
        return `
<div class="tool-item" data-tip="${escHtml(tipData)}">
  <div class="tool-icon-wrap">🔧</div>
  <div class="tool-body">
    <div class="tool-name">${escHtml(t.name)}</div>
    <div class="tool-desc">${escHtml(t.description)}</div>
  </div>
</div>`;
      }).join("");

      body += `
<div class="tools-section">
  <button class="tools-toggle" data-action="toggleTools">
    <span class="tools-label">Tools</span>
    <span class="tools-count-badge">${count}</span>
    <span class="chevron open">▶</span>
  </button>
  <div class="tools-list">
    ${count > 0 ? rows : `<div class="card-placeholder">No tools exposed by this server</div>`}
  </div>
</div>`;
    } else if (status === "error") {
      body += `
<div class="error-box">
  <div class="err-label">⚠ Connection error</div>
  ${escHtml(state.error ?? "Unknown error")}
</div>`;
    }

    return `
<div class="${cardClass}">
  <div class="card-top status-${status}">
    <span class="status-dot dot-${status}"></span>
    <span class="card-name">${escHtml(name)}</span>
    <span class="type-badge ${badgeClass}">${escHtml(type)}</span>
  </div>
  ${body}
</div>`;
  }

  private formatExpiry(expiresAt: number): string {
    const ms = expiresAt - Date.now();
    if (ms <= 0) return "Token expired — please sign in again";
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    return h > 0 ? `Token expires in ${h}h ${m % 60}m` : `Token expires in ${m}m`;
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function serverKey(src: McpSource, name: string): string {
  return `${src.scope}::${src.label}::${name}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Safe value for an HTML attribute — escapes double-quotes and backslashes only */
function escAttrVal(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, "&quot;");
}

function propRow(key: string, val: string, extraClass = ""): string {
  return `<div class="prop-row"><span class="prop-key">${escHtml(key)}</span><span class="prop-val${extraClass}">${val}</span></div>`;
}
