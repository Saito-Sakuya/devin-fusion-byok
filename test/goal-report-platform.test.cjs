'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { reportCommandFor, createGoalController } = require('../src/runtime/goal-state.cjs');
const { parseArguments, MAX_REPORT_BYTES } = require('../src/runtime/goal-report.cjs');
const store = require('../src/runtime/goal-store.cjs');
const CLI = path.resolve(__dirname, '../src/runtime/goal-report.cjs');
const TOKEN = 'a'.repeat(64);
const args = ['--store', path.resolve(os.tmpdir(), 'fixture'), '--capability', TOKEN];

test('base64 report transport preserves UTF-8 evidence with the same field and size validation', () => {
  const value = { status: 'review', evidence: '已验证中文、"引号"、\'单引号\'、$(literal) 与 \\ 路径' };
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64');
  const result = parseArguments([...args, '--report-base64', encoded]);
  assert.equal(result.ok, true); assert.equal(result.evidence, value.evidence);
  assert.equal(result.status, 'review');
  assert.equal(parseArguments([...args, JSON.stringify(value), '--report-base64', encoded]).ok, false);
  assert.equal(parseArguments([...args, '--report-base64', encoded, JSON.stringify(value)]).ok, false);
  for (const invalid of ['', 'not base64!', 'eyJ9', Buffer.from([0xff]).toString('base64'),
    Buffer.alloc(MAX_REPORT_BYTES + 1).toString('base64'), Buffer.from('{"status":"progress","evidence":"x","extra":true}').toString('base64')]) {
    assert.equal(parseArguments([...args, '--report-base64', invalid]).ok, false);
  }
});

test('Unix report command retains POSIX escaping and Windows emits a PowerShell command', () => {
  const options = { execPath: '/node path', reportCliPath: '/script', storeRoot: "/store's path", token: TOKEN };
  const posix = reportCommandFor({ ...options, platform: 'linux' });
  assert.match(posix, /^ELECTRON_RUN_AS_NODE=1 '/); assert.ok(posix.includes("'/store'\\''s path'"));
  const powershell = reportCommandFor({ ...options, platform: 'win32' });
  assert.ok(powershell.includes("--store '/store''s path'")); assert.match(powershell, /--report-base64 \$goalReportPayload/);
  assert.match(powershell, /finally.*ELECTRON_RUN_AS_NODE/);
});

const shells = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['/bin/sh'];
for (const shell of shells) {
  const present = spawnSync(shell, shell === '/bin/sh' ? ['-c', 'exit 0'] : ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true }).status === 0;
  test(`generated Goal report runs in ${path.basename(shell)} and completes an isolated controller run`, { skip: !present }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goal report '中文-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let listener, dispatched;
    const controller = createGoalController({ root, reportCliPath: CLI, transport: {
      sessions: () => [{ sessionId: 'synthetic-session', status: 'idle' }], sessionStatus: () => 'idle',
      dispatch: request => { dispatched = request; return { ok: true }; }, cancel: () => ({ ok: true }), setListener: fn => { listener = fn; }
    } });
    t.after(() => controller.dispose());
    controller.start({ sessionId: 'synthetic-session', objective: 'Verify the isolated report fixture', criteria: 'UTF-8 evidence is persisted and completion is acknowledged', maxRuns: 1 });
    await new Promise(resolve => setImmediate(resolve));
    const goal = store.readGoal(root, 'synthetic-session');
    const file = fs.readdirSync(store.capabilitiesDirectory(root)).find(name => JSON.parse(fs.readFileSync(path.join(store.capabilitiesDirectory(root), name), 'utf8')).runId === goal.activeRun);
    const token = file.replace(/\.json$/, '');
    const evidence = '实测报告："双引号"、\'单引号\'、$(不会执行) 与中文保持原样';
    const original = JSON.stringify({ status: 'progress', evidence: '在这里写本次实际运行的证据' });
    // Change only the two user-editable report fields, keeping the capability.
    const command = reportCommandFor({ execPath: process.execPath, reportCliPath: CLI, storeRoot: root, token });
    const encodedJson = JSON.stringify({ status: 'complete', evidence });
    const quote = process.platform === 'win32' ? value => "'" + value.replace(/'/g, "''") + "'" : value => "'" + value.replace(/'/g, "'\\''") + "'";
    const script = command.replace(quote(original), quote(encodedJson));
    const run = spawnSync(shell, shell === '/bin/sh' ? ['-c', script] : ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /"accepted":true/);
    assert.equal(store.readReport(root, goal.activeRun).evidence, evidence);
    const duplicate = spawnSync(shell, shell === '/bin/sh' ? ['-c', script] : ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.notEqual(duplicate.status, 0); assert.match(duplicate.stdout, /"ok":false/);
    assert.equal(store.readReport(root, goal.activeRun).evidence, evidence);
    listener({ type: 'idle', sessionId: 'synthetic-session', runId: dispatched.runId, stopReason: 'end_turn' });
    const completed = controller.snapshot().history.find(item => item.id === goal.id);
    assert.equal(completed.status, 'completed'); assert.equal(completed.evidence.at(-1).evidence, evidence);
    assert.equal(store.readCapability(root, token), null, 'completion invalidates the per-run capability');
  });
}
