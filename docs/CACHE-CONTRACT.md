# Responses cache and native reasoning state contract

## 1. Scope / Trigger

Applies to GPT-5/6 and o1/o3/o4 models using OpenAI Responses with reasoning
effort other than `none`. Preserve complete output state through native message
signatures and use a stable prompt cache key. Other API formats retain their
existing request controls. Visible history alone cannot reconstruct previously
discarded encrypted reasoning, output IDs or message phases.

## 2. Signatures

- `buildRequestBody(request, route, provider)` in `src/protocol/responses.cjs`.
- `serveChat({ request, route, provider, res, signal, log, timeouts, onMetrics })`.
- Native response: protobuf `GetChatMessageResponse.delta_signature`, field 10.
- Native request: protobuf `ChatMessagePrompt.signature`, field 12, or the
  equivalent flat JSON `signature` string. Native message source 3 is assistant.
- Envelope: `dfbyok-responses-v1:` followed by base64url JSON `{ scope, items }`.
- Scope: SHA-256 of `[provider.id, provider.baseUrl, provider.apiKey, route.model]`.

The input layout follows the native extension's generated `ChatMessagePrompt`
implementation. The response field layout is also recorded
in the independently maintained [Devin protobuf schema](https://github.com/ShadowSmallBaby/ClawProxyHubPlugins/blob/main/plugins-go/devin/devinproto/devinproto.proto).

## 3. Contracts

Responses requests set `store: false`, `include: ["reasoning.encrypted_content"]`
and `prompt_cache_key: "dfbyok-" + scope.slice(0, 40)`. The key stays stable as
history grows or the reasoning effort changes. No plaintext credential is placed
inside the envelope or key. No retention or explicit breakpoint setting is
added; actual cache support and reported usage depend on the provider.

Capture complete `response.output_item.done` items and the final
`response.completed.response.output`, preserving their numeric output ordering.
Before the terminal native chunk, encode the validated complete output in the
signature field. The native client persists it with the assistant message.
On the next request, restore those exact items at that message's position,
including encrypted reasoning, message phases and original tool argument bytes.
Tool results continue to follow their matching function calls.

Only self-contained reasoning items with nonempty `encrypted_content` and an
array `summary` may be replayed. Output types are restricted to `reasoning`,
assistant `message` with `output_text`, and `function_call`. Envelopes are limited
to 8 MiB and 512 items. Visible assistant text and ordered tool IDs, names and
JSON argument values must still match the native message; new images invalidate
the state. No prompt text or opaque state is added to diagnostic logs.

Successful chat logs add only numeric `replayedReasoningItems`,
`savedOutputStateItems` and `savedReasoningStateItems`. Token cache counts continue
to come from the upstream usage response.

## 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| Matching completed output and provider/model scope | Replay exact ordered output |
| Provider, URL, credential or model changed | Fall back to visible native history |
| Text, images, tool IDs, names or argument values edited | Fall back to visible native history |
| JSON argument whitespace/key order changed | Retain original output bytes if values match |
| Foreign, malformed or oversized signature | Ignore the envelope |
| Reasoning item contains only an ID | Omit state; server storage is disabled |
| No reasoning item, valid message/tool output | Preserve that output's IDs and phases |
| Truncated output | No replay envelope or partial tool call |
| Failed/cancelled stream | Existing error/cancellation handling; no completed state |
| Cache miss / gateway reports zero | Report the upstream value; do not fabricate a hit |

## 5. Good / Base / Bad Cases

Good: `[reasoning, commentary message, function call, reasoning, function call]`
is saved as one native signature and restored in exactly that sequence. The next
turn appends the tool results without losing either reasoning item.

Base: an existing conversation without signatures still sends its visible text
and tool calls. Already discarded reasoning cannot be reconstructed.

Bad: replaying a signature after a history edit or provider/model switch must
never replace the current message. A Responses reasoning ID alone is not usable
with `store: false`.

## 6. Tests Required

`test/responses-state.test.cjs` exercises a local HTTP upstream, the actual
adapter, Connect/protobuf framing and native input parsing. It covers complete
ordered state, JSON/protobuf round trips, phases, incomplete final output,
history edits, provider/model/credential isolation, stable keys, malformed or
oversized state, IDs without ciphertext, truncation and other API formats.

Run `npm test`. Fixtures establish state preservation and isolation; cache hit
rates require the provider's real `usage.input_tokens_details.cached_tokens`.
Do not publish private conversation state, credentials or live traffic records.

## 7. Wrong vs Correct

Wrong: reduce every assistant turn to text and fresh function-call objects,
discard reasoning and phases, then assume identical visible text guarantees
cache reuse.

Correct: request self-contained encrypted state, preserve the complete ordered
output through the native signature, validate it against current history and
scope, and measure actual `usage.input_tokens_details.cached_tokens`.

References: [OpenAI reasoning state](https://developers.openai.com/api/docs/guides/reasoning),
[prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics).
