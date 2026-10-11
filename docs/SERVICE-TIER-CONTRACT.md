# OpenAI Fast service-tier contract

## 1. Scope / Trigger

v0.3.45 adds an explicit, per-provider/model processing choice to BYOK OpenAI
Responses and Chat Completions. It applies equally to configured Lead, Sidekick
and subagent routes. Anthropic Messages suppresses the OpenAI field. Existing
models and discovered models keep provider-default behavior until edited.

Official API source, checked 2026-10-11:
[Fast mode](https://developers.openai.com/api/docs/guides/fast-mode).
Both `fast` and `priority` request Fast processing for supported models;
availability, premium pricing and possible server downgrades remain upstream.

## 2. Signatures

- `modelServiceTier(model, provider = {}) -> string | null` in model-capabilities.cjs.
- `SERVICE_TIER_OPTIONS` supplies one shared allowlist and the webview labels.
- `updateModels({ providerId, changes: [{ id, serviceTier }] })` and
  `addModel({ providerId, model: { id, serviceTier, ... } })` use the existing manager.
- `buildRequestBody(request, route, provider)` writes `service_tier` only when
  the selected OpenAI route has an explicit choice.
- `createTracker(...).finish(...)` adds optional `serviceTierRequested` and
  `serviceTierActual`; snapshot normalization preserves only known enum values.

## 3. Contracts

Private model configuration uses `serviceTier: 'default' | 'fast' | 'priority'`.
The empty UI value deletes that property, so the HTTP field is omitted. This
preserves the provider/project default, which itself may already use Fast.
Standard explicitly sends `default`. Discovery does not infer paid eligibility.

The catalog passes the setting to every effort route for that provider/model.
Provider/model/effort routing identities and Fusion references stay unchanged.
Reasoning effort, tool schemas, Responses state scope and prompt-cache keys are
independent. A new request reads the current configuration; an in-flight request
and its retries retain the already-serialized original body. No service-tier
header is added; the separate Ultrafast header/tier is outside this feature.

The public model state includes the saved choice but no credential. The model
dialog shows it for OpenAI formats only, with a premium-pricing/support hint.
An Anthropic protocol switch suppresses an existing choice without destroying
it, so changing back can restore it.

Requested metrics contain the explicit field or null when omitted. Actual
metrics require a terminal Responses object (completed, incomplete or failed),
or a Chat Completions chunk with a finish reason or usage. A created event cannot
prove the final processing tier. Only auto/default/flex/scale/priority/fast/
ultrafast values are retained; absent/unknown values become null. Monitor schema
3 is extended additively; old records remain readable. Context details and the
detailed usage table show requested and actual values separately, with
provider-default and unreported labels respectively when absent.

## 4. Validation & Error Matrix

| Input / response | Result |
| --- | --- |
| Missing or empty UI choice | Omit field; existing provider default applies |
| default / fast / priority | Persist and send exactly that value for OpenAI |
| Null, boolean, object, unknown or whitespace-padded UI value | PanelInputError before a write |
| Nonempty choice submitted for Anthropic | PanelInputError before a write |
| Saved OpenAI choice after provider changes to Anthropic | Omit field and requested metric |
| Invalid explicit OpenAI value in manually edited config | Catalog validation error; no arbitrary value sent |
| HTTP 400 unsupported service tier | Existing parameter error; no retry or silent tier fallback |
| Temporary network failure before output | Existing bounded retry; identical serialized tier |
| Actual tier differs from requested tier | Preserve and display both independently |
| Actual tier missing or outside allowlist | Unreported; never substitute the requested tier |

## 5. Good / Base / Bad Cases

Good: set fast for a GPT Lead and priority for a separate Sidekick. Requests
retain each model's own effort and tier. An upstream default response remains
visible as default rather than being labelled Fast.

Base: upgrading or importing a model sends exactly the previous request body
until an explicit tier is selected. Selecting the empty option restores this.

Bad: treating a model ID, an early created event or a UI Fast selection as proof
of actual paid Fast processing; sending OpenAI fields to Anthropic; inventing
`fast: true`; switching request tiers silently during retry.

## 6. Tests Required

- service-tier.test.cjs: manager write/state -> catalog -> HTTP body for both
  OpenAI APIs; independent Fusion roles; stable identities/cache/tools/effort;
  invalid values and Anthropic suppression; terminal/unknown metrics and reload;
  real local backend responses showing requested Fast and actual default.
- panel-view.test.cjs: restore/save the selection, default omission, protocol
  visibility, and billing/compatibility hint using the emitted browser script.
- request-retry.test.cjs: identical priority bodies across transient attempts;
  unsupported Fast returns once without deleting or replacing the parameter.
- monitor-panel.test.cjs: detailed columns distinguish requested fast from
  actual default while preserving previous zero/missing metric behavior.

These use synthetic local servers. No test claims live Fast eligibility,
performance gains or a specific supplier's price.

## 7. Wrong vs Correct

Wrong: enable a lower reasoning effort and call it Fast; always display the
requested tier as the actual tier; automatically strip a rejected paid option.

Correct: send the documented `service_tier` independently of reasoning, keep
retry bytes unchanged, and use only allowlisted upstream terminal values as
processing evidence. Let the user choose provider defaults or a compatibility
value when the provider does not support the requested option.
