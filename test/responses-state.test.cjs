'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const extension = path.resolve(process.env.BYOK_TEST_EXTENSION || path.join(__dirname, '..'));
const wire = require(path.join(extension, 'src/protocol/wire.cjs'));
const { parseChat } = require(path.join(extension, 'src/protocol/chat.cjs'));
const { buildRequestBody, serveChat } = require(path.join(extension, 'src/protocol/responses.cjs'));
const route = { model: 'gpt-6.1-sol', effort: 'low', uid: 'fixture-route' };
const reason = id => ({ id, type: 'reasoning', summary: [{ type: 'summary_text', text: 'Test summary.' }], encrypted_content: 'opaque-fixture-' + id });
const call = (id, args = '{ "source": "fixture://skill" }') => ({ id: 'item-' + id, type: 'function_call', call_id: id, name: 'skill', arguments: args, status: 'completed' });
const message = text => ({ id: 'message-fixture', type: 'message', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function nativeOutput(bytes) {
  const result = { content: '', signature: '', toolCalls: [], stop: 0 };
  for (let offset = 0; offset < bytes.length;) {
    const flags = bytes[offset], size = bytes.readUInt32BE(offset + 1);
    const data = bytes.subarray(offset + 5, offset + 5 + size);
    if (!(flags & 2)) {
      result.content += wire.str(data, 3); result.signature += wire.str(data, 10);
      result.stop ||= wire.num(data, 5);
      result.toolCalls.push(...wire.fields(data, 6).map(({ value }) => ({ id: wire.str(value, 1), name: wire.str(value, 2), arguments: wire.str(value, 3) })));
    }
    offset += 5 + size;
  }
  return result;
}
async function record(output, { incomplete = false, completedItems = true } = {}) {
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item }));
    events.push({ type: incomplete ? 'response.incomplete' : 'response.completed', response: { status: incomplete ? 'incomplete' : 'completed', ...(completedItems ? { output } : {}) } });
    res.end(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
  });
  let bridge, completion;
  try {
    const provider = { id: 'fixture-provider', baseUrl: await listen(upstream), apiFormat: 'openai-responses', apiKey: 'fixture-key' };
    bridge = http.createServer((req, res) => {
      completion = serveChat({ request: { systemPrompt: 'Stable instructions.', messages: [{ role: 'user', content: 'Test request.' }] }, route, provider, res });
      completion.catch(error => res.destroy(error));
    });
    const response = await fetch(await listen(bridge));
    const native = nativeOutput(Buffer.from(await response.arrayBuffer()));
    assert.equal((await completion).error, undefined);
    return { provider, native, received };
  } finally {
    if (bridge) await close(bridge);
    await close(upstream);
  }
}
function next(native, provider, overrides = {}) {
  return buildRequestBody({ systemPrompt: 'Stable instructions.', messages: [
    { role: 'user', content: 'Test request.' },
    { role: 'assistant', ...native, ...overrides },
    ...native.toolCalls.map(tool => ({ role: 'tool', toolCallId: tool.id, content: 'Fixture result.' })),
  ] }, route, provider);
}

test('Responses requests encrypted stateless output and preserves full output ordering across native signature', async () => {
  const output = [reason('r1'), message('Working.'), call('call-1'), reason('r2'), call('call-2', '{"step":2}')];
  const { provider, native, received } = await record(output);
  assert.equal(received.store, false);
  assert.deepEqual(received.include, ['reasoning.encrypted_content']);
  assert.equal(native.stop, 10);
  assert.equal(native.content, 'Working.');
  assert.ok(native.signature.startsWith('dfbyok-responses-v1:'));
  const body = next(native, provider);
  assert.deepEqual(body.input.slice(2, 7), output);
  assert.deepEqual(body.input.slice(7).map(i => i.call_id), ['call-1', 'call-2']);
  assert.equal(body.input.filter(i => i.type === 'function_call').length, 2);
});

for (const encoding of ['proto', 'json']) {
  test(`${encoding} native request restores opaque state after serialization`, async () => {
    const output = [reason('r1'), call('call-1')];
    const { provider, native } = await record(output);
    const input = encoding === 'proto' ? Buffer.concat([
      wire.m(3, Buffer.concat([wire.v(2, 3), wire.s(12, native.signature), wire.m(6, Buffer.concat([
        wire.s(1, native.toolCalls[0].id), wire.s(2, native.toolCalls[0].name), wire.s(3, native.toolCalls[0].arguments),
      ]))])),
    ]) : { chat_message_prompts: [{ source: 'UNKNOWN', signature: native.signature, tool_calls: native.toolCalls }] };
    const request = parseChat(input);
    assert.equal(request.messages[0].signature, native.signature);
    assert.deepEqual(buildRequestBody(request, route, provider).input, output);
  });
}

test('text-only assistant phase and output ID survive replay', async () => {
  const output = [reason('r1'), message('Complete.')];
  const { provider, native } = await record(output);
  assert.equal(native.stop, 2);
  assert.deepEqual(next(native, provider).input.slice(2), output);
});

test('item-done state survives gateways that omit output from response.completed', async () => {
  const output = [reason('r1'), call('call-1')];
  const { provider, native } = await record(output, { completedItems: false });
  assert.deepEqual(next(native, provider).input.slice(2, 4), output);
});

test('edited text, tool name, call ID or arguments discard obsolete opaque state', async () => {
  const { provider, native } = await record([reason('r1'), message('Working.'), call('call-1')]);
  for (const edit of [{ content: 'Edited.' }, { toolCalls: [] },
    { images: [{ mimeType: 'image/png', base64: 'fixture-image' }] },
    { toolCalls: [{ ...native.toolCalls[0], id: 'other-call' }] },
    { toolCalls: [{ ...native.toolCalls[0], name: 'other-tool' }] },
    { toolCalls: [{ ...native.toolCalls[0], arguments: '{"source":"changed"}' }] },
  ]) assert.equal(next(native, provider, edit).input.some(i => i.type === 'reasoning'), false);
});

test('tool argument reformatting preserves state when the JSON meaning is unchanged', async () => {
  const { provider, native } = await record([reason('r1'), call('call-1', '{"a":1,"b":{"c":2,"d":3}}')]);
  const body = next(native, provider, { toolCalls: [{ ...native.toolCalls[0], arguments: '{ "b": {"d":3,"c":2}, "a":1 }' }] });
  assert.equal(body.input.some(i => i.type === 'reasoning'), true);
  assert.equal(body.input.find(i => i.type === 'function_call').arguments, '{"a":1,"b":{"c":2,"d":3}}');
});

test('different provider, URL, key and model cannot receive the saved state', async () => {
  const { provider, native } = await record([reason('r1'), call('call-1')]);
  for (const changed of [{ ...provider, id: 'other' }, { ...provider, baseUrl: 'https://other.example' }, { ...provider, apiKey: 'other-key' }]) {
    assert.equal(next(native, changed).input.some(i => i.type === 'reasoning'), false);
  }
  const changed = buildRequestBody({ systemPrompt: '', messages: [{ role: 'assistant', ...native }] }, { ...route, model: 'gpt-6-astra' }, provider);
  assert.equal(changed.input.some(i => i.type === 'reasoning'), false);
});

test('cache key is stable as history grows and contains no provider credentials', () => {
  const provider = { id: 'fixture-provider', baseUrl: 'https://fixture.example/v1', apiKey: 'private-fixture-key', apiFormat: 'openai-responses' };
  const request = { systemPrompt: 'Stable instructions.', messages: [{ role: 'user', content: 'First task.' }] };
  const first = buildRequestBody(request, route, provider).prompt_cache_key;
  request.messages.push({ role: 'assistant', content: 'Result.' }, { role: 'user', content: 'Next task.' });
  assert.equal(buildRequestBody(request, { ...route, effort: 'max' }, provider).prompt_cache_key, first);
  assert.match(first, /^dfbyok-[a-f0-9]{40}$/);
  assert.notEqual(buildRequestBody(request, route, { ...provider, apiKey: 'other-key' }).prompt_cache_key, first);
  assert.notEqual(buildRequestBody(request, { ...route, model: 'gpt-6-astra' }, provider).prompt_cache_key, first);
});

test('malformed, foreign or oversized signatures fall back to visible native history', () => {
  const provider = { apiFormat: 'openai-responses' };
  for (const signature of ['anthropic-opaque-signature', 'dfbyok-responses-v1:invalid', 'dfbyok-responses-v1:' + 'a'.repeat(8 * 1024 * 1024)]) {
    const body = next({ content: 'Visible.', signature, toolCalls: [] }, provider);
    assert.deepEqual(body.input.at(-1), { role: 'assistant', content: 'Visible.' });
  }
});

test('reasoning IDs without encrypted content are not replayed as stateless state', async () => {
  const { native } = await record([{ id: 'r1', type: 'reasoning', summary: [] }, call('call-1')]);
  assert.equal(native.signature, '');
  assert.equal(native.toolCalls.length, 1);
});

test('truncated Responses output never supplies state or a partial tool call', async () => {
  const { native } = await record([reason('r1'), call('call-1')], { incomplete: true });
  assert.equal(native.stop, 3);
  assert.equal(native.signature, '');
  assert.deepEqual(native.toolCalls, []);
});

test('Chat Completions, Anthropic and third-party Responses models keep their request controls', () => {
  for (const apiFormat of ['openai', 'anthropic', 'openai-responses']) {
    for (const model of ['global:deepseek-v4.1-flash', 'claude-opus-4-6']) {
      const body = buildRequestBody({ systemPrompt: '', messages: [] }, { model, effort: 'xhigh' }, { apiFormat });
      assert.equal(Object.hasOwn(body, 'store'), false);
      assert.equal(Object.hasOwn(body, 'include'), false);
    }
  }
});
