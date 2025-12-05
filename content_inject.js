// content_inject.js
(function() {
  // ---------------- A: 注入页面上下文脚本（覆盖 window.Notification） ----------------
  const injectedCode = `
    (function() {
      try {
        if (window.__BARK_NOTIFICATION_HOOKED__) return;
        window.__BARK_NOTIFICATION_HOOKED__ = true;

        const OriginalNotification = window.Notification;

        function safeString(v) {
          try { return String(v || ""); } catch(e) { return ""; }
        }

        window.Notification = function(title, options) {
          try {
            const body = options && options.body ? options.body : "";
            const tag = options && options.tag ? options.tag : "";
            const renotify = options && options.renotify ? options.renotify : false;
            const icon = options && options.icon ? options.icon : "";
            // 向页面 postMessage，content script 会监听到
            window.postMessage({
              __fromBarkExtension: true,
              title: safeString(title),
              body: safeString(body),
              tag: safeString(tag),
              renotify: renotify,
              icon: safeString(icon),
              timestamp: Date.now(),
              url: location.href
            }, "*");
          } catch (e) {
            console && console.error && console.error("BarkHook capture error:", e);
          }
          // 保持页面通知的正常显示
          return new OriginalNotification(title, options);
        };

        // 保留静态属性与方法
        try {
          window.Notification.permission = OriginalNotification.permission;
          if (OriginalNotification.requestPermission) {
            window.Notification.requestPermission = OriginalNotification.requestPermission.bind(OriginalNotification);
          }
        } catch(e){}
      } catch (err) {
        console && console.error && console.error("injected bark hook failed:", err);
      }
    })();
  `;
  const script = document.createElement('script');
  script.textContent = injectedCode;
  (document.head || document.documentElement).appendChild(script);
  script.parentNode && script.parentNode.removeChild(script);

  // ---------------- B: content script（隔离上下文）监听并转发 ----------------
  window.addEventListener("message", function(event) {
    const data = event.data;
    if (!data || !data.__fromBarkExtension) return;

    // 这里允许 content script 进行一些过滤（例如只对白名单域名转发）
    // 我们直接转发到 extension 背景脚本
    try {
      // debug 输出（可在 about:debugging 的 content script 控制台看到）
      console.debug("content_script 收到通知消息:", data);
    } catch(e){}

    try {
      if (typeof browser !== "undefined" && browser.runtime && browser.runtime.sendMessage) {
        browser.runtime.sendMessage({ action: "forward_notification", payload: data });
      } else if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ action: "forward_notification", payload: data });
      } else {
        console.warn("runtime API not available to send message");
      }
    } catch (e) {
      // 双重保险
      try { chrome.runtime.sendMessage({ action: "forward_notification", payload: data }); } catch(err) {}
      try { browser && browser.runtime && browser.runtime.sendMessage({ action: "forward_notification", payload: data }); } catch(err) {}
    }
  }, false);

})();
