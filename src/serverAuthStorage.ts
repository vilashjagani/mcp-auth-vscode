import * as vscode from "vscode";
import { ServerAuthState } from "./authTypes";

const KEY_PREFIX = "mcpAuth.server.";

export class ServerAuthStorage {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async save(serverName: string, state: ServerAuthState): Promise<void> {
    await this.secrets.store(KEY_PREFIX + serverName, JSON.stringify(state));
  }

  async load(serverName: string): Promise<ServerAuthState | null> {
    const raw = await this.secrets.get(KEY_PREFIX + serverName);
    if (!raw) return null;
    try { return JSON.parse(raw) as ServerAuthState; } catch { return null; }
  }

  async clear(serverName: string): Promise<void> {
    await this.secrets.delete(KEY_PREFIX + serverName);
  }

  isExpired(state: ServerAuthState, bufferSeconds = 60): boolean {
    if (state.expiresAt === undefined) return false; // static creds never expire
    return Date.now() >= state.expiresAt - bufferSeconds * 1000;
  }
}
