import * as vscode from "vscode";

const SECRET_KEY = "mcpAuth.tokens";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // unix epoch ms
  tokenType: string;
}

export class TokenStorage {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async save(tokens: TokenSet): Promise<void> {
    await this.secrets.store(SECRET_KEY, JSON.stringify(tokens));
  }

  async load(): Promise<TokenSet | null> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TokenSet;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }

  isExpired(tokens: TokenSet, bufferSeconds = 60): boolean {
    return Date.now() >= tokens.expiresAt - bufferSeconds * 1000;
  }
}
