// ai-matcher.js — AI 辅助字段匹配（OpenAI 兼容接口，用户自带 key）
// 挂到全局 window.AH_AI，被 content.js 在「🤖 AI 辅助填写」时调用。
//
// 隐私原则：只把【页面字段标签】+【信息库字段名清单】发给模型做语义对齐，
// 绝不发送任何字段的真实值（身份证/手机号等一律不出浏览器）。
//
// 用法：
//   const mappings = await AH_AI.matchByLLM(pageFields, schemaFields, cfg)
//   pageFields:   [{ id, label }]          —— 页面上待匹配元素的标签
//   schemaFields: [{ key, label }]         —— 信息库字段（key = "group.field"）
//   cfg:          { baseUrl, apiKey, model }
//   返回:         [{ pageId, fieldKey }]    —— 仅包含模型有把握的映射

(function (global) {
  // 规整 base_url：允许用户填到 /v1 或根地址，统一拼出 /chat/completions
  function buildEndpoint(baseUrl) {
    let b = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!b) throw new Error('未配置 API 地址');
    if (/\/chat\/completions$/.test(b)) return b;
    if (/\/v\d+$/.test(b)) return b + '/chat/completions';
    // 没带版本号的根地址：默认补 /v1/chat/completions（OpenAI 兼容惯例）
    return b + '/v1/chat/completions';
  }

  // 从模型返回文本里稳健提取 JSON（剥 ```json 围栏、取第一个 {...}）
  function parseJsonLoose(text) {
    if (!text) return null;
    let t = String(text).trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try { return JSON.parse(t); } catch (e) { /* 继续兜底 */ }
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) { /* 放弃 */ } }
    return null;
  }

  function buildMessages(pageFields, schemaFields) {
    const system = [
      '你是表单字段语义对齐助手。给你两份清单：',
      '1) 网页表单里待填字段的标签（pageFields，每项有 id 和 label）；',
      '2) 用户信息库里的字段（schemaFields，每项有 key 和 label，key 形如 "group.field"）。',
      '任务：判断每个网页字段最可能对应信息库里的哪个字段。',
      '规则：',
      '- 只做语义对齐，绝不编造任何值；',
      '- 没有足够把握的网页字段直接跳过，不要勉强映射；',
      '- 一个信息库字段最多对应一个网页字段；',
      '- 严格只输出 JSON，格式：{"mappings":[{"pageId":"<id>","fieldKey":"<group.field>"}]}，不要任何解释文字。',
    ].join('\n');
    const user = JSON.stringify({ pageFields, schemaFields });
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  async function matchByLLM(pageFields, schemaFields, cfg) {
    if (!cfg || !cfg.apiKey) throw new Error('未配置 API Key');
    if (!cfg.model) throw new Error('未配置模型名');
    if (!Array.isArray(pageFields) || !pageFields.length) return [];

    const endpoint = buildEndpoint(cfg.baseUrl);
    const body = {
      model: cfg.model,
      messages: buildMessages(pageFields, schemaFields),
      temperature: 0,
      response_format: { type: 'json_object' },
    };

    let resp;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error('网络请求失败：' + e.message);
    }

    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 200); } catch (e) { /* ignore */ }
      // 部分服务不支持 response_format，再退一次（去掉该字段重试）
      if (resp.status === 400 && /response_format/i.test(detail)) {
        delete body.response_format;
        const r2 = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
          body: JSON.stringify(body),
        });
        if (!r2.ok) throw new Error(`接口错误 ${r2.status}`);
        resp = r2;
      } else {
        throw new Error(`接口错误 ${resp.status}${detail ? '：' + detail : ''}`);
      }
    }

    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '';
    const parsed = parseJsonLoose(content);
    if (!parsed || !Array.isArray(parsed.mappings)) return [];

    // 过滤：pageId 和 fieldKey 必须在传入清单里存在，防止模型瞎编
    const pageIds = new Set(pageFields.map((p) => String(p.id)));
    const fieldKeys = new Set(schemaFields.map((f) => String(f.key)));
    const out = [];
    const usedFields = new Set();
    for (const m of parsed.mappings) {
      if (!m || m.pageId == null || !m.fieldKey) continue;
      const pid = String(m.pageId), fk = String(m.fieldKey);
      if (!pageIds.has(pid) || !fieldKeys.has(fk)) continue;
      if (usedFields.has(fk)) continue; // 一个库字段只用一次
      usedFields.add(fk);
      out.push({ pageId: pid, fieldKey: fk });
    }
    return out;
  }

  global.AH_AI = {
    matchByLLM,
    buildEndpoint,   // 导出供测试
    parseJsonLoose,  // 导出供测试
  };
})(typeof window !== 'undefined' ? window : self);
