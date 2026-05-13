import * as vscode from "vscode";

export interface McpServerTarget {
  name: string;
  url: string;
}

export interface IdpConfig {
  clientId: string;
  deviceAuthEndpoint: string;
  tokenEndpoint: string;
  scopes: string;
  /** @deprecated use mcpServers */
  mcpServerName: string;
  /** @deprecated use mcpServers */
  mcpServerUrl: string;
  /** Preferred: list of MCP server entries to authenticate */
  mcpServers: McpServerTarget[];
  tokenRefreshBuffer: number;
  allowInsecureTls: boolean;
}

export function getConfig(): IdpConfig {
  const cfg = vscode.workspace.getConfiguration("mcpAuth");
  const mcpServerName = cfg.get<string>("mcpServerName", "mcp-server");
  const mcpServerUrl  = cfg.get<string>("mcpServerUrl", "");
  const rawServers    = cfg.get<Array<{ name?: string; url?: string }>>("mcpServers", []);
  const mcpServers: McpServerTarget[] = rawServers
    .filter((s) => s.name && s.url)
    .map((s) => ({ name: s.name!, url: s.url! }));

  return {
    clientId: cfg.get<string>("clientId", ""),
    deviceAuthEndpoint: cfg.get<string>("deviceAuthEndpoint", ""),
    tokenEndpoint: cfg.get<string>("tokenEndpoint", ""),
    scopes: cfg.get<string>("scopes", "openid profile email"),
    mcpServerName,
    mcpServerUrl,
    mcpServers,
    tokenRefreshBuffer: cfg.get<number>("tokenRefreshBuffer", 60),
    allowInsecureTls: cfg.get<boolean>("allowInsecureTls", false),
  };
}

/** Returns the effective list of MCP server targets.
 *  Prefers the mcpServers array; falls back to single mcpServerName/Url entry. */
export function getEffectiveServers(config: IdpConfig): McpServerTarget[] {
  if (config.mcpServers.length > 0) return config.mcpServers;
  if (config.mcpServerName) return [{ name: config.mcpServerName, url: config.mcpServerUrl }];
  return [];
}

function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function validateConfig(config: IdpConfig): string | null {
  if (!config.clientId) return "mcpAuth.clientId is required";
  if (!config.deviceAuthEndpoint) return "mcpAuth.deviceAuthEndpoint is required";
  if (!isValidUrl(config.deviceAuthEndpoint))
    return `mcpAuth.deviceAuthEndpoint is not a valid URL: "${config.deviceAuthEndpoint}"`;
  if (!config.tokenEndpoint) return "mcpAuth.tokenEndpoint is required";
  if (!isValidUrl(config.tokenEndpoint))
    return `mcpAuth.tokenEndpoint is not a valid URL: "${config.tokenEndpoint}"`;
  return null;
}
