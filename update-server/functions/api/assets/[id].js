// 删除单个安装包
// DELETE /api/assets/:id

export async function onRequestDelete(context) {
  const { env, params } = context;
  const id = parseInt(params.id);
  if (!id) return json({ error: '无效 ID' }, 400);

  try {
    // 查出文件名，从 R2 删除
    const asset = await env.DB.prepare(
      'SELECT filename FROM assets WHERE id = ?'
    ).bind(id).first();

    if (asset) {
      try { await env.FILES.delete(asset.filename); } catch {}
      await env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(id).run();
    }

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
