const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Extract isLocalhostCallbackUrl from auth-flow-runner.js for unit testing.
const source = fs.readFileSync(path.join(__dirname, '..', 'background', 'auth-flow-runner.js'), 'utf8');

// Stub out the deps the module pulls from `root` so the IIFE doesn't blow up
// trying to call CpaReauthApi / CpaReauthState etc. We only need isLocalhostCallbackUrl.
const stubScope = {
  CPA_CALLBACK_PORT: 1455,
  CpaReauthApi: {},
  CpaReauthState: {},
  CPA_MSG: {},
  CPA_AUTH_PAGE_READY_TIMEOUT_MS: 0,
  CPA_FILL_EMAIL_TIMEOUT_MS: 0,
  CPA_FILL_PASSWORD_TIMEOUT_MS: 0,
  CPA_OAUTH_CONSENT_TIMEOUT_MS: 0,
  CPA_LOCALHOST_CALLBACK_TIMEOUT_MS: 0,
  CPA_PER_EMAIL_TIMEOUT_MS: 0,
  chrome: {
    tabs: { get: () => Promise.resolve({}), update: () => Promise.resolve(), create: () => Promise.resolve({ id: 0 }), remove: () => Promise.resolve(), sendMessage: () => Promise.resolve({}) },
    webNavigation: { onBeforeNavigate: { addListener: () => {}, removeListener: () => {} }, onCommitted: { addListener: () => {}, removeListener: () => {} } },
  },
};

const flow = new Function('self', `
const chrome = self.chrome;
${source}
return self.CpaReauthAuthFlow;
`)(stubScope);

test('isLocalhostCallbackUrl accepts localhost with code+state', () => {
  assert.equal(flow.isLocalhostCallbackUrl('http://localhost:1455/auth/callback?code=abc&state=xyz'), true);
  assert.equal(flow.isLocalhostCallbackUrl('http://127.0.0.1:1455/auth/callback?code=abc&state=xyz'), true);
  assert.equal(flow.isLocalhostCallbackUrl('http://localhost:1455/?code=abc&state=xyz'), true);
});

test('isLocalhostCallbackUrl rejects non-localhost hosts', () => {
  assert.equal(flow.isLocalhostCallbackUrl('https://auth.openai.com/auth/callback?code=abc&state=xyz'), false);
  assert.equal(flow.isLocalhostCallbackUrl('https://example.com/?code=abc&state=xyz'), false);
});

test('isLocalhostCallbackUrl requires both code and state', () => {
  assert.equal(flow.isLocalhostCallbackUrl('http://localhost:1455/'), false);
  assert.equal(flow.isLocalhostCallbackUrl('http://localhost:1455/?code=abc'), false);
  assert.equal(flow.isLocalhostCallbackUrl('http://localhost:1455/?state=xyz'), false);
});

test('isLocalhostCallbackUrl tolerates different ports', () => {
  // Some CPA setups proxy 1455 through a different port; still considered valid.
  assert.equal(flow.isLocalhostCallbackUrl('http://localhost:18765/auth/callback?code=abc&state=xyz'), true);
});

test('isLocalhostCallbackUrl rejects file:// and javascript: schemes', () => {
  assert.equal(flow.isLocalhostCallbackUrl(''), false);
  assert.equal(flow.isLocalhostCallbackUrl(null), false);
  assert.equal(flow.isLocalhostCallbackUrl('file://localhost/?code=abc&state=xyz'), false);
});
