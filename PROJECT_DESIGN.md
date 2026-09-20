# PROJECT_DESIGN

共通ルール（`Personal-UI/DESIGN.md`, `TOKENS.md`）を前提とする。ここにはこのプロジェクト固有の内容だけを書く。

## 1. Product type

**種類:** 個人用の一般公開Webツール（GitHub Pages + Cloudflare Worker）

**一文で表す目的:**
動画（YouTube / TikTok / Instagram / X / Facebook）のURLを渡すだけで、字幕を取得しClaudeが日本語要約または全文文字起こしを返す。

**主要ユーザー:**

- 開発者本人。長い動画を見る時間がないときに内容を素早く把握したい。

**主要タスク（最大3つ）:**

1. URLを貼って要約を取得する
2. 必要なら全文文字起こしを取得する
3. 結果をコピーして別の場所へ貼り付ける

**利用環境:**

- 主な端末: iPhone / laptop
- 主な入力: touch / keyboard
- 対応テーマ: Light / Dark（System追従）
- 対応言語: 日本語

## 2. Project Requirements

- バックエンドはCloudflare Worker（`worker.js`）、フロントは単一の`index.html`（ビルドステップなし）。
- 要約モードの出力は、ObsidianのSource Note形式（YAML Frontmatter + Markdown本文）で固定フォーマット。Frontmatterには`title` / `topics` / `source_url`などが入る。フロントは表示用にFrontmatterを解釈・除去しつつ、コピーや保存では元のMarkdown（Frontmatter込み）をそのまま扱う。
- 全文文字起こしモードはFrontmatterを持たないプレーンテキスト。
- 字幕は外部動画由来の非信頼テキスト。結果表示（HTML化）は必ずエスケープを経由し、任意のHTMLタグを素通りさせない。

## 3. Signature — 1つだけ

**名前:** 読了目安バッジ

**一文での定義:**
要約結果の見出し横に「読了目安: 約◯分」を示し、長い動画を短時間で読める価値を毎回可視化する。

**製品の目的とのつながり:**
このツールの価値は「動画を見る時間を読む時間に変える」こと。結果を見るたびにその価値が一言で伝わるようにする。

**適用場所・状態:**

- 要約結果／文字起こし結果カードの見出し直下のみ

**反復ルール:**
文字数（記号を除く）÷ 500字/分の概算。1分未満は「1分未満」と表示し、他の場所では時間表示を使わない。

**使わない場所:**
入力フォーム、エラー表示、読み込み中状態。

## 4. Preference overrides

| 共通Preference | このプロジェクトでの上書き | 理由 | 適用範囲 |
|---|---|---|---|
| （なし） | | | |

## 5. Project-specific tokens

（なし。共通 `TOKENS.md` をそのまま使用）

## 6. Content and data conventions

- 結果本文: Claudeが返すMarkdown軽量構文（見出し2種・箇条書き・番号リスト・`**強調**`）のみをレンダリングする。それ以外の記法が来ても崩れないよう、未知の行はプレーン段落として扱う。
- 要約モードのYAML Frontmatterは本文として表示せず、`title`を結果見出しに、`topics`を見出し直下のタグに変換する。コピー・Markdown保存では常に元のFrontmatter付きテキストを使う（Obsidianへそのまま取り込めるようにするため）。
- エラー文: 原因と次に取るべき行動が分かる日本語文。

## 7. Responsive behavior

| 領域 | Compact | Medium / Wide |
|---|---|---|
| 入力行 | 縦積み・フル幅 | 横並び |
| 結果本文 | 通常表示（`resize: vertical`で手動拡大可） | 同左＋「大きく表示」で最大75vh |

## 8. Acceptance notes

- 要約結果のMarkdown見出し・箇条書きが実際に構造化されて表示される（生の`##`や`-`、Frontmatterの`---`が見えない）
- 悪意あるタグを含む字幕を要約・文字起こしした場合でもスクリプトが実行されない
- コピーボタン・Markdown保存ボタンの両方で、Frontmatterを含む元のMarkdownテキストが得られる
- topicsが空配列の場合、タグ行が表示されない（余白だけ残らない）

## 9. Decisions

| 日付 | 判断 | 理由 |
|---|---|---|
| 2026-09-20 | 結果表示を`<textarea>`から構造化レンダリングに変更 | Claudeの出力が最初からMarkdown構造を持っており、生記号のまま表示するのは情報構造を伝えるというHard Ruleに反していたため |
| 2026-09-20 | Signatureを「読了目安バッジ」に決定 | 動画時間の代わりに文字数から概算できるため、バックエンド変更なしで導入できる |
| 2026-09-20 | YAML Frontmatterを本文表示から除去し、title/topicsを見出しとタグに昇格 | Obsidian向けのメタデータが生テキストとして読者に見えてしまい、要約結果を数秒で理解できるというHard Rule 2.4に反していたため |
