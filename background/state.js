// background/state.js — 全局状态层
//
// 三块存储：
//   1. settings  → chrome.storage.local  (CPA url/key、密码、回调方式、邮箱来源)
//   2. progress  → chrome.storage.local  (邮箱列表 + 各邮箱状态，中断恢复用)
//   3. running   → chrome.storage.session(当前正在跑哪个邮箱、log、运行 flag)

(function attachCpaState(root) {
  if (root.__CPA_REAUTH_STATE_BOOTED) return;
  root.__CPA_REAUTH_STATE_BOOTED = true;

  const { CPA_STORAGE_KEYS, CPA_EMAIL_STATUS, CPA_EMAIL_SOURCE } = root;

  const DEFAULT_SETTINGS = Object.freeze({
    baseUrl: '',
    managementKey: '',
    sharedPassword: '',
    emailSource: CPA_EMAIL_SOURCE.AUTO,  // 'auto' 或 'manual'
    manualEmailsText: '',                // 手动模式下的多行文本（按换行切）
    callbackMode: 'local',               // 暂时只支持 local；UI 上有切换位预留
  });

  const DEFAULT_PROGRESS = Object.freeze({
    // 邮箱条目结构：{ email, status, attempts, lastError, lastUpdatedAt }
    entries: [],
    // 全局 batch 信息
    startedAt: 0,
    finishedAt: 0,
  });

  const DEFAULT_RUNNING = Object.freeze({
    isRunning: false,
    currentEmail: '',
    currentStep: '',         // 'fetching_url' / 'waiting_login' / 'fill_email' / 'fill_password' / ...
    currentAuthTabId: 0,
    currentOauthState: '',
    sessionId: 0,
    logs: [],                // 最近若干条日志（环形截断）
  });

  function clone(obj) {
    return obj == null ? obj : JSON.parse(JSON.stringify(obj));
  }

  async function getSettings() {
    const data = await chrome.storage.local.get([CPA_STORAGE_KEYS.SETTINGS]);
    return { ...DEFAULT_SETTINGS, ...(data[CPA_STORAGE_KEYS.SETTINGS] || {}) };
  }

  async function setSettings(updates) {
    const current = await getSettings();
    const next = { ...current, ...updates };
    await chrome.storage.local.set({ [CPA_STORAGE_KEYS.SETTINGS]: next });
    return next;
  }

  async function getProgress() {
    const data = await chrome.storage.local.get([CPA_STORAGE_KEYS.PROGRESS]);
    return { ...DEFAULT_PROGRESS, ...(data[CPA_STORAGE_KEYS.PROGRESS] || {}) };
  }

  async function setProgress(progress) {
    await chrome.storage.local.set({ [CPA_STORAGE_KEYS.PROGRESS]: progress });
    return progress;
  }

  async function clearProgress() {
    return setProgress(clone(DEFAULT_PROGRESS));
  }

  async function getRunning() {
    const data = await chrome.storage.session.get([CPA_STORAGE_KEYS.RUNNING]);
    return { ...DEFAULT_RUNNING, ...(data[CPA_STORAGE_KEYS.RUNNING] || {}) };
  }

  async function setRunning(updates) {
    const current = await getRunning();
    const next = { ...current, ...updates };
    await chrome.storage.session.set({ [CPA_STORAGE_KEYS.RUNNING]: next });
    return next;
  }

  async function clearRunning() {
    return setRunning(clone(DEFAULT_RUNNING));
  }

  // 从邮箱列表里移除指定邮箱。返回 { ok, removed, remaining, reason? }。
  // reason='running' 时拒绝删（避免在正在跑的邮箱底下抽地毯）。
  async function removeEntry(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return { ok: false, removed: 0, reason: 'invalid-email' };
    const progress = await getProgress();
    const entries = Array.isArray(progress.entries) ? progress.entries.slice() : [];
    const idx = entries.findIndex((e) => e?.email === normalizedEmail);
    if (idx < 0) return { ok: false, removed: 0, reason: 'not-found' };
    if (entries[idx]?.status === CPA_EMAIL_STATUS.RUNNING) {
      return { ok: false, removed: 0, reason: 'running' };
    }
    entries.splice(idx, 1);
    await setProgress({ ...progress, entries });
    return { ok: true, removed: 1, remaining: entries.length };
  }

  // 把一条 entry 的状态原地更新；返回新的 progress。
  async function updateEntry(email, patch) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return getProgress();
    const progress = await getProgress();
    const entries = Array.isArray(progress.entries) ? progress.entries : [];
    const idx = entries.findIndex((e) => e?.email === normalizedEmail);
    const now = Date.now();
    if (idx < 0) {
      entries.push({
        email: normalizedEmail,
        status: CPA_EMAIL_STATUS.PENDING,
        attempts: 0,
        lastError: '',
        lastUpdatedAt: now,
        ...patch,
      });
    } else {
      entries[idx] = { ...entries[idx], ...patch, lastUpdatedAt: now };
    }
    return setProgress({ ...progress, entries });
  }

  // 用一份新邮箱列表初始化 progress，保留已有状态（重新拉列表时合并）。
  async function seedEntries(emails, { source = CPA_EMAIL_SOURCE.AUTO } = {}) {
    const normalized = Array.from(new Set(
      (Array.isArray(emails) ? emails : [])
        .map((e) => String(e || '').trim().toLowerCase())
        .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    )).sort();

    const progress = await getProgress();
    const oldByEmail = new Map((progress.entries || []).map((e) => [e?.email, e]));
    const entries = normalized.map((email) => {
      const old = oldByEmail.get(email);
      if (old && (old.status === CPA_EMAIL_STATUS.SUCCESS || old.status === CPA_EMAIL_STATUS.SKIPPED)) {
        // 保留已经成功/跳过的，不要把它们退回 pending
        return { ...old, source };
      }
      return {
        email,
        status: old?.status === CPA_EMAIL_STATUS.RUNNING ? CPA_EMAIL_STATUS.PENDING : (old?.status || CPA_EMAIL_STATUS.PENDING),
        attempts: old?.attempts || 0,
        lastError: old?.lastError || '',
        lastUpdatedAt: Date.now(),
        source,
      };
    });
    return setProgress({ ...progress, entries });
  }

  function summarizeProgress(progress) {
    const entries = Array.isArray(progress?.entries) ? progress.entries : [];
    const total = entries.length;
    const counts = {
      pending: 0,
      running: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    };
    for (const entry of entries) {
      const status = entry?.status || CPA_EMAIL_STATUS.PENDING;
      if (counts[status] !== undefined) counts[status] += 1;
    }
    return { total, ...counts };
  }

  // 给侧栏一次性拉所有 state（settings + progress + running）
  async function getFullStateForSidebar() {
    const [settings, progress, running] = await Promise.all([
      getSettings(),
      getProgress(),
      getRunning(),
    ]);
    return { settings, progress, running, summary: summarizeProgress(progress) };
  }

  // 日志环形写入（最多保留 200 条）
  async function appendLog(message, level = 'info') {
    const running = await getRunning();
    const logs = Array.isArray(running.logs) ? running.logs : [];
    const next = {
      timestamp: Date.now(),
      level,
      message: String(message || '').slice(0, 500),
    };
    logs.push(next);
    while (logs.length > 200) logs.shift();
    await setRunning({ logs });
    // 实时广播给侧栏
    try {
      chrome.runtime.sendMessage({
        type: root.CPA_MSG.LOG_APPEND,
        payload: next,
      }).catch(() => {});
    } catch {}
    return next;
  }

  async function broadcastStateUpdated() {
    const state = await getFullStateForSidebar();
    try {
      chrome.runtime.sendMessage({
        type: root.CPA_MSG.STATE_UPDATED,
        payload: state,
      }).catch(() => {});
    } catch {}
  }

  root.CpaReauthState = {
    DEFAULT_SETTINGS,
    DEFAULT_PROGRESS,
    DEFAULT_RUNNING,
    getSettings,
    setSettings,
    getProgress,
    setProgress,
    clearProgress,
    getRunning,
    setRunning,
    clearRunning,
    updateEntry,
    removeEntry,
    seedEntries,
    summarizeProgress,
    getFullStateForSidebar,
    appendLog,
    broadcastStateUpdated,
  };
})(typeof self !== 'undefined' ? self : globalThis);
