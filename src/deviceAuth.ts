import * as https from "https";
import * as http from "http";
import { TokenSet } from "./tokenStorage";
import { getLogger } from "./logger";

/** Minimal params needed by device-auth and token-poll functions. */
export interface DeviceAuthParams {
  clientId: string;
  deviceAuthEndpoint: string;
  tokenEndpoint: string;
  scopes: string;
  allowInsecureTls: boolean;
}

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

interface HttpResult {
  status: number;
  body: string;
  contentType: string;
}

function post(endpoint: string, body: string, allowInsecureTls: boolean): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      reject(new Error(`Invalid endpoint URL: "${endpoint}"`));
      return;
    }

    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const headers: Record<string, string | number> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };

    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? "443" : "80"),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers,
      // allow bypassing self-signed / corporate gateway certs when configured
      ...(isHttps && allowInsecureTls ? { rejectUnauthorized: false } : {}),
    };

    getLogger().request("POST", endpoint, headers, body);

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const result: HttpResult = {
          status: res.statusCode ?? 0,
          body: data,
          contentType: String(res.headers["content-type"] ?? ""),
        };
        getLogger().response(result.status, result.contentType, result.body);
        resolve(result);
      });
    });
    req.on("error", (err) => {
      getLogger().error(`Network error calling ${endpoint}: ${err.message}`);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

function parseJsonOrThrow(result: HttpResult, context: string): Record<string, unknown> {
  const looksLikeJson =
    result.contentType.includes("application/json") ||
    result.body.trimStart().startsWith("{");

  if (!looksLikeJson) {
    throw new Error(
      `${context} failed — HTTP ${result.status}, server did not return JSON.\n` +
      `Content-Type: ${result.contentType}\n` +
      `Response (first 500 chars):\n${result.body.replace(/\s+/g, " ").slice(0, 500)}\n\n` +
      `Possible causes:\n` +
      `  • Wrong endpoint URL (check mcpAuth.deviceAuthEndpoint / tokenEndpoint)\n` +
      `  • Client ID not registered for Device Authorization Grant\n` +
      `  • Corporate proxy / site-gateway intercepting the request\n` +
      `  • TLS certificate issue — try enabling mcpAuth.allowInsecureTls\n` +
      `\nSee the "MCP Auth" Output Channel for the full request/response log.`
    );
  }

  try {
    return JSON.parse(result.body) as Record<string, unknown>;
  } catch {
    throw new Error(
      `${context} — HTTP ${result.status}, response looked like JSON but failed to parse.\n` +
      `Response: ${result.body.replace(/\s+/g, " ").slice(0, 500)}`
    );
  }
}

function encodeForm(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export async function startDeviceAuth(config: DeviceAuthParams): Promise<DeviceAuthResponse> {
  getLogger().info(`Starting device auth → ${config.deviceAuthEndpoint}`);
  getLogger().info(`client_id=${config.clientId}  scope=${config.scopes}`);

  const body = encodeForm({ client_id: config.clientId, scope: config.scopes });
  const result = await post(config.deviceAuthEndpoint, body, config.allowInsecureTls);
  const parsed = parseJsonOrThrow(result, "Device authorization request");

  if (parsed["error"]) {
    throw new Error(
      `Device auth error: ${parsed["error"]} — ${parsed["error_description"] ?? ""}`
    );
  }
  if (result.status >= 400) {
    throw new Error(
      `Device auth request failed with HTTP ${result.status}: ${result.body.slice(0, 200)}`
    );
  }

  return parsed as unknown as DeviceAuthResponse;
}

export async function pollForToken(
  config: DeviceAuthParams,
  deviceCode: string,
  intervalSeconds: number,
  expiresIn: number,
  onWaiting: () => void,
  signal: AbortSignal
): Promise<TokenSet> {
  const deadline = Date.now() + expiresIn * 1000;
  let interval = intervalSeconds * 1000;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("Authentication cancelled");

    await sleep(interval);

    getLogger().info("Polling token endpoint…");
    const body = encodeForm({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: config.clientId,
    });

    const result = await post(config.tokenEndpoint, body, config.allowInsecureTls);
    const resp = parseJsonOrThrow(result, "Token polling request") as unknown as TokenResponse;

    if (resp.access_token) {
      getLogger().info("Token received successfully");
      return {
        accessToken: resp.access_token,
        refreshToken: resp.refresh_token,
        tokenType: resp.token_type ?? "Bearer",
        expiresAt: Date.now() + (resp.expires_in ?? 3600) * 1000,
      };
    }

    if (resp.error === "authorization_pending" || resp.error === "slow_down") {
      if (resp.error === "slow_down") {
        interval += 5000;
        getLogger().info("slow_down received — increasing poll interval");
      }
      onWaiting();
      continue;
    }

    throw new Error(`Token error: ${resp.error} — ${resp.error_description ?? ""}`);
  }

  throw new Error("Device code expired — please try signing in again");
}

export async function refreshAccessToken(
  config: DeviceAuthParams,
  refreshToken: string
): Promise<TokenSet> {
  getLogger().info("Refreshing access token…");
  const body = encodeForm({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    scope: config.scopes,
  });

  const result = await post(config.tokenEndpoint, body, config.allowInsecureTls);
  const resp = parseJsonOrThrow(result, "Token refresh request") as unknown as TokenResponse;

  if (!resp.access_token) {
    throw new Error(`Refresh error: ${resp.error} — ${resp.error_description ?? ""}`);
  }
  getLogger().info("Token refreshed successfully");
  return {
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token ?? refreshToken,
    tokenType: resp.token_type ?? "Bearer",
    expiresAt: Date.now() + (resp.expires_in ?? 3600) * 1000,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
