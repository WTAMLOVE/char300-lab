export const maxTranslationCodepoints = 12000;

export type TranslationSource = {
  entryId: string;
  mode: "writing" | "version";
  versionId: string | null;
  text: string;
};

export type TranslationState =
  | { kind: "idle" }
  | { kind: "loading"; source: TranslationSource }
  | { kind: "success"; source: TranslationSource; translation: string }
  | { kind: "error"; source: TranslationSource; message: string };

function sameSource(left: TranslationSource | null, right: TranslationSource): boolean {
  return left !== null && left.entryId === right.entryId && left.mode === right.mode && left.versionId === right.versionId && left.text === right.text;
}

export class TranslationController {
  #state: TranslationState = { kind: "idle" };
  #generation = 0;
  #abort: AbortController | null = null;
  private readonly getCurrentSource: () => TranslationSource | null;
  private readonly request: (text: string, signal: AbortSignal) => Promise<string>;
  private readonly onChange: (state: TranslationState) => void;

  constructor(
    getCurrentSource: () => TranslationSource | null,
    request: (text: string, signal: AbortSignal) => Promise<string>,
    onChange: (state: TranslationState) => void
  ) {
    this.getCurrentSource = getCurrentSource;
    this.request = request;
    this.onChange = onChange;
  }

  get state(): TranslationState {
    return this.#state;
  }

  invalidate(): void {
    this.#abort?.abort();
    this.#abort = null;
    this.#generation += 1;
    this.#setState({ kind: "idle" });
  }

  async start(): Promise<void> {
    if (this.#state.kind === "loading") return;
    const source = this.getCurrentSource();
    if (!source || !source.text.trim()) return;
    if ([...source.text].length > maxTranslationCodepoints) {
      this.#setState({ kind: "error", source, message: "正文过长，请缩短后重试。" });
      return;
    }
    this.#abort?.abort();
    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#abort = controller;
    this.#setState({ kind: "loading", source });
    try {
      const translation = await this.request(source.text, controller.signal);
      if (generation !== this.#generation || !sameSource(this.getCurrentSource(), source)) return;
      this.#abort = null;
      this.#setState({ kind: "success", source, translation });
    } catch (error) {
      if (generation !== this.#generation || !sameSource(this.getCurrentSource(), source)) return;
      this.#abort = null;
      this.#setState({ kind: "error", source, message: error instanceof Error ? error.message : "翻译失败，请稍后重试。" });
    }
  }

  #setState(state: TranslationState): void {
    this.#state = state;
    this.onChange(state);
  }
}

export async function fetchTranslation(text: string, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      cache: "no-store",
      signal
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("无法连接翻译服务，请检查网络或服务配置。");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("翻译服务返回了无法识别的结果。");
  }
  if (!response.ok) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    throw new Error(typeof message === "string" ? message : "翻译失败，请稍后重试。");
  }
  const translation = (body as { translation?: unknown } | null)?.translation;
  if (typeof translation !== "string" || !translation.trim()) {
    throw new Error("翻译服务没有返回译文。");
  }
  return translation;
}

/** Reading UI state is separate from the request and from persisted article data. */
export class TranslationWorkspace {
  readonly controller: TranslationController;
  source: TranslationSource | null = null;
  display: "current" | "saved" = "current";
  cancelled = false;
  private readonly getCurrentSource: () => TranslationSource | null;
  private readonly onChange: () => void;

  constructor(getCurrentSource: () => TranslationSource | null,
    request: (text: string, signal: AbortSignal) => Promise<string>, onChange: () => void) {
    this.getCurrentSource = getCurrentSource;
    this.onChange = onChange;
    this.controller = new TranslationController(getCurrentSource, request, onChange);
  }

  get isCurrent(): boolean {
    return this.source !== null && sameSource(this.getCurrentSource(), this.source);
  }

  open(source: TranslationSource, display: "current" | "saved"): void {
    this.controller.invalidate();
    this.source = { ...source };
    this.display = display;
    this.cancelled = false;
    this.onChange();
  }

  show(display: "current" | "saved"): void {
    this.display = display;
    this.onChange();
  }

  async start(): Promise<void> {
    if (!this.isCurrent) return;
    this.cancelled = false;
    this.display = "current";
    await this.controller.start();
  }

  cancel(): void {
    this.cancelled = true;
    this.controller.invalidate();
  }

  close(): void {
    this.source = null;
    this.cancelled = false;
    this.controller.invalidate();
  }

  visibleText(saved: string): string {
    if (this.display === "saved") return saved;
    const result = this.controller.state;
    return result.kind === "success" && this.isCurrent ? result.translation : "";
  }

  get canSave(): boolean {
    return this.display === "current" && this.controller.state.kind === "success" && this.isCurrent;
  }
}
