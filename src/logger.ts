import * as vscode from "vscode";

class Logger {
  private readonly channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel("MCP Auth");
  }

  show(): void {
    this.channel.show(true);
  }

  info(msg: string): void {
    this.write("INFO ", msg);
  }

  error(msg: string): void {
    this.write("ERROR", msg);
  }

  request(method: string, url: string, headers: Record<string, unknown>, body: string): void {
    this.write("REQ  ", `${method} ${url}`);
    this.write("     ", `Headers: ${JSON.stringify(headers)}`);
    // redact sensitive values but show param names
    const redacted = body.replace(/=([\w.@%-]{4,})/g, "=<redacted>");
    this.write("     ", `Body: ${redacted}`);
  }

  response(status: number, contentType: string, body: string): void {
    this.write("RES  ", `HTTP ${status}  content-type: ${contentType}`);
    this.write("     ", `Body: ${body.replace(/\s+/g, " ").slice(0, 2000)}`);
  }

  private write(level: string, msg: string): void {
    const ts = new Date().toISOString();
    this.channel.appendLine(`[${ts}] ${level}  ${msg}`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

// module-level singleton — created once in activate(), used everywhere
let instance: Logger | undefined;

export function createLogger(): Logger {
  instance = new Logger();
  return instance;
}

export function getLogger(): Logger {
  if (!instance) throw new Error("Logger not initialised");
  return instance;
}
