// 登录
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { password } = await request.json();
    const config = await env.DB.prepare('SELECT value FROM config WHERE key = "admin_password"').first();
    if (!config || password !== config.value) return json({ error: '密码错误' }, 401);
    const token = await generateToken(env);
    return json({ token, expires_in: 7 * 24 * 3600 });
  } catch (err) { return json({ error: '登录失败' }, 400); }
}

// 修改密码
export async function onRequestPatch(context) {
  const { request, env } = context;
  try {
    const { oldPassword, newPassword } = await request.json();
    const config = await env.DB.prepare('SELECT value FROM config WHERE key = "admin_password"').first();
    if (!config || oldPassword !== config.value) return json({ error: '原密码错误' }, 401);
    
    await env.DB.prepare('UPDATE config SET value = ? WHERE key = "admin_password"').bind(newPassword).run();
    return json({ ok: true });
  } catch (err) { return json({ error: '修改失败' }, 400); }
}

async function generateToken(env) {
  const ts = String(Date.now());
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ts));
  const hmac = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return btoa(`${ts}.${hmac}`);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
