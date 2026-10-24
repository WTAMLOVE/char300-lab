import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { createAnalysisBackupPayload } from "../src/backup.ts";
import { diffTexts } from "../src/diff.ts";
import { getStorageStatus, hasMeaningfulArticleData, loadState, normalizeState, parseImportedState, persistDraftState, persistState, pruneHistoricalEmptyEntries, shouldShowOpfsUpgradePrompt, updateDraft } from "../src/store.ts";
import { makeEntry, makeLegacyState, makeState, makeVersion } from "./fixtures.ts";

class MemoryStorage implements Storage {
  #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, String(value));
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage()
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: {} }
  });
});

function enableOpfsSupport(): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        getDirectory: async () => {
          throw new Error("Synthetic OPFS handle is not used by prompt tests");
        }
      }
    }
  });
}

test("normalize preserves all stored article and version identity fields", () => {
  const version = makeVersion("entry-stable", 1, "不可改写的正文。", "2026-07-04T12:00:00.000Z");
  const state = makeState([
    makeEntry({
      entry_id: "entry-stable",
      date_key: "2026-07-04",
      created_at: "2026-07-04T10:00:00.000Z",
      updated_at: "2026-07-04T12:00:00.000Z",
      versions: [version],
      current_version_id: version.version_id
    })
  ]);

  const normalized = normalizeState(state);
  assert.equal(normalized.entries[0].entry_id, "entry-stable");
  assert.equal(normalized.entries[0].created_at, "2026-07-04T10:00:00.000Z");
  assert.equal(normalized.entries[0].versions[0].version_id, version.version_id);
  assert.equal(normalized.entries[0].versions[0].entry_id, version.entry_id);
  assert.equal(normalized.entries[0].versions[0].content, version.content);
  assert.equal(normalized.entries[0].versions[0].created_at, version.created_at);
  assert.equal(normalized.entries[0].versions[0].is_initial, true);
});

test("normalize reuses persisted token statistics and diff caches when present", () => {
  const version = makeVersion("entry-derived", 1, "正文已经变化");
  version.token_stats = {
    text_units: 123,
    punctuation_units: 4,
    total_units: 127,
    han_units: 120,
    latin_units: 2,
    number_units: 1
  };
  version.diff_from_previous = [{ op: "INSERT", token: { value: "cache", kind: "latin" } }];

  const normalized = normalizeState(makeState([makeEntry({ entry_id: "entry-derived", versions: [version] })]));

  assert.deepEqual(normalized.entries[0].versions[0].token_stats, version.token_stats);
  assert.deepEqual(normalized.entries[0].versions[0].diff_from_previous, version.diff_from_previous);
});

test("wrapped v2 JSON remains importable without changing content", () => {
  const original = makeState();
  const imported = parseImportedState({ app: "逐字", schema_version: 2, state: original });
  assert.ok(imported);
  assert.equal(imported.entries[0].versions[0].content, original.entries[0].versions[0].content);
  assert.equal(imported.entries[0].versions[0].version_id, original.entries[0].versions[0].version_id);
});

test("analysis JSON restores every source field and rebuilds full diffs", () => {
  const entryId = "entry-analysis";
  const first = makeVersion(entryId, 1, "第一行\n第二行。", "2026-07-10T09:00:00.000Z");
  const second = makeVersion(entryId, 2, "第一行\n修改后的第二行！", "2026-07-10T09:05:00.000Z");
  first.diff_from_previous = diffTexts("", first.content);
  second.diff_from_previous = diffTexts(first.content, second.content);
  const original = makeState([
    makeEntry({
      entry_id: entryId,
      date_key: "2026-07-10",
      created_at: "2026-07-10T08:55:00.000Z",
      updated_at: "2026-07-10T09:06:00.000Z",
      current_version_id: second.version_id,
      optional_title: "保留标题",
      versions: [first, second],
      draft: "未保存的草稿\n也必须保留",
      lastSavedContent: second.content
    })
  ]);
  const analysisPayload = createAnalysisBackupPayload({
    app: "逐字",
    schema_version: 2 as const,
    exported_at: "2026-07-13T00:00:00.000Z",
    state: original,
    preferences: { theme: "dark" }
  });

  const imported = parseImportedState(analysisPayload);
  assert.ok(imported);
  const restored = imported.entries[0];
  assert.equal(imported.active_entry_id, original.active_entry_id);
  assert.equal(restored.entry_id, entryId);
  assert.equal(restored.date_key, "2026-07-10");
  assert.equal(restored.created_at, "2026-07-10T08:55:00.000Z");
  assert.equal(restored.updated_at, "2026-07-10T09:06:00.000Z");
  assert.equal(restored.current_version_id, second.version_id);
  assert.equal(restored.optional_title, "保留标题");
  assert.equal(restored.draft, "未保存的草稿\n也必须保留");
  assert.equal(restored.lastSavedContent, second.content);
  assert.deepEqual(restored.versions.map(({ version_id, entry_id, content, created_at, token_stats, is_initial }) => ({
    version_id,
    entry_id,
    content,
    created_at,
    token_stats,
    is_initial
  })), original.entries[0].versions.map(({ version_id, entry_id, content, created_at, token_stats, is_initial }) => ({
    version_id,
    entry_id,
    content,
    created_at,
    token_stats,
    is_initial
  })));
  assert.deepEqual(restored.versions[0].diff_from_previous, diffTexts("", first.content));
  assert.deepEqual(restored.versions[1].diff_from_previous, diffTexts(first.content, second.content));
  assert.equal("diff_summary" in restored.versions[0], false);
});

test("bare AppState remains importable", () => {
  const original = makeState();
  const imported = parseImportedState(original);
  assert.ok(imported);
  assert.equal(imported.active_entry_id, original.active_entry_id);
});

test("v1 localStorage migrates without losing the legacy version", () => {
  localStorage.setItem("char300-lab-state-v1", JSON.stringify(makeLegacyState()));
  const migrated = loadState();
  assert.equal(migrated.entries.length, 1);
  assert.equal(migrated.entries[0].entry_id, "legacy-entry");
  assert.equal(migrated.entries[0].versions[0].version_id, "legacy-version-1");
  assert.equal(migrated.entries[0].versions[0].content, "旧版正文。");
  assert.ok(localStorage.getItem("char300-lab-state-v2"));
});

test("existing v2 localStorage remains readable", () => {
  const original = makeState();
  localStorage.setItem("char300-lab-state-v2", JSON.stringify(original));
  const loaded = loadState();
  assert.equal(loaded.entries[0].versions[0].content, original.entries[0].versions[0].content);
  assert.equal(loaded.entries[0].versions[0].version_id, original.entries[0].versions[0].version_id);
});

test("an automatically created empty entry is not meaningful user data", () => {
  const empty = makeEntry({ versions: [], current_version_id: null, draft: "", lastSavedContent: "" });
  assert.equal(hasMeaningfulArticleData(makeState([empty])), false);
});

test("draft text, saved content, and even an empty saved version count as user data", () => {
  assert.equal(hasMeaningfulArticleData(makeState([makeEntry({ versions: [], draft: "草稿", lastSavedContent: "" })])), true);
  assert.equal(hasMeaningfulArticleData(makeState([makeEntry({ versions: [], draft: "", lastSavedContent: "已保存" })])), true);
  assert.equal(hasMeaningfulArticleData(makeState([makeEntry({ versions: [makeVersion("entry-1", 1, "")] })])), true);
});

test("empty v2 data starts on OPFS without showing the legacy upgrade prompt", () => {
  enableOpfsSupport();
  const empty = makeState([makeEntry({ versions: [], current_version_id: null, draft: "", lastSavedContent: "" })]);
  localStorage.setItem("char300-lab-state-v2", JSON.stringify(empty));

  loadState();

  assert.equal(localStorage.getItem("char300-lab-opfs-upgrade-v1"), "upgraded");
  assert.equal(shouldShowOpfsUpgradePrompt(), false);
});

test("meaningful v2 data still receives the one-time OPFS migration prompt", () => {
  enableOpfsSupport();
  localStorage.setItem("char300-lab-state-v2", JSON.stringify(makeState()));

  loadState();

  assert.equal(localStorage.getItem("char300-lab-opfs-upgrade-v1"), null);
  assert.equal(shouldShowOpfsUpgradePrompt(), true);
});

test("empty legacy v1 data starts on OPFS without showing a migration prompt", () => {
  enableOpfsSupport();
  localStorage.setItem(
    "char300-lab-state-v1",
    JSON.stringify({ entry: { entry_id: "legacy-empty", created_at: "2026-07-01T00:00:00.000Z" }, versions: [], draft: "", lastSavedContent: "" })
  );

  loadState();

  assert.equal(localStorage.getItem("char300-lab-opfs-upgrade-v1"), "upgraded");
  assert.equal(shouldShowOpfsUpgradePrompt(), false);
});

test("OPFS-unsupported browsers keep empty state in localStorage without showing an unusable upgrade prompt", () => {
  const empty = makeState([makeEntry({ versions: [], current_version_id: null, draft: "", lastSavedContent: "" })]);
  localStorage.setItem("char300-lab-state-v2", JSON.stringify(empty));

  loadState();

  assert.equal(localStorage.getItem("char300-lab-opfs-upgrade-v1"), null);
  assert.equal(shouldShowOpfsUpgradePrompt(), false);
});

test("OPFS draft input writes a small journal instead of rewriting the full localStorage snapshot", () => {
  enableOpfsSupport();
  const state = loadState();
  const drafted = updateDraft(state, "尚未保存的草稿");

  persistDraftState(drafted);

  assert.equal(localStorage.getItem("char300-lab-state-v2"), null);
  const journal = JSON.parse(localStorage.getItem("char300-lab-draft-journal-v1") ?? "null") as { entries?: Record<string, { draft?: string }> } | null;
  assert.equal(journal?.entries?.[drafted.active_entry_id]?.draft, "尚未保存的草稿");
});

test("OPFS draft journal preserves unsaved drafts from multiple entries", () => {
  enableOpfsSupport();
  const first = makeEntry({ entry_id: "draft-a", updated_at: "2026-07-11T01:00:00.000Z", draft: "A 草稿" });
  const second = makeEntry({ entry_id: "draft-b", updated_at: "2026-07-11T02:00:00.000Z", draft: "B 草稿" });
  loadState();

  persistDraftState({ entries: [first, second], active_entry_id: first.entry_id });
  persistDraftState({ entries: [first, second], active_entry_id: second.entry_id });

  const journal = JSON.parse(localStorage.getItem("char300-lab-draft-journal-v1") ?? "null") as DraftJournalFixture;
  assert.equal(journal.entries[first.entry_id].draft, "A 草稿");
  assert.equal(journal.entries[second.entry_id].draft, "B 草稿");
});

test("a newer draft journal is recovered over an older compatibility snapshot", () => {
  const original = makeState();
  original.entries[0].updated_at = "2026-07-11T01:00:00.000Z";
  original.entries[0].draft = "旧草稿";
  localStorage.setItem("char300-lab-state-v2", JSON.stringify(original));
  localStorage.setItem("char300-lab-opfs-upgrade-v1", "upgraded");
  localStorage.setItem(
    "char300-lab-draft-journal-v1",
    JSON.stringify({ entry_id: original.entries[0].entry_id, draft: "恢复的新草稿", updated_at: "2026-07-11T02:00:00.000Z" })
  );

  const recovered = loadState();

  assert.equal(recovered.entries[0].draft, "恢复的新草稿");
  assert.equal(recovered.entries[0].updated_at, "2026-07-11T02:00:00.000Z");
});

test("the multi-entry draft journal recovers every newer unsaved draft", () => {
  const first = makeEntry({ entry_id: "recover-a", updated_at: "2026-07-11T01:00:00.000Z", draft: "旧 A" });
  const second = makeEntry({ entry_id: "recover-b", updated_at: "2026-07-11T01:00:00.000Z", draft: "旧 B" });
  localStorage.setItem("char300-lab-state-v2", JSON.stringify({ entries: [first, second], active_entry_id: first.entry_id }));
  localStorage.setItem("char300-lab-opfs-upgrade-v1", "upgraded");
  localStorage.setItem(
    "char300-lab-draft-journal-v1",
    JSON.stringify({
      entries: {
        [first.entry_id]: { draft: "新 A", updated_at: "2026-07-11T02:00:00.000Z" },
        [second.entry_id]: { draft: "新 B", updated_at: "2026-07-11T03:00:00.000Z" }
      }
    })
  );

  const recovered = loadState();
  assert.equal(recovered.entries.find((entry) => entry.entry_id === first.entry_id)?.draft, "新 A");
  assert.equal(recovered.entries.find((entry) => entry.entry_id === second.entry_id)?.draft, "新 B");
});

test("historical cleanup never removes an entry containing user data", () => {
  const dated = "2026-01-01";
  const draft = makeEntry({ entry_id: "historical-draft", date_key: dated, versions: [], current_version_id: null, draft: "未保存正文", lastSavedContent: "" });
  const saved = makeEntry({ entry_id: "historical-saved", date_key: dated, draft: "", lastSavedContent: "已保存正文" });
  const versioned = makeEntry({ entry_id: "historical-version", date_key: dated, draft: "", lastSavedContent: "" });

  const cleaned = pruneHistoricalEmptyEntries(makeState([draft, saved, versioned]));
  assert.deepEqual(new Set(cleaned.entries.map((entry) => entry.entry_id)), new Set([draft.entry_id, saved.entry_id, versioned.entry_id]));
});

test("normalize preserves a user-defined entry title", () => {
  const state = makeState([makeEntry({ optional_title: "我的标题" })]);
  assert.equal(normalizeState(state).entries[0].optional_title, "我的标题");
});

type DraftJournalFixture = {
  entries: Record<string, { draft: string; updated_at: string }>;
};

test("storage status reports localStorage fallback when the compatibility snapshot succeeds", () => {
  persistState(makeState());
  assert.equal(getStorageStatus().kind, "local-fallback");
  assert.ok(getStorageStatus().lastSavedAt);
});

test("storage status reports failure without deleting the in-memory state when localStorage throws", () => {
  const failingStorage = new MemoryStorage();
  failingStorage.setItem = () => {
    throw new DOMException("Quota exceeded", "QuotaExceededError");
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: failingStorage
  });

  const state = makeState();
  assert.doesNotThrow(() => persistState(state));
  assert.equal(getStorageStatus().kind, "save-error");
  assert.equal(state.entries[0].versions[0].content, "第一版。");
});

test("translation saves one text per entry without changing source versions or writing timestamps", async () => {
  const { saveTranslation, saveVersion } = await import("../src/store.ts");
  const original = makeState([makeEntry({ entry_id: "a" }), makeEntry({ entry_id: "b" })]);
  const translated = saveTranslation(original, "a", "English\nSecond paragraph");
  assert.equal(original.entries[0].saved_translation, "");
  assert.equal(translated.entries[0].saved_translation, "English\nSecond paragraph");
  assert.equal(translated.entries[1], original.entries[1]);
  const { saved_translation, ...article } = translated.entries[0];
  assert.deepEqual(article, (({ saved_translation, ...rest }) => rest)(original.entries[0]));
  assert.equal(saveTranslation(translated, "a", saved_translation), translated);
  assert.equal(saveTranslation(translated, "missing", "English"), translated);
  assert.equal(saveTranslation(translated, "a", "  "), translated);
  assert.equal(saveTranslation(translated, "a", "Replacement").entries[0].saved_translation, "Replacement");
  assert.equal(updateDraft(translated, "New draft").entries[0].saved_translation, saved_translation);
  assert.equal(saveVersion(translated).entries[0].saved_translation, saved_translation);
});

test("old and malformed translation fields normalize safely while multiline translations round trip", () => {
  for (const value of [undefined, null, {}, 7, " \n "]) {
    const raw = makeState();
    (raw.entries[0] as unknown as { saved_translation: unknown }).saved_translation = value;
    assert.equal(normalizeState(raw).entries[0].saved_translation, "");
  }
  const original = makeState([makeEntry({ saved_translation: " First paragraph.\n\nSecond. " })]);
  assert.equal(parseImportedState(JSON.parse(JSON.stringify(original)))?.entries[0].saved_translation, original.entries[0].saved_translation);
  assert.equal(parseImportedState(makeLegacyState())?.entries[0].saved_translation, "");
});

test("translation-only historical practices are meaningful, retained, and recoverable", async () => {
  const original = makeState([makeEntry({ date_key: "2025-01-01", versions: [], draft: "", lastSavedContent: "", saved_translation: "Only translation" })]);
  assert.equal(hasMeaningfulArticleData(original), true);
  assert.equal(pruneHistoricalEmptyEntries(original).entries[0].saved_translation, "Only translation");
  loadState();
  assert.equal((await persistState(original)).kind, "local-fallback");
  assert.equal(loadState().entries[0].saved_translation, "Only translation");
});

// A real asynchronous in-memory OPFS adapter exercises checkpoint writes and restart recovery.
function fakeOpfs() {
  const files = new Map<string, string>();
  let failWrites = false;
  let beforeWrite: (() => Promise<void>) | undefined;
  const directory = {
    async getDirectoryHandle() { return directory; },
    async getFileHandle(name: string) {
      return {
        async getFile() {
          if (!files.has(name)) throw new Error("Not found");
          return new Blob([files.get(name)!]);
        },
        async createWritable() {
          let content = "";
          return {
            async write(text: string) {
              if (name === "checkpoint.json") await beforeWrite?.();
              if (failWrites) throw new Error("OPFS unavailable");
              content = text;
            },
            async close() { files.set(name, content); }
          };
        }
      };
    }
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage: { getDirectory: async () => directory } } });
  return { files, fail: (value: boolean) => { failWrites = value; }, pause: (callback?: () => Promise<void>) => { beforeWrite = callback; } };
}

async function startWithCheckpoint() {
  const { hydrateOpfsStorage } = await import("../src/store.ts");
  const disk = fakeOpfs();
  const original = makeState([makeEntry({ saved_translation: "Old English" })]);
  disk.files.set("checkpoint.json", JSON.stringify(original));
  localStorage.setItem("char300-lab-state-v2", JSON.stringify(original));
  localStorage.setItem("char300-lab-opfs-upgrade-v1", "upgraded");
  const loaded = loadState();
  await hydrateOpfsStorage(loaded);
  return { disk, original };
}

test("OPFS receipt waits for actual write, queue coalescing preserves newest import", async () => {
  const { disk, original } = await startWithCheckpoint();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  disk.pause(() => gate);
  const next = { ...original, entries: [{ ...original.entries[0], saved_translation: "New English" }] };
  let settled = false;
  const first = persistState(next).then((result) => { settled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  const imported = makeState([makeEntry({ entry_id: "imported", saved_translation: "Imported English" })]);
  const final = persistState(imported);
  release();
  assert.equal((await first).kind, "opfs-saved");
  assert.equal((await final).state.entries[0].entry_id, "imported");
  assert.equal(JSON.parse(disk.files.get("checkpoint.json")!).entries[0].saved_translation, "Imported English");
});

test("OPFS fallback persists downgrade so restart cannot replace new translation with old checkpoint", async () => {
  const { hydrateOpfsStorage } = await import("../src/store.ts");
  const { disk, original } = await startWithCheckpoint();
  disk.fail(true);
  const next = { ...original, entries: [{ ...original.entries[0], saved_translation: "Newest English" }] };
  assert.equal((await persistState(next)).kind, "local-fallback");
  assert.equal(localStorage.getItem("char300-lab-opfs-upgrade-v1"), "failed");
  assert.equal(JSON.parse(disk.files.get("checkpoint.json")!).entries[0].saved_translation, "Old English");
  const loaded = loadState();
  assert.equal(await hydrateOpfsStorage(loaded), null);
  assert.equal(loaded.entries[0].saved_translation, "Newest English");
});

test("unrecoverable fallback reports failure; same text can be retried when storage recovers", async () => {
  const { disk, original } = await startWithCheckpoint();
  disk.fail(true);
  const next = { ...original, entries: [{ ...original.entries[0], saved_translation: "New English" }] };
  const realSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = () => { throw new Error("Quota"); };
  assert.equal((await persistState(next)).kind, "save-error");
  assert.equal(getStorageStatus().kind, "save-error");
  localStorage.setItem = realSet;
  assert.equal((await persistState(next)).kind, "local-fallback");
  assert.equal(loadState().entries[0].saved_translation, "New English");
});

test("a failed downgrade marker is not reported as saved", async () => {
  const { disk, original } = await startWithCheckpoint();
  disk.fail(true);
  const realSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === "char300-lab-opfs-upgrade-v1") throw new Error("Marker unavailable");
    realSet(key, value);
  };
  assert.equal((await persistState(original)).kind, "save-error");
  localStorage.setItem = realSet;
});

test("coalesced receipts identify the actual persisted snapshot rather than reporting the overwritten text", async () => {
  const { disk, original } = await startWithCheckpoint();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  disk.pause(() => gate);
  const a = persistState(original);
  const intermediate = { ...original, entries: [{ ...original.entries[0], saved_translation: "Intermediate" }] };
  const b = persistState(intermediate);
  const newest = { ...original, entries: [{ ...original.entries[0], saved_translation: "Newest" }] };
  const c = persistState(newest);
  release();
  await a;
  assert.equal((await b).state.entries[0].saved_translation, "Newest");
  assert.equal((await c).state.entries[0].saved_translation, "Newest");
});

test("OPFS success is recoverable when the local compatibility snapshot runs out of quota", async () => {
  const { hydrateOpfsStorage } = await import("../src/store.ts");
  const { disk, original } = await startWithCheckpoint();
  const realSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === "char300-lab-state-v2") throw new Error("Quota");
    realSet(key, value);
  };
  const next = { ...original, entries: [{ ...original.entries[0], saved_translation: "OPFS only" }] };
  assert.equal((await persistState(next)).kind, "opfs-saved");
  localStorage.setItem = realSet;
  const recovered = await hydrateOpfsStorage(loadState());
  assert.equal(recovered?.entries[0].saved_translation, "OPFS only");
  assert.equal(JSON.parse(disk.files.get("checkpoint.json")!).entries[0].saved_translation, "OPFS only");
});

test("failed in-flight OPFS write falls back to the latest imported archive, never the old state", async () => {
  const { disk, original } = await startWithCheckpoint();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  disk.pause(() => gate);
  disk.fail(true);
  const a = persistState(original);
  const imported = makeState([makeEntry({ entry_id: "replacement", saved_translation: "Replacement" })]);
  const b = persistState(imported);
  release();
  const firstReceipt = await a;
  assert.equal(firstReceipt.kind, "local-fallback");
  assert.equal(firstReceipt.state.entries[0].entry_id, "replacement");
  assert.equal((await b).state.entries[0].entry_id, "replacement");
  assert.equal(loadState().entries[0].saved_translation, "Replacement");
});

test("deleting a practice and resetting an archive also removes its saved translation", async () => {
  const { deleteEntry, resetState } = await import("../src/store.ts");
  loadState();
  const original = makeState([makeEntry({ entry_id: "translated", saved_translation: "English" }), makeEntry({ entry_id: "other" })]);
  assert.equal(deleteEntry(original, "translated").entries.some((entry) => entry.saved_translation === "English"), false);
  const reset = resetState();
  assert.equal(reset.entries[0].saved_translation, "");
  await persistState(reset);
});
