import * as cp from "child_process";
import { McpServerEntry } from "./mcpConfig";
import { ToolInfo, queryHttpTools, queryStdioTools } from "./mcpClient";
import { getLogger } from "./logger";

export type ServerStatus = "idle" | "connecting" | "connected" | "error" | "stopped";

export interface ServerState {
  status: ServerStatus;
  tools: ToolInfo[];
  error?: string;
  /** only set for stdio servers */
  proc?: cp.ChildProcess;
}

export class ServerStateManager {
  private readonly states = new Map<string, ServerState>();
  private onChangeCallback?: () => void;

  onStateChange(cb: () => void): void {
    this.onChangeCallback = cb;
  }

  getState(key: string): ServerState {
    return this.states.get(key) ?? { status: "idle", tools: [] };
  }

  /** key = `scope::name`, e.g. "global::my-mcp-server" or "workspace::local-mcp" */
  async connect(key: string, entry: McpServerEntry, authHeaders: Record<string, string>): Promise<void> {
    const current = this.getState(key);
    if (current.status === "connecting") return;

    this.setState(key, { status: "connecting", tools: current.tools });

    try {
      const type = (entry.type as string | undefined) ?? "http";
      const serverHeaders: Record<string, string> = {
        ...(entry.headers as Record<string, string> | undefined ?? {}),
        ...authHeaders,
      };

      if (type === "stdio") {
        if (!entry.command) throw new Error("stdio server missing 'command'");
        const args = Array.isArray(entry.args) ? (entry.args as string[]) : [];
        const envExtra = (entry.env as Record<string, string> | undefined) ?? {};
        const { tools, proc } = await queryStdioTools(
          String(entry.command), args, envExtra,
          (p) => {
            p.on("exit", () => {
              const st = this.getState(key);
              if (st.status !== "stopped") {
                this.setState(key, { ...st, status: "error", error: "Process exited unexpectedly" });
              }
            });
          }
        );
        this.setState(key, { status: "connected", tools, proc });
        getLogger().info(`[${key}] connected via stdio, ${tools.length} tools`);
      } else {
        // http / sse / streamable-http all use HTTP transport
        const url = String(entry.url ?? "");
        if (!url) throw new Error("HTTP server missing 'url'");
        const allowInsecure = Boolean((entry as { allowInsecureTls?: boolean }).allowInsecureTls);
        const tools = await queryHttpTools(url, serverHeaders, allowInsecure);
        this.setState(key, { status: "connected", tools });
        getLogger().info(`[${key}] connected via HTTP, ${tools.length} tools`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      getLogger().error(`[${key}] connect failed: ${msg}`);
      this.setState(key, { status: "error", tools: [], error: msg });
    }
  }

  stop(key: string): void {
    const st = this.getState(key);
    st.proc?.kill();
    this.setState(key, { status: "stopped", tools: [] });
    getLogger().info(`[${key}] stopped`);
  }

  reset(key: string): void {
    const st = this.getState(key);
    if (st.status === "connecting") return;
    st.proc?.kill();
    this.setState(key, { status: "idle", tools: [] });
  }

  private setState(key: string, state: ServerState): void {
    this.states.set(key, state);
    this.onChangeCallback?.();
  }

  dispose(): void {
    for (const [key, st] of this.states) {
      if (st.proc) {
        st.proc.kill();
        getLogger().info(`[${key}] killed on dispose`);
      }
    }
    this.states.clear();
  }
}
