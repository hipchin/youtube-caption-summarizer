import assert from "node:assert/strict";
import test from "node:test";

import worker from "./worker.js";

const origin = "https://example.com";
const videoUrl = "https://www.youtube.com/watch?v=test";

function request(mode = "summary") {
  return new Request("https://worker.example.com/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ url: videoUrl, mode }),
  });
}

function env() {
  return {
    ALLOWED_ORIGIN: origin,
    SUPADATA_API_KEY: "test-supadata-key",
    ANTHROPIC_API_KEY: "test-anthropic-key",
  };
}

test("summary mode requests a Source Note and removes an accidental code fence", async (t) => {
  const originalFetch = globalThis.fetch;
  let claudeRequest;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.supadata.ai/")) {
      return Response.json({ content: "睡眠時間を確保することが重要です。", lang: "ja" });
    }

    claudeRequest = JSON.parse(init.body);
    return Response.json({
      content: [
        {
          type: "text",
          text: "```markdown\n---\ntype: source\ntitle: \"睡眠の基本\"\ntopics:\n  - 睡眠\nsource_type: YouTube\nsource_url: \"https://www.youtube.com/watch?v=test\"\ndate_added: 2026-08-18\nstatus: archived\n---\n\n# 睡眠の基本\n\n## 概要\n要約です。\n```",
        },
      ],
    });
  };

  const response = await worker.fetch(request(), env());
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.match(claudeRequest.messages[0].content, /Source Note/);
  assert.match(claudeRequest.messages[0].content, /source_url: "https:\/\/www\.youtube\.com\/watch\?v=test"/);
  assert.equal(data.summary.startsWith("---\n"), true);
  assert.equal(data.summary.includes("```markdown"), false);
});

test("transcript mode keeps the existing plain transcript response", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    assert.equal(String(url).startsWith("https://api.supadata.ai/"), true);
    return Response.json({ content: "全文文字起こし", lang: "ja", availableLangs: ["ja"] });
  };

  const response = await worker.fetch(request("transcript"), env());
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.mode, "transcript");
  assert.equal(data.summary, "全文文字起こし");
});
