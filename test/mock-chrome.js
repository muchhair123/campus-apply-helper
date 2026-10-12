// 测试用：在普通网页环境模拟 chrome.storage.local / chrome.runtime
// 仅供 test/*.html 本地验证 UI，不打包进插件。
(function () {
  const store = {};
  window.chrome = window.chrome || {};
  chrome.storage = {
    local: {
      get(keys, cb) {
        const out = {};
        if (keys == null) Object.assign(out, store);
        else if (typeof keys === 'string') out[keys] = store[keys];
        else if (Array.isArray(keys)) keys.forEach((k) => (out[k] = store[k]));
        else Object.keys(keys).forEach((k) => (out[k] = store[k] !== undefined ? store[k] : keys[k]));
        setTimeout(() => cb(out), 0);
      },
      set(obj, cb) {
        Object.assign(store, obj);
        setTimeout(() => cb && cb(), 0);
      },
      remove(key, cb) {
        delete store[key];
        setTimeout(() => cb && cb(), 0);
      },
    },
  };
  const __listeners = [];
  chrome.runtime = {
    sendMessage: (msg, cb) => setTimeout(() => cb && cb({ ok: true }), 0),
    openOptionsPage: () => console.log('[mock] openOptionsPage'),
    getURL: (p) => p,
    onMessage: { addListener: (fn) => __listeners.push(fn) },
    lastError: null,
  };
  // 测试辅助：模拟向 content script 派发一条消息
  window.__dispatchMessage = (msg) => {
    __listeners.forEach((fn) => fn(msg, {}, () => {}));
  };
  chrome.tabs = {
    query: (q, cb) => cb([{ id: 1, url: 'https://example.com' }]),
    create: (o) => console.log('[mock] tabs.create', o),
    sendMessage: (id, msg, cb) => cb && cb({ ok: true }),
  };
})();
