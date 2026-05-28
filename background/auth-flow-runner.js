// background/auth-flow-runner.js — 单个邮箱的完整 OAuth 重新授权流程
//
// 一个邮箱的全流程：
//   1. CPA GET /v0/management/codex-auth-url → 拿到 oauthUrl + state
//   2. 打开（或复用）一个 tab 跳到 oauthUrl
//   3. 注册 webNavigation 监听，等 tab 跳到 http://localhost:1455/* 时把完整 URL 抓下来
//   4. 同时驱动 content script：填邮箱 → 等密码页 → 填密码 → 等 OAuth 同意页 → 点同意
//   5. localhost 抓到后调 CPA POST /v0/management/oauth-callback
//   6. 200 即视为该邮箱成功

(function attachCpaAuthFlowRunner(root) {
  if (root.__CPA_REAUTH_AUTH_FLOW_BOOTED) return;
  root.__CPA_REAUTH_AUTH_FLOW_BOOTED = true;

  const {
    CpaReauthApi,
    CpaReauthState,
    CPA_MSG,
    CPA_AUTH_PAGE_READY_TIMEOUT_MS,
    CPA_FILL_EMAIL_TIMEOUT_MS,
    CPA_FILL_PASSWORD_TIMEOUT_MS,
    CPA_EMAIL_VERIFICATION_WAIT_TIMEOUT_MS,
    CPA_OAUTH_CONSENT_TIMEOUT_MS,
    CPA_LOCALHOST_CALLBACK_TIMEOUT_MS,
    CPA_PER_EMAIL_TIMEOUT_MS,
    CPA_CALLBACK_PORT,
    CPA_MAIL2925_INBOX_URL,
  } = root;

  // 复用 OpenAI auth 流程的 ChatGPT/OpenAI tab 之外，开一个独立 2925 收件箱 tab。
  // 全局只保留一个；用户关掉了也容忍重开。
  let mail2925TabId = 0;
  async function ensureMail2925Tab() {
    if (mail2925TabId) {
      try {
        const t = await chrome.tabs.get(mail2925TabId);
        if (t?.id) {
          // 已存在，激活让 Vue 应用解除限流（关键：后台 tab Vue 不刷新 inbox）
          await activateTab(mail2925TabId);
          return mail2925TabId;
        }
      } catch {
        mail2925TabId = 0;
      }
    }
    const created = await chrome.tabs.create({
      url: CPA_MAIL2925_INBOX_URL || 'https://www.2925.com/',
      active: true,
    });
    mail2925TabId = created?.id || 0;
    return mail2925TabId;
  }

  // ---------- 标签页管理 ----------
  //
  // 关键决策：所有创建/复用的 tab 都用 active:true。
  // 原因：Chrome 会对后台 tab 限流（requestAnimationFrame、setTimeout、甚至部分
  // webNavigation 事件投递都会受影响）。2925 Vue 应用刷新邮件列表、OAuth 同意
  // 页面跳转到 localhost 这些操作都依赖正常的事件循环。如果 tab 不激活，
  // 我们的 chrome.tabs.sendMessage 还能发，但页面那边 Vue 不重渲染、
  // chrome.webNavigation 延迟投递，看起来就像「卡住」。
  // 副作用：用户会看到 tab 在前后台来回切。但批量授权场景下用户本来就不该
  // 在用浏览器，这点切换可接受。

  let dedicatedTabId = 0;

  async function activateTab(tabId) {
    if (!tabId) return;
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch {
      // 标签页可能已经被用户关掉，忽略
    }
  }

  async function ensureAuthTab(url) {
    // 优先复用已有专用 tab；不存在或失效则新建
    if (dedicatedTabId) {
      try {
        const tab = await chrome.tabs.get(dedicatedTabId);
        if (tab?.id) {
          await chrome.tabs.update(dedicatedTabId, { url, active: true });
          return dedicatedTabId;
        }
      } catch {
        dedicatedTabId = 0;
      }
    }
    const created = await chrome.tabs.create({ url, active: true });
    dedicatedTabId = created?.id || 0;
    return dedicatedTabId;
  }

  async function closeAuthTab() {
    if (!dedicatedTabId) return;
    try {
      await chrome.tabs.remove(dedicatedTabId);
    } catch {}
    dedicatedTabId = 0;
  }

  // 批量任务结束时关闭 2925 标签页（让用户重新跑下一批时再开）
  async function closeMail2925Tab() {
    if (!mail2925TabId) return;
    try {
      await chrome.tabs.remove(mail2925TabId);
    } catch {}
    mail2925TabId = 0;
  }

  function getAuthTabId() {
    return dedicatedTabId;
  }

  // ---------- 等待 + 轮询 ----------

  function isLocalhostCallbackUrl(rawUrl) {
    if (!rawUrl) return false;
    try {
      const parsed = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) return false;
      // 端口 CLIProxyAPI 默认 1455；放宽一点容忍其他端口
      if (parsed.port && Number(parsed.port) !== CPA_CALLBACK_PORT && Number(parsed.port) !== 0) {
        // 不强制端口，但记录便于排查
      }
      // 必须有 code/state 参数才算回调
      const code = parsed.searchParams.get('code');
      const state = parsed.searchParams.get('state');
      return Boolean(code && state);
    } catch {
      return false;
    }
  }

  async function waitForTabUrlComplete(tabId, predicate, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.status === 'complete' && predicate(tab.url || '')) {
          return tab;
        }
      } catch {
        return null;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  }

  async function inspectPage(tabId) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: CPA_MSG.INSPECT_AUTH_PAGE });
      return result || { state: 'unknown' };
    } catch {
      return { state: 'unknown' };
    }
  }

  async function waitForPageState(tabId, expectedStates, timeoutMs) {
    const expected = new Set(Array.isArray(expectedStates) ? expectedStates : [expectedStates]);
    const start = Date.now();
    let last = { state: 'unknown' };
    while (Date.now() - start < timeoutMs) {
      last = await inspectPage(tabId);
      if (last && expected.has(last.state)) {
        return last;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return last;
  }

  // ---------- localhost 回调拦截 ----------
  //
  // 用 webNavigation.onBeforeNavigate 监听，看到 callback URL 就抓下来交给 resolve。
  // 同时调 tabs.update 把 tab 引导到 about:blank 阻止真正访问 localhost
  // (因为大概率没监听端口、空回 502 反而难看)。

  /**
   * 注册一个对 tabId 的 localhost 回调监听。**不带 timeout** —— 因为
   * 整个邮箱处理流程很长（email/password/2925接码/oauth consent），任何
   * 一段都可能让从「监听器注册」到「localhost 跳转」的时间超过 60s。
   * 调用方在合适的时机（如同意按钮点完）用 Promise.race 自己加 timeout。
   *
   * 返回 { promise, cancel }：
   *   - promise: resolve(callbackUrl)，永不 reject（除非显式 cancel）
   *   - cancel(reason): 取消监听并 reject promise（用于失败路径清理）
   */
  function startCallbackListener(tabId) {
    let settle;
    let alreadyResolved = false;
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });

    function handle(details) {
      if (alreadyResolved) return;
      if (Number(details?.tabId) !== Number(tabId)) return;
      if (Number(details?.frameId) !== 0) return;
      const url = details.url || '';
      if (!isLocalhostCallbackUrl(url)) return;
      alreadyResolved = true;
      try { chrome.webNavigation.onBeforeNavigate.removeListener(listener); } catch {}
      try { chrome.webNavigation.onCommitted.removeListener(committedListener); } catch {}
      // 把 tab 引走，避免 localhost 显示 ERR_CONNECTION_REFUSED
      chrome.tabs.update(tabId, { url: 'about:blank' }).catch(() => {});
      settle.resolve(url);
    }

    const listener = (details) => handle(details);
    const committedListener = (details) => handle(details);
    const filter = {
      url: [{ hostEquals: 'localhost' }, { hostEquals: '127.0.0.1' }],
    };
    chrome.webNavigation.onBeforeNavigate.addListener(listener, filter);
    chrome.webNavigation.onCommitted.addListener(committedListener, filter);

    function cancel(reason) {
      if (alreadyResolved) return;
      alreadyResolved = true;
      try { chrome.webNavigation.onBeforeNavigate.removeListener(listener); } catch {}
      try { chrome.webNavigation.onCommitted.removeListener(committedListener); } catch {}
      settle.reject(new Error(reason || 'callback listener cancelled'));
    }

    return { promise, cancel };
  }

  // ---------- 2925 接码 + 提交后状态确认 ----------

  /**
   * 在 mailTabId 上轮询 2925 inbox，直到拿到一个**不在 skipCodes 里**的验证码，
   * 或者超时抛 Error。封装出来是因为「代码不正确」时要原地重新拉一次新邮件。
   *
   * @param {Object} args
   *   @param {number} args.mailTabId
   *   @param {string} args.recipient                    收件人邮箱（用来在 inbox 预览里过滤）
   *   @param {string[]} args.skipCodes                  已经被 OpenAI 拒绝过的验证码（不再返回）
   *   @param {() => void} args.checkAbort               throw 触发停止
   *   @param {(msg:string, lvl?:string) => Promise<void>} args.log
   *   @param {string} [args.attemptLabel]               日志里附加显示「（第 N 轮重试…）」
   * @returns {Promise<{code:string, source:string, isUnread?:boolean}>}
   */
  async function pollMail2925ForCode({ mailTabId, recipient, skipCodes, checkAbort, log, attemptLabel = '' }) {
    const pollStart = Date.now();
    const pollDeadline = pollStart + CPA_EMAIL_VERIFICATION_WAIT_TIMEOUT_MS;
    const POLL_INTERVAL_MS = 3000;
    let codeResult = null;
    let pollIndex = 0;
    let lastErrMsg = '';
    while (Date.now() < pollDeadline) {
      checkAbort();
      pollIndex += 1;
      // 每次轮询前激活 2925 tab，让 Vue 应用拿到正常的事件循环。
      await activateTab(mailTabId);
      let attempt;
      try {
        attempt = await chrome.tabs.sendMessage(mailTabId, {
          type: CPA_MSG.FETCH_2925_CODE,
          payload: {
            recipientEmail: recipient,
            shouldRefresh: true,
            // 前 3 次只扫预览（快）；之后允许点进邮件正文（慢但更准）
            shouldDrillInto: pollIndex >= 4,
            skipCodes: Array.isArray(skipCodes) ? Array.from(skipCodes) : [],
          },
        });
      } catch (err) {
        lastErrMsg = String(err?.message || err);
        await log(`2925 第 ${pollIndex} 次轮询${attemptLabel}通信失败（content script 可能还在加载），3 秒后重试：${lastErrMsg}`, 'warn');
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }
      if (attempt?.error) {
        lastErrMsg = attempt.error;
        await log(`2925 第 ${pollIndex} 次轮询${attemptLabel}内部异常：${attempt.error}`, 'warn');
      } else if (attempt?.code) {
        codeResult = attempt;
        break;
      } else {
        await log(
          `2925 第 ${pollIndex} 次轮询${attemptLabel}：扫描 ${attempt?.itemCount ?? 0} 封 / OpenAI 验证码邮件 ${attempt?.openAiItemCount ?? 0} 封（未读 ${attempt?.unreadOpenAiCount ?? 0}）/ GPT 营销邮件 ${(attempt?.brandedItemCount ?? 0) - (attempt?.openAiItemCount ?? 0)} 封，暂未抓到验证码`,
        );
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (!codeResult) {
      throw new Error(`2925 接码超时${attemptLabel}（${Math.round(CPA_EMAIL_VERIFICATION_WAIT_TIMEOUT_MS / 1000)}s 内未抓到符合条件的验证码）${lastErrMsg ? '；最后一次错误：' + lastErrMsg : ''}。请确认 2925 标签页已登录并能收到 ${recipient || '该邮箱'} 的转发邮件。`);
    }
    return codeResult;
  }

  /**
   * 填完验证码后短轮询页面状态，等 OpenAI 给出结果：
   *   - 成功：跳到 oauth_consent
   *   - 失败：留在 email_verification 且 hasError=true
   * 由于「代码不正确」可能要等服务器 round-trip 后才出现，给 15s 窗口。
   */
  async function waitForPostCodeSubmit(tabId) {
    const start = Date.now();
    const deadline = start + 15_000;
    let last = { state: 'unknown' };
    while (Date.now() < deadline) {
      last = await inspectPage(tabId);
      if (last?.state === 'oauth_consent') return last;
      if (last?.state === 'email_verification' && last.hasError === true) return last;
      await new Promise((r) => setTimeout(r, 500));
    }
    return last;
  }

  // ---------- 整体流程 ----------

  /**
   * 跑一个邮箱的完整 OAuth 重新授权流程。
   * @param {Object} ctx
   *   @param {Object} ctx.settings  - CpaReauthState.getSettings 的快照
   *   @param {string} ctx.email     - 邮箱
   *   @param {() => boolean} ctx.shouldStop - 用户是否请求停止
   * @returns {Promise<{ok:true, callbackUrl, message}|{ok:false, error}>}
   */
  async function reauthSingleEmail(ctx) {
    const { settings, email, shouldStop } = ctx;
    const log = (msg, level = 'info') => CpaReauthState.appendLog(`[${email}] ${msg}`, level);

    const startedAt = Date.now();
    const timeoutAt = startedAt + CPA_PER_EMAIL_TIMEOUT_MS;
    const checkAbort = () => {
      if (shouldStop && shouldStop()) {
        throw new Error('用户已请求停止。');
      }
      if (Date.now() > timeoutAt) {
        throw new Error('单邮箱整体超时。');
      }
    };

    // 提前声明，让 finally 能访问到（const 在 try 块内会因 TDZ 在 finally 中不可见）
    let callbackListener = null;
    // 这一轮在 2925 用过的所有验证码（含被 OpenAI 拒绝的）。
    // 成功收尾后会让 mail-2925 内容脚本把它们对应的邮件统统删掉，
    // 让下一封邮箱在同一个 2925 收件箱里看不到旧的 OpenAI 验证码邮件。
    const usedVerificationCodes = [];
    let mail2925TabIdForCleanup = 0;
    let mail2925RecipientForCleanup = '';

    try {
      checkAbort();
      await log('开始重新授权');

      // 1a. 清理 ChatGPT / OpenAI cookies，避免上一个账号的 session 让 OpenAI
      //     直接判定为「已登录」跳过登录页（每个邮箱前都清一次，与 FlowPilot 主项目对齐）
      try {
        if (root.CpaReauthCookieCleanup?.clearOpenAiCookies) {
          await log('清理 ChatGPT / OpenAI cookies...');
          const cookieResult = await root.CpaReauthCookieCleanup.clearOpenAiCookies();
          if (cookieResult.skipped) {
            await log(`跳过 cookie 清理：${cookieResult.skipped}`, 'warn');
          } else {
            await log(`已清理 ${cookieResult.removedCount}/${cookieResult.totalFound} 个 cookies（${cookieResult.elapsedMs}ms）`);
          }
        }
      } catch (cookieErr) {
        // 清 cookie 失败不阻塞主流程，但记一笔日志
        await log(`cookie 清理异常（继续执行）：${cookieErr?.message || cookieErr}`, 'warn');
      }
      checkAbort();

      // 1. 拿 OAuth URL
      const { oauthUrl, oauthState } = await CpaReauthApi.requestCodexAuthUrl(settings);
      await CpaReauthState.setRunning({
        currentEmail: email,
        currentStep: 'opening_oauth_url',
        currentOauthState: oauthState,
      });
      await log(`已从 CPA 拿到 OAuth URL（state=${oauthState ? oauthState.slice(0, 16) + '…' : '?'}）`);
      checkAbort();

      // 2. 打开 tab
      const tabId = await ensureAuthTab(oauthUrl);
      await CpaReauthState.setRunning({ currentAuthTabId: tabId });
      await log(`已在标签页 ${tabId} 打开 OAuth URL`);

      // 3. 启动 localhost 回调监听（早注册，避免某些场景 OAuth 直接跳过同意页自动跳转）。
      //    不带 timeout —— 计时单独在「同意按钮点完后」启动，避免被 2925 接码等慢步骤拖垮。
      callbackListener = startCallbackListener(tabId);

      // 4. 等页面 load 完
      await waitForTabUrlComplete(tabId, (u) => /^https?:\/\//i.test(u), CPA_AUTH_PAGE_READY_TIMEOUT_MS);
      checkAbort();

      // 5. 在邮箱页填邮箱
      await activateTab(tabId); // 后台 tab Vue 可能不渲染，激活保证页面正常加载
      const emailPageSnap = await waitForPageState(tabId, ['email', 'password', 'oauth_consent'], CPA_FILL_EMAIL_TIMEOUT_MS);
      checkAbort();
      if (emailPageSnap.state === 'email') {
        await CpaReauthState.setRunning({ currentStep: 'fill_email' });
        await log('检测到邮箱输入页，正在填写...');
        const fillResult = await chrome.tabs.sendMessage(tabId, {
          type: CPA_MSG.EXECUTE_FILL_EMAIL,
          payload: { email },
        });
        if (fillResult?.error) throw new Error(`填邮箱失败：${fillResult.error}`);
        await log('已提交邮箱，等待密码页...');
      } else if (emailPageSnap.state === 'unknown') {
        throw new Error(`授权页未进入可识别状态。URL=${emailPageSnap.url || 'unknown'}`);
      }

      // 6. 密码页
      await activateTab(tabId);
      const pwSnap = await waitForPageState(tabId, ['password', 'oauth_consent', 'email_verification'], CPA_FILL_PASSWORD_TIMEOUT_MS);
      checkAbort();
      if (pwSnap.state === 'password') {
        await CpaReauthState.setRunning({ currentStep: 'fill_password' });
        await log('检测到密码页，正在填写...');
        const fillResult = await chrome.tabs.sendMessage(tabId, {
          type: CPA_MSG.EXECUTE_FILL_PASSWORD,
          payload: { password: settings.sharedPassword || '' },
        });
        if (fillResult?.error) throw new Error(`填密码失败：${fillResult.error}`);
        await log('已提交密码，等待下一页（OAuth 同意 / 邮箱验证）...');
      } else if (pwSnap.state !== 'oauth_consent' && pwSnap.state !== 'email_verification') {
        throw new Error(`填邮箱后未进入密码页/同意页/验证页。URL=${pwSnap.url || 'unknown'}`);
      }

      // 6.5 可选：邮箱验证码页 —— OpenAI 偶发会要求二次验证，需要去 2925 接码
      // 仅当确实进入到 email_verification 状态时才打开 2925；否则跳过这一步直接走 OAuth 同意。
      await activateTab(tabId);
      const postPwSnap = await waitForPageState(tabId, ['oauth_consent', 'email_verification'], CPA_OAUTH_CONSENT_TIMEOUT_MS);
      checkAbort();
      if (postPwSnap.state === 'email_verification') {
        await CpaReauthState.setRunning({ currentStep: 'fetching_2925_code' });
        const recipient = (postPwSnap.recipientEmail || email || '').toLowerCase();
        await log(`OpenAI 要求邮箱二次验证（向 ${recipient || '未知' } 发送了验证码），正在打开 2925 接码...`, 'warn');

        const mailTabId = await ensureMail2925Tab();
        if (!mailTabId) throw new Error('无法打开 2925 标签页。');
        // 暂存给后面成功收尾时的清理用
        mail2925TabIdForCleanup = mailTabId;
        mail2925RecipientForCleanup = recipient;

        // 等 2925 页面 ready（content script 加载完）
        await waitForTabUrlComplete(mailTabId, (u) => /2925\.com/i.test(u), 15000);
        // 让 Vue SPA mount + content script attach onMessage 监听器。
        // 通过反复发 INSPECT 探测，直到 content script 真的能回应为止。
        await log('等待 2925 页面 content script 就绪...');
        const probeDeadline = Date.now() + 15000;
        let scriptReady = false;
        while (Date.now() < probeDeadline) {
          checkAbort();
          try {
            const probe = await chrome.tabs.sendMessage(mailTabId, { type: CPA_MSG.INSPECT_2925_INBOX });
            if (probe && (probe.itemCount !== undefined || probe.url)) {
              scriptReady = true;
              await log(`2925 content script 就绪：当前 inbox ${probe.itemCount ?? 0} 封邮件，URL=${(probe.url || '').slice(0, 60)}`);
              break;
            }
          } catch (err) {
            // "Could not establish connection" = SPA 还没 mount / 还没注入；继续等
          }
          await new Promise((r) => setTimeout(r, 700));
        }
        if (!scriptReady) {
          await log('2925 探测超时但仍尝试拉取（可能页面正常但首次 inspect 没回包）', 'warn');
        }
        checkAbort();

        // 单次「接码 → 填码 → 等结果」可能要做多轮：
        // 如果 2925 同时收到了多封验证码邮件（旧的 + 新的），OpenAI 端只认最新一封，
        // 我们如果不幸抓到了旧的，页面会回显「代码不正确」。
        // 此时要：把这次的码加进 skipCodes，再回 2925 拉一封不同的 code 来重试。
        const MAX_CODE_ATTEMPTS = 3;
        let codeAccepted = false;

        for (let attemptIdx = 1; attemptIdx <= MAX_CODE_ATTEMPTS && !codeAccepted; attemptIdx += 1) {
          checkAbort();

          // 1) 从 2925 拉一个尚未试过的 code
          const codeResult = await pollMail2925ForCode({
            mailTabId,
            recipient,
            skipCodes: usedVerificationCodes,
            checkAbort,
            log,
            attemptLabel: attemptIdx === 1 ? '' : `（第 ${attemptIdx} 轮重试，已跳过 ${usedVerificationCodes.length} 个失效码）`,
          });
          const code = String(codeResult.code || '').trim();
          if (!/^\d{4,8}$/.test(code)) {
            throw new Error(`2925 返回的验证码格式异常：${JSON.stringify(codeResult)}`);
          }
          usedVerificationCodes.push(code);
          await log(`已从 2925 接到验证码 ${code}（来源：${codeResult.source || '?'}，未读=${codeResult.isUnread ? '是' : '否'}），回填到 OpenAI...`);

          // 2) 切回 OAuth tab 填码
          await CpaReauthState.setRunning({ currentStep: 'fill_verification_code' });
          await activateTab(tabId);
          const fillResult = await chrome.tabs.sendMessage(tabId, {
            type: CPA_MSG.EXECUTE_FILL_VERIFICATION_CODE,
            payload: { code },
          });
          if (fillResult?.error) throw new Error(`填写验证码失败：${fillResult.error}`);
          await log(`验证码已填写并提交，等待页面反馈...`);

          // 3) 等服务器反馈：成功 → 跳到 oauth_consent；失败 → 留在 email_verification 且 hasError=true
          await activateTab(tabId);
          const postFillSnap = await waitForPostCodeSubmit(tabId);
          checkAbort();
          if (postFillSnap.state === 'oauth_consent') {
            codeAccepted = true;
            await log('验证码被 OpenAI 接受，已跳转到 OAuth 同意页。');
            break;
          }
          if (postFillSnap.state === 'email_verification' && postFillSnap.hasError) {
            await log(`OpenAI 拒绝验证码 ${code}（页面显示「代码不正确」/Invalid code）。回 2925 拉一封更新的邮件...`, 'warn');
            // 让 OpenAI 把上一个填的擦掉再继续 —— 不主动点 Resend（点 Resend 会让所有旧码失效，
            // 包括我们刚从 2925 拉到的新邮件）。
            continue;
          }
          // 既不是 oauth_consent 也不是显式 hasError，就当成 OK，让后面 OAuth 同意流程自己再检
          await log(`提交后页面状态=${postFillSnap.state}（无错误标记），继续走 OAuth 同意流程。`);
          codeAccepted = true;
          break;
        }

        if (!codeAccepted) {
          throw new Error(`连续 ${MAX_CODE_ATTEMPTS} 次验证码都被 OpenAI 拒绝（已尝试：${usedVerificationCodes.join(', ')}）。可能 2925 收到的邮件还是过期的，或 OpenAI 这次直接拉黑了该邮箱。`);
        }
      }

      // 7. OAuth 同意页
      // 关键：激活 OAuth tab 让它跑前台事件循环；否则后台 tab 上同意按钮点了之后
      // Chrome 可能会延迟触发 OAuth 跳转到 localhost，导致我们超时。
      await activateTab(tabId);
      const consentSnap = await waitForPageState(tabId, ['oauth_consent'], CPA_OAUTH_CONSENT_TIMEOUT_MS);
      checkAbort();
      if (consentSnap.state === 'oauth_consent') {
        await CpaReauthState.setRunning({ currentStep: 'confirm_oauth' });
        await log('检测到 OAuth 同意页，正在点击同意...');
        const confirmResult = await chrome.tabs.sendMessage(tabId, {
          type: CPA_MSG.EXECUTE_CONFIRM_OAUTH,
        });
        if (confirmResult?.error) {
          // 也可能页面自动同意了，先不死板报错
          await log(`OAuth 同意按钮点击异常：${confirmResult.error}，将继续等待 localhost 回调`, 'warn');
        } else {
          await log(`已点击 OAuth 同意按钮（${confirmResult?.clicked || '?'}）`);
        }
      } else {
        await log(`未能确认 OAuth 同意页，将直接等待 localhost 回调（如 CPA 已透传完成）`, 'warn');
      }

      // 8. 等 localhost 回调
      // 同意按钮点完后开始倒计时；listener 早就注册了，所以就算 OAuth 自动跳转
      // 在同意点击瞬间发生，已经被 listener.promise resolve 了，下面 race 会立刻通过。
      // 保持 OAuth tab 激活让最终跳转流畅完成。
      await activateTab(tabId);
      await CpaReauthState.setRunning({ currentStep: 'waiting_localhost_callback' });
      const callbackUrl = await Promise.race([
        callbackListener.promise,
        new Promise((_, reject) => setTimeout(() => {
          callbackListener.cancel('timeout');
          reject(new Error(`等待 localhost 回调超时（同意按钮点完后 ${Math.round(CPA_LOCALHOST_CALLBACK_TIMEOUT_MS / 1000)}s 内未捕获到回调）。`));
        }, CPA_LOCALHOST_CALLBACK_TIMEOUT_MS)),
      ]);
      checkAbort();
      if (!callbackUrl) {
        throw new Error('未捕获到 localhost 回调。');
      }
      await log(`已拦截 localhost 回调，正在上报给 CPA...`);

      // 9. POST 给 CPA
      await CpaReauthState.setRunning({ currentStep: 'posting_callback' });
      const submitResult = await CpaReauthApi.submitOAuthCallback(settings, callbackUrl);
      await log(`CPA 已确认重新授权成功：${submitResult.message}`, 'ok');

      // 10. 清理 2925 上这一轮用过的所有验证码邮件（含被拒绝的旧码邮件）。
      //     与 FlowPilot 主项目的「每验证完一封就删除」语义对齐，
      //     避免下一封邮箱在同一个 2925 收件箱里被上一轮的旧邮件干扰。
      //     best-effort：失败不抛错，不影响这封邮箱已经成功的结果。
      if (usedVerificationCodes.length > 0 && mail2925TabIdForCleanup) {
        try {
          await CpaReauthState.setRunning({ currentStep: 'cleanup_2925_mail' });
          await activateTab(mail2925TabIdForCleanup);
          const delResult = await chrome.tabs.sendMessage(mail2925TabIdForCleanup, {
            type: CPA_MSG.DELETE_2925_MAIL,
            payload: {
              codes: usedVerificationCodes.slice(),
              recipientEmail: mail2925RecipientForCleanup || '',
            },
          });
          if (delResult?.error) {
            await log(`清理 2925 邮件时 content 返回错误（忽略）：${delResult.error}`, 'warn');
          } else if (delResult?.ok) {
            await log(`已清理 2925 收件箱：删除 ${delResult.deleted?.length || 0} 封验证码邮件（${(delResult.deleted || []).join(', ')}），收件箱 ${delResult.itemCountBefore} → ${delResult.itemCountAfter}`);
          } else {
            await log(`2925 邮件部分清理：成功 ${(delResult?.deleted || []).join(', ') || '0'}，失败 ${(delResult?.skipped || []).join(', ') || '0'}`, 'warn');
          }
        } catch (delErr) {
          await log(`清理 2925 邮件失败（忽略，不影响本邮箱成功结果）：${delErr?.message || delErr}`, 'warn');
        }
      }

      return {
        ok: true,
        callbackUrl,
        message: submitResult.message,
      };
    } catch (error) {
      const message = String(error?.message || error || '未知错误');
      await log(`失败：${message}`, 'error');
      return { ok: false, error: message };
    } finally {
      // 即使流程中途失败，也要把 callback listener 卸载掉，否则会泄漏到下一个邮箱
      // （webNavigation 监听器是全局的，会累积）。
      try {
        if (callbackListener && typeof callbackListener.cancel === 'function') {
          callbackListener.cancel('flow ended');
        }
      } catch {}
      await CpaReauthState.setRunning({
        currentStep: '',
        currentAuthTabId: 0,
        currentOauthState: '',
      });
    }
  }

  root.CpaReauthAuthFlow = {
    reauthSingleEmail,
    ensureAuthTab,
    closeAuthTab,
    closeMail2925Tab,
    getAuthTabId,
    isLocalhostCallbackUrl,
  };
})(typeof self !== 'undefined' ? self : globalThis);
