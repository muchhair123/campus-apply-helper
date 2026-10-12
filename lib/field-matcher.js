// field-matcher.js — 启发式字段匹配引擎
// 挂到全局 window.AH_Matcher。被 content.js 使用（manifest 顺序加载）。
//
// 核心思路：对页面每个表单元素收集"上下文线索"（label/placeholder/name/id/aria/邻近文本），
// 与 schema 字段的 aliases 做归一化模糊匹配打分，取最高分且过阈值的字段。
// 设计原则「宁缺毋填」：低置信度不自动填，列入需手动确认清单。

(function (global) {
  const SCHEMA = global.AH_SCHEMA;

  // 归一化：转小写、去空白、去全角符号、去常见无意义词
  function norm(s) {
    if (!s) return '';
    return String(s)
      .toLowerCase()
      .replace(/[\s　:：*＊()（）\[\]【】.、,，\-_/\\]/g, '')
      // 先整体去掉常见占位短语，再去零散修饰词，避免 "请填写" 残留出 "请"
      .replace(/请输入|请选择|请如实填写|请填写|如实填写/g, '')
      .replace(/填写|必填|选填|例如|format/g, '');
  }

  // 收集一个表单元素的上下文文本线索（按可靠性排序，权重不同）
  function collectClues(el) {
    const clues = [];
    const add = (text, weight) => {
      const n = norm(text);
      if (n) clues.push({ n, weight });
    };

    // 1) 关联 label（for=id 或包裹）
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) add(lab.textContent, 1.0);
    }
    const wrapLabel = el.closest('label');
    if (wrapLabel) add(wrapLabel.textContent, 0.95);

    // 2) aria-label / title / placeholder
    add(el.getAttribute('aria-label'), 0.9);
    add(el.getAttribute('title'), 0.6);
    add(el.getAttribute('placeholder'), 0.75);

    // 3) name / id（英文线索）
    add(el.getAttribute('name'), 0.7);
    add(el.id, 0.6);

    // 4) 邻近文本：前一个兄弟、父级里的 label/span/td 前缀
    const prev = el.previousElementSibling;
    if (prev && /^(label|span|div|td|th|p|strong)$/i.test(prev.tagName)) add(prev.textContent, 0.65);
    // 常见布局：<td>标签</td><td><input></td>
    const cell = el.closest('td');
    if (cell) {
      const prevCell = cell.previousElementSibling;
      if (prevCell) add(prevCell.textContent, 0.6);
    }
    // 常见布局：<div class="label">标签</div> 作为父容器首个文本
    // Element UI / Ant Design 等框架：字段无 id/name/label[for]，容器 label 是唯一可靠线索，故提至最高权重
    const formItem = el.closest('.form-item,.ant-form-item,.el-form-item,.field,.form-group');
    if (formItem) {
      const lab = formItem.querySelector('.el-form-item__label,.ant-form-item-label,label,.label');
      if (lab) add(lab.textContent, 0.95);
    }

    return clues;
  }

  // 单个 alias 与一条线索的匹配分：完全相等 1.0；包含关系按长度比；否则 0
  function aliasScore(aliasNorm, clueNorm) {
    if (!aliasNorm || !clueNorm) return 0;
    if (clueNorm === aliasNorm) return 1.0;
    // 单字 alias（如"系""男"）只接受完全相等，否则极易误匹配长线索
    if (aliasNorm.length <= 1) return 0;
    // 线索包含 alias（如线索"联系手机号码"含 alias"手机号"）
    if (clueNorm.includes(aliasNorm)) {
      const ratio = aliasNorm.length / clueNorm.length;
      // alias 只占长线索的一小部分时，极可能是巧合子串（如"单位"命中"是否为邮储银行体系内单位员工"）
      // 要求线索不太长，或 alias 占比够高，否则判为不可信
      if (clueNorm.length >= 8 && ratio < 0.34) return 0;
      return 0.7 + 0.25 * ratio;
    }
    // alias 包含线索（线索较短，如线索"手机"含于 alias"手机号码"）—— 要求线索够长避免误匹配
    if (aliasNorm.includes(clueNorm) && clueNorm.length >= 2) {
      return 0.55 + 0.2 * (clueNorm.length / aliasNorm.length);
    }
    return 0;
  }

  // 某些标签含"归属/类型/判断"词，核心语义与本人标量字段不同，必须排除误填。
  // 例："紧急联系电话"≠本人电话；"证件号码类型"要的是类型不是号；"最高学历预计毕业时间"要的是时间不是学历。
  function excludedFieldsFor(clueNorm) {
    const ex = new Set();
    // 归属他人：紧急联系人 / 他人，禁止匹配本人 basic 的姓名/电话/手机
    if (/紧急|联系人|配偶|本人以外/.test(clueNorm)) {
      ['phone', 'name', 'email'].forEach((k) => ex.add('basic.' + k));
    }
    // "类型"字段（证件号码类型）禁止匹配号码本身
    if (/类型/.test(clueNorm)) ex.add('basic.idCard');
    // 含"时间/日期"的禁止匹配 学历/学校（如"最高学历预计毕业时间"要的是时间）
    if (/时间|日期/.test(clueNorm)) { ex.add('education.degree'); ex.add('education.school'); }
    return ex;
  }

  // 对一个元素，返回最佳匹配 { fieldKey, groupKey, repeatable, confidence }
  function matchElement(el, fields) {
    const clues = collectClues(el);
    if (clues.length === 0) return null;

    // 汇总所有线索触发的排除集
    const excluded = new Set();
    for (const c of clues) excludedFieldsFor(c.n).forEach((k) => excluded.add(k));

    let best = null;
    for (const field of fields) {
      if (excluded.has(field.groupKey + '.' + field.key)) continue;
      const aliasNorms = field.aliases.map(norm).filter(Boolean);
      let fieldScore = 0;
      for (const clue of clues) {
        for (const a of aliasNorms) {
          const s = aliasScore(a, clue.n) * clue.weight;
          if (s > fieldScore) fieldScore = s;
        }
      }
      if (fieldScore > 0 && (!best || fieldScore > best.confidence)) {
        best = {
          fieldKey: field.key,
          groupKey: field.groupKey,
          repeatable: field.repeatable,
          confidence: fieldScore,
        };
      }
    }
    return best;
  }

  // 收集页面上可填的表单元素（排除隐藏、只读、禁用、按钮类）
  function collectFormElements(root) {
    const els = Array.from(root.querySelectorAll('input, select, textarea'));
    return els.filter((el) => {
      if (el.disabled) return false;
      // readonly 的组件化下拉（el-select 等）仍保留——用于归入「需手动」提示；纯 readonly 跳过
      if (el.readOnly && !isComponentSelect(el)) return false;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'file', 'image', 'search'].includes(type)) return false;
      // 跳过不可见元素
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    });
  }

  // 从 profile 取某字段的值（标量分组取 group.field；可重复分组默认取第 0 条）
  function getProfileValue(profile, groupKey, fieldKey, repeatable) {
    if (!profile) return '';
    const g = profile[groupKey];
    if (repeatable) {
      if (Array.isArray(g) && g[0]) return g[0][fieldKey] || '';
      return '';
    }
    return g ? g[fieldKey] || '' : '';
  }

  const MIN_CONFIDENCE = 0.55; // 低于此值列入「需手动确认」

  // 判断是否为「组件化下拉」：Element UI / Ant Design 等用 readonly input + 弹层实现，
  // 直接写 value 不会更新组件状态且无法触发选项，故不自动填，列入手动。
  function isComponentSelect(el) {
    if (el.tagName.toLowerCase() === 'select') return false; // 原生 select 可自动填
    if (el.readOnly) return true;
    if (el.closest('.el-select,.el-cascader,.el-date-editor,.ant-select,.ant-picker,.ant-cascader')) return true;
    return false;
  }

  // 主入口：扫描页面，返回填充计划
  // 返回 { toFill: [{el, fieldKey, label, value, confidence}], needManual: [{el, label}] }
  function buildFillPlan(root, profile, fieldsArg) {
    const fields = fieldsArg || SCHEMA.flatFields; // 传入合并后的 flatFields 可让自定义字段参与匹配
    const elements = collectFormElements(root);
    const toFill = [];
    const needManual = [];
    const usedElements = new Set();

    for (const el of elements) {
      const m = matchElement(el, fields);
      if (!m) continue;
      const fieldDef = fields.find((f) => f.key === m.fieldKey && f.groupKey === m.groupKey);
      const value = getProfileValue(profile, m.groupKey, m.fieldKey, m.repeatable);
      const label = fieldDef ? fieldDef.label : m.fieldKey;
      if (m.confidence < MIN_CONFIDENCE) continue; // 低置信度忽略，不打扰

      const hasValue = value && String(value).trim();
      const isSelect = isComponentSelect(el);
      if (!hasValue) {
        // 信息库没值 → 提示手动（下拉也一样，没建议值无法自动点选）
        needManual.push({ el, fieldKey: m.fieldKey, groupKey: m.groupKey, label, reason: isSelect ? 'select' : 'empty' });
      } else {
        // 有值：普通字段直接填；组件下拉标 isSelect，由 content 尝试安全自动点选，失败再回落手选
        toFill.push({ el, fieldKey: m.fieldKey, groupKey: m.groupKey, label, value, confidence: m.confidence, isSelect });
        usedElements.add(el);
      }
    }
    return { toFill, needManual };
  }

  global.AH_Matcher = {
    norm,
    collectClues,
    collectFormElements,
    buildFillPlan,
    matchElement,
    isComponentSelect,
    MIN_CONFIDENCE,
  };
})(typeof window !== 'undefined' ? window : self);
