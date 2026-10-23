import { ProviderError, requestTranslation } from "./providers.mjs";

export const MAX_REQUEST_BYTES = 32 * 1024;
export const MAX_TEXT_CODEPOINTS = 12000;

const errors = {
  INVALID_INPUT: [400, "请输入需要翻译的正文。"],
  INPUT_TOO_LONG: [413, "正文过长，请缩短后重试。"],
  RATE_LIMITED: [429, "请求过于频繁，请稍后重试。"],
  UPSTREAM_ERROR: [502, "翻译服务暂时不可用，请稍后重试。"],
  UPSTREAM_AUTH_ERROR: [503, "AI 接口拒绝访问，请检查服务商地址和密钥。"],
  UPSTREAM_TIMEOUT: [504, "翻译超时，请稍后重试。"],
  SERVICE_UNAVAILABLE: [503, "请先在服务器配置 AI 接口，再使用翻译功能。"],
  FORBIDDEN: [403, "无法处理此请求。"]
};

function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(body));
}

function sendError(res, code) {
  const [status, message] = errors[code] ?? errors.UPSTREAM_ERROR;
  sendJson(res, status, { error: { code, message } });
  return status;
}

async function readJson(req) {
  const announcedLength = Number(req.headers["content-length"]);
  if (announcedLength > MAX_REQUEST_BYTES) throw new ProviderError("INPUT_TOO_LONG");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new ProviderError("INPUT_TOO_LONG");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProviderError("INVALID_INPUT");
  }
}

export function createTranslateHandler({ config, allowedOrigin, fetchImpl = fetch, now = Date.now, log = () => {}, timeoutMs = 60000 } = {}) {
  const attempts = new Map();
  let active = 0;

  return async function handleTranslate(req, res) {
    const startedAt = now();
    const requestId = crypto.randomUUID();
    let status = 500;
    let errorCode = null;
    try {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "仅支持 POST 请求。" } });
        status = 405;
        return;
      }
      const origin = req.headers.origin;
      const expectedOrigin = allowedOrigin || `http://${req.headers.host}`;
      if (origin && origin !== expectedOrigin) {
        errorCode = "FORBIDDEN";
        status = sendError(res, errorCode);
        return;
      }
      if (allowedOrigin && req.headers.host !== new URL(allowedOrigin).host) {
        errorCode = "FORBIDDEN";
        status = sendError(res, errorCode);
        return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
        errorCode = "INVALID_INPUT";
        status = sendError(res, errorCode);
        return;
      }
      if (!config) {
        errorCode = "SERVICE_UNAVAILABLE";
        status = sendError(res, errorCode);
        return;
      }
      const body = await readJson(req);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.text !== "string" || !body.text.trim()) {
        errorCode = "INVALID_INPUT";
        status = sendError(res, errorCode);
        return;
      }
      if ([...body.text].length > MAX_TEXT_CODEPOINTS) {
        errorCode = "INPUT_TOO_LONG";
        status = sendError(res, errorCode);
        return;
      }

      const client = req.socket.remoteAddress ?? "unknown";
      const windowStart = now() - 60000;
      const recent = (attempts.get(client) ?? []).filter((value) => value > windowStart);
      if (recent.length >= 10 || active >= 2) {
        attempts.set(client, recent);
        errorCode = "RATE_LIMITED";
        status = sendError(res, errorCode);
        return;
      }
      recent.push(now());
      attempts.set(client, recent);
      active += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      res.once("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const translation = await requestTranslation(body.text, config, { fetchImpl, signal: controller.signal });
        status = 200;
        sendJson(res, status, { translation });
      } finally {
        clearTimeout(timeout);
        active -= 1;
      }
    } catch (error) {
      errorCode = error instanceof ProviderError ? error.code : "UPSTREAM_ERROR";
      status = sendError(res, errorCode);
    } finally {
      log({ requestId, status, errorCode, durationMs: Math.max(0, now() - startedAt) });
    }
  };
}
