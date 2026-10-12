// content.js — 页面注入侧边栏 + 执行填充 + 抓取投递信息
// manifest 已先加载 profile-schema.js、field-matcher.js，这里直接用全局 AH_SCHEMA / AH_Matcher。
// 存储直接走 chrome.storage.local（content 环境未加载 storage.js 封装）。

(function () {
  // 只在顶层 frame 注入侧边栏 UI；子 frame 仅参与填充（通过顶层调用其内元素，同源才行）
  const IS_TOP = window.top === window.self;
  let host = null; // Shadow host 元素
  let shadow = null;
  let lastPlan = null; // 最近一次填充计划（供回写用）

  // ---------- 存储读写 ----------
  function getProfile() {
    return new Promise((resolve) => {
      chrome.storage.local.get('profile', (res) => resolve((res && res.profile) || {}));
    });
  }
  function saveProfile(p) {
    return new Promise((resolve) => chrome.storage.local.set({ profile: p }, () => resolve(true)));
  }

  // 读自定义 schema 并与内置合并，返回有效 schema { groups, flatFields }
  function getEffective() {
    return new Promise((resolve) => {
      chrome.storage.local.get('customSchema', (res) => {
        resolve(AH_SCHEMA.buildEffective(res && res.customSchema ? res.customSchema : { groups: [] }));
      });
    });
  }
  // 仅要 flatFields 时的便捷包装（用于匹配/一键填写）
  async function getEffectiveFlatFields() {
    return (await getEffective()).flatFields;
  }

  // ---------- 填充单个元素（派发事件以兼容 Vue/React） ----------
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  // 异步轮询：等 predicate() 为真，最多 timeout 毫秒；超时返回 false
  function waitFor(predicate, timeout = 800, interval = 50) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        let ok = false;
        try { ok = predicate(); } catch (e) { ok = false; }
        if (ok) return resolve(true);
        if (Date.now() - t0 >= timeout) return resolve(false);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // 当前可见的 Element UI 下拉浮层选项（排除隐藏的、已销毁的）
  function visibleElOptions() {
    return Array.from(document.querySelectorAll('.el-select-dropdown__item'))
      .filter((o) => o.offsetParent !== null && !/is-disabled/.test(o.className));
  }

  // 安全自动点选 Element UI 下拉：匹配到唯一选项才点，歧义/零匹配一律放弃（返回 false 交回手选）
  async function fillElSelect(el, value) {
    const target = AH_Matcher.norm(value);
    if (!target) return false;
    try {
      // 1) 点击展开浮层（点 input 本身）
      el.scrollIntoView({ block: 'center' });
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.click();
      // 2) 等选项浮层渲染
      const appeared = await waitFor(() => visibleElOptions().length > 0, 900, 50);
      if (!appeared) return false;
      await sleep(60); // 让选项稳定
      const opts = visibleElOptions();

      // 3) 匹配：先完全相等，再「选项包含目标 / 目标包含选项」，收集候选
      const normed = opts.map((o) => ({ o, n: AH_Matcher.norm(o.textContent) })).filter((x) => x.n);
      let exact = normed.filter((x) => x.n === target);
      let candidates;
      if (exact.length === 1) candidates = exact;
      else if (exact.length > 1) candidates = []; // 多个完全相等（异常），放弃
      else {
        // 包含关系匹配（如 目标"硕士" ↔ 选项"硕士研究生"）
        const contains = normed.filter((x) => x.n.includes(target) || target.includes(x.n));
        candidates = contains;
      }

      // 4) 唯一候选才点；歧义（多候选）或零候选 → 收起浮层、放弃
      if (candidates.length === 1) {
        candidates[0].o.click();
        await sleep(40);
        return true;
      }
      // 放弃：按 ESC / 点别处收起浮层，避免挡住后续操作
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', keyCode: 27 }));
      document.body.click();
      return false;
    } catch (e) {
      try { document.body.click(); } catch (_) {}
      return false;
    }
  }

  async function fillElement(el, value) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    // Element UI / 组件化下拉：走异步安全点选
    if (AH_Matcher.isComponentSelect && AH_Matcher.isComponentSelect(el)) {
      return await fillElSelect(el, value);
    }

    if (tag === 'select') {
      // 选项文本/值模糊匹配
      const target = AH_Matcher.norm(value);
      let matched = null;
      if (target) {
        for (const opt of el.options) {
          const on = AH_Matcher.norm(opt.textContent) || AH_Matcher.norm(opt.value);
          if (!on) continue; // 跳过"请选择"等被归一化为空的占位项，避免空串被 includes 误匹配
          if (on === target || on.includes(target) || target.includes(on)) { matched = opt; break; }
        }
      }
      if (!matched) return false;
      el.value = matched.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (type === 'radio' || type === 'checkbox') {
      // 对同 name 的一组，匹配 value/邻近 label 文本
      const target = AH_Matcher.norm(value);
      const group = el.name ? document.getElementsByName(el.name) : [el];
      if (!target) return false;
      for (const r of group) {
        const lab = r.id ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`) : r.closest('label');
        const text = AH_Matcher.norm((lab && lab.textContent) || r.value);
        if (!text) continue;
        if (text === target || text.includes(target) || target.includes(text)) {
          r.checked = true;
          r.dispatchEvent(new Event('input', { bubbles: true }));
          r.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }

    // 普通 input / textarea
    el.focus();
    setNativeValue(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  // ---------- 执行一键填充 ----------
  async function runAutofill() {
    const profile = await getProfile();
    if (!profile || Object.keys(profile).length === 0) {
      return { filled: 0, needManual: [], error: 'empty_profile' };
    }
    // 收集本 frame + 同源子 frame 的元素，统一在顶层构建计划（含自定义字段）
    const effFields = await getEffectiveFlatFields();
    const plan = AH_Matcher.buildFillPlan(document, profile, effFields);
    const filledFields = [];
    const selectFailed = []; // 下拉没自动选上 → 回落手选（带建议值）
    const otherFailed = [];  // 普通字段写入失败
    // 顺序 await：下拉展开/收起不能并发，否则浮层互相干扰
    for (const item of plan.toFill) {
      let ok = false;
      try { ok = await fillElement(item.el, item.value); } catch (e) { ok = false; }
      if (ok) {
        filledFields.push({ label: item.label, isSelect: !!item.isSelect });
        flash(item.el, true);
      } else if (item.isSelect) {
        selectFailed.push({ label: item.label, suggest: item.value });
        flash(item.el, false);
      } else {
        otherFailed.push({ label: item.label });
        flash(item.el, false);
      }
    }
    lastPlan = plan;
    // 合并 needManual：原本信息库没值的 + 下拉没自动选上的
    const needManual = plan.needManual.map((x) => ({ fieldKey: x.fieldKey, groupKey: x.groupKey, label: x.label, reason: x.reason, suggest: x.suggest || '' }));
    for (const s of selectFailed) needManual.push({ label: s.label, reason: 'select', suggest: s.suggest });
    return {
      filled: filledFields.length,
      filledFields,
      needManual,
      failedSelect: otherFailed.map((x) => x.label),
    };
  }

  // 填充高亮反馈
  function flash(el, ok) {
    const old = el.style.boxShadow;
    el.style.transition = 'box-shadow .3s';
    el.style.boxShadow = ok ? '0 0 0 2px #22c55e' : '0 0 0 2px #f59e0b';
    setTimeout(() => { el.style.boxShadow = old; }, 1500);
  }

  // ---------- 回写：把当前页面上「需手动」字段用户填的新值存回信息库 ----------
  async function writeBackManual() {
    if (!lastPlan) return { saved: 0 };
    const profile = await getProfile();
    const effFields = await getEffectiveFlatFields();
    let saved = 0;
    for (const item of lastPlan.needManual) {
      const val = (item.el.value || '').trim();
      if (!val) continue;
      // 写回信息库（标量分组直接存；可重复分组写第 0 条）
      const field = effFields.find((f) => f.key === item.fieldKey && f.groupKey === item.groupKey);
      if (!field) continue;
      if (field.repeatable) {
        profile[item.groupKey] = profile[item.groupKey] || [{}];
        if (!profile[item.groupKey][0]) profile[item.groupKey][0] = {};
        profile[item.groupKey][0][item.fieldKey] = val;
      } else {
        profile[item.groupKey] = profile[item.groupKey] || {};
        profile[item.groupKey][item.fieldKey] = val;
      }
      saved++;
    }
    if (saved) await saveProfile(profile);
    return { saved };
  }

  // ---------- 回写（独立按钮）：扫描当前页所有 input，反查信息库字段并存回 ----------
  // 不依赖是否跑过一键填写；能对应到 schema 字段的才写，脏字段（银行专属等）跳过。
  // 取某个表单元素在页面上的标签文字（用于"未识别字段"展示 / 加入信息库时的字段名）
  function labelOfEl(el) {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && l.textContent.trim()) return l.textContent.trim(); }
    const fi = el.closest('.el-form-item,.ant-form-item,.form-item,.field,.form-group');
    if (fi) { const l = fi.querySelector('.el-form-item__label,.ant-form-item-label,label,.label'); if (l && l.textContent.trim()) return l.textContent.trim(); }
    return (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '').trim();
  }

  // 取某个表单元素所属"区块"的标题（用于自动识别该字段应归哪个信息库模块）
  function sectionTitleOfEl(el) {
    // 向上找带区块语义的祖先容器，取其内首个标题类节点的文字
    const containerSel = 'section,fieldset,[class*="section"],[class*="module"],[class*="block"],[class*="panel"],[class*="card"],[class*="form-group"]';
    let node = el;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      if (!node.matches || !node.matches(containerSel)) continue;
      const h = node.querySelector('h1,h2,h3,h4,legend,[class*="title"],[class*="header"]');
      if (h) {
        const t = (h.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 20) return t;
      }
    }
    // 退化：找前面最近的标题元素
    const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,legend,[class*="section-title"],[class*="form-title"]'));
    const rect = el.getBoundingClientRect();
    let best = null, bestTop = -Infinity;
    for (const h of heads) {
      const hr = h.getBoundingClientRect();
      if (hr.top <= rect.top && hr.top > bestTop) { bestTop = hr.top; best = h; }
    }
    if (best) { const t = (best.textContent || '').replace(/\s+/g, ' ').trim(); if (t && t.length <= 20) return t; }
    return '';
  }

  // 根据区块标题，在有效 schema 的模块里找最匹配的 groupKey（自动识别默认模块）
  function guessGroupKey(sectionTitle, groups) {
    const t = AH_Matcher.norm(sectionTitle);
    if (!t) return '';
    // 完全相等 > 包含关系
    let exact = groups.find((g) => AH_Matcher.norm(g.label) === t);
    if (exact) return exact.key;
    let contains = groups.find((g) => { const gl = AH_Matcher.norm(g.label); return gl && (t.includes(gl) || gl.includes(t)); });
    return contains ? contains.key : '';
  }

  async function writeBackPage() {
    const profile = await getProfile();
    const effRes = await getEffective(); // { groups, flatFields }
    const fields = effRes.flatFields;
    const elements = AH_Matcher.collectFormElements(document);
    const savedLabels = [];
    const unknown = []; // 未能对应到信息库任何字段的 → 回传供用户决定是否加入

    for (const el of elements) {
      const val = (el.value || '').trim();
      if (!val) continue;
      const m = AH_Matcher.matchElement(el, fields);
      const field = m && m.confidence >= AH_Matcher.MIN_CONFIDENCE
        ? fields.find((f) => f.key === m.fieldKey && f.groupKey === m.groupKey) : null;
      if (!field) {
        const lab = labelOfEl(el);
        if (lab && lab.length <= 30) {
          // 自动识别该字段所属区块 → 匹配信息库模块作默认
          const section = sectionTitleOfEl(el);
          const guessKey = guessGroupKey(section, effRes.groups);
          unknown.push({ label: lab, value: val, section, guessKey });
        }
        continue;
      }
      if (m.repeatable) {
        profile[m.groupKey] = Array.isArray(profile[m.groupKey]) && profile[m.groupKey].length ? profile[m.groupKey] : [{}];
        profile[m.groupKey][0][m.fieldKey] = val;
      } else {
        profile[m.groupKey] = profile[m.groupKey] || {};
        profile[m.groupKey][m.fieldKey] = val;
      }
      savedLabels.push(field.label);
    }
    if (savedLabels.length) await saveProfile(profile);
    return { saved: savedLabels.length, savedLabels, unknown };
  }

  // 把用户选中的"未识别字段"按各自选定的模块加入信息库并存值
  // picks: [{label, value, targetGroupKey}]
  //   targetGroupKey = 内置模块 key（挂载为该模块自定义字段）/ 自定义模块 key / '' 或 '__new__'（新建"其他补充信息"）
  async function addUnknownFieldsToProfile(picks) {
    const res = await new Promise((r) => chrome.storage.local.get(['customSchema', 'profile'], r));
    const cs = (res.customSchema && Array.isArray(res.customSchema.groups)) ? res.customSchema : { groups: [] };
    const profile = res.profile || {};
    const builtin = AH_SCHEMA.groups;
    const builtinMap = new Map(builtin.map((g) => [g.key, g]));
    let newGroupKey = null; // 本次新建的"其他补充信息"模块（多条未识别字段共用一个）
    const touchedLabels = [];

    // 在 customSchema 里找/建某 key 的组（用于挂载字段）。isBuiltinMount: 该 key 是内置模块
    function ensureCsGroup(key, label, repeatable) {
      let g = cs.groups.find((x) => x.key === key);
      if (!g) { g = { key, label, repeatable: !!repeatable, custom: true, fields: [] }; cs.groups.push(g); }
      return g;
    }

    for (const p of picks) {
      let key = p.targetGroupKey;
      let repeatable = false;
      if (!key || key === '__new__') {
        if (!newGroupKey) {
          const g = { key: 'custom_' + Date.now().toString(36) + Math.floor(Math.random() * 1e3), label: '其他补充信息', repeatable: false, custom: true, fields: [] };
          cs.groups.push(g); newGroupKey = g.key;
        }
        key = newGroupKey;
      }
      const builtinGroup = builtinMap.get(key);
      repeatable = builtinGroup ? !!builtinGroup.repeatable : !!(cs.groups.find((x) => x.key === key) || {}).repeatable;

      // 字段挂到 customSchema 对应组（内置 key 则建一个同 key 的挂载组）
      const csGroup = ensureCsGroup(key, builtinGroup ? builtinGroup.label : (cs.groups.find((x) => x.key === key) || {}).label || '其他补充信息', repeatable);
      let f = csGroup.fields.find((x) => x.label === p.label);
      if (!f) { f = { key: 'cf_' + Date.now().toString(36) + Math.floor(Math.random() * 1e3), label: p.label, type: 'text', custom: true, aliases: [p.label] }; csGroup.fields.push(f); }

      // 写值到 profile：多条模块写第 0 条，单条模块写对象
      if (repeatable) {
        profile[key] = Array.isArray(profile[key]) && profile[key].length ? profile[key] : [{}];
        profile[key][0][f.key] = p.value;
      } else {
        profile[key] = profile[key] || {};
        profile[key][f.key] = p.value;
      }
      touchedLabels.push(p.label);
    }
    await new Promise((r) => chrome.storage.local.set({ customSchema: cs, profile }, r));
    return { added: touchedLabels.length };
  }

  // ---------- 抓取当前页投递信息（半自动） ----------
  function guessApplicationInfo() {
    const title = document.title || '';
    // 公司名猜测：取 title 中第一段 / document 中常见公司字样
    let company = '';
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent.trim().length < 30) company = h1.textContent.trim();
    if (!company) company = title.split(/[-_|·—\s]+/)[0].slice(0, 20);
    return {
      company,
      position: '',
      url: location.href,
      note: title.slice(0, 60),
    };
  }

  async function recordApplication(info) {
    return new Promise((resolve) => {
      chrome.storage.local.get('applications', (res) => {
        const list = Array.isArray(res.applications) ? res.applications : [];
        const item = Object.assign(
          {
            id: 'app_' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
            company: '', position: '', date: new Date().toISOString().slice(0, 10),
            status: '已投递', url: '', note: '',
          },
          info
        );
        list.unshift(item);
        chrome.storage.local.set({ applications: list }, () => resolve(item));
      });
    });
  }

  // ================= 侧边栏 UI（仅顶层 frame） =================
  function buildSidebar() {
    if (host) return;
    host = document.createElement('div');
    host.id = '__ah_sidebar_host__';
    host.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; z-index: 2147483647;';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = SIDEBAR_HTML;
    bindSidebarEvents();
  }

  function toggleSidebar() {
    if (!IS_TOP) return;
    if (!host) buildSidebar();
    const panel = shadow.querySelector('.ah-panel');
    panel.classList.toggle('open');
  }

  function bindSidebarEvents() {
    const $ = (sel) => shadow.querySelector(sel);
    $('.ah-close').addEventListener('click', () => shadow.querySelector('.ah-panel').classList.remove('open'));

    $('.ah-fill').addEventListener('click', async () => {
      setResult('<div class="ah-loading">正在匹配并填充…</div>');
      const r = await runAutofill();
      if (r.error === 'empty_profile') {
        setResult('<div class="ah-warn">信息库还是空的。请先打开「个人信息库」填写或上传简历。</div>' +
          '<button class="ah-link" id="ah-open-options">打开信息库</button>');
        $('#ah-open-options').addEventListener('click', openOptions);
        return;
      }
      let html = `<div class="ah-ok">✓ 已自动填 ${r.filled} 个字段</div>`;
      if (r.filledFields && r.filledFields.length)
        html += `<div class="ah-list">${r.filledFields.map((f) => {
          const label = typeof f === 'string' ? f : f.label;
          const isSel = typeof f === 'object' && f.isSelect;
          return `<span class="ah-tag ok">${esc(label)}${isSel ? ' ▾' : ''}</span>`;
        }).join('')}</div>`;
      if (r.filledFields && r.filledFields.some((f) => typeof f === 'object' && f.isSelect))
        html += `<div class="ah-sub" style="color:#9a6700">▾ 为下拉自动选中项，请重点核对是否正确。</div>`;

      // 需手动的分两类：信息库没值的 / 组件化下拉需手选的
      const manual = (r.needManual || []);
      const selects = manual.filter((f) => f.reason === 'select');
      const empties = manual.filter((f) => f.reason !== 'select');
      if (empties.length) {
        html += `<div class="ah-sub">⚠ 这些字段信息库里没有，请在页面手填，再点下方「存回信息库」沉淀：</div>`;
        html += `<div class="ah-list">${empties.map((f) => `<span class="ah-tag warn">${esc(f.label)}</span>`).join('')}</div>`;
      }
      if (selects.length) {
        html += `<div class="ah-sub">⚠ 这些下拉/日期控件未能自动选上，需你手动选择${selects.some(s=>s.suggest)?'（括号内是信息库里的值，供参考）':''}：</div>`;
        html += `<div class="ah-list">${selects.map((f) => `<span class="ah-tag warn">${esc(f.label)}${f.suggest ? '（'+esc(f.suggest)+'）' : ''}</span>`).join('')}</div>`;
      }
      if (r.failedSelect && r.failedSelect.length)
        html += `<div class="ah-sub">以下未能写入，请手动处理：${r.failedSelect.join('、')}</div>`;

      html += `<button class="ah-btn ghost" id="ah-writeback" style="margin-top:10px">💾 把本页填写的内容存回信息库</button>`;
      setResult(html);
      bindWriteback($);
    });

    // 主面板独立「存回信息库」按钮（不依赖先点一键填写）
    $('.ah-writeback-main').addEventListener('click', async () => {
      setResult('<div class="ah-loading">正在扫描本页并存回…</div>');
      const res = await writeBackPage();
      renderWritebackResult($, res);
    });

    $('.ah-record').addEventListener('click', async () => {
      const info = guessApplicationInfo();
      setResult(`
        <div class="ah-sub">确认投递信息（可修改）：</div>
        <label class="ah-f">公司<input id="ah-r-company" value="${esc(info.company)}"></label>
        <label class="ah-f">岗位<input id="ah-r-position" value=""></label>
        <label class="ah-f">链接<input id="ah-r-url" value="${esc(info.url)}"></label>
        <button class="ah-btn" id="ah-r-save">保存投递记录</button>
      `);
      $('#ah-r-save').addEventListener('click', async () => {
        const rec = await recordApplication({
          company: $('#ah-r-company').value.trim(),
          position: $('#ah-r-position').value.trim(),
          url: $('#ah-r-url').value.trim(),
          note: info.note,
        });
        setResult(`<div class="ah-ok">✓ 已记录：${esc(rec.company || '(未命名)')} · ${esc(rec.position || '-')}</div>
          <button class="ah-link" id="ah-open-apps">查看全部投递记录</button>`);
        $('#ah-open-apps').addEventListener('click', openOptions);
      });
    });

    $('.ah-open-options').addEventListener('click', openOptions);

    function setResult(html) { $('.ah-result').innerHTML = html; }

    // 绑定结果区里的「存回信息库」按钮（一键填写结果区内的小按钮）
    function bindWriteback($$) {
      const wb = $$('#ah-writeback');
      if (!wb) return;
      wb.addEventListener('click', async () => {
        wb.disabled = true;
        wb.textContent = '正在存回…';
        const res = await writeBackPage();
        renderWritebackResult($, res);
      });
    }

    // 渲染「存回信息库」结果：已存回 + 未识别字段（可勾选加入信息库）
    async function renderWritebackResult($$, res) {
      let html = res.saved
        ? `<div class="ah-ok">✓ 已存回 ${res.saved} 个字段到信息库</div>
           <div class="ah-list">${res.savedLabels.map((l) => `<span class="ah-tag ok">${esc(l)}</span>`).join('')}</div>`
        : `<div class="ah-warn">没有识别到可直接存回的字段。</div>`;

      const unknown = res.unknown || [];
      if (unknown.length) {
        // 有效 schema 的所有模块（内置+自定义）作为"存到哪个模块"的选项
        const eff = await getEffective();
        const moduleOpts = (defKey) => eff.groups.map((g) =>
          `<option value="${esc(g.key)}" ${g.key === defKey ? 'selected' : ''}>${esc(g.label)}${g.custom ? '（自定义）' : ''}</option>`
        ).join('') + `<option value="__new__" ${!defKey ? 'selected' : ''}>+ 新建「其他补充信息」</option>`;

        html += `<div class="ah-sub">⚠ 这些字段信息库里没有。已按页面区块自动归类（可改），勾选后「加入信息库」：</div>`;
        html += `<div class="ah-unknown">${unknown.map((u, i) => `
          <div class="ah-uk-row">
            <label class="ah-ck"><input type="checkbox" class="ah-uk" data-i="${i}" checked> ${esc(u.label)}：<span class="ah-uv">${esc(u.value)}</span></label>
            <select class="ah-uk-target ah-sel2" data-i="${i}">${moduleOpts(u.guessKey)}</select>
          </div>`).join('')}</div>`;
        html += `<button class="ah-btn ghost" id="ah-uk-add">+ 加入信息库</button>`;
      }
      setResult(html);

      const addBtn = $$('#ah-uk-add');
      if (addBtn) addBtn.addEventListener('click', async () => {
        const picks = Array.from(shadow.querySelectorAll('.ah-uk')).filter((c) => c.checked).map((c) => {
          const i = +c.dataset.i;
          const sel = shadow.querySelector(`.ah-uk-target[data-i="${i}"]`);
          return { ...unknown[i], targetGroupKey: sel ? sel.value : '__new__' };
        });
        if (!picks.length) { addBtn.textContent = '请先勾选字段'; return; }
        addBtn.disabled = true; addBtn.textContent = '正在加入…';
        const r = await addUnknownFieldsToProfile(picks);
        addBtn.textContent = `✓ 已加入 ${r.added} 个字段到信息库`;
      });
    }
  }

  function openOptions() {
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  // ---------- 消息监听 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'TOGGLE_SIDEBAR') {
      toggleSidebar();
      sendResponse({ ok: true });
    }
    return false;
  });

  // ================= 侧边栏模板（含 scoped 样式，Shadow DOM 隔离） =================
  const SIDEBAR_HTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .ah-panel {
    position: fixed; top: 0; right: -340px; width: 320px; height: 100vh;
    background: #fff; box-shadow: -2px 0 16px rgba(0,0,0,.12);
    transition: right .25s ease; display: flex; flex-direction: column;
    font-size: 13px; color: #1f2937;
  }
  .ah-panel.open { right: 0; }
  .ah-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: #2563eb; color: #fff; }
  .ah-head .t { font-weight: 600; font-size: 14px; }
  .ah-close { background: none; border: none; color: #fff; font-size: 18px; cursor: pointer; line-height: 1; }
  .ah-body { padding: 16px; overflow-y: auto; flex: 1; }
  .ah-btn { width: 100%; padding: 10px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; margin-bottom: 10px; }
  .ah-fill { background: #2563eb; color: #fff; font-weight: 600; }
  .ah-fill:hover { background: #1d4ed8; }
  .ah-record { background: #16a34a; color: #fff; }
  .ah-record:hover { background: #15803d; }
  .ah-btn.ghost { background: #f3f4f6; color: #1f2937; border: 1px solid #e5e7eb; }
  .ah-open-options { background: none; border: 1px solid #e5e7eb; color: #6b7280; }
  .ah-result { margin-top: 12px; }
  .ah-ok { color: #16a34a; font-weight: 600; margin-bottom: 8px; }
  .ah-warn { color: #b45309; background: #fffbeb; border: 1px solid #fde68a; padding: 8px 10px; border-radius: 6px; margin-bottom: 8px; }
  .ah-sub { color: #6b7280; margin: 10px 0 6px; font-size: 12px; }
  .ah-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .ah-tag { padding: 2px 8px; border-radius: 999px; font-size: 11px; }
  .ah-tag.ok { background: #dcfce7; color: #166534; }
  .ah-tag.warn { background: #fef3c7; color: #92400e; }
  .ah-loading { color: #6b7280; }
  .ah-link { background: none; border: none; color: #2563eb; cursor: pointer; font-size: 12px; text-decoration: underline; padding: 4px 0; }
  .ah-f { display: block; margin-bottom: 8px; font-size: 12px; color: #6b7280; }
  .ah-f input { display: block; width: 100%; padding: 7px 9px; border: 1px solid #e5e7eb; border-radius: 6px; margin-top: 3px; font-size: 13px; color: #1f2937; }
  .ah-foot { padding: 10px 16px; border-top: 1px solid #f0f0f0; }
  .ah-unknown { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .ah-ck { font-size: 12px; color: #1f2937; display: flex; align-items: center; gap: 4px; }
  .ah-uv { color: #2563eb; }
  .ah-sel { width: 100%; padding: 7px 9px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; margin-bottom: 8px; }
  .ah-uk-row { display: flex; flex-direction: column; gap: 3px; padding: 6px 0; border-bottom: 1px solid #f3f4f6; }
  .ah-sel2 { width: 100%; padding: 5px 8px; border: 1px solid #e5e7eb; border-radius: 5px; font-size: 12px; }
</style>
<div class="ah-panel">
  <div class="ah-head">
    <span class="t">📝 校招网申助手</span>
    <button class="ah-close" title="收起">×</button>
  </div>
  <div class="ah-body">
    <button class="ah-btn ah-fill">⚡ 一键填写当前页面</button>
    <button class="ah-btn ah-writeback-main ghost">💾 把本页填写存回信息库</button>
    <button class="ah-btn ah-record">＋ 记录本次投递</button>
    <div class="ah-result"></div>
  </div>
  <div class="ah-foot">
    <button class="ah-btn ah-open-options ghost" style="margin:0">管理信息库 / 投递记录</button>
  </div>
</div>`;
})();
