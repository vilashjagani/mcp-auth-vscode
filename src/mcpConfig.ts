import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export interface McpServerEntry {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface McpServersMap {
  [name: string]: McpServerEntry;
}

// ─── Token write / clear ──────────────────────────────────────────────────────

export async function writeMcpToken(
  serverName: string,
  accessToken: string,
  tokenType: string,
  mcpServerUrl: string,
  authMethod: import("./authTypes").AuthMethod = "device"
): Promise<void> {
  const mcpConfig = vscode.workspace.getConfiguration("mcp");
  // Deep-clone — VS Code returns a Proxy; mutating it directly throws an isExtensible trap error
  const servers: McpServersMap = JSON.parse(
    JSON.stringify(mcpConfig.get<McpServersMap>("servers") ?? {})
  );

  const existing: McpServerEntry = (servers[serverName] as McpServerEntry) ?? {};

  let headerPatch: Record<string, string>;
  if (authMethod === "api_key") {
    // tokenType holds the header name for api_key auth
    headerPatch = { [tokenType]: accessToken };
    // Remove any stale Authorization header from previous method
    const cleaned = { ...(existing.headers ?? {}) };
    delete cleaned["Authorization"];
    headerPatch = { ...cleaned, [tokenType]: accessToken };
  } else if (authMethod === "basic") {
    headerPatch = { ...(existing.headers ?? {}), Authorization: `Basic ${accessToken}` };
  } else {
    // device / client_credentials
    headerPatch = { ...(existing.headers ?? {}), Authorization: `${tokenType} ${accessToken}` };
  }

  const updated: McpServerEntry = {
    type: "http",
    ...existing,
    headers: headerPatch,
  };
  if (mcpServerUrl) updated.url = mcpServerUrl;
  servers[serverName] = updated;

  await mcpConfig.update("servers", servers, vscode.ConfigurationTarget.Global);
}

export async function clearMcpToken(serverName: string): Promise<void> {
  const mcpConfig = vscode.workspace.getConfiguration("mcp");
  // Deep-clone — VS Code returns a Proxy; mutating it directly throws an isExtensible trap error
  const servers: McpServersMap = JSON.parse(
    JSON.stringify(mcpConfig.get<McpServersMap>("servers") ?? {})
  );

  const existing = servers[serverName];
  if (!existing) return;

  const headers = { ...(existing.headers ?? {}) };
  delete headers["Authorization"];

  if (Object.keys(headers).length) {
    existing.headers = headers;
  } else {
    delete existing.headers;
  }

  servers[serverName] = existing;
  await mcpConfig.update("servers", servers, vscode.ConfigurationTarget.Global);
}

// ─── Read helpers used by Lens ────────────────────────────────────────────────

export interface McpSource {
  label: string;
  scope: "global" | "workspace";
  /** The settings.json (or mcp.json) that owns the servers data — used by ⚙ Settings button */
  filePath: string | null;
  /** Dedicated mcp.json path for this source — used by 📄 MCP Config button.
   *  May not exist yet; Lens will create it with an empty skeleton when opened. */
  mcpJsonPath: string | null;
  servers: McpServersMap;
}

/**
 * Returns global + all workspace-level mcp.servers maps with source metadata.
 * Also probes for standalone .vscode/mcp.json files in each workspace folder.
 */
export function readAllMcpSources(): McpSource[] {
  const sources: McpSource[] = [];

  // ── Global ────────────────────────────────────────────────────────────────
  const globalCfg     = vscode.workspace.getConfiguration("mcp");
  const globalServers = globalCfg.get<McpServersMap>("servers") ?? {};
  const globalSettingsPath = resolveGlobalSettingsPath();
  // Global mcp.json lives next to settings.json in the User folder
  const globalMcpJsonPath  = globalSettingsPath
    ? path.join(path.dirname(globalSettingsPath), "mcp.json")
    : null;

  sources.push({
    label: "Global",
    scope: "global",
    filePath: globalSettingsPath,
    mcpJsonPath: globalMcpJsonPath,
    servers: globalServers,
  });

  // ── Per-workspace folder ──────────────────────────────────────────────────
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const vscodDir    = path.join(folder.uri.fsPath, ".vscode");
    const mcpJsonPath = path.join(vscodDir, "mcp.json");
    const settingsPath = path.join(vscodDir, "settings.json");

    // .vscode/mcp.json (standalone — preferred)
    if (fs.existsSync(mcpJsonPath)) {
      try {
        const raw    = fs.readFileSync(mcpJsonPath, "utf8");
        const parsed = JSON.parse(raw) as { servers?: McpServersMap };
        sources.push({
          label: `${folder.name} (.vscode/mcp.json)`,
          scope: "workspace",
          filePath: mcpJsonPath,       // both buttons point to the same file
          mcpJsonPath: mcpJsonPath,
          servers: parsed.servers ?? {},
        });
      } catch {
        sources.push({
          label: `${folder.name} (.vscode/mcp.json — parse error)`,
          scope: "workspace",
          filePath: mcpJsonPath,
          mcpJsonPath: mcpJsonPath,
          servers: {},
        });
      }
    }

    // .vscode/settings.json → mcp.servers (only when mcp.json doesn't exist)
    if (!fs.existsSync(mcpJsonPath) && fs.existsSync(settingsPath)) {
      try {
        const raw      = fs.readFileSync(settingsPath, "utf8");
        const parsed   = JSON.parse(raw) as { mcp?: { servers?: McpServersMap } };
        const wsServers = parsed.mcp?.servers;
        if (wsServers && Object.keys(wsServers).length > 0) {
          sources.push({
            label: `${folder.name} (settings.json)`,
            scope: "workspace",
            filePath: settingsPath,
            mcpJsonPath: mcpJsonPath,  // doesn't exist yet — Lens will scaffold it
            servers: wsServers,
          });
        }
      } catch {
        // silently skip malformed settings.json
      }
    }
  }

  return sources;
}

/** Opens (and creates if absent) the dedicated mcp.json file for a source. */
export function ensureMcpJsonExists(mcpJsonPath: string): void {
  if (fs.existsSync(mcpJsonPath)) return;
  try {
    fs.mkdirSync(path.dirname(mcpJsonPath), { recursive: true });
    fs.writeFileSync(mcpJsonPath, JSON.stringify({ servers: {} }, null, 2) + "\n", "utf8");
  } catch {
    // best-effort — if it fails the open will show an error naturally
  }
}

function resolveGlobalSettingsPath(): string | null {
  // VS Code stores global settings in a well-known location per OS
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const candidates: string[] = [];

  if (process.platform === "win32") {
    const appData = process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming");
    candidates.push(path.join(appData, "Code", "User", "settings.json"));
  } else if (process.platform === "darwin") {
    candidates.push(
      path.join(home, "Library", "Application Support", "Code", "User", "settings.json")
    );
  } else {
    candidates.push(path.join(home, ".config", "Code", "User", "settings.json"));
    candidates.push(path.join(home, ".config", "Code - OSS", "User", "settings.json"));
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── Flat server list from all sources (used as the authoritative server list) ──

export interface McpServerInfo {
  name: string;
  url: string;
  entry: McpServerEntry;
}

/**
 * Returns all unique MCP servers from every source (global settings.json,
 * workspace mcp.json, workspace settings.json).  Later sources win on name
 * collision so workspace-level definitions shadow global ones.
 */
export function readAllMcpServers(): McpServerInfo[] {
  const sources = readAllMcpSources();
  const map = new Map<string, McpServerInfo>();
  for (const src of sources) {
    for (const [name, entry] of Object.entries(src.servers)) {
      const url = String((entry as McpServerEntry).url ?? "");
      map.set(name, { name, url, entry: entry as McpServerEntry });
    }
  }
  return [...map.values()];
}

