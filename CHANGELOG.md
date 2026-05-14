# Changelog

All notable changes to the MCP Server Authentication extension are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

---

## [0.2.0] — 2026-05-15

### Added

- **Five auth methods per MCP server** — each server can use a different method and IDP:
  - `device` — OAuth 2.0 Device Authorization Flow (RFC 8628), browser-based login
  - `client_credentials` — `grant_type=client_credentials` (client_id + client_secret)
  - `password` — `grant_type=password` (client_id + optional client_secret + username + password)
  - `basic` — HTTP Basic Authorization header (username + password)
  - `api_key` — static key injected into a configurable header (default `x-api-key`)
- **Per-server config in `mcpAuth.serverConfigs`** — keyed by server name, each entry holds its own IDP endpoints, client_id, scopes, and method; two servers can point to two completely different IDPs
- **Prompt-and-save for missing settings** — if a required non-sensitive field (clientId, tokenEndpoint, deviceAuthEndpoint, scopes, username, apiKeyHeader) is absent, the extension prompts and immediately saves to `mcpAuth.serverConfigs` in `settings.json`
- **Strict secrets policy** — `clientSecret`, `password`, and `api_key` values are never written to `settings.json`; they are always stored in VS Code `SecretStorage` (OS keychain) only
- **Server list from `mcp.json`** — the Sign In / Sign Out server picker and per-server card buttons are now driven by `mcp.servers` / `.vscode/mcp.json` rather than a separate `mcpAuth.mcpServers` list
- **Per-server Sign In / Sign Out buttons** in the MCP Server Lens — every server card shows its own auth method badge and login state
- **Silent token refresh for all grant types** — `client_credentials` and `password` grant tokens are re-fetched silently on expiry using credentials from `SecretStorage`; device-flow tokens use the refresh token
- **Method picker loops for multi-server sign-in** — when signing in from the command palette with multiple servers, the picker re-opens after each server so all can be authenticated in one session

### Changed

- `mcpAuth.serverConfigs` replaces the old flat global settings (`mcpAuth.clientId`, `mcpAuth.tokenEndpoint`, `mcpAuth.username`, `mcpAuth.password`, `mcpAuth.apiKey`, `mcpAuth.apiKeyHeader`, `mcpAuth.mcpServers`) — per-server isolation is now first-class
- `deviceAuth.ts` functions (`startDeviceAuth`, `pollForToken`, `refreshAccessToken`) now accept a slim `DeviceAuthParams` interface instead of the full `IdpConfig`
- Sign Out now shows a server picker (single-server setups sign out immediately without prompting)

### Fixed

- Auth state badges and Sign In/Out card buttons now appear for all servers visible in the Lens, not only those listed in `mcpAuth.mcpServers`
- `clientSecret` is preserved in `SecretStorage` across token refreshes so silent re-auth works without re-prompting

---

## [0.1.0] — 2026-05-14

### Added

- **OAuth 2.0 Device Authorization Flow** (RFC 8628) — sign in via browser without a redirect URI
- **Token auto-refresh** — silently refreshes the access token using the refresh token before expiry
- **Secure token storage** — tokens stored in VS Code `SecretStorage` (OS keychain)
- **MCP server config injection** — writes `type: http` + `Authorization: Bearer` header into `mcp.servers` in VS Code global settings automatically after sign-in
- **Multiple MCP server support** — configure a list of servers via `mcpAuth.mcpServers`; token is injected into all of them on sign-in
- **MCP Server Lens sidebar** — activity-bar panel showing all configured MCP servers (global and workspace)
  - Per-server Start / Stop / Refresh buttons
  - Live connection status indicator (idle / connecting / connected / error)
  - Tools list with name, description, and parameter metadata on hover
  - Configure buttons to open settings or the relevant `mcp.json` file
- **HTTP and stdio transport support** in the Lens MCP client
- **Output channel logging** (`MCP Auth`) with full request/response detail for troubleshooting
- **Status bar item** showing auth state and token expiry countdown
- `mcpAuth.allowInsecureTls` setting for environments with self-signed/corporate proxy certificates
- `mcpAuth.tokenRefreshBuffer` setting to control how early the silent refresh fires
