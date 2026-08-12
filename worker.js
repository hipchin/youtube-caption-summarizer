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

function finalSummaryPrompt(sourceText) {
  return `以下の動画内容を、日本語で次の形式に整理してください。

## 概要
動画の主題を1〜2文で述べる。

## 重要ポイント
動画内で述べられている重要事項を5〜10項目の箇条書きにする。

## 話者の主張
話者が特に強調している主張、結論、立場を整理する。

## 具体例
動画内で使われた具体例、数値、事例があれば整理する。なければ「特になし」とする。

## AIによる補足・応用
動画内容から考えられる応用や学習上の示唆を2〜3文で述べる。この欄は動画内の発言ではなくAIによる補足であることを明確にする。

動画内容：
${sourceText}`;
}

async function summarizeWithClaude(transcript, env) {
  const clipped = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  const wasClipped = transcript.length > MAX_TRANSCRIPT_CHARS;
  const chunks = splitTranscript(clipped);

  if (chunks.length === 1) {
    const summary = await callClaude(
      [{ role: "user", content: finalSummaryPrompt(chunks[0]) }],
      env,
      4096
    );
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
  const summary = await callClaude(
    [
      {
        role: "user",
        content: `${finalSummaryPrompt(combined)}\n\n上記の「動画内容」は分割字幕から作成した中間要約です。重複を統合し、動画全体として自然な流れになるようにまとめてください。`,
      },
    ],
    env,
    6000
  );

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
      await enforceRateLimit(request, env, mode);

      const videoUrl = validateVideoUrl(payload && payload.url);
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
          : await summarizeWithClaude(transcript.content, env);

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
