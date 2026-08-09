# Workspace Switcher

現在開いているフォルダ（または `.code-workspace` のあるディレクトリ）を起点に workspace 候補を列挙し、QuickPick から選んで別ウィンドウで開きます。

## 使い方

1. フォルダまたは `.code-workspace` を VS Code で開く。
2. コマンドパレットで `Workspace Switcher: Switch in current root` を実行（または `Ctrl+Alt+W`）。
3. 一覧から開きたい `.code-workspace` を選択。

## 動作
- ルート判定:
  - `.code-workspace` を開いている場合はそのファイルの親ディレクトリ。
  - フォルダを開いている場合はそのフォルダ。
- Git worktree がある場合は、main worktree 直下の `.code-workspace` をテンプレートとして扱う。
- 候補には worktree のディレクトリ名とブランチ名を表示する。detached HEAD は短縮コミットIDを表示する。
- `.code-workspace` がない worktree を選んだ場合は、テンプレートをその worktree のルート直下へコピーする。
- リポジトリ内にテンプレートが1つもない場合は、選択したルートを対象とする `<ルート名>.code-workspace` をそのルート直下へ作成する。
- workspace 内の相対パスは、コピー先の worktree を基準に解決される。
- 選択したファイルを `vscode.openFolder` で新規ウィンドウとして開く。

## 開発
```bash
npm install
npm run watch
# F5 で拡張ホストを起動
```
