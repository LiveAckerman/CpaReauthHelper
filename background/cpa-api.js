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
   * 从所有 auth-files 里筛选 provider=codex 且 unavailable=true 的邮箱集合。
   * 返回去重后的邮箱数组（小写，按字典序）。同一个邮箱可能在多个 provider/计划下存在；
   * 这里只关心 codex 失效需要重新授权的那些。
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
    requestCodexAuthUrl,
    submitOAuthCallback,
    pingCpa,
  };
})(typeof self !== 'undefined' ? self : globalThis);
