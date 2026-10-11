# Goal report platform contract

## 1. Scope / Trigger

Each Goal run submits a status plus evidence through goal-report.cjs using a
per-run capability. The previous generated command always used POSIX inline
environment assignment and quoting, which failed in Windows PowerShell.

## 2. Signatures / Configuration

`reportCommandFor({ execPath, reportCliPath, storeRoot, token, platform })`
defaults platform to process.platform. Unix retains its POSIX command; Windows
emits a PowerShell command that edits JSON, encodes it as UTF-8 Base64, executes
the fixed report CLI, checks its exit code and restores ELECTRON_RUN_AS_NODE.

`goal-report.cjs --store <absolute> --capability <64 hex> <JSON>` remains valid.
The equivalent Windows transport is `--report-base64 <canonical Base64 JSON>`.
Only one report payload is accepted. The decoded payload is capped at 32 KiB;
evidence retains the existing 1-4,000 character limit.

## 3. Contracts / Invariants

- PowerShell single quotes escape apostrophes by doubling them. JSON evidence
  must not expand variables, command substitutions or native-argument quotes.
- Use a base64 ASCII argument to survive both Windows PowerShell 5 and PS7.
  Decode strictly as UTF-8 and reject non-canonical or oversized base64.
- Pipe Electron output to Out-Host so PowerShell waits for the GUI-subsystem
  executable's Node-mode report process. A nonzero report exit throws visibly.
- The prompt asks the model to edit status/evidence only; paths, executable and
  capability remain fixed. An accepted report is consumed only by its active
  run, goal revision and session; no chat assertion can mark the Goal complete.
- Retain capability expiry, single report per run, ownership, permission,
  cancellation and idle gates. No credentials or real capabilities enter docs.
- Keep ACP v1/v2 behavior: a v2 local prompt acknowledgement does not complete
  a run; processing occurs on the real corresponding end-of-turn event.

## 4. Validation / Error Matrix

| Input or state | Result |
| --- | --- |
| Valid JSON or canonical UTF-8 base64, active capability | same validated report submission |
| Both transports, or multiple payloads | argument error, exit 2 |
| Bad base64, UTF-8, JSON, unknown field/status, oversized evidence | argument error, exit 2 |
| Stale/absent capability, revision, session or active run | report rejected, exit 1 |
| Duplicate report | preserve first evidence; reject second, exit 1 |
| Accepted progress and actual idle | schedule next bounded Goal run |
| Accepted complete and actual idle | consume evidence, complete and archive |
| Permission, cancel, disconnect, rejected dispatch or ambiguous session | stop or pause according to existing Goal contract |

## 5. Good / Base / Bad Cases

Good: a Windows path contains spaces, Chinese and an apostrophe. Evidence with
quotes and literal $(text) round-trips unchanged through PowerShell and Electron.

Base: an existing Unix script continues using its JSON positional argument.

Bad: a copied report command from an older run cannot complete a newer Goal;
duplicate invocation visibly fails and cannot overwrite the accepted evidence.

## 6. Tests / Evidence Required

test/goal-report-platform.test.cjs runs the generated command in actual Windows
PowerShell 5/PS7 or /bin/sh with an isolated goal store. It checks successful
completion, literal Unicode/quotes, failure exit, capability invalidation and
strict parsing. The existing Goal controller/transport/store suite checks idle,
ownership, permission, manual input, budgets, interruption and missing evidence.

BYOK_TEST_DEVIN_APP_ROOT enables checks against the actual installed Devin ACP
parser and picker. On 2026-10-11 an isolated Windows audit also used the actual
Devin CLI, authenticated through an isolated backend and the configured working
BYOK route. A test host adapter supplied the same registration interface: the
model executed a progress report in round one, the controller automatically
started round two, and the model executed a complete report. Two evidence
entries were consumed without errors. No existing editor session was reloaded
or interrupted. This is real CLI evidence; full editor GUI acceptance remains
separate and Goal retains its Beta label.

## 7. Wrong vs Correct

Wrong: generate POSIX syntax for Windows, pass raw JSON through Windows
PowerShell's native argument parser, or treat shell launch success as acceptance.

Correct: choose the platform's quoting and UTF-8 transport, check the actual CLI
result, and let the existing controller consume a validated scoped report only
after the matching turn ends.
