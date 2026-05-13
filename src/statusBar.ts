import * as vscode from "vscode";

export class StatusBarItem {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "mcpAuth.showStatus";
    this.item.show();
  }

  setSignedOut(): void {
    this.item.text = "$(key) MCP Auth: Sign In";
    this.item.tooltip = "Click to sign in to MCP server";
    this.item.command = "mcpAuth.authenticate";
    this.item.backgroundColor = undefined;
  }

  setAuthenticating(userCode: string): void {
    this.item.text = `$(sync~spin) MCP Auth: ${userCode}`;
    this.item.tooltip = `Waiting for browser authentication (code: ${userCode})`;
    this.item.command = "mcpAuth.showStatus";
    this.item.backgroundColor = undefined;
  }

  setSignedIn(expiresAt: number): void {
    const expiresIn = Math.round((expiresAt - Date.now()) / 60000);
    this.item.text = `$(check) MCP Auth: Signed In`;
    this.item.tooltip = `Signed in — token expires in ~${expiresIn} min. Click for details.`;
    this.item.command = "mcpAuth.showStatus";
    this.item.backgroundColor = undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
