# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                  # Install dependencies (one-time setup)
npm run compile              # TypeScript type-check only (no output files)
npm run build                # Development build → out/extension.js (with sourcemaps)
npm run watch                # Watch mode — auto-rebuilds on file changes
npm run vscode:prepublish    # Production build (minified, no sourcemaps)
npm run package              # Package extension → mcp-auth-*.vsix
```

There are no lint or test scripts configured.

**Development cycle**: run `npm run watch` in one terminal, then press `F5` in VS Code to launch an Extension Development Host. After code changes, use `Developer: Reload Window` (Ctrl+Shift+P) to reload.

## Architecture

This is a VS Code extension that implements **OAuth 2.0 Device Authorization Flow (RFC 8628)** for MCP servers. After a user authenticates, it automatically injects the resulting Bearer token into VS Code's `mcp.servers[name].headers.Authorization` so MCP clients pick it up without manual configuration.

### Entry point and wiring (`src/extension.ts`)

`activate()` instantiates all components and wires them together:
- Creates `Logger` → `TokenStorage` → `StatusBarItem` → `ServerStateManager` → `AuthManager`
- Registers four commands: `mcpAuth.authenticate`, `mcpAuth.logout`, `mcpAuth.showStatus`, `mcpAuth.refreshLens`
- Registers `LensPanel` as a webview sidebar provider
- Calls `authManager.initialize()` to restore a prior session or prompt if the token has expired

### OAuth flow (`src/authManager.ts`, `src/deviceAuth.ts`)

`AuthManager` orchestrates the end-to-end flow:
1. `signIn()` → `deviceAuth.startDeviceAuth()` (POST to device auth endpoint) → shows user code notification
2. `deviceAuth.pollForToken()` polls the token endpoint until the user completes browser login
3. On success, `applyToken()` writes the token via `mcpConfig.writeMcpToken()` and schedules a background refresh

`deviceAuth.ts` handles raw HTTP(S) — it uses Node's built-in `https`/`http` modules (no external HTTP library). It supports TLS bypass via `allowInsecureTls` for corporate proxies.

### Configuration (`src/config.ts`, `package.json`)

All settings live under the `mcpAuth.*` namespace. Key settings:
- `mcpAuth.clientId`, `mcpAuth.deviceAuthEndpoint`, `mcpAuth.tokenEndpoint`, `mcpAuth.scopes`
- `mcpAuth.mcpServers`: array of `{ name, url }` — preferred multi-server format
- `mcpAuth.mcpServerName` / `mcpAuth.mcpServerUrl`: legacy single-server fallback
- `mcpAuth.tokenRefreshBuffer`: seconds before expiry to trigger silent refresh (default 60)
- `mcpAuth.allowInsecureTls`: skip TLS certificate verification

`validateConfig()` in `config.ts` checks required fields and URL format before any auth attempt.

### MCP config injection (`src/mcpConfig.ts`)

Reads and writes VS Code's global `settings.json` and workspace `.vscode/mcp.json` files directly via filesystem (not the VS Code settings API) to manage `mcp.servers[name].headers.Authorization`. `readAllMcpSources()` merges both global and workspace-level server lists for display in the Lens panel.

### Sidebar UI (`src/lensPanel.ts`)

A `WebviewViewProvider` rendered in the "MCP Server Lens" activity bar container. It displays all discovered MCP servers, their connection status, and a tools list. Server interactions (connect, stop, refresh) send messages from the webview back to the provider, which delegates to `ServerStateManager`.

### Server state and MCP queries (`src/serverStateManager.ts`, `src/mcpClient.ts`)

`ServerStateManager` tracks per-server state (idle / connecting / connected / error) and tool lists. `mcpClient.ts` speaks JSON-RPC MCP protocol over two transports:
- **HTTP/SSE**: sends `initialize` + `tools/list` requests over HTTP
- **Stdio**: spawns a subprocess and exchanges JSON-RPC over stdin/stdout

### Token persistence (`src/tokenStorage.ts`)

Tokens are stored in VS Code's `SecretStorage` (OS keychain). The `TokenSet` includes `accessToken`, optional `refreshToken`, `expiresAt` (Unix ms), and `tokenType`.

### Build system

`esbuild.js` bundles `src/extension.ts` into a single `out/extension.js`. The `vscode` module is externalized (not bundled). Production builds (`vscode:prepublish`) add minification and strip sourcemaps.
