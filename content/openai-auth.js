// content/openai-auth.js — 注入到 auth.openai.com / accounts.openai.com / chatgpt.com 的内容脚本
//
// 任务远比 FlowPilot 主项目简单：本扩展只做「重新授权」一件事，所以
// 只需要应付三种页面：
//   A) email 输入页 (/auth/login, /create-account, /log-in 等)
//   B) password 输入页 (/log-in/password 或弹窗里的密码 input)
//   C) OAuth 同意页 (/oauth/authorize 或类似，有"继续/Continue/Authorize"按钮)
// localhost 回调拦截由 background webNavigation 监听，不在内容脚本里做。
//
// 用 IIFE + idempotent guard 包裹整个文件，避免 hot-reload 时 const
// redeclaration 失败导致旧版残留（FlowPilot 主项目踩过这个坑，详见
// 其 openai-auth.js 顶部注释）。

(function bootCpaReauthOpenAIAuth() {
  if (typeof self !== 'undefined' && self.__CPA_REAUTH_OPENAI_AUTH_BOOTED) {
    return;
  }
  if (typeof self !== 'undefined') {
    self.__CPA_REAUTH_OPENAI_AUTH_BOOTED = true;
  }

  const CPA_MSG = (typeof self !== 'undefined' && self.CPA_MSG) || {
    EXECUTE_FILL_EMAIL: 'CPA_EXECUTE_FILL_EMAIL',
    EXECUTE_FILL_PASSWORD: 'CPA_EXECUTE_FILL_PASSWORD',
    EXECUTE_FILL_VERIFICATION_CODE: 'CPA_EXECUTE_FILL_VERIFICATION_CODE',
    EXECUTE_CONFIRM_OAUTH: 'CPA_EXECUTE_CONFIRM_OAUTH',
    INSPECT_AUTH_PAGE: 'CPA_INSPECT_AUTH_PAGE',
  };

  console.log('[CpaReauth:openai-auth] content script loaded on', location.href);

  // ---------- 工具函数 ----------

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

  function isEnabled(el) {
    if (!el) return false;
    if (el.disabled) return false;
    const aria = trim(el.getAttribute('aria-disabled')).toLowerCase();
    if (aria === 'true') return false;
    return true;
  }

  function actionText(el) {
    if (!el) return '';
    return [
      el.textContent,
      el.value,
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('title'),
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, ms || 0)));
  }

  // 触发 React 友好的 input 值设置 —— 直接 .value 赋值会让 React 状态不同步
  function setInputValue(input, value) {
    if (!input) return;
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(input, String(value == null ? '' : value));
    } else {
      input.value = String(value == null ? '' : value);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clickWithFallback(el) {
    if (!el) throw new Error('cannot click null element');
    if (typeof el.click === 'function') {
      el.click();
      return;
    }
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  // ---------- 元素定位 ----------

  function findEmailInput() {
    const direct = document.querySelector('input[type="email"], input#email, input[name="email"], input[autocomplete="email"], input[autocomplete="username"]');
    if (direct && isVisible(direct)) return direct;
    return Array.from(document.querySelectorAll('input')).find((el) => {
      if (!isVisible(el)) return false;
      const type = trim(el.type).toLowerCase();
      const id = trim(el.id).toLowerCase();
      const name = trim(el.name).toLowerCase();
      const placeholder = trim(el.placeholder);
      const aria = trim(el.getAttribute?.('aria-label') || '');
      const combined = `${placeholder} ${aria}`;
      return type === 'email'
        || /email/i.test(id + ' ' + name)
        || /邮箱|电子邮件|email|メール/i.test(combined);
    }) || null;
  }

  function findPasswordInput() {
    const direct = document.querySelector('input[type="password"], input#password, input[name="password"], input[autocomplete="current-password"], input[autocomplete="new-password"]');
    if (direct && isVisible(direct)) return direct;
    return Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible) || null;
  }

  // 永远不要把这些按钮当成「继续」 —— 它们会重新发送验证码邮件，
  // 直接导致刚拿到的验证码瞬间失效（OpenAI 端只认最后一封发出的邮件）。
  const RESEND_BUTTON_TEXT_RE = /重新发送|再次发送|重新?获取|重发|resend|send\s*(?:another|new|again|code|email)/i;

  function findContinueButton() {
    const candidates = document.querySelectorAll('button, input[type="submit"], [role="button"]');
    // 优先匹配「继续 / Continue / Submit / 登录 / Sign in」
    const textPattern = /^(?:继续|登录|登陆|提交|下一步|continue|submit|next|sign\s*in|log\s*in)$/i;
    for (const el of candidates) {
      if (!isVisible(el) || !isEnabled(el)) continue;
      const text = actionText(el);
      if (!text) continue;
      if (RESEND_BUTTON_TEXT_RE.test(text)) continue;   // 显式排除「重新发送电子邮件」
      if (textPattern.test(text.trim())) return el;
    }
    // 退而求其次：找当前 form 里的 type=submit（同样要避开 Resend）
    for (const el of candidates) {
      if (!isVisible(el) || !isEnabled(el)) continue;
      if (trim(el.getAttribute?.('type')).toLowerCase() !== 'submit') continue;
      const text = actionText(el);
      if (RESEND_BUTTON_TEXT_RE.test(text)) continue;
      return el;
    }
    return null;
  }

  // /email-verification 页面：可能是单 input（type=text inputmode=numeric），
  // 也可能是 6 个 maxlength=1 的连续 input。先单 input，找不到再退到 split。
  function findVerificationCodeInput() {
    const single = document.querySelector('input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]');
    if (single && isVisible(single)) return { kind: 'single', element: single };
    // 文本 input 里 placeholder 含「验证码 / code」
    const placeholderMatch = Array.from(document.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"]')).find((el) => {
      if (!isVisible(el)) return false;
      const ph = trim(el.placeholder || '');
      const aria = trim(el.getAttribute('aria-label') || '');
      return /验证码|verification|^code$|otp/i.test(`${ph} ${aria}`);
    });
    if (placeholderMatch) return { kind: 'single', element: placeholderMatch };
    // split 模式
    const splitInputs = Array.from(document.querySelectorAll('input[maxlength="1"]')).filter(isVisible);
    if (splitInputs.length >= 4) return { kind: 'split', elements: splitInputs };
    return null;
  }

  // /email-verification 页面识别：URL + 描述里的「检查你的收件箱 / Check your inbox」
  function isEmailVerificationPage() {
    const path = location.pathname || '';
    if (/\/email-verification(?:[/?#]|$)/i.test(path)) return true;
    const bodyText = String(document.body?.innerText || '').slice(0, 800);
    return /检查你的收件箱|check your inbox|输入我们.*发送的验证码|enter the verification code/i.test(bodyText);
  }

  function findOAuthConsentButton() {
    // OpenAI 的 OAuth 同意页通常是 "Authorize / Continue / 继续 / 确认"
    const pattern = /^(?:authorize|authorise|continue|confirm|allow|确认|继续|授权|允许|同意)$/i;
    const candidates = document.querySelectorAll('button, input[type="submit"], [role="button"], a[role="button"]');
    for (const el of candidates) {
      if (!isVisible(el) || !isEnabled(el)) continue;
      const text = actionText(el);
      if (text && pattern.test(text.trim())) return el;
    }
    // 通用 fallback：form 的 submit
    const submit = document.querySelector('form button[type="submit"], form input[type="submit"]');
    if (submit && isVisible(submit) && isEnabled(submit)) return submit;
    return null;
  }

  // 判定当前页面是哪一类
  function inspectPage() {
    const url = location.href;
    const path = location.pathname || '';

    // OAuth 同意页
    if (/\/(?:oauth|authorize|consent)/i.test(path)) {
      const consentButton = findOAuthConsentButton();
      if (consentButton) {
        return { state: 'oauth_consent', url, consentButtonText: actionText(consentButton).slice(0, 30) };
      }
    }

    // 邮箱验证码页（/email-verification 或正文出现「检查你的收件箱」）
    // 必须放在 password / email 检查之前，因为这个页面 DOM 里可能也有其它输入框残留。
    if (isEmailVerificationPage()) {
      const codeInput = findVerificationCodeInput();
      if (codeInput) {
        const bodyText = String(document.body?.innerText || '').slice(0, 2000);
        // 是否显示了「代码不正确 / Invalid code / Incorrect code」之类的错误提示。
        // OpenAI 中文页面用「代码不正确」，英文是「Invalid code / Incorrect code / Code is incorrect」，
        // 偶尔也有「Verification code is invalid」。再宽一点也兜底进来。
        const hasError = /代码不正确|代码无效|验证码(?:不正确|无效|错误|已过期)|invalid\s+code|incorrect\s+code|code\s+is\s+(?:invalid|incorrect)|wrong\s+code|verification\s+code\s+is\s+(?:invalid|incorrect)|expired/i.test(bodyText);
        return {
          state: 'email_verification',
          url,
          codeInputKind: codeInput.kind,
          hasError,
          // 把发往目标邮箱（recipient）尽量提取出来给 background 做 2925 接码匹配
          // 页面文案常见：「输入我们刚刚向 xxx@duck.com 发送的验证码」
          recipientEmail: (function extractRecipient() {
            const txt = bodyText.slice(0, 1500);
            const m = txt.match(/向\s*([^\s@<]+@[^\s@>]+\.[^\s@>]+)\s*发送/i)
              || txt.match(/sent\s+to\s+([^\s@<]+@[^\s@>]+\.[^\s@>]+)/i)
              || txt.match(/([^\s@<]+@[^\s@>]+\.[^\s@>]+)/);
            return m ? m[1].trim().toLowerCase() : '';
          })(),
          continueButtonText: actionText(findContinueButton() || {}).slice(0, 30),
        };
      }
    }

    // 密码页（典型 /log-in/password）
    const passwordInput = findPasswordInput();
    if (passwordInput) {
      return {
        state: 'password',
        url,
        continueButtonText: actionText(findContinueButton() || {}).slice(0, 30),
      };
    }

    // 邮箱页
    const emailInput = findEmailInput();
    if (emailInput) {
      return {
        state: 'email',
        url,
        continueButtonText: actionText(findContinueButton() || {}).slice(0, 30),
      };
    }

    // OAuth 同意页 fallback：path 不带 /oauth/ 但能找到「授权」按钮
    const consentLike = findOAuthConsentButton();
    if (consentLike && /(authorize|continue|授权|继续|确认)/i.test(actionText(consentLike))) {
      return { state: 'oauth_consent', url, consentButtonText: actionText(consentLike).slice(0, 30) };
    }

    return { state: 'unknown', url };
  }

  // ---------- 动作执行 ----------

  async function executeFillEmail(email) {
    const target = trim(email);
    if (!target) throw new Error('未提供邮箱。');
    let input = null;
    for (let i = 0; i < 40 && !input; i += 1) {
      input = findEmailInput();
      if (!input) await sleep(250);
    }
    if (!input) throw new Error('未找到邮箱输入框。');
    setInputValue(input, target);
    await sleep(300);
    const cont = findContinueButton();
    if (!cont) throw new Error('未找到「继续」按钮。');
    clickWithFallback(cont);
    return { filled: target };
  }

  async function executeFillPassword(password) {
    const target = String(password == null ? '' : password);
    if (!target) throw new Error('未提供密码。');
    let input = null;
    for (let i = 0; i < 40 && !input; i += 1) {
      input = findPasswordInput();
      if (!input) await sleep(250);
    }
    if (!input) throw new Error('未找到密码输入框。');
    setInputValue(input, target);
    await sleep(300);
    const cont = findContinueButton();
    if (!cont) throw new Error('未找到「登录/继续」按钮。');
    clickWithFallback(cont);
    return { filled: true };
  }

  async function executeFillVerificationCode(code) {
    const target = String(code == null ? '' : code).replace(/\D/g, '');
    if (!/^\d{4,8}$/.test(target)) throw new Error(`验证码格式不正确：${code}`);
    let input = null;
    for (let i = 0; i < 40 && !input; i += 1) {
      input = findVerificationCodeInput();
      if (!input) await sleep(250);
    }
    if (!input) throw new Error('未找到验证码输入框。');

    if (input.kind === 'split') {
      // 6 个单字符 input：每个 input set 一位
      const inputs = input.elements;
      for (let i = 0; i < target.length && i < inputs.length; i += 1) {
        inputs[i].focus();
        setInputValue(inputs[i], target[i]);
        await sleep(60);
      }
    } else {
      input.element.focus();
      setInputValue(input.element, target);
    }
    await sleep(400);
    const cont = findContinueButton();
    if (!cont) {
      // OpenAI 的验证码页有时填完就自动提交，没有「继续」按钮也允许
      return { filled: target, autoSubmit: true };
    }
    clickWithFallback(cont);
    return { filled: target };
  }

  async function executeConfirmOAuth() {
    let btn = null;
    for (let i = 0; i < 30 && !btn; i += 1) {
      btn = findOAuthConsentButton();
      if (!btn) await sleep(300);
    }
    if (!btn) throw new Error('未找到 OAuth 同意按钮。');
    clickWithFallback(btn);
    return { clicked: actionText(btn).slice(0, 50) };
  }

  // ---------- 消息处理 ----------

  if (document.documentElement.getAttribute('data-cpa-reauth-listener') !== '1') {
    document.documentElement.setAttribute('data-cpa-reauth-listener', '1');

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return;
      if (!message.type.startsWith('CPA_')) return;

      (async () => {
        try {
          if (message.type === CPA_MSG.INSPECT_AUTH_PAGE) {
            return inspectPage();
          }
          if (message.type === CPA_MSG.EXECUTE_FILL_EMAIL) {
            return await executeFillEmail(message.payload?.email);
          }
          if (message.type === CPA_MSG.EXECUTE_FILL_PASSWORD) {
            return await executeFillPassword(message.payload?.password);
          }
          if (message.type === CPA_MSG.EXECUTE_FILL_VERIFICATION_CODE) {
            return await executeFillVerificationCode(message.payload?.code);
          }
          if (message.type === CPA_MSG.EXECUTE_CONFIRM_OAUTH) {
            return await executeConfirmOAuth();
          }
          return { ignored: true };
        } catch (error) {
          return { error: String(error?.message || error) };
        }
      })()
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ error: String(error?.message || error) }));

      return true; // keep channel open for async sendResponse
    });
  }
})();
