/**
 * Cloudflare Worker: video caption summarizer backend.
 *
 * Flow: validate video URL (YouTube / TikTok / Instagram / X / Facebook) ->
 * fetch transcript from Supadata -> summarize with Claude -> return JSON to the frontend.
 *
 * Required secrets (set with `wrangler secret put <NAME>`):
 *   - SUPADATA_API_KEY
 *   - ANTHROPIC_API_KEY
 *
 * Required var (in wrangler.toml [vars] or dashboard):
 *   - ALLOWED_ORIGIN  e.g. "https://hipchin.github.io"
 */

const SUPADATA_TRANSCRIPT_URL = "https://api.supadata.ai/v1/transcript";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TRANSCRIPT_CHARS = 80000;
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
      ...corsHeaders(env),
    },
  });
}

// Domains Supadata's /v1/transcript endpoint can fetch captions/transcripts from.
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
  if (typeof content === "string") {
    return content;
  }
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
    // status is likely "processing" / "queued" -> keep polling
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
    if (!data.jobId) {
      throw new UserFacingError("字幕の取得に失敗しました。", 502);
    }
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

async function summarizeWithClaude(transcript, env) {
  let truncated = false;
  let text = transcript;
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = text.slice(0, MAX_TRANSCRIPT_CHARS);
    truncated = true;
  }

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    system:
      "あなたは優秀な学習アシスタントです。与えられた動画の字幕テキストを読み、指定形式で日本語要約してください。",
    messages: [
      {
        role: "user",
        content: `以下はYouTube動画の字幕テキストです。次の形式で日本語要約してください。

①動画の主題を1〜2文で述べる
②重要なポイントを箇条書きで5〜10項目
③学習上の気づきや応用できる点を2〜3文で述べる

字幕テキスト：
${text}`,
      },
    ],
  };

  let res;
  try {
    res = await fetch(CLAUDE_URL, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
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

  const summary = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  if (!summary) {
    throw new UserFacingError("要約の生成に失敗しました。", 502);
  }

  if (truncated) {
    return `${summary}\n\n注：動画が長いため、冒頭部分を中心に要約しています`;
  }
  return summary;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { ok: false, error: "許可されていないメソッドです。" },
        405,
        env
      );
    }

    try {
      let payload;
      try {
        payload = await request.json();
      } catch {
        throw new UserFacingError("リクエストの形式が正しくありません。", 400);
      }

      const mode = payload && payload.mode === "transcript" ? "transcript" : "summary";

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
      // Unexpected error: never leak internal details.
      return jsonResponse(
        { ok: false, error: "予期しないエラーが発生しました。しばらくしてから再試行してください。" },
        500,
        env
      );
    }
  },
};
