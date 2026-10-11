# Provider failure diagnostics contract

## 1. Scope / Trigger

Applies to routed BYOK inference in this fork. The generic
`Provider response could not be completed.` obscures whether a provider event,
a broken connection, an incomplete stream or a protocol error ended a request.
Classify these causes without exposing raw upstream payloads.

## 2. Signatures

The existing `serveChat(...)` and `processor(...).event(event)` contracts remain.
`chat-error` log events retain `model`, `status`, `code` and `requestId`, and add
`failureKind`, `failureStage`, `lastUpstreamEvent` and `receivedBytes`. Optional
fields are `upstreamEvent`, `providerErrorCode`, `transportErrorCode`, `upstreamRequestId` and
`exceptionType`. Native failure stop reason remains 13.

## 3. Contracts

`failureKind` differentiates `provider_error`, `transport_error`, `timeout`,
`incomplete_stream`, `http_error` and `protocol_error`. Stages include request
building, response headers, body reads, event parsing/handling and finalization.
Raw messages and payloads are never logged. Provider/transport codes use finite
allowlists; unknown provider codes become `unrecognized_code`. Event names use
known protocol values or `other`. Only numeric byte counts are retained.
Recognized provider codes include documented Sub2API stream transport codes.
The outer SSE `type: error` is not treated as a provider error code. Request
identifiers are restricted to UUIDs or bounded OpenAI `req_` values, excluding
the configured API key. Pre-response DNS failure and connect timeout display
their safe machine code, instead of the generic connection message.

Error classification itself does not change provider settings or timeouts.
The retry layer separately consumes the recognized transient classification. A failed stream cannot emit pending tools or replay state.

## 4. Validation / Error Matrix

| Trigger | Classification / user behavior |
| --- | --- |
| SSE `response.failed` or `error`, including HTTP 200 | Provider failed response, recognized code if available |
| Body reader rejects | Interrupted provider connection; safe underlying transport code |
| EOF with no terminal event | Stream ended before completion |
| Headers timeout | Provider did not respond before timeout |
| Idle stream timeout | Provider timed out waiting for more data |
| Invalid SSE JSON, schema or tool arguments | Invalid provider response format |
| Unexpected completed status | Protocol failure; known event logged |
| Client abort | Existing `chat-aborted` and `client_cancelled`, separate from upstream failure |

## 5. Good / Base / Bad Cases

Good: HTTP 200 followed by `response.failed` with `server_error` logs
`failureKind: provider_error`, stage `stream_event`, and the recognized code.

Base: a successful response retains its original native output and stop reason.

Bad: a provider uses a secret or prompt text as an error code/message. The message
is discarded and the unknown code is replaced, never copied to logs or user text.

## 6. Tests Required

`test/provider-errors.test.cjs` exercises local HTTP/SSE and native framing for
provider failures, disconnects, EOF, both timeout stages, malformed protocol,
cancellation, DNS, recognized gateway codes and successful responses. It checks
secret omission and withholding incomplete tools/state. Run `npm test`; retries
and proxy routing have independent fixture suites.

## 7. Wrong vs Correct

Wrong: infer that HTTP 200 guarantees successful inference, or treat all
`upstream_stream_error` records as network resets.

Correct: record the failure source and stage, distinguish provider failure events
from rejected reads, and keep client cancellations separate. Existing coarse
records remain inconclusive; diagnose a new occurrence with the added fields.
