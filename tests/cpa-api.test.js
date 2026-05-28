const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Load the module by source so we can test the pure-function helpers
// without spinning up a Chrome extension context.
const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'background', 'cpa-api.js'), 'utf8');
const api = new Function('self', `${moduleSource}; return self.CpaReauthApi;`)({});

test('pickReauthCandidatesFromAuthFiles only picks codex provider with unavailable=true', () => {
  const files = [
    { provider: 'codex', email: 'a@duck.com', unavailable: true },
    { provider: 'codex', email: 'b@duck.com', unavailable: false },
    { provider: 'gemini', email: 'c@duck.com', unavailable: true },
    { provider: 'CODEX', email: 'D@DUCK.com', unavailable: true },
    { provider: 'codex', email: '', unavailable: true },
    { provider: 'codex', email: 'invalid', unavailable: true },
    null,
    { provider: 'codex' },
  ];
  const result = api.pickReauthCandidatesFromAuthFiles(files);
  assert.deepEqual(result, ['a@duck.com', 'd@duck.com']);
});

test('pickReauthCandidatesFromAuthFiles dedupes emails (case-insensitive)', () => {
  const files = [
    { provider: 'codex', email: 'X@DUCK.com', unavailable: true },
    { provider: 'codex', email: 'x@duck.com', unavailable: true },
    { provider: 'codex', email: 'x@duck.com', unavailable: true },
  ];
  assert.deepEqual(api.pickReauthCandidatesFromAuthFiles(files), ['x@duck.com']);
});

test('pickReauthCandidatesFromAuthFiles uses `account` field as email fallback', () => {
  const files = [
    { provider: 'codex', account: 'fallback@duck.com', unavailable: true },
  ];
  assert.deepEqual(api.pickReauthCandidatesFromAuthFiles(files), ['fallback@duck.com']);
});

test('normalizeBaseUrl throws when missing or invalid', () => {
  assert.throws(() => api.normalizeBaseUrl(''), /未配置/);
  assert.throws(() => api.normalizeBaseUrl('not a url'), /格式无效/);
  assert.throws(() => api.normalizeBaseUrl('ftp://cpa.example.com'), /http/);
});

test('normalizeBaseUrl returns origin (drops path/query)', () => {
  assert.equal(api.normalizeBaseUrl('https://cpa.example.com/v0/management/foo?x=1'), 'https://cpa.example.com');
  assert.equal(api.normalizeBaseUrl('http://localhost:8317/'), 'http://localhost:8317');
});

// ---------- classifyCodexProbeResult ----------

test('classifyCodexProbeResult: 2xx → healthy', () => {
  assert.deepEqual(api.classifyCodexProbeResult({ apiCallOk: true, statusCode: 200, body: '{"plan":"plus"}' }), { status: 'healthy', reason: '200' });
  assert.deepEqual(api.classifyCodexProbeResult({ apiCallOk: true, statusCode: 204, body: '' }), { status: 'healthy', reason: '204' });
});

test('classifyCodexProbeResult: 401/403 → needs_reauth', () => {
  assert.deepEqual(api.classifyCodexProbeResult({ apiCallOk: true, statusCode: 401, body: '{"detail":"invalid_token"}' }), { status: 'needs_reauth', reason: '401' });
  assert.deepEqual(api.classifyCodexProbeResult({ apiCallOk: true, statusCode: 403, body: '{}' }), { status: 'needs_reauth', reason: '403' });
});

test('classifyCodexProbeResult: 429 → quota_exceeded', () => {
  assert.deepEqual(api.classifyCodexProbeResult({ apiCallOk: true, statusCode: 429, body: 'whatever' }), { status: 'quota_exceeded', reason: '429' });
});

test('classifyCodexProbeResult: any status with quota-ish body → quota_exceeded', () => {
  assert.equal(api.classifyCodexProbeResult({ apiCallOk: true, statusCode: 400, body: '{"code":"rate_limit_exceeded"}' }).status, 'quota_exceeded');
  assert.equal(api.classifyCodexProbeResult({ apiCallOk: true, statusCode: 400, body: '{"detail":"You are over the usage limit."}' }).status, 'quota_exceeded');
  assert.equal(api.classifyCodexProbeResult({ apiCallOk: true, statusCode: 500, body: 'quota exceeded for this period' }).status, 'quota_exceeded');
});

test('classifyCodexProbeResult: other non-quota errors → needs_reauth (per user spec)', () => {
  assert.equal(api.classifyCodexProbeResult({ apiCallOk: true, statusCode: 404, body: 'not found' }).status, 'needs_reauth');
  assert.equal(api.classifyCodexProbeResult({ apiCallOk: true, statusCode: 500, body: 'internal error' }).status, 'needs_reauth');
  assert.equal(api.classifyCodexProbeResult({ apiCallOk: true, statusCode: 502, body: '' }).status, 'needs_reauth');
});

test('classifyCodexProbeResult: api-call itself failed → unknown (don\'t risk re-auth)', () => {
  assert.deepEqual(api.classifyCodexProbeResult({ apiCallOk: false }), { status: 'unknown', reason: 'api-call-failed' });
});

test('classifyCodexProbeResult: missing/zero status code → unknown', () => {
  assert.equal(api.classifyCodexProbeResult({ apiCallOk: true, statusCode: 0, body: '' }).status, 'unknown');
  assert.equal(api.classifyCodexProbeResult({ apiCallOk: true }).status, 'unknown');
});

// ---------- pickCodexCandidatesForProbing ----------

test('pickCodexCandidatesForProbing: picks all codex files with auth_index + email', () => {
  const files = [
    { provider: 'codex', email: 'a@duck.com', auth_index: 'idx-a', unavailable: true, id_token: { chatgpt_account_id: 'acct-a' } },
    { provider: 'codex', email: 'b@duck.com', auth_index: 'idx-b', unavailable: false },
    { provider: 'gemini', email: 'c@duck.com', auth_index: 'idx-c', unavailable: true },
    { provider: 'codex', email: '', auth_index: 'no-email' },
    { provider: 'codex', email: 'd@duck.com', auth_index: '' },  // no auth_index → drop
  ];
  const result = api.pickCodexCandidatesForProbing(files);
  assert.equal(result.length, 2);
  assert.equal(result[0].email, 'a@duck.com');
  assert.equal(result[0].accountId, 'acct-a');
  assert.equal(result[0].unavailable, true);
  assert.equal(result[1].email, 'b@duck.com');
  assert.equal(result[1].unavailable, false);
});

test('pickCodexCandidatesForProbing: same email twice → keeps unavailable=true one', () => {
  const files = [
    { provider: 'codex', email: 'dup@duck.com', auth_index: 'fresh', unavailable: false },
    { provider: 'codex', email: 'dup@duck.com', auth_index: 'stale', unavailable: true },
  ];
  const result = api.pickCodexCandidatesForProbing(files);
  assert.equal(result.length, 1);
  assert.equal(result[0].authIndex, 'stale');
  assert.equal(result[0].unavailable, true);
});
