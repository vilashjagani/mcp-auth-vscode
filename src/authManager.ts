import * as vscode from "vscode";
import { getConfig, validateConfig, getEffectiveServers } from "./config";
import { TokenStorage, TokenSet } from "./tokenStorage";
import { startDeviceAuth, pollForToken, refreshAccessToken } from "./deviceAuth";
import { writeMcpToken, clearMcpToken } from "./mcpConfig";
import { StatusBarItem } from "./statusBar";
import { getLogger } from "./logger";
import { LensPanel } from "./lensPanel";

export class AuthManager {
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private currentAbort: AbortController | undefined;
  private lens?: LensPanel;

  constructor(
    private readonly storage: TokenStorage,
    private readonly statusBar: StatusBarItem
  ) {}

  setLens(lens: LensPanel): void {
    this.lens = lens;
  }

  /** Called on extension activation — restores existing session or prompts if expired */
  async initialize(): Promise<void> {
    const tokens = await this.storage.load();
    if (!tokens) {
      this.statusBar.setSignedOut();
      return;
    }

    const config = getConfig();
    if (!this.storage.isExpired(tokens, config.tokenRefreshBuffer)) {
      await this.applyToken(tokens);
      this.scheduleRefresh(tokens);
      return;
    }

    if (tokens.refreshToken) {
      try {
        await this.doRefresh(tokens.refreshToken);
        return;
      } catch {
        // refresh failed — fall through to signed-out state
      }
    }

    this.statusBar.setSignedOut();
  }

  async signIn(): Promise<void> {
    const config = getConfig();
    const configError = validateConfig(config);
    if (configError) {
      const action = await vscode.window.showErrorMessage(
        `MCP Auth: ${configError}`,
        "Open Settings"
      );
      if (action === "Open Settings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "mcpAuth"
        );
      }
      return;
    }

    this.currentAbort?.abort();
    this.currentAbort = new AbortController();

    let deviceResp;
    try {
      deviceResp = await startDeviceAuth(config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      getLogger().error(`Device auth failed: ${msg}`);
      const action = await vscode.window.showErrorMessage(
        `MCP Auth: Device auth request failed — see log for details`,
        "Show Log",
        "Show Details",
        "Open Settings"
      );
      if (action === "Show Log") {
        getLogger().show();
      } else if (action === "Show Details") {
        vscode.window.showErrorMessage(msg, { modal: true });
      } else if (action === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "mcpAuth");
      }
      return;
    }

    const verificationUrl =
      deviceResp.verification_uri_complete ?? deviceResp.verification_uri;

    const action = await vscode.window.showInformationMessage(
      `MCP Auth: Open the browser and enter code  ${deviceResp.user_code}`,
      "Open Browser",
      "Copy Code",
      "Cancel"
    );

    if (action === "Cancel") {
      this.currentAbort.abort();
      return;
    }
    if (action === "Copy Code") {
      await vscode.env.clipboard.writeText(deviceResp.user_code);
    }
    if (action === "Open Browser" || action === "Copy Code") {
      await vscode.env.openExternal(vscode.Uri.parse(verificationUrl));
    }

    this.statusBar.setAuthenticating(deviceResp.user_code);

    let tokens: TokenSet;
    try {
      tokens = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `MCP Auth: Waiting for browser login (code: ${deviceResp.user_code})`,
          cancellable: true,
        },
        async (_progress, cancelToken) => {
          cancelToken.onCancellationRequested(() => this.currentAbort?.abort());
          return pollForToken(
            config,
            deviceResp.device_code,
            deviceResp.interval ?? 5,
            deviceResp.expires_in,
            () => {},
            this.currentAbort!.signal
          );
        }
      );
    } catch (err) {
      this.statusBar.setSignedOut();
      if (!this.currentAbort?.signal.aborted) {
        vscode.window.showErrorMessage(`MCP Auth: Authentication failed: ${String(err)}`);
      }
      return;
    }

    await this.storage.save(tokens);
    await this.applyToken(tokens);
    this.scheduleRefresh(tokens);
    vscode.window.showInformationMessage("MCP Auth: Signed in successfully");
  }

  async signOut(): Promise<void> {
    this.cancelRefreshTimer();
    await this.storage.clear();
    const config = getConfig();
    const targets = getEffectiveServers(config);
    await Promise.all(targets.map((t) => clearMcpToken(t.name)));
    this.statusBar.setSignedOut();
    this.lens?.setTokenState(null);
    vscode.window.showInformationMessage("MCP Auth: Signed out");
  }

  async showStatus(): Promise<void> {
    const tokens = await this.storage.load();
    if (!tokens) {
      vscode.window.showInformationMessage("MCP Auth: Not signed in");
      return;
    }
    const expiresIn = Math.round((tokens.expiresAt - Date.now()) / 1000);
    const minutes = Math.floor(expiresIn / 60);
    const seconds = expiresIn % 60;
    vscode.window.showInformationMessage(
      `MCP Auth: Signed in — token expires in ${minutes}m ${seconds}s`
    );
  }

  private async doRefresh(refreshToken: string): Promise<void> {
    const config = getConfig();
    const tokens = await refreshAccessToken(config, refreshToken);
    await this.storage.save(tokens);
    await this.applyToken(tokens);
    this.scheduleRefresh(tokens);
  }

  private async applyToken(tokens: TokenSet): Promise<void> {
    const config  = getConfig();
    const targets = getEffectiveServers(config);
    await Promise.all(
      targets.map((t) => writeMcpToken(t.name, tokens.accessToken, tokens.tokenType, t.url))
    );
    this.statusBar.setSignedIn(tokens.expiresAt);
    this.lens?.setTokenState({
      expiresAt: tokens.expiresAt,
      accessToken: tokens.accessToken,
      tokenType: tokens.tokenType,
    });
  }

  private scheduleRefresh(tokens: TokenSet): void {
    this.cancelRefreshTimer();
    const config = getConfig();
    const delay = tokens.expiresAt - Date.now() - config.tokenRefreshBuffer * 1000;
    if (delay <= 0) {
      if (tokens.refreshToken) {
        this.doRefresh(tokens.refreshToken).catch(() => this.statusBar.setSignedOut());
      }
      return;
    }
    this.refreshTimer = setTimeout(async () => {
      const stored = await this.storage.load();
      if (!stored?.refreshToken) {
        this.statusBar.setSignedOut();
        return;
      }
      try {
        await this.doRefresh(stored.refreshToken);
      } catch {
        this.statusBar.setSignedOut();
        vscode.window.showWarningMessage(
          "MCP Auth: Token refresh failed — please sign in again",
          "Sign In"
        ).then((action) => {
          if (action === "Sign In") this.signIn();
        });
      }
    }, delay);
  }

  private cancelRefreshTimer(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  dispose(): void {
    this.cancelRefreshTimer();
    this.currentAbort?.abort();
  }
}
