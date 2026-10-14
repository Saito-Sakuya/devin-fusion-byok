'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configureNativeDirectEnv } = require('../src/lifecycle/native-direct-env.cjs');
const { restoreObject, permitted } = require('../src/lifecycle/owned-settings.cjs');

function apply(agentEnv, receipt, options = {}) {
  return configureNativeDirectEnv({ agentEnv, receipt, platform: 'win32', proxySupport: 'off', ...options });
}
test('Windows direct mode suppresses registry fallback for main and summary ACP without redirecting summary RPCs', () => {
  const receipt = { changes: [] };
  const original = { 'devin-cli': { WINDSURF_API_SERVER_URL: 'http://127.0.0.1:39842', KEEP: 'retained', HTTPS_PROXY: 'http://user-proxy' },
    'summary-agent': { KEEP: 'summary', WINDSURF_API_SERVER_URL: 'https://official.example' }, other: { HTTP_PROXY: 'http://other-proxy' } };
  const result = apply(original, receipt);
  for (const agent of ['devin-cli', 'summary-agent']) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      assert.ok(result[agent][key].length > 0);
      assert.equal(result[agent][key].trim(), '');
    }
    assert.equal(result[agent].NO_PROXY, '*');
    assert.equal(result[agent].no_proxy, '*');
  }
  assert.equal(result['devin-cli'].WINDSURF_API_SERVER_URL, original['devin-cli'].WINDSURF_API_SERVER_URL);
  assert.equal(result['summary-agent'].WINDSURF_API_SERVER_URL, original['summary-agent'].WINDSURF_API_SERVER_URL);
  assert.deepEqual(result.other, original.other);
  assert.equal(original['devin-cli'].HTTPS_PROXY, 'http://user-proxy');
  assert.equal(original['summary-agent'].HTTP_PROXY, undefined);
  assert.deepEqual(restoreObject({ 'devin.acp.agentEnv': result }, receipt.changes).value['devin.acp.agentEnv'], original);
});
test('repeat configuration preserves originals and proxy mode changes restore them', () => {
  const receipt = { changes: [] }, original = { 'devin-cli': { HTTP_PROXY: 'http://original', NO_PROXY: 'localhost' }, 'summary-agent': {} };
  const first = apply(original, receipt);
  const again = apply(first, receipt);
  assert.deepEqual(again, first);
  assert.equal(receipt.changes.length, 16);
  assert.deepEqual(apply(again, receipt, { proxySupport: 'on' }), original);
  assert.equal(receipt.changes.length, 0);
});
test('restore retains user edits to managed values and foreign settings receipts', () => {
  const receipt = { changes: [{ path: ['devin.acp.agentPreferences', 'devin-cli', 'model'], managed: 'fusion-dfbyok-test', original: { exists: false } }] };
  const next = apply({ 'devin-cli': {}, 'summary-agent': {} }, receipt);
  next['summary-agent'].HTTPS_PROXY = 'http://subsequent-user-edit';
  const restored = apply(next, receipt, { proxySupport: 'override' });
  assert.equal(restored['summary-agent'].HTTPS_PROXY, 'http://subsequent-user-edit');
  assert.equal(restored['devin-cli'].HTTP_PROXY, undefined);
  assert.equal(receipt.changes.length, 1);
});
test('enabled proxies and other platforms retain the user environment', () => {
  const original = { 'devin-cli': { HTTPS_PROXY: 'http://user' } };
  for (const options of [{ proxySupport: undefined }, { proxySupport: 'on' }, { platform: 'linux' }]) {
    const receipt = { changes: [] };
    assert.deepEqual(apply(original, receipt, options), original);
    assert.equal(receipt.changes.length, 0);
  }
});
test('summary ownership permits only proxy keys', () => {
  assert.equal(permitted(['devin.acp.agentEnv', 'summary-agent', 'HTTPS_PROXY']), true);
  for (const key of ['WINDSURF_API_SERVER_URL', 'WINDSURF_API_KEY', 'NODE_EXTRA_CA_CERTS', 'PATH']) {
    assert.equal(permitted(['devin.acp.agentEnv', 'summary-agent', key]), false);
  }
  assert.equal(permitted(['devin.acp.agentPreferences', 'summary-agent', 'model']), false);
  assert.equal(permitted(['devin.acp.agentEnv', 'other', 'HTTP_PROXY']), false);
});
