import * as vscode from "vscode";
import { AuthManager } from "./authManager";
import { ServerAuthStorage } from "./serverAuthStorage";
import { StatusBarItem } from "./statusBar";
import { createLogger } from "./logger";
import { LensPanel } from "./lensPanel";
import { ServerStateManager } from "./serverStateManager";

export function activate(context: vscode.ExtensionContext): void {
  const logger = createLogger();
  const storage = new ServerAuthStorage(context.secrets);
  const statusBar = new StatusBarItem();
  const serverState = new ServerStateManager();
  const authManager = new AuthManager(storage, statusBar, context.secrets);

  const lens = new LensPanel(context.extensionUri, storage, serverState);
  authManager.setLens(lens);

  context.subscriptions.push(
    logger,
    statusBar,
    vscode.commands.registerCommand("mcpAuth.authenticate", (serverName?: string) => authManager.signIn(serverName)),
    vscode.commands.registerCommand("mcpAuth.logout",       (serverName?: string) => authManager.signOut(serverName)),
    vscode.commands.registerCommand("mcpAuth.showStatus",   () => authManager.showStatus()),
    vscode.commands.registerCommand("mcpAuth.refreshLens",  () => lens.refresh()),
    vscode.window.registerWebviewViewProvider(LensPanel.viewId, lens, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    new vscode.Disposable(() => {
      authManager.dispose();
      serverState.dispose();
      lens.dispose();
    })
  );

  authManager.initialize().catch((err) => {
    logger.error(`Initialization error: ${err}`);
  });
}

export function deactivate(): void {
  // cleanup handled via disposables registered in activate()
}
