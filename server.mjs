// Read-only static server for the site.
// Serves the built site (LEARN_ROOT, default /var/lib/learn) on loopback;
// A reverse proxy forwards the public hostname here. No dependencies.
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.env.LEARN_ROOT ?? "/var/lib/learn");
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8072);

const TEXT = "text/plain; charset=utf-8";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".zip": "application/zip",
  ".csv": "text/csv; charset=utf-8",
};
// Source files are always shown as plain text, never executed or rendered.
for (const ext of [".txt", ".py", ".c", ".h", ".cpp", ".hpp", ".cc", ".rs", ".ts", ".sql", ".sh", ".tex", ".sty", ".java", ".go"]) {
  MIME[ext] = TEXT;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": TEXT, "Cache-Control": "no-store" });
  res.end(body);
}

async function resolveFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rel = path.posix.normalize(decoded).replace(/^\/+/, "");
  if (rel.split("/").some((seg) => seg.startsWith("."))) return null; // hidden files, ".."
  let full = path.join(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  try {
    let info = await stat(full);
    if (info.isDirectory()) {
      full = path.join(full, "index.html");
      info = await stat(full);
    }
    const real = await realpath(full);
    if (!real.startsWith(ROOT + path.sep)) return null; // symlink escape
    return info.isFile() ? { full: real, info } : null;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return send(res, 405, "Method Not Allowed\n");
  }
  const urlPath = (req.url ?? "/").split("?")[0];
  const file = await resolveFile(urlPath);
  if (!file) return send(res, 404, "Not Found\n");

  const ext = path.extname(file.full).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  const lastModified = file.info.mtime.toUTCString();
  const headers = {
    "Content-Type": type,
    "Content-Length": file.info.size,
    "Last-Modified": lastModified,
    // App assets revalidate on each visit; versioned vendor files cache for a day.
    "Cache-Control": urlPath.startsWith("/vendor/") ? "public, max-age=86400" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": CSP,
  };
  if (!(ext in MIME)) headers["Content-Disposition"] = "attachment";

  const since = req.headers["if-modified-since"];
  if (since && Date.parse(since) >= Math.floor(file.info.mtime.getTime() / 1000) * 1000) {
    res.writeHead(304, { "Last-Modified": lastModified, "Cache-Control": headers["Cache-Control"] });
    return res.end();
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(file.full).on("error", () => res.destroy()).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`learn: serving ${ROOT} on http://${HOST}:${PORT}`);
});
