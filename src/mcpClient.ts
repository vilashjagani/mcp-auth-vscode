/**
 * Lightweight MCP JSON-RPC client.
 * Supports: HTTP streamable (2024-11-05) and stdio transports.
 * No external dependencies — uses Node built-ins only.
 */

import * as https from "https";
import * as http from "http";
import * as cp from "child_process";

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id?: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function rawPost(
  endpoint: string,
  body: Buffer,
  headers: Record<string, string | number>,
  allowInsecureTls: boolean,
  timeoutMs: number
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch {
      reject(new Error(`Invalid MCP server URL: "${endpoint}"`));
      return;
    }

    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? "443" : "80"),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Content-Length": body.length,
        ...headers,
      },
      ...(isHttps && allowInsecureTls ? { rejectUnauthorized: false } : {}),
    };

    const timer = setTimeout(
      () => reject(new Error(`Request to ${endpoint} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }); });
    });
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    req.write(body);
    req.end();
  });
}

function extractJsonRpc(body: string, contentType: string, id: number): JsonRpcResponse | null {
  // Handle SSE (text/event-stream) body — look for matching data: line
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      try {
        const msg = JSON.parse(json) as JsonRpcResponse;
        if (msg.id === id) return msg;
      } catch { /* skip */ }
    }
    return null;
  }
  // application/json
  try {
    return JSON.parse(body) as JsonRpcResponse;
  } catch {
    return null;
  }
}

async function postJsonRpc(
  url: string,
  extraHeaders: Record<string, string>,
  allowInsecureTls: boolean,
  req: JsonRpcRequest,
  timeoutMs = 10_000
): Promise<{ resp: JsonRpcResponse | null; sessionId: string | undefined }> {
  const body = Buffer.from(JSON.stringify(req), "utf8");
  const res = await rawPost(url, body, extraHeaders as Record<string, string | number>, allowInsecureTls, timeoutMs);

  if (res.status >= 400) {
    const preview = res.body.replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`HTTP ${res.status} from MCP server. Response: ${preview}`);
  }

  const sessionId = res.headers["mcp-session-id"] as string | undefined;
  const contentType = String(res.headers["content-type"] ?? "application/json");

  if (req.id === undefined) {
    // notification — no response expected
    return { resp: null, sessionId };
  }

  const parsed = extractJsonRpc(res.body, contentType, req.id);
  if (!parsed) {
    throw new Error(`Could not parse JSON-RPC response for id=${req.id}. Body (first 300): ${res.body.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  return { resp: parsed, sessionId };
}

// ─── HTTP tools query ─────────────────────────────────────────────────────────

export async function queryHttpTools(
  url: string,
  headers: Record<string, string>,
  allowInsecureTls: boolean
): Promise<ToolInfo[]> {
  // 1. initialize
  const { resp: initResp, sessionId } = await postJsonRpc(url, headers, allowInsecureTls, {
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-auth-lens", version: "0.1.0" },
    },
    id: 1,
  });

  if (initResp?.error) {
    throw new Error(`MCP initialize failed: ${initResp.error.message}`);
  }

  const sessionHdrs: Record<string, string> = { ...headers };
  if (sessionId) sessionHdrs["Mcp-Session-Id"] = sessionId;

  // 2. notifications/initialized (no response)
  await postJsonRpc(url, sessionHdrs, allowInsecureTls, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  }).catch(() => {});

  // 3. tools/list
  const { resp: toolsResp } = await postJsonRpc(url, sessionHdrs, allowInsecureTls, {
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
    id: 2,
  });

  if (toolsResp?.error) {
    throw new Error(`tools/list failed: ${toolsResp.error.message}`);
  }

  const result = toolsResp?.result as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> } | undefined;
  return (result?.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description?.trim() || "(no description)",
    inputSchema: t.inputSchema,
  }));
}

// ─── stdio tools query ────────────────────────────────────────────────────────

export interface StdioResult {
  tools: ToolInfo[];
  proc: cp.ChildProcess;
}

export async function queryStdioTools(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  onSpawn?: (proc: cp.ChildProcess) => void
): Promise<StdioResult> {
  const proc = cp.spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  onSpawn?.(proc);

  const tools = await new Promise<ToolInfo[]>((resolve, reject) => {
    const TIMEOUT = 15_000;
    let buf = "";
    let initDone = false;
    let pendingId: number | null = null;

    const timer = setTimeout(
      () => reject(new Error(`Stdio server "${command}" timed out after ${TIMEOUT}ms`)),
      TIMEOUT
    );

    const cleanup = () => { clearTimeout(timer); proc.stdout!.removeAllListeners("data"); };

    proc.on("error", (err) => { cleanup(); reject(new Error(`Failed to start "${command}": ${err.message}`)); });
    proc.on("close", (code) => {
      if (pendingId !== null) {
        cleanup();
        reject(new Error(`Process "${command}" exited (code ${code ?? "?"}) before completing`));
      }
    });

    proc.stderr?.on("data", () => { /* drain stderr silently */ });

    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let msg: JsonRpcResponse;
        try { msg = JSON.parse(line) as JsonRpcResponse; } catch { continue; }

        if (!initDone && msg.id === 1) {
          if (msg.error) { cleanup(); reject(new Error(`Initialize failed: ${msg.error.message}`)); return; }
          initDone = true;
          // Send notifications/initialized
          const notif: JsonRpcRequest = { jsonrpc: "2.0", method: "notifications/initialized", params: {} };
          proc.stdin!.write(JSON.stringify(notif) + "\n");
          // Send tools/list
          pendingId = 2;
          const tlReq: JsonRpcRequest = { jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 };
          proc.stdin!.write(JSON.stringify(tlReq) + "\n");
        } else if (msg.id === pendingId) {
          cleanup();
          pendingId = null;
          if (msg.error) { reject(new Error(`tools/list failed: ${msg.error.message}`)); return; }
          const result = msg.result as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> } | undefined;
          resolve((result?.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description?.trim() || "(no description)",
            inputSchema: t.inputSchema,
          })));
        }
      }
    });

    // Send initialize
    const initReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-auth-lens", version: "0.1.0" },
      },
      id: 1,
    };
    proc.stdin!.write(JSON.stringify(initReq) + "\n");
  });

  return { tools, proc };
}
