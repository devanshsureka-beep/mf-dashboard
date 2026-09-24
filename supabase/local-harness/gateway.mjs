// =============================================================================
// Docker-less local gateway — DEVELOPMENT ONLY.
//
// Emulates the two Supabase HTTP services the app uses, on one port (54321):
//   /auth/v1/*     -> proxied to a locally running Supabase Auth (GoTrue) on :9999
//   /storage/v1/*  -> a tiny file-system stand-in for Supabase Storage
//
// The storage stand-in checks the JWT signature but does NOT evaluate storage
// RLS policies. Real Supabase Storage enforces the policies in
// supabase/migrations/20260924000010_storage.sql. Never deploy this file.
//
// Usage: LOCAL_JWT_SECRET=... node supabase/local-harness/gateway.mjs
// =============================================================================
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.GATEWAY_PORT ?? 54321);
const AUTH_URL = process.env.AUTH_URL ?? "http://127.0.0.1:9999";
const SECRET = process.env.LOCAL_JWT_SECRET;
if (!SECRET) {
  console.error("LOCAL_JWT_SECRET is required");
  process.exit(1);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".storage");
mkdirSync(ROOT, { recursive: true });

function verifyJwt(token) {
  try {
    const [h, p, s] = token.split(".");
    const expected = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
    if (!timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function signToken(path, expiresIn) {
  const exp = Math.floor(Date.now() / 1000) + Number(expiresIn || 60);
  const mac = createHmac("sha256", SECRET).update(`${path}|${exp}`).digest("base64url");
  return `${exp}.${mac}`;
}

function checkToken(path, token) {
  const [exp, mac] = String(token ?? "").split(".");
  if (!exp || Number(exp) * 1000 < Date.now()) return false;
  const expected = createHmac("sha256", SECRET).update(`${path}|${exp}`).digest("base64url");
  return mac === expected;
}

function safePath(objectPath) {
  const p = normalize(decodeURIComponent(objectPath)).replace(/^(\.\.[/\\])+/, "");
  const full = join(ROOT, p);
  if (!full.startsWith(ROOT)) throw new Error("bad path");
  return full;
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractMultipartFile(buf, contentType) {
  const m = /boundary=(.+)$/.exec(contentType ?? "");
  if (!m) return buf;
  const boundary = Buffer.from(`--${m[1]}`);
  const start = buf.indexOf(boundary);
  const headerEnd = buf.indexOf(Buffer.from("\r\n\r\n"), start);
  const next = buf.indexOf(boundary, headerEnd);
  return buf.subarray(headerEnd + 4, next - 2);
}

async function handleStorage(req, res, path, query) {
  // Signed URL download (no bearer needed)
  let m = /^\/object\/sign\/(.+)$/.exec(path);
  if (m && req.method === "GET") {
    if (!checkToken(m[1], query.get("token"))) return json(res, 400, { error: "InvalidSignature" });
    const file = safePath(m[1]);
    if (!existsSync(file)) return json(res, 404, { error: "not_found" });
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(readFileSync(file));
  }

  const auth = req.headers.authorization?.replace(/^Bearer /, "");
  if (!auth || !verifyJwt(auth)) return json(res, 403, { error: "Unauthorized", message: "invalid JWT" });

  if (m && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    if (!existsSync(safePath(m[1]))) return json(res, 404, { statusCode: "404", error: "not_found", message: "Object not found" });
    const token = signToken(m[1], body.expiresIn);
    return json(res, 200, { signedURL: `/object/sign/${m[1]}?token=${token}` });
  }

  m = /^\/object\/(?:authenticated\/)?(.+)$/.exec(path);
  if (m && (req.method === "POST" || req.method === "PUT")) {
    const file = safePath(m[1]);
    if (existsSync(file) && req.headers["x-upsert"] !== "true") {
      return json(res, 400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
    }
    const raw = await readBody(req);
    const data = extractMultipartFile(raw, req.headers["content-type"]);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    return json(res, 200, { Key: m[1], Id: m[1] });
  }
  if (m && req.method === "GET") {
    const file = safePath(m[1]);
    if (!existsSync(file)) return json(res, 404, { error: "not_found" });
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(readFileSync(file));
  }
  return json(res, 404, { error: "unsupported in local gateway" });
}

function proxyAuth(req, res, path, search) {
  const target = new URL(`${path}${search}`, AUTH_URL);
  const upstream = http.request(
    target,
    { method: req.method, headers: { ...req.headers, host: target.host } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (e) => json(res, 502, { error: "auth upstream unavailable", message: e.message }));
  req.pipe(upstream);
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        });
        return res.end();
      }
      if (url.pathname.startsWith("/auth/v1")) return proxyAuth(req, res, url.pathname.slice(8) || "/", url.search);
      if (url.pathname.startsWith("/storage/v1")) return await handleStorage(req, res, url.pathname.slice(11), url.searchParams);
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: String(e?.message ?? e) });
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`local gateway on http://127.0.0.1:${PORT}`));
