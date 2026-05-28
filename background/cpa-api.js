// background/cpa-api.js — CLIProxyAPI (CPA) 管理接口封装
//
// 涉及 3 个端点（来自 CLIProxyAPI 仓库 internal/api/server.go）：
//   - GET  /v0/management/auth-files       列出所有账号（带 unavailable 字段）
//   - GET  /v0/management/codex-auth-url   获取一个新的 OAuth 授权 URL
//   - POST /v0/management/oauth-callback   提交 localhost 回调 URL
//
// 鉴权：Authorization: Bearer <managementKey>

(function attachCpaApi(root) {
  if (root.__CPA_REAUTH_CPA_API_BOOTED) return;
  root.__CPA_REAUTH_CPA_API_BOOTED = true;

  function trim(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeBaseUrl(baseUrl) {
    const raw = trim(baseUrl);
    if (!raw) {
      throw new Error('CPA 地址未配置。');
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error('CPA 地址格式无效。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('CPA 地址必须是 http(s)。');
    }
    return parsed.origin;
  }

  async function fetchCpaJson(baseUrl, path, options = {}) {
    const origin = normalizeBaseUrl(baseUrl);
    const managementKey = trim(options.managementKey);
    if (!managementKey) {
      throw new Error('CPA 管理密钥未配置。');
    }
    const method = (options.method || 'GET').toUpperCase();
    const url = `${origin}${path}`;
    const headers = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${managementKey}`,
    };
    const init = {
      method,
      headers,
      cache: 'no-store',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 20000;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    if (controller) init.signal = controller.signal;

    try {
      const resp = await fetch(url, init);
      const text = await resp.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      if (!resp.ok) {
        const detail = payload?.error || payload?.message || payload?.detail || text || `HTTP ${resp.status}`;
        const err = new Error(`CPA ${method} ${path} 失败 (HTTP ${resp.status})：${detail}`);
        err.status = resp.status;
        err.payload = payload;
        throw err;
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`CPA ${method} ${path} 超时（${timeoutMs}ms）。`);
      }
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /**
   * 列出所有 auth-files。返回 `{ files: [...] }`。
   * 每条 file 含：id, name, provider, email, status, status_message, disabled, unavailable, ...
   */
  async function listAuthFiles(settings) {
    const payload = await fetchCpaJson(settings.baseUrl, '/v0/management/auth-files', {
      managementKey: settings.managementKey,
      timeoutMs: 25000,
    });
    return Array.isArray(payload?.files) ? payload.files : [];
  }

  /**
   * 从所有 auth-files 里筛选 provider=codex 且 unavailable=true 的邮箱集合（**仅读缓存**）。
   * 返回去重邮箱数组（小写，按字典序）。
   *
   * 注意：这只是 CPA 端的「缓存视图」—— CPA 在 token 刷新失败时会把账号标为 unavailable=true，
   * 但这条记录可能是陈旧的（实际可能已经恢复 / 或者 unavailable=false 的账号实际也已经失效）。
   * 真正决定要不要重新授权，应该用 `probeAllCodexCandidates()` 实地探测。
   */
  function pickReauthCandidatesFromAuthFiles(files) {
    const set = new Set();
    for (const file of files) {
      if (!file || typeof file !== 'object') continue;
      const provider = String(file.provider || file.type || '').toLowerCase();
      if (provider !== 'codex') continue;
      if (file.unavailable !== true) continue;
      const email = String(file.email || file.account || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      set.add(email);
    }
    return Array.from(set).sort();
  }

  /**
   * 收集所有 codex auth-file 用于实地探测：返回 { authIndex, email, accountId, unavailable, statusMessage }
   * 数组（按邮箱去重；同邮箱多条时保留 unavailable=true 优先 / authIndex 较小者）。
   * accountId 来自 id_token.chatgpt_account_id（codex 凭证里都有）。
   */
  function pickCodexCandidatesForProbing(files) {
    const byEmail = new Map();
    for (const file of files) {
      if (!file || typeof file !== 'object') continue;
      const provider = String(file.provider || file.type || '').toLowerCase();
      if (provider !== 'codex') continue;
      const email = String(file.email || file.account || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      const authIndex = String(file.auth_index || file.authIndex || file.id || '').trim();
      if (!authIndex) continue;
      const idToken = file.id_token || file.idToken || {};
      const accountId = String(idToken?.chatgpt_account_id || idToken?.chatgptAccountId || '').trim();
      const entry = {
        authIndex,
        email,
        accountId,
        unavailable: file.unavailable === true,
        statusMessage: String(file.status_message || file.statusMessage || '').trim(),
        name: String(file.name || '').trim(),
      };
      const prev = byEmail.get(email);
      if (!prev) {
        byEmail.set(email, entry);
        continue;
      }
      // 同邮箱多条：unavailable=true 优先
      if (entry.unavailable && !prev.unavailable) byEmail.set(email, entry);
    }
    return Array.from(byEmail.values()).sort((a, b) => a.email.localeCompare(b.email));
  }

  // ---------- 探测：判断 codex 账号是真死还是只是额度超 ----------
  //
  // 与 CPA 官方管理面板（cpamc.router-for.me）一致：
  // POST /v0/management/api-call → 让 CPA 用该账号的 access_token 实地请求
  //   GET https://chatgpt.com/backend-api/wham/usage
  // 然后根据 upstream 的 status_code + body 文本来判定。

  const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
  const CODEX_USAGE_USER_AGENT = 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal';

  // 把 wham/usage 的探测结果分类为：healthy / quota_exceeded / needs_reauth / unknown
  //
  // 用户给的规则：
  //   - 2xx：账号正常
  //   - 429 或正文含「额度超」类关键字：仅 quota，不算异常
  //   - 401/403：典型的「凭证失效」→ 异常，需要重新授权
  //   - 其它（404 / 5xx / api-call 本身报错）：按用户「只要不是额度超的都算异常」从严归入 needs_reauth
  // apiCallOk=false 表示我们调 CPA /api-call 本身就失败了（CPA 不可达 / 鉴权失败 / token 刷新失败）
  //   → 信息不够，归 unknown，不冒险拉去重新授权
  function classifyCodexProbeResult({ apiCallOk, statusCode, body }) {
    if (apiCallOk === false) {
      return { status: 'unknown', reason: 'api-call-failed' };
    }
    const code = Number(statusCode);
    const text = String(body == null ? '' : body).toLowerCase();
    const looksLikeQuota = /rate.?limit|quota.?exceeded|usage.?limit|too.?many.?requests|insufficient.?quota|over.?(?:the\s+)?usage/i.test(text);
    if (code === 429 || looksLikeQuota) {
      return { status: 'quota_exceeded', reason: code === 429 ? '429' : 'body-quota' };
    }
    if (code >= 200 && code < 300) {
      return { status: 'healthy', reason: `${code}` };
    }
    if (code === 401 || code === 403) {
      return { status: 'needs_reauth', reason: `${code}` };
    }
    if (!Number.isFinite(code) || code <= 0) {
      return { status: 'unknown', reason: 'no-status-code' };
    }
    // 用户口径：只要不是额度超的都算异常
    return { status: 'needs_reauth', reason: `status-${code}` };
  }

  /**
   * 用 api-call 实地探测一个 codex 账号。
   * @param {Object} settings
   * @param {{authIndex:string, accountId?:string, email:string}} cand
   * @param {Object} [opts]
   *   @param {number} [opts.timeoutMs=20000]
   * @returns {Promise<{apiCallOk:boolean, statusCode:number, body:string, classification:{status,reason}, error?:string}>}
   */
  async function probeCodexAccount(settings, cand, opts = {}) {
    const headers = {
      'Authorization': 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      'User-Agent': CODEX_USAGE_USER_AGENT,
    };
    if (cand.accountId) headers['Chatgpt-Account-Id'] = cand.accountId;
    try {
      const payload = await fetchCpaJson(settings.baseUrl, '/v0/management/api-call', {
        method: 'POST',
        managementKey: settings.managementKey,
        timeoutMs: opts.timeoutMs || 20000,
        body: {
          auth_index: cand.authIndex,
          method: 'GET',
          url: CODEX_USAGE_URL,
          header: headers,
        },
      });
      const statusCode = Number(payload?.status_code ?? payload?.statusCode ?? 0);
      const body = String(payload?.body ?? '');
      const classification = classifyCodexProbeResult({ apiCallOk: true, statusCode, body });
      return { apiCallOk: true, statusCode, body, classification };
    } catch (error) {
      const detail = String(error?.message || error || '');
      // 422 这种 CPA 端拒绝（"auth token refresh failed" 等）就是典型的「该账号 token 死了」
      const isTokenRefreshFailed = /auth token refresh failed|auth token not found/i.test(detail);
      const classification = isTokenRefreshFailed
        ? { status: 'needs_reauth', reason: 'cpa-token-refresh-failed' }
        : classifyCodexProbeResult({ apiCallOk: false });
      return {
        apiCallOk: false,
        statusCode: 0,
        body: '',
        classification,
        error: detail,
      };
    }
  }

  /**
   * 串行 + 限并发地探测一批 candidates。
   * @param {Object} settings
   * @param {Array<{authIndex,email,accountId}>} candidates
   * @param {Object} [opts]
   *   @param {number} [opts.concurrency=4]
   *   @param {(progress:{index:number,total:number,cand:object,result:object}) => any} [opts.onProgress]
   *   @param {() => boolean} [opts.shouldStop]   stop 信号源
   * @returns {Promise<{results: Array, summary: {healthy,quotaExceeded,needsReauth,unknown,aborted}}>}
   */
  async function probeAllCodexCandidates(settings, candidates, opts = {}) {
    const concurrency = Math.max(1, Math.min(8, Number(opts.concurrency) || 4));
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : () => false;
    const total = candidates.length;
    const results = new Array(total);
    const summary = { healthy: 0, quotaExceeded: 0, needsReauth: 0, unknown: 0, aborted: 0 };
    let nextIdx = 0;
    let stopped = false;

    async function worker() {
      while (!stopped) {
        const i = nextIdx;
        nextIdx += 1;
        if (i >= total) return;
        if (shouldStop()) {
          stopped = true;
          summary.aborted += 1;
          return;
        }
        const cand = candidates[i];
        const probe = await probeCodexAccount(settings, cand);
        results[i] = { cand, ...probe };
        switch (probe.classification.status) {
          case 'healthy': summary.healthy += 1; break;
          case 'quota_exceeded': summary.quotaExceeded += 1; break;
          case 'needs_reauth': summary.needsReauth += 1; break;
          default: summary.unknown += 1; break;
        }
        if (onProgress) {
          try { await onProgress({ index: i, total, cand, result: results[i] }); } catch {}
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
    await Promise.all(workers);
    // 把 stop 之后留下的空位补上 unknown 占位，避免外层 result.map 炸
    for (let i = 0; i < total; i += 1) {
      if (!results[i]) results[i] = { cand: candidates[i], apiCallOk: false, statusCode: 0, body: '', classification: { status: 'unknown', reason: 'aborted' } };
    }
    return { results, summary };
  }

  /**
   * 请求一个新的 OAuth 授权 URL。
   * 返回 { oauthUrl, oauthState, cpaOrigin }
   */
  async function requestCodexAuthUrl(settings) {
    const payload = await fetchCpaJson(settings.baseUrl, '/v0/management/codex-auth-url', {
      managementKey: settings.managementKey,
      timeoutMs: 20000,
    });
    const oauthUrl = String(
      payload?.url
      || payload?.auth_url
      || payload?.authUrl
      || payload?.data?.url
      || payload?.data?.auth_url
      || payload?.data?.authUrl
      || ''
    ).trim();
    if (!oauthUrl || !/^https?:\/\//i.test(oauthUrl)) {
      throw new Error('CPA codex-auth-url 接口未返回有效 url。');
    }
    let oauthState = String(
      payload?.state
      || payload?.auth_state
      || payload?.authState
      || payload?.data?.state
      || payload?.data?.auth_state
      || ''
    ).trim();
    if (!oauthState) {
      try {
        oauthState = new URL(oauthUrl).searchParams.get('state') || '';
      } catch {
        oauthState = '';
      }
    }
    return {
      oauthUrl,
      oauthState,
      cpaOrigin: normalizeBaseUrl(settings.baseUrl),
    };
  }

  /**
   * 提交 localhost OAuth 回调 URL 给 CPA，让它换取 token 写盘。
   * 返回 200 即认为重新授权成功。
   */
  async function submitOAuthCallback(settings, callbackUrl) {
    const url = String(callbackUrl || '').trim();
    if (!url) throw new Error('回调 URL 为空，无法上报。');
    const payload = await fetchCpaJson(settings.baseUrl, '/v0/management/oauth-callback', {
      method: 'POST',
      managementKey: settings.managementKey,
      timeoutMs: 30000,
      body: {
        provider: 'codex',
        redirect_url: url,
      },
    });
    return {
      ok: true,
      raw: payload,
      message: String(payload?.message || payload?.status_message || '已上报回调').trim(),
    };
  }

  /**
   * 给前端的连通性快速探测：调一下 auth-files，能拿到 200 就说明 url + key 配置正确。
   * 返回 { ok, totalAccounts, codexUnavailable } 或 { ok:false, error }。
   */
  async function pingCpa(settings) {
    try {
      const files = await listAuthFiles(settings);
      const candidates = pickReauthCandidatesFromAuthFiles(files);
      return {
        ok: true,
        totalAccounts: files.length,
        codexCount: files.filter((f) => String(f.provider || f.type || '').toLowerCase() === 'codex').length,
        codexUnavailable: candidates.length,
      };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  root.CpaReauthApi = {
    normalizeBaseUrl,
    listAuthFiles,
    pickReauthCandidatesFromAuthFiles,
    pickCodexCandidatesForProbing,
    classifyCodexProbeResult,
    probeCodexAccount,
    probeAllCodexCandidates,
    requestCodexAuthUrl,
    submitOAuthCallback,
    pingCpa,
  };
})(typeof self !== 'undefined' ? self : globalThis);
