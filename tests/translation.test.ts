import assert from "node:assert/strict";
import test from "node:test";
import { TranslationController, fetchTranslation, maxTranslationCodepoints, type TranslationSource, type TranslationState } from "../src/translation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const draft: TranslationSource = { entryId: "entry-a", mode: "writing", versionId: null, text: "今天散步了。" };

test("translation starts only on request and keeps the exact draft snapshot", async () => {
  const pending = deferred<string>();
  const sent: string[] = [];
  const states: TranslationState[] = [];
  const controller = new TranslationController(() => draft, async (text) => {
    sent.push(text);
    return pending.promise;
  }, (state) => states.push(state));
  assert.deepEqual(sent, []);
  const work = controller.start();
  await controller.start();
  assert.deepEqual(sent, [draft.text]);
  assert.equal(states.at(-1)?.kind, "loading");
  pending.resolve("I went for a walk today.");
  await work;
  assert.deepEqual(controller.state, { kind: "success", source: draft, translation: "I went for a walk today." });
});

test("editing, switching versions, and cancelling discard late translations", async () => {
  let current: TranslationSource = draft;
  const first = deferred<string>();
  const second = deferred<string>();
  const requests = [first, second];
  const controller = new TranslationController(() => current, async () => requests.shift()!.promise, () => {});
  const oldWork = controller.start();
  current = { ...draft, text: "正文已修改。" };
  controller.invalidate();
  first.resolve("Stale result");
  await oldWork;
  assert.equal(controller.state.kind, "idle");

  current = { entryId: "entry-a", mode: "version", versionId: "version-1", text: "旧版本。" };
  const versionWork = controller.start();
  current = { entryId: "entry-a", mode: "version", versionId: "version-2", text: "旧版本。" };
  second.resolve("A version translation");
  await versionWork;
  assert.equal(controller.state.kind, "loading");
  controller.invalidate();
  assert.equal(controller.state.kind, "idle");
});

test("blank text and oversized text do not reach the API", async () => {
  let source: TranslationSource = { ...draft, text: "  " };
  let calls = 0;
  const controller = new TranslationController(() => source, async () => { calls += 1; return "unused"; }, () => {});
  await controller.start();
  assert.equal(calls, 0);
  source = { ...draft, text: "字".repeat(maxTranslationCodepoints + 1) };
  await controller.start();
  assert.equal(calls, 0);
  assert.equal(controller.state.kind, "error");
});

test("client sends only text and displays a server error message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/translate");
    assert.equal(init?.method, "POST");
    assert.equal(init?.cache, "no-store");
    assert.deepEqual(JSON.parse(String(init?.body)), { text: draft.text });
    return new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "请稍后重试。" } }), { status: 429 });
  };
  try {
    await assert.rejects(() => fetchTranslation(draft.text, new AbortController().signal), { message: "请稍后重试。" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client shows the configuration prompt returned by an unconfigured server", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: "SERVICE_UNAVAILABLE", message: "请先在服务器配置 AI 接口，再使用翻译功能。" }
  }), { status: 503 });
  try {
    await assert.rejects(() => fetchTranslation(draft.text, new AbortController().signal), {
      message: "请先在服务器配置 AI 接口，再使用翻译功能。"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("saved reading makes no request, keeps the selected source and copies visible text", async () => {
  const { TranslationWorkspace } = await import("../src/translation.ts");
  const source = { ...draft, mode: "version" as const, versionId: "old-version" };
  let calls = 0;
  const workspace = new TranslationWorkspace(() => source, async () => { calls++; return "New translation"; }, () => {});
  workspace.open(source, "saved");
  assert.equal(calls, 0);
  assert.equal(workspace.visibleText("Saved translation"), "Saved translation");
  assert.equal(workspace.canSave, false);
  await workspace.start();
  assert.equal(calls, 1);
  assert.equal(workspace.source?.versionId, "old-version");
  assert.equal(workspace.canSave, true);
  workspace.show("saved");
  assert.equal(workspace.visibleText("Saved translation"), "Saved translation");
  assert.equal(workspace.canSave, false);
  workspace.show("current");
  assert.equal(workspace.visibleText("Saved translation"), "New translation");
});

test("a late translation never switches away from saved reading or reopens a closed workspace", async () => {
  const { TranslationWorkspace } = await import("../src/translation.ts");
  const pending = deferred<string>();
  let signal: AbortSignal | undefined;
  const workspace = new TranslationWorkspace(() => draft, async (_, abort) => { signal = abort; return pending.promise; }, () => {});
  workspace.open(draft, "current");
  const work = workspace.start();
  workspace.show("saved");
  pending.resolve("New");
  await work;
  assert.equal(workspace.display, "saved");
  assert.equal(workspace.visibleText("Old"), "Old");
  assert.equal(workspace.canSave, false);
  workspace.close();
  assert.equal(workspace.source, null);
  assert.equal(workspace.controller.state.kind, "idle");

  const late = deferred<string>();
  const next = new TranslationWorkspace(() => draft, async (_, abort) => { signal = abort; return late.promise; }, () => {});
  next.open(draft, "current");
  const nextWork = next.start();
  next.close();
  assert.equal(signal?.aborted, true);
  late.resolve("Late result");
  await nextWork;
  assert.equal(next.source, null);
  assert.equal(next.controller.state.kind, "idle");
});

test("workspace cancellation retains original context; changed source prevents saving and requesting", async () => {
  const { TranslationWorkspace } = await import("../src/translation.ts");
  let source = draft;
  const workspace = new TranslationWorkspace(() => source, async () => "English", () => {});
  workspace.open(source, "current");
  await workspace.start();
  source = { ...draft, entryId: "another-entry" };
  assert.equal(workspace.canSave, false);
  assert.equal(workspace.visibleText(""), "");
  workspace.cancel();
  assert.equal(workspace.cancelled, true);
  assert.equal(workspace.source?.entryId, draft.entryId);
  await workspace.start();
  assert.equal(workspace.controller.state.kind, "idle");
});
