// background.js

const DEFAULT_CONFIG = {
  barkKey: "",
  whitelist: [],
  dedupWindowMs: 5000,
  rateLimitPerMin: 60,
  retryIntervalMs: 5000,
  maxRetries: 3
};

let config = Object.assign({}, DEFAULT_CONFIG);
let recentMap = new Map();
let sendTimestamps = [];
let retryQueue = [];
let isSending = false;
let tokenMap = {}; // token -> username 映射表

// ------------------ 读取 token2username.txt ------------------
async function loadTokenMap() {
  try {
    const url = (typeof browser !== "undefined"
      ? browser.runtime.getURL("token2username.txt")
      : chrome.runtime.getURL("token2username.txt"));

    console.log("🔍 尝试加载映射文件:", url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    tokenMap = {};
    for (const line of lines) {
      const [token, username] = line.split("----").map(s => s.trim());
      if (token && username) tokenMap[token] = username;
    }
    console.log("✅ token2username map loaded:", tokenMap);
  } catch (e) {
    console.error("❌ Failed to load token2username.txt:", e);
    tokenMap = {};
  }
}

// 初次加载
loadTokenMap();

// 每 30 秒自动重新加载映射文件
setInterval(loadTokenMap, 5000);

// ------------------ 配置加载 ------------------
function loadConfig() {
  if (typeof browser !== "undefined" && browser.storage) {
    browser.storage.local.get(DEFAULT_CONFIG).then(res => {
      config = Object.assign({}, DEFAULT_CONFIG, res);
      console.log("⚙️ BarkForwarder config loaded:", config);
    }).catch(err => {
      console.error("loadConfig error", err);
      config = Object.assign({}, DEFAULT_CONFIG);
    });
  } else if (typeof chrome !== "undefined" && chrome.storage) {
    chrome.storage.local.get(DEFAULT_CONFIG, res => {
      config = Object.assign({}, DEFAULT_CONFIG, res || {});
      console.log("⚙️ BarkForwarder config loaded (chrome):", config);
    });
  } else {
    config = Object.assign({}, DEFAULT_CONFIG);
  }
}
loadConfig();

// ------------------ storage 变化监听 ------------------
if (typeof browser !== "undefined" && browser.storage) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') loadConfig();
  });
} else if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') loadConfig();
  });
}

// ------------------ 去重与速率限制 ------------------
function cleanRecent() {
  const now = Date.now();
  for (const [k, t] of recentMap.entries()) if (now - t > config.dedupWindowMs) recentMap.delete(k);
}
function allowSend() {
  const now = Date.now();
  sendTimestamps = sendTimestamps.filter(ts => now - ts <= 60 * 1000);
  return sendTimestamps.length < config.rateLimitPerMin;
}
function recordSend() { sendTimestamps.push(Date.now()); }
function isWhitelisted(url) {
  if (!config.whitelist || config.whitelist.length === 0) return true;
  try {
    const u = new URL(url);
    const host = u.hostname;
    return config.whitelist.some(pattern => pattern.startsWith("*.") ? host.endsWith(pattern.slice(2)) : host === pattern);
  } catch (e) { return false; }
}

// ------------------ Bark 推送 ------------------
async function sendToBark(title, body) {
  if (!config.barkKey) {
    console.warn("🚫 Bark Key 未配置，跳过发送");
    return { ok: false, code: "no_key" };
  }
  const safeTitle = encodeURIComponent(title || "消息");
  const safeBody = encodeURIComponent(body || "");
  const url = `https://api.day.app/${config.barkKey}/${safeTitle}/${safeBody}`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      console.error("Bark 返回非 200:", res.status);
      return { ok: false, code: res.status };
    }
    recordSend();
    return { ok: true };
  } catch (e) {
    console.error("Bark 发送异常:", e);
    return { ok: false, code: "fetch_error", err: String(e) };
  }
}

// ------------------ 重试队列 ------------------
function enqueueRetry(item) { retryQueue.push(item); }
function processRetryQueue() {
  if (isSending) return;
  isSending = true;
  const now = Date.now();
  let due = retryQueue.filter(it => it.nextTryAt <= now);
  retryQueue = retryQueue.filter(it => it.nextTryAt > now);
  (async () => {
    for (const it of due) {
      if (it.tries >= config.maxRetries) {
        console.warn("达到最大重试次数，丢弃:", it.key);
        continue;
      }
      const res = await sendToBark(it.title, it.body);
      if (!res.ok) {
        it.tries = (it.tries || 0) + 1;
        it.nextTryAt = Date.now() + config.retryIntervalMs;
        retryQueue.push(it);
      } else console.log("重试发送成功:", it.key);
    }
    isSending = false;
  })().catch(err => { console.error("processRetryQueue error", err); isSending = false; });
}
setInterval(processRetryQueue, Math.max(1000, Math.floor(config.retryIntervalMs || 5000)));

// ------------------ 消息处理 ------------------
function handleForwardNotification(payload) {
  try {
    if (!payload || !payload.title) return;
    if (!isWhitelisted(payload.url)) {
      console.debug("非白名单域名，忽略:", payload.url);
      return;
    }

    cleanRecent();
    const key = `${payload.title}||${payload.body}||${payload.tag}`;
    if (recentMap.has(key)) {
      console.debug("重复通知（去重）:", key);
      return;
    }
    if (!allowSend()) {
      console.warn("速率限制触发，忽略本次发送");
      return;
    }
    recentMap.set(key, Date.now());

    // --- 解析 URL 得到 token 并映射 username ---
    let accountToken = null;
    try {
      const u = new URL(payload.url);
      const spm = u.searchParams.get("spm"); // 例如 a21ybx.home.sidebar.2.4c053da6KgUf2F
      if (spm) accountToken = spm.split(".").pop();
    } catch (e) { }
    const username = (accountToken && tokenMap[accountToken]) ? tokenMap[accountToken] : "未知账号";

    console.log("🔎 解析到 token:", accountToken, "→ username:", username);

    // 组织发送内容
    const composed = `接收人: ${username}\n消息内容: ${payload.body}\n\n来源: ${payload.url}\n时间: ${new Date(payload.timestamp).toLocaleString()}`;

    (async () => {
      const res = await sendToBark(payload.title, composed);
      if (!res.ok) {
        console.warn("首次发送失败，加入重试队列:", res);
        enqueueRetry({ title: payload.title, body: composed, key, tries: 0, nextTryAt: Date.now() + config.retryIntervalMs });
      } else {
        console.log("✅ 发送成功:", payload.title, "接收人:", username);
      }
    })();

  } catch (e) { console.error("handleForwardNotification error", e); }
}

// ------------------ runtime 消息监听 ------------------
if (typeof browser !== "undefined" && browser.runtime && browser.runtime.onMessage) {
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.action === "forward_notification" && msg.payload) handleForwardNotification(msg.payload);
    else if (msg && msg.action === "get_status") return { config, queueLen: retryQueue.length };
  });
} else if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === "forward_notification" && msg.payload) handleForwardNotification(msg.payload);
    else if (msg && msg.action === "get_status") sendResponse({ config, queueLen: retryQueue.length });
  });
}
