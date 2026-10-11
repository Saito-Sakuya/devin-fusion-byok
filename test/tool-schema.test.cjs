'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const extension = path.resolve(process.env.BYOK_TEST_EXTENSION || path.join(__dirname, '..'));
const wire = require(path.join(extension, 'src/protocol/wire.cjs'));
const { parseChat } = require(path.join(extension, 'src/protocol/chat.cjs'));
const { buildRequestBody, serveChat } = require(path.join(extension, 'src/protocol/responses.cjs'));

// A tool with alternative optional inputs must retain the native schema.
const parameters = {
  type: 'object',
  properties: { path: { type: 'string' }, source: { type: 'string' } },
  additionalProperties: false,
};

function nativeRequest(encoding, strict) {
  if (encoding === 'json') return {
    chatModelUid: 'test-route',
    chatMessagePrompts: [{ source: 1, prompt: 'Load the skill by source.' }],
    tools: [{ name: 'skill', description: 'Provide exactly one of path or source.',
      jsonSchemaString: JSON.stringify(parameters), ...(strict === undefined ? {} : { strict }) }],
  };
  return Buffer.concat([
    wire.s(21, 'test-route'),
    wire.m(3, Buffer.concat([wire.v(2, 1), wire.s(3, 'Load the skill by source.')])),
    wire.m(10, Buffer.concat([
      wire.s(1, 'skill'), wire.s(2, 'Provide exactly one of path or source.'), wire.s(3, JSON.stringify(parameters)),
      ...(strict === undefined ? [] : [wire.v(12, strict ? 1 : 0)]),
    ])),
  ]);
}

for (const encoding of ['json', 'proto']) {
  for (const strict of [undefined, false, true]) {
    test(`${encoding} native strict=${strict} preserves tool optionality and explicit mode`, () => {
      const request = parseChat(nativeRequest(encoding, strict));
      for (const apiFormat of ['openai-responses', 'openai']) {
        const body = buildRequestBody(request, { model: 'test-model' }, { apiFormat });
        const tool = apiFormat === 'openai' ? body.tools[0].function : body.tools[0];
        assert.equal(tool.strict, strict === true);
        assert.deepEqual(tool.parameters, parameters);
        assert.equal(Object.hasOwn(tool.parameters, 'required'), false);
        assert.equal(tool.name, 'skill');
      }
    });
  }
}

test('Anthropic receives the native input schema without an OpenAI strict field', () => {
  const request = parseChat(nativeRequest('proto', true));
  const body = buildRequestBody(request, { model: 'test-model' }, { apiFormat: 'anthropic' });
  assert.deepEqual(body.tools[0].input_schema, parameters);
  assert.equal(Object.hasOwn(body.tools[0], 'strict'), false);
});

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

for (const apiFormat of ['openai-responses', 'openai']) {
  test(`${apiFormat} sends strict=false and forwards a source-only streamed call unchanged`, { timeout: 10000 }, async () => {
    const args = '{ "source": "fixture://skill" }';
    let received;
    const upstream = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = { path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = apiFormat === 'openai' ? [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-fixture', function: { name: 'skill', arguments: args.slice(0, 12) } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(12) } }] }, finish_reason: 'tool_calls' }] },
      ] : [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item-fixture', call_id: 'call-fixture', name: 'skill', arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item-fixture', delta: args.slice(0, 12) },
        { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item-fixture', delta: args.slice(12) },
        { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'item-fixture', arguments: args },
        { type: 'response.completed', response: { status: 'completed' } },
      ];
      res.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n');
    });
    let bridge;
    let completion;
    try {
      const provider = { baseUrl: await listen(upstream), apiFormat };
      bridge = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const request = parseChat(wire.decode(Buffer.concat(chunks), req.headers).data);
        completion = serveChat({ request, route: { model: 'test-model', uid: 'test-route' }, provider, res });
        completion.catch(error => res.destroy(error));
      });
      const response = await fetch(await listen(bridge), { method: 'POST', headers: { 'content-type': 'application/proto' }, body: nativeRequest('proto') });
      const data = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200);
      assert.deepEqual((await completion).toolNames, ['skill']);
      assert.equal(received.path, apiFormat === 'openai' ? '/chat/completions' : '/responses');
      const tool = apiFormat === 'openai' ? received.body.tools[0].function : received.body.tools[0];
      assert.equal(tool.strict, false);
      assert.deepEqual(tool.parameters, parameters);
      const calls = [];
      for (let offset = 0; offset < data.length;) {
        const flags = data[offset], length = data.readUInt32BE(offset + 1);
        const frame = data.subarray(offset + 5, offset + 5 + length);
        if (!(flags & 2)) calls.push(...wire.fields(frame, 6).map(({ value }) => ({ id: wire.str(value, 1), name: wire.str(value, 2), arguments: wire.str(value, 3) })));
        offset += 5 + length;
      }
      assert.deepEqual(calls, [{ id: 'call-fixture', name: 'skill', arguments: args }]);
      assert.equal(Object.hasOwn(JSON.parse(calls[0].arguments), 'path'), false);
    } finally {
      if (bridge) await close(bridge);
      await close(upstream);
    }
  });
}
