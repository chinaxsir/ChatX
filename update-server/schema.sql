-- ===== 系统配置表 =====
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 插入初始密码
INSERT OR IGNORE INTO config (key, value) VALUES ('admin_password', 'frapi-admin-2026');
