// background.js
const DEFAULT_CONFIG = {
  barkKey: "",                // 用户在 popup 填写
  whitelist: [],              // 可填写域名列表，空数组表示允许所有域名
  dedupWindowMs: 5000,        // 去重窗口：5 秒内相同 key 不重复发送
  rateLimitPerMin: 60,        // 每分钟最多发送次数
  retryIntervalMs: 5000,      // 发送失败后的重试间隔
  maxRetries: 3               // 最大重试次数
};

let config = Object.assign({}, DEFAULT_CONFIG);
let recentMap = new Map();      // key -> timestamp
let sendTimestamps = [];        // timestamps for rate limiting (ms)
let retryQueue = [];            // [{title, body, key, tries, nextTryAt}, ...]
let isSending = false;

// helper: load config from storage
function loadConfig() {
  if (typeof browser !== "undefined" && browser.storage) {
    browser.storage.local.get(DEFAULT_CONFIG).then(res => {
      config = Object.assign({}, DEFAULT_CONFIG, res);
      console.log("BarkForwarder config loaded:", config);
    }).catch(err => {
      console.error("loadConfig error", err);
      config = Object.assign({}, DEFAULT_CONFIG);
    });
  } else if (typeof chrome !== "undefined" && chrome.storage) {
    chrome.storage.local.get(DEFAULT_CONFIG, res => {
      config = Object.assign({}, DEFAULT_CONFIG, res || {});
      console.log("BarkForwarder config loaded (chrome):", config);
    });
  } else {
    config = Object.assign({}, DEFAULT_CONFIG);
  }
}
loadConfig();

// storage change listener
if (typeof browser !== "undefined" && browser.storage) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') loadConfig();
  });
} else if (typeof chrome !== "undefined" && chrome.storage) {
  chrome.storage.onChanged && chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') loadConfig();
  });
}

// 清理过期去重项
function cleanRecent() {
  const now = Date.now();
  for (const [k, t] of recentMap.entries()) {
    if (now - t > config.dedupWindowMs) recentMap.delete(k);
  }
}

// 速率限制判断
function allowSend() {
  const now = Date.now();
  // 保留最近 60s 内的记录
  sendTimestamps = sendTimestamps.filter(ts => now - ts <= 60*1000);
  return sendTimestamps.length < config.rateLimitPerMin;
}
function recordSend() {
  sendTimestamps.push(Date.now());
}

// 简单域名白名单检查（如果 whitelist 非空则只允许其中域名）
function isWhitelisted(url) {
  if (!config.whitelist || config.whitelist.length === 0) return true;
  try {
    const u = new URL(url);
    const host = u.hostname;
    return config.whitelist.some(pattern => {
      // pattern 可以是 example.com 或 *.example.com
      if (pattern.startsWith("*.") && host.endsWith(pattern.slice(2))) return true;
      return host === pattern;
    });
  } catch(e) {
    return false;
  }
}

// 发送到 Bark（HTTP GET）
async function sendToBark(title, body) {
  if (!config.barkKey) {
    console.warn("Bark Key 未配置，跳过发送");
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

// 入队重试
function enqueueRetry(item) {
  retryQueue.push(item);
}

// 触发重试队列处理
function processRetryQueue() {
  if (isSending) return;
  isSending = true;
  const now = Date.now();
  // filter items that are due
  let due = retryQueue.filter(it => it.nextTryAt <= now);
  // update queue to only future ones
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
      } else {
        console.log("重试发送成功:", it.key);
      }
    }
    isSending = false;
  })().catch(err => {
    console.error("processRetryQueue error", err);
    isSending = false;
  });
}

// 定时触发重试
setInterval(processRetryQueue, Math.max(1000, Math.floor(config.retryIntervalMs || 5000)));

// 处理来自 content script 的消息
function handleForwardNotification(payload) {
  try {
    if (!payload || !payload.title) return;
    // 白名单过滤
    if (!isWhitelisted(payload.url)) {
      console.debug("非白名单域名，忽略:", payload.url);
      return;
    }

    const key = `${payload.title}||${payload.body}||${payload.tag}`;
    cleanRecent();
    if (recentMap.has(key)) {
      console.debug("重复通知（去重）:", key);
      return;
    }
    if (!allowSend()) {
      console.warn("速率限制触发，忽略本次发送");
      return;
    }
    recentMap.set(key, Date.now());

    // 组织发送内容（可自定义）
    const composed = `${payload.body}\n\n来源: ${payload.url}\n时间: ${new Date(payload.timestamp).toLocaleString()}`;

    // 尝试发送
    (async () => {
      const res = await sendToBark(payload.title, composed);
      if (!res.ok) {
        // 入队重试
        console.warn("首次发送失败，加入重试队列:", res);
        enqueueRetry({
          title: payload.title,
          body: composed,
          key,
          tries: 0,
          nextTryAt: Date.now() + config.retryIntervalMs
        });
      } else {
        console.log("发送成功:", payload.title);
      }
    })();

  } catch (e) {
    console.error("handleForwardNotification error", e);
  }
}

// 监听 runtime 消息
if (typeof browser !== "undefined" && browser.runtime && browser.runtime.onMessage) {
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.action === "forward_notification" && msg.payload) {
      handleForwardNotification(msg.payload);
    }
  });
} else if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === "forward_notification" && msg.payload) {
      handleForwardNotification(msg.payload);
    }
  });
}

// 导出一个用于 popup 查询状态的小接口（可选）
if (typeof browser !== "undefined" && browser.runtime && browser.runtime.onMessage) {
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === "get_status") {
      sendResponse({ config, queueLen: retryQueue.length });
    }
  });
} else if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === "get_status") {
      sendResponse({ config, queueLen: retryQueue.length });
    }
  });
}
