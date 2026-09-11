// Tauri 智能体 APP 后端 - 用 JSON 字符串传递，避开 IpcResponse 问题
use aes_gcm::aead::{Aead, KeyInit, generic_array::GenericArray};
use aes_gcm::Aes256Gcm;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures_util::StreamExt;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

fn default_endpoint() -> String { "https://api.frapi.kdns.fr".to_string() }

// ===== 加密存储引擎（AES-256-GCM + 设备主密钥文件）=====
// config.json 中的敏感字段以 "enc:v1:<base64(nonce||ciphertext)>" 形式落盘；
// 主密钥为首次运行随机生成的 32 字节，存于 app_data_dir/.mk（Unix 下 0600 权限）。
// 读取时兼容旧明文（非 enc:v1: 前缀的值原样通过），实现无缝迁移。

fn master_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut p = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    p.push(".mk");
    Ok(p)
}

fn get_master_key(app: &AppHandle) -> Result<Vec<u8>, String> {
    let p = master_key_path(app)?;
    if let Ok(bytes) = fs::read(&p) {
        if bytes.len() == 32 { return Ok(bytes); }
    }
    let mut key = vec![0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    fs::write(&p, &key).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    println!("已生成新的设备主密钥 -> {}", p.display());
    Ok(key)
}

fn encrypt_str(app: &AppHandle, plain: &str) -> Result<String, String> {
    if plain.is_empty() { return Ok(String::new()); }
    let key = get_master_key(app)?;
    let cipher = Aes256Gcm::new(GenericArray::from_slice(&key));
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = GenericArray::from_slice(&nonce_bytes);
    let ct = cipher.encrypt(nonce, plain.as_bytes()).map_err(|e| e.to_string())?;
    let mut packed = nonce_bytes.to_vec();
    packed.extend_from_slice(&ct);
    Ok(format!("enc:v1:{}", B64.encode(packed)))
}

fn decrypt_str(app: &AppHandle, s: &str) -> String {
    if s.is_empty() || !s.starts_with("enc:v1:") { return s.to_string(); }
    let packed = match B64.decode(&s[7..]) { Ok(d) => d, Err(_) => return String::new() };
    if packed.len() <= 12 { return String::new(); }
    let (nonce, ct) = packed.split_at(12);
    let key = match get_master_key(app) { Ok(k) => k, Err(_) => return String::new() };
    let cipher = Aes256Gcm::new(GenericArray::from_slice(&key));
    match cipher.decrypt(GenericArray::from_slice(nonce), ct) {
        Ok(pt) => String::from_utf8_lossy(&pt).to_string(),
        Err(_) => String::new(),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ThirdPartyApi {
    #[serde(default)] pub name: String,
    #[serde(default)] pub endpoint: String,
    #[serde(default)] pub api_key: String,
    #[serde(default)] pub model: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AppConfig {
    #[serde(default)] pub session_token: String,
    #[serde(default)] pub username: String,
    #[serde(default)] pub balance: f64,
    #[serde(default)] pub api_keys: Vec<String>,
    #[serde(default)] pub primary_api_key: String,
    #[serde(default = "default_endpoint")] pub builtin_endpoint: String,
    #[serde(default)] pub available_models: Vec<String>,
    #[serde(default)] pub third_party_apis: Vec<ThirdPartyApi>,
    #[serde(default)] pub current_model: String,
    #[serde(default)] pub current_api_key: String,
}

// ===== 登录 =====
#[tauri::command]
async fn login(username: String, password: String) -> Result<String, String> {
    let url = "https://api.frapi.kdns.fr/api/client-portal/login";
    println!("\n===== [Rust] 登录 {} =====", username);
    let client = reqwest::Client::new();
    let res = client.post(url)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({"username": username, "password": password}))
        .send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    println!("状态码: {}", status);
    println!("完整响应体:\n{}", body);
    
    // 尝试从登录响应直接提取 API Key
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
        println!("\n--- 解析登录响应中的 API Key ---");
        let mut found: Vec<String> = vec![];
        // 路径1: data.tokens[].token_key
        if let Some(tokens) = json.get("data").and_then(|d| d.get("tokens")).and_then(|t| t.as_array()) {
            for t in tokens {
                if let Some(k) = t.get("token_key").and_then(|v| v.as_str()) { found.push(k.to_string()); }
            }
        }
        // 路径2: data.api_keys[]
        if let Some(keys) = json.get("data").and_then(|d| d.get("api_keys")).and_then(|t| t.as_array()) {
            for k in keys {
                if let Some(v) = k.get("key").or_else(|| k.get("api_key")).or_else(|| k.get("token")).and_then(|v| v.as_str()) { found.push(v.to_string()); }
            }
        }
        // 路径3: 直接 data.api_key
        if let Some(k) = json.get("data").and_then(|d| d.get("api_key")).and_then(|v| v.as_str()) { found.push(k.to_string()); }
        
        if !found.is_empty() {
            println!("✅ 从登录响应直接提取到 {} 个 API Key:", found.len());
            for k in &found { println!("   - {}...", &k[..k.len().min(20)]); }
        } else {
            println!("⚠️ 登录响应中未直接包含 API Key 字段，将继续用 fetch_api_keys 探测");
        }
    }
    
    Ok(body)
}

// 截断字符串用于日志（避免多字节字符 panic）
fn trunc(s: &str, n: usize) -> String { s.chars().take(n).collect() }

// ===== 拉 API Key（官方控制台方式: x-session-token 头 + /dashboard 接口）=====
#[tauri::command]
async fn fetch_api_keys(session_token: String) -> Result<String, String> {
    println!("\n===== [Rust] 拉取 API Key =====");
    println!("session_token = '{}'", session_token);
    let client = reqwest::Client::new();

    // 官方控制台的真实调用方式: GET /dashboard 或 /tokens，请求头 x-session-token
    let urls = [
        "https://api.frapi.kdns.fr/api/client-portal/dashboard",
        "https://api.frapi.kdns.fr/api/client-portal/tokens",
    ];
    let mut last = String::new();
    for url in &urls {
        println!("▶ GET {} (x-session-token)", url);
        match client.get(*url).header("x-session-token", &session_token).send().await {
            Ok(r) => {
                let status = r.status();
                let body = r.text().await.unwrap_or_default();
                println!("  状态: {} | 响应: {}", status, trunc(&body, 500));
                if status.is_success() {
                    println!("✅ 成功获取！");
                    return Ok(body);
                }
                last = format!("{} -> {}", url, status);
            }
            Err(e) => println!("  ❌ 请求错误: {}", e),
        }
    }
    Err(format!("拉取 API Key 失败: {}", last))
}

// ===== 拉模型（方式1: 官方 session 接口；方式2: OpenAI /v1/models）=====
#[tauri::command(rename_all = "snake_case")]
async fn fetch_models(session_token: String, api_key: String, endpoint: String) -> Result<String, String> {
    println!("\n===== [Rust] 拉取模型列表 =====");
    let client = reqwest::Client::new();

    // 方式1: 官方控制台接口 (x-session-token)，响应 data.models / data.pools
    let url1 = "https://api.frapi.kdns.fr/api/client-portal/models";
    println!("▶ GET {} (x-session-token)", url1);
    if let Ok(r) = client.get(url1).header("x-session-token", &session_token).send().await {
        let status = r.status();
        let body = r.text().await.unwrap_or_default();
        println!("  状态: {} | 响应: {}", status, trunc(&body, 400));
        if status.is_success() {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                let mut ids: Vec<String> = vec![];
                for field in ["models", "pools"] {
                    if let Some(arr) = json.get("data").and_then(|d| d.get(field)).and_then(|v| v.as_array()) {
                        for item in arr {
                            match item {
                                serde_json::Value::String(s) => ids.push(s.clone()),
                                serde_json::Value::Object(m) => {
                                    for k in ["id", "name", "model", "model_name"] {
                                        if let Some(serde_json::Value::String(s)) = m.get(k) { ids.push(s.clone()); break; }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                if !ids.is_empty() {
                    ids.sort();
                    ids.dedup();
                    // frapi 置顶
                    ids.retain(|x| x != "frapi");
                    ids.insert(0, "frapi".to_string());
                    println!("✅ 官方接口获取 {} 个模型: {:?}", ids.len(), ids);
                    let out = serde_json::json!({ "data": ids.iter().map(|id| serde_json::json!({"id": id})).collect::<Vec<_>>() });
                    return Ok(out.to_string());
                }
            }
        }
    }

    // 方式2: OpenAI 兼容接口 (Bearer sk-...)
    let url2 = format!("{}/v1/models", endpoint.trim());
    println!("▶ 备用: GET {} (Bearer)", url2);
    if let Ok(r) = client.get(&url2).header("Authorization", format!("Bearer {}", api_key)).send().await {
        let status = r.status();
        let body = r.text().await.unwrap_or_default();
        println!("  状态: {} | 响应: {}", status, trunc(&body, 400));
        if status.is_success() { return Ok(body); }
    }
    Err("两种方式均拉取模型失败".to_string())
}

// ===== 聊天（支持多模态，非流式备用）=====
#[tauri::command(rename_all = "snake_case")]
async fn send_chat_request(token: String, prompt: String, endpoint: String, model: String, image_base64: Option<String>, history: Option<String>) -> Result<String, String> {
    println!("\n===== [Rust] 聊天(非流式) =====");
    println!("Token: {}... | Model: {} | Endpoint: {}", &token[..token.len().min(15)], model, endpoint);
    let client = reqwest::Client::new();
    let url = format!("{}/v1/chat/completions", endpoint.trim());
    
    let mut messages: Vec<serde_json::Value> = match history {
        Some(h) => serde_json::from_str(&h).unwrap_or_default(),
        None => vec![],
    };
    
    if let Some(img) = image_base64 {
        messages.push(serde_json::json!({
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": img}}
            ]
        }));
    } else {
        messages.push(serde_json::json!({"role": "user", "content": prompt}));
    }
    
    let res = client.post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({"model": model, "messages": messages}))
        .send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    println!("状态: {}", status);
    println!("响应预览: {}", trunc(&body, 300));
    Ok(body)
}

// ===== 聊天（SSE 流式：边接收边 emit chat-chunk 事件给前端）=====
#[tauri::command(rename_all = "snake_case")]
async fn send_chat_stream(app: AppHandle, token: String, prompt: String, endpoint: String, model: String, image_base64: Option<String>, history: Option<String>, request_id: Option<String>) -> Result<String, String> {
    println!("\n===== [Rust] 聊天(流式) =====");
    println!("Token: {}... | Model: {} | Endpoint: {}", &token[..token.len().min(15)], model, endpoint);
    let client = reqwest::Client::new();
    let url = format!("{}/v1/chat/completions", endpoint.trim());
    
    let mut messages: Vec<serde_json::Value> = match history {
        Some(h) => serde_json::from_str(&h).unwrap_or_default(),
        None => vec![],
    };
    
    if let Some(img) = image_base64 {
        messages.push(serde_json::json!({
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": img}}
            ]
        }));
    } else {
        messages.push(serde_json::json!({"role": "user", "content": prompt}));
    }
    
    // 请求流式响应；附带 stream_options 以获取 Token 用量，若上游不支持则自动降级重试
    let build_body = |include_usage: bool| {
        let mut body = serde_json::json!({"model": model, "messages": messages, "stream": true});
        if include_usage {
            body["stream_options"] = serde_json::json!({"include_usage": true});
        }
        body
    };
    let mut res = client.post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&build_body(true))
        .send().await.map_err(|e| format!("请求失败: {}", e))?;
    if res.status() == reqwest::StatusCode::BAD_REQUEST {
        let body = res.text().await.unwrap_or_default();
        if body.contains("stream_options") {
            println!("上游不支持 stream_options，降级重试");
            res = client.post(&url)
                .header("Authorization", format!("Bearer {}", token))
                .header("Content-Type", "application/json")
                .json(&build_body(false))
                .send().await.map_err(|e| format!("请求失败: {}", e))?;
        } else {
            return Err(format!("400: {}", trunc(&body, 200)));
        }
    }
    
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        println!("流式请求失败: {} | {}", status, trunc(&body, 200));
        return Err(format!("{}: {}", status, body));
    }
    
    let mut stream = res.bytes_stream();
    let mut full = String::new();
    let mut buffer = String::new();
    let mut chunk_count = 0usize;

    // 注册停止标志（供 stop_chat 命令触发）
    let stop_flag = Arc::new(AtomicBool::new(false));
    if let Some(rid) = &request_id {
        chat_flags().lock().unwrap().insert(rid.clone(), stop_flag.clone());
    }

    while let Some(item) = stream.next().await {
        if stop_flag.load(Ordering::Relaxed) {
            println!("用户中止流式生成，已收到 {} 字符", full.chars().count());
            let _ = app.emit("chat-stopped", full.clone());
            // 保留已生成的部分内容
            if full.is_empty() { return Err("已停止生成".to_string()); }
            return Ok(full);
        }
        let bytes = item.map_err(|e| format!("读取流失败: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        // 处理所有完整行（SSE 以换行分隔），残缺行留在 buffer
        while let Some(pos) = buffer.find('\n') {
            let line: String = buffer.drain(..pos + 1).collect();
            let line = line.trim();
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" { continue; }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                    // Token 用量（OpenAI 兼容: 最终分片携带 usage）
                    if let Some(u) = v.get("usage") {
                        if u.is_object() && u.get("total_tokens").is_some() {
                            println!("Token 用量: {}", u);
                            let _ = app.emit("chat-usage", u.clone());
                        }
                    }
                    if let Some(err) = v.get("error") {
                        let msg = err.get("message").and_then(|m| m.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| v["error"].to_string());
                        return Err(msg);
                    }
                    if let Some(delta) = v.pointer("/choices/0/delta/content").and_then(|c| c.as_str()) {
                        if !delta.is_empty() {
                            full.push_str(delta);
                            chunk_count += 1;
                            let _ = app.emit("chat-chunk", delta);
                        }
                    }
                }
            }
        }
    }
    
    println!("流式完成: {} 个分片, {} 字符", chunk_count, full.chars().count());
    if let Some(rid) = &request_id {
        chat_flags().lock().unwrap().remove(rid);
    }
    if full.is_empty() {
        return Err("上游未返回任何内容".to_string());
    }
    let _ = app.emit("chat-done", full.clone());
    Ok(full)
}

// ===== 配置持久化（敏感字段 AES-256-GCM 加密落盘）=====
// 加密字段: session_token / primary_api_key / api_keys[] / third_party_apis[].api_key
fn encrypt_config_fields(app: &AppHandle, mut cfg: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(obj) = cfg.as_object_mut() {
        for field in ["session_token", "primary_api_key"] {
            if let Some(v) = obj.get(field).and_then(|v| v.as_str()) {
                let enc = encrypt_str(app, v)?;
                obj.insert(field.to_string(), serde_json::Value::String(enc));
            }
        }
        if let Some(keys) = obj.get_mut("api_keys").and_then(|v| v.as_array_mut()) {
            for k in keys.iter_mut() {
                if let Some(s) = k.as_str() { *k = serde_json::Value::String(encrypt_str(app, s)?); }
            }
        }
        if let Some(apis) = obj.get_mut("third_party_apis").and_then(|v| v.as_array_mut()) {
            for api in apis.iter_mut() {
                if let Some(a) = api.as_object_mut() {
                    if let Some(s) = a.get("api_key").and_then(|v| v.as_str()) {
                        let enc = encrypt_str(app, s)?;
                        a.insert("api_key".to_string(), serde_json::Value::String(enc));
                    }
                }
            }
        }
    }
    Ok(cfg)
}

fn decrypt_config_fields(app: &AppHandle, mut cfg: serde_json::Value) -> serde_json::Value {
    if let Some(obj) = cfg.as_object_mut() {
        for field in ["session_token", "primary_api_key", "current_api_key"] {
            if let Some(v) = obj.get(field).and_then(|v| v.as_str()) {
                let dec = decrypt_str(app, v);
                obj.insert(field.to_string(), serde_json::Value::String(dec));
            }
        }
        if let Some(keys) = obj.get_mut("api_keys").and_then(|v| v.as_array_mut()) {
            for k in keys.iter_mut() {
                if let Some(s) = k.as_str() { *k = serde_json::Value::String(decrypt_str(app, s)); }
            }
        }
        if let Some(apis) = obj.get_mut("third_party_apis").and_then(|v| v.as_array_mut()) {
            for api in apis.iter_mut() {
                if let Some(a) = api.as_object_mut() {
                    if let Some(s) = a.get("api_key").and_then(|v| v.as_str()) {
                        let dec = decrypt_str(app, s);
                        a.insert("api_key".to_string(), serde_json::Value::String(dec));
                    }
                }
            }
        }
    }
    cfg
}

#[tauri::command]
fn save_config(app: AppHandle, config_json: String) -> Result<(), String> {
    let mut path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    path.push("config.json");
    let cfg: serde_json::Value = serde_json::from_str(&config_json).map_err(|e| format!("配置解析失败: {}", e))?;
    let encrypted = encrypt_config_fields(&app, cfg)?;
    let pretty = serde_json::to_string_pretty(&encrypted).map_err(|e| e.to_string())?;
    fs::write(&path, &pretty).map_err(|e| e.to_string())?;
    println!("配置已保存(敏感字段已加密) -> {}", path.display());
    Ok(())
}

#[tauri::command]
fn load_config(app: AppHandle) -> String {
    let mut path = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    path.push("config.json");
    if path.exists() {
        if let Ok(json) = fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&json) {
                return serde_json::to_string(&decrypt_config_fields(&app, cfg)).unwrap_or_else(|_| "{}".to_string());
            }
            return json; // 解析失败原样返回
        }
    }
    serde_json::to_string(&AppConfig::default()).unwrap_or_else(|_| "{}".to_string())
}

// ===== 历史记录 =====
#[tauri::command(rename_all = "snake_case")]
fn save_history(app: AppHandle, session_id: String, messages_json: String) -> Result<(), String> {
    let mut path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    path.push(format!("history_{}.json", session_id));
    fs::write(&path, &messages_json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_history(app: AppHandle, session_id: String) -> String {
    let mut path = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    path.push(format!("history_{}.json", session_id));
    if path.exists() {
        if let Ok(json) = fs::read_to_string(&path) { return json; }
    }
    "[]".to_string()
}

// ===== 会话自定义标题持久化（session_titles.json: { "s_xxx": "标题" }）=====
fn session_titles_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    path.push("session_titles.json");
    Ok(path)
}

fn load_session_titles(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    if let Ok(path) = session_titles_path(app) {
        if let Ok(s) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(obj) = v.as_object() {
                    return obj.clone();
                }
            }
        }
    }
    serde_json::Map::new()
}

#[tauri::command]
fn list_sessions(app: AppHandle) -> String {
    let path = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let titles = load_session_titles(&app);
    let mut sessions: Vec<serde_json::Value> = vec![];
    if let Ok(entries) = fs::read_dir(&path) {
        for entry in entries.flatten() {
            let n = entry.file_name().to_string_lossy().to_string();
            if n.starts_with("history_") && n.ends_with(".json") {
                let sid = n.replace("history_", "").replace(".json", "");
                // 读取首条用户消息作为标题 + 消息总数
                let mut title = String::new();
                let mut count = 0usize;
                if let Ok(content) = fs::read_to_string(entry.path()) {
                    if let Ok(msgs) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                        count = msgs.len();
                        for m in &msgs {
                            if m.get("role").and_then(|r| r.as_str()) == Some("user") {
                                if let Some(c) = m.get("content").and_then(|c| c.as_str()) {
                                    title = trunc(c, 24);
                                    break;
                                }
                            }
                        }
                    }
                }
                // 用户自定义标题优先
                let final_title = titles
                    .get(&sid)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| if title.is_empty() { "空会话".to_string() } else { title });
                sessions.push(serde_json::json!({
                    "id": sid,
                    "title": final_title,
                    "count": count
                }));
            }
        }
    }
    sessions.sort_by(|a, b| {
        let ai = a["id"].as_str().unwrap_or("").trim_start_matches("s_");
        let bi = b["id"].as_str().unwrap_or("").trim_start_matches("s_");
        bi.cmp(ai)
    });
    serde_json::to_string(&sessions).unwrap_or_else(|_| "[]".to_string())
}

// ===== 应用重启（更新完成后调用）=====
#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

// ===== 充值（卡密核销）=====
#[tauri::command(rename_all = "snake_case")]
async fn recharge(app: AppHandle, session_token: String, voucher_code: String) -> Result<String, String> {
    let token = decrypt_str(&app, &session_token);
    let url = "https://api.frapi.kdns.fr/api/client-portal/recharge";
    println!("\n===== [Rust] 充值核销 =====");
    let client = reqwest::Client::new();
    let res = client.post(url)
        .header("x-session-token", &token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({"voucher_code": voucher_code.trim()}))
        .send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    println!("状态: {} | 响应: {}", status, trunc(&body, 300));
    if !status.is_success() {
        // 尽量提取友好错误信息（官方格式: /error/message）
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
            let msg = v.pointer("/error/message").or_else(|| v.pointer("/data/message"))
                .or_else(|| v.pointer("/message"))
                .and_then(|m| m.as_str()).unwrap_or("卡密无效或已被使用");
            return Err(msg.to_string());
        }
        return Err(format!("{}: {}", status, trunc(&body, 200)));
    }
    Ok(body)
}

// ===== 账户信息刷新（余额 + API Keys）=====
#[tauri::command(rename_all = "snake_case")]
async fn refresh_account(app: AppHandle, session_token: String) -> Result<String, String> {
    let token = decrypt_str(&app, &session_token);
    if token.is_empty() { return Err("未登录".to_string()); }
    let url = "https://api.frapi.kdns.fr/api/client-portal/dashboard";
    println!("\n===== [Rust] 刷新账户信息 =====");
    let client = reqwest::Client::new();
    let res = client.get(url)
        .header("x-session-token", &token)
        .send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    println!("状态: {} | 响应: {}", status, trunc(&body, 300));
    if !status.is_success() { return Err(format!("{}: {}", status, trunc(&body, 200))); }
    Ok(body)
}

// ===== 删除历史会话 =====
#[tauri::command(rename_all = "snake_case")]
fn delete_session(app: AppHandle, session_id: String) -> Result<(), String> {
    let mut path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // 防路径注入：仅允许合法 session id 字符
    if !session_id.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err("非法会话 ID".to_string());
    }
    path.push(format!("history_{}.json", session_id));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
        println!("已删除会话 {}", session_id);
    }
    // 同步移除自定义标题
    let mut titles = load_session_titles(&app);
    if titles.remove(&session_id).is_some() {
        if let Ok(tp) = session_titles_path(&app) {
            let json = serde_json::to_string_pretty(&serde_json::Value::Object(titles))
                .map_err(|e| e.to_string())?;
            let _ = fs::write(&tp, json);
        }
    }
    Ok(())
}

// ===== 重命名历史会话（自定义标题持久化）=====
#[tauri::command(rename_all = "snake_case")]
fn rename_session(app: AppHandle, session_id: String, title: String) -> Result<(), String> {
    if !session_id.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err("非法会话 ID".to_string());
    }
    let t = title.trim();
    if t.is_empty() {
        return Err("标题不能为空".to_string());
    }
    let clipped: String = t.chars().take(60).collect();
    let mut titles = load_session_titles(&app);
    titles.insert(session_id, serde_json::Value::String(clipped));
    let tp = session_titles_path(&app)?;
    let json = serde_json::to_string_pretty(&serde_json::Value::Object(titles))
        .map_err(|e| e.to_string())?;
    fs::write(&tp, json).map_err(|e| e.to_string())?;
    Ok(())
}

// ===== 停止流式生成 =====
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

fn chat_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command(rename_all = "snake_case")]
fn stop_chat(request_id: String) {
    if let Some(flag) = chat_flags().lock().unwrap().get(&request_id).cloned() {
        flag.store(true, Ordering::Relaxed);
        println!("收到停止请求: {}", request_id);
    }
}

// ===== 截图快捷键（仅 Win/Linux 桌面端；移动端返回不支持）=====
#[cfg(desktop)]
fn capture_screen_data_url() -> Result<String, String> {
    use xcap::Monitor;
    let monitors = Monitor::all().map_err(|e| format!("无法枚举屏幕: {}", e))?;
    let monitor = monitors.first().ok_or("无可用屏幕")?;
    let img = monitor.capture_image().map_err(|e| format!("截屏失败: {}", e))?;
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {}", e))?;
    Ok(format!("data:image/png;base64,{}", B64.encode(png)))
}

#[cfg(desktop)]
#[tauri::command(rename_all = "snake_case")]
fn register_screenshot_hotkey(app: AppHandle, hotkey: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
    let _ = app.global_shortcut().unregister_all();
    let sc: Shortcut = hotkey.to_lowercase().replace(' ', "")
        .parse().map_err(|e| format!("快捷键格式无效: {:?}", e))?;
    app.global_shortcut().on_shortcut(sc, move |a, _s, event| {
        if event.state == ShortcutState::Pressed {
            match capture_screen_data_url() {
                Ok(data) => { let _ = a.emit("screenshot-taken", data); }
                Err(e) => { let _ = a.emit("screenshot-error", e); }
            }
        }
    }).map_err(|e| format!("注册快捷键失败(可能被占用): {}", e))?;
    println!("截图快捷键已注册: {}", hotkey);
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn unregister_screenshot_hotkey(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let _ = app.global_shortcut().unregister_all();
    Ok(())
}

// 移动端存根（保持命令注册完整）
#[cfg(not(desktop))]
#[tauri::command(rename_all = "snake_case")]
fn register_screenshot_hotkey(hotkey: String) -> Result<(), String> {
    let _ = hotkey; Err("移动端不支持截图快捷键".to_string())
}
#[cfg(not(desktop))]
#[tauri::command]
fn unregister_screenshot_hotkey() -> Result<(), String> { Ok(()) }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle();
            // 全局快捷键插件仅桌面端初始化
            #[cfg(desktop)]
            {
                let _ = handle.plugin(
                    tauri_plugin_global_shortcut::Builder::new().build()
                );
            }
            // 系统托盘（仅桌面端）
            #[cfg(desktop)]
            {
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
                use tauri::menu::{Menu, MenuItem};
                use tauri::Manager;

                let tray_menu = Menu::with_items(
                    handle,
                    &[
                        &MenuItem::with_id(handle, "tray-show", "显示 / 隐藏窗口", true, None::<&str>)?,
                        &tauri::menu::PredefinedMenuItem::separator(handle)?,
                        &MenuItem::with_id(handle, "tray-quit", "退出 Frapi AI", true, None::<&str>)?,
                    ],
                )?;

                let _tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
                    .icon(handle.default_window_icon().unwrap().clone())
                    .tooltip("Frapi AI")
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .on_tray_icon_event(|tray, event| {
                        let app = tray.app_handle();
                        match event {
                            TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
                                if let Some(w) = app.get_webview_window("main") {
                                    let now_visible = w.is_visible().unwrap_or(false);
                                    if now_visible {
                                        let _ = w.hide();
                                    } else {
                                        let _ = w.show();
                                        let _ = w.unminimize();
                                        let _ = w.set_focus();
                                    }
                                }
                            }
                            _ => {}
                        }
                    })
                    .build(handle)?;

                // 菜单点击事件
                let _ = handle.on_menu_event(|handle, event| {
                    match event.id.as_ref() {
                        "tray-show" => {
                            if let Some(w) = handle.get_webview_window("main") {
                                let now_visible = w.is_visible().unwrap_or(false);
                                if now_visible { let _ = w.hide(); } else { let _ = w.show(); let _ = w.set_focus(); }
                            }
                        }
                        "tray-quit" => { handle.exit(0); }
                        _ => {}
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭按钮 → 最小化到托盘（不退出进程）
            if let WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(desktop)]
                {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            login, fetch_api_keys, fetch_models, send_chat_request, send_chat_stream, stop_chat,
            save_config, load_config, save_history, load_history, list_sessions, delete_session,
            rename_session,
            recharge, refresh_account, restart_app, register_screenshot_hotkey, unregister_screenshot_hotkey
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}