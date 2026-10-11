# Standalone backend proxy contract

## 1. Scope / Trigger

Applies to the standalone backend's fetch and native HTTP/HTTPS requests.
Editor proxy settings are not automatically inherited by a detached Node
process. Configure both transports before listening, using Node.js 24.14+
proxy support and the existing JSONC settings parser.

## 2. Signatures

`configureBackendProxy(root, log = () => {}, env = process.env)` returns a restore
function and reads `../../settings.json` relative to
the extension's global-storage root using the existing JSONC parser. It configures
Node's documented `http.setGlobalProxyFromEnv()` once before starting the server,
affecting both fetch and native HTTP/HTTPS. It does not rewrite settings or change
system proxy configuration. The required built-in method exists in Node 24.14+.

## 3. Contracts

An explicit `http.proxySupport: "off"` disables proxies. Otherwise a nonempty
`http.proxy` applies to both HTTP and HTTPS and overrides inherited proxies.
Without that setting, lowercase environment values take precedence over uppercase
values. User `NO_PROXY` rules are preserved and localhost/IPv4/IPv6 loopback are
always added to keep ACP and management requests local.

Malformed settings fall back to environment values and emit a bounded code,
`settings_unreadable`. Unsupported runtimes and invalid proxy values retain the
previous transport and log mode `unsupported` or `invalid`. Proxy modes are logged;
proxy URLs, credentials and raw exception messages are never logged. Proxy changes
are applied at the next backend startup, not during an active inference.

## 4. Validation / Error Matrix

| Input / event | Behavior |
| --- | --- |
| Nonempty editor HTTP proxy | Applies to fetch, HTTP and HTTPS at startup |
| Proxy support `off` | Disables settings and inherited proxies |
| No editor proxy | Inherits environment proxy precedence |
| Loopback / custom bypass | Connects directly |
| Malformed settings | Safe settings error; environment fallback |
| Unsupported runtime / invalid proxy URL | Safe mode; retains previous transport |
| Pre-response DNS / connect timeout | Separate message with allowlisted code |
| Gateway SSE error | Allowlisted gateway code; no partial tools or state |

Pre-response DNS and connection timeouts have distinct text and their allowlisted
transport codes. Interrupted HTTP 200 bodies keep their existing stream failure
text. Gateway stream codes documented by Sub2API are recognized without storing
arbitrary upstream error messages. Outer SSE `type: error` is not a machine code.
Only UUIDs and bounded OpenAI `req_` identifiers from `x-request-id` are retained;
the configured API key is excluded. Failed responses cannot supply pending tools
or replay state, and proxy configuration itself does not add retries or extend timeouts.

## 5. Good / Base / Bad Cases

Good: a deliberately unresolvable fixture host succeeds through the configured
CONNECT proxy, and the origin receives the original synthetic request.

Base: editor-local management and ACP still connect directly, with user bypasses
and exact settings bytes preserved.

Bad: malformed settings or arbitrary upstream trace/error strings never expose
raw credentials, prompts or exception text in logs.

## 6. Tests Required

`test/backend-proxy.test.cjs` uses a local CONNECT/HTTP proxy and a deliberately
unresolvable `.invalid` host to verify fetch and native HTTP routing, environment
fallback, explicit disablement, user bypasses and loopback routing. Settings
remain byte-identical and diagnostics omit fixture secrets. Provider error tests
cover recognized gateway codes, safe identifiers and DNS failures. Run `npm test`
on Node.js 24.14+; passing fixtures do not certify remote connectivity.

## 7. Wrong vs Correct

Wrong: assume editor `http.proxy` automatically configures a detached Node backend,
or reset global agents while an inference is running.

Correct: explicitly configure the documented Node proxy transport before starting
the backend, retain local bypasses, and verify through actual installed requests.
An idle authenticated restart updates transport without cancelling active work.

## References

- [Node HTTP proxy support](https://nodejs.org/api/http.html#httpsetglobalproxyfromenvproxyenv)
- [Sub2API stream errors](https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/service/openai_stream_read_error.go)
- [Sub2API stream_read_error example](https://github.com/Wei-Shaw/sub2api/issues/6506)
