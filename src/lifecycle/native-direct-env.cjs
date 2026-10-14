'use strict';
const { valueAt, remember, restoreObject } = require('./owned-settings.cjs');
const OWNER = 'windows-native-direct';
const AGENTS = ['devin-cli', 'summary-agent'];
const DIRECT = { HTTP_PROXY: ' ', HTTPS_PROXY: ' ', ALL_PROXY: ' ', NO_PROXY: '*',
  http_proxy: ' ', https_proxy: ' ', all_proxy: ' ', no_proxy: '*' };

function configureNativeDirectEnv({ agentEnv, receipt, platform, proxySupport }) {
  const owned = receipt.changes.filter(change => change.owner === OWNER);
  const restored = restoreObject({ 'devin.acp.agentEnv': agentEnv }, owned);
  const next = restored.value['devin.acp.agentEnv'];
  receipt.changes = receipt.changes.filter(change => change.owner !== OWNER);
  if (platform !== 'win32' || proxySupport !== 'off') return next;

  // The bundled Windows CLI falls back to the registry when proxy variables
  // are empty, and its Connect transport ignores NO_PROXY. Whitespace prevents
  // that fallback but supplies no usable proxy URL. Keep NO_PROXY for tools
  // which support it. Verified against the bundled CLI's authenticated ACP.
  for (const agent of AGENTS) {
    for (const [key, managed] of Object.entries(DIRECT)) {
      const keys = ['devin.acp.agentEnv', agent, key];
      remember(receipt, keys, valueAt({ 'devin.acp.agentEnv': next }, keys), managed);
      receipt.changes.find(change => JSON.stringify(change.path) === JSON.stringify(keys)).owner = OWNER;
    }
    next[agent] = { ...(next[agent] || {}), ...DIRECT };
  }
  return next;
}
module.exports = { configureNativeDirectEnv };
