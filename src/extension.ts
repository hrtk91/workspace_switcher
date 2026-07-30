import * as vscode from 'vscode';
import { promises as fs, constants, Dirent } from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

// #region 現在のworkspaceから探索起点を決定する

/**
 * 現在開いているworkspaceまたはfolderから、実在する探索起点を返す。
 */
async function resolveExistingWorkspaceRootDirectory(): Promise<string | undefined> {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile) {
        const workspaceDirectory = path.dirname(workspaceFile.fsPath);
        if (await doesDirectoryExist(workspaceDirectory)) {
            return workspaceDirectory;
        }
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
        for (const folder of folders) {
            if (await doesDirectoryExist(folder.uri.fsPath)) {
                return folder.uri.fsPath;
            }
        }
    }

    return undefined;
}

/**
 * 指定パスが実在するディレクトリかを返す。
 */
async function doesDirectoryExist(directoryPath: string): Promise<boolean> {
    try {
        return (await fs.stat(directoryPath)).isDirectory();
    } catch {
        return false;
    }
}

// #endregion

// #region Gitリポジトリに属するworktreeを検出する

interface GitWorktreeInfo {
    path: string;
    head?: string;
    branch?: string;
}

/**
 * 指定ディレクトリが属するGit worktreeのルートを返す。
 */
async function resolveGitTopLevelDirectory(
    directoryPath: string
): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile('git', ['rev-parse', '--show-toplevel'], { cwd: directoryPath }, (err, stdout) => {
            if (err) { resolve(undefined); return; }
            resolve(stdout.trim());
        });
    });
}

/**
 * Git worktreeのporcelain出力をworktree情報へ変換する。
 */
function parseGitWorktreePorcelainOutput(output: string): GitWorktreeInfo[] {
    const worktrees: GitWorktreeInfo[] = [];
    for (const block of output.trim().split('\n\n')) {
        const worktree: Partial<GitWorktreeInfo> = {};
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
            worktrees.push(worktree as GitWorktreeInfo);
        }
    }
    return worktrees;
}

/**
 * 指定Gitリポジトリに登録されたworktree情報を返す。
 */
async function listGitWorktrees(
    gitTopLevelDirectoryPath: string
): Promise<GitWorktreeInfo[]> {
    return new Promise(resolve => {
        execFile(
            'git',
            ['worktree', 'list', '--porcelain'],
            { cwd: gitTopLevelDirectoryPath },
            (err, stdout) => {
                if (err) {
                    resolve([]);
                    return;
                }
                resolve(parseGitWorktreePorcelainOutput(stdout));
            }
        );
    });
}

/**
 * Gitに登録されたworktreeから、現在もディレクトリが存在するものを返す。
 */
async function listExistingGitWorktrees(
    gitTopLevelDirectoryPath: string
): Promise<GitWorktreeInfo[]> {
    const worktrees = await listGitWorktrees(gitTopLevelDirectoryPath);
    const worktreeExists = await Promise.all(
        worktrees.map(worktree => doesDirectoryExist(worktree.path))
    );

    return worktrees.filter((_, index) => worktreeExists[index]);
}

// #endregion

// #region workspace候補を列挙し、選択先へテンプレートを配置する

interface WorkspaceCandidate extends vscode.QuickPickItem {
    workspaceFilePath: string;
    templateFilePath?: string;
}

interface WorkspaceSearchTarget {
    directoryPath: string;
    worktree?: GitWorktreeInfo;
}

interface WorkspaceSearchContext {
    targets: WorkspaceSearchTarget[];
    templateFilePaths: string[];
}

interface WorkspaceFileSource {
    workspaceFilePath: string;
    templateFilePath?: string;
}

/**
 * 指定ディレクトリの直下にあるworkspaceファイルを列挙する。
 * 読み取れない、または既に存在しないディレクトリは候補なしとして扱う。
 */
async function listWorkspaceFilePathsInDirectory(
    directoryPath: string
): Promise<string[]> {
    try {
        const entries = await fs.readdir(directoryPath, { withFileTypes: true });
        return entries
            .filter((entry: Dirent) => entry.isFile() && entry.name.endsWith('.code-workspace'))
            .map(entry => path.join(directoryPath, entry.name));
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
async function selectWorkspaceCandidateWithQuickPick(
    candidates: WorkspaceCandidate[]
): Promise<WorkspaceCandidate | undefined> {
    if (candidates.length === 0) {
        vscode.window.showInformationMessage('No .code-workspace files found.');
        return;
    }

    return vscode.window.showQuickPick(candidates, {
        placeHolder: 'Select a workspace to open'
    });
}

/**
 * テンプレート由来の候補を選択先worktreeへコピーし、開くworkspaceのパスを返す。
 * 選択後に同名ファイルが作られていた場合は既存ファイルを優先する。
 */
async function getOrCreateWorkspaceFilePathForCandidate(
    candidate: WorkspaceCandidate
): Promise<string> {
    if (!candidate.templateFilePath) {
        return candidate.workspaceFilePath;
    }

    try {
        await fs.copyFile(
            candidate.templateFilePath,
            candidate.workspaceFilePath,
            constants.COPYFILE_EXCL
        );
    } catch (err: any) {
        if (err?.code !== 'EEXIST') {
            throw err;
        }
    }

    return candidate.workspaceFilePath;
}

/**
 * 探索起点から、workspace候補の検索対象とmain worktreeのテンプレートを返す。
 */
async function resolveWorkspaceSearchContext(
    rootDirectoryPath: string
): Promise<WorkspaceSearchContext> {
    const fallbackContext: WorkspaceSearchContext = {
        targets: [{ directoryPath: rootDirectoryPath }],
        templateFilePaths: [],
    };

    const gitTopLevelDirectoryPath = await resolveGitTopLevelDirectory(rootDirectoryPath);
    if (!gitTopLevelDirectoryPath) {
        return fallbackContext;
    }

    const worktrees = await listExistingGitWorktrees(gitTopLevelDirectoryPath);
    if (worktrees.length === 0) {
        return fallbackContext;
    }

    const mainWorktree = worktrees[0];
    return {
        targets: worktrees.map(worktree => ({
            directoryPath: worktree.path,
            worktree,
        })),
        templateFilePaths: await listWorkspaceFilePathsInDirectory(mainWorktree.path),
    };
}

/**
 * 1つの検索対象について、既存workspaceまたはテンプレート由来のファイル情報を返す。
 */
async function listWorkspaceFileSourcesForSearchTarget(
    target: WorkspaceSearchTarget,
    templateFilePaths: string[]
): Promise<WorkspaceFileSource[]> {
    const existingWorkspaceFilePaths = await listWorkspaceFilePathsInDirectory(
        target.directoryPath
    );
    return existingWorkspaceFilePaths.length > 0
        ? existingWorkspaceFilePaths.map(workspaceFilePath => ({ workspaceFilePath }))
        : templateFilePaths.map(templateFilePath => ({
            workspaceFilePath: path.join(
                target.directoryPath,
                path.basename(templateFilePath)
            ),
            templateFilePath,
        }));
}

/**
 * workspaceファイル情報をQuickPick表示用の候補へ変換する。
 */
function createWorkspaceCandidateForFileSource(
    target: WorkspaceSearchTarget,
    source: WorkspaceFileSource
): WorkspaceCandidate {
    const worktreeDescription = target.worktree?.branch
        ?? (target.worktree?.head ? `detached@${target.worktree.head.slice(0, 7)}` : undefined);

    return {
        label: target.worktree
            ? path.basename(target.directoryPath)
            : path.basename(source.workspaceFilePath),
        description: worktreeDescription ?? source.workspaceFilePath,
        detail: target.worktree ? source.workspaceFilePath : undefined,
        workspaceFilePath: source.workspaceFilePath,
        templateFilePath: source.templateFilePath,
    };
}

/**
 * 1つの検索対象について、QuickPick表示用のworkspace候補を返す。
 */
async function listWorkspaceCandidatesForSearchTarget(
    target: WorkspaceSearchTarget,
    templateFilePaths: string[]
): Promise<WorkspaceCandidate[]> {
    const sources = await listWorkspaceFileSourcesForSearchTarget(
        target,
        templateFilePaths
    );
    return sources.map(source =>
        createWorkspaceCandidateForFileSource(target, source)
    );
}

/**
 * 検索対象ごとのworkspace候補を列挙順を保ったまま返す。
 */
async function listWorkspaceCandidatesForSearchContext(
    context: WorkspaceSearchContext
): Promise<WorkspaceCandidate[]> {
    const candidatesByTarget = await Promise.all(
        context.targets.map(target =>
            listWorkspaceCandidatesForSearchTarget(target, context.templateFilePaths)
        )
    );

    return candidatesByTarget.flat();
}

// #endregion

// #region workspace切り替えコマンドを実行する

/**
 * workspaceファイルを新しいVS Codeウィンドウで開く。
 */
async function openWorkspaceFileInNewWindow(workspaceFilePath: string): Promise<void> {
    const uri = vscode.Uri.file(workspaceFilePath);
    await vscode.commands.executeCommand('vscode.openFolder', uri, false);
}

/**
 * workspaceの探索起点を解決できない理由をVS Code上へ表示する。
 */
function showWorkspaceRootResolutionError(): void {
    const hasWorkspaceLocation = Boolean(
        vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
    );
    const message = hasWorkspaceLocation
        ? 'The current workspace location no longer exists. Open an existing folder or workspace and try again.'
        : 'No folder or workspace is currently open.';
    vscode.window.showErrorMessage(message);
}

/**
 * 現在のGitリポジトリに属するworktreeからworkspaceを選択して開く。
 */
async function selectAndOpenGitWorktreeWorkspace(): Promise<void> {
    // 処理順:
    // 1. 現在のworkspaceから探索起点を決定し、利用可能か検証する。
    // 2. 探索対象のworktreeとmain worktreeのworkspaceテンプレートを取得する。
    // 3. 各worktreeから選択可能なworkspace候補を生成する。
    // 4. 選択されたworktreeに必要ならworkspaceファイルをコピーする。
    // 5. 選択先のworkspaceを新しいVS Codeウィンドウで開く。

    // 1. 現在のworkspaceから探索起点を決定し、利用可能か検証する。
    const rootDirectoryPath = await resolveExistingWorkspaceRootDirectory();
    if (!rootDirectoryPath) {
        showWorkspaceRootResolutionError();
        return;
    }

    // 2. 探索対象のworktreeとmain worktreeのworkspaceテンプレートを取得する。
    const searchContext = await resolveWorkspaceSearchContext(rootDirectoryPath);

    // 3. 各worktreeから選択可能なworkspace候補を生成する。
    const candidates = await listWorkspaceCandidatesForSearchContext(searchContext);

    // 4. 選択されたworktreeに必要ならworkspaceファイルをコピーする。
    const selectedCandidate = await selectWorkspaceCandidateWithQuickPick(candidates);
    if (!selectedCandidate) {
        return;
    }

    const workspaceFilePath = await getOrCreateWorkspaceFilePathForCandidate(
        selectedCandidate
    );

    // 5. 選択先のworkspaceを新しいVS Codeウィンドウで開く。
    await openWorkspaceFileInNewWindow(workspaceFilePath);
}

// #endregion

// #region VS Code拡張のライフサイクルを管理する

/**
 * workspace切り替えコマンドをVS Codeへ登録する。
 */
export function activate(context: vscode.ExtensionContext): void {
    const workspaceSwitchCommandRegistration = vscode.commands.registerCommand(
        'workspaceSwitcher.switchInRoot',
        selectAndOpenGitWorktreeWorkspace
    );
    context.subscriptions.push(workspaceSwitchCommandRegistration);
}

/**
 * 拡張停止時の後処理は不要なため何もしない。
 */
export function deactivate(): void {
    // nothing to clean up
}

// #endregion
