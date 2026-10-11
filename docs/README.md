# Implementation contracts

These contracts describe the additions to the upstream v0.3.42 plugin.

- [Responses output state and cache keys](CACHE-CONTRACT.md)
- [Provider error classification](ERROR-CONTRACT.md)
- [Standalone backend proxy routing](PROXY-CONTRACT.md)
- [Bounded original-request retries](RETRY-CONTRACT.md)
- [Cross-platform context request attribution](CONTEXT-CONTRACT.md)
- [Windows and Unix Goal report transport](GOAL-REPORT-CONTRACT.md)

Run `npm test` with Node.js 24.14+ and build with `npm run package`. Tests use
synthetic data and local services by default. SQLite fixtures use node:sqlite
on all supported platforms. Unix mode assertions run only on Unix; macOS
restart tests have explicit platform prerequisites. Set BYOK_TEST_DEVIN_APP_ROOT
to an installed resources/app directory to verify native picker and ACP code.
Tests requiring a live service stay opt-in. A fixture pass is not evidence of
remote provider availability; real CLI verification also does not imply full
editor GUI acceptance.

Preserve the runtime source identity contract when changing backend dependencies:
old extension hosts use the `SOURCE_FILES` list to decide whether a backend needs
an upgrade. Reload the window after installing a new version; never terminate an
active request just to apply an update.

Keep LICENSE and THIRD_PARTY_NOTICES.md with redistributed source and packages.
Only source, synthetic tests and public documentation belong in this repository;
user configuration, session databases, credentials and live traffic do not.
