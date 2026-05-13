# Teradata MCP Authentication — Extension Configuration

Open VS Code Settings (`Ctrl+,`) and search for **Teradata MCP** to find all settings.

## Required settings

| Setting | Example value |
|---|---|
| `teradataMcp.clientId` | `your-client-id` |
| `teradataMcp.deviceAuthEndpoint` | `https://idp.example.com/as/device_authz.oauth2` |
| `teradataMcp.tokenEndpoint` | `https://idp.example.com/as/token.oauth2` |

## Optional settings

| Setting | Default | Description |
|---|---|---|
| `teradataMcp.scopes` | `openid profile email` | Space-separated OAuth scopes |
| `teradataMcp.mcpServerName` | `teradata` | Key under `mcp.servers` in VS Code settings |
| `teradataMcp.mcpServerUrl` | *(empty)* | Written as `mcp.servers.<name>.url` |
| `teradataMcp.tokenRefreshBuffer` | `60` | Seconds before expiry to proactively refresh |

## JSON settings example

```jsonc
// settings.json
{
  "teradataMcp.clientId": "your-client-id",
  "teradataMcp.deviceAuthEndpoint": "https://idp.example.com/as/device_authz.oauth2",
  "teradataMcp.tokenEndpoint": "https://idp.example.com/as/token.oauth2",
  "teradataMcp.scopes": "openid profile email",
  "teradataMcp.mcpServerName": "teradata",
  "teradataMcp.mcpServerUrl": "https://your-teradata-mcp-server/",
  "teradataMcp.tokenRefreshBuffer": 60
}
```

## What happens after sign-in

The extension writes the access token to `mcp.servers.teradata.headers.Authorization` in your
global VS Code settings so any MCP-aware extension picks it up automatically:

```jsonc
// Written automatically — do not edit manually
{
  "mcp": {
    "servers": {
      "teradata": {
        "url": "https://your-teradata-mcp-server/",
        "headers": {
          "Authorization": "Bearer eyJ..."
        }
      }
    }
  }
}
```

## Sign-in flow

1. Run **Teradata MCP: Sign In** from the Command Palette (`Ctrl+Shift+P`).
2. A notification shows your **user code** (e.g. `BCDF-1234`).
3. Click **Open Browser** — your browser opens the verification URL with the code pre-filled.
4. Complete login in the browser.
5. The extension detects the completed login, stores the token securely, and updates `mcp.servers`.
6. The status bar shows `✓ TD MCP: Signed In`.

Tokens are stored in VS Code's encrypted `SecretStorage` (OS keychain on desktop).
The extension automatically refreshes the token 60 s before expiry using the refresh token.
