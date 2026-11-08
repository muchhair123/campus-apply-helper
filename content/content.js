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

  // 读 AI 接口配置（content 环境未加载 storage.js，直接读 chrome.storage.local）
  function getLLMConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get('llmConfig', (res) => {
        resolve((res && res.llmConfig) || { baseUrl: '', apiKey: '', model: '', enabled: false });
      });
    });
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
  // 执行一个填充计划（一键填写 / 选区填写共用）。返回结果汇总。
  async function applyPlan(plan) {
    const filledFields = [];
    const selectFailed = []; // 下拉没自动选上 → 回落手选（带建议值）
    const otherFailed = [];  // 普通字段写入失败
    // 顺序 await：下拉展开/收起不能并发，否则浮层互相干扰
    for (const item of plan.toFill) {
      let ok = false;
      try { ok = await fillElement(item.el, item.value); } catch (e) { ok = false; }
      if (ok) {
        filledFields.push({ label: item.label, value: item.value, isSelect: !!item.isSelect });
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

  async function runAutofill() {
    const profile = await getProfile();
    if (!profile || Object.keys(profile).length === 0) {
      return { filled: 0, needManual: [], error: 'empty_profile' };
    }
    // 收集本 frame + 同源子 frame 的元素，统一在顶层构建计划（含自定义字段）
    const effFields = await getEffectiveFlatFields();
    const plan = AH_Matcher.buildFillPlan(document, profile, effFields);
    return await applyPlan(plan);
  }

  // 在指定根元素范围内填充（选区填写用）
  async function runAutofillInScope(scope) {
    const profile = await getProfile();
    if (!profile || Object.keys(profile).length === 0) {
      return { filled: 0, needManual: [], error: 'empty_profile' };
    }
    const effFields = await getEffectiveFlatFields();
    const plan = AH_Matcher.buildFillPlan(scope, profile, effFields);
    return await applyPlan(plan);
  }

  // 取元素的「最佳标签」用于发给 AI（权重最高的线索；退回 placeholder/name）
  function bestLabelOf(el) {
    try {
      const clues = AH_Matcher.collectClues(el);
      if (clues && clues.length) {
        const top = clues.slice().sort((a, b) => b.weight - a.weight)[0];
        if (top && top.n) return top.n;
      }
    } catch (e) { /* ignore */ }
    return el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '';
  }

  // 从 profile 按 "group.field" 取值（标量取对象字段；可重复取第 0 条）
  function profileValueByKey(profile, groups, fullKey) {
    const [gk, fk] = String(fullKey).split('.');
    if (!gk || !fk) return '';
    const g = groups.find((x) => x.key === gk);
    const data = profile[gk];
    if (!data) return '';
    if (g && g.repeatable) {
      if (Array.isArray(data) && data[0]) return data[0][fk] || '';
      return '';
    }
    return data[fk] || '';
  }

  // AI 辅助填写：先跑启发式普通填充，剩余未匹配字段交给 LLM 语义对齐。
  // 只把字段「标签」发给模型，绝不发送任何值。scope 默认整页。
  async function runAIAutofill(scope) {
    const root = scope || document;
    const profile = await getProfile();
    if (!profile || Object.keys(profile).length === 0) return { error: 'empty_profile' };

    const cfg = await getLLMConfig();
    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) return { error: 'no_llm_config' };

    const eff = await getEffective();
    const effFields = eff.flatFields;

    // 1) 先跑普通填充
    const plan = AH_Matcher.buildFillPlan(root, profile, effFields);
    const baseResult = await applyPlan(plan);
    const filledEls = new Set(plan.toFill.map((t) => t.el));

    // 2) 收集剩余「未匹配/低置信」元素
    const remaining = AH_Matcher.collectFormElements(root).filter((el) => {
      if (filledEls.has(el)) return false;
      const m = AH_Matcher.matchElement(el, effFields);
      return !m || m.confidence < AH_Matcher.MIN_CONFIDENCE;
    });

    if (!remaining.length) return { base: baseResult, aiFilled: 0, aiFields: [] };

    // 3) 构造 pageFields（只含标签）+ schemaFields（只含字段名），发 LLM
    const idMap = new Map();
    const pageFields = [];
    remaining.forEach((el, i) => {
      const id = 'p' + i;
      el.dataset.__ahId = id;
      idMap.set(id, el);
      const label = bestLabelOf(el);
      if (label) pageFields.push({ id, label });
    });
    if (!pageFields.length) return { base: baseResult, aiFilled: 0, aiFields: [] };

    const schemaFields = effFields.map((f) => ({ key: f.groupKey + '.' + f.key, label: f.label }));

    let mappings;
    try {
      mappings = await AH_AI.matchByLLM(pageFields, schemaFields, cfg);
    } catch (e) {
      return { base: baseResult, aiError: e.message };
    }

    // 4) 按映射取值并填充（有值才填）
    const aiFields = [];
    for (const mp of mappings) {
      const el = idMap.get(mp.pageId);
      if (!el) continue;
      const value = profileValueByKey(profile, eff.groups, mp.fieldKey);
      if (!value || !String(value).trim()) continue;
      let ok = false;
      try { ok = await fillElement(el, value); } catch (e) { ok = false; }
      if (ok) {
        const fd = effFields.find((f) => f.groupKey + '.' + f.key === mp.fieldKey);
        aiFields.push({ label: fd ? fd.label : mp.fieldKey, value });
        flash(el, true);
      }
    }
    return { base: baseResult, aiFilled: aiFields.length, aiFields };
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

  // ================= 选区填写：框选页面某容器，只在该区域内填充 =================
  let selState = null; // { overlay, hint, target, onMove, onClick, onKey }

  // 找光标下「最近的、内部含可填表单元素的」容器
  function nearestFormContainer(x, y) {
    let el = document.elementFromPoint(x, y);
    if (!el) return null;
    // 跳过侧边栏自身
    if (host && (el === host || host.contains(el) || el.getRootNode() === shadow)) return null;
    // 候选容器选择器（从具体到宽泛）
    const SELS = 'form,fieldset,section,table,.el-form,.ant-form,[class*="form"],[class*="card"],[class*="panel"],[class*="section"]';
    let node = el.closest(SELS);
    // 逐级向上，找到「内部确有可填元素」的容器；最多上溯 6 层
    let hops = 0;
    while (node && hops < 6) {
      if (AH_Matcher.collectFormElements(node).length > 0) return node;
      node = node.parentElement ? node.parentElement.closest(SELS) : null;
      hops++;
    }
    // 兜底：光标元素自身所在的、含表单元素的最近块级祖先
    node = el;
    hops = 0;
    while (node && node !== document.body && hops < 8) {
      if (node.querySelectorAll && AH_Matcher.collectFormElements(node).length > 0) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 60 && rect.height > 30) return node;
      }
      node = node.parentElement; hops++;
    }
    return null;
  }

  function positionOverlay(overlay, el) {
    const r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = r.top + 'px';
    overlay.style.left = r.left + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
  }

  function enterSelectionMode() {
    if (!IS_TOP) return;
    if (selState) return; // 已在选区模式
    // 高亮覆盖层（独立元素，不进 Shadow DOM，pointer-events:none 不挡点击）
    const overlay = document.createElement('div');
    overlay.id = '__ah_sel_overlay__';
    overlay.style.cssText = [
      'position:fixed', 'z-index:2147483646', 'pointer-events:none', 'display:none',
      'outline:2px solid #2563eb', 'background:rgba(37,99,235,.10)',
      'border-radius:4px', 'transition:all .05s ease', 'box-sizing:border-box',
    ].join(';');
    const hint = document.createElement('div');
    hint.id = '__ah_sel_hint__';
    hint.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
      'background:#111827', 'color:#fff', 'padding:8px 14px', 'border-radius:999px',
      'font:13px/1.4 -apple-system,"PingFang SC",sans-serif', 'box-shadow:0 2px 10px rgba(0,0,0,.25)',
      'pointer-events:none',
    ].join(';');
    hint.textContent = '🎯 选区填写：移动到要填的区域，点击确认；Esc 取消';
    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(hint);

    const onMove = (e) => {
      const t = nearestFormContainer(e.clientX, e.clientY);
      selState.target = t || null;
      if (t) positionOverlay(overlay, t);
      else overlay.style.display = 'none';
    };
    const onClick = async (e) => {
      // 点到侧边栏自身：不处理
      if (host && e.composedPath && e.composedPath().includes(host)) return;
      if (!selState.target) return;
      e.preventDefault(); e.stopPropagation();
      const target = selState.target;
      exitSelectionMode();
      // 打开侧边栏并展示结果
      if (!host) buildSidebar();
      shadow.querySelector('.ah-panel').classList.add('open');
      const setResult = (h) => { shadow.querySelector('.ah-result').innerHTML = h; };
      setResult('<div class="ah-loading">正在填充所选区域…</div>');
      const r = await runAutofillInScope(target);
      renderFillResult(setResult, r);
    };
    const onKey = (e) => { if (e.key === 'Escape') exitSelectionMode(); };

    selState = { overlay, hint, target: null, onMove, onClick, onKey };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  function exitSelectionMode() {
    if (!selState) return;
    document.removeEventListener('mousemove', selState.onMove, true);
    document.removeEventListener('click', selState.onClick, true);
    document.removeEventListener('keydown', selState.onKey, true);
    selState.overlay.remove();
    selState.hint.remove();
    selState = null;
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

    // 结果区事件委托：复制字段值（📋）+ 存回按钮（选区填写结果区也能用）——纯本地，不联网
    $('.ah-result').addEventListener('click', async (e) => {
      const copyBtn = e.target.closest('.ah-copy');
      if (copyBtn) {
        const val = copyBtn.dataset.val || '';
        const done = () => { const o = copyBtn.textContent; copyBtn.textContent = '✓'; setTimeout(() => { copyBtn.textContent = o; }, 1200); };
        try {
          await navigator.clipboard.writeText(val);
          done();
        } catch (err) {
          // 某些页面 clipboard API 受限 → 退回 execCommand
          try {
            const ta = document.createElement('textarea');
            ta.value = val; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); ta.remove();
            done();
          } catch (e2) { copyBtn.textContent = '✕'; }
        }
        return;
      }
      // 存回信息库按钮（兜底委托；一键填写路径也会经 bindWriteback 绑定，这里加 guard 防重复）
      const wb = e.target.closest('#ah-writeback');
      if (wb && !wb.dataset.bound) {
        wb.dataset.bound = '1';
        wb.disabled = true; wb.textContent = '正在存回…';
        const res = await writeBackPage();
        renderWritebackResult($, res);
      }
    });

    $('.ah-fill').addEventListener('click', async () => {
      setResult('<div class="ah-loading">正在匹配并填充…</div>');
      const r = await runAutofill();
      renderFillResult(setResult, r); // 存回按钮由 .ah-result 事件委托统一处理
    });

    // AI 辅助填写：先普通填，再把剩余字段交给用户自己的 LLM
    $('.ah-ai-fill').addEventListener('click', async () => {
      setResult('<div class="ah-loading">正在匹配并填充（含 AI 语义对齐）…</div>');
      const r = await runAIAutofill();
      if (r.error === 'empty_profile') {
        setResult('<div class="ah-warn">信息库还是空的。请先打开「个人信息库」填写或上传简历。</div>' +
          '<button class="ah-link" id="ah-open-options">打开信息库</button>');
        $('#ah-open-options').addEventListener('click', openOptions);
        return;
      }
      if (r.error === 'no_llm_config') {
        setResult('<div class="ah-warn">还没配置 AI 接口。请到设置页「AI 设置」填入 API 地址 / Key / 模型名后再用。</div>' +
          '<button class="ah-link" id="ah-open-options">打开设置</button>');
        $('#ah-open-options').addEventListener('click', openOptions);
        return;
      }
      // 先渲染普通填充结果
      renderFillResult(setResult, r.base || { filled: 0, filledFields: [], needManual: [] });
      // 再在结果区顶部追加 AI 部分
      const res = shadow.querySelector('.ah-result');
      let aiHtml = '';
      if (r.aiError) {
        aiHtml = `<div class="ah-warn">🤖 AI 调用失败：${esc(r.aiError)}</div>`;
      } else if (r.aiFilled > 0) {
        aiHtml = `<div class="ah-ok" style="color:#7c3aed">🤖 AI 又补填了 ${r.aiFilled} 个字段，请人工复核：</div>
          <div class="ah-fields">${r.aiFields.map((f) => `
            <div class="ah-field-row">
              <span class="ah-fl" style="background:#ede9fe;color:#6d28d9">${esc(f.label)}</span>
              <span class="ah-fv" title="${esc(f.value)}">${esc(f.value)}</span>
              <button class="ah-copy" data-val="${esc(f.value)}" title="复制">📋</button>
            </div>`).join('')}</div>`;
      } else {
        aiHtml = `<div class="ah-sub">🤖 AI 没有发现可补填的字段。</div>`;
      }
      // 插到结果区最前
      const wrap = document.createElement('div');
      wrap.innerHTML = aiHtml;
      res.insertBefore(wrap, res.firstChild);
    });

    // 侧边栏「选区填写」按钮：进入框选模式
    $('.ah-sel-fill').addEventListener('click', () => {
      shadow.querySelector('.ah-panel').classList.remove('open'); // 收起侧边栏方便框选
      enterSelectionMode();
    });

    // 字段速取：列出信息库里所有有值的字段，逐条可复制（不联网、不碰页面）
    $('.ah-pick').addEventListener('click', async () => {
      setResult('<div class="ah-loading">读取信息库…</div>');
      const profile = await getProfile();
      if (!profile || Object.keys(profile).length === 0) {
        setResult('<div class="ah-warn">信息库是空的。请先打开「个人信息库」填写或上传简历。</div>' +
          '<button class="ah-link" id="ah-open-options">打开信息库</button>');
        $('#ah-open-options').addEventListener('click', openOptions);
        return;
      }
      const eff = await getEffective();
      const rows = [];
      for (const g of eff.groups) {
        const data = profile[g.key];
        if (!data) continue;
        // 可重复分组是数组（逐条逐字段）；标量分组是对象
        const records = Array.isArray(data) ? data : [data];
        records.forEach((rec, ri) => {
          if (!rec || typeof rec !== 'object') return;
          for (const f of g.fields) {
            const v = rec[f.key];
            if (v == null || String(v).trim() === '') continue;
            const prefix = records.length > 1 ? `${g.label}${ri + 1}·` : `${g.label}·`;
            rows.push({ label: prefix + f.label, value: String(v) });
          }
        });
      }
      if (!rows.length) { setResult('<div class="ah-warn">信息库里还没有填任何值。</div>'); return; }
      const html = `<div class="ah-sub">点 📋 复制对应值，粘到页面任意位置：</div>
        <div class="ah-fields">${rows.map((r) => `
          <div class="ah-field-row">
            <span class="ah-fl">${esc(r.label)}</span>
            <span class="ah-fv" title="${esc(r.value)}">${esc(r.value)}</span>
            <button class="ah-copy" data-val="${esc(r.value)}" title="复制">📋</button>
          </div>`).join('')}</div>`;
      setResult(html);
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

  // 渲染「填充结果」到结果区（一键填写 / 选区填写共用）。
  // setResult: 写 .ah-result 的函数；r: applyPlan 结果；$opt/bindWbOpt 仅一键填写时传入。
  function renderFillResult(setResult, r, $opt, bindWbOpt) {
    const $ = $opt || ((sel) => shadow.querySelector(sel));
    if (r.error === 'empty_profile') {
      setResult('<div class="ah-warn">信息库还是空的。请先打开「个人信息库」填写或上传简历。</div>' +
        '<button class="ah-link" id="ah-open-options">打开信息库</button>');
      const b = shadow.querySelector('#ah-open-options'); if (b) b.addEventListener('click', openOptions);
      return;
    }
    let html = `<div class="ah-ok">✓ 已自动填 ${r.filled} 个字段</div>`;
    if (r.filledFields && r.filledFields.length)
      html += `<div class="ah-fields">${r.filledFields.map((f) => {
        const label = typeof f === 'string' ? f : f.label;
        const val = typeof f === 'object' ? (f.value || '') : '';
        const isSel = typeof f === 'object' && f.isSelect;
        return `<div class="ah-field-row">
          <span class="ah-fl">${esc(label)}${isSel ? ' ▾' : ''}</span>
          <span class="ah-fv" title="${esc(val)}">${esc(val)}</span>
          ${val ? `<button class="ah-copy" data-val="${esc(val)}" title="复制">📋</button>` : ''}
        </div>`;
      }).join('')}</div>`;
    if (r.filledFields && r.filledFields.some((f) => typeof f === 'object' && f.isSelect))
      html += `<div class="ah-sub" style="color:#9a6700">▾ 为下拉自动选中项，请重点核对是否正确。</div>`;

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
    if (bindWbOpt) bindWbOpt($);
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
    } else if (msg?.type === 'START_SELECTION_FILL') {
      enterSelectionMode();
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
  .ah-ai-fill { background: #7c3aed; color: #fff; font-weight: 600; }
  .ah-ai-fill:hover { background: #6d28d9; }
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
  .ah-fields { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
  .ah-field-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; }
  .ah-field-row:hover { background: #f9fafb; }
  .ah-fl { flex: 0 0 auto; color: #166534; font-size: 11px; background: #dcfce7; padding: 2px 8px; border-radius: 999px; }
  .ah-fv { flex: 1 1 auto; color: #374151; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ah-copy { flex: 0 0 auto; background: none; border: 1px solid #e5e7eb; border-radius: 5px; cursor: pointer; font-size: 12px; padding: 2px 6px; line-height: 1.2; }
  .ah-copy:hover { background: #eef2ff; border-color: #c7d2fe; }
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
    <button class="ah-btn ah-ai-fill">🤖 AI 辅助填写</button>
    <button class="ah-btn ah-sel-fill ghost">🎯 选区填写（只填框选区域）</button>
    <button class="ah-btn ah-pick ghost">📇 字段速取（逐字段复制）</button>
    <button class="ah-btn ah-writeback-main ghost">💾 把本页填写存回信息库</button>
    <button class="ah-btn ah-record">＋ 记录本次投递</button>
    <div class="ah-result"></div>
  </div>
  <div class="ah-foot">
    <button class="ah-btn ah-open-options ghost" style="margin:0">管理信息库 / 投递记录</button>
  </div>
</div>`;
})();
