import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readProviderConfig } from "./providers.mjs";
import { createTranslateHandler } from "./translate.mjs";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const apiOnly = process.argv.includes("--api-only");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const distDir = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
let config;
try {
  config = readProviderConfig();
} catch {
  console.error("Translation server configuration is missing or invalid. Set AI_API_BASE_URL, AI_API_KEY, AI_MODEL and AI_API_FORMAT.");
  process.exit(1);
}

if (!apiOnly) {
  try {
    if (!statSync(resolve(distDir, "index.html")).isFile()) throw new Error("missing index");
  } catch {
    console.error("Build the site before starting the server: pnpm run build");
    process.exit(1);
  }
}

const translate = createTranslateHandler({
  config,
  allowedOrigin: process.env.APP_ORIGIN || undefined,
  log: ({ requestId, status, errorCode, durationMs }) => {
    console.info(JSON.stringify({ requestId, status, errorCode, durationMs }));
  }
});

const server = createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === "/api/translate") {
    void translate(req, res);
    return;
  }
  if (pathname.startsWith("/api/")) {
    res.writeHead(404, { "Cache-Control": "no-store" });
    res.end();
    return;
  }
  if (apiOnly || (req.method !== "GET" && req.method !== "HEAD")) {
    res.writeHead(404);
    res.end();
    return;
  }

  let file;
  try {
    file = resolve(distDir, `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (!file.startsWith(`${distDir}${sep}`)) {
    res.writeHead(403);
    res.end();
    return;
  }
  let stats;
  try {
    stats = statSync(file);
    if (!stats.isFile()) throw new Error("not a file");
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentTypes[extname(file)] || "application/octet-stream",
    "Content-Length": stats.size,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": file.endsWith(`${sep}index.html`) || file.endsWith(`${sep}sw.js`) ? "no-cache" : "public, max-age=3600"
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    createReadStream(file).pipe(res);
  }
});

server.listen(port, host, () => {
  console.info(`Zhuzi ${apiOnly ? "API" : "site and API"} listening on http://${host}:${port}`);
});
