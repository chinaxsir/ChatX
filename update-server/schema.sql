-- ===== 系统配置表 =====
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 插入初始密码
INSERT OR IGNORE INTO config (key, value) VALUES ('admin_password', 'frapi-admin-2026');

-- ===== 客户端消费明细表（退出时批量上报）=====
CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  estimated INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_token ON usage_logs(session_token);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_logs(ts);
