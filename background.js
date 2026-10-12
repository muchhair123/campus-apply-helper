// background.js — service worker（MV3）
// 职责：点击工具栏图标时打开/关闭侧边栏；作为消息中枢（打开 options 页等）。
// 存储直接走 chrome.storage.local，content/options/popup 各自读写，无需经由此处中转。

// 注意：manifest 里配置了 default_popup，所以点击图标默认弹 popup。
// 侧边栏的开关由 popup 里的按钮通过消息触发（见下）。

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'OPEN_OPTIONS_WITH_DRAFT') {
    // 简历解析草稿：先存入 storage，再打开 options 页，options 读取后展示确认
    chrome.storage.local.set({ __resume_draft__: msg.draft || null }, () => {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
    });
    return true; // async
  }

  if (msg?.type === 'TOGGLE_SIDEBAR') {
    // 由 popup 发起：向当前活动标签页的 content script 转发切换指令
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse({ ok: false, error: 'no active tab' });
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' }, () => {
        // 忽略 content script 未注入的页面（如 chrome:// 页）
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true });
        }
      });
    });
    return true; // async
  }

  return false;
});
