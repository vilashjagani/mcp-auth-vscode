import * as vscode from "vscode";
import { AuthMethod, ServerAuthConfig } from "./authTypes";

export interface McpServerTarget {
  name: string;
  url: string;
}

/**
 * Non-sensitive per-server auth settings stored in settings.json.
 * Sensitive values (clientSecret, password, apiKey) live ONLY in SecretStorage.
 */
export interface ServerNonSensitiveConfig {
  method?: AuthMethod;
  clientId?: string;
  deviceAuthEndpoint?: string;
  tokenEndpoint?: string;
  scopes?: string;
  apiKeyHeader?: string;
  allowInsecureTls?: boolean;
  /** Username for Basic Auth — not sensitive, can live in settings. */
  username?: string;
}

export interface IdpConfig {
  tokenRefreshBuffer: number;
  allowInsecureTls: boolean;
  /** Per-server non-sensitive configs keyed by server name */
  serverConfigs: Record<string, ServerNonSensitiveConfig>;
  /** @deprecated use readAllMcpServers() from mcpConfig.ts */
  mcpServerName: string;
  /** @deprecated use readAllMcpServers() from mcpConfig.ts */
  mcpServerUrl: string;
}

export function getConfig(): IdpConfig {
  const cfg = vscode.workspace.getConfiguration("mcpAuth");
  return {
    tokenRefreshBuffer: cfg.get<number>("tokenRefreshBuffer", 60),
    allowInsecureTls:   cfg.get<boolean>("allowInsecureTls", false),
    serverConfigs:      cfg.get<Record<string, ServerNonSensitiveConfig>>("serverConfigs", {}),
    mcpServerName:      cfg.get<string>("mcpServerName", ""),
    mcpServerUrl:       cfg.get<string>("mcpServerUrl", ""),
  };
}

/** Returns the non-sensitive config stored for a specific server (empty object if none). */
export function getServerConfig(serverName: string): ServerNonSensitiveConfig {
  const config = getConfig();
  return config.serverConfigs[serverName] ?? {};
}

/**
 * Merges updates into the stored non-sensitive config for a server and saves to global settings.
 * Only call with non-sensitive fields — never pass clientSecret, password, or apiKey here.
 */
export async function saveServerConfig(
  serverName: string,
  updates: Partial<ServerNonSensitiveConfig>
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("mcpAuth");
  const existing: Record<string, ServerNonSensitiveConfig> =
    cfg.get<Record<string, ServerNonSensitiveConfig>>("serverConfigs") ?? {};
  existing[serverName] = { ...(existing[serverName] ?? {}), ...updates };
  await cfg.update("serverConfigs", existing, vscode.ConfigurationTarget.Global);
}

/**
 * Builds a resolved ServerAuthConfig for a server from its stored non-sensitive settings.
 * Sensitive fields (clientSecret, password, apiKey) are NOT included here — callers
 * must merge them in from SecretStorage.
 */
export function resolveServerAuthConfig(serverName: string): ServerAuthConfig {
  const saved = getServerConfig(serverName);
  const globalCfg = getConfig();
  return {
    method:             saved.method ?? "device",
    clientId:           saved.clientId,
    deviceAuthEndpoint: saved.deviceAuthEndpoint,
    tokenEndpoint:      saved.tokenEndpoint,
    scopes:             saved.scopes,
    apiKeyHeader:       saved.apiKeyHeader ?? "x-api-key",
    allowInsecureTls:   saved.allowInsecureTls ?? globalCfg.allowInsecureTls,
    username:           saved.username,
    // sensitive fields are intentionally absent — callers add them from SecretStorage
  };
}

function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch { return false; }
}

export function validateDeviceConfig(cfg: ServerAuthConfig): string | null {
  if (!cfg.clientId)           return "clientId is required — enter it when prompted";
  if (!cfg.deviceAuthEndpoint) return "deviceAuthEndpoint is required — enter it when prompted";
  if (!isValidUrl(cfg.deviceAuthEndpoint!)) return `deviceAuthEndpoint is not a valid URL: "${cfg.deviceAuthEndpoint}"`;
  if (!cfg.tokenEndpoint)      return "tokenEndpoint is required — enter it when prompted";
  if (!isValidUrl(cfg.tokenEndpoint!))      return `tokenEndpoint is not a valid URL: "${cfg.tokenEndpoint}"`;
  return null;
}

export function validateClientCredentialsConfig(cfg: ServerAuthConfig): string | null {
  if (!cfg.clientId)      return "clientId is required";
  if (!cfg.clientSecret)  return "clientSecret is required";
  if (!cfg.tokenEndpoint) return "tokenEndpoint is required";
  if (!isValidUrl(cfg.tokenEndpoint!)) return `tokenEndpoint is not a valid URL: "${cfg.tokenEndpoint}"`;
  return null;
}

export function validatePasswordGrantConfig(cfg: ServerAuthConfig): string | null {
  if (!cfg.clientId)      return "clientId is required";
  if (!cfg.tokenEndpoint) return "tokenEndpoint is required";
  if (!isValidUrl(cfg.tokenEndpoint!)) return `tokenEndpoint is not a valid URL: "${cfg.tokenEndpoint}"`;
  if (!cfg.username)      return "username is required";
  if (!cfg.password)      return "password is required";
  // clientSecret is optional — omitted for public clients
  return null;
}
