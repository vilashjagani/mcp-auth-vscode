# Changelog

All notable changes to the MCP Server Authentication extension are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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
