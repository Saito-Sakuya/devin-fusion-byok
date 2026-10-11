'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createMonitor, defaultDatabasePath } = require('../src/runtime/monitor.cjs');
const { publicSnapshot } = require('../src/runtime/monitor-client.cjs');
const { contextDetails, createContextUi } = require('../src/panel/context-view.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-database-'));
  const databasePath = path.join(root, 'sessions.db');
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE message_nodes(session_id TEXT, chat_message TEXT)');
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, databasePath, db, monitor: createMonitor({ root, databasePath }),
    message: (session, data) => db.prepare('INSERT INTO message_nodes VALUES (?, ?)').run(session, JSON.stringify(data)) };
}
const record = (id, toolIds = []) => ({ schemaVersion: 3, id, startedAt: '2026-01-01T00:00:00Z', model: 'synthetic-model',
  status: 'success', httpStatus: 200, inputTokens: 100, outputTokens: 20, cachedTokens: 80, reasoningTokens: 0,
  firstResponseMs: 100, firstOutputMs: 200, firstTextMs: 200, durationMs: 1100, hasTools: toolIds.length > 0, toolIds });

test('database discovery uses Windows roaming data and honors Unix XDG data roots', () => {
  assert.equal(defaultDatabasePath({ platform: 'win32', home: 'C:\\Users\\Fixture', env: { APPDATA: 'E:\\Roaming' } }), 'E:\\Roaming\\Devin\\cli\\sessions.db');
  assert.equal(defaultDatabasePath({ platform: 'win32', home: 'C:\\Users\\Fixture', env: {} }), 'C:\\Users\\Fixture\\AppData\\Roaming\\Devin\\cli\\sessions.db');
  for (const platform of ['darwin', 'linux']) {
    assert.equal(defaultDatabasePath({ platform, home: '/home/fixture', env: {} }), '/home/fixture/.local/share/devin/cli/sessions.db');
    assert.equal(defaultDatabasePath({ platform, home: '/home/fixture', env: { XDG_DATA_HOME: '/data' } }), '/data/devin/cli/sessions.db');
  }
});

test('live WAL message tools restore session request metrics through the public client and context view', async t => {
  const f = fixture(t);
  f.message('lead-session', { message_id: 'native-generated', role: 'assistant', content: 'PRIVATE', tool_calls: [{ id: 'call-lead' }] });
  f.message('other-session', { message_id: 'other', tool_call_id: 'call-other' });
  f.monitor.record(record('gateway-generated', ['call-lead']));
  f.monitor.record(record('other-gateway', ['call-other']));
  const first = f.monitor.snapshot(), coalesced = f.monitor.snapshot();
  const snapshot = publicSnapshot(await first);
  assert.deepEqual(await coalesced, await first);
  assert.equal(snapshot.sessionStatus, 'ready');
  assert.equal(snapshot.records.find(r => r.id === 'gateway-generated').sessionId, 'lead-session');
  assert.equal(snapshot.records.find(r => r.id === 'other-gateway').sessionId, 'other-session');
  const session = { sessionId: 'lead-session', lead: { used: 100, size: 1000 }, subagents: [] };
  const details = contextDetails(session, snapshot);
  const values = Object.fromEntries(details.request.map(r => [r.key, r.value]));
  assert.equal(values.request, 'synthetic-model · 成功');
  assert.equal(values.durationMs, '1.1 s'); assert.equal(values.firstResponseMs, '0.1 s');
  assert.equal(values.gatewayTps, '20'); assert.equal(values.inputTokens, '100');
  assert.equal(values.cachedTokens, '80'); assert.equal(values.reasoningTokens, '0');
  assert.equal(values.tps, '—', 'tool-bearing output is not claimed as plain text decoding speed');
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(snapshot).includes('call-lead'), false);
  const checksum = fs.readFileSync(f.databasePath);
  await createMonitor({ root: f.root, databasePath: f.databasePath }).snapshot();
  assert.deepEqual(fs.readFileSync(f.databasePath), checksum, 'read-only lookup does not rewrite the live database');
});

test('exact response IDs win; shared tools and repeated history never borrow another session', async t => {
  const f = fixture(t);
  f.message('a', { message_id: 'response-exact', tool_calls: [{ id: 'shared' }] });
  f.message('b', { message_id: 'history', tool_calls: [{ id: 'shared' }] });
  f.monitor.record(record('response-exact', ['shared']));
  f.monitor.record({ ...record('response-ambiguous', ['shared']), messageIds: ['response-exact'] });
  f.monitor.record({ ...record('response-unknown'), messageIds: ['response-exact'] });
  const snapshot = await f.monitor.snapshot();
  assert.equal(snapshot.records.find(r => r.id === 'response-exact').sessionId, 'a');
  assert.equal(snapshot.records.find(r => r.id === 'response-ambiguous').attribution, 'ambiguous');
  assert.equal(snapshot.records.find(r => r.id === 'response-unknown').attribution, 'unassigned');
});

test('bound JSON identities tolerate quotes, invalid message JSON and a missing legacy tool table', async t => {
  const f = fixture(t);
  const identity = "response'); DROP TABLE message_nodes; --";
  f.message('a', { message_id: identity });
  f.message('irrelevant', { message_id: 'unused', tool_calls: ['not-an-object', null, 3] });
  f.message('irrelevant', { message_id: 'unused-2', tool_calls: 'not-an-array' });
  f.db.prepare('INSERT INTO message_nodes VALUES (?, ?)').run('bad', '{PRIVATE invalid');
  f.monitor.record(record(identity));
  const result = await f.monitor.snapshot();
  assert.equal(result.sessionStatus, 'ready'); assert.equal(result.records[0].sessionId, 'a');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM message_nodes').get().n, 4);
});

test('unreadable schema is explicit and cannot expose unrelated aggregate metrics', async t => {
  const f = fixture(t);
  f.db.exec('DROP TABLE message_nodes');
  f.monitor.record(record('unmatched'));
  const snapshot = await f.monitor.snapshot();
  assert.equal(snapshot.status, 'degraded'); assert.equal(snapshot.sessionStatus, 'unavailable');
  const details = contextDetails({ sessionId: 'a' }, publicSnapshot(snapshot));
  assert.equal(details.request[0].value, '会话请求归属暂不可用');
  assert.equal(details.request.find(r => r.key === 'inputTokens').value, '—');
});

test('statusbar updates as soon as the asynchronous request snapshot arrives', async t => {
  const f = fixture(t);
  f.message('a', { message_id: 'response' }); f.monitor.record(record('response'));
  const item = { show() {}, hide() {}, dispose() {} };
  let reads = 0;
  const ui = createContextUi({ vscode: { window: { createStatusBarItem: () => item }, commands: { registerCommand: () => ({ dispose() {} }) } },
    context: { subscriptions: [] }, snapshot: () => [{ sessionId: 'a', subagents: [] }], catalog: () => ({}),
    readMonitor: async () => { reads++; return { snapshot: publicSnapshot(await f.monitor.snapshot()) }; } });
  t.after(() => ui.dispose());
  for (let i = 0; i < 100 && !item.tooltip.includes('synthetic-model'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(item.tooltip, /最近请求：synthetic-model · 成功/); assert.equal(reads, 1);
});
