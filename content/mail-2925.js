// content/mail-2925.js — 2925 邮箱接码（精简版）
//
// 假设用户已经登录 2925，不做登录引导（如果未登录就 timeout 报错让用户手动登录）。
//
// 核心做法：
//   1. 收到 FETCH_2925_CODE 消息后开始轮询 inbox
//   2. 优先尝试通过 OpenAI session cookie / API 内嵌的 fetch 拉收件箱（2925 内部 vue 应用
//      会通过自己的 ajax 拿邮件列表），但这条路偶尔会被风控；
//      所以我们就直接解析 inbox 列表的 DOM 文本。
//   3. 找最新的 OpenAI 类邮件（发件人含 OpenAI / 主题含 verification code / 正文含 6 位数）
//   4. 提取 6 位数验证码返回
//   5. 如果可以匹配收件人邮箱（filter by recipient），优先选匹配的那一封，
//      避免同一个 2925 邮箱接到多个 duck.com 邮件时拿错。
//
// IIFE + idempotent guard，防 hot-reload 死循环。

(function bootCpaReauthMail2925() {
  if (typeof self !== 'undefined' && self.__CPA_REAUTH_MAIL2925_BOOTED) {
    return;
  }
  if (typeof self !== 'undefined') {
    self.__CPA_REAUTH_MAIL2925_BOOTED = true;
  }

  const CPA_MSG = (typeof self !== 'undefined' && self.CPA_MSG) || {
    FETCH_2925_CODE: 'CPA_FETCH_2925_CODE',
    INSPECT_2925_INBOX: 'CPA_INSPECT_2925_INBOX',
    DELETE_2925_MAIL: 'CPA_DELETE_2925_MAIL',
  };

  console.log('[CpaReauth:mail-2925] content script loaded on', location.href);

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, ms || 0)));
  }

  function trim(value) {
    return String(value == null ? '' : value).trim();
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function pageText() {
    return String(document.body?.innerText || '').replace(/ /g, ' ');
  }

  // ---------- 邮件正文里提验证码 ----------
  // 优先匹配「6 位连续数字 + 上下文是 verification / code / 验证码」
  // 退而求其次：取最近一封 OpenAI 邮件预览里的第一个 6 位数字串
  function extractCodeFromText(text, options = {}) {
    if (!text) return '';
    const haystack = String(text);

    // 1. 强匹配：「验证码 / verification / code」附近 ±60 字符内的 6 位数字。
    //    用 (?<!\d) / (?!\d) 限定 \d{6} 是独立的 6 位数字串，
    //    避免从 12345678 这种 7 位 ID 里抠出 6 位假码。
    const strongPatterns = [
      /(?:验证码|verification\s*code|your\s*code|one[-\s]*time\s*code|otp)[^\d]{0,40}(?<!\d)(\d{6})(?!\d)/i,
      /(?<!\d)(\d{6})(?!\d)[^\d]{0,40}(?:验证码|verification|code|otp)/i,
    ];
    for (const pat of strongPatterns) {
      const m = haystack.match(pat);
      if (m) return m[1];
    }

    // 2. 弱匹配：从 OpenAI 邮件预览里直接抓第一个 6 位数字串
    if (options.allowWeak) {
      const m = haystack.match(/(?<!\d)(\d{6})(?!\d)/);
      if (m) return m[1];
    }
    return '';
  }

  // ---------- inbox 邮件项查找 ----------
  // 2925 实测 DOM：table.maillist-table > tbody > tr.unread-mail (未读) / tr (已读)
  // 加上若干历史/兜底选择器，按命中率从高到低排
  const MAIL_ITEM_SELECTORS = [
    'table.maillist-table tbody tr',
    'tr.unread-mail',
    '.mail-item',
    '.letter-item',
    '[class*="mailItem"]',
    '[class*="mail-item"]',
    '[class*="letterItem"]',
    '[class*="letter-item"]',
    '.el-table__row',
    'tr[class*="mail"]',
    'li[class*="mail"]',
    '[class*="listItem"]',
  ].join(', ');

  // 判断一行邮件是否是未读（2925 用 tr.unread-mail 标记）。
  // 未读 = 还没被任何人/本扩展点开过 = 最新到达 = 我们最该接的那封。
  function isUnreadItem(el) {
    if (!el) return false;
    try {
      if (el.classList && el.classList.contains('unread-mail')) return true;
      if (typeof el.closest === 'function' && el.closest('tr.unread-mail, .unread-mail, .unread')) return true;
      // 兜底：邮件标题里加粗（font-weight 600+ / bold）
      const titleEl = typeof el.querySelector === 'function'
        ? el.querySelector('.mail-content-title, .mail-title')
        : null;
      if (titleEl) {
        const fw = window.getComputedStyle(titleEl)?.fontWeight || '';
        const num = Number(fw);
        if ((!Number.isNaN(num) && num >= 600) || /bold/i.test(fw)) return true;
      }
    } catch {}
    return false;
  }

  function collectInboxItems() {
    const list = Array.from(document.querySelectorAll(MAIL_ITEM_SELECTORS)).filter(isVisible);
    return list.map((el) => ({
      element: el,
      isUnread: isUnreadItem(el),
      text: trim(el.innerText || el.textContent || '').replace(/\s+/g, ' '),
    }));
  }

  // 判定一项是否来自 OpenAI / ChatGPT 的「验证码邮件」
  //
  // 必须同时满足：
  //   A. 含品牌词（chatgpt / openai / noreply@openai.com）
  //   B. 含验证码语义词（code / 验证码 / login code / verification / 登录代码 / temporary login）
  //
  // 这条规则是为了把 "ChatGPT 给你的一些实用点子" 这种营销邮件挡掉
  // —— 它只命中 A 不命中 B。
  // 真正的验证码邮件主题/正文摘要里一定会带 "code" 或 "验证码"。
  function isLikelyOpenAiItem(text) {
    if (!text) return false;
    const brand = /openai|chatgpt|noreply@openai\.com/i;
    const codeKw = /\bcode\b|验证码|登录代码|登入代码|verification|one[-\s]*time|otp|temporary\s+(?:chatgpt\s+)?login/i;
    return brand.test(text) && codeKw.test(text);
  }

  // 营销/通用 OpenAI 邮件（不含 code 关键字），仅用于诊断日志
  function isAnyOpenAiBrandedItem(text) {
    if (!text) return false;
    return /openai|chatgpt|noreply@openai\.com/i.test(text);
  }

  // 判定预览文本是否含给定收件人邮箱（duck 邮箱转发到 2925 时常会在正文/header 出现 to: xxx）
  function previewMentionsRecipient(text, recipient) {
    if (!recipient) return true; // 没指定就别过滤
    const lower = String(text || '').toLowerCase();
    const needle = String(recipient || '').toLowerCase();
    return lower.includes(needle);
  }

  // ---------- 刷新 / 进入收件箱 ----------
  //
  // 2925 用的是纯文本 + Vue 路由，没有 class/href/title/aria 可挂钩。
  // 所以这两个函数都是「找文本恰好等于 X 的可见叶子节点 → 点 closest 的可点容器」。

  // 在 scope 里找一个文本完全等于 needle 的可见叶子节点（children.length === 0）。
  // 2925 的菜单项 / 工具栏按钮基本都是这种纯文本叶子，最稳。
  function findByExactText(scopeSelector, needle) {
    const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
    if (!scope) return null;
    const all = scope.querySelectorAll('*');
    for (const el of all) {
      if (el.children.length !== 0) continue;       // 只匹配叶子节点
      if (!isVisible(el)) continue;
      if ((el.textContent || '').trim() !== needle) continue;
      return el;
    }
    return null;
  }

  function tryClickRefresh() {
    // 找到「刷新」叶子节点，沿父链 closest 到工具栏按钮容器 .tool-common
    // (toolbar 里每个按钮都是 .tool-common，所以 querySelector('.tool-common') 第一个常常
    //  不是「刷新」那个；必须按 leaf-up 找)
    const leaf = findByExactText(null, '刷新');
    if (!leaf) return false;
    const clickable = leaf.closest('.tool-common, button, a, [role="button"], li') || leaf;
    try { clickable.click(); return true; } catch {}
    try { leaf.click(); return true; } catch {}
    return false;
  }

  // 工具栏「删除」按钮（同 .tool-common 体系，叶子节点文本完全等于「删除」）
  function tryClickDelete() {
    const leaf = findByExactText(null, '删除');
    if (!leaf) return false;
    const clickable = leaf.closest('.tool-common, button, a, [role="button"], li') || leaf;
    try { clickable.click(); return true; } catch {}
    try { leaf.click(); return true; } catch {}
    return false;
  }

  // 在一行邮件里勾选 checkbox（native checkbox 优先，ElementUI / iview 兜底）
  function selectMailRowCheckbox(rowEl) {
    if (!rowEl) return false;
    try {
      const native = rowEl.querySelector?.('input[type="checkbox"]');
      if (native && isVisible(native)) {
        if (!native.checked) native.click();
        return true;
      }
    } catch {}
    const wrapperSelectors = '.el-checkbox, .ivu-checkbox, [role="checkbox"], [class*="checkbox"]';
    try {
      const wrappers = rowEl.querySelectorAll?.(wrapperSelectors) || [];
      for (const w of wrappers) {
        if (!isVisible(w)) continue;
        try { w.click(); return true; } catch {}
      }
    } catch {}
    return false;
  }

  function tryClickInbox() {
    let el = findByExactText('ul.left-nav', '收件箱');
    if (!el) {
      // 兜底：左 nav 第一项的 li 通常就是收件箱
      const firstLi = document.querySelector('ul.left-nav > li');
      if (firstLi && isVisible(firstLi) && (firstLi.textContent || '').includes('收件箱')) {
        el = firstLi;
      }
    }
    if (!el) return false;
    const clickable = el.closest('li, a, [role="button"]') || el;
    try { clickable.click(); return true; } catch {}
    try { el.click(); return true; } catch {}
    return false;
  }

  // ---------- 主流程：等验证码 ----------

  /**
   * 单次扫描 inbox 找验证码 —— 让 background 控制轮询节奏，这样每次轮询
   * 都有日志可看，用户能看到进度，而不是被一次阻塞 90 秒。
   * @param {Object} payload
   *   @param {string} payload.recipientEmail - 收件人邮箱（用于多账号转发到同一 2925 时过滤）
   *   @param {boolean} [payload.shouldRefresh] - 是否点一下「刷新」按钮（首次进入收件箱 / 长时间未刷新时）
   *   @param {boolean} [payload.shouldDrillInto] - 是否允许点进邮件正文查找（耗时但更精准）
   *   @param {string[]} [payload.skipCodes] - 已经试过被 OpenAI 拒绝的验证码；本次扫描不要再返回它们
   * @returns {Promise<{code?: string, source?: string, itemCount: number, openAiItemCount: number, preview?: string, isUnread?: boolean}>}
   */
  async function scanInboxOnce(payload = {}) {
    const recipient = trim(payload.recipientEmail).toLowerCase();
    const shouldRefresh = payload.shouldRefresh !== false;
    const shouldDrillInto = payload.shouldDrillInto === true;
    const skipCodes = new Set(
      (Array.isArray(payload.skipCodes) ? payload.skipCodes : [])
        .map((c) => String(c || '').trim())
        .filter(Boolean),
    );

    // 第一次进入收件箱时主动切一下，确保不在「写信 / 草稿箱」之类视图
    tryClickInbox();
    await sleep(300);

    if (shouldRefresh) {
      tryClickRefresh();
      await sleep(800);
    }

    const items = collectInboxItems();
    // 严格命中：品牌词 + code 语义词。这是后面 drillInto 的唯一候选池
    let openAiItems = items.filter((it) => isLikelyOpenAiItem(it.text));
    // 关键：把未读邮件（最新到达）排到前面 —— 多封验证码邮件时只有最新一封有效。
    // 用 stable sort（V8 自 2019 起 Array.sort 就是 stable 的），同未读状态保持 DOM 顺序。
    openAiItems = openAiItems
      .map((it, idx) => ({ it, idx }))
      .sort((a, b) => {
        const ua = a.it.isUnread ? 0 : 1;
        const ub = b.it.isUnread ? 0 : 1;
        if (ua !== ub) return ua - ub;
        return a.idx - b.idx;
      })
      .map((wrap) => wrap.it);
    // 诊断用：只挂品牌词但不含 code 的（一般是营销邮件），只统计不点击
    const brandedItemCount = items.filter((it) => isAnyOpenAiBrandedItem(it.text)).length;
    const unreadOpenAiCount = openAiItems.filter((it) => it.isUnread).length;

    // 1) 先从 list 列表预览里抓 6 位码
    //    弱匹配只允许在「严格命中」邮件上做；营销邮件 / 其他来源不允许 fallback 到弱匹配
    //    skipCodes 命中的直接跳过（OpenAI 已经拒绝过的旧验证码）
    const candidates = openAiItems.length ? openAiItems : items;
    for (const item of candidates) {
      if (!previewMentionsRecipient(item.text, recipient)) continue;
      let code = extractCodeFromText(item.text, { allowWeak: false });
      if (!code && isLikelyOpenAiItem(item.text)) {
        code = extractCodeFromText(item.text, { allowWeak: true });
      }
      if (!code) continue;
      if (skipCodes.has(code)) continue;
      return {
        code,
        source: 'preview',
        itemCount: items.length,
        openAiItemCount: openAiItems.length,
        unreadOpenAiCount,
        brandedItemCount,
        isUnread: item.isUnread === true,
        preview: item.text.slice(0, 200),
      };
    }

    // 2) 整页文本强匹配兜底（2925 UI 有时在右侧预览面板直接渲染整封邮件）
    const pageCode = extractCodeFromText(pageText(), { allowWeak: false });
    if (pageCode && !skipCodes.has(pageCode)) {
      return {
        code: pageCode,
        source: 'pagewide-strong',
        itemCount: items.length,
        openAiItemCount: openAiItems.length,
        unreadOpenAiCount,
        brandedItemCount,
      };
    }

    // 3) 如果调用方开启了 drillInto，点进「严格命中」的 OpenAI 验证码邮件读详情
    //    选目标顺序：未读 > 读过的；recipient 匹配优先；显式跳过已被 OpenAI 拒绝的预览码。
    if (shouldDrillInto && openAiItems.length > 0) {
      const drillCandidates = openAiItems.filter((it) => {
        if (!previewMentionsRecipient(it.text, recipient)) return false;
        const previewCode = extractCodeFromText(it.text, { allowWeak: false })
          || extractCodeFromText(it.text, { allowWeak: true });
        if (previewCode && skipCodes.has(previewCode)) return false;  // 这封邮件预览里就是被拒绝过的码
        return true;
      });
      const targetItem = drillCandidates[0] || openAiItems.find((it) => previewMentionsRecipient(it.text, recipient)) || openAiItems[0];
      try {
        targetItem.element.click();
      } catch {}
      await sleep(1200);
      const bodyCode = extractCodeFromText(pageText(), { allowWeak: true });
      // 点进详情后通常需要点回 inbox 才能继续下次扫描，这里不主动返回，
      // 由 background 下次循环时调用 INSPECT_2925_INBOX 自然会再 tryClickInbox。
      if (bodyCode && !skipCodes.has(bodyCode)) {
        return {
          code: bodyCode,
          source: 'body',
          itemCount: items.length,
          openAiItemCount: openAiItems.length,
          unreadOpenAiCount,
          brandedItemCount,
          isUnread: targetItem?.isUnread === true,
        };
      }
    }

    return {
      itemCount: items.length,
      openAiItemCount: openAiItems.length,
      unreadOpenAiCount,
      brandedItemCount,
    };
  }

  /**
   * 按验证码值删除 2925 inbox 里对应的邮件 —— 单封邮件用过/被拒绝后清理掉，
   * 避免下一封邮箱在同一个 2925 收件箱里被旧邮件干扰。
   *
   * 流程：回到收件箱 → 刷新 → 找文本含目标 code 的行 → 勾选 checkbox → 点删除。
   * 重复执行直到该 code 不再出现在 inbox 里（或达到 perCodeMaxRounds 上限）。
   *
   * @param {Object} payload
   *   @param {string[]} payload.codes  要删除的验证码列表（每个 code 至少删一封）
   *   @param {string}   [payload.recipientEmail]  收件人邮箱，可选过滤（多账号用同一 2925 时避免误删）
   * @returns {Promise<{ok:boolean, deleted:string[], skipped:string[], itemCountBefore:number, itemCountAfter:number}>}
   */
  async function deleteMailsByCodes(payload = {}) {
    const codes = (Array.isArray(payload.codes) ? payload.codes : [])
      .map((c) => String(c || '').trim())
      .filter(Boolean);
    const recipient = trim(payload.recipientEmail).toLowerCase();
    if (codes.length === 0) return { ok: true, deleted: [], skipped: [], itemCountBefore: 0, itemCountAfter: 0 };

    tryClickInbox();
    await sleep(300);
    tryClickRefresh();
    await sleep(800);

    const itemCountBefore = collectInboxItems().length;
    const deleted = [];
    const skipped = [];

    for (const code of codes) {
      let success = false;
      // 同一个 code 最多删 2 次（理论上一次就够，留一手兜底「2925 把同 code 重复转发」）
      for (let round = 0; round < 2; round += 1) {
        const items = collectInboxItems();
        const target = items.find((it) => {
          if (!it.text.includes(code)) return false;
          if (recipient && !previewMentionsRecipient(it.text, recipient)) return false;
          return true;
        });
        if (!target) {
          if (round === 0) {
            // 第一轮没找到也算成功（可能这封 code 还没来到过 inbox 或已被人工删过）
            success = true;
          }
          break;
        }
        const selected = selectMailRowCheckbox(target.element);
        if (!selected) break;
        await sleep(250);
        const clicked = tryClickDelete();
        if (!clicked) break;

        // 等 inbox 刷新，目标行消失就算成功
        for (let i = 0; i < 12; i += 1) {
          await sleep(250);
          const still = collectInboxItems().some((it) => it.text.includes(code));
          if (!still) {
            success = true;
            break;
          }
        }
        if (success) break;
      }
      if (success) deleted.push(code);
      else skipped.push(code);
    }

    // 删完最后再刷一次 inbox 让 UI 收敛
    tryClickRefresh();
    await sleep(400);
    const itemCountAfter = collectInboxItems().length;

    return {
      ok: skipped.length === 0,
      deleted,
      skipped,
      itemCountBefore,
      itemCountAfter,
    };
  }

  function inspectInbox() {
    const items = collectInboxItems();
    return {
      url: location.href,
      itemCount: items.length,
      // 严格匹配：含品牌词 + code 关键字（真正的验证码邮件）
      visibleOpenAiCount: items.filter((it) => isLikelyOpenAiItem(it.text)).length,
      // 宽松匹配：只含品牌词（包括 "给你的一些实用点子" 这类营销邮件）
      brandedItemCount: items.filter((it) => isAnyOpenAiBrandedItem(it.text)).length,
      sampleTextHead: items[0]?.text?.slice(0, 120) || '',
    };
  }

  // ---------- 消息监听 ----------

  if (document.documentElement.getAttribute('data-cpa-reauth-mail2925-listener') !== '1') {
    document.documentElement.setAttribute('data-cpa-reauth-mail2925-listener', '1');

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return;
      if (!message.type.startsWith('CPA_')) return;

      (async () => {
        try {
          if (message.type === CPA_MSG.INSPECT_2925_INBOX) {
            return inspectInbox();
          }
          if (message.type === CPA_MSG.FETCH_2925_CODE) {
            // 单次扫描；background 主控循环节奏
            return await scanInboxOnce(message.payload || {});
          }
          if (message.type === CPA_MSG.DELETE_2925_MAIL) {
            return await deleteMailsByCodes(message.payload || {});
          }
          return { ignored: true };
        } catch (error) {
          return { error: String(error?.message || error) };
        }
      })()
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ error: String(err?.message || err) }));

      return true;
    });
  }

  // 仅在测试 harness 里通过 self.__exports 暴露内部函数做单测
  if (typeof self !== 'undefined') {
    self.__CPA_REAUTH_MAIL2925_INTERNALS = {
      extractCodeFromText,
      isLikelyOpenAiItem,
      isAnyOpenAiBrandedItem,
      isUnreadItem,
      previewMentionsRecipient,
    };
  }
})();
