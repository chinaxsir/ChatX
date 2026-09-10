// 仪表盘统计 API
// GET /api/stats — 返回总览数据 + 最近 check-in + 版本分布 + 平台分布

export async function onRequestGet(context) {
  const { env } = context;

  try {
    // 总版本数
    const versionCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM versions'
    ).first();

    // 最新版本
    const latest = await env.DB.prepare(
      'SELECT version, pub_date FROM versions WHERE is_latest = 1 LIMIT 1'
    ).first();

    // 总 check-in 数
    const checkinCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM checkins'
    ).first();

    // 有更新的 check-in 数（需要更新的客户端）
    const updateCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM checkins WHERE has_update = 1'
    ).first();

    // 总下载量
    const downloadCount = await env.DB.prepare(
      'SELECT COALESCE(SUM(download_count), 0) as total FROM assets'
    ).first();

    // 最近 30 条 check-in
    const recentCheckins = await env.DB.prepare(
      'SELECT client_version, target, arch, has_update, ip, created_at FROM checkins ORDER BY created_at DESC LIMIT 30'
    ).all();

    // 客户端版本分布
    const versionDist = await env.DB.prepare(
      'SELECT client_version, COUNT(*) as count FROM checkins GROUP BY client_version ORDER BY count DESC LIMIT 10'
    ).all();

    // 平台分布
    const platformDist = await env.DB.prepare(
      `SELECT
         CASE
           WHEN target = 'windows' THEN 'Windows'
           WHEN target = 'darwin' THEN 'macOS'
           WHEN target = 'linux' THEN 'Linux'
           ELSE COALESCE(target, 'Unknown')
         END as platform_name,
         target, arch,
         COUNT(*) as count
       FROM checkins
       GROUP BY target, arch
       ORDER BY count DESC`
    ).all();

    // 各安装包下载统计
    const assetStats = await env.DB.prepare(
      `SELECT a.filename, a.platform, a.download_count, v.version
       FROM assets a
       JOIN versions v ON a.version_id = v.id
       ORDER BY a.download_count DESC`
    ).all();

    return json({
      versions: versionCount?.count || 0,
      latest_version: latest?.version || '—',
      latest_pub_date: latest?.pub_date || '—',
      checkins: checkinCount?.count || 0,
      update_available: updateCount?.count || 0,
      downloads: downloadCount?.total || 0,
      recent_checkins: recentCheckins.results || [],
      version_distribution: versionDist.results || [],
      platform_distribution: platformDist.results || [],
      asset_stats: assetStats.results || [],
    });
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
