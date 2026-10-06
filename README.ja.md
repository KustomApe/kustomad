# agents-dailies

**コーディングエージェントが作ったものを見るための、ライブのレビューページ。** [English](README.md)

エージェントが画像をレンダリングしたり、動画を撮ったり、音や 3D モデルを書き出したりすると、
新しいウィンドウが開いたり、worktree の奥のパスだけが残されたりしがちです。agents-dailies は
その置き場所をひとつにします。開きっぱなしのブラウザタブに、作られたものが上から順に、
候補と横並びで、その場で現れて残ります。

返事はそのページで —— **OK**、または投稿全体やファイル単位のメモ。エージェントからの質問
（「この 3 つのどれ？」「このカットで出していい？」、まとめてのレビューシート）にも、選んで
**送信** するだけで答えられます。返事と回答は、エージェントが待機中でも届きます。

名前は映画やゲーム制作の *デイリーズ*（前日のレンダーを皆で見て、残すものを決める毎日のレビュー）から。

## 主な機能

- **ライブなタブひとつ** — Server-Sent Events で即時反映。フォーカスを奪わず、ビューアのタブが無い時だけブラウザを開きます。
- **あらゆる媒体** — 画像/GIF、動画（ループ・ミュート・表示中のみ再生。Ogg Theora などは ffmpeg があれば一度だけ WebM 化）、音声、GLB/glTF（model-viewer で回転）、PDF、HTML（サンドボックス）、Markdown、テキスト。
- **リポジトリ → Issue → セッションの履歴** — サイドバーで新しい順にグループ化。未読ドット、件数、回答待ちの数、検索。ブランチ名から Issue キーを推定（`me/summ-239-x` → `SUMM-239`）。
- **見て答える質問** — ファイル、複数ファイルのパターン、文が A, B, C… の選択肢に。`--about` で「承認する対象」を選択肢の上に表示。回答がエージェントを起こします。
- **ファイルごとのメモ**、**ダウンロード／パスのコピー／画像のクリップボードコピー／ドラッグ**。
- **Devlog（制作記録）** — 別タブ。main にマージされた作業だけを、変更点・工夫・苦労・決めたこと・before/after つきで記録。`devlog summary` で期間の材料（記録・決定・コミット・保存済みトランスクリプト）をまとめて出力。
- **Issue カード** — 設定したコマンド（Linear / GitHub / Jira など）で取得した Issue のタイトル・状態・説明を表示。
- **保存** — ファイルは内容ハッシュでリポジトリ外に一度だけ保存。イベントログは追記のみ、マシンごとに 1 ファイル。
- **キーボード操作** — `j`/`k` 投稿, `h`/`l` ファイル, `o` OK, `c` ファイルにメモ（`C` 投稿に）, `f` 全画面, `1`–`9` 選択, `Enter` 送信, `y` コピー（`Y` パス）, `d` ダウンロード, `[`/`]` サイドバー, `/` 検索。

## インストール

Node.js 22.6 以上が `PATH` にあれば OK。npm install もビルドも不要です。

```sh
git clone https://github.com/KustomApe/agents-dailies.git ~/.local/share/agents-dailies-src
mkdir -p ~/.local/bin
ln -s ~/.local/share/agents-dailies-src/bin/agents-dailies ~/.local/bin/   # ~/.local/bin を PATH に
agents-dailies guide >> CLAUDE.md   # エージェントへの説明（AGENTS.md などでも可）
```

### Claude Code プラグインとして（任意）

```text
/plugin marketplace add KustomApe/agents-dailies
/plugin install agents-dailies@agents-dailies
```

新しいセッションから、`bin/` の PATH 追加・スキル・フック（メディアをウィンドウで開くのを止める、返事をエージェントに渡す、マージ後の devlog 記録を促す等）が有効になります。インストールしなくても CLI とビューアはそのまま使えます。

## 起動

最初の `show` / `ask` でビューアがバックグラウンドで起動し、タブが無ければブラウザが開きます（http://127.0.0.1:4778/）。

| コマンド | 内容 |
| --- | --- |
| `agents-dailies open` | 必要なら起動して、ブラウザで開く |
| `agents-dailies status` | 動作状況・アドレス・開いているタブ数・保存場所 |
| `agents-dailies serve` | フォアグラウンドで起動（Ctrl-C で停止） |
| `agents-dailies stop` | バックグラウンドのビューアを停止 |

ログは `~/.local/share/agents-dailies/server.log`。ポート変更は `AGENTS_DAILIES_PORT=4800`。

## 使い方

```sh
agents-dailies show a.png b.png --title "ライティング A / B" --note "B はフィルライトを下げた"
agents-dailies ask "正面図はどれを残す？" a.png b.png --option "どれも違う — 描き直し"
agents-dailies ask "このカットで出す？" --about cut.mp4 --option "OK" --option "直したい所がある"
agents-dailies wait <post-id>     # バックグラウンドで。回答が来たら終了
agents-dailies context            # 「これ」— ビューアで選択中のもの
agents-dailies devlog add --title "マントが厚くなった" --before old.png --after new.png --summary - <<'EOF'
変更点と理由。
## 工夫
## 苦労
## 決めたこと
EOF
agents-dailies devlog summary --since "2026-10-01 18:00"
```

詳しいコマンド・保存場所・環境変数（`AGENTS_DAILIES_*`）・セキュリティは [README.md](README.md) を参照してください。

## ライセンス

MIT
