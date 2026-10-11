# Context request attribution contract

## 1. Scope / Trigger

The context statusbar and detail panel join native ACP context usage with the
latest completed BYOK request for the selected session. Windows previously used
the Unix database path and `/usr/bin/sqlite3`, making every join unavailable.
Recent Devin versions also keep tool identities in message_nodes rather than
consistently populating tool_call_state.

## 2. Signatures / Configuration

`defaultDatabasePath({ platform, env, home })` resolves Windows
`APPDATA/Devin/cli/sessions.db`, falling back to the user's AppData/Roaming;
Unix uses `XDG_DATA_HOME/devin/cli/sessions.db` or
`~/.local/share/devin/cli/sessions.db`. Explicit createMonitor databasePath is
retained for isolated tests. No database or machine-specific paths ship in VSIX.

`createMonitor({ root, databasePath }).snapshot()` keeps monitor protocol 1.
`contextDetails(session, monitor, catalog)` matches one exact session group.
The context UI refreshes when the asynchronous snapshot arrives, coalesces
reads, and retains the user's selected session.

## 3. Contracts / Invariants

- Use built-in node:sqlite with readOnly true and a one-second lock timeout.
  Never create a missing database, change its schema or checkpoint its WAL.
- Bind JSON identity arrays through json_each parameters; do not construct SQL
  from a provider-controlled response or tool identifier.
- Query reply message_id, tool_call_state.tool_call_id, message tool_call_id,
  and assistant tool_calls[].id. Ignore invalid message JSON and malformed tools.
  The legacy tool table may be absent while message attribution still works.
- Run synchronous SQLite work in an isolated Worker from monitor.cjs, with an
  eight-second deadline and guaranteed database close. Network streaming must
  remain responsive during parsing of a large session database.
- One outstanding lookup per monitor, at most 5,000 requests, 15-second snapshot
  cache. New monitor records invalidate that cache. Keep SOURCE_FILES unchanged
  in structure so old hosts can determine backend identity consistently.
- Exact reply identity takes precedence; otherwise the union of emitted tool
  matches must name exactly one session. Ambiguity remains unassigned. Input
  history, timestamps, model names or global totals cannot select a session.
- Public snapshots strip stored request-history and tool identities. No prompt
  or message contents enter diagnostics, fixtures or repository artifacts.
- Missing provider counters remain null; zero remains zero. Cache and reasoning
  are subsets, not extra token charges. Tool output does not establish text TPS.

## 4. Validation / Error Matrix

| Situation | Result |
| --- | --- |
| Reply ID uniquely present | response-id attribution |
| Only emitted tool identity present in native message JSON | tool-id attribution |
| One ID copied across multiple sessions | ambiguous; no context request metrics |
| No stable emitted identity | unassigned, retained in usage view |
| Missing/corrupt database or incompatible message schema | degraded snapshot; sessionStatus unavailable |
| Empty request history | empty ready snapshot without unnecessary SQLite work |
| Provider omitted a counter or text speed is inapplicable | display an em dash |
| Valid provider zero | display zero |

The request tile distinguishes no observed session, unavailable request data,
unavailable attribution and no attributable completed BYOK request. It never
substitutes another session's record to make the panel look populated.

## 5. Good / Base / Bad Cases

Good: a generated gateway reply ID differs from the native message ID, but its
tool ID is present in a live WAL message. The selected session displays the
request duration, first response and provider cache counters.

Base: a text-only reply without a persistent identity stays unassigned; native
context usage still appears independently when its ACP event arrives.

Bad: copying conversation history to a new session must not assign every old
request to the new window; a multi-session tool match stays ambiguous.

## 6. Tests / Evidence Required

test/monitor.test.cjs and test/monitor-database.test.cjs create real portable
SQLite fixtures, including uncheckpointed WAL, missing legacy tables, hostile
quoted IDs, malformed JSON/tools, exact priority, ambiguity, restart, no missing
DB creation and the monitor-client-to-context-view path. Context tests cover
zero/missing values, selected session isolation, UI disposal and async refresh.

On 2026-10-11 the updated reader resolved real local Windows request records and
populated request timing, input and cached-token fields. This read-only audit
does not publish session identifiers or conversation data. Built-in Devin Node
also ran the SQLite Worker regression. An installed editor needs extension
reload and backend upgrade before the new implementation is active.

## 7. Wrong vs Correct

Wrong: require a Unix executable on Windows, scan synchronously in the streaming
backend, or select a session by recent activity/global usage to fill empty cells.

Correct: discover the platform data path, read a consistent SQLite statement in
a bounded Worker, use unique emitted identities and explain genuinely missing
metrics. See [Node.js 24 SQLite API](https://nodejs.org/download/release/v24.16.0/docs/api/sqlite.html).
