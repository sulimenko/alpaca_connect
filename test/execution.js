'use strict';
/* eslint-disable camelcase */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const load = (name, globals) => vm.runInNewContext(fs.readFileSync(path.join(root, 'application', name), 'utf8'), globals);
const plain = (value) => JSON.parse(JSON.stringify(value));
const input = () => ({
  version: 2,
  orderId: 17,
  account: 'EXT-1',
  live: true,
  credentials: { pkey: 'sentinel-private-key', secret: 'sentinel-private-secret' },
  intent: {
    symbol: 'AAPL',
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
const nativeOrder = (overrides = {}) => ({
  id: 'B-1',
  client_order_id: 'meta-17',
  status: 'new',
  qty: '2',
  filled_qty: '0',
  ...overrides,
});
function harness() {
  const calls = [];
  const logs = [];
  const state = {
    account: { account_number: 'EXT-1', id: 'native-account' },
    accountStatus: 200,
    order: nativeOrder(),
    orderStatus: 200,
    failAccount: false,
    failOrder: false,
    badJSON: false,
    bars: { bars: [{ c: 11, h: 12, l: 9, o: 10, t: '2026-10-01T12:00:00Z', n: 2, v: 100 }], next_page_token: null },
    snapshots: { AAPL: { latestTrade: { p: 11 }, prevDailyBar: { c: 10 } } },
  };
  const globals = {
    node: { crypto },
    Buffer,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    config: { execution: { token: 's'.repeat(32), identity: 'metaterminal-execution' } },
    domain: { execution: {} },
    lib: { execution: {} },
  };
  globals.fetch = async (url, options) => {
    calls.push({ url, options });
    let body;
    let status = 200;
    if (url.endsWith('/v2/account')) {
      if (state.failAccount) throw new Error('sentinel-private-secret account transport');
      const revoked =
        options.headers['APCA-API-KEY-ID'] === 'revoked-key' || options.headers['APCA-API-SECRET-KEY'] !== 'sentinel-private-secret';
      status = revoked ? 401 : state.accountStatus;
      body = state.account;
    } else if (url.includes('/stocks/AAPL/bars')) {
      body = typeof state.bars === 'function' ? state.bars(url) : state.bars;
    } else if (url.includes('/stocks/snapshots')) {
      body = state.snapshots;
    } else if (url.includes('/v2/orders')) {
      if (state.failOrder) throw new Error('sentinel-private-secret order transport');
      if (options.method === 'POST') assert.equal(JSON.parse(options.body).client_order_id, 'meta-17');
      status = state.orderStatus;
      body = state.order;
    } else {
      assert.fail('Unexpected external request');
    }
    return {
      status,
      json: async () => {
        if (state.badJSON) throw new Error('sentinel-private-secret JSON');
        return body;
      },
    };
  };
  globals.domain.execution.attempts = load('domain/execution/attempts.js', globals);
  for (const name of ['request', 'account', 'normalize', 'broker', 'marketData', 'handle']) {
    globals.lib.execution[name] = load('lib/execution/' + name + '.js', globals);
  }
  const hook = load('api/execution.1.js', globals);
  const invoke = (action, data, overrides = {}) =>
    hook.router({
      method: 'execution/' + action,
      verb: 'POST',
      args: data,
      headers: { authorization: 'Bearer ' + 's'.repeat(32), 'x-service-identity': 'metaterminal-execution' },
      ...overrides,
    });
  const posts = () => calls.filter((call) => call.url.includes('/orders') && call.options.method === 'POST');
  const proofs = () => calls.filter((call) => call.url.endsWith('/v2/account'));
  return { invoke, globals, calls, logs, state, posts, proofs };
}

test('exact service authentication and POST capability boundary before broker touch', async () => {
  const h = harness();
  for (const action of ['submit', 'lookup', 'marketdata', 'capabilities']) {
    for (const headers of [
      {},
      { authorization: 'Bearer user-session' },
      { authorization: 'Bearer wrong', 'x-service-identity': 'metaterminal-execution' },
      { authorization: 'Bearer ' + 's'.repeat(32), 'x-service-identity': 'wrong' },
      { authorization: 'bearer ' + 's'.repeat(32), 'x-service-identity': 'metaterminal-execution' },
    ]) {
      assert.equal((await h.invoke(action, input(), { headers })).state, 'unauthorized');
    }
    assert.equal((await h.invoke(action, input(), { verb: 'GET' })).state, 'invalid');
  }
  assert.deepEqual(plain(await h.invoke('capabilities', {})), {
    version: 2,
    terminal: 'ALPACA',
    contract: 'meta-alpaca-v2-2',
    submit: true,
    recovery: 'client_order_id',
    restart_safe: true,
    marketdata: true,
  });
  assert.equal((await h.invoke('unknown', input())).state, 'invalid');
  for (const token of [undefined, '', 'short']) {
    h.globals.config.execution.token = token;
    assert.equal((await h.invoke('submit', input())).state, 'unauthorized');
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.logs.length, 0);
});

test('market/limit/stop/stop_limit map normalized intent and exact account/environment', async () => {
  for (const type of ['market', 'limit', 'stop', 'stop_limit']) {
    const h = harness();
    const data = input();
    data.live = false;
    data.intent = { ...data.intent, type, quantity: -2, limitPrice: 10, stopPrice: 9 };
    assert.equal((await h.invoke('submit', data)).state, 'acknowledged');
    const body = JSON.parse(h.posts()[0].options.body);
    assert.equal(body.side, 'sell');
    assert.equal(body.qty, '2');
    assert.equal(body.type, type);
    assert.equal(body.limit_price, ['limit', 'stop_limit'].includes(type) ? '10' : undefined);
    assert.equal(body.stop_price, ['stop', 'stop_limit'].includes(type) ? '9' : undefined);
    assert.equal(h.proofs()[0].url, 'https://paper-api.alpaca.markets/v2/account');
    assert.equal(h.posts()[0].url, 'https://paper-api.alpaca.markets/v2/orders');
    assert.equal(h.posts()[0].options.redirect, 'error');
  }
  const h = harness();
  assert.equal((await h.invoke('lookup', { ...input(), account: 'native-account' })).state, 'found');
  assert.equal(h.proofs()[0].url, 'https://api.alpaca.markets/v2/account');
  for (const account of ['ext-1', 'EXT', 'EXT-1 ', 'OTHER']) {
    assert.equal((await h.invoke('lookup', { ...input(), account })).state, 'source_unavailable');
  }
});

test('initial invalid intent cannot place an order; account proof precedes authoritative rejection', async () => {
  const h = harness();
  const data = input();
  for (const patch of [
    { relation: 'BRK', related: [{ type: 'stop', quantity: 2 }] },
    { relation: 'OCO' },
    { quantity: 0 },
    { quantity: null },
    { quantity: '2' },
    { quantity: NaN },
    { quantity: Infinity },
    { type: 'unknown' },
    { symbol: '../AAPL' },
    { tif: 'bad' },
    { assetCategory: 'CRYPTO' },
    { related: null },
    { type: 'stop_limit', limitPrice: 10, stopPrice: null },
    { type: 'limit', limitPrice: null },
    { type: 'stop', stopPrice: 0 },
    { extended: true },
    { extended: 'false' },
    { limitPrice: { secret: 'sentinel-private-secret' } },
    { stopPrice: false },
  ]) {
    assert.equal((await h.invoke('submit', { ...data, intent: { ...data.intent, ...patch } })).state, 'rejected');
  }
  assert.equal(h.posts().length, 0);
  assert.equal(h.proofs().length, 19);
  for (const patch of [{ account: '../OTHER' }, { live: 'true' }, { version: 1 }, { credentials: null }]) {
    assert.equal((await h.invoke('submit', { ...data, ...patch })).state, 'rejected');
  }
  assert.equal(h.proofs().length, 19);
});

test('parallel and cached submit always prove account freshly and send at most one POST', async () => {
  const h = harness();
  const data = input();
  const [first, parallel] = await Promise.all([h.invoke('submit', data), h.invoke('submit', data)]);
  assert.equal(first.state, 'acknowledged');
  assert.ok(['acknowledged', 'ambiguous'].includes(parallel.state));
  assert.equal(h.proofs().length, 2);
  assert.equal(h.posts().length, 1);
  assert.deepEqual(plain(await h.invoke('submit', data)), plain(first));
  assert.equal(h.proofs().length, 3);
  assert.equal((await h.invoke('submit', { ...data, intent: { ...data.intent, quantity: 3 } })).state, 'ambiguous');
  assert.equal(h.proofs().length, 4);
  for (const patch of [{ assetCategory: 'OPT' }, { limitPrice: 10 }, { stopPrice: 9 }]) {
    const count = h.proofs().length;
    assert.equal((await h.invoke('submit', { ...data, intent: { ...data.intent, ...patch } })).state, 'ambiguous');
    assert.equal(h.proofs().length, count + 1, 'all normalized intent fields participate in conflict guard');
  }
  assert.equal(h.posts().length, 1);
  const receipt = plain(h.globals.domain.execution.attempts.get(data));
  assert.equal(JSON.stringify(receipt).includes('sentinel-'), false);
  assert.equal(JSON.stringify(receipt).includes('credentials'), false);
});

test('acknowledged or lost response never downgrades on later intent/credential/account/transport failure', async () => {
  for (const lost of [false, true]) {
    const h = harness();
    const data = input();
    h.state.failOrder = lost;
    const first = await h.invoke('submit', data);
    assert.equal(first.state, lost ? 'ambiguous' : 'acknowledged');
    const receipt = plain(h.globals.domain.execution.attempts.get(data));
    h.state.failOrder = false;
    for (const variant of [
      { ...data, intent: null },
      { ...data, intent: { ...data.intent, quantity: 0 } },
      { ...data, intent: { ...data.intent, relation: 'BRK' } },
      { ...data, intent: { ...data.intent, quantity: 3 } },
      { ...data, credentials: null },
      { ...data, credentials: { pkey: '', secret: 'bad' } },
      { ...data, credentials: { pkey: 'revoked-key', secret: 'bad' } },
      { ...data, credentials: { pkey: data.credentials.pkey, secret: 'wrong-secret' } },
      { ...data, credentials: { pkey: data.credentials.pkey, secret: null } },
      { ...data, account: 'OTHER' },
      { ...data, account: '../OTHER' },
      { ...data, live: false },
      { ...data, live: null },
      { ...data, version: 1 },
    ]) {
      const proofCount = h.proofs().length;
      const outcome = await h.invoke('submit', variant);
      assert.ok(['ambiguous', 'source_unavailable'].includes(outcome.state), JSON.stringify(variant.intent));
      if (
        variant.version === 2 &&
        typeof variant.live === 'boolean' &&
        !variant.account.includes('/') &&
        variant.credentials?.pkey &&
        typeof variant.credentials.secret === 'string'
      ) {
        assert.equal(h.proofs().length, proofCount + 1);
      }
      assert.deepEqual(plain(h.globals.domain.execution.attempts.get(data)), receipt, 'later failure cannot overwrite evidence');
    }
    h.state.accountStatus = 403;
    assert.equal((await h.invoke('submit', data)).state, 'source_unavailable');
    h.state.accountStatus = 200;
    h.state.account = { account_number: 'OTHER' };
    assert.equal((await h.invoke('submit', data)).state, 'source_unavailable');
    h.state.failAccount = true;
    assert.equal((await h.invoke('submit', data)).state, 'source_unavailable');
    assert.deepEqual(plain(h.globals.domain.execution.attempts.get(data)), receipt);
    h.state.failAccount = false;
    h.state.account = { account_number: 'EXT-1' };
    const proofCount = h.proofs().length;
    assert.deepEqual(plain(await h.invoke('submit', data)), plain(first));
    assert.equal(h.proofs().length, proofCount + 1);
    assert.equal(h.posts().length, 1);
  }
});

test('definitive native rejection is separate from duplicate, malformed and uncertain response', async () => {
  const variants = [
    [422, { code: 42210000, message: 'insufficient buying power' }, 'rejected'],
    [400, { code: 40010001, message: 'invalid qty' }, 'rejected'],
    [422, { code: 42210000, message: 'client_order_id must be unique' }, 'ambiguous'],
    [422, { code: 42210000, message: 'duplicate ID' }, 'ambiguous'],
    [409, { code: 40910000, message: 'conflict' }, 'ambiguous'],
    [503, { code: 50310000, message: 'unavailable' }, 'ambiguous'],
    [422, { message: 'invalid' }, 'ambiguous'],
    [422, { code: 42210000, message: 'error', ...nativeOrder({ status: 'filled', filled_qty: '2' }) }, 'ambiguous'],
    [200, nativeOrder({ status: 'unknown' }), 'ambiguous'],
    [200, nativeOrder({ filled_qty: null }), 'ambiguous'],
    [200, nativeOrder({ status: 'canceled' }), 'rejected'],
    [200, nativeOrder({ status: 'canceled', filled_qty: '1' }), 'acknowledged'],
  ];
  for (const [status, order, expected] of variants) {
    const h = harness();
    h.state.orderStatus = status;
    h.state.order = order;
    assert.equal((await h.invoke('submit', input())).state, expected);
    await h.invoke('submit', input());
    assert.equal(h.posts().length, 1);
    assert.equal(h.proofs().length, 2);
  }
  const h = harness();
  h.state.badJSON = true;
  assert.equal((await h.invoke('submit', input())).state, 'source_unavailable');
  assert.equal(h.posts().length, 0);
  h.state.badJSON = false;
  h.state.failAccount = true;
  assert.equal((await h.invoke('lookup', input())).state, 'source_unavailable');
});

test('native lookup recovers lost POST after fresh worker, pins brokerId and keeps absence fail closed', async () => {
  const h = harness();
  h.state.failOrder = true;
  assert.equal((await h.invoke('submit', input())).state, 'ambiguous');
  h.state.failOrder = false;
  h.globals.domain.execution.attempts = load('domain/execution/attempts.js', h.globals);
  h.state.order = nativeOrder({ status: 'filled', filled_qty: '2' });
  const found = await h.invoke('lookup', input());
  assert.equal(found.state, 'found');
  assert.equal(found.broker.state, 'filled');
  assert.ok(h.calls.some((call) => call.url.endsWith('/v2/orders:by_client_order_id?client_order_id=meta-17')));
  assert.equal((await h.invoke('lookup', { ...input(), brokerId: 'OTHER' })).state, 'source_unavailable');
  assert.equal((await h.invoke('lookup', { ...input(), brokerId: { secret: 'sentinel-private-secret' } })).state, 'source_unavailable');
  assert.equal((await h.invoke('submit', input())).state, 'ambiguous');
  assert.equal(h.posts().length, 1, 'recovered placement blocks subsequent submit in worker');
  h.state.order = nativeOrder({ id: 'B-2' });
  assert.equal((await h.invoke('lookup', input())).state, 'source_unavailable');
  h.state.orderStatus = 404;
  assert.equal((await h.invoke('lookup', input())).state, 'source_unavailable');
  const fresh = harness();
  fresh.state.orderStatus = 404;
  assert.equal((await fresh.invoke('lookup', input())).state, 'not_found');
  assert.equal((await fresh.invoke('lookup', { ...input(), brokerId: 'B-1' })).state, 'source_unavailable');
  fresh.state.accountStatus = 401;
  assert.equal((await fresh.invoke('lookup', input())).state, 'source_unavailable');
  assert.equal(fresh.calls.filter((call) => call.url.includes('/v2/orders')).length, 2);
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('concurrent lookup proof survives delayed submit transport/rejection/malformed/conflicting evidence', async () => {
  for (const late of ['transport', 'rejection', 'malformed', 'conflict', 'terminal', 'acknowledged']) {
    const h = harness();
    const entered = deferred();
    const release = deferred();
    const nativeFetch = h.globals.fetch;
    h.globals.fetch = async (url, options) => {
      if (url.endsWith('/v2/orders') && options.method === 'POST') {
        h.calls.push({ url, options });
        entered.resolve();
        await release.promise;
        if (late === 'transport') throw new Error('sentinel-private-secret transport');
        const responses = {
          rejection: { status: 422, body: { code: 42210000, message: 'insufficient buying power' } },
          malformed: { status: 200, body: nativeOrder({ filled_qty: null }) },
          conflict: { status: 200, body: nativeOrder({ id: 'B-other' }) },
          terminal: { status: 200, body: nativeOrder({ status: 'rejected' }) },
          acknowledged: { status: 200, body: nativeOrder() },
        };
        const response = responses[late];
        return { status: response.status, json: async () => response.body };
      }
      return nativeFetch(url, options);
    };
    const pending = h.invoke('submit', input());
    await entered.promise;
    h.state.order = nativeOrder({ status: 'filled', filled_qty: '2' });
    assert.equal((await h.invoke('lookup', input())).state, 'found');
    assert.equal(h.globals.domain.execution.attempts.get(input()).brokerId, 'B-1');
    release.resolve();
    const outcome = await pending;
    assert.equal(outcome.state, late === 'acknowledged' ? 'acknowledged' : 'ambiguous', late);
    assert.equal(h.globals.domain.execution.attempts.get(input()).brokerId, 'B-1', 'late response cannot erase identity');
    h.state.order = nativeOrder({ id: 'B-other' });
    assert.equal((await h.invoke('lookup', input())).state, 'source_unavailable', 'unpinned lookup still honors observed id');
    await h.invoke('submit', input());
    assert.equal(h.posts().length, 1, 'late response cannot open a retry');
  }
});

test('lookup proving placement during delayed submit account proof prevents order POST', async () => {
  const h = harness();
  const entered = deferred();
  const release = deferred();
  const nativeFetch = h.globals.fetch;
  let delayed = false;
  h.globals.fetch = async (url, options) => {
    const response = await nativeFetch(url, options);
    if (!delayed && url.endsWith('/v2/account')) {
      delayed = true;
      entered.resolve();
      await release.promise;
    }
    return response;
  };
  const pending = h.invoke('submit', input());
  await entered.promise;
  assert.equal((await h.invoke('lookup', input())).state, 'found');
  release.resolve();
  assert.equal((await pending).state, 'ambiguous');
  assert.equal(h.globals.domain.execution.attempts.get(input()).brokerId, 'B-1');
  assert.equal(h.posts().length, 0, 'fresh lookup proof closes the submit path before side effect');
});

test('Meta durable placement barrier is the sole cross-restart no-resubmit owner when broker permits reuse', async () => {
  // Simulated durable Meta row survives replacing every connector module.
  // The fake broker accepts reused IDs after completion; uniqueness is not a lock.
  const meta = { placementAttempted: false };
  let connector = harness();
  let placements = 0;
  const submitThroughMeta = async () => {
    if (meta.placementAttempted) return connector.invoke('lookup', input());
    meta.placementAttempted = true; // durable commit BEFORE transport
    placements++;
    return connector.invoke('submit', input());
  };
  connector.state.failOrder = true;
  assert.equal((await submitThroughMeta()).state, 'ambiguous');
  connector = harness();
  connector.state.order = nativeOrder({ status: 'filled', filled_qty: '2' });
  assert.equal((await submitThroughMeta()).state, 'found');
  assert.equal(placements, 1);
  assert.equal(connector.posts().length, 0);
  const unsafe = harness(); // bypassing Meta's durable barrier after restart
  assert.equal((await unsafe.invoke('submit', input())).state, 'acknowledged');
  assert.equal(unsafe.posts().length, 1, 'connector RAM/client_order_id cannot promise permanent deduplication');
});

test('every current Alpaca status has explicit exposure-safe mapping or fail-closed policy', async () => {
  const h = harness();
  const states = {
    new: 'pending',
    pending_new: 'pending',
    accepted: 'accepted',
    accepted_for_bidding: 'accepted',
    pending_cancel: 'cancelling',
    pending_replace: 'pending',
    done_for_day: 'pending',
    stopped: 'pending',
    suspended: 'pending',
    held: 'pending',
    calculated: 'pending',
    canceled: 'cancelled',
    expired: 'expired',
    rejected: 'rejected',
    partially_filled: 'part_filled',
    filled: 'filled',
  };
  for (const [status, expected] of Object.entries(states)) {
    h.state.order = nativeOrder({ status, filled_qty: { filled: '2', partially_filled: '1' }[status] || '0' });
    const found = await h.invoke('lookup', input());
    assert.equal(found.state, 'found', status);
    assert.equal(found.broker.state, expected, status);
  }
  for (const order of [
    nativeOrder({ status: 'replaced' }),
    nativeOrder({ status: 'replaced', replaced_by: 'B-2' }),
    nativeOrder({ status: 'unknown' }),
    nativeOrder({ status: 'constructor' }),
    nativeOrder({ status: null }),
    nativeOrder({ status: ['rejected'] }),
    nativeOrder({ status: { state: 'rejected' } }),
    nativeOrder({ client_order_id: 'other' }),
    nativeOrder({ id: { secret: 'sentinel-private-secret' } }),
  ]) {
    h.state.order = order;
    assert.equal((await h.invoke('lookup', input())).state, 'source_unavailable');
  }
});

test('strict qty and filled_qty matrix: malformed evidence never releases exposure', async () => {
  const h = harness();
  for (const status of ['new', 'canceled', 'expired', 'rejected', 'calculated', 'filled', 'partially_filled']) {
    for (const field of ['qty', 'filled_qty']) {
      for (const value of [
        undefined,
        null,
        false,
        true,
        '',
        ' ',
        'NaN',
        'Infinity',
        '1x',
        '0x0',
        '-1',
        -1,
        NaN,
        Infinity,
        {},
        [],
        '1e0',
        '0.00000000000000000000000000000000000000000000000000000000000000001',
      ]) {
        const row = nativeOrder({ status, filled_qty: { filled: '2', partially_filled: '1' }[status] || '0' });
        if (value === undefined) delete row[field];
        else row[field] = value;
        h.state.order = row;
        assert.equal((await h.invoke('lookup', input())).state, 'source_unavailable', status + '/' + field + '/' + String(value));
      }
    }
  }
  const zeroStates = {
    canceled: 'cancelled',
    expired: 'expired',
    rejected: 'rejected',
    calculated: 'pending',
    pending_cancel: 'cancelling',
    new: 'pending',
  };
  for (const [status, zeroState] of Object.entries(zeroStates)) {
    for (const [value, expected] of [
      ['0', zeroState],
      [0, zeroState],
      ['0.000000000000000001', 'part_filled'],
      ['1', 'part_filled'],
      [1, 'part_filled'],
      ['2.00', 'filled'],
      [2, 'filled'],
    ]) {
      h.state.order = nativeOrder({ status, filled_qty: value });
      assert.equal((await h.invoke('lookup', input())).broker.state, expected);
    }
  }
  for (const row of [
    nativeOrder({ qty: '0' }),
    nativeOrder({ qty: 0 }),
    nativeOrder({ filled_qty: '3' }),
    nativeOrder({ status: 'filled', filled_qty: '0' }),
    nativeOrder({ status: 'filled', filled_qty: '1' }),
    nativeOrder({ status: 'partially_filled' }),
    nativeOrder({ status: 'partially_filled', filled_qty: '2' }),
  ]) {
    h.state.order = row;
    assert.equal((await h.invoke('lookup', input())).state, 'source_unavailable');
  }
  h.state.order = nativeOrder({ status: 'canceled', qty: 2, filled_qty: 1 });
  assert.equal((await h.invoke('lookup', input())).broker.state, 'part_filled');
  h.state.order = nativeOrder({ status: 'expired', qty: '1.5', filled_qty: '1.5' });
  assert.equal((await h.invoke('lookup', input())).broker.state, 'filled');
  h.state.order = nativeOrder({ status: 'rejected', qty: '1.000000000000000001', filled_qty: '1' });
  assert.equal((await h.invoke('lookup', input())).broker.state, 'part_filled', 'decimal precision cannot round partial exposure to full');
});

test('protected Meta bars and snapshots use fresh account proof and sanitized finite rows', async () => {
  const h = harness();
  const barsInput = { ...input(), kind: 'bars', symbol: 'AAPL', limit: 2 };
  const bars = await h.invoke('marketdata', barsInput);
  assert.deepEqual(plain(bars), {
    state: 'found',
    rows: [{ close: 11, high: 12, low: 9, open: 10, timestamp: Date.parse('2026-10-01T12:00:00Z'), turnover: 2, volume: 100 }],
  });
  const snapshotsInput = { ...input(), kind: 'snapshots', symbols: ['AAPL'], live: false };
  assert.deepEqual(plain(await h.invoke('marketdata', snapshotsInput)), {
    state: 'found',
    rows: [{ symbol: 'AAPL', price: '11.00', prevClose: '10.00', change: '1.00', changeP: '10.00' }],
  });
  assert.equal(h.proofs().length, 2);
  assert.equal(h.proofs()[1].url, 'https://paper-api.alpaca.markets/v2/account');
  assert.ok(h.calls.filter((call) => call.url.includes('/stocks/')).every((call) => call.url.includes('feed=iex')));
  for (const patch of [
    { symbol: '../AAPL' },
    { limit: 0 },
    { limit: 10001 },
    { start: 'bad' },
    { start: '2026-10-02', end: '2026-10-01' },
  ]) {
    assert.equal((await h.invoke('marketdata', { ...barsInput, ...patch })).state, 'source_unavailable');
  }
  for (const field of ['c', 'h', 'l', 'o', 'n', 'v', 't']) {
    for (const bad of [null, false, '', {}, NaN, Infinity, -1]) {
      const bar = { c: 11, h: 12, l: 9, o: 10, t: '2026-10-01T12:00:00Z', n: 2, v: 100, [field]: bad };
      h.state.bars = { bars: [bar] };
      assert.equal((await h.invoke('marketdata', barsInput)).state, 'source_unavailable');
    }
  }
  for (const body of [null, {}, { bars: [null] }, { bars: [{ c: 11, h: 1, l: 9, o: 10, t: 'bad', n: 2, v: 100 }] }]) {
    h.state.bars = body;
    assert.equal((await h.invoke('marketdata', barsInput)).state, 'source_unavailable');
  }
  for (const bad of [null, false, '', '11', {}, NaN, Infinity, 0, -1]) {
    h.state.snapshots = { AAPL: { latestTrade: { p: bad }, prevDailyBar: { c: 10 } } };
    assert.equal((await h.invoke('marketdata', snapshotsInput)).state, 'source_unavailable');
    h.state.snapshots = { AAPL: { latestTrade: { p: 11 }, prevDailyBar: { c: bad } } };
    assert.equal((await h.invoke('marketdata', snapshotsInput)).state, 'source_unavailable');
  }
  h.state.snapshots = { AAPL: { latestTrade: { p: Number.MAX_VALUE }, prevDailyBar: { c: Number.MIN_VALUE } } };
  assert.equal((await h.invoke('marketdata', snapshotsInput)).state, 'source_unavailable');
  h.state.account = { account_number: 'OTHER' };
  const count = h.calls.filter((call) => call.url.includes('/stocks/')).length;
  assert.equal((await h.invoke('marketdata', barsInput)).state, 'source_unavailable');
  assert.equal(h.calls.filter((call) => call.url.includes('/stocks/')).length, count);
  assert.equal(h.logs.length, 0);
  assert.equal(JSON.stringify(bars).includes('sentinel-'), false);
});

test('bar pagination detects cycles, empty advancing pages, bad tokens and oversize results', async () => {
  const h = harness();
  const data = { ...input(), kind: 'bars', symbol: 'AAPL', limit: 3 };
  const bar = h.state.bars.bars[0];
  h.state.bars = (url) => ({ bars: [bar], next_page_token: new URL(url).searchParams.has('page_token') ? null : 'next' });
  assert.equal((await h.invoke('marketdata', data)).rows.length, 2);
  for (const body of [
    { bars: [], next_page_token: 'next' },
    { bars: [bar], next_page_token: 5 },
    { bars: [bar], next_page_token: '' },
    { bars: [bar], next_page_token: 'next' },
    { bars: [bar, bar, bar, bar], next_page_token: null },
  ]) {
    h.state.bars = body;
    assert.equal((await h.invoke('marketdata', data)).state, 'source_unavailable');
  }
  h.state.bars = (url) => ({ bars: [bar], next_page_token: new URL(url).searchParams.get('page_token') === 'a' ? 'b' : 'a' });
  assert.equal((await h.invoke('marketdata', { ...data, limit: 4 })).state, 'source_unavailable');
});

test('unvalidated identifiers/request objects and raw exceptions are never reflected', async () => {
  const h = harness();
  const sentinel = { secret: 'sentinel-private-secret', token: 's'.repeat(32) };
  for (const action of ['submit', 'lookup', 'marketdata']) {
    for (const data of [
      null,
      [],
      sentinel,
      { ...input(), orderId: sentinel },
      { ...input(), orderId: ['sentinel-private-secret'] },
      { ...input(), orderId: 'sentinel-private-secret' },
      { ...input(), orderId: -1 },
      { ...input(), orderId: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const outcome = await h.invoke(action, data);
      assert.equal(JSON.stringify(outcome).includes('sentinel-'), false);
      assert.equal(JSON.stringify(outcome).includes('s'.repeat(32)), false);
    }
  }
  h.globals.lib.execution.handle = () => {
    throw new Error('sentinel-private-secret');
  };
  assert.deepEqual(plain(await h.invoke('submit', { orderId: sentinel })), { version: 2, orderId: null, state: 'source_unavailable' });
  assert.equal((await h.invoke('submit', input())).orderId, 17);
  assert.equal(h.logs.length, 0);
  assert.equal(
    h.calls.some((call) => /back|ptfin/.test(call.url)),
    false,
  );
});
