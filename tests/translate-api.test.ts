import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { readOptionalProviderConfig, readProviderConfig, requestTranslation, ProviderError } from "../server/providers.mjs";
import { createTranslateHandler, MAX_REQUEST_BYTES, MAX_TEXT_CODEPOINTS } from "../server/translate.mjs";

const config = {
  format: "chat-completions",
  endpoint: "https://example.test/v1/chat/completions",
  key: "private-key",
  model: "example-model"
};

function completion(text: string, finishReason = "stop") {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: text } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function createHarness(options: Parameters<typeof createTranslateHandler>[0]) {
  const handler = createTranslateHandler(options);
  return async (body: unknown, headers: Record<string, string> = {}, method = "POST") => {
    const chunks = body === null ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
    const req = Object.assign(Readable.from(chunks), {
      method,
      headers: { host: "127.0.0.1:8787", "content-type": "application/json", ...headers },
      socket: { remoteAddress: "127.0.0.1" }
    });
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      status: 0,
      headers: {} as Record<string, string>,
      body: "",
      writeHead(status: number, responseHeaders: Record<string, string>) {
        this.status = status;
        this.headers = responseHeaders;
      },
      end(value: string) {
        this.body = value;
        this.writableEnded = true;
      }
    });
    await handler(req, res);
    return { status: res.status, headers: res.headers, json: () => JSON.parse(res.body) };
  };
}

test("provider configuration appends the selected endpoint and rejects unsafe URLs", () => {
  assert.equal(readProviderConfig({ AI_API_FORMAT: "responses", AI_API_BASE_URL: "https://opencode.test/inference/openai/v1/", AI_API_KEY: "secret", AI_MODEL: "model" }).endpoint,
    "https://opencode.test/inference/openai/v1/responses");
  assert.equal(readProviderConfig({ AI_API_BASE_URL: "https://api.deepseek.test", AI_API_KEY: "secret", AI_MODEL: "model" }).endpoint,
    "https://api.deepseek.test/chat/completions");
  assert.throws(() => readProviderConfig({ AI_API_BASE_URL: "http://public.test", AI_API_KEY: "secret", AI_MODEL: "model" }), ProviderError);
  assert.throws(() => readProviderConfig({ AI_API_BASE_URL: "https://example.test/v1/responses", AI_API_KEY: "secret", AI_MODEL: "model" }), ProviderError);
});

test("AI configuration is optional until translation is requested", async () => {
  assert.equal(readOptionalProviderConfig({}), null);
  assert.equal(readOptionalProviderConfig({ AI_API_BASE_URL: "https://example.test/v1" }), null);
  assert.equal(readOptionalProviderConfig({ AI_API_BASE_URL: "http://public.test", AI_API_KEY: "secret", AI_MODEL: "model" }), null);
  assert.equal(readOptionalProviderConfig({ AI_API_BASE_URL: "https://example.test/v1", AI_API_KEY: "secret", AI_MODEL: "model" })?.endpoint,
    "https://example.test/v1/chat/completions");

  const response = await createHarness({ config: readOptionalProviderConfig({}) })({ text: "今天散步了。" });
  assert.equal(response.status, 503);
  assert.equal(response.json().error.code, "SERVICE_UNAVAILABLE");
  assert.equal(response.json().error.message, "请先在服务器配置 AI 接口，再使用翻译功能。");
});

test("chat completions sends the fixed prompt and original article as separate roles", async () => {
  const source = "今天下雨了。\n我还是出门了。";
  const translation = await requestTranslation(source, config, {
    fetchImpl: async (url, init) => {
      assert.equal(url, config.endpoint);
      assert.equal(init?.headers?.Authorization, "Bearer private-key");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(body), ["model", "messages"]);
      assert.equal(body.messages[0].role, "system");
      assert.match(body.messages[0].content, /少量俚语/);
      assert.equal(body.messages[1].role, "user");
      assert.ok(body.messages[1].content.includes(source));
      return completion("It rained today.\nI went out anyway.");
    }
  });
  assert.equal(translation, "It rained today.\nI went out anyway.");
});

test("responses format extracts output text and rejects incomplete output", async () => {
  const responseConfig = { ...config, format: "responses", endpoint: "https://example.test/v1/responses" };
  const translation = await requestTranslation("试试", responseConfig, {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.instructions.includes("自然"), true);
      assert.equal(body.input.includes("试试"), true);
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Let's give it a try." }] }] }));
    }
  });
  assert.equal(translation, "Let's give it a try.");
  await assert.rejects(() => requestTranslation("试试", responseConfig, {
    fetchImpl: async () => new Response(JSON.stringify({ status: "incomplete", output: [] }))
  }), { code: "UPSTREAM_ERROR" });
  await assert.rejects(() => requestTranslation("试试", config, {
    fetchImpl: async () => completion("partial", "length")
  }), { code: "UPSTREAM_ERROR" });
});

test("HTTP endpoint accepts a valid article and keeps private text out of logs", async () => {
  const logs: unknown[] = [];
  const request = createHarness({ config, fetchImpl: async () => completion("A plain translation."), log: (item) => logs.push(item) });
  const response = await request({ text: "私密正文" });
  assert.equal(response.status, 200);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(response.json(), { translation: "A plain translation." });
  assert.equal(JSON.stringify(logs).includes("私密正文"), false);
  assert.equal(JSON.stringify(logs).includes("private-key"), false);
});

test("HTTP endpoint rejects invalid input, origin, body size and missing configuration", async () => {
  const request = createHarness({ config, fetchImpl: async () => completion("unused") });
  assert.equal((await request({ text: "  " })).status, 400);
  assert.equal((await request("{broken json")).status, 400);
  assert.equal((await request({ text: "正文" }, { "content-type": "text/plain" })).status, 400);
  assert.equal((await request({ text: "字".repeat(MAX_TEXT_CODEPOINTS + 1) })).status, 413);
  assert.equal((await request({ text: "字".repeat(MAX_REQUEST_BYTES) })).status, 413);
  assert.equal((await request({ text: "正文" }, { origin: "https://another.test" })).status, 403);
  assert.equal((await request(null, {}, "GET")).status, 405);
  assert.equal((await createHarness({})({ text: "正文" })).status, 503);
  const strict = createHarness({ config, allowedOrigin: "http://127.0.0.1:8787", fetchImpl: async () => completion("yes") });
  assert.equal((await strict({ text: "正文" }, { origin: "http://127.0.0.1:8787" })).status, 200);
  assert.equal((await strict({ text: "正文" }, { host: "other.test", origin: "http://127.0.0.1:8787" })).status, 403);
});

test("HTTP endpoint limits repeated requests without calling the provider again", async () => {
  let calls = 0;
  const request = createHarness({ config, fetchImpl: async () => { calls += 1; return completion("Done."); } });
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await request({ text: "正文" })).status, 200);
  }
  assert.equal((await request({ text: "正文" })).status, 429);
  assert.equal(calls, 10);
});

test("HTTP endpoint maps upstream rate limiting and timeout to stable errors", async () => {
  const limited = await createHarness({ config, fetchImpl: async () => new Response("", { status: 429 }) })({ text: "正文" });
  assert.equal(limited.status, 429);
  assert.equal(limited.json().error.code, "RATE_LIMITED");
  const request = createHarness({ config, timeoutMs: 5, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }) });
  const response = await request({ text: "正文" });
  assert.equal(response.status, 504);
  assert.equal(response.json().error.code, "UPSTREAM_TIMEOUT");
});
