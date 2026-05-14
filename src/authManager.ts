import * as vscode from "vscode";
import {
  getConfig,
  getServerConfig,
  saveServerConfig,
  resolveServerAuthConfig,
  validateDeviceConfig,
  validateClientCredentialsConfig,
  validatePasswordGrantConfig,
} from "./config";
import { DeviceAuthParams, startDeviceAuth, pollForToken, refreshAccessToken } from "./deviceAuth";
import { ServerAuthStorage } from "./serverAuthStorage";
import { ServerAuthState, AuthMethod, ServerAuthConfig } from "./authTypes";
import { fetchClientCredentialsToken, fetchPasswordGrantToken } from "./clientCredentials";
import { writeMcpToken, clearMcpToken, readAllMcpServers, McpServerInfo } from "./mcpConfig";
import { StatusBarItem } from "./statusBar";
import { getLogger } from "./logger";
import { LensPanel } from "./lensPanel";

const LEGACY_KEY = "mcpAuth.tokens";

export class AuthManager {
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private currentAborts = new Map<string, AbortController>();
  private lens?: LensPanel;

  constructor(
    private readonly storage: ServerAuthStorage,
    private readonly statusBar: StatusBarItem,
    private readonly secrets: vscode.SecretStorage
  ) {}

  setLens(lens: LensPanel): void { this.lens = lens; }

  async initialize(): Promise<void> {
    const servers = readAllMcpServers();
    await this.migrateLegacyToken(servers);

    const config = getConfig();
    let anySignedIn = false;

    for (const server of servers) {
      const state = await this.storage.load(server.name);
      if (!state) continue;

      if (state.method === "basic" || state.method === "api_key") {
        await this.applyServerAuth(server, state);
        anySignedIn = true;
      } else if (!this.storage.isExpired(state, config.tokenRefreshBuffer)) {
        await this.applyServerAuth(server, state);
        this.scheduleRefresh(server, state);
        anySignedIn = true;
      } else if (state.refreshToken || (state.method === "client_credentials" && state.clientSecret) || (state.method === "password" && state.password)) {
        try {
          await this.doRefresh(server, state);
          anySignedIn = true;
        } catch {
          await this.storage.clear(server.name);
        }
      } else {
        await this.storage.clear(server.name);
      }
    }

    if (!anySignedIn) this.statusBar.setSignedOut();
    this.lens?.refreshAuthStates(await this.loadAllStates());
  }

  // ── Sign In ───────────────────────────────────────────────────────────────

  async signIn(serverName?: string): Promise<void> {
    const servers = readAllMcpServers();

    if (servers.length === 0) {
      const action = await vscode.window.showErrorMessage(
        "MCP Auth: No MCP servers found. Add servers to mcp.servers in settings or a .vscode/mcp.json file.",
        "Open Settings"
      );
      if (action === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "mcp.servers");
      }
      return;
    }

    if (serverName) {
      const server = servers.find((s) => s.name === serverName);
      if (!server) {
        vscode.window.showErrorMessage(`MCP Auth: server "${serverName}" not found`);
        return;
      }
      await this.signInServer(server);
      return;
    }

    if (servers.length === 1) {
      await this.signInServer(servers[0]!);
      return;
    }

    // Multiple servers — loop until Escape
    while (true) {
      const allStates = await this.loadAllStates();
      const items = servers.map((s) => {
        const state = allStates[s.name];
        const saved = getServerConfig(s.name);
        const methodLabel = saved.method ?? "not configured";
        const detail = state
          ? `$(check) signed in · ${state.method}${state.expiresAt ? " · " + this.formatExpiry(state.expiresAt) : " · static"}`
          : `$(circle-slash) not signed in${saved.method ? " · method: " + methodLabel : ""}`;
        return { label: s.name, description: s.url || "(stdio)", detail, server: s };
      });

      const picked = await vscode.window.showQuickPick(items, {
        title: "MCP Auth: Select Server to Sign In",
        placeHolder: "Choose an MCP server — Escape when done",
        matchOnDetail: true,
      });
      if (!picked) return;

      await this.signInServer(picked.server);
    }
  }

  private async signInServer(server: McpServerInfo): Promise<void> {
    // Load saved (non-sensitive) config for this server to pre-select method
    const saved = getServerConfig(server.name);

    const METHOD_ITEMS: { label: string; description: string; method: AuthMethod }[] = [
      { label: "$(key) Device Auth Flow",       description: "Browser-based login (OAuth 2.0 RFC 8628)",                    method: "device" },
      { label: "$(shield) Client Credentials",  description: "grant_type=client_credentials — client_id + client_secret",   method: "client_credentials" },
      { label: "$(person) Password Grant",      description: "grant_type=password — client_id + client_secret + user creds", method: "password" },
      { label: "$(lock) Basic Auth",            description: "HTTP Basic — username + password as Authorization header",     method: "basic" },
      { label: "$(key) API Key",                description: "Static API key injected as a request header",                  method: "api_key" },
    ];

    const picked = await vscode.window.showQuickPick(
      METHOD_ITEMS.map((m) => ({ ...m, picked: m.method === saved.method })),
      { title: `MCP Auth: Auth method for "${server.name}"`, placeHolder: "Select authentication method" }
    );
    if (!picked) return;

    const method: AuthMethod = picked.method;

    // Save the chosen method immediately so it's pre-selected next time
    if (method !== saved.method) {
      await saveServerConfig(server.name, { method });
    }

    // Build auth config from saved non-sensitive settings (no sensitive data here)
    const authCfg: ServerAuthConfig = { ...resolveServerAuthConfig(server.name), method };

    switch (method) {
      case "device":             return this.signInDevice(server, authCfg);
      case "client_credentials": return this.signInClientCredentials(server, authCfg);
      case "password":           return this.signInPasswordGrant(server, authCfg);
      case "basic":              return this.signInBasic(server, authCfg);
      case "api_key":            return this.signInApiKey(server, authCfg);
    }
  }

  // ── Device Auth Flow ──────────────────────────────────────────────────────

  private async signInDevice(server: McpServerInfo, authCfg: ServerAuthConfig): Promise<void> {
    // Prompt for any missing non-sensitive fields and save them
    authCfg = await this.ensureDeviceConfig(server.name, authCfg);
    if (!authCfg) return;

    const err = validateDeviceConfig(authCfg);
    if (err) { await this.showConfigError(err); return; }

    this.currentAborts.get(server.name)?.abort();
    const abort = new AbortController();
    this.currentAborts.set(server.name, abort);

    const idpCfg = this.toDeviceAuthParams(authCfg);
    let deviceResp;
    try {
      deviceResp = await startDeviceAuth(idpCfg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      getLogger().error(`Device auth failed [${server.name}]: ${msg}`);
      const action = await vscode.window.showErrorMessage(
        `MCP Auth [${server.name}]: Device auth request failed — see Output log`,
        "Show Log", "Open Settings"
      );
      if (action === "Show Log") getLogger().show();
      else if (action === "Open Settings") await vscode.commands.executeCommand("workbench.action.openSettings", `mcpAuth.serverConfigs`);
      return;
    }

    const verificationUrl = deviceResp.verification_uri_complete ?? deviceResp.verification_uri;
    const action = await vscode.window.showInformationMessage(
      `MCP Auth [${server.name}]: Enter code  ${deviceResp.user_code}  in your browser`,
      "Open Browser", "Copy Code", "Cancel"
    );
    if (action === "Cancel") { abort.abort(); return; }
    if (action === "Copy Code") await vscode.env.clipboard.writeText(deviceResp.user_code);
    if (action === "Open Browser" || action === "Copy Code") await vscode.env.openExternal(vscode.Uri.parse(verificationUrl));

    this.statusBar.setAuthenticating(deviceResp.user_code);

    let tokenSet: import("./tokenStorage").TokenSet;
    try {
      tokenSet = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `MCP Auth [${server.name}]: Waiting for login (${deviceResp.user_code})`, cancellable: true },
        async (_p, cancelToken) => {
          cancelToken.onCancellationRequested(() => abort.abort());
          return pollForToken(idpCfg, deviceResp.device_code, deviceResp.interval ?? 5, deviceResp.expires_in, () => {}, abort.signal);
        }
      );
    } catch (e) {
      this.statusBar.setSignedOut();
      if (!abort.signal.aborted) vscode.window.showErrorMessage(`MCP Auth [${server.name}]: Auth failed: ${String(e)}`);
      return;
    }

    const state: ServerAuthState = {
      method: "device",
      accessToken: tokenSet.accessToken,
      refreshToken: tokenSet.refreshToken,
      tokenType: tokenSet.tokenType,
      expiresAt: tokenSet.expiresAt,
    };
    await this.storage.save(server.name, state);
    await this.applyServerAuth(server, state);
    this.scheduleRefresh(server, state);
    vscode.window.showInformationMessage(`MCP Auth [${server.name}]: Signed in via Device Auth`);
    this.lens?.refreshAuthStates(await this.loadAllStates());
  }

  // ── Client Credentials ────────────────────────────────────────────────────

  private async signInClientCredentials(server: McpServerInfo, authCfg: ServerAuthConfig): Promise<void> {
    // Prompt for missing non-sensitive fields (clientId, tokenEndpoint → saved to settings)
    // and the clientSecret (prompted but stored ONLY in SecretStorage)
    authCfg = await this.ensureClientCredentialsConfig(server.name, authCfg);
    if (!authCfg) return;

    const err = validateClientCredentialsConfig(authCfg);
    if (err) { await this.showConfigError(err); return; }

    try {
      const tokenState = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `MCP Auth [${server.name}]: Fetching token…`, cancellable: false },
        () => fetchClientCredentialsToken(authCfg)
      );
      // Store clientSecret in the auth state so silent refresh works — it stays in SecretStorage
      const state: ServerAuthState = { ...tokenState, clientSecret: authCfg.clientSecret };
      await this.storage.save(server.name, state);
      await this.applyServerAuth(server, state);
      this.scheduleRefresh(server, state);
      vscode.window.showInformationMessage(`MCP Auth [${server.name}]: Signed in via Client Credentials`);
      this.lens?.refreshAuthStates(await this.loadAllStates());
    } catch (e) {
      vscode.window.showErrorMessage(`MCP Auth [${server.name}]: ${String(e)}`);
    }
  }

  // ── Password Grant ────────────────────────────────────────────────────────

  private async signInPasswordGrant(server: McpServerInfo, authCfg: ServerAuthConfig): Promise<void> {
    authCfg = await this.ensurePasswordGrantConfig(server.name, authCfg);
    if (!authCfg) return;

    const err = validatePasswordGrantConfig(authCfg);
    if (err) { await this.showConfigError(err); return; }

    try {
      const tokenState = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `MCP Auth [${server.name}]: Fetching token…`, cancellable: false },
        () => fetchPasswordGrantToken(authCfg)
      );
      // Store clientSecret and password in SecretStorage (via ServerAuthState) for silent refresh
      const state: ServerAuthState = {
        ...tokenState,
        clientSecret: authCfg.clientSecret,
        password: authCfg.password,
      };
      await this.storage.save(server.name, state);
      await this.applyServerAuth(server, state);
      this.scheduleRefresh(server, state);
      vscode.window.showInformationMessage(`MCP Auth [${server.name}]: Signed in via Password Grant`);
      this.lens?.refreshAuthStates(await this.loadAllStates());
    } catch (e) {
      vscode.window.showErrorMessage(`MCP Auth [${server.name}]: ${String(e)}`);
    }
  }

  // ── Basic Auth ────────────────────────────────────────────────────────────

  private async signInBasic(server: McpServerInfo, authCfg: ServerAuthConfig): Promise<void> {
    // username can be saved to settings (not sensitive); password MUST NOT be saved
    let username = authCfg.username;
    if (!username) {
      username = await vscode.window.showInputBox({
        title: `Basic Auth — Username for "${server.name}"`,
        prompt: "Enter username (will be saved to settings)",
        ignoreFocusOut: true,
      });
      if (!username) return;
      await saveServerConfig(server.name, { username });
    }

    const password = await vscode.window.showInputBox({
      title: `Basic Auth — Password for "${server.name}"`,
      prompt: "Password — stored securely in SecretStorage only, never in settings.json",
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) return;

    const token = Buffer.from(`${username}:${password}`).toString("base64");
    const state: ServerAuthState = { method: "basic", accessToken: token, tokenType: "Basic" };
    await this.storage.save(server.name, state);
    await this.applyServerAuth(server, state);
    this.statusBar.setSignedIn(undefined);
    vscode.window.showInformationMessage(`MCP Auth [${server.name}]: Basic Auth configured`);
    this.lens?.refreshAuthStates(await this.loadAllStates());
  }

  // ── API Key ───────────────────────────────────────────────────────────────

  private async signInApiKey(server: McpServerInfo, authCfg: ServerAuthConfig): Promise<void> {
    // apiKeyHeader can be saved; apiKey MUST NOT be saved to settings
    let apiKeyHeader = authCfg.apiKeyHeader ?? "x-api-key";

    const headerInput = await vscode.window.showInputBox({
      title: `API Key Header for "${server.name}"`,
      prompt: "Header name to inject (e.g. x-api-key, Authorization) — saved to settings",
      value: apiKeyHeader,
      ignoreFocusOut: true,
    });
    if (headerInput === undefined) return;
    apiKeyHeader = headerInput || "x-api-key";

    if (apiKeyHeader !== authCfg.apiKeyHeader) {
      await saveServerConfig(server.name, { apiKeyHeader });
    }

    const apiKey = await vscode.window.showInputBox({
      title: `API Key for "${server.name}"`,
      prompt: "Enter API key — stored securely in SecretStorage only, never in settings.json",
      password: true,
      ignoreFocusOut: true,
    });
    if (!apiKey) return;

    const state: ServerAuthState = {
      method: "api_key",
      accessToken: apiKey,
      tokenType: apiKeyHeader,   // tokenType carries the header name for api_key
    };
    await this.storage.save(server.name, state);
    await this.applyServerAuth(server, state);
    this.statusBar.setSignedIn(undefined);
    vscode.window.showInformationMessage(`MCP Auth [${server.name}]: API Key configured`);
    this.lens?.refreshAuthStates(await this.loadAllStates());
  }

  // ── Sign Out ──────────────────────────────────────────────────────────────

  async signOut(serverName?: string): Promise<void> {
    const servers = readAllMcpServers();

    if (serverName) {
      await this.doSignOut(servers.filter((s) => s.name === serverName));
      vscode.window.showInformationMessage(`MCP Auth [${serverName}]: Signed out`);
      return;
    }

    if (servers.length === 1) {
      await this.doSignOut(servers);
      vscode.window.showInformationMessage(`MCP Auth [${servers[0]!.name}]: Signed out`);
      return;
    }

    const allStates = await this.loadAllStates();
    const signedInServers = servers.filter((s) => allStates[s.name] !== null);
    if (signedInServers.length === 0) {
      vscode.window.showInformationMessage("MCP Auth: No servers are currently signed in");
      return;
    }

    const serverItems = signedInServers.map((s) => {
      const state = allStates[s.name]!;
      const detail = `${state.method}${state.expiresAt ? " · " + this.formatExpiry(state.expiresAt) : " · static"}`;
      return { label: `$(server) ${s.name}`, description: s.url, detail, name: s.name };
    });

    const picked = await vscode.window.showQuickPick(
      [
        { label: "$(sign-out) Sign out ALL servers", description: "", detail: `${signedInServers.length} server(s) signed in`, name: "__all__" },
        ...serverItems,
      ],
      { title: "MCP Auth: Sign Out — select server", placeHolder: "Choose a server to sign out", matchOnDetail: true }
    );
    if (!picked) return;

    if (picked.name === "__all__") {
      await this.doSignOut(servers);
      vscode.window.showInformationMessage("MCP Auth: Signed out from all servers");
    } else {
      await this.doSignOut(servers.filter((s) => s.name === picked.name));
      vscode.window.showInformationMessage(`MCP Auth [${picked.name}]: Signed out`);
    }
  }

  private async doSignOut(servers: McpServerInfo[]): Promise<void> {
    for (const server of servers) {
      this.cancelRefreshTimer(server.name);
      this.currentAborts.get(server.name)?.abort();
      await this.storage.clear(server.name);
      await clearMcpToken(server.name);
    }
    const allStates = await this.loadAllStates();
    if (!Object.values(allStates).some((s) => s !== null)) this.statusBar.setSignedOut();
    this.lens?.refreshAuthStates(allStates);
  }

  async showStatus(): Promise<void> {
    const servers = readAllMcpServers();
    if (servers.length === 0) { vscode.window.showInformationMessage("MCP Auth: No MCP servers found"); return; }
    const lines: string[] = [];
    for (const server of servers) {
      const state = await this.storage.load(server.name);
      if (!state) {
        const saved = getServerConfig(server.name);
        lines.push(`${server.name}: Not signed in${saved.method ? " (method: " + saved.method + ")" : ""}`);
        continue;
      }
      lines.push(state.expiresAt
        ? `${server.name}: ${state.method} — ${this.formatExpiry(state.expiresAt)}`
        : `${server.name}: ${state.method} — static credentials`
      );
    }
    vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
  }

  async loadAllStates(): Promise<Record<string, ServerAuthState | null>> {
    const result: Record<string, ServerAuthState | null> = {};
    for (const server of readAllMcpServers()) {
      result[server.name] = await this.storage.load(server.name);
    }
    return result;
  }

  // ── Config-gathering helpers (prompt missing fields, save non-sensitive) ──

  /**
   * Ensures all required device-auth fields are present.
   * Missing non-sensitive fields (clientId, endpoints, scopes) are prompted
   * and immediately saved to mcpAuth.serverConfigs[serverName] in settings.json.
   * Returns null if the user cancels any prompt.
   */
  private async ensureDeviceConfig(serverName: string, cfg: ServerAuthConfig): Promise<ServerAuthConfig> {
    let { clientId, deviceAuthEndpoint, tokenEndpoint, scopes } = cfg;

    if (!clientId) {
      clientId = await vscode.window.showInputBox({
        title: `[${serverName}] Device Auth — Client ID`,
        prompt: "OAuth client_id for this server's IDP (saved to settings, not sensitive)",
        ignoreFocusOut: true,
      });
      if (!clientId) return null as unknown as ServerAuthConfig;
      await saveServerConfig(serverName, { clientId });
    }

    if (!deviceAuthEndpoint) {
      deviceAuthEndpoint = await vscode.window.showInputBox({
        title: `[${serverName}] Device Auth — Device Authorization Endpoint`,
        prompt: "e.g. https://idp.example.com/oauth2/device_authz (saved to settings)",
        ignoreFocusOut: true,
      });
      if (!deviceAuthEndpoint) return null as unknown as ServerAuthConfig;
      await saveServerConfig(serverName, { deviceAuthEndpoint });
    }

    if (!tokenEndpoint) {
      tokenEndpoint = await vscode.window.showInputBox({
        title: `[${serverName}] Device Auth — Token Endpoint`,
        prompt: "e.g. https://idp.example.com/oauth2/token (saved to settings)",
        ignoreFocusOut: true,
      });
      if (!tokenEndpoint) return null as unknown as ServerAuthConfig;
      await saveServerConfig(serverName, { tokenEndpoint });
    }

    if (!scopes) {
      const scopeInput = await vscode.window.showInputBox({
        title: `[${serverName}] Device Auth — Scopes`,
        prompt: "Space-separated OAuth scopes (saved to settings)",
        value: "openid profile email",
        ignoreFocusOut: true,
      });
      if (scopeInput === undefined) return null as unknown as ServerAuthConfig;
      scopes = scopeInput || "openid profile email";
      await saveServerConfig(serverName, { scopes });
    }

    return { ...cfg, clientId, deviceAuthEndpoint, tokenEndpoint, scopes };
  }

  /**
   * Ensures all required client_credentials fields are present.
   * clientId and tokenEndpoint are saved to settings (not sensitive).
   * clientSecret is prompted but stored ONLY in SecretStorage via ServerAuthState — never settings.
   * Returns null if the user cancels any prompt.
   */
  private async ensureClientCredentialsConfig(serverName: string, cfg: ServerAuthConfig): Promise<ServerAuthConfig> {
    let { clientId, tokenEndpoint, clientSecret, scopes } = cfg;

    if (!clientId) {
      clientId = await vscode.window.showInputBox({
        title: `[${serverName}] Client Credentials — Client ID`,
        prompt: "OAuth client_id (saved to settings, not sensitive)",
        ignoreFocusOut: true,
      });
      if (!clientId) return null as unknown as ServerAuthConfig;
      await saveServerConfig(serverName, { clientId });
    }

    if (!tokenEndpoint) {
      tokenEndpoint = await vscode.window.showInputBox({
        title: `[${serverName}] Client Credentials — Token Endpoint`,
        prompt: "e.g. https://idp.example.com/oauth2/token (saved to settings)",
        ignoreFocusOut: true,
      });
      if (!tokenEndpoint) return null as unknown as ServerAuthConfig;
      await saveServerConfig(serverName, { tokenEndpoint });
    }

    if (!scopes) {
      const scopeInput = await vscode.window.showInputBox({
        title: `[${serverName}] Client Credentials — Scopes (optional)`,
        prompt: "Space-separated scopes, leave blank to omit",
        value: "",
        ignoreFocusOut: true,
      });
      if (scopeInput === undefined) return null as unknown as ServerAuthConfig;
      if (scopeInput) {
        scopes = scopeInput;
        await saveServerConfig(serverName, { scopes });
      }
    }

    if (!clientSecret) {
      clientSecret = await vscode.window.showInputBox({
        title: `[${serverName}] Client Credentials — Client Secret`,
        prompt: "Stored securely in SecretStorage — NOT saved to settings.json",
        password: true,
        ignoreFocusOut: true,
      });
      if (!clientSecret) return null as unknown as ServerAuthConfig;
      // deliberately not calling saveServerConfig here — secret stays in memory only
    }

    return { ...cfg, clientId, tokenEndpoint, clientSecret, scopes: scopes || undefined };
  }

  /**
   * Ensures all required password-grant fields are present.
   * clientId, tokenEndpoint, scopes, and username → saved to settings (non-sensitive).
   * clientSecret and password → prompted but stored ONLY in SecretStorage, never settings.
   */
  private async ensurePasswordGrantConfig(serverName: string, cfg: ServerAuthConfig): Promise<ServerAuthConfig> {
    let { clientId, tokenEndpoint, scopes, username, clientSecret, password } = cfg;

    if (!clientId) {
      clientId = await vscode.window.showInputBox({
        title: `[${serverName}] Password Grant — Client ID`,
        prompt: "OAuth client_id (saved to settings, not sensitive)",
        ignoreFocusOut: true,
      });
      if (!clientId) return null as unknown as ServerAuthConfig;
      await saveServerConfig(serverName, { clientId });
    }

    if (!tokenEndpoint) {
      tokenEndpoint = await vscode.window.showInputBox({
        title: `[${serverName}] Password Grant — Token Endpoint`,
        prompt: "e.g. https://idp.example.com/oauth2/token (saved to settings)",
        ignoreFocusOut: true,
      });
      if (!tokenEndpoint) return null as unknown as ServerAuthConfig;
      await saveServerConfig(serverName, { tokenEndpoint });
    }

    if (!scopes) {
      const scopeInput = await vscode.window.showInputBox({
        title: `[${serverName}] Password Grant — Scopes (optional)`,
        prompt: "Space-separated scopes, leave blank to omit",
        ignoreFocusOut: true,
      });
      if (scopeInput === undefined) return null as unknown as ServerAuthConfig;
      if (scopeInput) {
        scopes = scopeInput;
        await saveServerConfig(serverName, { scopes });
      }
    }

    if (!username) {
      username = await vscode.window.showInputBox({
        title: `[${serverName}] Password Grant — Username`,
        prompt: "Username (saved to settings, not sensitive)",
        ignoreFocusOut: true,
      });
      if (!username) return null as unknown as ServerAuthConfig;
      await saveServerConfig(serverName, { username });
    }

    if (!clientSecret) {
      // Press Enter (leave blank) to skip — some IDPs use public clients with no secret
      const secretInput = await vscode.window.showInputBox({
        title: `[${serverName}] Password Grant — Client Secret (optional)`,
        prompt: "Leave blank if your IDP uses a public client. Stored in SecretStorage only — NOT saved to settings.json",
        password: true,
        ignoreFocusOut: true,
      });
      if (secretInput === undefined) return null as unknown as ServerAuthConfig; // Escape = cancel
      clientSecret = secretInput || undefined; // empty string → treat as absent
    }

    if (!password) {
      password = await vscode.window.showInputBox({
        title: `[${serverName}] Password Grant — User Password`,
        prompt: "Stored in SecretStorage only — NOT saved to settings.json",
        password: true,
        ignoreFocusOut: true,
      });
      if (!password) return null as unknown as ServerAuthConfig;
    }

    return { ...cfg, clientId, tokenEndpoint, scopes: scopes || undefined, username, clientSecret, password };
  }

  // ── Apply / refresh ───────────────────────────────────────────────────────

  private async applyServerAuth(server: McpServerInfo, state: ServerAuthState): Promise<void> {
    await writeMcpToken(
      server.name,
      state.accessToken!,
      state.method === "api_key" ? (state.tokenType ?? "x-api-key") : (state.tokenType ?? "Bearer"),
      server.url,
      state.method
    );
    this.statusBar.setSignedIn(state.expiresAt);
  }

  private scheduleRefresh(server: McpServerInfo, state: ServerAuthState): void {
    this.cancelRefreshTimer(server.name);
    if (!state.expiresAt) return;
    const config = getConfig();
    const delay = state.expiresAt - Date.now() - config.tokenRefreshBuffer * 1000;
    if (delay <= 0) {
      this.doRefresh(server, state).catch(() => this.statusBar.setSignedOut());
      return;
    }
    const timer = setTimeout(async () => {
      const stored = await this.storage.load(server.name);
      if (!stored) { this.statusBar.setSignedOut(); return; }
      try {
        await this.doRefresh(server, stored);
      } catch {
        this.statusBar.setSignedOut();
        vscode.window.showWarningMessage(
          `MCP Auth [${server.name}]: Token refresh failed — please sign in again`, "Sign In"
        ).then((a) => { if (a === "Sign In") this.signInServer(server); });
      }
    }, delay);
    this.refreshTimers.set(server.name, timer);
  }

  private async doRefresh(server: McpServerInfo, state: ServerAuthState): Promise<void> {
    let newState: ServerAuthState;

    if (state.method === "client_credentials" && state.clientSecret) {
      const authCfg = resolveServerAuthConfig(server.name);
      const freshState = await fetchClientCredentialsToken({ ...authCfg, clientSecret: state.clientSecret });
      newState = { ...freshState, clientSecret: state.clientSecret };

    } else if (state.method === "password" && state.password) {
      const authCfg = resolveServerAuthConfig(server.name);
      const freshState = await fetchPasswordGrantToken({
        ...authCfg,
        clientSecret: state.clientSecret,
        password: state.password,
      });
      newState = { ...freshState, clientSecret: state.clientSecret, password: state.password };

    } else if (state.refreshToken) {
      const authCfg = resolveServerAuthConfig(server.name);
      const tokenSet = await refreshAccessToken(this.toDeviceAuthParams(authCfg), state.refreshToken);
      newState = {
        method: state.method,
        accessToken: tokenSet.accessToken,
        refreshToken: tokenSet.refreshToken ?? state.refreshToken,
        tokenType: tokenSet.tokenType,
        expiresAt: tokenSet.expiresAt,
      };
    } else {
      throw new Error("No refresh mechanism available");
    }

    await this.storage.save(server.name, newState);
    await this.applyServerAuth(server, newState);
    this.scheduleRefresh(server, newState);
    this.lens?.refreshAuthStates(await this.loadAllStates());
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private toDeviceAuthParams(authCfg: ServerAuthConfig): DeviceAuthParams {
    return {
      clientId:           authCfg.clientId ?? "",
      deviceAuthEndpoint: authCfg.deviceAuthEndpoint ?? "",
      tokenEndpoint:      authCfg.tokenEndpoint ?? "",
      scopes:             authCfg.scopes ?? "openid profile email",
      allowInsecureTls:   authCfg.allowInsecureTls ?? false,
    };
  }

  private formatExpiry(expiresAt: number): string {
    const ms = expiresAt - Date.now();
    if (ms <= 0) return "expired";
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    return h > 0 ? `expires in ${h}h ${m % 60}m` : `expires in ${m}m`;
  }

  private cancelRefreshTimer(serverName: string): void {
    const t = this.refreshTimers.get(serverName);
    if (t !== undefined) { clearTimeout(t); this.refreshTimers.delete(serverName); }
  }

  private async showConfigError(msg: string): Promise<void> {
    const action = await vscode.window.showErrorMessage(`MCP Auth: ${msg}`, "Open Settings");
    if (action === "Open Settings") await vscode.commands.executeCommand("workbench.action.openSettings", "mcpAuth.serverConfigs");
  }

  private async migrateLegacyToken(servers: McpServerInfo[]): Promise<void> {
    const raw = await this.secrets.get(LEGACY_KEY);
    if (!raw) return;
    try {
      const legacy = JSON.parse(raw) as { accessToken: string; refreshToken?: string; expiresAt: number; tokenType: string };
      for (const server of servers) {
        if (!(await this.storage.load(server.name))) {
          await this.storage.save(server.name, {
            method: "device",
            accessToken: legacy.accessToken,
            refreshToken: legacy.refreshToken,
            tokenType: legacy.tokenType,
            expiresAt: legacy.expiresAt,
          });
        }
      }
    } catch { /* ignore malformed legacy */ }
    await this.secrets.delete(LEGACY_KEY);
    getLogger().info("Migrated legacy single-token to per-server storage");
  }

  dispose(): void {
    for (const [name] of this.refreshTimers) this.cancelRefreshTimer(name);
    for (const [, abort] of this.currentAborts) abort.abort();
  }
}
