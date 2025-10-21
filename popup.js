// popup.js
const DEFAULT = {
  barkKey: "",
  whitelist: [],
  dedupWindowMs: 5000,
  rateLimitPerMin: 60,
  retryIntervalMs: 5000,
  maxRetries: 3
};

const storage = (typeof browser !== 'undefined' && browser.storage) ? browser.storage.local : chrome.storage.local;

function load() {
  if (storage.get.length === 1) {
    storage.get(DEFAULT).then(res => fill(res));
  } else {
    storage.get(DEFAULT, res => fill(res));
  }
}
function fill(res) {
  res = res || DEFAULT;
  document.getElementById('barkKey').value = res.barkKey || "";
  document.getElementById('whitelist').value = (res.whitelist || []).join("\n");
  document.getElementById('dedup').value = res.dedupWindowMs || 5000;
  document.getElementById('rate').value = res.rateLimitPerMin || 60;
  document.getElementById('retry').value = res.retryIntervalMs || 5000;
  document.getElementById('maxRetries').value = res.maxRetries || 3;
}

function save() {
  const cfg = {
    barkKey: document.getElementById('barkKey').value.trim(),
    whitelist: document.getElementById('whitelist').value.split("\n").map(s => s.trim()).filter(Boolean),
    dedupWindowMs: Number(document.getElementById('dedup').value) || 5000,
    rateLimitPerMin: Number(document.getElementById('rate').value) || 60,
    retryIntervalMs: Number(document.getElementById('retry').value) || 5000,
    maxRetries: Number(document.getElementById('maxRetries').value) || 3
  };

  if (typeof browser !== 'undefined' && browser.storage) {
    browser.storage.local.set(cfg).then(() => show("已保存")).catch(e => show("保存失败: " + e));
  } else if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.set(cfg, () => {
      if (chrome.runtime.lastError) show("保存失败: " + chrome.runtime.lastError.message);
      else show("已保存");
    });
  } else show("浏览器不支持 storage API");
}

function show(s) {
  document.getElementById('msg').innerText = s;
  setTimeout(() => { document.getElementById('msg').innerText = ""; }, 3000);
}

document.getElementById('save').addEventListener('click', save);
load();
