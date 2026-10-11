'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const extension = path.resolve(process.env.BYOK_TEST_EXTENSION || path.join(__dirname, '..'));
const { serveChat } = require(path.join(extension, 'src/protocol/responses.cjs'));
const wire = require(path.join(extension, 'src/protocol/wire.cjs'));
const secret = 'fixture-credential-and-private-prompt';
const event = data => 'data: ' + JSON.stringify(data) + '\n\n';
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
function decode(bytes) {
  let text = '', signature = '', stop = 0, calls = 0;
  for (let offset = 0; offset < bytes.length;) {
    const flags = bytes[offset], size = bytes.readUInt32BE(offset + 1);
    const data = bytes.subarray(offset + 5, offset + 5 + size);
    if (!(flags & 2)) {
      text += wire.str(data, 3);
      signature += wire.str(data, 10);
      stop ||= wire.num(data, 5);
      calls += wire.fields(data, 6).length;
    }
    offset += size + 5;
  }
  return { text, signature, stop, calls };
}
async function probe(handler, { timeouts, cancel = false, baseUrl } = {}) {
  const logs = [];
  let metrics, completion, bridge;
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* Drain the fixture request. */ }
    handler(res);
  });
  const abort = new AbortController();
  try {
    const upstreamUrl = await listen(upstream);
    const provider = { id: 'fixture', apiKey: secret, baseUrl: baseUrl || upstreamUrl, apiFormat: 'openai-responses' };
    bridge = http.createServer((req, res) => {
      completion = serveChat({ request: { systemPrompt: secret, messages: [{ role: 'user', content: secret }] },
        route: { model: 'gpt-6.1-sol', effort: 'low' }, provider, res, timeouts,
        signal: abort.signal, log: value => {
          logs.push(value);
          if (cancel && value.event === 'chat-aborted') res.end();
        }, onMetrics: value => { metrics = value; } });
      if (cancel) setTimeout(() => abort.abort(), 35);
    });
    const response = await fetch(await listen(bridge));
    const native = decode(Buffer.from(await response.arrayBuffer()));
    const result = await completion;
    assert.equal(JSON.stringify({ logs, metrics, native }).includes(secret), false);
    return { result, native, logs, metrics };
  } finally {
    if (bridge) await close(bridge);
    await close(upstream);
  }
}
function sse(res) { res.writeHead(200, { 'content-type': 'text/event-stream' }); }
test('HTTP 200 response.failed reports the provider code and withholds partial tools/state', async () => {
  const { native, logs, metrics } = await probe(res => {
    res.setHeader('x-request-id', '12345678-1234-1234-1234-123456789abc');
    sse(res);
    res.end(event({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'fixture', arguments: '' } }) +
      event({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: secret } } }));
  });
  assert.equal(native.stop, 13);
  assert.equal(native.signature, '');
  assert.equal(native.calls, 0);
  assert.equal(native.text, 'Provider reported a failed response (server_error).');
  const error = logs.find(r => r.event === 'chat-error');
  assert.equal(error.status, 200);
  assert.equal(error.failureKind, 'provider_error');
  assert.equal(error.providerErrorCode, 'server_error');
  assert.equal(error.upstreamEvent, 'response.failed');
  assert.equal(error.failureStage, 'stream_event');
  assert.equal(error.upstreamRequestId, '12345678-1234-1234-1234-123456789abc');
  assert.equal(metrics.status, 'error');
});
test('explicit error event uses the provider error type without logging its message', async () => {
  const { native, logs } = await probe(res => { sse(res); res.end(event({ type: 'error', error: { type: 'rate_limit_error', message: secret } })); });
  assert.equal(native.text, 'Provider reported a failed response (rate_limit_error).');
  assert.equal(logs.at(-1).providerErrorCode, 'rate_limit_error');
});
test('arbitrary provider codes and raw payloads are redacted from user text and logs', async () => {
  const { native, logs } = await probe(res => { res.setHeader('x-request-id', secret); sse(res); res.end(event({ type: 'error', code: secret, message: secret })); });
  assert.equal(native.text, 'Provider reported a failed response.');
  assert.equal(logs.at(-1).providerErrorCode, 'unrecognized_code');
  assert.equal(logs.at(-1).upstreamRequestId, undefined);
});
test('documented gateway stream errors retain their machine codes', async () => {
  for (const code of ['upstream_error', 'stream_read_error', 'upstream_stream_read_error', 'upstream_http2_stream_error', 'upstream_stream_truncated']) {
    const { native, logs } = await probe(res => { sse(res); res.end(event({ type: 'error', error: { code, type: 'upstream_error', message: secret } })); });
    assert.equal(native.text, 'Provider reported a failed response (' + code + ').');
    assert.equal(logs.at(-1).providerErrorCode, code);
  }
});
test('outer SSE event type is not mistaken for a provider error code', async () => {
  const { native, logs } = await probe(res => { sse(res); res.end(event({ type: 'error', code: null, message: secret })); });
  assert.equal(native.text, 'Provider reported a failed response.');
  assert.equal(logs.at(-1).providerErrorCode, null);
});
test('pre-response DNS failure exposes its safe machine code', async () => {
  const { native, logs } = await probe(() => {}, { baseUrl: 'http://byok-provider-fixture.invalid' });
  assert.equal(native.text, 'Could not resolve the provider hostname (ENOTFOUND).');
  assert.equal(logs.at(-1).failureStage, 'response_headers');
  assert.equal(logs.at(-1).receivedBytes, 0);
  assert.equal(logs.at(-1).transportErrorCode, 'ENOTFOUND');
});
test('broken response body is distinguished from a provider failure event', async () => {
  const { native, logs } = await probe(res => {
    sse(res); res.write(event({ type: 'response.created', response: { status: 'in_progress' } }));
    setTimeout(() => res.destroy(), 30);
  });
  assert.equal(native.text, 'Connection to the provider was interrupted during the response.');
  const error = logs.at(-1);
  assert.equal(error.failureKind, 'transport_error');
  assert.equal(error.failureStage, 'stream_read');
  assert.equal(error.lastUpstreamEvent, 'response.created');
  assert.ok(['UND_ERR_SOCKET', 'ECONNRESET'].includes(error.transportErrorCode));
  assert.ok(error.receivedBytes > 0);
});
test('EOF without terminal output reports an incomplete stream', async () => {
  const { native, logs } = await probe(res => { sse(res); res.end(event({ type: 'response.created', response: { status: 'in_progress' } })); });
  assert.equal(native.text, 'Provider stream ended before the response was completed.');
  assert.equal(logs.at(-1).failureKind, 'incomplete_stream');
});
test('headers timeout and idle body timeout have separate messages and stages', async () => {
  const header = await probe(() => {}, { timeouts: { firstResponseMs: 35, idleMs: 200 } });
  assert.equal(header.native.text, 'Provider did not respond before the timeout.');
  assert.equal(header.logs.at(-1).failureStage, 'response_headers');
  const body = await probe(res => { sse(res); res.write(event({ type: 'response.created', response: { status: 'in_progress' } })); }, { timeouts: { firstResponseMs: 200, idleMs: 35 } });
  assert.equal(body.native.text, 'Provider response timed out while waiting for more data.');
  assert.equal(body.logs.at(-1).failureKind, 'timeout');
  assert.equal(body.logs.at(-1).failureStage, 'stream_read');
});
test('invalid JSON and inconsistent completion are classified as protocol errors', async () => {
  const malformed = await probe(res => { sse(res); res.end('data: {invalid\n\n'); });
  assert.equal(malformed.native.text, 'Provider response format is invalid.');
  assert.equal(malformed.logs.at(-1).code, 'upstream_invalid_json');
  const inconsistent = await probe(res => { sse(res); res.end(event({ type: 'response.completed', response: { status: 'failed' } })); });
  assert.equal(inconsistent.logs.at(-1).failureKind, 'protocol_error');
  assert.equal(inconsistent.logs.at(-1).upstreamEvent, 'response.completed');
});
test('client cancellation stays separate from upstream failures', async () => {
  const { logs, result, metrics } = await probe(res => { sse(res); res.write(event({ type: 'response.created', response: { status: 'in_progress' } })); }, { cancel: true });
  assert.equal(result.aborted, true);
  assert.equal(metrics.code, 'client_cancelled');
  assert.equal(logs.some(r => r.event === 'chat-error'), false);
});
test('successful output keeps its original stop reason and has no failure diagnostics', async () => {
  const { native, logs } = await probe(res => { sse(res); res.end(event({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture OK.' }] }] } })); });
  assert.equal(native.stop, 2);
  assert.equal(native.text, 'Fixture OK.');
  assert.equal(logs.at(-1).event, 'chat-complete');
  assert.equal(logs.at(-1).failureKind, undefined);
});
