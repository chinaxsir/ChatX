import { useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ===== 双模式 invoke =====
// Tauri 2 会在 webview 中注入 window.__TAURI_INTERNALS__，用它判断原生环境（require 在 Vite ESM 中不存在！）
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// 参数键名双向补全：同时提供 camelCase 和 snake_case，兼容不同 Tauri 版本的 IPC 参数命名规则
function dupKeys(args: any): any {
  if (!args || typeof args !== "object") return args;
  const out: any = {};
  for (const k of Object.keys(args)) {
    out[k] = args[k];
    const camel = k.replace(/_([a-z0-9])/g, (_m: string, c: string) => c.toUpperCase());
    const snake = k.replace(/([A-Z])/g, (_m: string, c: string) => "_" + c.toLowerCase());
    if (camel !== k) out[camel] = args[k];
    if (snake !== k) out[snake] = args[k];
  }
  return out;
}

let invoke: any;
if (isTauri) {
  // 原生环境：直通 Tauri IPC，由 Rust 后端代理所有网络请求
  invoke = (cmd: string, args?: any) => (window as any).__TAURI_INTERNALS__.invoke(cmd, dupKeys(args));
  console.log("✅ Tauri 原生模式 - 走 Rust 后端");
} else {
  console.log("⚠️ 浏览器模式 - fetch 模拟（可能有 CORS 限制）");
  invoke = async (cmd: string, args: any) => {
    const mkKey = (v: any) => `Bearer ${v}`;
    if (cmd === "login") return await (await fetch("https://api.frapi.kdns.fr/api/client-portal/login", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({username: args.username, password: args.password}) })).json();
    if (cmd === "fetch_api_keys") return await (await fetch("https://api.frapi.kdns.fr/api/client-portal/tokens", { headers:{"Authorization": args.session_token} })).json();
    if (cmd === "fetch_models") return await (await fetch(`${args.endpoint}/v1/models`, { headers:{"Authorization": mkKey(args.api_key)} })).json();
    if (cmd === "send_chat_request") {
      const body: any = { model: args.model, messages: JSON.parse(args.history || "[]").concat([args.image_base64 ? { role:"user", content:[{type:"text",text:args.prompt},{type:"image_url",image_url:{url:args.image_base64}}]} : { role:"user", content: args.prompt }]) };
      return await (await fetch(`${args.endpoint}/v1/chat/completions`, { method:"POST", headers:{"Authorization": mkKey(args.token), "Content-Type":"application/json"}, body: JSON.stringify(body) })).json();
    }
    if (cmd === "load_config") { try { return JSON.parse(localStorage.getItem("agent_config")||"null") || DEFAULT; } catch { return DEFAULT; } }
    if (cmd === "save_config") { localStorage.setItem("agent_config", args.config_json); return "ok"; }
    if (cmd === "save_history") { localStorage.setItem(`history_${args.session_id}`, args.messages_json); return "ok"; }
    if (cmd === "load_history") { try { return localStorage.getItem(`history_${args.session_id}`) || "[]"; } catch { return "[]"; } }
    if (cmd === "list_sessions") { try { return localStorage.getItem("agent_sessions") || "[]"; } catch { return "[]"; } }
    return null;
  };
}

const DEFAULT = { session_token:"", username:"", balance:0, api_keys:[] as string[], primary_api_key:"", builtin_endpoint:"https://api.frapi.kdns.fr", third_party_apis:[] as any[], current_model:"frapi", current_tp:-1, usage_log:[] as any[], hotkey:"Ctrl+Alt+A" };

type Msg = { role: "user"|"assistant"; content: string; image?: string; file?: string };

const TEXT_EXT = ["txt","md","markdown","json","csv","tsv","log","xml","yml","yaml","html","htm","css","js","jsx","ts","tsx","py","java","c","h","cpp","hpp","cs","go","rs","rb","php","sh","bat","ps1","sql","ini","conf","toml","properties","swift","kt","scala","vue","svelte"];
const isDesktop = () => typeof navigator !== "undefined" && !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

// ===== 响应式 hook：检测是否移动端宽度（<=768px）=====
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth <= breakpoint;
  });
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e: MediaQueryListEvent | MediaQueryList) => setIsMobile(e.matches);
    handler(mql);
    // 兼容新旧 API
    if (mql.addEventListener) mql.addEventListener("change", handler as any);
    else mql.addListener(handler as any);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", handler as any);
      else mql.removeListener(handler as any);
    };
  }, [breakpoint]);
  return isMobile;
}

function App() {
  const [config, setConfig] = useState(DEFAULT);
  // 始终保存最新 config 的 ref，避免定时刷新/异步回调拿到过期闭包而覆盖 usage_log 等字段
  const configRef = useRef(config);
  configRef.current = config;
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [activeTab, setActiveTab] = useState<"chat"|"settings"|"history">("chat");
  const [loginForm, setLoginForm] = useState({ username:"", password:"" });
  const [loading, setLoading] = useState(false);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [sessionId, setSessionId] = useState(() => "s_" + Date.now());
  // 会话内联重命名
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const renameEscRef = useRef(false);
  const newConversation = () => { setSessionId("s_" + Date.now()); setMessages([]); };
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textFileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // ===== 自动更新（仅桌面端）=====
  const [updateInfo, setUpdateInfo] = useState<{ version: string; notes: string } | null>(null);
  const [updateState, setUpdateState] = useState<"idle"|"downloading"|"installing">("idle");
  const updateRef = useRef<any>(null);
  const [updateCheckState, setUpdateCheckState] = useState<"idle"|"checking"|"uptodate">("idle");

  // ===== 应用内 Toast 通知（替代原生 alert，避免显示 tauri.localhost 标题）=====
  const [toast, setToast] = useState<{ id: number; msg: string; type: "success" | "error" | "info" } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = (msg: string, type: "success" | "error" | "info" = "info", duration = 3200) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), msg, type });
    toastTimer.current = window.setTimeout(() => setToast(null), duration);
  };

  // 接管全局原生 alert → 应用内 Toast（原生弹窗标题栏会显示 "tauri.localhost 显示"）
  useEffect(() => {
    const originalAlert = window.alert;
    window.alert = (msg?: any) => {
      const text = String(msg ?? "");
      // 根据内容前缀自动选择类型
      const type = /✅|成功/.test(text) ? "success" : /❌|失败|错误|⚠️/.test(text) ? "error" : "info";
      showToast(text, type, /失败|错误/.test(text) ? 6000 : 3200);
    };
    return () => { window.alert = originalAlert; };
  }, []);

  // ===== 侧栏宽度可拖拽 =====
  // 顶栏保底宽度（按钮 + 状态区）+ 分割条 5px；侧栏最小可读宽度与最大占比
  const HEADER_MIN = 620;
  const SPLITTER = 5;
  const SIDEBAR_MIN = 220;
  const SIDEBAR_RATIO_MAX = 0.38;   // 侧栏最多占窗口 38%，保证左右比例合理
  const sidebarMax = (w: number) =>
    Math.max(SIDEBAR_MIN, Math.min(w - HEADER_MIN - SPLITTER, Math.floor(w * SIDEBAR_RATIO_MAX)));
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = parseInt(localStorage.getItem("sidebar_width") || "0", 10);
      if (saved > 0) return saved;
    } catch {}
    // 默认取窗口宽 24%，钳制在 240~340px
    const w = typeof window !== "undefined" ? window.innerWidth : 1280;
    return Math.max(240, Math.min(340, Math.round(w * 0.24)));
  });
  const [winW, setWinW] = useState<number>(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // 实际渲染宽度：钳制在 [SIDEBAR_MIN, min(顶栏保底剩余, 窗口38%)]，保证顶栏完整、比例合理
  const effectiveSidebarWidth = isMobile
    ? 0
    : Math.min(Math.max(SIDEBAR_MIN, sidebarWidth), sidebarMax(winW));
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const onSplitterDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;
    startWidth.current = effectiveSidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - startX.current;
      const newW = Math.min(sidebarMax(window.innerWidth), Math.max(SIDEBAR_MIN, startWidth.current + delta));
      setSidebarWidth(newW);
    };
    const onUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem("sidebar_width", String(sidebarWidth)); } catch {}
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [sidebarWidth]);

  const checkForUpdates = async (silent: boolean) => {
    if (!isTauri) { if (!silent) showToast("浏览器模式不支持更新检查", "info"); return; }
    if (!silent) setUpdateCheckState("checking");
    try {
      const update: any = await check();
      if (update) {
        updateRef.current = update;
        setUpdateInfo({ version: update.version || "?", notes: update.body || "" });
        setUpdateCheckState("idle");
        if (!silent) showToast("发现新版本 v" + (update.version || "?"), "success");
      } else {
        setUpdateCheckState("uptodate");
        if (!silent) showToast("✅ 当前已是最新版本", "success");
      }
    } catch (e) {
      console.warn("更新检查失败:", e);
      setUpdateCheckState("idle");
      if (!silent) showToast("检查更新失败，请稍后重试", "error", 5000);
    }
  };

  const installUpdate = async () => {
    const update = updateRef.current;
    if (!update) return;
    try {
      setUpdateState("downloading");
      let lastPct = -1;
      await update.downloadAndInstall((event: any) => {
        if (event.event === "Started" && event.contentLength) {
          setUpdateState("downloading");
        } else if (event.event === "Progress" && event.contentLength) {
          const pct = Math.round((event.chunkLength / event.contentLength) * 100);
          if (pct !== lastPct) { lastPct = pct; }
        } else if (event.event === "Finished") {
          setUpdateState("installing");
        }
      });
      showToast("✅ 更新完成，应用即将重启", "success");
      await invoke("restart_app");
    } catch (e) {
      showToast("更新安装失败: " + e, "error", 6000);
      setUpdateState("idle");
    }
  };

  // 启动静默检查更新
  useEffect(() => { checkForUpdates(true); }, []);

  // 登录后自动每 60 秒刷新一次余额
  useEffect(() => {
    if (!config.session_token || !isTauri) return;
    const timer = setInterval(() => { refreshBalance(); }, 60000);
    return () => clearInterval(timer);
  }, [config.session_token, isTauri]);

  // ===== 生成状态控制（停止生成）=====
  const [generating, setGenerating] = useState(false);
  const currentReqId = useRef<string>("");

  // ===== 文件附件（文本类）=====
  const [selectedFile, setSelectedFile] = useState<{ name: string; content: string } | null>(null);

  const onTextFilePicked = async (e: any) => {
    const f: File | undefined = e.target?.files?.[0];
    e.target.value = "";
    if (!f) return;
    const ext = f.name.split(".").pop()?.toLowerCase() || "";
    if (TEXT_EXT.includes(ext) || f.type.startsWith("text/")) {
      const text = await f.text();
      if (text.length > 80000) alert("文件超过 8 万字符，已自动截断前 8 万字符");
      setSelectedFile({ name: f.name, content: text.slice(0, 80000) });
    } else {
      alert("暂不支持该文件类型。\n支持：图片（🖼️ 按钮）和文本类文件（代码/配置/文档）。\nPDF、Word 等二进制格式请先另存为文本。");
    }
  };

  // ===== 截图（桌面端快捷键触发 → 框选裁剪）=====
  const [cropImg, setCropImg] = useState<string | null>(null);
  const [dragRect, setDragRect] = useState<{x:number;y:number;w:number;h:number} | null>(null);
  const dragStartRef = useRef<{x0:number;y0:number} | null>(null);
  const cropImgRef = useRef<HTMLImageElement>(null);
  const [hotkeyRec, setHotkeyRec] = useState("");

  useEffect(() => {
    if (!isTauri || !isDesktop()) return;
    let un1: any, un2: any;
    listen<string>("screenshot-taken", (e) => { setCropImg(e.payload); setDragRect(null); dragStartRef.current = null; }).then(u => { un1 = u; });
    listen<string>("screenshot-error", (e) => { alert("截图失败: " + e.payload + "\n（Linux Wayland 会话可能不支持）"); }).then(u => { un2 = u; });
    return () => { un1?.(); un2?.(); };
  }, []);

  // ESC 取消截图
  useEffect(() => {
    if (!cropImg) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { setCropImg(null); setDragRect(null); dragStartRef.current = null; } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [cropImg]);

  const endCrop = () => {
    const el = cropImgRef.current;
    const d = dragStartRef.current;
    const rect = dragRect;
    dragStartRef.current = null;
    setDragRect(null);
    if (!el || !d || !rect || rect.w < 8 || rect.h < 8) return;
    const disp = el.getBoundingClientRect();
    const sx = rect.x * (el.naturalWidth / disp.width);
    const sy = rect.y * (el.naturalHeight / disp.height);
    const sw = rect.w * (el.naturalWidth / disp.width);
    const sh = rect.h * (el.naturalHeight / disp.height);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw)); c.height = Math.max(1, Math.round(sh));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(el, sx, sy, sw, sh, 0, 0, c.width, c.height);
    setSelectedImage(c.toDataURL("image/png"));
    setCropImg(null);
  };

  // ===== 热键注册 =====
  const applyHotkey = async (hk?: string) => {
    if (!isTauri || !isDesktop()) return;
    try { await invoke("register_screenshot_hotkey", { hotkey: hk || config.hotkey || "Ctrl+Alt+A" }); }
    catch (e) { console.warn("截图热键注册失败:", e); }
  };
  useEffect(() => { if (config.session_token) applyHotkey(); }, []);

  const stopGeneration = () => {
    if (currentReqId.current) invoke("stop_chat", { request_id: currentReqId.current });
  };

  // ===== 充值（卡密核销）=====
  const [showRecharge, setShowRecharge] = useState(false);
  const [voucherCode, setVoucherCode] = useState("");
  const [recharging, setRecharging] = useState(false);

  const refreshBalance = async () => {
    try {
      // 用 ref 读取最新 config，避免定时任务闭包过期而回退/覆盖 usage_log 等字段
      const cur: any = configRef.current;
      const res: any = await invoke("refresh_account", { session_token: cur.session_token });
      const r = typeof res === "string" ? JSON.parse(res) : res;
      if (r?.data?.balance != null) {
        const newCfg: any = { ...configRef.current, balance: r.data.balance };
        if (r.data.username) newCfg.username = r.data.username;
        // 同步最新 API Keys（含 quota/用量信息）
        if (r.data.tokens && Array.isArray(r.data.tokens)) {
          const keys = r.data.tokens.map((t:any)=>t.token_key).filter(Boolean);
          if (keys.length) { newCfg.api_keys = keys; if (!newCfg.primary_api_key) newCfg.primary_api_key = keys[0]; }
        }
        setConfig(newCfg);
        invoke("save_config", { config_json: JSON.stringify(newCfg) });
        return true;
      }
    } catch (e) { console.warn("余额刷新失败:", e); }
    return false;
  };

  const doRecharge = async () => {
    if (!voucherCode.trim()) { alert("请输入卡密"); return; }
    setRecharging(true);
    try {
      const res: any = await invoke("recharge", { session_token: config.session_token, voucher_code: voucherCode.trim() });
      const r = typeof res === "string" ? JSON.parse(res) : res;
      if (r?.status === "success") {
        alert("✅ 充值成功！" + (r.data?.message || r.data?.amount != null ? `到账 ${r.data.amount}` : ""));
        setVoucherCode(""); setShowRecharge(false);
        await refreshBalance();
      } else {
        alert("❌ 充值失败: " + (r?.message || r?.data?.message || JSON.stringify(r).substring(0,150)));
      }
    } catch (e: any) { alert("❌ 充值失败: " + (e?.toString?.()||e)); }
    finally { setRecharging(false); }
  };

  useEffect(() => {
    invoke("load_config").then((c: any) => {
      const obj = typeof c === "string" ? JSON.parse(c) : c;
      if (obj && typeof obj === "object") setConfig({ ...DEFAULT, ...obj });
    }).catch(console.error);
    invoke("list_sessions").then((s: any) => {
      const arr = typeof s === "string" ? JSON.parse(s) : s;
      if (Array.isArray(arr)) setSessions(arr);
    }).catch(()=>{});
  }, []);

  const saveSession = async (sid: string, msgs: Msg[]) => {
    try { await invoke("save_history", { session_id: sid, messages_json: JSON.stringify(msgs) }); } catch {}
    const firstUser = msgs.find(m => m.role === "user");
    const autoTitle = (firstUser?.content || "图片对话").substring(0, 24);
    setSessions(prev => {
      // 已存在的会话保留其标题（可能是用户自定义更名），新会话用首条消息自动命名
      const existing = prev.find((s:any) => s.id === sid);
      const item = { id: sid, title: existing ? existing.title : autoTitle, count: msgs.length };
      return [item, ...prev.filter((s:any) => s.id !== sid)].slice(0, 50);
    });
  };

  const handleLogin = async () => {
    setLoading(true);
    const errs: string[] = [];
    try {
      const res: any = await invoke("login", loginForm);
      const r = typeof res === "string" ? JSON.parse(res) : res;
      console.log("=== 登录响应 ===", r);
      if (r.status !== "success") { alert("登录失败: " + (r.message||JSON.stringify(r))); return; }

      const d = r.data;
      let newCfg: any = { ...DEFAULT, session_token: d.session_token||"", username: d.username||"", balance: d.balance||0, builtin_endpoint: "https://api.frapi.kdns.fr" };

      // 步骤1: 提取 API Key（登录响应 → 备用 dashboard 接口）
      let apiKeys: string[] = [];
      if (d?.tokens && Array.isArray(d.tokens)) apiKeys = d.tokens.map((t:any)=>t.token_key).filter(Boolean);
      if (apiKeys.length === 0) {
        try {
          const kRes: any = await invoke("fetch_api_keys", { session_token: d.session_token||"" });
          const kd = typeof kRes === "string" ? JSON.parse(kRes) : kRes;
          console.log("=== API Key 接口响应 ===", kd);
          const tarr = kd?.data?.tokens || kd?.tokens || (Array.isArray(kd) ? kd : []);
          apiKeys = tarr.map((t:any) => typeof t === "string" ? t : (t?.token_key || t?.key || t?.api_key || "")).filter(Boolean);
          if (apiKeys.length === 0) errs.push("Key接口无tokens: " + JSON.stringify(kd).substring(0,120));
        } catch (e: any) { errs.push("fetch_api_keys: " + (e?.toString?.()||e)); }
      }
      newCfg.api_keys = apiKeys;
      newCfg.primary_api_key = apiKeys[0] || "";

      // 内置 API 由后端智能路由（frapi），无需拉取模型列表
      newCfg.current_model = "frapi";
      newCfg.current_tp = -1;

      // 步骤2: 持久化（失败不阻塞使用）
      try { await invoke("save_config", { config_json: JSON.stringify(newCfg) }); }
      catch (e: any) { errs.push("save_config: " + (e?.toString?.()||e)); }

      setConfig(newCfg);
      applyHotkey(newCfg.hotkey);
      if (errs.length) alert("登录成功，但有告警:\n" + errs.join("\n"));
      else alert("✅ 登录成功！获取 " + apiKeys.length + " 个 API Key");
    } catch (e: any) { alert("登录失败: " + (e?.toString?.()||e)); }
    finally { setLoading(false); }
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => setSelectedImage(reader.result as string);
    reader.readAsDataURL(file);
  };

  const sendMessage = async () => {
    if (!input.trim() && !selectedImage && !selectedFile) return;
    // 按 current_tp 解析当前使用的 API（-1=内置智能路由，>=0=第三方 API 索引）
    let endpoint = config.builtin_endpoint;
    let token = config.primary_api_key || config.api_keys[0] || "";
    let model = config.current_model || "frapi";
    const tpIdx = (config as any).current_tp;
    if (tpIdx != null && tpIdx >= 0 && config.third_party_apis[tpIdx]) {
      const tp = config.third_party_apis[tpIdx];
      endpoint = tp.endpoint; token = tp.api_key; model = config.current_model;
    }
    if (!token) { alert("⚠️ 无 API Key！"); return; }

    // 组装最终 prompt（文本附件内容注入）
    let prompt = input.trim();
    if (selectedFile) {
      prompt = `【附件文件: ${selectedFile.name}】\n\`\`\`\n${selectedFile.content}\n\`\`\`\n\n${prompt || "请阅读以上文件内容并总结要点。"}`;
    }
    const bubbleText = input.trim() || (selectedFile ? `📎 ${selectedFile.name}` : "[图片]");
    const userMsg: Msg = { role:"user", content: bubbleText, image: selectedImage || undefined, file: selectedFile?.name };
    const baseMsgs = [...messages, userMsg];
    const aiIdx = baseMsgs.length; // 新 assistant 消息的索引
    setMessages([...baseMsgs, { role:"assistant", content:"" }]);
    setInput(""); setSelectedImage(null);
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";

    const historyForApi = messages.map(m => ({ role: m.role, content: m.content }));
    const reqId = "r_" + Date.now();
    currentReqId.current = reqId;
    const reqArgs = {
      token, prompt: prompt || "描述这张图片", endpoint, model,
      image_base64: selectedImage || null,
      history: JSON.stringify(historyForApi),
      request_id: reqId
    };

    // 追加流式片段到 assistant 气泡 + 捕获 Token 用量
    let acc = "";
    let usageData: any = null;
    const appendDelta = (delta: string) => {
      acc += delta;
      setMessages(prev => prev.map((m, i) => i === aiIdx ? { ...m, content: acc } : m));
    };

    // 原生环境：监听 chat-chunk / chat-usage 事件（失败则回退非流式）
    let unlisten: (() => void) | null = null;
    if (isTauri) {
      try {
        const un1 = await listen<string>("chat-chunk", (e) => appendDelta(e.payload));
        const un2 = await listen<any>("chat-usage", (e) => { usageData = e.payload; });
        unlisten = () => { un1(); un2(); };
      } catch (e) { console.warn("事件监听失败，回退非流式:", e); unlisten = null; }
    }

    setGenerating(true);
    try {
      let fullText = "";
      if (unlisten) {
        // 流式：Rust 边收边 emit，invoke 最终返回完整文本
        const r: any = await invoke("send_chat_stream", reqArgs);
        fullText = typeof r === "string" ? r : String(r ?? "");
      } else {
        // 浏览器模式/回退：非流式
        const res: any = await invoke("send_chat_request", reqArgs);
        const data = typeof res === "string" ? JSON.parse(res) : res;
        if (data?.choices?.[0]?.message?.content) {
          fullText = data.choices[0].message.content;
          if (data?.usage?.total_tokens != null) usageData = data.usage;
        }
        else if (data?.error) throw new Error((data.error.code||data.error.status||"?") + ": " + (data.error.message||JSON.stringify(data.error)).substring(0,250));
        else throw new Error("响应异常: " + JSON.stringify(data).substring(0, 250));
      }
      // 用后端返回的完整文本定稿（与流式累计一致性兜底）
      if (!fullText && acc) fullText = acc;
      setMessages(prev => {
        const out = prev.map((m, i) => i === aiIdx ? { ...m, content: fullText || acc } : m);
        saveSession(sessionId, out);
        return out;
      });
      recordUsage(model, fullText || acc, usageData);
    } catch (e: any) {
      const raw = e?.toString?.()||String(e);
      let errText = "⚠️ " + raw;
      if (raw.includes("429") || raw.toLowerCase().includes("quota")) {
        errText += "\n\n💡 该模型上游配额已满，建议切换为 frapi 模型；若提示余额不足，请点击顶部 💵 充值。";
      }
      setMessages(prev => {
        const out = prev.map((m, i) => i === aiIdx ? { ...m, content: errText } : m);
        saveSession(sessionId, out);
        return out;
      });
    } finally {
      if (unlisten) unlisten();
      setGenerating(false);
      currentReqId.current = "";
    }
  };

  // ===== Token 用量记录 =====
  const recordUsage = (model: string, text: string, usage: any) => {
    try {
      // 用 ref 读取最新 config，确保连续对话时用量记录累加而非被旧闭包覆盖
      const cur: any = configRef.current;
      const log = cur.usage_log || [];
      let entry: any;
      if (usage && usage.total_tokens != null) {
        entry = { t: Date.now(), model, in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0, total: usage.total_tokens };
      } else {
        // 无精确用量时按 ~4 字符/token 估算
        entry = { t: Date.now(), model, in: 0, out: Math.ceil((text || "").length / 4), total: Math.ceil((text || "").length / 4), est: true };
      }
      const newCfg: any = { ...cur, usage_log: [entry, ...log].slice(0, 200) };
      setConfig(newCfg);
      invoke("save_config", { config_json: JSON.stringify(newCfg) });
    } catch {}
  };

  // ===== 第三方 API 管理（弹窗表单 + 模型列表自动刷新）=====
  const [showTpForm, setShowTpForm] = useState(false);
  const [tpForm, setTpForm] = useState({ name:"", endpoint:"", api_key:"", model:"" });
  const [tpTesting, setTpTesting] = useState(false);

  const openTpForm = () => { setTpForm({ name:"", endpoint:"", api_key:"", model:"" }); setShowTpForm(true); };

  const fetchTpModels = async (api_key: string, endpoint: string): Promise<string[]> => {
    try {
      const res: any = await invoke("fetch_models", { api_key, endpoint });
      const md = typeof res === "string" ? JSON.parse(res) : res;
      const arr = md?.data || (Array.isArray(md) ? md : []);
      return arr.map((m:any) => typeof m === "string" ? m : (m?.id || m?.name || "")).filter(Boolean);
    } catch { return []; }
  };

  const saveTpApi = async () => {
    if (!tpForm.endpoint.trim() || !tpForm.api_key.trim()) { alert("请填写 Endpoint 和 API Key"); return; }
    setTpTesting(true);
    // 自动拉取该 API 的可用模型列表
    const models = await fetchTpModels(tpForm.api_key.trim(), tpForm.endpoint.trim());
    const model = tpForm.model.trim() || models[0] || "";
    const newCfg: any = { ...config, third_party_apis: [...config.third_party_apis, { name: tpForm.name.trim() || `API ${config.third_party_apis.length+1}`, endpoint: tpForm.endpoint.trim(), api_key: tpForm.api_key.trim(), model, models }] };
    // 自动选中新 API 的第一个模型
    const idx = newCfg.third_party_apis.length - 1;
    if (model) { newCfg.current_tp = idx; newCfg.current_model = model; }
    setConfig(newCfg);
    invoke("save_config", { config_json: JSON.stringify(newCfg) });
    setTpTesting(false);
    setShowTpForm(false);
    alert(models.length ? `✅ 已添加并获取 ${models.length} 个模型` : "✅ 已添加（未能自动获取模型列表，已使用手动填写的模型名）");
  };

  const refreshTpModels = async (i: number) => {
    const tp = config.third_party_apis[i];
    if (!tp) return;
    const models = await fetchTpModels(tp.api_key, tp.endpoint);
    const newCfg: any = { ...config, third_party_apis: config.third_party_apis.map((a:any,idx:number) => idx===i ? { ...a, models, model: a.model || models[0] || "" } : a) };
    setConfig(newCfg);
    invoke("save_config", { config_json: JSON.stringify(newCfg) });
    alert(models.length ? `🔄 已刷新 ${models.length} 个模型` : "⚠️ 未能获取模型列表（检查 Endpoint/Key）");
  };

  const removeThirdPartyApi = (i: number) => {
    const newCfg: any = { ...config, third_party_apis: config.third_party_apis.filter((_, idx) => idx !== i) };
    if ((newCfg.current_tp ?? -1) === i) { newCfg.current_tp = -1; newCfg.current_model = "frapi"; }
    else if ((newCfg.current_tp ?? -1) > i) newCfg.current_tp = newCfg.current_tp - 1;
    setConfig(newCfg); invoke("save_config", { config_json: JSON.stringify(newCfg) });
  };
  const loadSession = async (sid: string) => {
    try { const r: any = await invoke("load_history", { session_id: sid }); const arr = typeof r === "string" ? JSON.parse(r) : r; setMessages(Array.isArray(arr)?arr:[]); setSessionId(sid); setActiveTab("chat"); } catch { setMessages([]); }
  };
  const removeSession = async (sid: string) => {
    if (!confirm("确定删除该会话？删除后不可恢复。")) return;
    try { await invoke("delete_session", { session_id: sid }); } catch (e) { alert("删除失败: " + e); return; }
    setSessions((prev:any[]) => prev.filter(s => s.id !== sid));
  };
  // ===== 会话内联重命名 =====
  const startRename = (s: any) => {
    renameEscRef.current = false;
    setRenameVal(s.title || "");
    setRenamingId(s.id);
  };
  const commitRename = async (sid: string) => {
    if (renameEscRef.current) { renameEscRef.current = false; return; }
    const t = renameVal.trim();
    setRenamingId(null);
    if (!t) return;
    const cur = sessions.find((x:any) => x.id === sid);
    if (cur && cur.title === t) return;   // 无变化
    // 乐观更新本地列表
    setSessions((prev:any[]) => prev.map((x:any) => x.id === sid ? { ...x, title: t } : x));
    try {
      await invoke("rename_session", { session_id: sid, title: t });
    } catch (e) {
      alert("更名失败: " + e);
      // 失败则重新拉取，回滚本地状态
      try { const s:any = await invoke("list_sessions"); const arr = typeof s === "string" ? JSON.parse(s) : s; if (Array.isArray(arr)) setSessions(arr); } catch {}
    }
  };
  const logout = () => { invoke("save_config", { config_json: JSON.stringify(DEFAULT) }); setConfig(DEFAULT); setMessages([]); };

  // ===== 辅助：顶栏状态区 + 菜单按钮合并 =====
  const renderHeader = () => (
    <>
      <span className="username">{config.username}</span>
      <span className="balance" onClick={refreshBalance} title="点击刷新余额">${Number(config.balance).toFixed(2)}</span>
      {config.api_keys.length > 0
        ? <span className="key-count">🔑 {config.api_keys.length}</span>
        : <span className="key-empty">⚠️ 无 Key</span>}
      {!isMobile && (
        <button className="btn btn-warn" onClick={()=>setShowRecharge(true)}>💵 充值</button>
      )}
      {/* 桌面端历史会话常驻左侧栏，顶栏不再重复“历史”入口 */}
      {!isMobile && [
        {k:'chat', t:'💬 对话'},
        {k:'settings', t:'⚙️ 设置'}
      ].map(x => (
        <button key={x.k} className={`btn btn-tab${activeTab===x.k?' active':''}`} onClick={()=>setActiveTab(x.k as any)}>{x.t}</button>
      ))}
      <button className="btn btn-ghost" onClick={logout}>🚪 退出</button>
    </>
  );

  // ===== 登录页 =====
  if (!config.username) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-brand">
            <div className="login-logo">🤖</div>
            <h1>Frapi AI</h1>
            <p className="login-tag">智能对话 · 多模态交互</p>
          </div>
          <input placeholder="用户名 / 邮箱" onChange={e=>setLoginForm({...loginForm,username:e.target.value})}/>
          <input type="password" placeholder="密码" onChange={e=>setLoginForm({...loginForm,password:e.target.value})} onKeyDown={e=>e.key==='Enter'&&!loading&&handleLogin()}/>
          <button type="submit" disabled={loading} onClick={handleLogin}>{loading?"登录中...":"登 录"}</button>
          <div className="login-footer">🛒 购买卡密请联系微信：<span className="wechat" onClick={()=>navigator.clipboard.writeText('xsirchats')}>xsirchats（点击复制）</span></div>
        </div>
      </div>
    );
  }

  // ===== 消息行渲染 =====
  const renderMessageRow = (m: Msg, i: number) => (
    <div key={i} className={`msg-row ${m.role}`}>
      <div>
        <div className={`msg-bubble ${m.role}`}>
          {m.image && <img src={m.image} />}
          {m.file && <div className="file-tag">📎 {m.file}</div>}
          {m.role === 'assistant'
            ? (m.content === ''
                ? <span className="thinking">思考中<span className="thinking-dots"></span></span>
                : <div className="md"><Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown></div>)
            : <span>{m.content}</span>}
        </div>
        {m.role === 'assistant' && m.content && (
          <button className="copy-btn" onClick={()=>{navigator.clipboard.writeText(m.content);}}>📋 复制</button>
        )}
      </div>
    </div>
  );

  // ===== 附件预览区 =====
  const renderAttachPreview = () => (selectedImage || selectedFile) ? (
    <div className="attach-row">
      {selectedImage && (
        <div className="attach-preview">
          <img src={selectedImage} />
          <button className="remove-btn" onClick={()=>setSelectedImage(null)}>移除</button>
        </div>
      )}
      {selectedFile && (
        <div className="attach-item">
          📎 {selectedFile.name}
          <button className="remove-btn" onClick={()=>setSelectedFile(null)}>✕</button>
        </div>
      )}
    </div>
  ) : null;

  // ===== 输入栏 =====
  const renderInputBar = () => (
    <div className="input-bar">
      {renderAttachPreview()}
      <div className="input-row">
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageChange} style={{ display:'none' }}/>
        <button className="attach-btn" onClick={()=>fileInputRef.current?.click()} title="上传图片">🖼️</button>
        <input ref={textFileInputRef} type="file" accept=".txt,.md,.markdown,.json,.csv,.tsv,.log,.xml,.yml,.yaml,.html,.htm,.css,.js,.jsx,.ts,.tsx,.py,.java,.c,.h,.cpp,.hpp,.cs,.go,.rs,.rb,.php,.sh,.bat,.ps1,.sql,.ini,.conf,.toml,.properties,.swift,.kt,.scala,.vue,.svelte,text/*" onChange={onTextFilePicked} style={{ display:'none' }}/>
        <button className="attach-btn" onClick={()=>textFileInputRef.current?.click()} title="上传文本文件（代码/配置/文档）">📎</button>
        <input
          value={input}
          onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>e.key==='Enter'&&!generating&&sendMessage()}
          placeholder="输入消息..."
        />
        {generating
          ? <button className="stop-btn" onClick={stopGeneration}>⏹ 停止</button>
          : <button className="send-btn" onClick={sendMessage}>发送</button>}
      </div>
    </div>
  );

  // ===== 模型选择 select =====
  const modelValue = (config as any).current_tp != null && (config as any).current_tp >= 0
    ? `tp:${(config as any).current_tp}:${config.current_model}`
    : "builtin:frapi";
  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    const newCfg: any = { ...config };
    if (v === "builtin:frapi") { newCfg.current_tp = -1; newCfg.current_model = "frapi"; }
    else {
      const rest = v.slice(3); const p = rest.indexOf(":");
      newCfg.current_tp = Number(rest.slice(0, p));
      newCfg.current_model = rest.slice(p+1);
    }
    setConfig(newCfg);
    invoke("save_config", { config_json: JSON.stringify(newCfg) });
  };

  const renderModelPicker = () => (
    <select className="model-picker" value={modelValue} onChange={handleModelChange}>
      <optgroup label="🔵 内置 (智能路由)">
        <option value="builtin:frapi">frapi（智能选择）</option>
      </optgroup>
      {config.third_party_apis.length > 0 && (
        <optgroup label="🟢 第三方 API">
          {config.third_party_apis.map((api:any, i:number) => {
            const list = (api.models && api.models.length) ? api.models : [api.model];
            return list.filter(Boolean).map((m:string) => (
              <option key={i+':'+m} value={`tp:${i}:${m}`}>{api.name} → {m}</option>
            ));
          })}
        </optgroup>
      )}
    </select>
  );

  // ===== 会话列表（桌面侧边栏 / 移动历史 Tab）=====
  const renderSessionList = () => (
    <>
      {sessions.length === 0 ? (
        <div className="empty-state">
          <div className="emoji">📜</div>
          <div>暂无历史会话</div>
        </div>
      ) : sessions.map((s:any) => (
        <div key={s.id} className={`session-item ${s.id === sessionId ? 'active' : ''}${renamingId === s.id ? ' renaming' : ''}`}>
          {renamingId === s.id ? (
            <input
              className="session-rename-input"
              autoFocus
              value={renameVal}
              maxLength={60}
              placeholder="输入会话名称"
              onChange={e=>setRenameVal(e.target.value)}
              onClick={e=>e.stopPropagation()}
              onKeyDown={e=>{
                if (e.key === 'Enter') { e.preventDefault(); commitRename(s.id); }
                else if (e.key === 'Escape') { renameEscRef.current = true; setRenamingId(null); }
              }}
              onBlur={()=>commitRename(s.id)}
            />
          ) : (
            <>
              <div className="session-main" onClick={()=>loadSession(s.id)} onDoubleClick={()=>startRename(s)} title="双击重命名">
                <div className="title">💬 {s.title}</div>
                <div className="session-time">
                  {new Date(parseInt(String(s.id).replace('s_',''))||0).toLocaleString()} · {s.count} 条消息
                </div>
              </div>
              <div className="session-actions">
                <button className="icon-btn" title="重命名" onClick={(e)=>{ e.stopPropagation(); startRename(s); }}>✏️</button>
                <button className="del-btn" title="删除会话" onClick={(e)=>{ e.stopPropagation(); removeSession(s.id); }}>🗑</button>
              </div>
            </>
          )}
        </div>
      ))}
    </>
  );

  // ===== 设置页 =====
  const renderSettings = () => {
    const log: any[] = (config as any).usage_log || [];
    const sum = log.reduce((a:any,e:any) => ({ in: a.in + (e.in||0), out: a.out + (e.out||0), total: a.total + (e.total||0) }), { in:0, out:0, total:0 });

    return (
      <div className="page-content">
        <div className="page-section">
          <h3>🔵 内置 frapi API</h3>
          <div style={{ fontSize: '13px', color: 'var(--text-500)' }}>
            后端智能路由自动选择最优模型 · {config.api_keys.length} 个 API Key · {config.builtin_endpoint}
          </div>
        </div>

        <div className="page-section">
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'12px' }}>
            <h3 style={{ margin: 0 }}>🟢 第三方 API</h3>
            <button className="btn btn-ok" onClick={openTpForm}>+ 添加</button>
          </div>
          {config.third_party_apis.length === 0 ? (
            <div className="empty-state" style={{ padding:'24px' }}>
              <div>暂无第三方 API，添加后将自动获取可用模型列表</div>
            </div>
          ) : config.third_party_apis.map((api:any, i:number) => (
            <div key={i} className="tp-card">
              <div className="tp-info">
                <div className="tp-name">{api.name}{api.models?.length ? <span className="tp-models">{api.models.length} 个模型</span> : null}</div>
                <div className="tp-endpoint">{api.endpoint}</div>
              </div>
              <div className="tp-actions">
                <button className="tp-refresh" onClick={()=>refreshTpModels(i)} title="刷新模型列表">🔄</button>
                <button className="del-btn" onClick={()=>removeThirdPartyApi(i)} title="删除">🗑</button>
              </div>
            </div>
          ))}
        </div>

        {isTauri && isDesktop() && (
          <div className="page-section">
            <h3>⌨️ 截图快捷键</h3>
            <div style={{ fontSize: '12px', color: 'var(--text-500)', marginBottom: '10px' }}>
              全局截图：按下快捷键截取屏幕 → 拖拽框选区域 → 自动添加到输入框（仅 Win/Linux 桌面端）
            </div>
            <div className="form-row">
              <input
                readOnly
                className={hotkeyRec ? 'recording' : ''}
                value={hotkeyRec || (config as any).hotkey || "Ctrl+Alt+A"}
                placeholder="点击此处后按下新快捷键"
                onKeyDown={e => {
                  e.preventDefault();
                  const parts: string[] = [];
                  if (e.ctrlKey) parts.push("Ctrl");
                  if (e.altKey) parts.push("Alt");
                  if (e.shiftKey) parts.push("Shift");
                  const k = e.key;
                  if (!["Control","Alt","Shift","Meta"].includes(k)) {
                    parts.push(k.length === 1 ? k.toUpperCase() : k);
                    setHotkeyRec(parts.join("+"));
                  }
                }}
              />
              <button
                className="btn btn-primary"
                onClick={async () => {
                  const hk = hotkeyRec || (config as any).hotkey || "Ctrl+Alt+A";
                  try {
                    await invoke("register_screenshot_hotkey", { hotkey: hk });
                    const c: any = { ...config, hotkey: hk };
                    setConfig(c); invoke("save_config", { config_json: JSON.stringify(c) });
                    setHotkeyRec("");
                    alert("✅ 截图快捷键已设置为: " + hk);
                  } catch (e) { alert("设置失败（快捷键可能被其他程序占用）:\n" + e); }
                }}
              >保存快捷键</button>
            </div>
          </div>
        )}

        <div className="page-section">
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'12px' }}>
            <h3 style={{ margin: 0 }}>🔢 Token 消费明细</h3>
            {log.length > 0 && (
              <button className="del-btn" onClick={()=>{ const c:any = { ...config, usage_log: [] }; setConfig(c); invoke("save_config", { config_json: JSON.stringify(c) }); }}>清空记录</button>
            )}
          </div>
          <div className="stat-cards">
            {[
              { l:'交互次数', v: log.length, c:'var(--brand-600)' },
              { l:'输入 tokens', v: sum.in, c:'#b45309' },
              { l:'输出 tokens', v: sum.out, c:'var(--ok-600)' },
              { l:'总计', v: sum.total, c:'#7c3aed' },
            ].map(x => (
              <div key={x.l} className="stat-card">
                <div className="label">{x.l}</div>
                <div className="value" style={{ color: x.c }}>{x.v.toLocaleString()}</div>
              </div>
            ))}
          </div>
          {log.length === 0 ? (
            <div className="empty-state" style={{ padding:'24px' }}>
              <div>暂无消费记录，开始对话后自动统计</div>
            </div>
          ) : (
            <div style={{ maxHeight:'220px', overflowY:'auto' }}>
              {log.slice(0, 30).map((e:any, i:number) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 12px', borderBottom:'1px solid var(--border-subtle)', fontSize:'12px' }}>
                  <div style={{ color:'var(--text-500)' }}>{new Date(e.t).toLocaleString()}</div>
                  <div style={{ color:'var(--text-700)', fontWeight:'500', flex:1, margin:'0 10px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{e.model}</div>
                  <div style={{ color:'var(--text-500)' }}>
                    ↑{e.in} ↓{e.out}{e.est ? ' ≈' : ''} · <b style={{ color:'#7c3aed' }}>{e.total}</b>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="page-section" style={{ borderBottom:'none' }}>
          <h3>ℹ️ 关于与更新</h3>
          <div style={{ fontSize: '12px', color: 'var(--text-500)', marginBottom: '10px' }}>
            当前版本 v{__APP_VERSION__} · 密钥已加密存储 (AES-256-GCM)
          </div>
          {updateInfo ? (
            <div className="update-card">
              <div className="update-title">🎉 发现新版本 v{updateInfo.version}</div>
              {updateInfo.notes && <div className="update-notes">{updateInfo.notes}</div>}
              <button onClick={installUpdate} disabled={updateState!=="idle"}>
                {updateState==="downloading" ? "⏬ 下载中..." : updateState==="installing" ? "⚙️ 安装中..." : "⬆️ 立即更新并重启"}
              </button>
            </div>
          ) : updateCheckState === "uptodate" ? (
            <div className="update-uptodate">
              <span>✅ 当前已是最新版本（v{__APP_VERSION__}）</span>
              <button className="btn btn-ghost" onClick={()=>checkForUpdates(false)}>🔄 重新检查</button>
            </div>
          ) : (
            <button className="btn btn-ghost" disabled={updateCheckState==="checking"} onClick={()=>checkForUpdates(false)}>
              {updateCheckState==="checking" ? "⏳ 正在检查..." : "🔍 检查更新"}
            </button>
          )}
        </div>
      </div>
    );
  };

  // ===== 移动端底部 Tab 栏 =====
  const renderMobileTabBar = () => (
    <div className="tab-bar">
      <button className={`tab-item${activeTab==='chat'?' active':''}`} onClick={()=>setActiveTab('chat')}>
        <span style={{ fontSize: '22px' }}>💬</span>
        <span>对话</span>
      </button>
      <button className={`tab-item${activeTab==='history'?' active':''}`} onClick={()=>setActiveTab('history')}>
        <span style={{ fontSize: '22px' }}>📜</span>
        <span>历史</span>
      </button>
      <button className={`tab-item${activeTab==='settings'?' active':''}`} onClick={()=>setActiveTab('settings')}>
        <span style={{ fontSize: '22px' }}>⚙️</span>
        <span>设置</span>
      </button>
    </div>
  );

  // ===== 主渲染 =====
  const layoutClass = `app ${isMobile ? 'app-mobile' : 'app-desktop'}`;

  return (
    <div className={layoutClass}>
      {/* 桌面端左侧栏（历史会话）*/}
      {!isMobile && (
        <aside className="sidebar" style={{ width: effectiveSidebarWidth }}>
          <div className="sidebar-header">
            <span>📜 历史</span>
          </div>
          <div className="sidebar-list">
            {renderSessionList()}
          </div>
        </aside>
      )}

      {/* 可拖拽分割条 */}
      {!isMobile && <div className="splitter" onMouseDown={onSplitterDown} />}

      {/* 中间主区域 */}
      <div className="main-area">
        {/* 顶栏：用户状态 + 按钮组 */}
        <header className="app-header">
          {renderHeader()}
        </header>

        {/* 对话 Tab 内容 */}
        {activeTab === 'chat' && (
          <div className="chat-container">
            {/* 模型工具栏（桌面端显示）*/}
            <div className="chat-toolbar">
              <span style={{ fontSize:'13px', color:'var(--text-500)', fontWeight:'500' }}>模型:</span>
              {renderModelPicker()}
              {!isMobile && (
                <button className="new-btn" onClick={newConversation}>➕ 新对话</button>
              )}
            </div>

            {/* 消息区 */}
            <div className="messages-wrap">
              {messages.length === 0 ? (
                <div className="empty-state">
                  <div className="emoji">💬</div>
                  <div>选择模型，开始对话！</div>
                </div>
              ) : messages.map((m, i) => renderMessageRow(m, i))}
              <div ref={messagesEndRef} />
            </div>

            {/* 输入区 */}
            {renderInputBar()}
          </div>
        )}

        {/* 历史 Tab（移动端）*/}
        {activeTab === 'history' && isMobile && (
          <div style={{ flex:1, overflowY:'auto', padding:'var(--space-3)' }}>
            {renderSessionList()}
          </div>
        )}

        {/* 设置 Tab */}
        {activeTab === 'settings' && renderSettings()}
      </div>

      {/* 移动端底部 Tab 栏 */}
      {isMobile && renderMobileTabBar()}

      {/* ===== 第三方 API 添加弹窗 ===== */}
      {showTpForm && (
        <div className="modal-mask" onClick={()=>setShowTpForm(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div style={{ textAlign:'center', marginBottom:'18px' }}>
              <div style={{ fontSize:'32px' }}>🟢</div>
              <h3>添加第三方 API</h3>
              <div style={{ fontSize:'12px', color:'var(--text-500)' }}>保存后将自动获取该 API 的可用模型列表</div>
            </div>
            {[
              { k:'name', ph:'API 别名（可选，如 OpenAI）', type:'text' },
              { k:'endpoint', ph:'Endpoint（如 https://api.openai.com）', type:'text' },
              { k:'api_key', ph:'API Key（sk-...）', type:'password' },
              { k:'model', ph:'默认模型（可选，留空自动获取）', type:'text' },
            ].map(f => (
              <input
                key={f.k}
                type={f.type}
                className="tp-input"
                value={(tpForm as any)[f.k]}
                placeholder={f.ph}
                onChange={e=>setTpForm({...tpForm, [f.k]: e.target.value})}
              />
            ))}
            <div style={{ display:'flex', gap:'10px', marginTop:'6px' }}>
              <button className="btn btn-big btn-ghost" style={{ flex:1 }} onClick={()=>setShowTpForm(false)}>取消</button>
              <button className="btn btn-big btn-primary" style={{ flex:1 }} onClick={saveTpApi} disabled={tpTesting}>
                {tpTesting ? "⏳ 获取模型中..." : "保存并获取模型"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 充值弹窗 ===== */}
      {showRecharge && (
        <div className="modal-mask" onClick={()=>setShowRecharge(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div style={{ textAlign:'center', marginBottom:'18px' }}>
              <div style={{ fontSize:'32px' }}>💵</div>
              <h3>账户充值</h3>
              <div style={{ fontSize:'13px', color:'var(--text-500)' }}>
                当前余额: <b style={{ color:'var(--brand-600)' }}>${Number(config.balance).toFixed(2)}</b>
              </div>
            </div>
            <input
              className="tp-input"
              value={voucherCode}
              onChange={e=>setVoucherCode(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&doRecharge()}
              placeholder="请输入充值卡密"
              autoFocus
            />
            <div className="recharge-hint">
              <span>🛒 购买卡密请联系微信: <b>xsirchats</b></span>
              <button className="btn btn-warn" onClick={()=>{navigator.clipboard.writeText("xsirchats"); alert("✅ 微信号已复制，去微信添加吧");}}>📋 复制</button>
            </div>
            <div style={{ display:'flex', gap:'10px' }}>
              <button className="btn btn-big btn-ghost" style={{ flex:1 }} onClick={()=>setShowRecharge(false)}>取消</button>
              <button className="btn btn-big btn-ok" style={{ flex:1 }} onClick={doRecharge} disabled={recharging}>
                {recharging ? "核销中..." : "确认充值"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 截图框选遮罩（快捷键触发）===== */}
      {cropImg && (
        <div className="crop-overlay" onMouseUp={endCrop}>
          <div className="crop-wrapper">
            <img
              ref={cropImgRef}
              src={cropImg}
              draggable={false}
              onMouseDown={e => {
                const r = e.currentTarget.getBoundingClientRect();
                dragStartRef.current = { x0: e.clientX - r.left, y0: e.clientY - r.top };
                setDragRect(null);
              }}
              onMouseMove={e => {
                if (!dragStartRef.current) return;
                const r = e.currentTarget.getBoundingClientRect();
                const cx = Math.max(0, Math.min(e.clientX - r.left, r.width));
                const cy = Math.max(0, Math.min(e.clientY - r.top, r.height));
                setDragRect({
                  x: Math.min(dragStartRef.current.x0, cx),
                  y: Math.min(dragStartRef.current.y0, cy),
                  w: Math.abs(cx - dragStartRef.current.x0),
                  h: Math.abs(cy - dragStartRef.current.y0)
                });
              }}
              onMouseUp={endCrop}
            />
            {dragRect && (
              <div
                className="crop-selection"
                style={{ left: dragRect.x, top: dragRect.y, width: dragRect.w, height: dragRect.h }}
              />
            )}
          </div>
          <div className="crop-instructions">
            🖥️ 拖拽框选截图区域 · 松开自动添加到输入框 · ESC 取消
          </div>
          <button className="crop-cancel" onClick={()=>{ setCropImg(null); setDragRect(null); }}>✕ 取消</button>
        </div>
      )}

      {/* ===== 应用内 Toast 通知（替代原生 alert，标题显示 Frapi AI 而非 tauri.localhost）===== */}
      {toast && (
        <div key={toast.id} className={`app-toast toast-${toast.type}`} onClick={()=>setToast(null)}>
          <span className="app-toast-title">Frapi AI</span>
          <span className="app-toast-msg">{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

export default App;
