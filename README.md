# Workspace Switcher

現在開いているフォルダ（または `.code-workspace` のあるディレクトリ）直下の `.code-workspace` を列挙し、QuickPick から選んで別ウィンドウで開きます。

## 使い方

1. フォルダまたは `.code-workspace` を VS Code で開く。
2. コマンドパレットで `Workspace Switcher: Switch in current root` を実行（または `Ctrl+Alt+W`）。
3. 一覧から開きたい `.code-workspace` を選択。

## 動作
- ルート判定:
  - `.code-workspace` を開いている場合はそのファイルの親ディレクトリ。
  - フォルダを開いている場合はそのフォルダ。
- ルート直下の `.code-workspace` を `fs.promises.readdir` + `Dirent` で検索。
- 選択したファイルを `vscode.openFolder` で新規ウィンドウとして開く。

## 開発
```bash
npm install
npm run watch
# F5 で拡張ホストを起動
```
