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
