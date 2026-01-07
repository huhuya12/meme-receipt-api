/**
 * meme-receipt-api (Cloudflare Workers)
 * Features:
 * - JSON API with CORS
 * - KV persistence (binding: MEME_KV)
 * - Optional API key auth (env.API_KEY)
 * - Receipts: create/get/list
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function corsHeaders(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers":
      "content-type,authorization,x-api-key,x-request-id",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

function withHeaders(base, extra) {
  return Object.assign({}, base, extra);
}

function json(req, status, obj, extraHeaders = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: withHeaders(withHeaders(JSON_HEADERS, corsHeaders(req)), extraHeaders),
  });
}

function text(req, status, body, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: withHeaders(corsHeaders(req), extraHeaders),
  });
}

function bad(req, msg, code = "bad_request", status = 400) {
  return json(req, status, { ok: false, code, message: msg });
}

function nowISO() {
  return new Date().toISOString();
}

function uuid() {
  // Cloudflare runtime supports crypto.randomUUID()
  return crypto.randomUUID();
}

function requireAuth(req, env) {
  if (!env.API_KEY) return null; // no auth if not set
  const k1 = req.headers.get("x-api-key");
  const k2 = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const key = k1 || k2;
  if (key !== env.API_KEY) {
    return bad(req, "Unauthorized", "unauthorized", 401);
  }
  return null;
}

async function readJson(req) {
  const ct = req.headers.get("content-type") || "";
  if (!ct.toLowerCase().includes("application/json")) return null;
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function pickReceipt(input) {
  // normalize & validate
  const r = {
    symbol: String(input.symbol || "").trim(),
    action: String(input.action || "").trim().toUpperCase(), // BUY/SELL/...
    price: Number(input.price),
    size: Number(input.size ?? 0),
    ts: input.ts ? String(input.ts) : nowISO(),
    note: input.note ? String(input.note).slice(0, 500) : "",
    source: input.source ? String(input.source).slice(0, 120) : "manual",
  };
  if (!r.symbol) return [null, "symbol is required"];
  if (!["BUY", "SELL", "HOLD", "ALERT"].includes(r.action))
    return [null, "action must be BUY/SELL/HOLD/ALERT"];
  if (!Number.isFinite(r.price) || r.price <= 0) return [null, "price must be > 0"];
  if (!Number.isFinite(r.size) || r.size < 0) return [null, "size must be >= 0"];
  return [r, null];
}

export default {
  async fetch(req, env, ctx) {
    // CORS preflight
    if (req.method === "OPTIONS") return text(req, 204, "");

    // auth (optional)
    const authErr = requireAuth(req, env);
    if (authErr) return authErr;

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    // basic health
    if (path === "/" && method === "GET") {
      return json(req, 200, {
        ok: true,
        name: "meme-receipt-api",
        time: nowISO(),
        endpoints: ["/health", "/receipt (POST)", "/receipt/:id (GET)", "/receipts (GET)"],
      });
    }
    if (path === "/health" && method === "GET") {
      return json(req, 200, {
        ok: true,
        time: nowISO(),
        kv_bound: Boolean(env.MEME_KV),
      });
    }

    // require KV
    if (!env.MEME_KV) {
      return bad(req, "KV binding MEME_KV is missing", "kv_missing", 500);
    }

    // POST /receipt  -> create receipt
    if (path === "/receipt" && method === "POST") {
      const body = await readJson(req);
      if (!body) return bad(req, "JSON body required");

      const [receipt, err] = pickReceipt(body);
      if (err) return bad(req, err);

      const id = uuid();
      const record = { id, ...receipt, created_at: nowISO() };

      const key = `receipt:${id}`;
      await env.MEME_KV.put(key, JSON.stringify(record), {
        metadata: { symbol: record.symbol, action: record.action },
      });

      // also maintain an index key for listing (by time)
      const idxKey = `idx:${Date.now()}:${id}`;
      await env.MEME_KV.put(idxKey, record.symbol, { expirationTtl: 60 * 60 * 24 * 14 }); // 14 days

      return json(req, 201, { ok: true, data: record });
    }

    // GET /receipt/:id -> fetch receipt
    if (path.startsWith("/receipt/") && method === "GET") {
      const id = path.split("/")[2] || "";
      if (!id) return bad(req, "id required");
      const key = `receipt:${id}`;
      const val = await env.MEME_KV.get(key);
      if (!val) return bad(req, "not found", "not_found", 404);
      return json(req, 200, { ok: true, data: JSON.parse(val) });
    }

    // GET /receipts?limit=50 -> list recent receipts (best-effort)
    if (path === "/receipts" && method === "GET") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 200);

      // list recent idx:* keys (lexicographic; good enough for MVP)
      const listed = await env.MEME_KV.list({ prefix: "idx:" });
      const keys = (listed.keys || [])
        .map((k) => k.name)
        .sort()
        .slice(-limit)
        .reverse();

      const ids = keys.map((k) => k.split(":")[2]).filter(Boolean);
      const values = await Promise.all(ids.map((id) => env.MEME_KV.get(`receipt:${id}`)));

      const data = values
        .filter(Boolean)
        .map((v) => {
          try { return JSON.parse(v); } catch { return null; }
        })
        .filter(Boolean);

      return json(req, 200, { ok: true, count: data.length, data });
    }

    // Not found
    return bad(req, `No route: ${method} ${path}`, "not_found", 404);
  },
};
// ===== Gate-1 去重（60秒窗口）=====
// 放置位置：POST /receipt 分支里，校验通过后、写入 receipt 之前

const fp = [
  String(body.symbol || "").toUpperCase(),
  String(body.action || "").toUpperCase(),
  String(body.price ?? ""),
  String(body.size ?? ""),
  String(body.source || "manual")
].join("|");

const fpKey = "fp:" + fp;

// 60秒内出现过 -> 认为重复，不再入库
const existed = await env.MEME_KV.get(fpKey);
if (existed) {
  // 用你原来项目里的 json() / Response 都行，关键是：return 必须在函数里
  return json(request, 200, { ok: true, duplicate: true, message: "duplicate in 60s" });
}

// 标记60秒
await env.MEME_KV.put(fpKey, "1", { expirationTtl: 60 });