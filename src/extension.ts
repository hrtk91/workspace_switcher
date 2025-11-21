import * as vscode from 'vscode';
import { promises as fs, Dirent } from 'fs';
import * as path from 'path';

async function getRootDirectory(): Promise<string | undefined> {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile) {
        return path.dirname(workspaceFile.fsPath);
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        return folders[0].uri.fsPath;
    }

    return undefined;
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        return entries
            .filter((entry: Dirent) => entry.isFile() && entry.name.endsWith('.code-workspace'))
            .map(entry => path.join(root, entry.name));
    } catch (err: any) {
        // Ignore permission errors but rethrow unexpected issues so the user knows
        if (err && err.code === 'EACCES') {
            return [];
        }
        throw err;
    }
}

async function pickWorkspace(workspaces: string[]): Promise<string | undefined> {
    if (workspaces.length === 0) {
        vscode.window.showInformationMessage('No .code-workspace files found in the root directory.');
        return;
    }

    const items = workspaces.map(fullPath => ({
        label: path.basename(fullPath),
        description: fullPath
    }));

    const choice = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a workspace to open'
    });

    return choice?.description;
}

async function switchWorkspace(): Promise<void> {
    const root = await getRootDirectory();
    if (!root) {
        vscode.window.showErrorMessage('No folder or workspace is currently open.');
        return;
    }

    const workspaces = await listWorkspaceFiles(root);
    const target = await pickWorkspace(workspaces);
    if (!target) {
        return;
    }

    const uri = vscode.Uri.file(target);
    // Reuse the current window instead of opening a new one
    await vscode.commands.executeCommand('vscode.openFolder', uri, false);
}

export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('workspaceSwitcher.switchInRoot', switchWorkspace);
    context.subscriptions.push(disposable);
}

export function deactivate() {
    // nothing to clean up
}
