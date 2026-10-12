// storage.js — chrome.storage.local 封装
// 挂到全局 window.AHStorage，供 options/popup 页通过 <script> 加载后使用。
// 数据模型：
//   profile       —— 个人信息库（单对象，结构见 profile-schema.js）
//   applications  —— 投递记录数组
//   settings      —— 插件设置（如侧边栏默认开关）

(function (global) {
  const KEYS = {
    PROFILE: 'profile',
    APPLICATIONS: 'applications',
    SETTINGS: 'settings',
    CUSTOM_SCHEMA: 'customSchema',
  };

  function get(key, fallback) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (res) => {
        resolve(res && res[key] !== undefined ? res[key] : fallback);
      });
    });
  }

  function set(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => resolve(true));
    });
  }

  const AHStorage = {
    KEYS,

    // ---- 个人信息库 ----
    async getProfile() {
      return get(KEYS.PROFILE, {});
    },
    async saveProfile(profile) {
      return set(KEYS.PROFILE, profile || {});
    },

    // ---- 投递记录 ----
    async getApplications() {
      return get(KEYS.APPLICATIONS, []);
    },
    async saveApplications(list) {
      return set(KEYS.APPLICATIONS, Array.isArray(list) ? list : []);
    },
    async addApplication(record) {
      const list = await this.getApplications();
      const item = Object.assign(
        {
          id: 'app_' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
          company: '',
          position: '',
          date: new Date().toISOString().slice(0, 10),
          status: '已投递',
          url: '',
          note: '',
        },
        record || {}
      );
      list.unshift(item);
      await this.saveApplications(list);
      return item;
    },
    async updateApplication(id, patch) {
      const list = await this.getApplications();
      const idx = list.findIndex((x) => x.id === id);
      if (idx === -1) return null;
      list[idx] = Object.assign({}, list[idx], patch);
      await this.saveApplications(list);
      return list[idx];
    },
    async deleteApplication(id) {
      const list = await this.getApplications();
      const next = list.filter((x) => x.id !== id);
      await this.saveApplications(next);
      return true;
    },

    // ---- 设置 ----
    async getSettings() {
      return get(KEYS.SETTINGS, { autoOpenSidebar: false });
    },
    async saveSettings(s) {
      return set(KEYS.SETTINGS, s || {});
    },

    // ---- 自定义 schema（用户新增的模块/字段结构）----
    async getCustomSchema() {
      return get(KEYS.CUSTOM_SCHEMA, { groups: [] });
    },
    async saveCustomSchema(cs) {
      return set(KEYS.CUSTOM_SCHEMA, cs && Array.isArray(cs.groups) ? cs : { groups: [] });
    },

    // ---- 备份 ----
    async exportAll() {
      const [profile, applications, settings, customSchema] = await Promise.all([
        this.getProfile(),
        this.getApplications(),
        this.getSettings(),
        this.getCustomSchema(),
      ]);
      return {
        __app__: '校招网申助手',
        __version__: 2,
        exportedAt: new Date().toISOString(),
        profile,
        applications,
        settings,
        customSchema,
      };
    },
    async importAll(data) {
      if (!data || typeof data !== 'object') throw new Error('无效的备份数据');
      if (data.profile) await this.saveProfile(data.profile);
      if (Array.isArray(data.applications)) await this.saveApplications(data.applications);
      if (data.settings) await this.saveSettings(data.settings);
      // 兼容旧备份：无 customSchema 字段时视为无自定义，不覆盖已有
      if (data.customSchema && Array.isArray(data.customSchema.groups)) await this.saveCustomSchema(data.customSchema);
      return true;
    },
  };

  global.AHStorage = AHStorage;
})(typeof window !== 'undefined' ? window : self);
