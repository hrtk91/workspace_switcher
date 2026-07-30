import * as vscode from 'vscode';
import { promises as fs, constants, Dirent } from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

// #region 現在のworkspaceから探索起点を決定する

/**
 * 現在開いているworkspaceまたはfolderから、実在する探索起点を返す。
 */
async function getRootDirectory(): Promise<string | undefined> {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile) {
        const workspaceDirectory = path.dirname(workspaceFile.fsPath);
        if (await isDirectory(workspaceDirectory)) {
            return workspaceDirectory;
        }
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
        for (const folder of folders) {
            if (await isDirectory(folder.uri.fsPath)) {
                return folder.uri.fsPath;
            }
        }
    }

    return undefined;
}

/**
 * 指定パスが実在するディレクトリかを返す。
 */
async function isDirectory(target: string): Promise<boolean> {
    try {
        return (await fs.stat(target)).isDirectory();
    } catch {
        return false;
    }
}

// #endregion

// #region Gitリポジトリに属するworktreeを検出する

interface WorktreeInfo {
    path: string;
    head?: string;
    branch?: string;
}

/**
 * 指定ディレクトリが属するGit worktreeのルートを返す。
 */
async function getGitTopLevel(dir: string): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile('git', ['rev-parse', '--show-toplevel'], { cwd: dir }, (err, stdout) => {
            if (err) { resolve(undefined); return; }
            resolve(stdout.trim());
        });
    });
}

/**
 * Gitのporcelain出力を、表示とworkspace生成に必要なworktree情報へ変換する。
 */
async function getWorktrees(dir: string): Promise<WorktreeInfo[]> {
    return new Promise(resolve => {
        execFile('git', ['worktree', 'list', '--porcelain'], { cwd: dir }, (err, stdout) => {
            if (err) { resolve([]); return; }
            const worktrees: WorktreeInfo[] = [];
            for (const block of stdout.trim().split('\n\n')) {
                const worktree: Partial<WorktreeInfo> = {};
                for (const line of block.split('\n')) {
                    if (line.startsWith('worktree ')) {
                        worktree.path = line.slice('worktree '.length);
                    } else if (line.startsWith('HEAD ')) {
                        worktree.head = line.slice('HEAD '.length);
                    } else if (line.startsWith('branch refs/heads/')) {
                        worktree.branch = line.slice('branch refs/heads/'.length);
                    }
                }
                if (worktree.path) {
                    worktrees.push(worktree as WorktreeInfo);
                }
            }
            resolve(worktrees);
        });
    });
}

// #endregion

// #region workspace候補を列挙し、選択先へテンプレートを配置する

interface WorkspaceItem extends vscode.QuickPickItem {
    fullPath: string;
    templatePath?: string;
}

interface SearchDirectory {
    path: string;
    worktree?: WorktreeInfo;
}

/**
 * 指定ディレクトリの直下にあるworkspaceファイルを列挙する。
 * 読み取れない、または既に存在しないディレクトリは候補なしとして扱う。
 */
async function listWorkspaceFiles(dir: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries
            .filter((entry: Dirent) => entry.isFile() && entry.name.endsWith('.code-workspace'))
            .map(entry => path.join(dir, entry.name));
    } catch (err: any) {
        if (err && ['EACCES', 'ENOENT', 'ENOTDIR'].includes(err.code)) {
            return [];
        }
        throw err;
    }
}

/**
 * workspace候補をQuickPickで表示し、ユーザーが選択した項目を返す。
 */
async function pickWorkspace(workspaces: WorkspaceItem[]): Promise<WorkspaceItem | undefined> {
    if (workspaces.length === 0) {
        vscode.window.showInformationMessage('No .code-workspace files found.');
        return;
    }

    const choice = await vscode.window.showQuickPick(workspaces, {
        placeHolder: 'Select a workspace to open'
    });

    return choice;
}

/**
 * テンプレート由来の候補を選択先worktreeへコピーし、開くworkspaceのパスを返す。
 * 選択後に同名ファイルが作られていた場合は既存ファイルを優先する。
 */
async function materializeWorkspace(item: WorkspaceItem): Promise<string> {
    if (!item.templatePath) {
        return item.fullPath;
    }

    try {
        await fs.copyFile(item.templatePath, item.fullPath, constants.COPYFILE_EXCL);
    } catch (err: any) {
        if (err?.code !== 'EEXIST') {
            throw err;
        }
    }

    return item.fullPath;
}

// #endregion

// #region workspace切り替えコマンドを実行する

/**
 * 現在のGitリポジトリに属するworktreeからworkspaceを選択して開く。
 */
async function switchWorkspace(): Promise<void> {
    // 処理順:
    // 1. 現在のworkspaceから探索起点を決定し、利用可能か検証する。
    // 2. Git worktreeを列挙し、main worktreeのworkspaceファイルをテンプレートとして取得する。
    // 3. 各worktreeのworkspace候補を表示用データへ変換する。
    // 4. 選択されたworktreeに必要ならworkspaceファイルをコピーする。
    // 5. 選択先のworkspaceを新しいVS Codeウィンドウで開く。

    // 1. 現在のworkspaceから探索起点を決定し、利用可能か検証する。
    const root = await getRootDirectory();
    if (!root) {
        const hasWorkspaceLocation = Boolean(
            vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
        );
        const message = hasWorkspaceLocation
            ? 'The current workspace location no longer exists. Open an existing folder or workspace and try again.'
            : 'No folder or workspace is currently open.';
        vscode.window.showErrorMessage(message);
        return;
    }

    // 2. Git worktreeを列挙し、main worktreeのworkspaceファイルをテンプレートとして取得する。
    let searchDirs: SearchDirectory[] = [{ path: root }];
    let templateFiles: string[] = [];

    const topLevel = await getGitTopLevel(root);
    if (topLevel) {
        const worktrees = await getWorktrees(topLevel);
        const worktreeExists = await Promise.all(
            worktrees.map(worktree => isDirectory(worktree.path))
        );
        const existingWorktrees = worktrees
            .filter((_, index) => worktreeExists[index])
            .map(worktree => ({ path: worktree.path, worktree }));

        if (existingWorktrees.length > 0) {
            searchDirs = existingWorktrees;
            templateFiles = await listWorkspaceFiles(existingWorktrees[0].path);
        }
    }

    // 3. 各worktreeのworkspace候補を表示用データへ変換する。
    const items: WorkspaceItem[] = [];
    for (const searchDir of searchDirs) {
        const dir = searchDir.path;
        const files = await listWorkspaceFiles(dir);
        const candidates: Array<{ fullPath: string; templatePath?: string }> = files.length > 0
            ? files.map(fullPath => ({ fullPath }))
            : templateFiles.map(templatePath => ({
                fullPath: path.join(dir, path.basename(templatePath)),
                templatePath,
            }));

        for (const candidate of candidates) {
            const dirLabel = path.basename(dir);
            const worktreeDescription = searchDir.worktree?.branch
                ?? (searchDir.worktree?.head ? `detached@${searchDir.worktree.head.slice(0, 7)}` : undefined);
            items.push({
                label: searchDir.worktree ? dirLabel : path.basename(candidate.fullPath),
                description: worktreeDescription ?? candidate.fullPath,
                detail: searchDir.worktree ? candidate.fullPath : undefined,
                fullPath: candidate.fullPath,
                templatePath: candidate.templatePath,
            });
        }
    }

    // 4. 選択されたworktreeに必要ならworkspaceファイルをコピーする。
    const choice = await pickWorkspace(items);
    if (!choice) {
        return;
    }

    const target = await materializeWorkspace(choice);

    // 5. 選択先のworkspaceを新しいVS Codeウィンドウで開く。
    const uri = vscode.Uri.file(target);
    await vscode.commands.executeCommand('vscode.openFolder', uri, false);
}

// #endregion

// #region VS Code拡張のライフサイクルを管理する

/**
 * workspace切り替えコマンドをVS Codeへ登録する。
 */
export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('workspaceSwitcher.switchInRoot', switchWorkspace);
    context.subscriptions.push(disposable);
}

/**
 * 拡張停止時の後処理は不要なため何もしない。
 */
export function deactivate() {
    // nothing to clean up
}

// #endregion
