// background/cookie-cleanup.js — 清理 ChatGPT / OpenAI cookies
//
// 每个邮箱开跑前都会调一次，避免上一个账号的 session cookie 让 OpenAI 在新轮里
// 直接判定为「已登录」跳过登录页。逻辑参考 FlowPilot 主项目 step 1 的做法：
// 列出几个相关域名 + 所有 cookie store，按 domain == target 或 endsWith('.target')
// 命中后逐个 remove。
//
// 注意：必须用 chrome.cookies.remove 的 url 字段构造正确的 https URL（仅 host+path
// 不带 query），否则 Chrome 会按 url 的 scheme/host/path 解析出错。

(function attachCpaCookieCleanup(root) {
  if (root.__CPA_REAUTH_COOKIE_CLEANUP_BOOTED) return;
  root.__CPA_REAUTH_COOKIE_CLEANUP_BOOTED = true;

  const CLEAR_DOMAINS = Object.freeze([
    'chatgpt.com',
    'chat.openai.com',
    'openai.com',
    'auth.openai.com',
    'auth0.openai.com',
    'accounts.openai.com',
  ]);

  function normalizeDomain(domain) {
    return String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
  }

  function shouldClearCookie(cookie) {
    const domain = normalizeDomain(cookie?.domain);
    if (!domain) return false;
    return CLEAR_DOMAINS.some((target) => domain === target || domain.endsWith(`.${target}`));
  }

  function buildCookieKey(cookie, fallbackStoreId = '') {
    return [
      cookie?.storeId || fallbackStoreId || '',
      cookie?.domain || '',
      cookie?.path || '',
      cookie?.name || '',
      cookie?.partitionKey ? JSON.stringify(cookie.partitionKey) : '',
    ].join('|');
  }

  function buildRemovalUrl(cookie) {
    const host = normalizeDomain(cookie?.domain);
    const rawPath = String(cookie?.path || '/');
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    return `https://${host}${path}`;
  }

  async function collectCookies(chromeApi) {
    if (!chromeApi?.cookies?.getAll) return [];

    const stores = chromeApi.cookies.getAllCookieStores
      ? await chromeApi.cookies.getAllCookieStores().catch(() => [{ id: undefined }])
      : [{ id: undefined }];
    const cookies = [];
    const seen = new Set();

    for (const store of stores) {
      const storeId = store?.id;
      for (const domain of CLEAR_DOMAINS) {
        let batch = [];
        try {
          batch = await chromeApi.cookies.getAll(
            storeId ? { storeId, domain } : { domain }
          );
        } catch (err) {
          console.warn('[CpaReauth:cookie-cleanup] getAll failed', { storeId, domain, err: err?.message || err });
          continue;
        }
        for (const cookie of batch || []) {
          if (!shouldClearCookie(cookie)) continue;
          const key = buildCookieKey(cookie, storeId);
          if (seen.has(key)) continue;
          seen.add(key);
          cookies.push(cookie);
        }
      }
    }
    return cookies;
  }

  async function removeOne(chromeApi, cookie) {
    const details = {
      url: buildRemovalUrl(cookie),
      name: cookie.name,
    };
    if (cookie.storeId) details.storeId = cookie.storeId;
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    try {
      const result = await chromeApi.cookies.remove(details);
      return Boolean(result);
    } catch (err) {
      console.warn('[CpaReauth:cookie-cleanup] remove failed', {
        domain: cookie?.domain,
        name: cookie?.name,
        err: err?.message || err,
      });
      return false;
    }
  }

  /**
   * 清理 ChatGPT / OpenAI cookies。
   * @returns {Promise<{ removedCount: number, totalFound: number, elapsedMs: number, skipped?: string }>}
   */
  async function clearOpenAiCookies() {
    const chromeApi = root.chrome || globalThis.chrome;
    if (!chromeApi?.cookies?.getAll || !chromeApi?.cookies?.remove) {
      return { removedCount: 0, totalFound: 0, elapsedMs: 0, skipped: 'cookies API not available' };
    }
    const startedAt = Date.now();
    const cookies = await collectCookies(chromeApi);
    let removedCount = 0;
    for (const cookie of cookies) {
      if (await removeOne(chromeApi, cookie)) {
        removedCount += 1;
      }
    }
    return {
      removedCount,
      totalFound: cookies.length,
      elapsedMs: Date.now() - startedAt,
    };
  }

  root.CpaReauthCookieCleanup = {
    CLEAR_DOMAINS,
    shouldClearCookie,
    normalizeDomain,
    buildRemovalUrl,
    clearOpenAiCookies,
  };
})(typeof self !== 'undefined' ? self : globalThis);
