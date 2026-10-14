'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { frame } = require('./wire.cjs');
const { textChunk, thinkingChunk, signatureChunk, toolChunk, stopChunk, usageChunk } = require('./chat.cjs');
const { createTracker } = require('../runtime/monitor.cjs');
const { modelEfforts, modelServiceTier } = require('../model-capabilities.cjs');
const { isAnthropicFormat, anthropicHeaders, buildAnthropicBody, createAnthropicAdapter } = require('./anthropic.cjs');
const MAX_SSE_BUFFER = 64 * 1024 * 1024;
const STATE_PREFIX = 'dfbyok-responses-v1:';
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const PROVIDER_ERROR_CODES = new Set([
  'server_error', 'internal_error', 'api_error', 'overloaded_error', 'rate_limit_error',
  'rate_limit_exceeded', 'insufficient_quota', 'invalid_request_error',
  'authentication_error', 'permission_error', 'invalid_api_key', 'model_not_found',
  'context_length_exceeded', 'invalid_encrypted_content', 'invalid_reasoning_signature',
  'response_failed', 'request_timeout', 'timeout', 'content_filter', 'content_policy_violation',
  // OpenAI-compatible gateway transport codes (Sub2API).
  'upstream_error', 'stream_read_error', 'upstream_stream_read_error',
  'upstream_http2_stream_error', 'upstream_stream_truncated', 'invalid_parameter',
]);
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED', 'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
]);
const RETRY_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
const RETRY_PROVIDER_CODES = new Set([
  'server_error', 'internal_error', 'api_error', 'overloaded_error',
  'rate_limit_error', 'rate_limit_exceeded', 'request_timeout', 'timeout',
  // Gateways may report upstream failures inside HTTP 200 SSE. Retry only
  // before output, within the same bounded policy; this code is not a diagnosis.
  'upstream_error',
  'stream_read_error', 'upstream_stream_read_error', 'upstream_http2_stream_error', 'upstream_stream_truncated',
]);
const PERMANENT_PROVIDER_CODES = new Set([
  'insufficient_quota', 'invalid_request_error', 'authentication_error', 'permission_error',
  'invalid_api_key', 'model_not_found', 'context_length_exceeded', 'invalid_encrypted_content',
  'invalid_reasoning_signature', 'content_filter', 'content_policy_violation', 'invalid_parameter',
]);

function retryAfter(headers) {
  for (const [name, multiplier] of [['retry-after-ms', 1], ['retry-after', 1000]]) {
    const value = headers.get(name)?.trim();
    if (!value) continue;
    if (value.length > 128) { if (/^\d/.test(value)) return 2147483647; continue; }
    if (/^\d+(?:\.\d+)?$/.test(value)) {
      // Saturate large numeric values instead of treating overflow as permission to retry early.
      return Math.min(2147483647, Math.ceil(Number(value) * multiplier));
    }
    if (name === 'retry-after' && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), /i.test(value)) {
      const date = Date.parse(value);
      if (Number.isFinite(date)) return Math.min(2147483647, Math.max(0, date - Date.now()));
    }
  }
  return 0;
}

function retryPolicy(options = {}) {
  const bounded = (value, fallback, max) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
  return { enabled: options.enabled === true, maxRetries: bounded(options.maxRetries, 3, 3),
    baseDelayMs: bounded(options.baseDelayMs, 2000, 8000), maxDelayMs: bounded(options.maxDelayMs, 8000, 8000),
    budgetMs: bounded(options.budgetMs, 60000, 60000) };
}

function retryDecision(result, policy, attempt, committed, started) {
  if (!policy.enabled) return { reason: 'disabled' };
  if (committed) return { reason: 'output_started' };
  if (result.retryAllowed === false) return { reason: 'provider_no_retry' };
  const diagnostics = result.diagnostics;
  if (PERMANENT_PROVIDER_CODES.has(diagnostics.providerErrorCode) ||
      PERMANENT_PROVIDER_CODES.has(diagnostics.providerErrorType)) return { reason: 'not_retryable' };
  const transient = result.code === 'upstream_http' ? RETRY_HTTP_STATUSES.has(result.status) :
    diagnostics.failureKind === 'provider_error' ? RETRY_PROVIDER_CODES.has(diagnostics.providerErrorCode) :
    diagnostics.failureKind === 'transport_error' ? RETRY_TRANSPORT_CODES.has(diagnostics.transportErrorCode) :
    result.code === 'upstream_timeout' || result.code === 'upstream_stream_incomplete';
  if (!transient) return { reason: 'not_retryable' };
  if (attempt > policy.maxRetries) return { reason: 'retry_limit' };
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const delayMs = Math.max(result.retryAfterMs || 0, Math.ceil(backoff * (1 + Math.random() * 0.2)));
  if (performance.now() - started + delayMs >= policy.budgetMs) return { reason: 'retry_budget' };
  return { delayMs };
}

function waitForRetry(ms, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = value => { clearTimeout(timer); signal.removeEventListener('abort', cancelled); resolve(value); };
    const cancelled = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal.addEventListener('abort', cancelled, { once: true });
  });
}

function providerFailure(event) {
  const error = event.data?.response?.error || event.data?.error || event.data;
  const value = error?.code || (error?.type !== event.type ? error?.type : null);
  const err = new Error('Provider reported a failed response');
  err.code = 'upstream_stream_error';
  err.diagnostics = {
    failureKind: 'provider_error',
    upstreamEvent: ['response.failed', 'error'].includes(event.type) ? event.type : 'error_payload',
    // Never record upstream error messages: they may contain prompts or keys.
    providerErrorCode: PROVIDER_ERROR_CODES.has(value) ? value : value ? 'unrecognized_code' : null,
    ...(PERMANENT_PROVIDER_CODES.has(error?.type) ? { providerErrorType: error.type } : {}),
  };
  return err;
}
function transportCode(error) {
  for (let depth = 0, current = error; current && depth < 4; depth++, current = current.cause) {
    if (TRANSPORT_ERROR_CODES.has(current.code)) return current.code;
  }
  return null;
}

function stateScope(route, provider) {
  // Prevent opaque reasoning state from crossing providers, credentials or models.
  return createHash('sha256').update(JSON.stringify([
    provider.id || '', provider.baseUrl || '', provider.apiKey || '', route.model,
  ])).digest('hex');
}
function resumableModel(route) {
  const id = String(route.model || '').split('/').at(-1);
  return route.effort !== 'none' && /^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(id) &&
    modelEfforts({ id: route.model }).length > 1;
}
function stateProjection(items) {
  if (!Array.isArray(items) || !items.length || items.length > 512) return null;
  let content = '';
  const tools = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') return null;
    if (item.type === 'reasoning') {
      // IDs alone require server-side storage; only replay self-contained state.
      if (typeof item.encrypted_content !== 'string' || !item.encrypted_content ||
          !Array.isArray(item.summary)) return null;
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) return null;
      for (const part of item.content) {
        if (part?.type !== 'output_text' || typeof part.text !== 'string') return null;
        content += part.text;
      }
    } else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' ||
          !item.name || typeof item.arguments !== 'string') return null;
      tools.push({ id: item.call_id, name: item.name, arguments: item.arguments });
    } else return null;
  }
  return { content, tools };
}
function canonicalArguments(value) {
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  return JSON.stringify(sort(JSON.parse(value)));
}
function replayItems(message, scope) {
  if (message.images?.length || typeof message.signature !== 'string' || !message.signature.startsWith(STATE_PREFIX) ||
      Buffer.byteLength(message.signature) > MAX_STATE_BYTES) return null;
  try {
    const state = JSON.parse(Buffer.from(message.signature.slice(STATE_PREFIX.length), 'base64url').toString('utf8'));
    if (state.scope !== scope) return null;
    const projection = stateProjection(state.items);
    const calls = message.toolCalls || [];
    // Edited, compacted or rerouted history must not restore obsolete output.
    if (!projection || projection.content !== message.content || projection.tools.length !== calls.length ||
        projection.tools.some((tool, index) => tool.id !== calls[index].id || tool.name !== calls[index].name ||
          canonicalArguments(tool.arguments) !== canonicalArguments(calls[index].arguments))) return null;
    return state.items;
  } catch { return null; }
}
function responseSignature(items, scope) {
  if (!scope || !stateProjection(items)) return '';
  const signature = STATE_PREFIX + Buffer.from(JSON.stringify({ scope, items })).toString('base64url');
  return Buffer.byteLength(signature) <= MAX_STATE_BYTES ? signature : '';
}

function isChatFormat(format = '') { return /chat[-_\/]?completions|^(?:chat|openai)$/.test(format); }
function endpoint(provider) {
  const url = new URL(provider.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid provider URL');
  const anthropic = isAnthropicFormat(provider.apiFormat);
  const chat = anthropic || isChatFormat(provider.apiFormat);
  url.pathname = url.pathname.replace(/\/(responses|chat\/completions|messages)\/?$/, '').replace(/\/$/, '') +
    (anthropic ? '/messages' : chat ? '/chat/completions' : '/responses');
  url.search = '';
  url.hash = '';
  return { url, chat, anthropic };
}

function contentOf(message, chat) {
  if (!message.images?.length) return message.content;
  const parts = [];
  if (message.content !== '') parts.push(chat ? { type: 'text', text: message.content } : { type: 'input_text', text: message.content });
  for (const image of message.images) {
    const url = `data:${image.mimeType};base64,${image.base64}`;
    parts.push(chat ? { type: 'image_url', image_url: { url } } : { type: 'input_image', image_url: url });
    if (image.caption) parts.push(chat ? { type: 'text', text: image.caption } : { type: 'input_text', text: image.caption });
  }
  return parts;
}

function buildRequestBody(request, route, provider) {
  if (isAnthropicFormat(provider.apiFormat)) return buildAnthropicBody(request, route, provider);
  const chat = isChatFormat(provider.apiFormat);
  const resume = !chat && resumableModel(route);
  const scope = resume ? stateScope(route, provider) : null;
  const messages = [];
  if (request.systemPrompt !== '') messages.push({ role: chat ? 'system' : 'developer', content: request.systemPrompt });
  for (const message of request.messages) {
    if (resume && message.role === 'assistant') {
      const items = replayItems(message, scope);
      if (items) { messages.push(...items); continue; }
    }
    if (message.role === 'tool') {
      messages.push(chat ? { role: 'tool', tool_call_id: message.toolCallId, content: message.content } : { type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      continue;
    }
    const content = contentOf(message, chat);
    if (chat) {
      const item = { role: message.role, content };
      if (message.toolCalls?.length) item.tool_calls = message.toolCalls.map(tool => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }));
      messages.push(item);
    } else {
      // A native message stores text before its repeated tool calls. Preserve
      // that sequence and keep every system message at its original position.
      if (content !== '' || !message.toolCalls?.length) messages.push({ role: message.role === 'system' ? 'developer' : message.role, content });
      for (const tool of message.toolCalls || []) messages.push({ type: 'function_call', call_id: tool.id, name: tool.name, arguments: tool.arguments });
    }
  }
  const body = { model: route.model, [chat ? 'messages' : 'input']: messages, stream: true };
  const serviceTier = modelServiceTier(route, provider);
  if (serviceTier) body.service_tier = serviceTier;
  if (resume) {
    body.store = false;
    body.include = ['reasoning.encrypted_content'];
    // Keep related requests together on gateways that still use the legacy
    // routing key; newer OpenAI models also accept it for cache accounting.
    body.prompt_cache_key = 'dfbyok-' + scope.slice(0, 40);
  }
  if (chat) body.stream_options = { include_usage: true };
  const maxTokens = request.maxTokens ?? route.maxOutputTokens ?? route.maxTokens ?? provider.maxOutputTokens ?? provider.maxTokens;
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) body[chat ? 'max_completion_tokens' : 'max_output_tokens'] = maxTokens;
  if (route.effort) {
    if (chat) body.reasoning_effort = route.effort;
    else body.reasoning = { effort: route.effort, ...(route.effort === 'none' ? {} : { summary: 'auto' }) };
  }
  if (request.tools?.length) {
    // Native ChatToolDefinition.strict defaults to false. Send it explicitly:
    // Responses may otherwise normalize optional parameters into required ones.
    body.tools = request.tools.map(tool => {
      const definition = { name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict === true };
      return chat ? { type: 'function', function: definition } : { type: 'function', ...definition };
    });
    const choice = request.toolChoice;
    if (choice?.name) body.tool_choice = chat ? { type: 'function', function: { name: choice.name } } : { type: 'function', name: choice.name };
    else if (choice) {
      const type = typeof choice === 'string' ? choice : choice.type;
      if (['auto', 'none', 'required', 'any'].includes(type)) body.tool_choice = type === 'any' ? 'required' : type;
    }
  }
  return body;
}

function parseEvent(raw) {
  let event = '';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  const joined = data.join('\n');
  if (joined.trim() === '[DONE]') return { type: 'done' };
  let value;
  try {
    value = JSON.parse(joined);
  } catch {
    const err = new Error('Invalid SSE event JSON');
    err.code = 'upstream_invalid_json';
    throw err;
  }
  return { type: value.type || event, data: value };
}

async function* events(body) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > MAX_SSE_BUFFER) {
      const err = new Error('SSE frame too large');
      err.code = 'upstream_content_type';
      throw err;
    }
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const event = parseEvent(raw);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const event = parseEvent(buffer); if (event) yield event; }
}

function usageSnapshot(data, chat) {
  const usage = chat ? data?.usage : data?.response?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = chat ? usage.prompt_tokens : usage.input_tokens;
  const output = chat ? usage.completion_tokens : usage.output_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) return null;
  return { inputTokens: input, outputTokens: output };
}

function processor(id, uid, chat, emit, scope = null) {
  const calls = new Map();
  const itemIndexes = new Map();
  const texts = new Map();
  const outputItems = new Map();
  let terminal = false;
  let reason = 2;
  let finished = false;
  let usage = null;
  let stateItems = 0, reasoningStateItems = 0;
  const getCall = (index, itemId) => {
    const key = index ?? itemIndexes.get(itemId) ?? itemId;
    if (key === undefined) {
      const err = new Error('Tool call has no index');
      err.code = 'upstream_invalid_tool';
      throw err;
    }
    if (itemId) itemIndexes.set(itemId, key);
    if (!calls.has(key)) calls.set(key, { id: '', name: '', arguments: '', complete: undefined });
    return calls.get(key);
  };
  const text = async (key, value, complete = false, thinking = false) => {
    if (typeof value !== 'string') return;
    const previous = texts.get(key) || '';
    if (complete && !value.startsWith(previous)) {
      const err = new Error('Inconsistent completed text');
      err.code = 'upstream_invalid_json';
      throw err;
    }
    const delta = complete ? value.slice(previous.length) : value;
    texts.set(key, complete ? value : previous + value);
    if (delta) await emit(thinking ? thinkingChunk(id, delta) : textChunk(id, delta));
  };
  const item = async (value, index, done) => {
    if (scope && done && Number.isSafeInteger(index) && index >= 0) outputItems.set(index, value);
    if (value.type === 'function_call') {
      const call = getCall(index, value.id);
      if (value.call_id || value.id) call.id = value.call_id || value.id;
      if (value.name) call.name = value.name;
      if (typeof value.arguments === 'string' && (done || value.arguments)) {
        if (done) call.complete = value.arguments;
        else call.arguments = value.arguments;
      }
    } else if (done && value.type === 'message') {
      for (const [contentIndex, part] of (value.content || []).entries()) {
        if (part.type === 'output_text') await text(`${index}:${contentIndex}`, part.text, true);
      }
    }
  };
  return {
    get terminal() { return terminal; },
    get stateItems() { return stateItems; },
    get reasoningStateItems() { return reasoningStateItems; },
    async event(event) {
      if (finished) return;
      const data = event.data;
      if (event.type === 'done') {
        if (!terminal && chat) terminal = true;
        return;
      }
      if (data?.error || event.type === 'response.failed' || event.type === 'error') throw providerFailure(event);
      if (!data) {
        const err = new Error('Upstream stream error');
        err.code = 'upstream_stream_error';
        err.diagnostics = { failureKind: 'protocol_error' };
        throw err;
      }
      const container = chat ? data : data.response;
      if (container && typeof container === 'object' && Object.hasOwn(container, 'usage')) usage = usageSnapshot(data, chat);
      if (chat) {
        for (const choice of data.choices || []) {
          if ((choice.index ?? 0) !== 0) continue;
          const delta = choice.delta || choice.message || {};
          if (delta.content) await text('chat', delta.content);
          if (delta.reasoning_content || delta.reasoning) await text('reasoning', delta.reasoning_content || delta.reasoning, false, true);
          for (const tool of delta.tool_calls || []) {
            const call = getCall(tool.index ?? 0);
            if (tool.id) call.id += tool.id;
            if (tool.function?.name) call.name += tool.function.name;
            if (typeof tool.function?.arguments === 'string') call.arguments += tool.function.arguments;
          }
          if (choice.finish_reason) {
            terminal = true;
            reason = choice.finish_reason === 'length' ? 3 : choice.finish_reason === 'content_filter' ? 11 : 2;
          }
        }
        return;
      }
      switch (event.type) {
        case 'response.output_item.added': await item(data.item, data.output_index, false); break;
        case 'response.output_item.done': await item(data.item, data.output_index, true); break;
        case 'response.function_call_arguments.delta': getCall(data.output_index, data.item_id).arguments += data.delta || ''; break;
        case 'response.function_call_arguments.done': getCall(data.output_index, data.item_id).complete = data.arguments; break;
        case 'response.output_text.delta': await text(`${data.output_index ?? 0}:${data.content_index ?? 0}`, data.delta); break;
        case 'response.output_text.done': await text(`${data.output_index ?? 0}:${data.content_index ?? 0}`, data.text, true); break;
        case 'response.reasoning.delta':
        case 'response.reasoning_summary_text.delta': await text(`reasoning:${data.output_index ?? 0}:${data.summary_index ?? 0}`, data.delta, false, true); break;
        case 'response.completed':
          if (data.response?.status && data.response.status !== 'completed') {
            const err = new Error('Unexpected completion status');
            err.code = 'upstream_stream_error';
            err.diagnostics = { failureKind: 'protocol_error', upstreamEvent: 'response.completed' };
            throw err;
          }
          for (const [index, value] of (data.response?.output || []).entries()) await item(value, index, true);
          terminal = true;
          break;
        case 'response.incomplete': terminal = true; reason = 3; break;
      }
    },
    async finish() {
      if (finished) return [];
      if (!terminal) {
        const err = new Error('Upstream stream ended without completion');
        err.code = 'upstream_stream_incomplete';
        throw err;
      }
      const tools = [];
      const orderedCalls = [...calls.entries()].sort(([left], [right]) => typeof left === 'number' && typeof right === 'number' ? left - right : 0);
      if (reason === 2) for (const [, call] of orderedCalls) {
        const args = call.complete ?? call.arguments;
        if (!call.name || !call.id || typeof args !== 'string') {
          const err = new Error('Incomplete tool call');
          err.code = 'upstream_invalid_tool';
          throw err;
        }
        try {
          JSON.parse(args); // Validate once, then forward the original JSON bytes.
        } catch {
          const err = new Error('Invalid tool call JSON');
          err.code = 'upstream_invalid_tool';
          throw err;
        }
        tools.push({ id: call.id, name: call.name, arguments: args });
      }
      if (!chat && reason === 2) {
        const items = [...outputItems].sort(([a], [b]) => a - b).map(([, value]) => value);
        const signature = responseSignature(items, scope);
        if (signature) {
          await emit(signatureChunk(id, signature));
          stateItems = items.length;
          reasoningStateItems = items.filter(item => item.type === 'reasoning').length;
        }
      }
      if (tools.length) await emit(toolChunk(id, tools));
      if (usage) await emit(usageChunk(id, uid, usage));
      await emit(stopChunk(id, tools.length ? 10 : reason, uid));
      finished = true;
      return tools.map(tool => tool.name);
    },
  };
}

// A failed attempt never commits its pending tools, reasoning state or error text.
// The outer request owns cancellation, retry limits and its one final metric.
async function serveChatAttempt({ id, request, route, provider, res, signal, log, timeouts, metrics, prepared, attempt, onOutput }) {
  const upstreamController = new AbortController();
  const abort = () => upstreamController.abort();
  const close = () => { if (!res.writableEnded) upstreamController.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  res.on('close', close);
  if (signal?.aborted) upstreamController.abort();
  const write = async chunk => {
    if (signal?.aborted || res.destroyed || res.writableEnded) throw new Error('Client closed');
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/connect+proto', 'cache-control': 'no-store' });
    const ready = res.write(frame(chunk));
    onOutput();
    if (!ready) await new Promise((resolve, reject) => {
      const clean = () => { res.off('drain', drained); res.off('close', closed); signal?.removeEventListener('abort', closed); };
      const drained = () => { clean(); resolve(); };
      const closed = () => { clean(); reject(new Error('Client closed')); };
      res.once('drain', drained); res.once('close', closed); signal?.addEventListener('abort', closed, { once: true });
    });
  };
  let status = 0;
  let classifiedCode = 'upstream_network';
  let failureStage = 'request_build';
  let lastUpstreamEvent = null;
  let receivedBytes = 0;
  let upstreamRequestId = null;
  let retryAfterMs = 0, retryAllowed = true, httpErrorCode = null, httpErrorType = null;
  const trackedEvent = type => /^(?:response\.(?:created|in_progress|completed|incomplete|failed|output_text\.(?:delta|done)|output_item\.(?:added|done)|function_call_arguments\.(?:delta|done)|reasoning_summary_text\.delta)|error|done)$/.test(type)
    ? type : 'other';
  const record = event => { try { log(event); } catch { /* Diagnostics cannot fail a model request. */ } };

  const firstResponseLimit = Number.isSafeInteger(timeouts?.firstResponseMs) && timeouts.firstResponseMs > 0
    ? Math.min(timeouts.firstResponseMs, 2147483647) : 120000;
  const idleLimit = Number.isSafeInteger(timeouts?.idleMs) && timeouts.idleMs > 0
    ? Math.min(timeouts.idleMs, 2147483647) : 120000;

  let activeTimer = null;
  const clearTimer = () => { if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; } };
  const armTimer = (ms, code) => {
    clearTimer();
    activeTimer = setTimeout(() => {
      classifiedCode = code;
      upstreamController.abort();
    }, ms);
  };

  try {
    if (!prepared.url) {
      const target = endpoint(provider);
      const body = buildRequestBody(request, route, provider);
      Object.assign(prepared, target, { body, serialized: JSON.stringify(body) });
    }
    const { url, chat, anthropic, body } = prepared;

    failureStage = 'response_headers';
    armTimer(firstResponseLimit, 'upstream_timeout');
    const upstream = await fetch(url, {
      redirect: 'error',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(anthropic ? anthropicHeaders(provider.apiKey) : provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {})
      },
      body: prepared.serialized,
      signal: upstreamController.signal
    });
    clearTimer();

    status = upstream.status;
    retryAfterMs = retryAfter(upstream.headers);
    retryAllowed = upstream.headers.get('x-should-retry') !== 'false';
    const traceId = upstream.headers.get('x-request-id');
    if (traceId !== provider.apiKey && /^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|req_[A-Za-z0-9]{16,64})$/.test(traceId || '')) upstreamRequestId = traceId;
    if (!upstream.ok) {
      classifiedCode = 'upstream_http';
      if (upstream.body && /^application\/(?:json|problem\+json)(?:;|$)/i.test(upstream.headers.get('content-type') || '')) {
        // A 429 may mean exhausted credit rather than a temporary rate limit.
        // Read only a bounded JSON error code; never retain the payload or message.
        const reader = upstream.body.getReader(), chunks = [];
        let length = 0, complete = false;
        armTimer(Math.min(idleLimit, 1000), 'upstream_http');
        try {
          while (length <= 16384) {
            const chunk = await reader.read();
            if (chunk.done) { complete = true; break; }
            length += chunk.value.byteLength;
            if (length <= 16384) chunks.push(chunk.value);
          }
          if (complete) {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const code = payload?.error?.code || payload?.error?.type || payload?.code;
            if (PROVIDER_ERROR_CODES.has(code)) httpErrorCode = code;
            if (PERMANENT_PROVIDER_CODES.has(payload?.error?.type)) httpErrorType = payload.error.type;
          }
        } catch { /* HTTP status remains authoritative if the error body is unreadable. */ }
        finally { clearTimer(); upstreamController.abort(); reader.releaseLock(); }
      } else await upstream.body?.cancel();
      throw new Error('Upstream HTTP error');
    }
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.body || !contentType.toLowerCase().includes('text/event-stream')) {
      classifiedCode = 'upstream_content_type';
      await upstream.body?.cancel();
      throw new Error('Upstream did not return SSE');
    }

    async function* rawChunksWithTimeout(bodyStream) {
      const reader = bodyStream.getReader();
      try {
        while (true) {
          armTimer(idleLimit, 'upstream_timeout');
          let res;
          try {
            failureStage = 'stream_read';
            res = await reader.read();
          } catch (err) {
            if (classifiedCode !== 'upstream_timeout') {
              classifiedCode = 'upstream_stream_error';
              const originalCode = transportCode(err);
              const readError = new Error('Upstream response body interrupted', { cause: err });
              readError.code = 'upstream_stream_error';
              readError.diagnostics = { failureKind: 'transport_error', transportErrorCode: originalCode };
              throw readError;
            }
            throw err;
          } finally {
            clearTimer();
          }
          if (res.done) break;
          receivedBytes += res.value.byteLength;
          failureStage = 'stream_parse';
          yield res.value;
        }
      } finally {
        reader.releaseLock();
      }
    }

    const scope = !chat && resumableModel(route) ? stateScope(route, provider) : null;
    const stream = processor(id, route.uid || request.modelUid, chat, write, scope);
    try {
      const adapt = anthropic ? createAnthropicAdapter() : event => [event];
      upstream: for await (const raw of events(rawChunksWithTimeout(upstream.body))) {
        for (const event of adapt(raw)) {
          failureStage = 'stream_event';
          lastUpstreamEvent = trackedEvent(event.type);
          metrics.event(event, chat);
          await stream.event(event);
          if (event.type === 'done' || (!chat && stream.terminal)) break upstream;
        }
      }
    } catch (err) {
      if (classifiedCode !== 'upstream_timeout') {
        const allowedCodes = new Set([
          'upstream_timeout', 'upstream_http', 'upstream_content_type',
          'upstream_stream_error', 'upstream_stream_incomplete',
          'upstream_invalid_tool', 'upstream_invalid_json', 'upstream_network'
        ]);
        classifiedCode = allowedCodes.has(err?.code) ? err.code : 'upstream_stream_error';
      }
      throw err;
    }

    let toolNames;
    try {
      failureStage = 'stream_finish';
      toolNames = await stream.finish();
    } catch (err) {
      classifiedCode = err?.code === 'upstream_invalid_tool' ? 'upstream_invalid_tool' : 'upstream_stream_incomplete';
      throw err;
    }

    res.end(frame(Buffer.from('{}'), 2));
    record({ event: 'chat-complete', model: route.model, status, toolNames, requestId: id,
      attempts: attempt, retries: attempt - 1,
      ...(upstreamRequestId ? { upstreamRequestId } : {}),
      ...(scope ? { replayedReasoningItems: body.input.filter(item => item.type === 'reasoning').length,
        savedOutputStateItems: stream.stateItems, savedReasoningStateItems: stream.reasoningStateItems } : {}) });
    return { status, toolNames, requestId: id };
  } catch (err) {
    clearTimer();
    const isClientCancel = signal?.aborted || res.destroyed || res.writableEnded;
    if (isClientCancel) {
      return { status, aborted: true };
    }

    const diagnostics = {
      failureKind: classifiedCode === 'upstream_timeout' ? 'timeout' :
        classifiedCode === 'upstream_network' ? 'transport_error' :
        classifiedCode === 'upstream_stream_incomplete' ? 'incomplete_stream' :
        classifiedCode === 'upstream_http' ? 'http_error' : 'protocol_error',
      failureStage, lastUpstreamEvent, receivedBytes,
      ...(upstreamRequestId ? { upstreamRequestId } : {}),
      ...(httpErrorCode ? { providerErrorCode: httpErrorCode } : {}),
      ...(httpErrorType ? { providerErrorType: httpErrorType } : {}),
      ...(err?.diagnostics || {}),
    };
    const connectionCode = transportCode(err);
    if (connectionCode) diagnostics.transportErrorCode = connectionCode;
    if (['TypeError', 'RangeError', 'SyntaxError'].includes(err?.name)) diagnostics.exceptionType = err.name;
    let errorText = 'Provider response could not be completed.';
    if (classifiedCode === 'upstream_http' && status >= 400) {
      errorText = `Provider returned HTTP ${status}.`;
    } else if (classifiedCode === 'upstream_content_type' || classifiedCode === 'upstream_invalid_json' || classifiedCode === 'upstream_invalid_tool') {
      errorText = 'Provider response format is invalid.';
    } else if (diagnostics.failureKind === 'provider_error') {
      errorText = 'Provider reported a failed response' +
        (diagnostics.providerErrorCode && diagnostics.providerErrorCode !== 'unrecognized_code' ? ` (${diagnostics.providerErrorCode})` : '') + '.';
    } else if (diagnostics.failureKind === 'transport_error') {
      errorText = status ? 'Connection to the provider was interrupted during the response.' :
        connectionCode === 'ENOTFOUND' || connectionCode === 'EAI_AGAIN' ? `Could not resolve the provider hostname (${connectionCode}).` :
        connectionCode === 'UND_ERR_CONNECT_TIMEOUT' || connectionCode === 'ETIMEDOUT' ? `Connection to the provider timed out (${connectionCode}).` :
        'Could not connect to the provider' + (connectionCode ? ` (${connectionCode})` : '') + '.';
    } else if (diagnostics.failureKind === 'timeout') {
      errorText = status ? 'Provider response timed out while waiting for more data.' : 'Provider did not respond before the timeout.';
    } else if (diagnostics.failureKind === 'incomplete_stream') {
      errorText = 'Provider stream ended before the response was completed.';
    }

    return { status, error: true, code: classifiedCode, requestId: id, diagnostics, errorText, retryAfterMs, retryAllowed };
  } finally {
    clearTimer();
    upstreamController.abort();
    signal?.removeEventListener('abort', abort);
    res.off('close', close);
  }
}

async function serveChat({ request, route, provider, res, signal, log = () => {}, timeouts = {}, retry = {}, onMetrics = () => {} }) {
  const id = randomUUID(), started = performance.now(), startedAt = new Date().toISOString();
  const policy = retryPolicy(retry), prepared = {}, client = new AbortController();
  const abort = () => client.abort();
  const close = () => { if (!res.writableEnded) abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  res.on('close', close);
  if (signal?.aborted) abort();
  const record = event => { try { log(event); } catch {} };
  let metrics, result = { status: 0 }, outcome = 'error', outcomeCode = null, committed = false, attempt = 0, retryStarted;
  try {
    while (!client.signal.aborted) {
      attempt++;
      metrics = createTracker({ id, request, route, provider, startTime: started, startedAt });
      result = await serveChatAttempt({ id, request, route, provider, res, signal: client.signal, log, timeouts,
        metrics, prepared, attempt, onOutput: () => { committed = true; } });
      if (result.aborted || client.signal.aborted) break;
      if (!result.error) { outcome = 'success'; return result; }
      // A slow first response must not consume the entire retry window before
      // any retry can start. Later attempts and backoff still consume the window.
      retryStarted ??= performance.now();
      const decision = retryDecision(result, policy, attempt, committed, retryStarted);
      if (decision.delayMs !== undefined) {
        record({ event: 'chat-retry', model: route.model, requestId: id, status: result.status, code: result.code,
          attempt, nextAttempt: attempt + 1, delayMs: decision.delayMs, ...result.diagnostics });
        if (!await waitForRetry(decision.delayMs, client.signal)) break;
        // Timer scheduling can exceed the budget if the event loop is busy.
        if (performance.now() - retryStarted < policy.budgetMs) continue;
        decision.reason = 'retry_budget';
      }
      const reasons = { output_started: 'response output already started', provider_no_retry: 'provider disabled retries',
        not_retryable: 'non-transient error', retry_limit: 'retry limit reached', retry_budget: 'retry time budget reached' };
      // This suffix also prevents an already loaded, older ACP observer from sending "continue".
      const message = result.errorText + (policy.enabled ? `\nAutomatic retries stopped (${reasons[decision.reason]}; ${attempt} attempts).` : '');
      try {
        if (client.signal.aborted || res.destroyed || res.writableEnded) break;
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/connect+proto', 'cache-control': 'no-store' });
        res.end(Buffer.concat([frame(textChunk(id, message)), frame(stopChunk(id, 13, route.uid || request.modelUid)), frame(Buffer.from('{}'), 2)]));
      } catch {
        if (!res.destroyed && !res.writableEnded) res.destroy();
      }
      outcomeCode = result.code;
      record({ event: 'chat-error', model: route.model, requestId: id, status: result.status, code: result.code,
        attempts: attempt, retries: Math.max(0, attempt - 1), retryStopped: decision.reason, ...result.diagnostics });
      return { status: result.status, error: true, code: result.code, requestId: id };
    }
    outcome = 'cancelled'; outcomeCode = 'client_cancelled';
    record({ event: 'chat-aborted', model: route.model, requestId: id, status: result.status, attempts: attempt });
    if (!res.destroyed && !res.writableEnded) res.destroy();
    return { status: result.status, aborted: true };
  } finally {
    metrics ||= createTracker({ id, request, route, provider, startTime: started, startedAt });
    try { onMetrics(metrics.finish(outcome, result.status, outcomeCode)); } catch {}
    signal?.removeEventListener('abort', abort);
    res.off('close', close);
  }
}

module.exports = { serveChat, buildRequestBody, parseEvent };
