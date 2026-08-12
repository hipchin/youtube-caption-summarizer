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
├── index.html           # フロントエンド（GitHub Pagesに配置）
├── worker.js            # Cloudflare Worker本体
├── wrangler.toml        # Worker設定（CORS / Rate Limiting）
├── .dev.vars.example    # ローカル開発用envのサンプル
└── .gitignore
```

## セキュリティと利用制限

Workerは次の防御を行います。

1. `Origin` ヘッダーを検査し、`ALLOWED_ORIGIN` と一致しないアクセスを403で拒否する。
2. Cloudflare WorkersのRate Limiting bindingを利用し、短時間の大量リクエストを429で拒否する。
3. Supadata / AnthropicのAPIキーはCloudflare Secretにのみ保存する。
4. 想定外の内部エラー詳細をクライアントへ返さない。

> `Origin` 検査は完全なユーザー認証ではありません。公開範囲をさらに厳密に限定する場合はCloudflare Accessなどの認証機構を追加してください。

## 長い動画の要約

字幕が約28,000文字を超える場合は、字幕を複数パートに分割して中間要約を作成し、それらをClaudeでもう一度統合して全体要約を生成します。

- 分割サイズ: 約28,000文字
- 要約対象の上限: 160,000文字
- 160,000文字を超えた場合: 先頭160,000文字を対象にし、その旨を結果末尾に表示
- 「動画内の内容」と「AIによる補足・応用」を区別して出力

## 1. Supadata APIキーの取得手順

1. https://supadata.ai/ にアクセスしてアカウントを作成する。
2. ダッシュボードにログインし、APIキー（`SUPADATA_API_KEY`）を発行する。
3. 無料枠のリクエスト上限や料金プランを確認する。

## 2. Anthropic APIキーの取得手順

1. https://console.anthropic.com/ にアクセスしてアカウントを作成する。
2. 「API Keys」画面で新しいキー（`ANTHROPIC_API_KEY`）を発行する。
3. 利用するモデル（`claude-sonnet-4-6`）が組織で利用可能か確認し、必要に応じて請求情報を設定する。

## 3. Cloudflare Workerのセットアップとデプロイ

### 事前準備

Rate Limiting bindingを利用するため、Wrangler 4.36.0以降を使用してください。

```bash
npm install -g wrangler@latest
wrangler --version
wrangler login
```

### `wrangler.toml` の確認

`ALLOWED_ORIGIN` を実際にGitHub Pagesを公開するoriginに設定します。

```toml
[vars]
ALLOWED_ORIGIN = "https://hipchin.github.io"
```

Rate Limiting bindingは次の設定です。

```toml
[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "1001"

  [ratelimits.simple]
  limit = 10
  period = 60
```

現在は `summary` と `transcript` を別キーとして扱い、それぞれ10リクエスト/分を目安に制限します。CloudflareのRate Limiting bindingは拠点単位で動作するため、厳密な課金上限としてではなく濫用抑止として使用します。

### secretの設定手順（本番）

APIキーは `wrangler.toml` には書かず、Workerのsecretとして設定します。

```bash
wrangler secret put SUPADATA_API_KEY
wrangler secret put ANTHROPIC_API_KEY
```

設定済みsecret一覧:

```bash
wrangler secret list
```

### デプロイ

```bash
wrangler deploy
```

## 4. ローカル開発設定（`.dev.vars`）

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

> `.dev.vars` と `.env` はAPIキーなどの機密情報を含むため、Gitにコミットしないでください。このリポジトリの `.gitignore` で除外されています。

## 5. GitHub Pagesへの配置手順

1. `index.html` をリポジトリのルートに配置する。
2. GitHubリポジトリの `Settings` → `Pages` を開く。
3. `Source` を `Deploy from a branch` にし、対象ブランチと `/ (root)` を選択して保存する。
4. 公開されたoriginをWorker側の `ALLOWED_ORIGIN` に設定する。
5. Workerを再デプロイする。

## 6. フロントエンド内のWorker URL

`index.html` 内の `WORKER_URL` にデプロイ済みWorker URLを設定します。

```js
const WORKER_URL = "https://youtube-caption-summarizer.tackro-i.workers.dev";
```

## API仕様（概要）

### リクエスト

```http
POST /
Content-Type: application/json
Origin: https://hipchin.github.io

{ "url": "https://www.youtube.com/watch?v=...", "mode": "summary" }
```

`mode` は `summary` または `transcript` です。

### 成功時

```json
{
  "ok": true,
  "mode": "summary",
  "summary": "Claudeが生成した要約テキスト",
  "transcriptLang": "ja",
  "availableLangs": ["ja", "en"]
}
```

### エラー時

```json
{ "ok": false, "error": "日本語の分かりやすいエラーメッセージ" }
```

主なHTTPステータス:

- `400`: URLやリクエスト形式の不備
- `403`: 許可されていないOrigin
- `404`: 字幕なし
- `429`: Rate Limit超過
- `502`: 外部API障害
- `504`: 字幕取得タイムアウト

## 今後の候補

- Cloudflare Accessによる本人認証
- 要約形式の選択
- 履歴保存
- 動画タイトルやサムネイル表示
- 長尺動画の上限160,000文字を超える場合の完全分割処理
