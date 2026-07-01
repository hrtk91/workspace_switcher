import * as vscode from 'vscode';
import { promises as fs, Dirent } from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

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

async function getGitTopLevel(dir: string): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile('git', ['rev-parse', '--show-toplevel'], { cwd: dir }, (err, stdout) => {
            if (err) { resolve(undefined); return; }
            resolve(stdout.trim());
        });
    });
}

async function getWorktreePaths(dir: string): Promise<string[]> {
    return new Promise(resolve => {
        execFile('git', ['worktree', 'list', '--porcelain'], { cwd: dir }, (err, stdout) => {
            if (err) { resolve([]); return; }
            const paths: string[] = [];
            for (const line of stdout.split('\n')) {
                if (line.startsWith('worktree ')) {
                    paths.push(line.slice('worktree '.length));
                }
            }
            resolve(paths);
        });
    });
}

async function listWorkspaceFiles(dir: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries
            .filter((entry: Dirent) => entry.isFile() && entry.name.endsWith('.code-workspace'))
            .map(entry => path.join(dir, entry.name));
    } catch (err: any) {
        if (err && err.code === 'EACCES') {
            return [];
        }
        throw err;
    }
}

interface WorkspaceItem extends vscode.QuickPickItem {
    fullPath: string;
}

async function pickWorkspace(workspaces: WorkspaceItem[]): Promise<string | undefined> {
    if (workspaces.length === 0) {
        vscode.window.showInformationMessage('No .code-workspace files found.');
        return;
    }

    const choice = await vscode.window.showQuickPick(workspaces, {
        placeHolder: 'Select a workspace to open'
    });

    return choice?.fullPath;
}

async function switchWorkspace(): Promise<void> {
    const root = await getRootDirectory();
    if (!root) {
        vscode.window.showErrorMessage('No folder or workspace is currently open.');
        return;
    }

    const searchDirs: string[] = [root];

    const topLevel = await getGitTopLevel(root);
    if (topLevel) {
        const worktrees = await getWorktreePaths(topLevel);
        for (const wt of worktrees) {
            if (!searchDirs.includes(wt)) {
                searchDirs.push(wt);
            }
        }
    }

    const items: WorkspaceItem[] = [];
    for (const dir of searchDirs) {
        const files = await listWorkspaceFiles(dir);
        for (const fullPath of files) {
            const isWorktree = dir !== root;
            const dirLabel = path.basename(dir);
            items.push({
                label: path.basename(fullPath),
                description: isWorktree ? `worktree: ${dirLabel}` : fullPath,
                detail: isWorktree ? fullPath : undefined,
                fullPath,
            });
        }
    }

    const target = await pickWorkspace(items);
    if (!target) {
        return;
    }

    const uri = vscode.Uri.file(target);
    await vscode.commands.executeCommand('vscode.openFolder', uri, false);
}

export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('workspaceSwitcher.switchInRoot', switchWorkspace);
    context.subscriptions.push(disposable);
}

export function deactivate() {
    // nothing to clean up
}
