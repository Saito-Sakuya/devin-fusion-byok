'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');
const extension = path.resolve(process.env.BYOK_TEST_EXTENSION || path.join(__dirname, '..'));
const { configureBackendProxy } = require(path.join(extension, 'src/runtime/backend.cjs'));
const hostname = 'byok-proxy-fixture.invalid';
const secret = 'fixture-secret-never-log';

async function fixture(t, settings) {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-network-'));
  const root = path.join(user, 'globalStorage', 'fixture');
  fs.mkdirSync(root, { recursive: true });
  const settingsFile = path.join(user, 'settings.json');
  const sockets = new Set();
  const connects = [], forwards = [], originRequests = [], logs = [];
  let restore;
  const origin = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    originRequests.push({ authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.end('Fixture OK.');
  });
  const proxy = http.createServer((req, res) => {
    forwards.push(req.url);
    const outbound = http.request({ host: '127.0.0.1', port: origin.address().port, path: '/', method: req.method, headers: req.headers, agent: false }, response => response.pipe(res));
    outbound.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(outbound);
  });
  proxy.on('connect', (req, socket, head) => {
    connects.push({ target: req.url, authorization: req.headers.authorization });
    const tunnel = net.connect(origin.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) tunnel.write(head);
      socket.pipe(tunnel).pipe(socket);
    });
    sockets.add(tunnel);
    tunnel.on('error', () => socket.destroy());
    socket.on('error', () => tunnel.destroy());
    socket.on('close', () => tunnel.destroy());
  });
  for (const server of [origin, proxy]) {
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
  const directUrl = 'http://127.0.0.1:' + origin.address().port;
  const remoteUrl = 'http://' + hostname + ':' + origin.address().port;
  if (settings !== undefined) fs.writeFileSync(settingsFile, typeof settings === 'function' ? settings(proxyUrl) : settings);
  const before = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
  t.after(async () => {
    restore?.();
    for (const socket of sockets) socket.destroy();
    for (const server of [proxy, origin]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.deepEqual(fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null, before);
    assert.equal(JSON.stringify(logs).includes(secret), false);
    fs.rmSync(user, { recursive: true });
  });
  return { proxyUrl, remoteUrl, directUrl, connects, forwards, originRequests, logs,
    configure(env = {}) { restore = configureBackendProxy(root, (event, data) => logs.push({ event, ...data }), env); } };
}
function viaHttp(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => { let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(body)); });
    request.on('error', reject);
  });
}
const request = url => fetch(url, { signal: AbortSignal.timeout(3000) });

test('JSONC editor proxy routes fetch and native HTTP through the same proxy', async t => {
  const f = await fixture(t, proxy => '{ // Existing editor settings\n "http.proxy": "' + proxy + '", "private": "' + secret + '",\n}');
  f.configure({ http_proxy: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1' });
  const response = await fetch(f.remoteUrl, { method: 'POST', body: 'synthetic', headers: { authorization: 'Bearer ' + secret }, signal: AbortSignal.timeout(3000) });
  assert.equal(await response.text(), 'Fixture OK.');
  assert.equal(await viaHttp(f.remoteUrl), 'Fixture OK.');
  assert.ok(f.connects.some(c => c.target === hostname + ':' + new URL(f.remoteUrl).port));
  assert.equal(f.connects.some(c => c.authorization), false);
  assert.equal(f.originRequests[0].authorization, 'Bearer ' + secret);
  assert.equal(f.originRequests[0].body, 'synthetic');
  assert.ok(f.forwards.some(url => url === f.remoteUrl + '/'));
  assert.equal(f.logs.at(-1).mode, 'settings');
});

test('loopback management and ACP requests bypass the configured proxy', async t => {
  const f = await fixture(t, proxy => JSON.stringify({ 'http.proxy': proxy }));
  f.configure();
  assert.equal(await (await request(f.directUrl)).text(), 'Fixture OK.');
  assert.equal(await viaHttp(f.directUrl), 'Fixture OK.');
  assert.equal(f.connects.length + f.forwards.length, 0);
});

test('explicitly disabled editor proxy bypasses both settings and inherited proxies', async t => {
  const f = await fixture(t, proxy => JSON.stringify({ 'http.proxy': proxy, 'http.proxySupport': 'off' }));
  f.configure({ HTTP_PROXY: f.proxyUrl, HTTPS_PROXY: f.proxyUrl });
  await assert.rejects(request(f.remoteUrl), e => e.cause?.code === 'ENOTFOUND');
  assert.equal(await (await request(f.directUrl)).text(), 'Fixture OK.');
  assert.equal(f.connects.length + f.forwards.length, 0);
  assert.equal(f.logs.at(-1).mode, 'disabled');
});

test('missing editor settings preserve inherited proxy configuration', async t => {
  const f = await fixture(t);
  f.configure({ http_proxy: f.proxyUrl, HTTP_PROXY: 'http://127.0.0.1:1' });
  assert.equal(await (await request(f.remoteUrl)).text(), 'Fixture OK.');
  assert.equal(f.connects.length, 1);
  assert.equal(f.logs.at(-1).mode, 'environment');
});

test('user bypasses remain effective alongside mandatory loopback bypasses', async t => {
  const f = await fixture(t, proxy => JSON.stringify({ 'http.proxy': proxy }));
  f.configure({ NO_PROXY: hostname });
  await assert.rejects(request(f.remoteUrl), e => e.cause?.code === 'ENOTFOUND');
  assert.equal(await (await request(f.directUrl)).text(), 'Fixture OK.');
  assert.equal(f.connects.length + f.forwards.length, 0);
});

test('malformed settings use the environment and emit only a safe settings error', async t => {
  const f = await fixture(t, '{ "private": "' + secret + '"');
  f.configure({ HTTP_PROXY: f.proxyUrl });
  assert.equal(await (await request(f.remoteUrl)).text(), 'Fixture OK.');
  assert.deepEqual(f.logs[0], { event: 'proxy-settings-error', code: 'settings_unreadable' });
  assert.equal(f.logs.at(-1).mode, 'environment');
});
