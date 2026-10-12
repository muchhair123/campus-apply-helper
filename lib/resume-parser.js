// resume-parser.js — 本地简历解析（PDF / docx / LaTeX / 纯文本）
// 挂到全局 window.AH_ResumeParser，被 options.js 使用。
// 解析分两步：1) 按扩展名取纯文本；2) extractFields(text) 用正则抽结构化字段。
// 结果作为「草稿」返回，由 options 合并进表单让用户确认，绝不直接覆盖。
//
// 依赖（在 options.html 阶段 5 启用）：
//   window.pdfjsLib        —— pdf.min.js
//   window.mammoth         —— mammoth.browser.min.js

(function (global) {
  // ---------- 取文本 ----------
  async function readFileText(file) {
    return await file.text();
  }

  async function pdfToText(file) {
    if (!global.pdfjsLib) throw new Error('PDF 解析库未加载');
    // worker 指向本地文件
    try {
      global.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/vendor/pdf.worker.min.js');
    } catch (e) { /* 测试环境无 chrome.runtime 时忽略 */ }
    const buf = await file.arrayBuffer();
    const pdf = await global.pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((it) => it.str).join(' ') + '\n';
    }
    return text;
  }

  async function docxToText(file) {
    if (!global.mammoth) throw new Error('Word 解析库未加载');
    const buf = await file.arrayBuffer();
    const res = await global.mammoth.extractRawText({ arrayBuffer: buf });
    return res.value || '';
  }

  // LaTeX：剥离命令/注释/花括号层，保留可读文本
  function texToText(raw) {
    let t = raw;
    t = t.replace(/(^|[^\\])%.*$/gm, '$1'); // 去注释
    t = t.replace(/\\documentclass[^\n]*|\\usepackage[^\n]*|\\newcommand[^\n]*|\\renewcommand[^\n]*/g, '');
    t = t.replace(/\\(section|subsection|textbf|textit|emph|href|resumeSubheading|resumeItem|resumeSubItem|item)\b/g, ' ');
    // href{url}{text} 保留 text
    t = t.replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1');
    t = t.replace(/\\[a-zA-Z]+(\[[^\]]*\])?/g, ' '); // 其余命令
    t = t.replace(/[{}]/g, ' ').replace(/[&\\]/g, ' ');
    t = t.replace(/\$[^$]*\$/g, ' '); // 行内公式
    t = t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
    return t.trim();
  }

  // 清理一段 LaTeX 内联文本：去 \textbf{} \textit{} \href{}{} 等，保留可读内容
  function cleanInline(s) {
    if (!s) return '';
    let t = s;
    t = t.replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1');
    t = t.replace(/\\(?:textbf|textit|emph|underline|texttt)\s*\{([^}]*)\}/g, '$1');
    t = t.replace(/\\textbar\{?\}?/g, '|');
    t = t.replace(/\\hfill|\\quad|\\&/g, ' ');
    t = t.replace(/\\%/g, '%');
    t = t.replace(/\\[a-zA-Z]+(\[[^\]]*\])?\s*/g, ' '); // 其余命令
    t = t.replace(/[{}]/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  // 从位置 pos 起，读取 LaTeX 命令后紧跟的 n 个 {...} 花括号组（支持嵌套、跨空白/换行）
  function readBraceGroups(src, pos, n) {
    const groups = [];
    let i = pos;
    while (groups.length < n) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] !== '{') break;
      let depth = 0, start = i + 1;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
      }
      groups.push(src.slice(start, i - 1));
    }
    return { groups, end: i };
  }

  // ---------- .tex 结构化解析（针对 \section + \resumeSubheading + \resumeItem/\resumeSubItem 风格简历）----------
  function parseTexStructured(raw) {
    // 去注释（保留 \%）
    const src = raw.replace(/(^|[^\\])%.*$/gm, '$1');
    const draft = { basic: {}, education: [], work: [], project: [], skill: {}, award: [] };
    // 读某条正则匹配 sm 命令后第一个 {...} 的原始内容
    const g0 = (body, sm) => readBraceGroups(body, sm.index + sm[0].length - 1, 1).groups[0] || '';

    // --- 头部：姓名 / 电话 / 邮箱 / 微信 ---
    const nameM = src.match(/\\(?:LARGE|Large|huge|Huge)\s*\\bfseries\s*([^\\{}\n]+)/) ||
                  src.match(/\\bfseries\s*([一-龥·]{2,6})\b/);
    if (nameM) draft.basic.name = nameM[1].trim();
    const phoneM = src.match(/(1[3-9]\d{9})/); if (phoneM) draft.basic.phone = phoneM[1];
    const emailM = src.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/); if (emailM) draft.basic.email = emailM[0];

    // --- 按 \section 切块 ---
    const sectionRe = /\\section\*?\{([^}]*)\}/g;
    const secs = [];
    let m;
    while ((m = sectionRe.exec(src))) secs.push({ title: cleanInline(m[1]), start: m.index + m[0].length });
    for (let s = 0; s < secs.length; s++) {
      secs[s].body = src.slice(secs[s].start, s + 1 < secs.length ? secs[s + 1].start : src.length);
    }

    const parseDateRange = (str) => {
      // "2024.09 -- 2027.06" / "2025" / "2026.03 -- 至今"
      const norm = (d) => {
        const mm = d.match(/(\d{4})[.\-\/]?(\d{1,2})?/);
        if (!mm) return d.trim();
        return mm[2] ? `${mm[1]}-${mm[2].padStart(2, '0')}` : mm[1];
      };
      const parts = str.split(/--|—|~|至/).map((x) => x.trim()).filter(Boolean);
      const start = parts[0] ? norm(parts[0]) : '';
      let end = '';
      if (/至今/.test(str)) end = '至今';
      else if (parts[1]) end = norm(parts[1]);
      return { start, end };
    };

    // 在一个 section body 内提取所有 \resumeSubheading{t1}{t2}{t3}{t4} 及其后的 \resumeItem{...}
    const extractSubheadings = (body) => {
      const re = /\\resumeSubheading/g;
      const list = [];
      let mm;
      while ((mm = re.exec(body))) {
        const { groups, end } = readBraceGroups(body, re.lastIndex, 4);
        if (groups.length < 4) continue;
        // 该条的描述项：从本 subheading 到下一个 subheading 之间的 \resumeItem
        const nextIdx = body.indexOf('\\resumeSubheading', end);
        const chunk = body.slice(end, nextIdx === -1 ? body.length : nextIdx);
        const items = [];
        const itemRe = /\\resumeItem\s*\{/g;
        let im;
        while ((im = itemRe.exec(chunk))) {
          const g = readBraceGroups(chunk, im.index + im[0].length - 1, 1);
          if (g.groups[0]) items.push(cleanInline(g.groups[0]));
        }
        list.push({ t1: cleanInline(groups[0]), t2: cleanInline(groups[1]), t3: cleanInline(groups[2]), t4: cleanInline(groups[3]), items });
      }
      return list;
    };

    for (const sec of secs) {
      const title = sec.title;
      if (/教育/.test(title)) {
        for (const h of extractSubheadings(sec.body)) {
          const dr = parseDateRange(h.t2);
          // t3: 学院 | 专业 | 学历
          const parts = h.t3.split('|').map((x) => x.trim()).filter(Boolean);
          const edu = { school: h.t1, enrollDate: dr.start, graduateDate: dr.end };
          if (parts[0]) edu.college = parts[0];
          if (parts[1]) edu.major = parts[1];
          if (parts[2]) {
            const dmap = { '硕士研究生': '硕士', '博士研究生': '博士', '本科': '本科', '大专': '大专', '专科': '大专' };
            edu.degree = dmap[parts[2]] || parts[2];
          }
          draft.education.push(edu);
        }
      } else if (/实习|工作/.test(title)) {
        for (const h of extractSubheadings(sec.body)) {
          const dr = parseDateRange(h.t2);
          draft.work.push({ company: h.t1, title: h.t3, startDate: dr.start, endDate: dr.end, description: h.items.join('\n') });
        }
      } else if (/项目/.test(title)) {
        for (const h of extractSubheadings(sec.body)) {
          const dr = parseDateRange(h.t2);
          draft.project.push({ projectName: h.t1, role: h.t3, startDate: dr.start, endDate: dr.end, description: h.items.join('\n') });
        }
      } else if (/技能/.test(title)) {
        // \resumeSubItem{\textbf{专业技能：}...}
        const subRe = /\\resumeSubItem\s*\{/g; let sm;
        const lines = [];
        while ((sm = subRe.exec(sec.body))) {
          const g = readBraceGroups(sec.body, sm.index + sm[0].length - 1, 1);
          if (g.groups[0]) lines.push(cleanInline(g.groups[0]));
        }
        const joined = lines.join('\n');
        const cet4 = joined.match(/CET-?4[：:\s]*(\d{3})/i); if (cet4) draft.skill.cet4 = cet4[1];
        const cet6 = joined.match(/CET-?6[：:\s]*(\d{3})/i); if (cet6) draft.skill.cet6 = cet6[1];
        draft.skill.skills = joined;
      } else if (/获奖|荣誉|奖/.test(title)) {
        const subRe = /\\resumeSubItem\s*\{/g; let sm;
        while ((sm = subRe.exec(sec.body))) {
          const rawGroup = g0(sec.body, sm);
          if (!rawGroup) continue;
          // 级别来自 \textit{...} 或 \hfill 之后；先抽出来并从原文剔除
          const levelM = rawGroup.match(/\\textit\{([^}]*)\}/);
          const level = levelM ? cleanInline(levelM[1]) : '';
          let body = rawGroup.replace(/\\hfill/g, '').replace(/\\textit\{[^}]*\}/g, '');
          const text = cleanInline(body);
          if (!text) continue;
          // 用 "——/—/--" 分隔「名称」和「时间」
          let name = text, date = '';
          const dm = text.match(/\s*(?:——|—|--)\s*(.+)$/);
          if (dm) { name = text.slice(0, dm.index).trim(); date = dm[1].trim(); }
          draft.award.push({ awardName: name, awardDate: date, awardLevel: level });
        }
      }
    }

    // 清掉空分组
    for (const k of ['education', 'work', 'project', 'award']) if (draft[k].length === 0) delete draft[k];
    if (Object.keys(draft.skill).length === 0) delete draft.skill;
    if (Object.keys(draft.basic).length === 0) delete draft.basic;
    return draft;
  }

  // ---------- 正则抽字段 ----------
  function extractFields(text) {
    const draft = { basic: {}, education: [], skill: {} };
    // PDF 文本层常在汉字之间插入空格；先把「汉字 空格 汉字」里的空格去掉，提升中文命中率
    let t = text.replace(/([一-龥])\s+(?=[一-龥])/g, '$1');
    t = t.replace(/\s+/g, ' ');

    // 手机号
    const phone = t.match(/(?<!\d)(1[3-9]\d{9})(?!\d)/);
    if (phone) draft.basic.phone = phone[1];

    // 邮箱
    const email = t.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (email) draft.basic.email = email[0];

    // 身份证（18 位）
    const id = t.match(/(?<!\d)(\d{17}[\dXx])(?!\d)/);
    if (id) draft.basic.idCard = id[1].toUpperCase();

    // 出生日期（1990-01 / 1990.01 / 1990年1月）
    const birth = t.match(/(19|20)\d{2}[-.年](0?[1-9]|1[0-2])([-.月](0?[1-9]|[12]\d|3[01]))?/);
    // 不强绑定为出生日期（易误），仅作参考，不自动填

    // GPA / 绩点
    const gpa = t.match(/(?:GPA|绩点|平均学分绩?点?|均分)[^\d]{0,6}(\d(?:\.\d{1,2})?)(?:\s*\/\s*(\d(?:\.\d)?))?/i);
    if (gpa) draft.education.push({ gpa: gpa[2] ? `${gpa[1]}/${gpa[2]}` : gpa[1] });

    // 四六级
    const cet4 = t.match(/(?:CET-?4|四级)[^\d]{0,6}(\d{3})/i);
    const cet6 = t.match(/(?:CET-?6|六级)[^\d]{0,6}(\d{3})/i);
    if (cet4) draft.skill.cet4 = cet4[1];
    if (cet6) draft.skill.cet6 = cet6[1];

    // 学校（匹配常见「XX大学/XX学院」）
    const school = t.match(/([一-龥]{2,10}(?:大学|学院|理工|交通大学|师范大学))/);
    if (school) {
      if (!draft.education[0]) draft.education.push({});
      draft.education[0].school = school[1];
    }

    // 学历关键词
    const degree = t.match(/(博士|硕士|本科|学士|大专|专科)/);
    if (degree) {
      if (!draft.education[0]) draft.education.push({});
      const map = { 学士: '本科', 专科: '大专' };
      draft.education[0].degree = map[degree[1]] || degree[1];
    }

    // 姓名：很难可靠正则识别，交给用户填。此处尝试「姓名：XX」显式模式
    const name = text.match(/姓\s*名[:：]\s*([一-龥·]{2,6})/);
    if (name) draft.basic.name = name[1];

    // 合并 education 里重复的空对象到第 0 条
    if (draft.education.length > 1) {
      const merged = Object.assign({}, ...draft.education);
      draft.education = [merged];
    }
    // 清掉空分组
    if (Object.keys(draft.skill).length === 0) delete draft.skill;
    if (draft.education.length === 0) delete draft.education;
    if (Object.keys(draft.basic).length === 0) delete draft.basic;

    return draft;
  }

  async function parseResume(file) {
    const name = (file.name || '').toLowerCase();
    let text = '';
    if (name.endsWith('.tex')) {
      // .tex 优先走结构化解析（教育/实习/项目/奖项成条抽取）；抽到实质内容就直接返回
      const raw = await readFileText(file);
      const structured = parseTexStructured(raw);
      const hasRich = (structured.education || structured.work || structured.project || structured.award);
      if (hasRich) return structured;
      // 结构化没抽到东西，退回纯文本正则
      text = texToText(raw);
    } else if (name.endsWith('.pdf')) text = await pdfToText(file);
    else if (name.endsWith('.docx')) text = await docxToText(file);
    else text = await readFileText(file); // txt / md / 其他纯文本

    if (!text || text.trim().length < 10) {
      throw new Error('未能从文件提取到文本（可能是扫描版/图片 PDF）。请改用 .tex 或手动录入。');
    }
    const draft = extractFields(text);
    // 中文 PDF 常因字体缺少 ToUnicode 映射导致汉字丢失：检测并给出提示
    const hasCJK = /[一-龥]/.test(text);
    if (name.endsWith('.pdf') && !hasCJK) {
      draft.__warning__ =
        '该 PDF 未能提取出中文（常见于用特殊中文字体编译的 PDF）。已抽取英文/数字字段；中文字段请改用 .tex 源文件解析或手动填写。';
    }
    return draft;
  }

  global.AH_ResumeParser = {
    parseResume,
    extractFields, // 导出供测试
    texToText,
    parseTexStructured, // 导出供测试
  };
})(typeof window !== 'undefined' ? window : self);
