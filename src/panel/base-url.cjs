'use strict';

// Shared by the extension host and the webview (injected via toString), so it
// must stay self-contained. Strips a pasted endpoint suffix. Anthropic keeps
// the supplied base path; other formats default to /v1 if no version is present.
function normalizeBaseUrlPath(pathname, apiFormat = '') {
  const path = String(pathname || '').replace(/\/(?:responses|chat\/completions|messages|models)\/?$/, '').replace(/\/+$/, '');
  if (apiFormat === 'anthropic') return path;
  return path.split('/').some(segment => /^v\d+/i.test(segment)) ? path : path + '/v1';
}

module.exports = { normalizeBaseUrlPath };
