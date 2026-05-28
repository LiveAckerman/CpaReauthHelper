// shared/constants.js — 项目级共享常量
// 同时被 background service worker 和 content script 加载，
// 暴露在 self (= window/globalThis) 上方便互相访问。

(function attachCpaReauthConstants(root) {
  if (root.__CPA_REAUTH_CONSTANTS_BOOTED) {
    return;
  }
  root.__CPA_REAUTH_CONSTANTS_BOOTED = true;

  // 邮箱状态枚举 —— 用于侧栏渲染 + 进度持久化
  root.CPA_EMAIL_STATUS = Object.freeze({
    PENDING: 'pending',
    RUNNING: 'running',
    SUCCESS: 'success',
    FAILED: 'failed',
    SKIPPED: 'skipped',
  });

  // 邮箱来源 —— 自动从 CPA 拉的 vs 用户手动粘的
  root.CPA_EMAIL_SOURCE = Object.freeze({
    AUTO: 'auto',
    MANUAL: 'manual',
  });

  // 单个邮箱整体流程超时（毫秒），超过这个时长还没拿到 oauth-callback 200 就判失败
  root.CPA_PER_EMAIL_TIMEOUT_MS = 5 * 60 * 1000;

  // OAuth 授权流程里 OpenAI 各阶段轮询/超时参数
  root.CPA_AUTH_PAGE_READY_TIMEOUT_MS = 30 * 1000;
  root.CPA_FILL_EMAIL_TIMEOUT_MS = 25 * 1000;
  root.CPA_FILL_PASSWORD_TIMEOUT_MS = 25 * 1000;
  root.CPA_EMAIL_VERIFICATION_WAIT_TIMEOUT_MS = 90 * 1000;
  root.CPA_OAUTH_CONSENT_TIMEOUT_MS = 30 * 1000;
  // 同意按钮点完后等 localhost 回调的最长时间。listener 在 tab 开打就早注册了
  // （早注册是为了兜底某些场景 OAuth 自动跳过同意页），所以该 timeout 只在
  // 「同意点完到 localhost 跳转」这一小段时间生效；120s 已经非常宽裕。
  root.CPA_LOCALHOST_CALLBACK_TIMEOUT_MS = 120 * 1000;
  root.CPA_MAIL2925_INBOX_URL = 'https://www.2925.com/';

  // 一批邮箱跑完后给用户的"冷却时间"（CPA 风控/OpenAI 风控缓冲）
  root.CPA_BETWEEN_EMAILS_DELAY_MS = 3000;

  // CPA 默认 localhost 回调端口（与 CLIProxyAPI 仓库里 codexCallbackPort 对齐）
  root.CPA_CALLBACK_PORT = 1455;

  // 内容脚本 ↔ background 消息类型
  root.CPA_MSG = Object.freeze({
    // background → content (openai)
    EXECUTE_FILL_EMAIL: 'CPA_EXECUTE_FILL_EMAIL',
    EXECUTE_FILL_PASSWORD: 'CPA_EXECUTE_FILL_PASSWORD',
    EXECUTE_FILL_VERIFICATION_CODE: 'CPA_EXECUTE_FILL_VERIFICATION_CODE',
    EXECUTE_CONFIRM_OAUTH: 'CPA_EXECUTE_CONFIRM_OAUTH',
    INSPECT_AUTH_PAGE: 'CPA_INSPECT_AUTH_PAGE',

    // background → content (2925)
    FETCH_2925_CODE: 'CPA_FETCH_2925_CODE',
    INSPECT_2925_INBOX: 'CPA_INSPECT_2925_INBOX',
    DELETE_2925_MAIL: 'CPA_DELETE_2925_MAIL',

    STOP: 'CPA_STOP_BATCH',

    // sidebar → background
    GET_STATE: 'CPA_GET_STATE',
    UPDATE_SETTINGS: 'CPA_UPDATE_SETTINGS',
    FETCH_UNAVAILABLE_EMAILS: 'CPA_FETCH_UNAVAILABLE_EMAILS',
    START_BATCH: 'CPA_START_BATCH',
    STOP_BATCH: 'CPA_STOP_BATCH_REQUEST',
    RETRY_FAILED: 'CPA_RETRY_FAILED',
    CLEAR_PROGRESS: 'CPA_CLEAR_PROGRESS',
    REMOVE_EMAIL_ENTRY: 'CPA_REMOVE_EMAIL_ENTRY',

    // background → sidebar (broadcast)
    STATE_UPDATED: 'CPA_STATE_UPDATED',
    LOG_APPEND: 'CPA_LOG_APPEND',
  });

  // 持久化 key
  root.CPA_STORAGE_KEYS = Object.freeze({
    SETTINGS: 'cpa_settings',          // chrome.storage.local
    PROGRESS: 'cpa_batch_progress',    // chrome.storage.local（中断恢复）
    LOGS: 'cpa_recent_logs',           // chrome.storage.session
    RUNNING: 'cpa_batch_running',      // chrome.storage.session
  });
})(typeof self !== 'undefined' ? self : globalThis);
