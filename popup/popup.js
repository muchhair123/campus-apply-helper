// popup.js — 工具栏弹窗逻辑
const $ = (id) => document.getElementById(id);

function setHint(text, isError) {
  const el = $('hint');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

$('btn-sidebar').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'TOGGLE_SIDEBAR' }, (res) => {
    if (res && res.ok) {
      window.close();
    } else {
      setHint('当前页面无法注入侧边栏（如浏览器内置页、应用商店页）。请在正常网页上使用。', true);
    }
  });
});

$('btn-profile').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }, () => window.close());
});

$('btn-apps').addEventListener('click', () => {
  // options 页通过 hash 定位到投递记录 tab
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#applications') });
  window.close();
});

// 填充统计数字
(async function initStats() {
  try {
    const profile = await AHStorage.getProfile();
    const apps = await AHStorage.getApplications();
    // 粗略统计信息库里已填的标量字段数
    let filled = 0;
    const countObj = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) v.forEach(countObj);
        else if (v && typeof v === 'object') countObj(v);
        else if (v !== undefined && v !== null && String(v).trim() !== '') filled++;
      }
    };
    countObj(profile);
    $('stat-filled').textContent = filled;
    $('stat-apps').textContent = apps.length;
  } catch (e) {
    setHint('读取数据失败：' + e.message, true);
  }
})();
