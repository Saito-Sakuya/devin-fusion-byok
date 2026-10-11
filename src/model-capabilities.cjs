'use strict';

const SERVICE_TIER_OPTIONS = Object.freeze([
  { value: '', label: '跟随供应商（默认）' },
  { value: 'default', label: '标准（default）' },
  { value: 'fast', label: 'Fast（fast）' },
  { value: 'priority', label: 'Fast（priority 兼容值）' },
]);

function modelServiceTier(model, provider = {}) {
  if (provider.apiFormat === 'anthropic') return null;
  const value = model?.serviceTier;
  if (value == null || value === '') return null;
  if (!SERVICE_TIER_OPTIONS.some(option => option.value === value)) throw new Error('Invalid model service tier');
  return value;
}

// /models commonly reports IDs only. Keep provider-specific overrides explicit;
// use the standard GPT/o reasoning controls only for recognizable base IDs.
function modelEfforts(model) {
  if (model.effortMode === 'none') return [null];
  if (Array.isArray(model.efforts) && model.efforts.length) return [...new Set(model.efforts)];
  if (model.effortMode === 'manual') return [null];
  const id = String(model.id || '').split('/').at(-1);
  if (/^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(id) &&
      !/(?:^|-)(?:none|minimal|low|medium|high|xhigh|max|ultra)(?:-|$)/i.test(id)) {
    // The null variant retains previously saved UIDs and provider-default behavior.
    return [null, 'low', 'medium', 'high', 'xhigh', 'max'];
  }
  // Claude Opus/Sonnet/Fable 4.6+ accept output_config.effort; Haiku does not.
  if (/^claude-(?:opus|sonnet|fable|mythos)-(?:[5-9]|4-[6-9])(?:[-.]|$)/i.test(id)) return [null, 'low', 'medium', 'high', 'xhigh', 'max'];
  return [null];
}

function modelSupportsImages(model) {
  return true;
}

module.exports = { modelEfforts, modelSupportsImages, modelServiceTier, SERVICE_TIER_OPTIONS };
