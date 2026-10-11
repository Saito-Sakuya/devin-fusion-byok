'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const extension = path.resolve(process.env.BYOK_TEST_EXTENSION || path.join(__dirname, '..'));
const { serveChat } = require(path.join(extension, 'src/protocol/responses.cjs'));
const { startBackend } = require(path.join(extension, 'src/runtime/backend.cjs'));
const { buildCatalog } = require(path.join(extension, 'src/catalog.cjs'));
const { createManager } = require(path.join(extension, 'src/panel/model.cjs'));
const { readConfig, writeConfig } = require(path.join(extension, 'src/config.cjs'));
const { matchesProviderError } = require(path.join(extension, 'src/runtime/auto-continue.cjs'));
const wire = require(path.join(extension, 'src/protocol/wire.cjs'));
const secret = 'retry-fixture-secret-credential-and-private-prompt';
const event = data => 'data: ' + JSON.stringify(data) + '\n\n';
const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const success = res => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(event({ type: 'response.completed', response: { status: 'completed', output: [message('RETRY_OK')],
    usage: { input_tokens: 25, output_tokens: 3, input_tokens_details: { cached_tokens: 20 } } } }));
};
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
function decode(bytes) {
  const result = { text: '', thinking: '', signature: '', calls: [], stops: [], ids: new Set(), trailers: 0 };
  for (let offset = 0; offset < bytes.length;) {
    const flags = bytes[offset], size = bytes.readUInt32BE(offset + 1);
    assert.ok(offset + size + 5 <= bytes.length);
    const data = bytes.subarray(offset + 5, offset + 5 + size);
    if (flags & 2) result.trailers++;
    else {
      result.ids.add(wire.str(data, 1));
      result.text += wire.str(data, 3); result.thinking += wire.str(data, 9); result.signature += wire.str(data, 10);
      if (wire.num(data, 5)) result.stops.push(wire.num(data, 5));
      result.calls.push(...wire.fields(data, 6).map(({ value }) => wire.str(value, 1)));
    }
    offset += size + 5;
  }
  return result;
}
async function probe(handler, options = {}) {
  const received = [], logs = [], records = [], times = [];
  const abort = new AbortController();
  let bridge, completion, cancellationAt;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks).toString()); times.push(performance.now());
    handler(res, received.length);
  });
  try {
    const origin = await listen(upstream);
    bridge = http.createServer((req, res) => {
      completion = serveChat({ request: { systemPrompt: secret, messages: [{ role: 'user', content: secret }] },
        provider: { id: 'fixture', apiKey: secret, baseUrl: origin, apiFormat: options.apiFormat || 'openai-responses' },
        route: { model: 'gpt-6.1-sol', effort: 'low' }, res, signal: abort.signal, timeouts: options.timeouts,
        retry: { enabled: true, baseDelayMs: 2, maxDelayMs: 8, budgetMs: 3000, ...options.retry },
        log: value => {
          logs.push(value);
          if (options.cancelOnRetry && value.event === 'chat-retry') {
            cancellationAt = performance.now();
            if (options.cancelOnRetry === 'disconnect') res.destroy();
            else abort.abort();
          }
        }, onMetrics: value => records.push(value) });
      completion.catch(error => res.destroy(error));
    });
    let bytes = Buffer.alloc(0);
    try {
      const response = await fetch(await listen(bridge), { signal: AbortSignal.timeout(5000) });
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) { if (!options.cancelOnRetry) throw error; }
    const result = await completion, native = decode(bytes);
    assert.equal(records.length, 1);
    assert.equal(JSON.stringify({ logs, records, native }).includes(secret), false);
    return { result, native, logs, records, received, times, cancellationMs: performance.now() - cancellationAt };
  } finally {
    abort.abort();
    if (bridge) await close(bridge);
    await close(upstream);
  }
}

test('503 then 502 then success resends identical request bytes with one native completion', async () => {
  const r = await probe((res, attempt) => attempt < 3 ? res.writeHead(attempt === 1 ? 503 : 502).end() : success(res));
  assert.equal(r.received.length, 3);
  assert.equal(new Set(r.received).size, 1);
  assert.equal(JSON.parse(r.received[0]).store, false);
  assert.match(JSON.parse(r.received[0]).prompt_cache_key, /^dfbyok-/);
  assert.equal(r.native.text, 'RETRY_OK');
  assert.deepEqual(r.native.stops, [2]);
  assert.equal(r.native.trailers, 1); assert.equal(r.native.ids.size, 1);
  assert.equal(r.logs.filter(l => l.event === 'chat-retry').length, 2);
  assert.equal(r.logs.at(-1).attempts, 3); assert.equal(r.logs.at(-1).retries, 2);
  assert.equal(r.records[0].status, 'success');
  assert.ok(r.records[0].durationMs >= r.times[2] - r.times[0]);
});

test('a dropped socket before headers is retried and succeeds', async () => {
  const r = await probe((res, attempt) => attempt === 1 ? res.destroy() : success(res));
  assert.equal(r.native.text, 'RETRY_OK'); assert.equal(r.received.length, 2);
  assert.equal(r.logs[0].failureKind, 'transport_error');
  assert.ok(['UND_ERR_SOCKET', 'ECONNRESET'].includes(r.logs[0].transportErrorCode));
});

for (const status of [408, 429, 500, 502, 503, 504]) {
  test('temporary HTTP ' + status + ' is retried', async () => {
    const r = await probe((res, attempt) => attempt === 1 ? res.writeHead(status).end() : success(res));
    assert.equal(r.native.text, 'RETRY_OK'); assert.equal(r.received.length, 2);
  });
}

test('persistent temporary errors stop after four attempts and cannot trigger ACP continue', async () => {
  const r = await probe(res => res.writeHead(503).end(), { retry: { maxRetries: 500 } });
  assert.equal(r.received.length, 4); assert.deepEqual(r.native.stops, [13]); assert.equal(r.native.trailers, 1);
  assert.match(r.native.text, /retry limit reached; 4 attempts/);
  assert.equal(matchesProviderError(r.native.text), false);
  assert.equal(r.logs.filter(l => l.event === 'chat-error').length, 1);
  assert.equal(r.logs.at(-1).retryStopped, 'retry_limit');
});

test('disabled retries leave the existing single-attempt error behavior', async () => {
  const r = await probe(res => res.writeHead(503).end(), { retry: { enabled: false } });
  assert.equal(r.received.length, 1); assert.equal(r.native.text, 'Provider returned HTTP 503.');
  assert.equal(r.logs.some(l => l.event === 'chat-retry'), false);
});

test('authentication, permission and invalid request HTTP failures are not retried', async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const r = await probe(res => res.writeHead(status).end());
    assert.equal(r.received.length, 1); assert.equal(r.logs.at(-1).retryStopped, 'not_retryable');
  }
});

test('retry-after-ms takes precedence and is honored before the next POST', async () => {
  const r = await probe((res, attempt) => attempt === 1 ? res.writeHead(429, { 'retry-after-ms': '45', 'retry-after': '10' }).end() : success(res));
  assert.equal(r.received.length, 2); assert.equal(r.logs[0].delayMs, 45);
  assert.ok(r.times[1] - r.times[0] >= 40);
});

test('Retry-After fractional seconds and HTTP dates are honored', async () => {
  const seconds = await probe((res, attempt) => attempt === 1 ? res.writeHead(429, { 'retry-after': '0.045' }).end() : success(res));
  assert.equal(seconds.logs[0].delayMs, 45); assert.ok(seconds.times[1] - seconds.times[0] >= 40);
  const date = await probe((res, attempt) => attempt === 1 ? res.writeHead(503, { 'retry-after': new Date(Date.now() + 2200).toUTCString() }).end() : success(res));
  assert.equal(date.received.length, 2); assert.ok(date.logs[0].delayMs >= 1000);
  assert.ok(date.times[1] - date.times[0] >= date.logs[0].delayMs - 5);
});

test('server delays beyond the retry budget, including huge numbers, stop without retrying early', async () => {
  for (const delay of ['120', '9'.repeat(100), '9'.repeat(200)]) {
    const r = await probe(res => res.writeHead(429, { 'retry-after': delay }).end());
    assert.equal(r.received.length, 1); assert.equal(r.logs.at(-1).retryStopped, 'retry_budget');
  }
});

test('HTTP quota and parameter error bodies override a superficially temporary status', async () => {
  for (const [status, code] of [[429, 'insufficient_quota'], [500, 'invalid_parameter']]) {
    const r = await probe(res => res.writeHead(status, { 'content-type': 'application/json' }).end(
      JSON.stringify({ error: { code, message: secret } })));
    assert.equal(r.received.length, 1); assert.equal(r.logs.at(-1).retryStopped, 'not_retryable');
    assert.equal(r.logs.at(-1).providerErrorCode, code);
  }
});

test('a broken stream before visible output retries instead of emitting an intermediate error', async () => {
  const r = await probe((res, attempt) => {
    if (attempt !== 1) return success(res);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ type: 'response.created', response: { status: 'in_progress' } }));
    setTimeout(() => res.destroy(), 20);
  });
  assert.equal(r.received.length, 2); assert.equal(r.native.text, 'RETRY_OK');
  assert.equal(r.logs[0].failureStage, 'stream_read'); assert.deepEqual(r.native.stops, [2]);
});

test('a provider no-retry header prevents repeating a temporary failure', async () => {
  const r = await probe(res => res.writeHead(503, { 'x-should-retry': 'false' }).end());
  assert.equal(r.received.length, 1); assert.equal(r.logs.at(-1).retryStopped, 'provider_no_retry');
});

test('the total retry scheduling budget includes the failed request time', async () => {
  const r = await probe(res => setTimeout(() => res.writeHead(503).end(), 45), { retry: { budgetMs: 20 } });
  assert.equal(r.received.length, 1); assert.equal(r.logs.at(-1).retryStopped, 'retry_budget');
});

for (const cancelOnRetry of [true, 'disconnect']) {
  test('cancelling during backoff via ' + cancelOnRetry + ' stops immediately without another POST', async () => {
    const r = await probe(res => res.writeHead(503).end(), { cancelOnRetry, retry: { baseDelayMs: 2000 } });
    assert.equal(r.result.aborted, true); assert.equal(r.received.length, 1);
    assert.equal(r.logs.at(-1).event, 'chat-aborted'); assert.equal(r.logs.some(l => l.event === 'chat-error'), false);
    assert.equal(r.records[0].status, 'cancelled'); assert.ok(r.cancellationMs < 250);
  });
}

test('temporary SSE errors and incomplete EOF before output retry with fresh attempt state', async () => {
  for (const error of ['server_error', 'stream_read_error', 'upstream_http2_stream_error', 'eof']) {
    const r = await probe((res, attempt) => {
      if (attempt !== 1) return success(res);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(event({ type: 'response.created', response: { status: 'in_progress' } }) +
        (error === 'eof' ? '' : event({ type: 'error', error: { code: error, message: secret } })));
    });
    assert.equal(r.native.text, 'RETRY_OK'); assert.equal(r.received.length, 2);
  }
});

test('quota, auth, encrypted-state, parameter and unrecognized SSE failures do not retry', async () => {
  for (const code of ['insufficient_quota', 'authentication_error', 'invalid_encrypted_content', 'invalid_parameter', 'upstream_error', secret]) {
    const r = await probe(res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(event({ type: 'response.failed', response: { error: { code, message: secret } } }));
    });
    assert.equal(r.received.length, 1); assert.equal(r.logs.at(-1).retryStopped, 'not_retryable');
  }
});

test('malformed JSON, content type and completed invalid tool payloads do not retry', async () => {
  for (const data of [null, 'data: {invalid\n\n', event({ type: 'response.completed', response: { status: 'completed', output: [
    { type: 'function_call', call_id: 'bad', name: 'skill', arguments: 'not-json' } ] } })]) {
    const r = await probe(res => {
      res.writeHead(200, { 'content-type': data === null ? 'application/json' : 'text/event-stream' });
      res.end(data ?? '{}');
    });
    assert.equal(r.received.length, 1); assert.equal(r.logs.at(-1).retryStopped, 'not_retryable');
  }
});

for (const type of ['response.output_text.delta', 'response.reasoning_summary_text.delta']) {
  test(type + ' already sent to the client prevents repeating the request', async () => {
    const r = await probe(res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event({ type, output_index: 0, delta: 'Partial output.' }));
      setTimeout(() => res.destroy(), 20);
    });
    assert.equal(r.received.length, 1); assert.equal(r.logs.at(-1).retryStopped, 'output_started');
    assert.equal(type.includes('reasoning') ? r.native.thinking : r.native.text.slice(0, 15), 'Partial output.');
    assert.deepEqual(r.native.calls, []); assert.equal(r.native.signature, ''); assert.deepEqual(r.native.stops, [13]);
  });
}

test('tools and usage from a failed uncommitted attempt do not leak into the successful retry', async () => {
  const r = await probe((res, attempt) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempt === 1) {
      res.end(event({ type: 'response.output_item.added', output_index: 0,
        item: { type: 'function_call', id: 'failed-item', call_id: 'failed-call', name: 'skill', arguments: '{' } }) +
        event({ type: 'response.failed', response: { usage: { input_tokens: 900, output_tokens: 800 }, error: { code: 'server_error' } } }));
    } else {
      res.end(event({ type: 'response.completed', response: { status: 'completed', output: [
        { type: 'reasoning', encrypted_content: 'retry-fixture-encrypted', summary: [] },
        { type: 'function_call', id: 'good-item', call_id: 'good-call', name: 'skill', arguments: '{"source":"fixture"}' }
      ], usage: { input_tokens: 25, output_tokens: 3 } } }));
    }
  });
  assert.equal(r.received.length, 2); assert.deepEqual(r.native.calls, ['good-call']);
  assert.deepEqual(r.native.stops, [10]); assert.ok(r.native.signature.startsWith('dfbyok-responses-v1:'));
  assert.equal(Buffer.from(r.native.signature.split(':')[1], 'base64url').toString().includes('failed-call'), false);
  assert.deepEqual(r.records[0].toolIds, ['good-call']); assert.equal(r.records[0].inputTokens, 25);
  assert.equal(r.records[0].outputTokens, 3);
});

test('header and idle timeouts retry before any output is committed', async () => {
  for (const stage of ['headers', 'idle']) {
    const r = await probe((res, attempt) => {
      if (attempt !== 1) return success(res);
      if (stage === 'idle') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(event({ type: 'response.created', response: { status: 'in_progress' } }));
      }
    }, { timeouts: { firstResponseMs: 40, idleMs: 40 } });
    assert.equal(r.native.text, 'RETRY_OK'); assert.equal(r.received.length, 2);
    assert.equal(r.logs[0].code, 'upstream_timeout');
  }
});

for (const apiFormat of ['openai', 'anthropic']) {
  test(apiFormat + ' retries through the same transport while retaining protocol output', async () => {
    const r = await probe((res, attempt) => {
      if (attempt === 1) return res.writeHead(503).end();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(apiFormat === 'openai' ? event({ choices: [{ index: 0, delta: { content: 'RETRY_OK' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' :
        [{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'RETRY_OK' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' }].map(event).join(''));
    }, { apiFormat });
    assert.equal(r.received.length, 2); assert.equal(new Set(r.received).size, 1);
    assert.equal(r.native.text, 'RETRY_OK'); assert.deepEqual(r.native.stops, [2]);
  });
}

test('the settings command controls backend retries on the next request and disables legacy continue', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-retry-test-')), file = path.join(root, 'config.json');
  const logs = []; let backend, count = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) {}
    count++; if (count % 2) res.writeHead(503).end(); else success(res);
  });
  try {
    writeConfig(file, { enabled: true, providers: [{ id: 'fixture', name: 'Fixture', apiKey: secret,
      baseUrl: await listen(upstream), apiFormat: 'openai-responses', models: [{ id: 'gpt-6.1-sol', label: 'Fixture', efforts: ['low'] }] }],
      fusionPresets: [], sidekicks: [], roleExclusions: { lead: [], sidekick: [] }, autoContinueOnProviderError: true });
    const manager = createManager({ read: () => readConfig(file), write: value => writeConfig(file, value) });
    const state = await manager.dispatch('setAutoContinue', { enabled: true });
    assert.equal(state.autoContinueOnProviderError, true);
    assert.equal(readConfig(file).autoRetryProviderRequests, true); assert.equal(readConfig(file).autoContinueOnProviderError, false);
    backend = await startBackend({ root, port: 0, log: (event, data) => logs.push({ event, ...data }) });
    const uid = Object.entries(buildCatalog(readConfig(file)).routes).find(([, route]) => route.effort === 'low')[0];
    const invoke = async () => {
      const res = await fetch('http://127.0.0.1:' + backend.port + '/exa.api_server_pb.ApiServerService/GetChatMessage', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatModelUid: uid, chatMessagePrompts: [{ source: 1, prompt: 'Synthetic retry test.' }] }) });
      return decode(Buffer.from(await res.arrayBuffer()));
    };
    assert.equal((await invoke()).text, 'RETRY_OK'); assert.equal(count, 2);
    const delay = logs.find(l => l.event === 'chat-retry').delayMs; assert.ok(delay >= 2000 && delay <= 2400);
    const disabled = await manager.dispatch('setAutoContinue', { enabled: false });
    assert.equal(disabled.autoContinueOnProviderError, false);
    assert.equal((await invoke()).text, 'Provider returned HTTP 503.'); assert.equal(count, 3);
    assert.equal(logs.filter(l => l.event === 'chat-retry').length, 1);
    assert.equal(JSON.stringify(logs).includes(secret), false);
  } finally {
    if (backend) await backend.close();
    await close(upstream);
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('byok-retry-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
