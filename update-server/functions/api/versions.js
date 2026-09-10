// 版本管理 API
// GET  /api/versions  — 列出所有版本
// POST /api/versions  — 创建新版本

export async function onRequestGet(context) {
  const { env } = context;

  try {
    const versions = await env.DB.prepare(
      `SELECT v.*, COUNT(a.id) as asset_count
       FROM versions v
       LEFT JOIN assets a ON a.version_id = v.id
       GROUP BY v.id
       ORDER BY v.created_at DESC`
    ).all();

    // 获取每个版本的 assets
    const result = [];
    for (const v of versions.results || []) {
      const assets = await env.DB.prepare(
        'SELECT id, platform, filename, file_size, download_count FROM assets WHERE version_id = ?'
      ).bind(v.id).all();
      result.push({ ...v, assets: assets.results || [] });
    }

    return json({ versions: result });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { version, notes, pub_date, is_latest } = await request.json();

    if (!version || !pub_date) {
      return json({ error: 'version 和 pub_date 为必填' }, 400);
    }

    // 如果设为最新，先取消其他版本的 is_latest
    if (is_latest) {
      await env.DB.prepare('UPDATE versions SET is_latest = 0').run();
    }

    const result = await env.DB.prepare(
      'INSERT INTO versions (version, notes, pub_date, is_latest) VALUES (?, ?, ?, ?)'
    ).bind(version, notes || '', pub_date, is_latest ? 1 : 0).run();

    return json({ id: result.meta.last_row_id, ok: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return json({ error: '版本号已存在' }, 400);
    }
    return json({ error: err.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
