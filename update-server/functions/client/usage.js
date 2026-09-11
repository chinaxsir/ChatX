// 客户端批量上报消费明细（退出时调用）
// 路径: POST /client/usage
// 鉴权: x-session-token（Frapi 官方 session token，仅做格式校验）
// 写入 D1: usage_logs 表

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    // 1. 基本校验
    const sessionToken = request.headers.get('x-session-token') || '';
    if (!sessionToken || sessionToken.length < 10) {
      return json({ error: 'missing or invalid session token' }, 401);
    }

    // 2. 解析请求体
    const body = await request.json();
    const logs = body.logs;
    if (!Array.isArray(logs) || logs.length === 0) {
      return json({ ok: true, inserted: 0 });
    }

    // 3. 批量写入 D1（单次最多 200 条，防止滥用）
    const batch = logs.slice(0, 200);
    const stmt = env.DB.prepare(
      'INSERT INTO usage_logs (session_token, ts, model, input_tokens, output_tokens, total_tokens, estimated) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const inserts = batch.map(e => stmt.bind(
      sessionToken,
      e.t || Date.now(),
      e.model || '',
      e.in || 0,
      e.out || 0,
      e.total || 0,
      e.est ? 1 : 0
    ));
    await env.DB.batch(inserts);

    return json({ ok: true, inserted: batch.length });
  } catch (err) {
    console.error('usage upload error:', err);
    return json({ error: 'server error' }, 500);
  }
}

// 管理后台查询：GET /client/usage?token=xxx&limit=100
export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token') || '';
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 100, 500);
    if (!token) return json({ error: 'missing token' }, 400);

    const { results } = await env.DB.prepare(
      'SELECT * FROM usage_logs WHERE session_token = ? ORDER BY ts DESC LIMIT ?'
    ).bind(token, limit).all();

    return json({ total: results.length, results });
  } catch (err) {
    return json({ error: 'server error' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
