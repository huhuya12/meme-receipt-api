export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return json({ ok: true, ts: Date.now() });
    }

    // Read receipt
    // GET /receipt?id=xxx
    if (url.pathname === "/receipt" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return json({ ok: false, error: "missing id" }, 400);

      const key = `receipt:${id}`;
      const data = await env.MEME_KV.get(key, { type: "json" });

      return json({ ok: true, id, data: data ?? null });
    }

    // Write receipt
    // POST /receipt   body: {"id":"xxx","data":{...}}
    if (url.pathname === "/receipt" && request.method === "POST") {
      const body = await safeJson(request);
      if (!body?.id) return json({ ok: false, error: "missing id" }, 400);

      const key = `receipt:${body.id}`;
      await env.MEME_KV.put(key, JSON.stringify(body.data ?? {}));
      return json({ ok: true, id: body.id });
    }

    return new Response("Not Found", { status: 404 });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}