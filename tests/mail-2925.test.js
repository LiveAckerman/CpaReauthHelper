const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// content/mail-2925.js 直接执行依赖 chrome.runtime / document，
// 我们用最小 stub 让它装载完，再通过 self.__CPA_REAUTH_MAIL2925_INTERNALS 拿到内部纯函数测。

const source = fs.readFileSync(path.join(__dirname, '..', 'content', 'mail-2925.js'), 'utf8');

function buildInternals() {
  const scope = {
    chrome: {
      runtime: {
        onMessage: { addListener: () => {} },
      },
    },
    document: {
      documentElement: {
        attrs: {},
        getAttribute(name) { return this.attrs[name]; },
        setAttribute(name, v) { this.attrs[name] = v; },
      },
      body: { innerText: '' },
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    location: { href: 'https://www.2925.com/', pathname: '/' },
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    console: { log: () => {}, warn: () => {} },
  };
  // eslint-disable-next-line no-new-func
  new Function('self', `
    const chrome = self.chrome;
    const document = self.document;
    const location = self.location;
    const window = self.window;
    const console = self.console;
    ${source}
  `)(scope);
  return scope.__CPA_REAUTH_MAIL2925_INTERNALS;
}

const api = buildInternals();

test('extractCodeFromText (strong) catches verification code with chinese label', () => {
  const t = '您的验证码是 123456，5 分钟内有效。';
  assert.equal(api.extractCodeFromText(t), '123456');
});

test('extractCodeFromText (strong) catches OpenAI english template', () => {
  const t = 'Your OpenAI verification code is 098765. Do not share.';
  assert.equal(api.extractCodeFromText(t), '098765');
});

test('extractCodeFromText (strong) catches code preceding label', () => {
  const t = '111222 is your verification code.';
  assert.equal(api.extractCodeFromText(t), '111222');
});

test('extractCodeFromText (strong) ignores 6-digit numbers without context', () => {
  const t = 'Order #135246 shipped on 2025-01-15.';
  assert.equal(api.extractCodeFromText(t), '', 'should not pick up unrelated 6-digit numbers in strong mode');
});

test('extractCodeFromText (weak) picks first 6-digit when allowWeak=true', () => {
  const t = 'Some preview text 246810 etc.';
  assert.equal(api.extractCodeFromText(t, { allowWeak: true }), '246810');
});

test('extractCodeFromText (weak) ignores 7+ digit runs', () => {
  const t = 'Reference 12345678 (not a code)';
  // 6-digit not present, weak mode should NOT pick into the 7-digit run
  assert.equal(api.extractCodeFromText(t, { allowWeak: true }), '');
});

test('isLikelyOpenAiItem matches only ChatGPT/OpenAI verification emails (brand + code keyword)', () => {
  // 真正的验证码邮件：品牌词 + code 关键字
  assert.equal(api.isLikelyOpenAiItem('OpenAI <noreply@openai.com> Your verification code'), true);
  assert.equal(api.isLikelyOpenAiItem('ChatGPT 验证码 123456'), true);
  assert.equal(api.isLikelyOpenAiItem('ChatGPT Your temporary ChatGPT login code'), true);
  assert.equal(api.isLikelyOpenAiItem('ChatGPT Your temporary login code is 098765'), true);
  // 仅含 "code"，不含品牌词 —— 仍然命中（避免漏过转发后只剩正文的情况）
  // ……但我们要的恰恰是同时要品牌词，所以以下应该不命中
  assert.equal(api.isLikelyOpenAiItem('your code is 123456'), false);
  // 无关邮件
  assert.equal(api.isLikelyOpenAiItem('GitHub login attempt'), false);
  assert.equal(api.isLikelyOpenAiItem('Random spam'), false);
});

test('isLikelyOpenAiItem rejects ChatGPT marketing emails (brand without code keyword)', () => {
  // 这是真实 2925 收件箱里出现的营销邮件 —— 不能被当成验证码邮件
  assert.equal(
    api.isLikelyOpenAiItem('ChatGPT 给你的一些实用点子 将你的灵感'),
    false,
    'marketing email with brand but no code keyword must be rejected',
  );
  assert.equal(
    api.isLikelyOpenAiItem('ChatGPT 每周精选 看看大家在用 ChatGPT 做什么'),
    false,
  );
  assert.equal(
    api.isLikelyOpenAiItem('OpenAI Newsletter: product updates this week'),
    false,
  );
});

test('isAnyOpenAiBrandedItem still matches brand-only items (diagnostic helper)', () => {
  assert.equal(api.isAnyOpenAiBrandedItem('ChatGPT 给你的一些实用点子'), true);
  assert.equal(api.isAnyOpenAiBrandedItem('ChatGPT Your temporary ChatGPT login code'), true);
  assert.equal(api.isAnyOpenAiBrandedItem('GitHub login attempt'), false);
});

test('previewMentionsRecipient: empty recipient = pass-through', () => {
  assert.equal(api.previewMentionsRecipient('OpenAI 123456', ''), true);
});

test('previewMentionsRecipient: case-insensitive substring match', () => {
  assert.equal(api.previewMentionsRecipient('To: COCOA-worst-impose@duck.com', 'cocoa-worst-impose@duck.com'), true);
  assert.equal(api.previewMentionsRecipient('To: someone-else@duck.com', 'cocoa-worst-impose@duck.com'), false);
});

test('isUnreadItem: tr.unread-mail is detected as unread', () => {
  const fakeRow = {
    classList: { contains: (c) => c === 'unread-mail' },
    closest: () => null,
    querySelector: () => null,
  };
  assert.equal(api.isUnreadItem(fakeRow), true);
});

test('isUnreadItem: row inside tr.unread-mail ancestor is unread', () => {
  const fakeRow = {
    classList: { contains: () => false },
    closest: (sel) => (/unread/i.test(sel) ? {} : null),
    querySelector: () => null,
  };
  assert.equal(api.isUnreadItem(fakeRow), true);
});

test('isUnreadItem: no unread markers → false', () => {
  const fakeRow = {
    classList: { contains: () => false },
    closest: () => null,
    querySelector: () => null,
  };
  assert.equal(api.isUnreadItem(fakeRow), false);
});

test('isUnreadItem: returns false on null', () => {
  assert.equal(api.isUnreadItem(null), false);
});
