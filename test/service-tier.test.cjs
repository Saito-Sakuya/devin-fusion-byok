'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildCatalog } = require('../src/catalog.cjs');
const { createManager, PanelInputError } = require('../src/panel/model.cjs');
const { buildRequestBody } = require('../src/protocol/responses.cjs');
const { startBackend } = require('../src/runtime/backend.cjs');
const { createMonitor, createTracker } = require('../src/runtime/monitor.cjs');
const { contextDetails } = require('../src/panel/context-view.cjs');
const { readConfig, writeConfig } = require('../src/config.cjs');
const wire = require('../src/protocol/wire.cjs');
const request = { systemPrompt: 'Stable fixture instructions.', messages: [{ role: 'user', content: 'Synthetic tier test.' }],
  tools: [{ name: 'fixture', parameters: { type: 'object', properties: {} }, strict: false }] };
function config(apiFormat = 'openai-responses') {
  return { enabled: true, providers: [{ id: 'fixture', name: 'Fixture', apiFormat, apiKey: 'private-tier-fixture', baseUrl: 'https://fixture.invalid/v1',
    models: [{ id: 'gpt-6.1-sol', efforts: ['low', 'high'] }, { id: 'gpt-5.4', efforts: ['medium'] }] }],
    sidekicks: [], fusionPresets: [{ id: 'saved', name: 'Saved fusion', lead: { providerId: 'fixture', model: 'gpt-6.1-sol', effort: 'high' },
      sidekick: { providerId: 'fixture', model: 'gpt-5.4', effort: 'medium' } }] };
}
function memory(value = config()) {
  let current = structuredClone(value), writes = 0;
  const manager = createManager({ read: () => structuredClone(current), write: value => { current = structuredClone(value); writes++; } });
  return { manager, read: () => current, writes: () => writes };
}
const update = (manager, serviceTier, id = 'gpt-6.1-sol') => manager.dispatch('updateModels', { providerId: 'fixture', changes: [{ id, serviceTier }] });
function removeFixture(root) {
  const resolved = fs.realpathSync(root), relative = path.relative(fs.realpathSync(os.tmpdir()), resolved);
  assert.ok(relative.startsWith('byok-tier-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
  fs.rmSync(resolved, { recursive: true, force: true });
}

test('service tiers preserve model and Fusion identities, reasoning, tools and cache keys in both OpenAI APIs', async () => {
  for (const apiFormat of ['openai-responses', 'openai']) {
    const f = memory(config(apiFormat)), initial = buildCatalog(f.read());
    const baseRoute = Object.values(initial.routes).find(route => route.model === 'gpt-6.1-sol' && route.effort === 'high');
    const baseBody = buildRequestBody(request, baseRoute, f.read().providers[0]);
    assert.equal(Object.hasOwn(baseBody, 'service_tier'), false);
    for (const tier of ['fast', 'priority', 'default', '']) {
      const state = await update(f.manager, tier);
      const catalog = buildCatalog(f.read());
      assert.deepEqual(Object.keys(catalog.routes), Object.keys(initial.routes));
      assert.deepEqual(Object.keys(catalog.fusions), Object.keys(initial.fusions));
      for (const route of Object.values(catalog.routes).filter(route => route.model === 'gpt-6.1-sol')) assert.equal(route.serviceTier || '', tier);
      assert.equal(state.providers[0].models[0].serviceTier, tier);
      assert.equal(JSON.stringify(state).includes('private-tier-fixture'), false);
      const body = buildRequestBody(request, catalog.routes[baseRoute.uid], f.read().providers[0]);
      assert.equal(body.service_tier, tier || undefined);
      delete body.service_tier;
      assert.deepEqual(body, baseBody);
    }
    assert.equal(Object.hasOwn(f.read().providers[0].models[0], 'serviceTier'), false);
    await update(f.manager, 'priority', 'gpt-5.4');
    const catalog = buildCatalog(f.read()), fusion = Object.values(catalog.fusions)[0];
    assert.equal(catalog.routes[fusion.sidekickUid].serviceTier, 'priority');
    assert.equal(catalog.routes[fusion.leadUid].serviceTier, undefined);
  }
});

test('invalid and Anthropic tiers are rejected before writes; protocol changes suppress stale OpenAI settings', async () => {
  const f = memory();
  for (const tier of ['ultrafast', 'flex', 'auto', 'FAST', ' fast ', true, null, { value: 'fast' }]) {
    await assert.rejects(update(f.manager, tier), PanelInputError);
    assert.equal(f.writes(), 0);
  }
  const anthropic = memory(config('anthropic'));
  await assert.rejects(update(anthropic.manager, 'fast'), /仅支持 OpenAI/);
  assert.equal(anthropic.writes(), 0);
  const stale = config('anthropic'); stale.providers[0].models[0].serviceTier = 'fast';
  const catalog = buildCatalog(stale), route = Object.values(catalog.routes)[0];
  assert.equal(route.serviceTier, undefined);
  assert.equal(buildRequestBody(request, { ...route, serviceTier: 'fast' }, stale.providers[0]).service_tier, undefined);
  const malformed = config(); malformed.providers[0].models[0].serviceTier = 'not-a-tier';
  assert.throws(() => buildCatalog(malformed), /Invalid model service tier/);
});

test('terminal tiers distinguish actual fallback, absent reports and hostile values; persisted records stay allowlisted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-tier-monitor-'));
  try {
    const monitor = createMonitor({ root, databasePath: path.join(root, 'absent.db') });
    const make = (id, actual) => {
      const tracker = createTracker({ id, request, route: { model: 'gpt-6.1-sol', serviceTier: 'fast' }, provider: { id: 'fixture' } });
      tracker.event({ type: 'response.created', data: { response: { service_tier: 'fast' } } }, false);
      tracker.event({ type: 'response.completed', data: { response: actual === undefined ? {} : { service_tier: actual } } }, false);
      return tracker.finish('success', 200);
    };
    for (const [id, actual] of [['fallback', 'default'], ['supported', 'priority'], ['missing', undefined], ['hostile', 'PRIVATE_TIER_VALUE']]) monitor.record(make(id, actual));
    const snapshot = await monitor.snapshot(), records = new Map(snapshot.records.map(record => [record.id, record]));
    assert.equal(records.get('fallback').serviceTierActual, 'default');
    assert.equal(records.get('supported').serviceTierActual, 'priority');
    assert.equal(records.get('missing').serviceTierActual, null);
    assert.equal(records.get('hostile').serviceTierActual, null);
    assert.equal(JSON.stringify(snapshot).includes('PRIVATE_TIER_VALUE'), false);
    assert.equal(fs.readFileSync(path.join(root, 'monitor.jsonl'), 'utf8').includes('PRIVATE_TIER_VALUE'), false);
    const reloaded = await createMonitor({ root, databasePath: path.join(root, 'absent.db') }).snapshot();
    assert.equal(reloaded.records.find(record => record.id === 'fallback').serviceTierActual, 'default');
    const details = contextDetails({ sessionId: 'fixture' }, { sessions: [{ sessionId: 'fixture', records: [records.get('fallback')] }] });
    assert.equal(details.request.find(row => row.key === 'serviceTierRequested').value, 'fast');
    assert.equal(details.request.find(row => row.key === 'serviceTierActual').value, 'default');
  } finally { removeFixture(root); }
});

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
for (const apiFormat of ['openai-responses', 'openai']) {
  test(apiFormat + ' sends saved tiers through the real backend and records the upstream actual tier', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-tier-backend-')), file = path.join(root, 'config.json');
    const bodies = [], logs = []; let backend;
    const upstream = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const data = apiFormat === 'openai' ? { service_tier: 'default', choices: [{ index: 0, delta: { content: 'TIER_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }
        : { type: 'response.completed', response: { status: 'completed', service_tier: 'default', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'TIER_OK' }] }], usage: { input_tokens: 10, output_tokens: 2 } } };
      res.end('data: ' + JSON.stringify(data) + '\n\n' + (apiFormat === 'openai' ? 'data: [DONE]\n\n' : ''));
    });
    try {
      const saved = config(apiFormat); saved.providers[0].baseUrl = await listen(upstream); writeConfig(file, saved);
      const manager = createManager({ read: () => readConfig(file), write: value => writeConfig(file, value) });
      backend = await startBackend({ root, port: 0, log: (event, data) => logs.push({ event, ...data }) });
      const uid = Object.values(buildCatalog(saved).routes).find(route => route.model === 'gpt-6.1-sol').uid;
      for (const tier of ['fast', 'priority', 'default', '']) {
        await update(manager, tier);
        const response = await fetch('http://127.0.0.1:' + backend.port + '/exa.api_server_pb.ApiServerService/GetChatMessage', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatModelUid: uid, chatMessagePrompts: [{ source: 1, prompt: 'Synthetic tier test.' }] }) });
        const bytes = Buffer.from(await response.arrayBuffer()); let text = '';
        for (let offset = 0; offset < bytes.length;) {
          const size = bytes.readUInt32BE(offset + 1);
          if (!(bytes[offset] & 2)) text += wire.str(bytes.subarray(offset + 5, offset + 5 + size), 3);
          offset += 5 + size;
        }
        assert.equal(text, 'TIER_OK');
        assert.equal(bodies.at(-1).service_tier, tier || undefined);
      }
      await backend.close(); backend = null;
      const records = fs.readFileSync(path.join(root, 'monitor.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(records.map(record => record.serviceTierRequested), ['fast', 'priority', 'default', null]);
      assert.deepEqual(records.map(record => record.serviceTierActual), ['default', 'default', 'default', 'default']);
      assert.equal(JSON.stringify(logs).includes('private-tier-fixture'), false);
    } finally {
      if (backend) await backend.close(); await close(upstream);
      removeFixture(root);
    }
  });
}
