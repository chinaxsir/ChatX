// 单个版本操作
// PUT   /api/versions/:id  — 更新版本信息 / 设为最新
// DELETE /api/versions/:id — 删除版本（同时清理 R2 中的文件）

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const id = parseInt(params.id);
  if (!id) return json({ error: '无效 ID' }, 400);

  try {
    const body = await request.json();

    // 设为最新版本
    if (body.is_latest) {
      await env.DB.prepare('UPDATE versions SET is_latest = 0').run();
      await env.DB.prepare('UPDATE versions SET is_latest = 1 WHERE id = ?').bind(id).run();
    }

    // 更新版本号 / 备注 / 发布时间
    if (body.version || body.notes !== undefined || body.pub_date) {
      const cur = await env.DB.prepare('SELECT * FROM versions WHERE id = ?').bind(id).first();
      await env.DB.prepare(
        'UPDATE versions SET version = ?, notes = ?, pub_date = ? WHERE id = ?'
      ).bind(
        body.version || cur.version,
        body.notes !== undefined ? body.notes : cur.notes,
        body.pub_date || cur.pub_date,
        id
      ).run();
    }

    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  const id = parseInt(params.id);
  if (!id) return json({ error: '无效 ID' }, 400);

  try {
    // 先查出关联的 R2 文件名，删除 R2 对象
    const assets = await env.DB.prepare(
      'SELECT filename FROM assets WHERE version_id = ?'
    ).bind(id).all();

    for (const a of assets.results || []) {
      try { await env.FILES.delete(a.filename); } catch {}
    }

    // 删除数据库记录（ON DELETE CASCADE 会自动清理 assets）
    await env.DB.prepare('DELETE FROM versions WHERE id = ?').bind(id).run();

    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
