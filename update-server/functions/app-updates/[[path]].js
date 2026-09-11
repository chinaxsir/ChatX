// Tauri 客户端更新端点
// 路由：/app-updates/{target}/{arch}/{current_version}  → 返回 latest.json
// 路由：/app-updates/files/{filename}                    → 从 R2 下载安装包
// 路由：/app-updates/latest.json                          → 直接获取清单

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const path = params.path || [];
  const url = new URL(request.url);

  // /app-updates/latest.json — 直接返回清单（兼容静态文件方式）
  if (path.length === 1 && path[0] === 'latest.json') {
    return await getLatestManifest(env, null, null, null, request);
  }

  // /app-updates/files/{filename} — 从 R2 下载安装包
  if (path.length >= 2 && path[0] === 'files') {
    const filename = path.slice(1).join('/');
    return await serveFile(env, filename, request);
  }

  // /app-updates/{target}/{arch}/{current_version} — Tauri 标准更新检查
  if (path.length >= 3) {
    const target = path[0];       // windows / darwin / linux
    const arch = path[1];          // x86_64 / aarch64 / i686 / armv7
    const currentVersion = path[2]; // 客户端当前版本
    return await getLatestManifest(env, target, arch, currentVersion, request);
  }

  // 其他路径返回 404
  return jsonResponse({ error: 'Not found' }, 404);
}

// 构建并返回 Tauri 更新清单
async function getLatestManifest(env, target, arch, currentVersion, request) {
  try {
    // 查询最新版本
    const latest = await env.DB.prepare(
      'SELECT id, version, notes, pub_date FROM versions WHERE is_latest = 1 LIMIT 1'
    ).first();

    if (!latest) {
      return jsonResponse({ error: 'No version available' }, 404);
    }

    // 查询该版本的所有平台安装包
    const assets = await env.DB.prepare(
      'SELECT platform, filename, signature, file_size FROM assets WHERE version_id = ?'
    ).bind(latest.id).all();

    // 构建 Tauri 格式的 platforms 对象
    const platforms = {};
    for (const asset of assets.results || []) {
      // 下载 URL 指向同域名的 files 路径
      const origin = new URL(request.url).origin;
      const downloadUrl = `${origin}/app-updates/files/${asset.filename}`;
      platforms[asset.platform] = {
        signature: asset.signature,
        url: downloadUrl,
      };
    }

    // 记录客户端 check-in（异步，不阻塞响应）
    if (target && arch && currentVersion) {
      const hasUpdate = !isVersionGte(currentVersion, latest.version);
      const ip = request.headers.get('CF-Connecting-IP') || '';
      const ua = request.headers.get('User-Agent') || '';
      // D1 写入（fire-and-forget）
      env.DB.prepare(
        'INSERT INTO checkins (client_version, target, arch, has_update, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(currentVersion, target, arch, hasUpdate ? 1 : 0, ua, ip).run().catch(() => {});
    }

    // 返回 Tauri 标准 JSON
    // 注意：pub_date 必须是标准 ISO 8601 格式（YYYY-MM-DDTHH:mm:ss.000Z），Tauri updater 严格解析
    // D1 的 datetime('now') / datetime('now','localtime') 可能返回不同格式，在这里 normalize
    let pubDate = latest.pub_date || '';
    if (pubDate) {
      // 替换空格为 T，去掉无格式后缀 → 追加 Z
      pubDate = pubDate.trim();
      if (!pubDate.includes('T')) pubDate = pubDate.replace(' ', 'T');
      if (!/Z$/.test(pubDate) && !/[+-]\d{2}:\d{2}$/.test(pubDate)) {
        pubDate = pubDate + 'Z';
      }
      // 强制补 .000Z 以匹配 Tauri 期望格式
      pubDate = pubDate.replace(/Z$/, '.000Z');
    }
    return jsonResponse({
      version: latest.version,
      notes: latest.notes || '',
      pub_date: pubDate,
      platforms,
    });
  } catch (err) {
    return jsonResponse({ error: 'Internal error: ' + err.message }, 500);
  }
}

// 从 R2 提供文件下载
async function serveFile(env, filename, request) {
  try {
    // 防路径注入
    if (filename.includes('..')) {
      return new Response('Forbidden', { status: 403 });
    }

    const object = await env.FILES.get(filename);
    if (!object) {
      return new Response('File not found', { status: 404 });
    }

    // 异步增加下载计数
    env.DB.prepare(
      'UPDATE assets SET download_count = download_count + 1 WHERE filename = ?'
    ).bind(filename).run().catch(() => {});

    // 流式返回文件
    const headers = new Headers();
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    headers.set('Content-Length', object.size);
    // 安装包重新上传后必须立即生效，不缓存（避免边缘缓存旧包导致签名校验失败）
    headers.set('Cache-Control', 'no-store, must-revalidate');

    return new Response(object.body, { headers });
  } catch (err) {
    return new Response('Download error: ' + err.message, { status: 500 });
  }
}

// 简单的 SemVer 比较：currentVersion >= latestVersion → true
function isVersionGte(current, latest) {
  const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
  const [c, l] = [parse(current), parse(latest)];
  for (let i = 0; i < 3; i++) {
    if ((c[i] || 0) > (l[i] || 0)) return true;
    if ((c[i] || 0) < (l[i] || 0)) return false;
  }
  return true; // 版本相同
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
