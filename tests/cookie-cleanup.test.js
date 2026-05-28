const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'background', 'cookie-cleanup.js'), 'utf8');
const api = new Function('self', `${source}; return self.CpaReauthCookieCleanup;`)({});

test('shouldClearCookie matches all OpenAI/ChatGPT root + subdomains', () => {
  // exact matches
  assert.equal(api.shouldClearCookie({ domain: 'chatgpt.com' }), true);
  assert.equal(api.shouldClearCookie({ domain: 'openai.com' }), true);
  assert.equal(api.shouldClearCookie({ domain: 'auth.openai.com' }), true);
  assert.equal(api.shouldClearCookie({ domain: 'auth0.openai.com' }), true);
  assert.equal(api.shouldClearCookie({ domain: 'accounts.openai.com' }), true);
  assert.equal(api.shouldClearCookie({ domain: 'chat.openai.com' }), true);
  // leading-dot variants (host-only=false cookies)
  assert.equal(api.shouldClearCookie({ domain: '.chatgpt.com' }), true);
  assert.equal(api.shouldClearCookie({ domain: '.openai.com' }), true);
  // subdomains
  assert.equal(api.shouldClearCookie({ domain: 'api.openai.com' }), true);
  assert.equal(api.shouldClearCookie({ domain: 'cdn.chatgpt.com' }), true);
});

test('shouldClearCookie rejects unrelated domains', () => {
  assert.equal(api.shouldClearCookie({ domain: 'google.com' }), false);
  assert.equal(api.shouldClearCookie({ domain: 'openai.malicious.com' }), false); // suffix attack
  assert.equal(api.shouldClearCookie({ domain: 'notopenai.com' }), false);
  assert.equal(api.shouldClearCookie({ domain: '' }), false);
  assert.equal(api.shouldClearCookie({}), false);
  assert.equal(api.shouldClearCookie(null), false);
});

test('normalizeDomain strips leading dots and lowercases', () => {
  assert.equal(api.normalizeDomain('.ChatGPT.com'), 'chatgpt.com');
  assert.equal(api.normalizeDomain('..openai.com'), 'openai.com');
  assert.equal(api.normalizeDomain('  AUTH.OPENAI.COM  '), 'auth.openai.com');
  assert.equal(api.normalizeDomain(undefined), '');
});

test('buildRemovalUrl produces a valid https URL with path defaulting to /', () => {
  assert.equal(
    api.buildRemovalUrl({ domain: 'chatgpt.com', path: '/' }),
    'https://chatgpt.com/'
  );
  assert.equal(
    api.buildRemovalUrl({ domain: '.openai.com', path: '/auth' }),
    'https://openai.com/auth'
  );
  assert.equal(
    api.buildRemovalUrl({ domain: 'auth.openai.com', path: 'no-slash' }),
    'https://auth.openai.com/no-slash'
  );
  assert.equal(
    api.buildRemovalUrl({ domain: 'chatgpt.com' }),
    'https://chatgpt.com/'
  );
});

test('clearOpenAiCookies returns skipped when cookies API unavailable', async () => {
  const fakeScope = {};
  const fakeApi = new Function('self', `${source}; return self.CpaReauthCookieCleanup;`)(fakeScope);
  fakeScope.chrome = {}; // no cookies API
  const result = await fakeApi.clearOpenAiCookies();
  assert.equal(result.removedCount, 0);
  assert.match(result.skipped || '', /not available/i);
});

test('clearOpenAiCookies removes only matching cookies and returns counts', async () => {
  // Build a fake chrome.cookies that returns mixed cookies and tracks removals.
  const removed = [];
  const fakeScope = {
    chrome: {
      cookies: {
        getAllCookieStores: async () => [{ id: 'default' }],
        getAll: async ({ domain }) => {
          // Return a cookie for every domain we know
          return [
            { name: 'a', domain, path: '/', storeId: 'default' },
            // Mix in one off-domain cookie that should be filtered out by shouldClear
            ...(domain === 'chatgpt.com' ? [{ name: 'b', domain: 'google.com', path: '/', storeId: 'default' }] : []),
          ];
        },
        remove: async (details) => {
          removed.push(details);
          return { name: details.name };
        },
      },
    },
  };
  const fakeApi = new Function('self', `${source}; return self.CpaReauthCookieCleanup;`)(fakeScope);
  const result = await fakeApi.clearOpenAiCookies();
  assert.equal(result.removedCount, 6, 'should have removed exactly one cookie per known CLEAR_DOMAIN (6 total)');
  // The off-domain google.com cookie that getAll returned should be filtered out by shouldClearCookie
  assert.equal(removed.some((d) => d.url.includes('google.com')), false);
  assert.ok(removed.every((d) => d.url.startsWith('https://')));
});
