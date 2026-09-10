// 文件上传 API
// POST /api/upload  — 上传安装包到 R2 + 写入 assets 表
//
// 请求体（multipart/form-data）:
//   file:        安装包二进制文件
//   signature:   .sig 签名内容（文本）
//   platform:    平台标识，如 "windows-x86_64"
//   version_id:  关联的版本 ID
//   filename:    自定义文件名（可选，默认用上传文件名）

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const formData = await request.formData();

    const file = formData.get('file');
    const signature = formData.get('signature');
    const platform = formData.get('platform');
    const versionId = parseInt(formData.get('version_id'));
    const customFilename = formData.get('filename');

    if (!file || !signature || !platform || !versionId) {
      return json({ error: '缺少必填字段（file, signature, platform, version_id）' }, 400);
    }

    // 生成文件名
    const filename = customFilename || file.name;
    if (filename.includes('..')) {
      return json({ error: '非法文件名' }, 400);
    }

    // 上传到 R2
    const arrayBuffer = await file.arrayBuffer();
    await env.FILES.put(filename, arrayBuffer, {
      httpMetadata: { contentType: 'application/octet-stream' },
    });

    // 如果该平台已有旧文件，先从 R2 删除
    const oldAsset = await env.DB.prepare(
      'SELECT id, filename FROM assets WHERE version_id = ? AND platform = ?'
    ).bind(versionId, platform).first();

    if (oldAsset) {
      try { await env.FILES.delete(oldAsset.filename); } catch {}
      // 更新现有记录
      await env.DB.prepare(
        'UPDATE assets SET filename = ?, signature = ?, file_size = ? WHERE id = ?'
      ).bind(filename, signature, file.size, oldAsset.id).run();
    } else {
      // 新增记录
      await env.DB.prepare(
        'INSERT INTO assets (version_id, platform, filename, signature, file_size) VALUES (?, ?, ?, ?, ?)'
      ).bind(versionId, platform, filename, signature, file.size).run();
    }

    return json({ ok: true, filename, size: file.size });
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
