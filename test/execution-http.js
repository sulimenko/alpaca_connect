'use strict';
/* eslint-disable camelcase */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

// Preload runs in the real Impress worker BEFORE metavm captures fetch.
// Only this test's fake broker stores orders. Connector receipts stay in RAM.
// Any unexpected URL is blocked; no real Alpaca transport can occur.
function installFetchFixture() {
  const fixtureFs = require('node:fs');
  const fixturePath = require('node:path');
  const eventFile = fixturePath.join(process.cwd(), 'fixture-events.jsonl');
  const orderFile = fixturePath.join(process.cwd(), 'fixture-broker-orders.json');
  const secret = 'sentinel-private-secret';
  const error = () => new Error(secret + ' sentinel-private-key ' + process.env.BROKER_EXECUTION_TOKEN);
  globalThis.fetch = async (address, options) => {
    const url = new URL(address);
    if (!['api.alpaca.markets', 'paper-api.alpaca.markets', 'data.alpaca.markets'].includes(url.hostname)) {
      fixtureFs.appendFileSync(eventFile, JSON.stringify({ blocked: true }) + '\n');
      throw error();
    }
    const event = { path: url.pathname, host: url.hostname, method: options.method };
    fixtureFs.appendFileSync(eventFile, JSON.stringify(event) + '\n');
    if (options.redirect !== 'error' || !options.signal || options.headers['APCA-API-SECRET-KEY'] !== secret) throw error();
    const key = options.headers['APCA-API-KEY-ID'];
    let body;
    let status = 200;
    if (url.pathname === '/v2/account') {
      if (key === 'sentinel-transport-key') throw error();
      status = key === 'sentinel-revoked-key' ? 401 : 200;
      body = { account_number: key === 'sentinel-wrong-account-key' ? 'OTHER' : 'EXT-1', id: 'native-account', secret };
    } else if (url.pathname === '/v2/orders' && options.method === 'POST') {
      const request = JSON.parse(options.body);
      if (request.symbol === 'REJECT') {
        status = 422;
        body = { code: 42210000, message: 'insufficient buying power ' + secret + ' ' + process.env.BROKER_EXECUTION_TOKEN };
      } else if (request.symbol === 'DUPLICATE') {
        status = 422;
        body = { code: 42210000, message: 'client_order_id must be unique ' + secret };
      } else if (request.symbol === 'HTTPFAIL') {
        status = 503;
        body = { code: 50310000, message: secret };
      } else {
        body = {
          id: 'B-' + request.client_order_id.slice(5),
          client_order_id: request.client_order_id,
          status: request.symbol === 'LOSS' ? 'filled' : 'new',
          qty: request.qty,
          filled_qty: request.symbol === 'LOSS' ? request.qty : '0',
          secret,
          serviceToken: process.env.BROKER_EXECUTION_TOKEN,
        };
        if (request.symbol === 'MALFORMED') body.filled_qty = null;
        if (request.symbol === 'JSONFAIL') {
          return {
            status,
            json: async () => {
              throw error();
            },
          };
        }
        const orders = fixtureFs.existsSync(orderFile) ? JSON.parse(fixtureFs.readFileSync(orderFile, 'utf8')) : {};
        // Simulated remote broker state: never persist credentials/sentinels.
        const { secret: ignoredSecret, serviceToken: ignoredToken, ...order } = body;
        orders[request.client_order_id] = order;
        fixtureFs.writeFileSync(orderFile, JSON.stringify(orders));
        if (request.symbol === 'LOSS') throw error(); // accepted, HTTP response lost
      }
    } else if (url.pathname === '/v2/orders:by_client_order_id') {
      const orders = fixtureFs.existsSync(orderFile) ? JSON.parse(fixtureFs.readFileSync(orderFile, 'utf8')) : {};
      body = orders[url.searchParams.get('client_order_id')];
      if (!body) {
        status = 404;
        body = { message: secret };
      }
    } else if (url.pathname.endsWith('/bars')) {
      body = {
        bars: [
          { c: url.pathname.includes('/MALFORMED/') ? Infinity : 11, h: 12, l: 9, o: 10, t: '2026-10-01T12:00:00Z', n: 2, v: 100, secret },
        ],
        next_page_token: null,
      };
    } else if (url.pathname.endsWith('/snapshots')) {
      body = {
        AAPL: { latestTrade: { p: 11, secret }, prevDailyBar: { c: 10 } },
        MALFORMED: { latestTrade: { p: NaN }, prevDailyBar: { c: 10 } },
      };
    } else {
      fixtureFs.appendFileSync(eventFile, JSON.stringify({ blocked: true }) + '\n');
      throw error();
    }
    return { status, json: async () => body };
  };
}

const collect = (folder) =>
  fs
    .readdirSync(folder, { withFileTypes: true })
    .map((entry) => {
      const filename = path.join(folder, entry.name);
      return entry.isDirectory() ? collect(filename) : fs.readFileSync(filename, 'utf8');
    })
    .join('');

test('real Impress authorized broker paths, full restart recovery and credential isolation', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpaca-execution-http-'));
  const token = 'sentinel-service-bearer-' + 's'.repeat(32);
  const port = await freePort();
  fs.cpSync(path.join(root, 'application'), path.join(directory, 'application'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  fs.copyFileSync(path.join(root, 'server.js'), path.join(directory, 'server.js'));
  const preload = path.join(directory, 'fixture.cjs');
  fs.writeFileSync(preload, '(' + installFetchFixture.toString() + ')();\n');
  let child;
  let exited;
  let output = '';
  const responses = [];
  const events = () => {
    const file = path.join(directory, 'fixture-events.jsonl');
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  };
  const posts = () => events().filter((event) => event.path === '/v2/orders' && event.method === 'POST').length;
  const proofs = () => events().filter((event) => event.path === '/v2/account').length;
  const call = async (action, data, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/execution/${action}`, {
      method: options.method || 'POST',
      signal: AbortSignal.timeout(2000),
      headers: options.headers || {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        'X-Service-Identity': 'metaterminal-execution',
      },
      body: options.method === 'GET' ? undefined : JSON.stringify(data),
    });
    assert.equal(response.ok, true);
    const text = await response.text();
    responses.push(text);
    assert.equal(text.includes('sentinel-'), false, 'HTTP response must not reflect secrets');
    assert.equal(text.includes(token), false, 'HTTP response must not reflect bearer');
    return JSON.parse(text);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 6000);
    await exited;
    clearTimeout(killTimer);
  };
  const start = async () => {
    child = spawn(process.execPath, ['--require', preload, 'server.js'], {
      cwd: directory,
      env: { PATH: process.env.PATH, MODE: 'prod', host: '127.0.0.1', port: String(port), BROKER_EXECUTION_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    exited = once(child, 'exit');
    const started = Date.now();
    while (Date.now() - started < 10000) {
      assert.equal(child.exitCode, null, 'Impress must remain running during readiness');
      try {
        return await call('capabilities', {});
      } catch {
        await wait(50);
      }
    }
    throw new Error('Impress readiness timeout');
  };
  const data = (orderId = 17, symbol = 'AAPL') => ({
    version: 2,
    orderId,
    account: 'EXT-1',
    live: false,
    credentials: { pkey: 'sentinel-private-key', secret: 'sentinel-private-secret' },
    intent: {
      symbol,
      assetCategory: 'STK',
      quantity: 2,
      type: 'market',
      tif: 'day',
      relation: 'NORMAL',
      related: [],
      extended: false,
      limitPrice: null,
      stopPrice: null,
    },
  });
  try {
    assert.deepEqual(await start(), {
      version: 2,
      terminal: 'ALPACA',
      contract: 'meta-alpaca-v2-2',
      submit: true,
      recovery: 'client_order_id',
      restart_safe: true,
      marketdata: true,
    });
    for (const action of ['submit', 'lookup', 'marketdata', 'capabilities']) {
      for (const headers of [
        { 'Content-Type': 'application/json' },
        { Authorization: 'Bearer sentinel-user-token', 'X-Service-Identity': 'metaterminal-execution' },
        { Authorization: 'Bearer sentinel-wrong-service-token', 'X-Service-Identity': 'metaterminal-execution' },
        { Authorization: 'Bearer ' + token, 'X-Service-Identity': 'wrong' },
      ]) {
        assert.equal((await call(action, data(), { headers })).state, 'unauthorized');
      }
      assert.equal((await call(action, {}, { method: 'GET' })).state, 'invalid');
    }
    assert.equal(events().length, 0, 'all auth failures must happen before any broker request');
    assert.equal((await call('submit', data())).state, 'acknowledged');
    assert.equal((await call('lookup', { ...data(), brokerId: 'B-17' })).state, 'found');
    assert.equal((await call('lookup', { ...data(), brokerId: 'OTHER' })).state, 'source_unavailable');
    assert.equal((await call('submit', data(18, 'REJECT'))).state, 'rejected');
    for (const [id, symbol] of [
      [19, 'MALFORMED'],
      [20, 'LOSS'],
      [21, 'DUPLICATE'],
      [22, 'HTTPFAIL'],
      [23, 'JSONFAIL'],
    ]) {
      assert.equal((await call('submit', data(id, symbol))).state, 'ambiguous');
    }
    for (const original of [data(), data(20, 'LOSS')]) {
      const count = posts();
      const proofCount = proofs();
      assert.ok(['acknowledged', 'ambiguous'].includes((await call('submit', original)).state));
      assert.equal(proofs(), proofCount + 1, 'cached submit proves supplied account freshly');
      assert.equal((await call('submit', { ...original, intent: null })).state, 'ambiguous');
      for (const pkey of ['sentinel-revoked-key', 'sentinel-wrong-account-key', 'sentinel-transport-key']) {
        const invalid = { ...original, credentials: { ...original.credentials, pkey } };
        assert.equal((await call('submit', invalid)).state, 'source_unavailable');
        assert.equal((await call('lookup', invalid)).state, 'source_unavailable');
        assert.equal((await call('marketdata', { ...invalid, kind: 'snapshots', symbols: ['AAPL'] })).state, 'source_unavailable');
      }
      assert.equal((await call('submit', { ...original, credentials: null })).state, 'ambiguous');
      assert.equal((await call('submit', { ...original, account: 'OTHER' })).state, 'source_unavailable');
      assert.equal(posts(), count, 'later validation/fetch failure cannot send another POST');
    }
    const bars = await call('marketdata', { ...data(), kind: 'bars', symbol: 'AAPL', limit: 2 });
    assert.equal(bars.state, 'found');
    assert.equal(bars.rows[0].close, 11);
    const prices = await call('marketdata', { ...data(), kind: 'snapshots', symbols: ['AAPL'], live: true });
    assert.equal(prices.state, 'found');
    assert.equal(prices.rows[0].price, '11.00');
    for (const request of [
      { ...data(), kind: 'bars', symbol: 'MALFORMED', limit: 2 },
      { ...data(), kind: 'snapshots', symbols: ['MALFORMED'] },
    ]) {
      assert.equal((await call('marketdata', request)).state, 'source_unavailable');
    }
    for (const action of ['submit', 'lookup', 'marketdata']) {
      const bad = { ...data(), orderId: { secret: 'sentinel-private-secret', token }, account: { secret: 'sentinel-private-key' } };
      assert.equal((await call(action, bad)).orderId, null);
      assert.equal((await call(action, { secret: 'sentinel-private-secret', token })).orderId, null);
    }
    assert.equal((await call('lookup', data(999))).state, 'not_found');
    const count = posts();
    await stop(); // complete process/worker restart, not only a Map reset
    assert.equal((await start()).restart_safe, true);
    const recovered = await call('lookup', { ...data(20, 'LOSS'), brokerId: 'B-20' });
    assert.equal(recovered.state, 'found');
    assert.equal(recovered.broker.state, 'filled');
    assert.equal(posts(), count, 'restart recovery must be GET by deterministic client id');
    assert.ok(events().some((event) => event.host === 'api.alpaca.markets' && event.path === '/v2/account'));
    assert.ok(events().some((event) => event.host === 'paper-api.alpaca.markets' && event.path === '/v2/account'));
    assert.ok(events().every((event) => !event.blocked));
  } finally {
    await stop();
    const logDirectory = path.join(directory, 'log');
    if (fs.existsSync(logDirectory)) output += collect(logDirectory);
    // Fixture evidence contains only request type and non-secret native rows.
    const fixtureLogs = ['fixture-events.jsonl', 'fixture-broker-orders.json']
      .filter((name) => fs.existsSync(path.join(directory, name)))
      .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'))
      .join('');
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(output.includes('sentinel-'), false, 'stdout/stderr/file logs must be credential-safe on success and failure');
    assert.equal(output.includes(token), false, 'service bearer must never enter runtime logs');
    assert.equal(fixtureLogs.includes('sentinel-'), false, 'fake broker audit cannot persist credential sentinels');
    assert.ok(responses.length > 20, 'security verification must traverse actual HTTP responses');
  }
});
