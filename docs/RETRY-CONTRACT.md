# BYOK automatic request retry contract

## 1. Scope / Trigger

Applies to routed BYOK inference using OpenAI Responses, Chat Completions and
Anthropic Messages. A retry resends the same serialized request after a confirmed
temporary failure, before any native response frame has been emitted. Official
account/ACP forwarding and model discovery keep their existing behavior.

## 2. Signatures / Configuration

`serveChat({ request, route, provider, res, signal, retry, timeouts, log, onMetrics })`
owns the logical native request. `serveChatAttempt` owns one upstream HTTP request.
The backend supplies only `retry.enabled`; production limits are fixed.
Internal test options can shorten delays/budgets but cannot exceed 3 additional
attempts or the 60-second scheduling window.

`autoRetryProviderRequests` is the persisted switch. If absent, the legacy
`autoContinueOnProviderError` value is accepted for compatibility. The existing
panel command `setAutoContinue` writes the new switch and clears the legacy flag.
The panel retains its existing public-state field, now showing backend retries.
New extension activation enables ACP auto-continue only for unfinished plans.
Reload the extension host after upgrading so the settings panel and ACP observer
use the same implementation. Requests read the retry setting on each new call.

## 3. Contracts / Invariants

- At most 3 additional HTTP attempts, 4 total. No unbounded retry loop.
- Base waits are 2, 4 and 8 seconds with 0-20% positive jitter. Respect
  `retry-after-ms`, then seconds/fractional seconds or an HTTP date in `Retry-After`.
- Start retries only within 60 seconds of the original request. A delay that
  exceeds the remaining budget ends retries; it is not shortened. In-flight
  generation retains the previous 120-second headers/idle timeout.
- One native request ID, one final stop and trailer, one monitor record. Request
  JSON bytes, model, cache key and replay history remain identical across attempts.
- Client abort/disconnect cancels upstream fetch and backoff immediately.
- Each attempt has fresh parser, adapter, tools, usage and output-state buffers.
  Failed attempt data is discarded; its usage is not claimed as successfully
  delivered output or a refund. Providers may charge failed attempts.
- Any emitted text, thinking, signature, tool, usage or stop frame prevents replay.
- Monitor duration/first-output timing includes all attempts and waits, while
  successful usage and tool IDs come only from the successful attempt.
- Whitelisted metadata logs retries and terminal reasons. No raw upstream error
  messages, prompts, credentials, headers or request bodies enter diagnostics.

## 4. Validation / Error Matrix

| Failure | Retry before native output? |
| --- | --- |
| DNS failure, refused/reset connection, pipe/socket error, connect/read timeout | Yes, for known transient transport codes |
| HTTP 408, 429, 500, 502, 503, 504 | Yes, unless a known permanent JSON code or `x-should-retry: false` overrides |
| Explicit server/internal/API/overload/rate/timeout SSE codes | Yes |
| Documented gateway read/truncation SSE codes or premature EOF | Yes |
| Auth, permission, quota, model/context, parameter or encrypted-state error | No |
| Ambiguous gateway `upstream_error` or unknown SSE code | No |
| Invalid JSON, content type, tool schema or completed protocol payload | No |
| Visible response already emitted | No |
| Client stop/disconnect or exhausted count/time budget | No |

For HTTP JSON errors, inspect at most 16 KiB with a one-second upper read limit;
retain only a recognized machine code. Oversized numeric retry delays saturate
to a value beyond the budget. Final failures include a bounded retry-stop suffix
that the ACP observer treats as terminal, including when plan continuation is on.

## 5. Good / Base / Bad Cases

Good: 503 then 502 then completion produces one successful native response from
three byte-identical requests, without intermediate error text.

Base: switching off retries restores the previous single-attempt failure text.
Changing the setting affects the next request without restarting the backend.

Bad: partial text plus reset cannot replay the prompt or pending tools. Persistent
503 ends after four attempts; 429 insufficient quota ends after one. Stopping
during a two-second backoff cannot produce another POST.

## 6. Tests / Evidence Required

`test/request-retry.test.cjs` uses local HTTP servers, dropped sockets,
streaming bodies, cancellation, Retry-After headers and an isolated backend
controlled by the real settings manager. It checks byte-identical replay,
bounded attempts and waits, terminal ACP suppression, independent attempt state,
metrics, permanent errors and cancellation. Run `npm test` for these cases and
the original regression suite.

Build with `npm run package` and inspect the VSIX identity and retained licenses.
Offline fixtures do not establish current provider availability. Use only
synthetic prompts for optional live verification.

## 7. Wrong vs Correct

Wrong: send conversation `continue` after every error, restart after partial
output, reuse failed tool buffers, ignore server delays, or hide failures forever.

Correct: retry the original BYOK request inside its native lifecycle with finite
limits, cancellable waits, fresh attempt state, safe diagnostics and an explicit
terminal result. Activate installed code using authenticated idle shutdown;
never kill the editor or an active inference to load this change.

References consulted on 2026-10-11:

- [OpenAI SDK retry eligibility and Retry-After handling](https://github.com/openai/openai-python/blob/main/src/openai/_base_client.py)
- [Anthropic SDK retry behavior](https://github.com/anthropics/anthropic-sdk-python#retries)
