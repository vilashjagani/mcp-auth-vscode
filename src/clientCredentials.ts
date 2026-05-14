import { ServerAuthConfig } from "./authTypes";
import { ServerAuthState } from "./authTypes";
import { getLogger } from "./logger";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

function encodeForm(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function post(endpoint: string, body: string, allowInsecureTls: boolean): Promise<{ status: number; body: string; contentType: string }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const isHttps = endpoint.startsWith("https:");
  const lib: typeof import("https") = isHttps
    ? require("https")
    : require("http");

  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch {
      reject(new Error(`Invalid tokenEndpoint: "${endpoint}"`)); return;
    }
    const headers: Record<string, string | number> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? "443" : "80"),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers,
      ...(isHttps && allowInsecureTls ? { rejectUnauthorized: false } : {}),
    };
    getLogger().request("POST", endpoint, headers, body);
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c));
      res.on("end", () => {
        const result = { status: res.statusCode ?? 0, body: data, contentType: String(res.headers["content-type"] ?? "") };
        getLogger().response(result.status, result.contentType, result.body);
        resolve(result);
      });
    });
    req.on("error", (err: Error) => { getLogger().error(`Network error: ${err.message}`); reject(err); });
    req.write(body);
    req.end();
  });
}

export async function fetchClientCredentialsToken(cfg: ServerAuthConfig): Promise<ServerAuthState> {
  getLogger().info(`Client Credentials → ${cfg.tokenEndpoint}`);
  const params: Record<string, string> = {
    grant_type: "client_credentials",
    client_id: cfg.clientId!,
    client_secret: cfg.clientSecret!,
  };
  if (cfg.scopes) params["scope"] = cfg.scopes;

  const result = await post(cfg.tokenEndpoint!, encodeForm(params), cfg.allowInsecureTls ?? false);
  const resp = parseTokenResponse(result, "client_credentials");

  getLogger().info("client_credentials token received");
  return {
    method: "client_credentials",
    accessToken: resp.access_token,
    tokenType: resp.token_type ?? "Bearer",
    expiresAt: Date.now() + (resp.expires_in ?? 3600) * 1000,
  };
}

export async function fetchPasswordGrantToken(cfg: ServerAuthConfig): Promise<ServerAuthState> {
  getLogger().info(`Password Grant → ${cfg.tokenEndpoint}`);
  const params: Record<string, string> = {
    grant_type: "password",
    client_id: cfg.clientId!,
    username: cfg.username!,
    password: cfg.password!,
  };
  // client_secret is optional — some IDPs use public clients (no secret required)
  if (cfg.clientSecret) params["client_secret"] = cfg.clientSecret;
  if (cfg.scopes) params["scope"] = cfg.scopes;

  const result = await post(cfg.tokenEndpoint!, encodeForm(params), cfg.allowInsecureTls ?? false);
  const resp = parseTokenResponse(result, "password");

  getLogger().info("password grant token received");
  return {
    method: "password",
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token,
    tokenType: resp.token_type ?? "Bearer",
    expiresAt: Date.now() + (resp.expires_in ?? 3600) * 1000,
  };
}

function parseTokenResponse(result: { status: number; body: string; contentType: string }, grantType: string): TokenResponse {
  let resp: TokenResponse;
  try { resp = JSON.parse(result.body) as TokenResponse; }
  catch { throw new Error(`${grantType}: server returned non-JSON (HTTP ${result.status})`); }
  if (resp.error || !resp.access_token) {
    throw new Error(`${grantType} error: ${resp.error} — ${resp.error_description ?? ""}`);
  }
  return resp;
}
