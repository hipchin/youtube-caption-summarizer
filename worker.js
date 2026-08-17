/**
 * Cloudflare Worker: video caption summarizer backend.
 *
 * Flow: validate origin + rate limit -> validate video URL ->
 * fetch transcript from Supadata -> summarize with Claude -> return JSON.
 */

const SUPADATA_TRANSCRIPT_URL = "https://api.supadata.ai/v1/transcript";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TRANSCRIPT_CHARS = 160000;
const CHUNK_SIZE_CHARS = 28000;
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_MS = 60000;

const USER_CONTEXT = `情報を単に収集するのではなく、生活・仕事・学習・意思決定に再利用できる知識として蓄積する。
特定ジャンルに限定せず、新しい視点、根拠、具体例、実践可能性、制約・リスク、既存知識を更新する点を重視する。
自分との関連性を無理に作らず、事実・話者の意見・AIの考察を区別し、不明な内容は不明のまま扱う。`;

const TOPICS = [
  "AI", "AIエージェント", "AIモデル", "ChatGPT", "Claude", "Claude Code", "Codex",
  "ローカルLLM", "AIコーディング", "プロンプト", "API", "個人開発", "Webアプリ",
  "ローカルアプリ", "GitHub", "n8n", "Google Apps Script", "業務自動化", "仕事術",
  "生産性", "働き方", "個人ビジネス", "収益化", "ソロプレナー", "家計", "税金",
  "投資", "経済", "資産形成", "健康", "運動", "筋力トレーニング", "栄養", "睡眠",
  "食事", "学習", "読書", "心理", "マインドセット", "意思決定", "問題解決",
  "人間関係", "コミュニケーション",
];

class UserFacingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(env),
    },
  });
}

function assertAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!env.ALLOWED_ORIGIN) {
    throw new UserFacingError("サーバー設定に問題があります。", 500);
  }
  if (origin !== env.ALLOWED_ORIGIN) {
    throw new UserFacingError("このアクセス元からの利用は許可されていません。", 403);
  }
}

async function enforceRateLimit(request, env, mode) {
  if (!env.RATE_LIMITER) return;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `${mode === "transcript" ? "transcript" : "summary"}:${ip}`;
  const { success } = await env.RATE_LIMITER.limit({ key });
  if (!success) {
    throw new UserFacingError(
      "短時間にリクエストが集中しています。1分ほど待ってから再試行してください。",
      429
    );
  }
}

const ALLOWED_VIDEO_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "fb.watch",
];

function isAllowedVideoHost(hostname) {
  const h = hostname.toLowerCase();
  return ALLOWED_VIDEO_DOMAINS.some((domain) => h === domain || h.endsWith(`.${domain}`));
}

function validateVideoUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new UserFacingError("動画のURLを入力してください。", 400);
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UserFacingError("URLの形式が正しくありません。", 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UserFacingError("URLの形式が正しくありません。", 400);
  }
  if (!isAllowedVideoHost(parsed.hostname)) {
    throw new UserFacingError(
      "対応していないサイトのURLです（YouTube / TikTok / Instagram / X（Twitter）/ Facebookに対応）。",
      400
    );
  }
  return parsed.toString();
}

function extractSupadataContent(data) {
  const content = data && data.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => (item && item.text) || "").join("\n");
  }
  return "";
}

function supadataHttpErrorMessage(status) {
  switch (status) {
    case 400:
      return "字幕取得サービスがこのURLを処理できませんでした。URLを確認してください。";
    case 401:
    case 403:
      return "字幕取得サービスの認証に失敗しました。しばらくしてから再試行してください。";
    case 404:
      return "この動画の字幕が見つかりませんでした。字幕が存在しない動画の可能性があります。";
    case 429:
      return "字幕取得サービスへのリクエストが混み合っています。しばらくしてから再試行してください。";
    default:
      if (status >= 500) {
        return "字幕取得サービスが一時的に利用できません。しばらくしてから再試行してください。";
      }
      return "字幕の取得に失敗しました。";
  }
}

async function pollSupadataJob(jobId, apiKey) {
  const start = Date.now();
  while (Date.now() - start < MAX_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const res = await fetch(`${SUPADATA_TRANSCRIPT_URL}/${encodeURIComponent(jobId)}`, {
      method: "GET",
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) {
      throw new UserFacingError(supadataHttpErrorMessage(res.status), 502);
    }
    const data = await res.json();
    if (data.status === "completed") {
      return {
        content: extractSupadataContent(data),
        lang: data.lang || null,
        availableLangs: Array.isArray(data.availableLangs) ? data.availableLangs : [],
      };
    }
    if (data.status === "failed") {
      throw new UserFacingError("字幕の取得に失敗しました。", 502);
    }
  }
  throw new UserFacingError(
    "処理に時間がかかっています。短い動画で試すか、しばらくしてから再試行してください。",
    504
  );
}

async function fetchTranscript(videoUrl, env) {
  const params = new URLSearchParams();
  params.set("url", videoUrl);
  params.set("text", "true");
  params.set("mode", "native");

  let res;
  try {
    res = await fetch(`${SUPADATA_TRANSCRIPT_URL}?${params.toString()}`, {
      method: "GET",
      headers: { "x-api-key": env.SUPADATA_API_KEY },
    });
  } catch {
    throw new UserFacingError(
      "字幕取得サービスに接続できませんでした。しばらくしてから再試行してください。",
      502
    );
  }

  if (res.status === 202) {
    let data;
    try {
      data = await res.json();
    } catch {
      throw new UserFacingError("字幕の取得に失敗しました。", 502);
    }
    if (!data.jobId) throw new UserFacingError("字幕の取得に失敗しました。", 502);
    return pollSupadataJob(data.jobId, env.SUPADATA_API_KEY);
  }

  if (!res.ok) {
    throw new UserFacingError(supadataHttpErrorMessage(res.status), 502);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new UserFacingError("字幕の取得に失敗しました。", 502);
  }

  const content = extractSupadataContent(data);
  if (!content) {
    throw new UserFacingError(
      "この動画の字幕が見つかりませんでした。字幕が存在しない動画の可能性があります。",
      404
    );
  }

  return {
    content,
    lang: data.lang || null,
    availableLangs: Array.isArray(data.availableLangs) ? data.availableLangs : [],
  };
}

function claudeHttpErrorMessage(status) {
  switch (status) {
    case 400:
      return "要約リクエストの内容に問題がありました。";
    case 401:
    case 403:
      return "要約サービスの認証に失敗しました。しばらくしてから再試行してください。";
    case 404:
      return "要約サービスに接続できませんでした。";
    case 429:
      return "要約サービスへのリクエストが混み合っています。しばらくしてから再試行してください。";
    default:
      if (status >= 500) {
        return "要約サービスが一時的に利用できません。しばらくしてから再試行してください。";
      }
      return "要約の生成に失敗しました。";
  }
}

async function callClaude(messages, env, maxTokens) {
  let res;
  try {
    res = await fetch(CLAUDE_URL, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens,
        system:
          "あなたは動画内容を正確に整理する学習アシスタントです。字幕にない事実を動画内の発言として補わず、事実とAIによる補足を明確に分けてください。",
        messages,
      }),
    });
  } catch {
    throw new UserFacingError(
      "要約サービスに接続できませんでした。しばらくしてから再試行してください。",
      502
    );
  }

  if (!res.ok) {
    throw new UserFacingError(claudeHttpErrorMessage(res.status), 502);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new UserFacingError("要約の生成に失敗しました。", 502);
  }

  const text = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  if (!text) throw new UserFacingError("要約の生成に失敗しました。", 502);
  return text;
}

function splitTranscript(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE_CHARS) {
    chunks.push(text.slice(i, i + CHUNK_SIZE_CHARS));
  }
  return chunks;
}

function sourceTypeForUrl(videoUrl) {
  const hostname = new URL(videoUrl).hostname.toLowerCase();
  if (hostname.includes("youtube") || hostname === "youtu.be") return "YouTube";
  if (hostname.includes("tiktok")) return "TikTok";
  if (hostname.includes("instagram")) return "Instagram";
  if (hostname === "x.com" || hostname.endsWith(".x.com") || hostname.includes("twitter")) return "X";
  if (hostname.includes("facebook") || hostname === "fb.watch") return "Facebook";
  return "Video";
}

function finalSummaryPrompt(sourceText, videoUrl) {
  const dateAdded = new Date().toISOString().slice(0, 10);
  return `以下の動画内容から、Obsidianの20_Sourcesに保存する日本語のSource Noteを作成してください。

ユーザーの情報整理方針:
${USER_CONTEXT}

要約ルール:
- 元情報にない事実を追加せず、不明な内容を推測で補完しない
- 主要な結論と、その理解に必要な根拠を対応させる
- 数値、研究結果、固有名詞、サービス名、事例、手順、条件、例外は重要なら残す
- 事実と、話者の意見・経験・予測を区別する
- メリットだけでなく、制約、欠点、リスク、反対材料も残す
- 情報量を減らすこと自体を目的にせず、重要ポイントの項目数を固定しない
- 挨拶、宣伝、スポンサー紹介、内容に影響しない雑談、重複は省く
- 自分との関連性や実践項目は、元情報から自然に導ける場合だけ記載する
- AI独自の考察を加える場合は「AIによる考察」と明記し、動画由来の内容と混同しない
- 根拠が弱い主張、情報源不明、古い可能性、検証が必要な内容は「疑問・未確認事項」に分離する

出力要件:
- Markdownだけを出力し、コードフェンスや前置きは付けない
- 先頭に次の形式のYAML Frontmatterを置く
- titleは内容を端的に表す自然な日本語にする。YAML文字列として必ずダブルクォートで囲む
- topicsは下記の許可語彙から1〜5個だけ選ぶ。適切な語がない場合は空配列 [] にする
- Frontmatterの後に同じtitleのH1見出しを置く
- 「概要」「重要ポイント」「根拠・具体例」は必須とする
- 「話者の主張・予測」「自分に関係するポイント」「実践・試したいこと」「疑問・未確認事項」は該当内容がある場合だけ追加する

---
type: source
title: "内容から生成したタイトル"
topics:
  - 許可語彙から選んだトピック
source_type: ${sourceTypeForUrl(videoUrl)}
source_url: "${videoUrl.replaceAll('"', "%22")}"
date_added: ${dateAdded}
status: archived
---

topicsの許可語彙:
${TOPICS.join("、")}

動画内容:
${sourceText}`;
}

function normalizeSourceNote(markdown) {
  const trimmed = markdown.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

async function summarizeWithClaude(transcript, videoUrl, env) {
  const clipped = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  const wasClipped = transcript.length > MAX_TRANSCRIPT_CHARS;
  const chunks = splitTranscript(clipped);

  if (chunks.length === 1) {
    const summary = normalizeSourceNote(await callClaude(
      [{ role: "user", content: finalSummaryPrompt(chunks[0], videoUrl) }],
      env,
      4096
    ));
    return wasClipped
      ? `${summary}\n\n注：字幕が非常に長いため、先頭${MAX_TRANSCRIPT_CHARS.toLocaleString()}文字を対象に要約しています。`
      : summary;
  }

  const partialSummaries = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const partial = await callClaude(
      [
        {
          role: "user",
          content: `以下は1本の動画字幕を${chunks.length}分割したうちの${i + 1}番目です。後で全体要約を作るため、情報を落としすぎずに整理してください。\n\n- 主要な主張\n- 重要な事実・数値・具体例\n- 話の流れ\n- 後続部分との関係がありそうな論点\n\n字幕：\n${chunks[i]}`,
        },
      ],
      env,
      1500
    );
    partialSummaries.push(`### パート ${i + 1}\n${partial}`);
  }

  const combined = partialSummaries.join("\n\n");
  const summary = normalizeSourceNote(await callClaude(
    [
      {
        role: "user",
        content: `${finalSummaryPrompt(combined, videoUrl)}\n\n上記の「動画内容」は分割字幕から作成した中間要約です。重複を統合し、動画全体として自然な流れになるようにまとめてください。`,
      },
    ],
    env,
    6000
  ));

  return wasClipped
    ? `${summary}\n\n注：字幕が非常に長いため、先頭${MAX_TRANSCRIPT_CHARS.toLocaleString()}文字を対象に分割要約しています。`
    : summary;
}

export default {
  async fetch(request, env) {
    try {
      assertAllowedOrigin(request, env);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(env) });
      }

      if (request.method !== "POST") {
        return jsonResponse({ ok: false, error: "許可されていないメソッドです。" }, 405, env);
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        throw new UserFacingError("リクエストの形式が正しくありません。", 400);
      }

      const mode = payload && payload.mode === "transcript" ? "transcript" : "summary";
      const videoUrl = validateVideoUrl(payload && payload.url);

      await enforceRateLimit(request, env, mode);

      const transcript = await fetchTranscript(videoUrl, env);

      if (!transcript.content) {
        throw new UserFacingError(
          "この動画の字幕が見つかりませんでした。字幕が存在しない動画の可能性があります。",
          404
        );
      }

      const summary =
        mode === "transcript"
          ? transcript.content
          : await summarizeWithClaude(transcript.content, videoUrl, env);

      return jsonResponse(
        {
          ok: true,
          mode,
          summary,
          transcriptLang: transcript.lang,
          availableLangs: transcript.availableLangs,
        },
        200,
        env
      );
    } catch (err) {
      if (err instanceof UserFacingError) {
        return jsonResponse({ ok: false, error: err.message }, err.status, env);
      }
      return jsonResponse(
        { ok: false, error: "予期しないエラーが発生しました。しばらくしてから再試行してください。" },
        500,
        env
      );
    }
  },
};
