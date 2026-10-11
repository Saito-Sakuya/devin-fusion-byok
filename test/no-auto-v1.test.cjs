'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const extension = path.resolve(process.env.BYOK_TEST_EXTENSION || path.join(__dirname, '..'));
const { createManager } = require(path.join(extension, 'src/panel/model.cjs'));
const { discover } = require(path.join(extension, 'src/config.cjs'));
const { serveChat } = require(path.join(extension, 'src/protocol/responses.cjs'));
const { renderPanel } = require(path.join(extension, 'src/panel/view.cjs'));

function manager() {
  let config = { enabled: true, providers: [], sidekicks: [], roleExclusions: { lead: [], sidekick: [] } };
  return {
    read: () => structuredClone(config),
    api: createManager({ read: () => structuredClone(config), write: value => { config = structuredClone(value); } }),
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const anthropicCases = [
  ['domain', '', ''],
  ['domain with slash', '/', ''],
  ['custom path', '/proxy/anthropic', '/proxy/anthropic'],
  ['custom path with slash', '/proxy/anthropic/', '/proxy/anthropic'],
  ['pasted messages endpoint', '/proxy/anthropic/messages/', '/proxy/anthropic'],
  ['pasted models endpoint', '/proxy/anthropic/models', '/proxy/anthropic'],
  ['explicit v1', '/v1', '/v1'],
  ['explicit v4', '/gateway/v4/', '/gateway/v4'],
  ['explicit v1beta', '/gateway/v1beta/messages', '/gateway/v1beta'],
];

for (const [label, inputPath, expectedBasePath] of anthropicCases) {
  test('Anthropic save, model discovery and Messages request: ' + label, { timeout: 10000 }, async () => {
    const received = [];
    const upstream = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({ method: req.method, path: url.pathname, headers: req.headers,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
      if (req.method === 'GET' && url.pathname === expectedBasePath + '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test-model' }], has_more: false }));
      } else if (req.method === 'POST' && url.pathname === expectedBasePath + '/messages') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = [
          { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ];
        res.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''));
      } else {
        res.writeHead(404); res.end('Unexpected request path');
      }
    });
    let bridge;
    try {
      const origin = await listen(upstream);
      const saved = manager();
      await saved.api.dispatch('saveProvider', { name: 'Test', baseUrl: origin + inputPath,
        apiFormat: 'anthropic', apiKey: 'local-test-key' });
      const provider = saved.read().providers[0];
      assert.equal(provider.baseUrl, origin + expectedBasePath);
      assert.equal(await discover(provider), 1);
      const request = { modelUid: 'test-route', systemPrompt: '', messages: [{ role: 'user', content: 'ping' }] };
      let completion;
      bridge = http.createServer((req, res) => {
        completion = serveChat({ request, route: { model: 'test-model', uid: 'test-route' }, provider, res });
        completion.catch(error => { res.destroy(error); });
      });
      const response = await fetch(await listen(bridge));
      assert.equal(response.status, 200);
      assert.ok((await response.arrayBuffer()).byteLength > 0);
      assert.equal((await completion).error, undefined);
      assert.deepEqual(received.map(value => [value.method, value.path]), [
        ['GET', expectedBasePath + '/models'], ['POST', expectedBasePath + '/messages'],
      ]);
      assert.equal(received[1].headers['x-api-key'], 'local-test-key');
      assert.equal(received[1].body.model, 'test-model');
    } finally {
      if (bridge) await close(bridge);
      await close(upstream);
    }
  });
}

for (const apiFormat of ['openai-responses', 'openai']) {
  test(apiFormat + ' preserves existing version defaults', async () => {
    const saved = manager();
    for (const [input, expected] of [
      ['https://example.com', 'https://example.com/v1'],
      ['https://example.com/proxy', 'https://example.com/proxy/v1'],
      ['https://example.com/v4/chat/completions', 'https://example.com/v4'],
    ]) {
      await saved.api.dispatch('saveProvider', { name: 'Test', baseUrl: input, apiFormat });
      assert.equal(saved.read().providers.at(-1).baseUrl, expected);
    }
  });
}

test('editing an existing provider and switching API formats uses the selected format', async () => {
  const saved = manager();
  await saved.api.dispatch('saveProvider', { name: 'Test', baseUrl: 'https://example.com', apiFormat: 'openai', apiKey: 'local-test-key' });
  const id = saved.read().providers[0].id;
  await saved.api.dispatch('saveProvider', { id, name: 'Test', baseUrl: 'https://example.com/proxy', apiFormat: 'anthropic' });
  assert.equal(saved.read().providers[0].baseUrl, 'https://example.com/proxy');
  assert.equal(saved.read().providers[0].apiKey, 'local-test-key');
  await saved.api.dispatch('saveProvider', { id, name: 'Test', baseUrl: 'https://example.com/proxy', apiFormat: 'openai-responses' });
  assert.equal(saved.read().providers[0].baseUrl, 'https://example.com/proxy/v1');
});

test('generated webview scripts compile and injected normalizer accepts API format', () => {
  const html = renderPanel({ nonce: 'test', cspSource: 'https://example.com' });
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const [, script] of scripts) new vm.Script(script);
  const injected = html.match(/function normalizeBaseUrlPath\([^]*?\n\}/)?.[0];
  assert.ok(injected);
  const normalize = vm.runInNewContext('(' + injected + ')');
  assert.equal(normalize('/proxy', 'anthropic'), '/proxy');
  assert.equal(normalize('/proxy', 'openai'), '/proxy/v1');
});

test('actual webview preview follows input and API format changes', () => {
  const html = renderPanel({ nonce: 'test', cspSource: 'https://example.com' });
  const injected = html.match(/function normalizeBaseUrlPath\([^]*?\n\}/)?.[0];
  const previewCode = html.match(/const refreshPreview = \(\) => \{[\s\S]*?^    \};/m)?.[0];
  assert.ok(injected && previewCode);
  let children = [];
  const context = {
    URL, baseUrl: { value: 'https://example.com/proxy/messages' }, apiFormat: { value: 'anthropic' },
    normalizeBaseUrlPath: vm.runInNewContext('(' + injected + ')'),
    element: () => '<br>',
    urlPreview: { replaceChildren: () => { children = []; }, append: (...values) => { children.push(...values); } },
  };
  const refresh = vm.runInNewContext(previewCode + '\nrefreshPreview;', context);
  for (const [apiFormat, input, requestUrl, modelsUrl] of [
    ['anthropic', 'https://example.com/proxy/messages', 'https://example.com/proxy/messages', 'https://example.com/proxy/models'],
    ['openai', 'https://example.com/proxy/messages', 'https://example.com/proxy/v1/chat/completions', 'https://example.com/proxy/v1/models'],
    ['anthropic', 'https://example.com/v1', 'https://example.com/v1/messages', 'https://example.com/v1/models'],
    ['anthropic', 'https://example.com', 'https://example.com/messages', 'https://example.com/models'],
  ]) {
    context.apiFormat.value = apiFormat; context.baseUrl.value = input;
    refresh();
    assert.ok(children[0].endsWith(requestUrl));
    assert.ok(children[2].endsWith(modelsUrl));
  }
  context.baseUrl.value = 'invalid'; refresh();
  assert.deepEqual(children, []);
});
