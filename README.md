# 動画字幕要約アプリ

動画のURL（YouTube / TikTok / Instagram / X（Twitter）/ Facebook）を入力すると、字幕を取得してClaude APIで日本語要約するシングルページアプリです。

- フロントエンド: `index.html`（GitHub Pagesでホスティング）
- バックエンド: `worker.js`（Cloudflare Worker）
- 字幕取得: [Supadata API](https://supadata.ai/)
- 要約: [Anthropic Claude API](https://www.anthropic.com/api)

APIキーはCloudflare Workerのsecretとしてのみ保持され、フロントエンドには一切露出しません。

## 構成

```
.
├── index.html          # フロントエンド（GitHub Pagesに配置）
├── worker.js            # Cloudflare Worker本体
├── wrangler.toml         # Worker設定（デプロイ先・ALLOWED_ORIGINなど）
├── .dev.vars.example     # ローカル開発用envのサンプル
└── .gitignore
```

## 1. Supadata APIキーの取得手順

1. https://supadata.ai/ にアクセスしてアカウントを作成する。
2. ダッシュボードにログインし、APIキー（`SUPADATA_API_KEY`）を発行する。
3. 無料枠のリクエスト上限や料金プランを確認しておく（動画の長さ・件数によって消費量が変わります）。

## 2. Anthropic APIキーの取得手順

1. https://console.anthropic.com/ にアクセスしてアカウントを作成する。
2. 「API Keys」画面で新しいキー（`ANTHROPIC_API_KEY`）を発行する。
3. 利用するモデル（`claude-sonnet-4-6`）が組織で利用可能か確認し、必要に応じて請求情報を設定する。

## 3. Cloudflare Workerのセットアップとデプロイ

### 事前準備

```bash
npm install -g wrangler
wrangler login
```

### `wrangler.toml` の確認

`wrangler.toml` の `ALLOWED_ORIGIN` を、実際にGitHub Pagesを公開するoriginに変更してください。

```toml
[vars]
ALLOWED_ORIGIN = "https://hipchin.github.io"
```

### secretの設定手順（本番）

APIキーは `wrangler.toml` には書かず、必ずWorkerのsecretとして設定します。

```bash
wrangler secret put SUPADATA_API_KEY
# プロンプトが表示されたらSupadataのAPIキーを貼り付けてEnter

wrangler secret put ANTHROPIC_API_KEY
# プロンプトが表示されたらAnthropicのAPIキーを貼り付けてEnter
```

設定済みのsecret一覧を確認する場合:

```bash
wrangler secret list
```

### デプロイ

```bash
wrangler deploy
```

デプロイが完了すると `https://<worker名>.<サブドメイン>.workers.dev` のようなURLが発行されます。このURLをフロントエンドの `WORKER_URL` に設定します。

## 4. ローカル開発設定（`.dev.vars`）

`wrangler dev` でローカル実行する場合、`.dev.vars.example` をコピーして `.dev.vars` を作成し、実際のAPIキーを入れてください。

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars` の内容例:

```
SUPADATA_API_KEY=your_supadata_api_key_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here
ALLOWED_ORIGIN=http://localhost:8788
```

起動:

```bash
wrangler dev
```

> **重要:** `.dev.vars` と `.env` はAPIキーなどの機密情報を含むため、**絶対にGitにコミットしないでください**。このリポジトリの `.gitignore` で既に除外されていますが、`git status` で誤ってステージされていないか必ず確認してください。

## 5. GitHub Pagesへの配置手順

1. `index.html` をリポジトリのルート（または `docs/` フォルダ）に配置する。
2. GitHubリポジトリの `Settings` → `Pages` を開く。
3. `Source` を `Deploy from a branch` にし、対象ブランチとフォルダ（`/ (root)` または `/docs`）を選択して保存する。
4. 数分待つと `https://<GitHubユーザー名>.github.io/<リポジトリ名>/` でアプリが公開される。
5. 公開されたoriginを、Worker側の `ALLOWED_ORIGIN`（`wrangler.toml`）に設定し、再デプロイする。

## 6. フロントエンド内のWorker URLの変更方法

`index.html` 内の以下の定数を、デプロイしたWorkerのURLに書き換えてください。

```js
// index.html 内
const WORKER_URL = "https://your-worker-subdomain.workers.dev";
```

Worker URLを変更したら、変更後の `index.html` を再度GitHub Pagesへpushしてください。

## API仕様（概要）

### リクエスト（フロントエンド → Worker）

```
POST /
Content-Type: application/json

{ "url": "https://www.youtube.com/watch?v=..." }
```

### レスポンス（成功時）

```json
{
  "ok": true,
  "summary": "Claudeが生成した要約テキスト",
  "transcriptLang": "ja",
  "availableLangs": ["ja", "en"]
}
```

### レスポンス（エラー時）

```json
{ "ok": false, "error": "日本語の分かりやすいエラーメッセージ" }
```

## 制限事項 / TODO

- 字幕テキストが80,000文字を超える場合、先頭80,000文字のみを要約対象とし、結果末尾に「注：動画が長いため、冒頭部分を中心に要約しています」と付記します。
- TODO: 将来的には長い動画向けに分割要約に対応する。
- MVPでは保存機能・ログイン機能・履歴機能は実装していません。
