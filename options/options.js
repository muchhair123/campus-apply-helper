// options.js — 设置页逻辑：个人信息库 + 投递记录
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let profileState = {};              // 当前编辑中的 profile（内存副本）
let customSchema = { groups: [] };  // 用户自定义模块/字段
let SCHEMA = window.AH_SCHEMA.buildEffective({ groups: [] }); // 有效 schema（内置+自定义），初始化后在 init 里重算

// 重算有效 schema（自定义变化后调用）
function rebuildSchema() {
  SCHEMA = window.AH_SCHEMA.buildEffective(customSchema);
}
// 生成唯一键
let __keySeq = 0;
function uid(prefix) { __keySeq += 1; return prefix + '_' + Date.now().toString(36) + __keySeq; }

// ======================= Tab 切换 =======================
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  // 保存条只在信息库 tab 显示
  $('#savebar').style.display = name === 'profile' ? 'flex' : 'none';
  if (name === 'applications') renderApplications();
  history.replaceState(null, '', '#' + name);
}
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ======================= 信息库表单渲染 =======================
function fieldInputHTML(field, value, path) {
  const v = value == null ? '' : String(value);
  const esc = (s) => s.replace(/"/g, '&quot;');
  if (field.type === 'textarea') {
    return `<textarea data-path="${path}">${v.replace(/</g, '&lt;')}</textarea>`;
  }
  if (field.type === 'select') {
    const opts = ['<option value=""></option>']
      .concat((field.options || []).map((o) => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${o}</option>`))
      .join('');
    return `<select data-path="${path}">${opts}</select>`;
  }
  const typeMap = { tel: 'tel', email: 'email', date: 'date', month: 'month', number: 'number' };
  const inputType = typeMap[field.type] || 'text';
  return `<input type="${inputType}" data-path="${path}" value="${esc(v)}" />`;
}

function renderFieldGrid(group, data, basePath) {
  return `<div class="field-grid">${group.fields
    .map((f) => {
      const full = f.type === 'textarea';
      const path = `${basePath}.${f.key}`;
      // 自定义字段（含挂载到内置模块的）带改名/删除按钮；内置固定字段锁定
      const fieldCtrls = f.custom
        ? `<span class="field-ctrls">
             <button class="field-rename" title="改名" data-action="rename-field" data-group="${group.key}" data-field="${f.key}">✎</button>
             <button class="field-del" title="删除该字段" data-action="del-field" data-group="${group.key}" data-field="${f.key}">✕</button>
           </span>`
        : '';
      return `<div class="field ${full ? 'full' : ''}">
        <label>${f.label}${fieldCtrls}</label>
        ${fieldInputHTML(f, data ? data[f.key] : '', path)}
      </div>`;
    })
    .join('')}</div>`;
}

function renderProfileForm() {
  const form = $('#profile-form');
  form.innerHTML = SCHEMA.groups
    .map((group) => {
      let bodyHTML;
      if (group.repeatable) {
        const items = Array.isArray(profileState[group.key]) ? profileState[group.key] : [];
        const itemsHTML = items
          .map(
            (item, i) => `
          <div class="repeat-item" data-group="${group.key}" data-index="${i}">
            <div class="item-head">
              <span class="idx">第 ${i + 1} 条</span>
              <button class="btn sm ghost-danger" data-action="remove-item" data-group="${group.key}" data-index="${i}">删除</button>
            </div>
            ${renderFieldGrid(group, item, `${group.key}[${i}]`)}
          </div>`
          )
          .join('');
        bodyHTML = `${itemsHTML}<button class="btn add" data-action="add-item" data-group="${group.key}">+ 添加${group.label}</button>`;
      } else {
        bodyHTML = renderFieldGrid(group, profileState[group.key] || {}, group.key);
      }
      // 自定义模块：模块头加「自定义标签 + 删模块」；内置模块只能加字段不能删
      const headExtra = group.custom
        ? `<span class="group-tag">自定义</span>
           <button class="btn sm ghost-danger" data-action="del-group" data-group="${group.key}">删除模块</button>`
        : '';
      // 内置和自定义模块都允许「+ 添加字段」（内置模块的新字段作为挂载的自定义字段，加在模块末尾）
      const addFieldBtn = `<button class="btn add sm" data-action="add-field" data-group="${group.key}">+ 添加字段</button>`;
      return `<div class="group-card">
        <div class="group-head"><h3>${group.label}</h3><div class="group-head-right">${headExtra}</div></div>
        <div class="group-body">${bodyHTML}${addFieldBtn}</div>
      </div>`;
    })
    .join('') + `
    <button class="btn add" id="btn-add-group" style="margin-top:4px">+ 新增自定义模块</button>`;
}

// 把表单当前值收集回 profileState
function collectForm() {
  // 标量分组
  for (const group of SCHEMA.groups) {
    if (group.repeatable) continue;
    profileState[group.key] = profileState[group.key] || {};
  }
  $$('#profile-form [data-path]').forEach((el) => {
    const path = el.dataset.path;
    setByPath(profileState, path, el.value);
  });
}

// 支持 "basic.name" 和 "education[0].school" 两种路径
function setByPath(obj, path, value) {
  const m = path.match(/^(\w+)(\[(\d+)\])?\.(\w+)$/);
  if (!m) return;
  const [, group, , idxStr, field] = m;
  if (idxStr !== undefined) {
    obj[group] = obj[group] || [];
    obj[group][+idxStr] = obj[group][+idxStr] || {};
    obj[group][+idxStr][field] = value;
  } else {
    obj[group] = obj[group] || {};
    obj[group][field] = value;
  }
}

// 可重复分组增删条目 + 自定义模块/字段增删（委托事件）
$('#profile-form').addEventListener('click', (e) => {
  // 新增自定义模块（独立按钮）
  if (e.target.closest('#btn-add-group')) { collectForm(); addCustomGroup(); return; }

  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const groupKey = btn.dataset.group;
  collectForm(); // 先保存当前输入
  if (action === 'add-item') {
    profileState[groupKey] = profileState[groupKey] || [];
    profileState[groupKey].push({});
    renderProfileForm();
  } else if (action === 'remove-item') {
    const idx = +btn.dataset.index;
    profileState[groupKey].splice(idx, 1);
    renderProfileForm();
  } else if (action === 'del-group') {
    delCustomGroup(groupKey);
  } else if (action === 'add-field') {
    addCustomField(groupKey);
  } else if (action === 'del-field') {
    delCustomField(groupKey, btn.dataset.field);
  } else if (action === 'rename-field') {
    renameCustomField(groupKey, btn.dataset.field);
  }
});

// ---- 自定义模块/字段操作 ----
function findCustomGroup(key) { return customSchema.groups.find((g) => g.key === key); }

// 在 customSchema 里找/建某 key 的组（内置模块 key 则建"挂载组"）
function ensureCustomGroup(key) {
  let g = findCustomGroup(key);
  if (g) return g;
  const builtin = window.AH_SCHEMA.groups.find((x) => x.key === key);
  g = { key, label: builtin ? builtin.label : key, repeatable: builtin ? !!builtin.repeatable : false, custom: true, fields: [] };
  customSchema.groups.push(g);
  return g;
}
// 在 customSchema 里查某字段（含内置挂载组）
function findCustomField(groupKey, fieldKey) {
  const g = findCustomGroup(groupKey);
  return g ? g.fields.find((f) => f.key === fieldKey) : null;
}

function addCustomGroup() {
  const label = (prompt('新模块名称（如：证书、海外经历）') || '').trim();
  if (!label) return;
  const multi = confirm('这个模块需要「多条记录」吗？\n\n确定 = 多条（像教育/奖项，可加第2、3条）\n取消 = 单条（一组字段）');
  customSchema.groups.push({ key: uid('custom'), label, repeatable: multi, custom: true, fields: [] });
  rebuildSchema();
  renderProfileForm();
}

function delCustomGroup(key) {
  const g = findCustomGroup(key);
  if (!g) return;
  if (!confirm(`删除自定义模块「${g.label}」？该模块下已填的数据也会一并删除。`)) return;
  customSchema.groups = customSchema.groups.filter((x) => x.key !== key);
  delete profileState[key];
  rebuildSchema();
  renderProfileForm();
}

function addCustomField(groupKey) {
  const g = ensureCustomGroup(groupKey); // 内置模块也能加（作挂载字段）
  const label = (prompt('字段名称（如：证书名称）') || '').trim();
  if (!label) return;
  const aliasRaw = (prompt('该字段的别名/同义词，用逗号分隔（可留空）。\n填了能提升网申页「一键填写」命中率。', '') || '').trim();
  const aliases = aliasRaw ? aliasRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
  g.fields.push({ key: uid('cf'), label, type: 'text', custom: true, aliases: [label, ...aliases] });
  rebuildSchema();
  renderProfileForm();
}

function renameCustomField(groupKey, fieldKey) {
  const f = findCustomField(groupKey, fieldKey);
  if (!f) return;
  const old = f.label;
  const next = (prompt('修改字段名称：', old) || '').trim();
  if (!next || next === old) return;
  f.label = next;
  // 同步 aliases：把旧 label 替换为新 label（保留其他别名）
  const aliases = Array.isArray(f.aliases) ? f.aliases.filter((a) => a !== old) : [];
  if (!aliases.includes(next)) aliases.unshift(next);
  f.aliases = aliases;
  rebuildSchema();
  renderProfileForm();
}

function delCustomField(groupKey, fieldKey) {
  const g = findCustomGroup(groupKey);
  if (!g) return;
  g.fields = g.fields.filter((f) => f.key !== fieldKey);
  // 挂载组删空后，若是内置 key 的空挂载组可清掉（可选，保持整洁）
  if (g.fields.length === 0 && window.AH_SCHEMA.groups.some((x) => x.key === groupKey)) {
    customSchema.groups = customSchema.groups.filter((x) => x.key !== groupKey);
  }
  rebuildSchema();
  renderProfileForm();
}

// ======================= 保存 / 撤销 =======================
async function saveProfile() {
  collectForm();
  await AHStorage.saveProfile(profileState);
  await AHStorage.saveCustomSchema(customSchema); // 自定义模块/字段结构一起存
  const st = $('#save-status');
  st.textContent = '✓ 已保存';
  st.classList.add('ok');
  setTimeout(() => { st.textContent = ''; st.classList.remove('ok'); }, 2000);
}
$('#btn-save').addEventListener('click', saveProfile);
$('#btn-reset').addEventListener('click', async () => {
  profileState = await AHStorage.getProfile();
  customSchema = await AHStorage.getCustomSchema();
  rebuildSchema();
  renderProfileForm();
  const st = $('#save-status');
  st.textContent = '已撤销未保存的修改';
  setTimeout(() => (st.textContent = ''), 2000);
});

// ======================= 投递记录（tab2） =======================
const STATUS_LIST = ['已投递', '笔试', '面试', 'offer', '挂了'];
let appsCache = [];

async function renderApplications() {
  appsCache = await AHStorage.getApplications();
  drawAppsTable();
}

function drawAppsTable() {
  const kw = ($('#apps-search').value || '').trim().toLowerCase();
  const statusFilter = $('#apps-filter-status').value;
  const rows = appsCache.filter((a) => {
    const hitKw = !kw || (a.company + ' ' + a.position).toLowerCase().includes(kw);
    const hitStatus = !statusFilter || a.status === statusFilter;
    return hitKw && hitStatus;
  });

  const wrap = $('#apps-table-wrap');
  if (rows.length === 0) {
    wrap.innerHTML = `<div class="empty">${appsCache.length === 0 ? '还没有投递记录。在网申页点侧边栏的「记录本次投递」，或点右上「手动添加」。' : '没有匹配的记录。'}</div>`;
    return;
  }

  const statusOpts = (cur) =>
    STATUS_LIST.map((s) => `<option value="${s}" ${s === cur ? 'selected' : ''}>${s}</option>`).join('');

  wrap.innerHTML = `<table class="apps">
    <thead><tr>
      <th style="width:18%">公司</th><th style="width:20%">岗位</th>
      <th style="width:12%">投递日期</th><th style="width:11%">状态</th>
      <th style="width:10%">链接</th><th>备注</th><th style="width:48px"></th>
    </tr></thead>
    <tbody>
      ${rows
        .map(
          (a) => `<tr data-id="${a.id}">
        <td><input data-field="company" value="${attr(a.company)}" /></td>
        <td><input data-field="position" value="${attr(a.position)}" /></td>
        <td><input type="date" data-field="date" value="${attr(a.date)}" /></td>
        <td><select class="status-select st-${a.status}" data-field="status">${statusOpts(a.status)}</select></td>
        <td>${a.url ? `<a href="${attr(a.url)}" target="_blank" rel="noopener">打开↗</a>` : '<span style="color:#9ca3af">—</span>'}</td>
        <td><input data-field="note" value="${attr(a.note)}" placeholder="备注…" /></td>
        <td><button class="btn sm ghost-danger" data-action="del-app">删</button></td>
      </tr>`
        )
        .join('')}
    </tbody></table>`;
}

function attr(s) {
  return String(s == null ? '' : s).replace(/"/g, '&quot;');
}

// 表格内编辑：失焦即保存
$('#apps-table-wrap').addEventListener('change', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const field = e.target.dataset.field;
  if (!field) return;
  const id = tr.dataset.id;
  await AHStorage.updateApplication(id, { [field]: e.target.value });
  const local = appsCache.find((x) => x.id === id);
  if (local) local[field] = e.target.value;
  if (field === 'status') {
    e.target.className = 'status-select st-' + e.target.value;
  }
});
$('#apps-table-wrap').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="del-app"]');
  if (!btn) return;
  const tr = btn.closest('tr[data-id]');
  if (!confirm('确定删除这条投递记录？')) return;
  await AHStorage.deleteApplication(tr.dataset.id);
  await renderApplications();
});
$('#apps-search').addEventListener('input', drawAppsTable);
$('#apps-filter-status').addEventListener('change', drawAppsTable);
$('#btn-add-app').addEventListener('click', async () => {
  await AHStorage.addApplication({ company: '', position: '' });
  await renderApplications();
});

// ======================= 简历解析（阶段 5 接入） =======================
$('#btn-upload-resume').addEventListener('click', () => $('#resume-file').click());
$('#resume-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('#resume-filename').textContent = file.name;
  const statusEl = $('#resume-status');
  if (!window.AH_ResumeParser || !window.AH_ResumeParser.parseResume) {
    statusEl.textContent = '简历解析模块尚未启用（阶段 5）。可先手动填写下方字段。';
    return;
  }
  statusEl.textContent = '解析中…';
  try {
    const draft = await window.AH_ResumeParser.parseResume(file);
    applyDraft(draft);
    statusEl.textContent = '解析完成，已填入草稿，请核对。';
  } catch (err) {
    statusEl.textContent = '解析失败：' + err.message;
  }
});

// 把解析草稿合并进当前表单（不覆盖已有非空值）
function applyDraft(draft) {
  if (!draft) return;
  const warning = draft.__warning__;
  for (const [groupKey, val] of Object.entries(draft)) {
    if (groupKey === '__warning__') continue;
    if (Array.isArray(val)) {
      // 可重复分组（教育/工作/项目/奖项）：按业务主键去重，把草稿新条目合并进现有列表
      const existing = Array.isArray(profileState[groupKey]) ? profileState[groupKey] : [];
      const kept = existing.filter((it) => it && typeof it === 'object' && Object.values(it).some((x) => x && String(x).trim()));
      // 每个分组用一个“主键字段”判断是否同一条；取不到就退回全字段签名
      const keyField = { education: 'school', work: 'company', project: 'projectName', award: 'awardName' }[groupKey];
      const sig = (o) => {
        const k = keyField && o[keyField] ? String(o[keyField]).trim() : '';
        return k || JSON.stringify(Object.values(o || {}).map((x) => String(x || '').trim()).sort());
      };
      const idx = new Map(kept.map((it, i) => [sig(it), i]));
      const merged = kept.slice();
      for (const item of val) {
        if (!item || typeof item !== 'object') continue;
        const s = sig(item);
        if (idx.has(s)) {
          // 同一条已存在：用草稿补齐其缺失字段，不覆盖用户已填的非空值
          const cur = merged[idx.get(s)];
          for (const [k, v] of Object.entries(item)) if (v && !cur[k]) cur[k] = v;
        } else {
          idx.set(s, merged.length); merged.push(item); // 新条目追加
        }
      }
      profileState[groupKey] = merged.length ? merged : val;
    } else if (val && typeof val === 'object') {
      profileState[groupKey] = profileState[groupKey] || {};
      for (const [k, v] of Object.entries(val)) {
        if (v && !profileState[groupKey][k]) profileState[groupKey][k] = v;
      }
    }
  }
  renderProfileForm();
  const banner = $('#draft-banner');
  banner.querySelector('span').textContent = warning
    ? '⚠️ ' + warning
    : '⚠️ 已从简历解析出部分字段并填入下方表单，请核对后保存。';
  banner.style.display = 'flex';
}
$('#btn-draft-dismiss').addEventListener('click', () => {
  $('#draft-banner').style.display = 'none';
});

// 检查 background 转来的解析草稿（从侧边栏触发的场景，暂留）
async function checkPendingDraft() {
  chrome.storage.local.get('__resume_draft__', (res) => {
    if (res && res.__resume_draft__) {
      applyDraft(res.__resume_draft__);
      chrome.storage.local.remove('__resume_draft__');
    }
  });
}

// ======================= 备份导入导出 =======================
$('#btn-export').addEventListener('click', async () => {
  const data = await AHStorage.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `校招助手备份-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!confirm('导入将覆盖当前的信息库和投递记录，确定继续？')) return;
    await AHStorage.importAll(data);
    profileState = await AHStorage.getProfile();
    customSchema = await AHStorage.getCustomSchema();
    rebuildSchema();
    renderProfileForm();
    await renderApplications();
    alert('导入成功。');
  } catch (err) {
    alert('导入失败：' + err.message);
  }
});

// ======================= 初始化 =======================
(async function init() {
  profileState = await AHStorage.getProfile();
  customSchema = await AHStorage.getCustomSchema();
  rebuildSchema();
  renderProfileForm();
  await checkPendingDraft();
  // 根据 hash 定位 tab
  const hash = (location.hash || '').replace('#', '');
  switchTab(hash === 'applications' ? 'applications' : 'profile');
})();
