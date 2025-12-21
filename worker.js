export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 根路径：健康检查
    if (url.pathname === "/") {
      return new Response("meme-receipt-api is running ✅", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // 写入 KV
    if (url.pathname === "/set" && request.method === "POST") {
      const body = await request.json();
      const { key, value } = body;

      if (!key || value === undefined) {
        return new Response(
          JSON.stringify({ error: "key 和 value 必须提供" }),
          { status: 400 }
        );
      }

      await env.MEME_KV.put(key, JSON.stringify(value));

      return new Response(
        JSON.stringify({ success: true, key }),
        { headers: { "content-type": "application/json" } }
      );
    }

    // 读取 KV
    if (url.pathname === "/get") {
      const key = url.searchParams.get("key");
      if (!key) {
        return new Response(
          JSON.stringify({ error: "缺少 key 参数" }),
          { status: 400 }
        );
      }

      const value = await env.MEME_KV.get(key);
      return new Response(
        JSON.stringify({ key, value }),
        { headers: { "content-type": "application/json" } }
      );
    }

    // 404
    return new Response("Not Found", { status: 404 });
  },
};