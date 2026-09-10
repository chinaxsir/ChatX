// 管理后台 API 中间件：校验所有 /api/* 请求的认证 token
// 白名单：/api/auth（登录）不需要认证

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // 登录接口不需要认证
  if (path === '/api/auth' && request.method === 'POST') {
    return context.next();
  }

  // 校验 Authorization Bearer token
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return new Response(JSON.stringify({ error: '未登录' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 验证 token
  const valid = await verifyToken(token, env);
  if (!valid) {
    return new Response(JSON.stringify({ error: 'Token 无效或已过期' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return context.next();
}

// 验证 token：格式 base64(timestamp.hmac(timestamp, secret))
async function verifyToken(token, env) {
  try {
    const raw = atob(token);
    const [ts, hmac] = raw.split('.');
    if (!ts || !hmac) return false;

    // 7 天过期
    const age = Date.now() - parseInt(ts);
    if (age > 7 * 24 * 3600 * 1000) return false;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ts));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return hmac === expected;
  } catch {
    return false;
  }
}
