import { TRANSLATION_INSTRUCTIONS, translationInput } from "./prompt.mjs";

const endpointNames = {
  "chat-completions": "chat/completions",
  responses: "responses"
};

export class ProviderError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function readProviderConfig(env = process.env) {
  const format = env.AI_API_FORMAT || "chat-completions";
  const rawUrl = env.AI_API_BASE_URL;
  const key = env.AI_API_KEY;
  const model = env.AI_MODEL;
  if (!rawUrl || !key || !model || !(format in endpointNames)) {
    throw new ProviderError("SERVICE_UNAVAILABLE");
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderError("SERVICE_UNAVAILABLE");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new ProviderError("SERVICE_UNAVAILABLE");
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  if (/(?:\/chat\/completions|\/responses)$/.test(basePath)) {
    throw new ProviderError("SERVICE_UNAVAILABLE");
  }
  url.pathname = `${basePath}/${endpointNames[format]}`;
  return { format, endpoint: url.toString(), key, model };
}

function extractTranslation(format, body) {
  if (format === "chat-completions") {
    const choice = body?.choices?.[0];
    if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string") {
      throw new ProviderError("UPSTREAM_ERROR");
    }
    return choice.message.content;
  }

  if (body?.status && body.status !== "completed") {
    throw new ProviderError("UPSTREAM_ERROR");
  }
  const pieces = body?.output?.flatMap((item) =>
    item?.type === "message" && Array.isArray(item.content)
      ? item.content.filter((part) => part?.type === "output_text" && typeof part.text === "string").map((part) => part.text)
      : []
  );
  if (Array.isArray(pieces) && pieces.length > 0) {
    return pieces.join("");
  }
  // Some compatible services expose the SDK convenience field in JSON.
  if (typeof body?.output_text === "string") {
    return body.output_text;
  }
  throw new ProviderError("UPSTREAM_ERROR");
}

export async function requestTranslation(text, config, { fetchImpl = fetch, signal } = {}) {
  const input = translationInput(text);
  const payload = config.format === "chat-completions"
    ? { model: config.model, messages: [{ role: "system", content: TRANSLATION_INSTRUCTIONS }, { role: "user", content: input }] }
    : { model: config.model, instructions: TRANSLATION_INSTRUCTIONS, input };

  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal
    });
  } catch (error) {
    if (signal?.aborted || error?.name === "TimeoutError") {
      throw new ProviderError("UPSTREAM_TIMEOUT");
    }
    throw new ProviderError("UPSTREAM_ERROR");
  }
  if (response.status === 429) {
    throw new ProviderError("RATE_LIMITED");
  }
  if (!response.ok) {
    throw new ProviderError(response.status === 401 || response.status === 403 ? "SERVICE_UNAVAILABLE" : "UPSTREAM_ERROR");
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new ProviderError("UPSTREAM_ERROR");
  }
  const translation = extractTranslation(config.format, body).trim();
  if (!translation || [...translation].length > 24000) {
    throw new ProviderError("UPSTREAM_ERROR");
  }
  return translation;
}
