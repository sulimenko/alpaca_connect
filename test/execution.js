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
    configuration: {
      suspend_trade: false,
      fractional_trading: true,
      no_shorting: false,
      max_margin_multiplier: '2',
      disable_overnight_trading: false,
    },
    configurationStatus: 200,
    asset: {
      class: 'us_equity',
      symbol: 'AAPL',
      exchange: 'NASDAQ',
      status: 'active',
      tradable: true,
      fractionable: true,
      marginable: true,
      shortable: true,
      easy_to_borrow: true,
      attributes: ['fractional_eh_enabled', 'overnight_tradable'],
    },
    assetStatus: 200,
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
      body = typeof state.account === 'function' ? state.account(url) : state.account;
    } else if (url.endsWith('/v2/account/configurations')) {
      status = state.configurationStatus;
      body = state.configuration;
    } else if (url.endsWith('/v2/assets/AAPL')) {
      status = state.assetStatus;
      body = state.asset;
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
  for (const name of [
    'request',
    'account',
    'normalize',
    'broker',
    'marketData',
    'handle',
    'decimal',
    'rulesAccount',
    'rules',
    'ruleMatrix',
    'ruleSummary',
    'validateRule',
  ]) {
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
  for (const action of ['submit', 'lookup', 'marketdata', 'capabilities', 'rules']) {
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

test('extended limit DAY/GTC keeps native TIF and one POST across parallel, repeat and conflicting submits', async () => {
  for (const tif of ['day', 'gtc']) {
    const h = harness();
    const data = input();
    data.intent = { ...data.intent, type: 'limit', tif, extended: true, limitPrice: 10 };
    const [first, parallel] = await Promise.all([h.invoke('submit', data), h.invoke('submit', data)]);
    assert.equal(first.state, 'acknowledged');
    assert.ok(['acknowledged', 'ambiguous'].includes(parallel.state));
    assert.deepEqual(plain(await h.invoke('submit', data)), plain(first));
    assert.equal(h.proofs().length, 3);
    assert.equal(h.posts().length, 1);
    assert.deepEqual(JSON.parse(h.posts()[0].options.body), {
      symbol: 'AAPL',
      qty: '2',
      side: 'buy',
      type: 'limit',
      time_in_force: tif,
      client_order_id: 'meta-17',
      extended_hours: true,
      limit_price: '10',
    });
    for (const patch of [{ tif: tif === 'day' ? 'gtc' : 'day' }, { extended: false }, { tif: 'ioc' }, { quantity: 3 }]) {
      assert.equal((await h.invoke('submit', { ...data, intent: { ...data.intent, ...patch } })).state, 'ambiguous');
    }
    assert.equal(h.proofs().length, 7);
    assert.equal(h.posts().length, 1);
  }
});

test('extended market/stop/stop_limit and limit IOC/FOK reject before native POST', async () => {
  for (const type of ['market', 'limit', 'stop', 'stop_limit']) {
    for (const tif of ['day', 'gtc', 'ioc', 'fok']) {
      if (type === 'limit' && ['day', 'gtc'].includes(tif)) continue;
      const h = harness();
      const data = input();
      data.intent = { ...data.intent, type, tif, extended: true, limitPrice: 10, stopPrice: 9 };
      assert.equal((await h.invoke('submit', data)).state, 'rejected', type + '/' + tif);
      assert.equal(h.proofs().length, 1);
      assert.equal(h.posts().length, 0);
    }
  }
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

test('successful lookup replaces cached rejection with broker evidence without another POST', async () => {
  for (const initial of [
    { status: 422, body: { code: 42210000, message: 'insufficient buying power' } },
    { status: 200, body: nativeOrder({ status: 'rejected' }) },
  ]) {
    for (const status of ['new', 'partially_filled', 'filled', 'canceled', 'expired', 'rejected']) {
      const h = harness();
      const data = input();
      h.state.orderStatus = initial.status;
      h.state.order = initial.body;
      assert.equal((await h.invoke('submit', data)).state, 'rejected');
      h.state.orderStatus = 200;
      h.state.order = nativeOrder({ status, filled_qty: { filled: '2', partially_filled: '1' }[status] || '0' });
      const recovered = await h.invoke('lookup', data);
      assert.equal(recovered.state, 'found');
      const proofCount = h.proofs().length;
      const replay = await h.invoke('submit', data);
      assert.equal(replay.state, ['canceled', 'expired', 'rejected'].includes(status) ? 'ambiguous' : 'acknowledged');
      assert.deepEqual(plain(replay.broker), plain(recovered.broker));
      assert.equal(h.proofs().length, proofCount + 1, 'recovered cached outcome still requires fresh account proof');
      const evidence = plain(h.globals.domain.execution.attempts.get(data));
      assert.equal((await h.invoke('submit', { ...data, brokerId: 'OTHER' })).state, 'ambiguous');
      assert.equal((await h.invoke('submit', { ...data, intent: null })).state, 'ambiguous');
      h.state.failAccount = true;
      assert.equal((await h.invoke('submit', data)).state, 'source_unavailable');
      h.state.failAccount = false;
      h.state.order = nativeOrder({ filled_qty: null });
      assert.equal((await h.invoke('lookup', data)).state, 'source_unavailable');
      assert.deepEqual(plain(h.globals.domain.execution.attempts.get(data)), evidence, 'failed calls preserve recovered evidence');
      assert.deepEqual(plain(await h.invoke('submit', data)), plain(replay));
      assert.equal(h.posts().length, 1, 'native recovery never permits another POST');
    }
  }
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
    const evidence = plain(h.globals.domain.execution.attempts.get(input()));
    release.resolve();
    const outcome = await pending;
    assert.equal(outcome.state, late === 'acknowledged' ? 'acknowledged' : 'ambiguous', late);
    assert.equal(h.globals.domain.execution.attempts.get(input()).brokerId, 'B-1', 'late response cannot erase identity');
    assert.deepEqual(plain(h.globals.domain.execution.attempts.get(input())), evidence, 'late POST cannot overwrite lookup evidence');
    h.state.order = nativeOrder({ id: 'B-other' });
    assert.equal((await h.invoke('lookup', input())).state, 'source_unavailable', 'unpinned lookup still honors observed id');
    const replay = await h.invoke('submit', input());
    assert.equal(replay.state, 'acknowledged');
    assert.deepEqual(plain(replay.broker), { terminal_id: 'B-1', state: 'filled' });
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

const rulesInput = () => ({
  version: 1,
  account: 'EXT-1',
  live: false,
  credentials: input().credentials,
  instrument: { symbol: 'AAPL', assetCategory: 'STK', exchange: 'NASDAQ', currency: 'USD' },
});
const activeAccount = () => ({
  account_number: 'EXT-1',
  id: 'native-account',
  status: 'ACTIVE',
  account_blocked: false,
  trading_blocked: false,
  trade_suspended_by_user: false,
  shorting_enabled: true,
  multiplier: '2',
  equity: '2000',
});
const rulesHarness = () => {
  const h = harness();
  h.state.account = activeAccount();
  return h;
};
const unavailable = (result) => {
  assert.ok(['unavailable', 'unsupported'].includes(result.state));
  assert.deepEqual(Object.keys(result).sort(), ['reason', 'state', 'version']);
  assert.equal(result.version, 1);
  assert.equal(JSON.stringify(result).includes('sentinel-'), false);
};

test('rules v1 bypasses generic v2 validation, sanitizes all failures and never places orders', async () => {
  const h = rulesHarness();
  h.globals.lib.execution.handle = () => assert.fail('v1 must bypass v2/orderId handling');
  const result = await h.invoke('rules', rulesInput());
  assert.equal(result.state, 'ready');
  assert.equal(result.version, 1);
  assert.deepEqual(plain(result.identity), { terminal: 'ALPACA', externalAccount: 'EXT-1', live: false });
  assert.deepEqual(plain(result.instrument), rulesInput().instrument);
  assert.deepEqual(
    h.calls.map((call) => new URL(call.url).pathname),
    ['/v2/account', '/v2/account/configurations', '/v2/assets/AAPL'],
  );
  assert.ok(h.calls.every((call) => call.options.method === 'GET' && new URL(call.url).host === 'paper-api.alpaca.markets'));
  for (const patch of [
    { version: 2 },
    { live: 'false' },
    { account: 'EXT-1 ' },
    { account: { secret: 'sentinel-private-secret' } },
    { credentials: null },
    { credentials: [] },
    { credentials: { pkey: 'key\n', secret: 'secret' } },
    { instrument: null },
    { instrument: { ...rulesInput().instrument, symbol: '../AAPL' } },
  ]) {
    const count = h.calls.length;
    unavailable(await h.invoke('rules', { ...rulesInput(), ...patch }));
    assert.equal(h.calls.length, count);
  }
  for (const data of [null, [], false, 'sentinel-private-secret']) unavailable(await h.invoke('rules', data));
  for (const patch of [{ assetCategory: 'OPT' }, { assetCategory: 'us_option' }, { currency: 'EUR' }, { exchange: 'OTC' }]) {
    const count = h.calls.length;
    unavailable(await h.invoke('rules', { ...rulesInput(), instrument: { ...rulesInput().instrument, ...patch } }));
    assert.equal(h.calls.length, count);
  }
  h.globals.lib.execution.rules = () => {
    throw new Error('sentinel-private-secret');
  };
  assert.deepEqual(plain(await h.invoke('rules', rulesInput())), { version: 1, state: 'unavailable', reason: 'source_unavailable' });
  assert.equal(h.posts().length, 0);
  assert.equal(h.logs.length, 0);
});

test('rules account proof requires exact identity, environment, ACTIVE and explicit nonblocking flags', async () => {
  for (const patch of [
    { account_number: 'OTHER', id: 'OTHER' },
    ...[undefined, null, {}, '', 'active', 'ONBOARDING', 'APPROVAL_PENDING', 'ACCOUNT_UPDATED', 'SUSPENDED', 'CLOSED'].map((status) => ({
      status,
    })),
    ...['account_blocked', 'trading_blocked', 'trade_suspended_by_user'].flatMap((name) =>
      [true, undefined, null, 0, 'false'].map((value) => ({ [name]: value })),
    ),
  ]) {
    const h = rulesHarness();
    h.state.account = { ...activeAccount(), ...patch };
    unavailable(await h.invoke('rules', rulesInput()));
    assert.equal(h.calls.length, 1, 'bad native account stops before configuration/asset use');
  }
  for (const row of [null, [], 'ACTIVE']) {
    const h = rulesHarness();
    h.state.account = row;
    unavailable(await h.invoke('rules', rulesInput()));
  }
  for (const failure of ['failAccount', 'badJSON']) {
    const h = rulesHarness();
    h.state[failure] = true;
    unavailable(await h.invoke('rules', rulesInput()));
    assert.equal(h.calls.length, 1);
  }
  const h = rulesHarness();
  h.state.account = (url) =>
    new URL(url).host === 'paper-api.alpaca.markets' ? activeAccount() : { ...activeAccount(), account_number: 'LIVE-1', id: 'LIVE-ID' };
  assert.equal((await h.invoke('rules', rulesInput())).state, 'ready');
  unavailable(await h.invoke('rules', { ...rulesInput(), live: true }));
  assert.equal((await h.invoke('rules', { ...rulesInput(), account: 'native-account' })).state, 'ready');
});

test('malformed configuration never grants rules and optional unknown proof closes only affected capabilities', async () => {
  for (const configuration of [
    null,
    [],
    {},
    { suspend_trade: true },
    { suspend_trade: 'false' },
    ...['fractional_trading', 'no_shorting', 'disable_overnight_trading', 'ptp_no_exception_entry'].map((name) => ({
      suspend_trade: false,
      [name]: null,
    })),
    { suspend_trade: false, max_margin_multiplier: 2 },
    { suspend_trade: false, max_margin_multiplier: '3' },
  ]) {
    const h = rulesHarness();
    h.state.configuration = configuration;
    unavailable(await h.invoke('rules', rulesInput()));
    assert.equal(h.calls.length, 2);
  }
  const h = rulesHarness();
  h.state.configurationStatus = 503;
  unavailable(await h.invoke('rules', rulesInput()));
  h.state.configurationStatus = 200;
  h.state.configuration = { suspend_trade: false };
  const result = await h.invoke('rules', rulesInput());
  assert.equal(result.state, 'ready');
  assert.ok(
    result.orders.every(
      (row) => !row.quantity.fractional && !row.sessions.includes('overnight') && !(row.side === 'sell' && row.positionEffect === 'open'),
    ),
  );
});

test('rules assets require exact active/tradable class/symbol/exchange and explicit valid attributes', async () => {
  for (const patch of [
    { class: 'us_option' },
    { class: undefined },
    { symbol: 'aapl' },
    { symbol: 'OTHER' },
    { exchange: 'NYSE' },
    { exchange: 'OTC' },
    { status: 'inactive' },
    { status: 'ACTIVE' },
    { tradable: false },
    { tradable: 'true' },
    ...[undefined, null, {}, '', [null], [true], [{}], [''], ['overnight_tradable', 'overnight_tradable'], ['unknown_restriction']].map(
      (attributes) => ({ attributes }),
    ),
  ]) {
    const h = rulesHarness();
    h.state.asset = { ...h.state.asset, ...patch };
    unavailable(await h.invoke('rules', rulesInput()));
    assert.equal(h.posts().length, 0);
  }
  for (const attribute of ['ipo', 'ptp_no_exception', 'ptp_with_exception']) {
    for (const permission of [undefined, false, true]) {
      const h = rulesHarness();
      h.state.asset.attributes = [attribute];
      if (permission !== undefined) h.state.configuration.ptp_no_exception_entry = permission;
      unavailable(await h.invoke('rules', rulesInput()));
    }
  }
  for (const asset of [null, [], 'AAPL']) {
    const h = rulesHarness();
    h.state.asset = asset;
    unavailable(await h.invoke('rules', rulesInput()));
  }
  const h = rulesHarness();
  h.state.assetStatus = 404;
  unavailable(await h.invoke('rules', rulesInput()));
});

test('one maximal canonical scope per capability preserves whole TIF and fractional DAY/close-long support', async () => {
  const h = rulesHarness();
  const result = plain(await h.invoke('rules', rulesInput()));
  assert.equal(result.state, 'ready');
  const whole = result.orders.filter((row) => !row.quantity.fractional);
  assert.equal(whole.length, 48);
  assert.equal(result.orders.length, 56);
  for (const type of ['market', 'limit', 'stop', 'stop_limit']) {
    const tifs = ['market', 'limit'].includes(type) ? ['day', 'gtc', 'ioc', 'fok'] : ['day', 'gtc'];
    for (const tif of tifs) {
      for (const side of ['buy', 'sell']) {
        for (const positionEffect of ['open', 'close']) {
          assert.ok(
            whole.some((row) => row.type === type && row.tif === tif && row.side === side && row.positionEffect === positionEffect),
          );
        }
      }
    }
  }
  const keys = ['type', 'tif', 'relation', 'orderClass', 'quantityMode', 'side', 'positionEffect'];
  assert.equal(new Set(result.orders.map((row) => JSON.stringify(keys.map((key) => row[key])))).size, result.orders.length);
  for (const row of result.orders) {
    assert.deepEqual(Object.keys(row).sort(), [...keys, 'sessions', 'quantity'].sort());
    assert.equal(row.relation, 'NORMAL');
    assert.equal(row.orderClass, 'simple');
    assert.equal(row.quantityMode, row.quantity.fractional ? 'fractional' : 'whole');
    assert.deepEqual(
      row.sessions,
      row.type === 'limit' && ['day', 'gtc'].includes(row.tif) ? ['regular', 'pre_market', 'post_market', 'overnight'] : ['regular'],
    );
    assert.equal(row.quantity.maximum, 'infinity');
    assert.deepEqual(row.quantity.minimumNotional, row.side === 'buy' ? { amount: '1', currency: 'USD' } : null);
    assert.equal(row.quantity.minimum, row.quantity.fractional ? '0.000000001' : '1');
    assert.equal(row.quantity.step, row.quantity.minimum);
    if (row.quantity.fractional) {
      assert.equal(row.tif, 'day');
      if (row.side === 'sell') assert.equal(row.positionEffect, 'close');
    }
    if (row.sessions.length > 1) {
      assert.equal(row.type, 'limit');
      assert.ok(['day', 'gtc'].includes(row.tif));
    }
    if (['ioc', 'fok'].includes(row.tif)) {
      assert.equal(row.quantity.fractional, false);
      assert.deepEqual(row.sessions, ['regular']);
      assert.ok(['market', 'limit'].includes(row.type));
    }
  }
  assert.deepEqual(result.quantity, { fractional: true, minimum: null, step: null, maximum: 'infinity', minimumNotional: null });
  assert.equal(h.posts().length, 0);
});

test('fractional disabled/unknown proof yields whole summary; generic extended evidence never proves overnight', async () => {
  for (const [target, field] of [
    ['configuration', 'fractional_trading'],
    ['asset', 'fractionable'],
  ]) {
    for (const value of [false, undefined]) {
      const h = rulesHarness();
      if (value === undefined) delete h.state[target][field];
      else h.state[target][field] = value;
      const result = await h.invoke('rules', rulesInput());
      assert.equal(result.state, 'ready');
      assert.ok(result.orders.every((row) => !row.quantity.fractional));
      assert.deepEqual(plain(result.quantity), { fractional: false, minimum: '1', step: '1', maximum: 'infinity', minimumNotional: null });
    }
  }
  for (const value of [true, undefined]) {
    const h = rulesHarness();
    if (value === undefined) delete h.state.configuration.disable_overnight_trading;
    else h.state.configuration.disable_overnight_trading = value;
    const result = await h.invoke('rules', rulesInput());
    assert.ok(result.orders.every((row) => !row.sessions.includes('overnight')));
  }
  for (const attributes of [
    [],
    ['fractional_eh_enabled'],
    ['overnight_tradable', 'overnight_halted'],
    ['fractional_eh_enabled', 'overnight_halted'],
  ]) {
    const h = rulesHarness();
    h.state.asset.attributes = attributes;
    h.state.asset.extended_hours = true;
    const result = await h.invoke('rules', rulesInput());
    assert.ok(result.orders.every((row) => !row.sessions.includes('overnight')));
    assert.ok(result.orders.some((row) => row.sessions.includes('pre_market')));
    assert.ok(result.orders.some((row) => row.sessions.includes('post_market')));
    if (!attributes.includes('fractional_eh_enabled')) {
      assert.ok(result.orders.every((row) => row.sessions.length === 1 || !row.quantity.fractional));
    }
  }
  for (const patch of [
    { overnight_tradable: false },
    { overnight_tradable: 'true' },
    { overnight_halted: true },
    { overnight_halted: null },
  ]) {
    const h = rulesHarness();
    Object.assign(h.state.asset, patch);
    assert.ok((await h.invoke('rules', rulesInput())).orders.every((row) => !row.sessions.includes('overnight')));
  }
});

test('limit scope intersects fractional EH and overnight proofs without fractional GTC or regular duplicates', async () => {
  for (const fractionalEH of [false, true]) {
    for (const tradable of [false, true]) {
      for (const disabled of [false, true]) {
        const h = rulesHarness();
        h.state.configuration.disable_overnight_trading = disabled;
        h.state.asset.attributes = [];
        if (fractionalEH) h.state.asset.attributes.push('fractional_eh_enabled');
        if (tradable) h.state.asset.attributes.push('overnight_tradable');
        // Explicit newer fields must agree with the attributes proof.
        h.state.asset.overnight_tradable = tradable;
        h.state.asset.overnight_halted = false;
        const rules = plain(await h.invoke('rules', rulesInput()));
        const extended = ['regular', 'pre_market', 'post_market'];
        if (tradable && !disabled) extended.push('overnight');
        for (const row of rules.orders) {
          const expected = row.type === 'limit' && ['day', 'gtc'].includes(row.tif) && (!row.quantity.fractional || fractionalEH);
          assert.deepEqual(row.sessions, expected ? extended : ['regular']);
          if (row.quantity.fractional) assert.equal(row.tif, 'day');
        }
        assert.equal(rules.orders.length, 56);
        assert.equal(h.posts().length, 0);
      }
    }
  }
});

test('incomplete short/margin/equity/ETB proof never advertises opening short and preserves sell close', async () => {
  const variants = [
    ['account', 'shorting_enabled', [false, undefined, 'true']],
    ['account', 'multiplier', ['1', undefined, '3', 2]],
    ['account', 'equity', [undefined, null, '1999.999999999', '2e3', 2000, '-2000']],
    ['configuration', 'no_shorting', [true, undefined]],
    ['configuration', 'max_margin_multiplier', ['1', undefined]],
    ['asset', 'marginable', [false, undefined]],
    ['asset', 'shortable', [false, undefined]],
    ['asset', 'easy_to_borrow', [false, undefined, 'true']],
  ];
  for (const [target, field, values] of variants) {
    for (const value of values) {
      const h = rulesHarness();
      if (value === undefined) delete h.state[target][field];
      else h.state[target][field] = value;
      const result = await h.invoke('rules', rulesInput());
      assert.equal(result.state, 'ready', target + '.' + field);
      assert.ok(result.orders.every((row) => !(row.side === 'sell' && row.positionEffect === 'open')));
      assert.ok(result.orders.some((row) => row.side === 'sell' && row.positionEffect === 'close'));
    }
  }
  for (const attribute of ['hard_to_borrow', 'locate_required']) {
    const h = rulesHarness();
    h.state.asset.attributes.push(attribute);
    unavailable(await h.invoke('rules', rulesInput()));
  }
});

test('maximum never serializes undocumented metadata, numeric guards or runtime sentinels', async () => {
  for (const maximum of [undefined, null, '1000', '1e9', 100, Number.MAX_SAFE_INTEGER, Infinity, {}, 'infinity']) {
    const h = rulesHarness();
    h.state.asset.max_order_size = maximum;
    h.state.asset.quantity = { maximum, minimum: null, step: null };
    h.state.configuration.max_order_quantity = maximum;
    const result = await h.invoke('rules', rulesInput());
    assert.ok(result.orders.every((row) => row.quantity.maximum === 'infinity'));
    assert.equal(result.quantity.maximum, 'infinity');
    assert.equal(JSON.stringify(result).includes(String(Number.MAX_SAFE_INTEGER)), false);
  }
});

test('summary is uniform-only and concrete validation always selects an exact atomic row', async () => {
  const h = rulesHarness();
  const rules = plain(await h.invoke('rules', rulesInput()));
  const { validateRule, ruleSummary } = h.globals.lib.execution;
  const choose = (side, fractional) =>
    rules.orders.find(
      (row) =>
        row.type === 'limit' &&
        row.tif === 'day' &&
        row.side === side &&
        row.positionEffect === (side === 'sell' ? 'close' : 'open') &&
        row.quantity.fractional === fractional,
    );
  const orderFor = (row, quantity, limitPrice = '1') => ({ ...row, fractional: row.quantity.fractional, quantity, limitPrice });
  assert.equal(validateRule({ rules, order: orderFor(choose('sell', true), '0.000000001') }), true);
  assert.equal(validateRule({ rules, order: orderFor(choose('sell', true), '0.0000000001') }), false);
  assert.equal(validateRule({ rules, order: orderFor(choose('sell', false), '0.5') }), false);
  assert.equal(validateRule({ rules, order: orderFor(choose('buy', true), '0.5'), valuationPrice: '1' }), false);
  assert.equal(validateRule({ rules, order: orderFor(choose('buy', true), '0.5'), valuationPrice: '2' }), true);
  assert.equal(validateRule({ rules, order: orderFor(choose('buy', false), '1'), valuationPrice: '0.99' }), false);
  assert.equal(validateRule({ rules, order: orderFor(choose('buy', false), '1'), valuationPrice: '1' }), true);
  assert.equal(validateRule({ rules, order: orderFor(choose('buy', false), '1') }), false);
  assert.deepEqual(plain(ruleSummary({ orders: rules.orders.filter((row) => row.side === 'buy') })).minimumNotional, {
    amount: '1',
    currency: 'USD',
  });
  assert.equal(ruleSummary({ orders: rules.orders.filter((row) => row.side === 'sell') }).minimumNotional, null);
  const altered = { ...rules, quantity: { fractional: true, minimum: '0', step: '0.0000000001', maximum: '999', minimumNotional: null } };
  assert.equal(validateRule({ rules: altered, order: orderFor(choose('sell', false), '0.5') }), false);
  assert.equal(validateRule({ rules: altered, order: orderFor(choose('buy', true), '0.5'), valuationPrice: '1' }), false);
  for (const patch of [
    { relation: 'BRK' },
    { orderClass: 'oco' },
    { quantityMode: 'notional' },
    { quantityMode: 'qty' },
    { quantityMode: 'whole' },
    { fractional: false },
    { sessions: ['overnight'] },
    { tif: 'opg' },
    { tif: 'cls' },
    { tif: 'gtc', sessions: ['regular', 'pre_market', 'post_market'] },
  ]) {
    assert.equal(validateRule({ rules, order: { ...orderFor(choose('sell', true), '1'), ...patch } }), false);
  }
  const selected = choose('sell', false);
  const capped = { ...rules, orders: [{ ...selected, quantity: { ...selected.quantity, maximum: '2' } }] };
  assert.equal(validateRule({ rules: capped, order: orderFor(selected, '2') }), true);
  assert.equal(validateRule({ rules: capped, order: orderFor(selected, '3') }), false);
  for (const name of ['minimum', 'step', 'fractional']) {
    const broken = { ...rules, orders: [{ ...selected, quantity: { ...selected.quantity, [name]: null } }] };
    assert.equal(validateRule({ rules: broken, order: orderFor(selected, '1') }), false);
  }
  for (const fractional of [false, true]) {
    const row = choose('sell', fractional);
    assert.equal(validateRule({ rules, order: orderFor(row, '1') }), true);
    for (const quantityMode of ['qty', 'notional', null, fractional ? 'whole' : 'fractional']) {
      const inconsistent = { ...row, quantityMode };
      const broken = { ...rules, orders: [inconsistent] };
      assert.equal(validateRule({ rules: broken, order: orderFor(inconsistent, '1') }), false);
    }
  }
});

test('validateRule compares separate canonical arrays by content and rejects malformed, subset and ambiguous scopes', async () => {
  for (const overnight of [false, true]) {
    const h = rulesHarness();
    h.state.configuration.disable_overnight_trading = !overnight;
    const rules = plain(await h.invoke('rules', rulesInput()));
    const { validateRule } = h.globals.lib.execution;
    for (const type of ['market', 'limit']) {
      const row = rules.orders.find(
        (value) =>
          value.type === type &&
          value.tif === 'gtc' &&
          value.side === 'sell' &&
          value.positionEffect === 'close' &&
          !value.quantity.fractional,
      );
      const order = { ...row, sessions: [...row.sessions], fractional: false, quantity: '1', limitPrice: '1' };
      assert.notEqual(order.sessions, row.sessions);
      const original = JSON.stringify({ rules, order });
      assert.equal(validateRule({ rules, order }), true);
      assert.equal(JSON.stringify({ rules, order }), original);
      assert.equal(validateRule({ rules, order: { ...order, fractional: undefined } }), false);
      const malformed = [
        undefined,
        null,
        'regular',
        [],
        ['unknown'],
        ['regular', 'unknown', 'post_market'],
        ['regular', 'pre_market'],
        ['regular', 'pre_market', 'pre_market'],
        ['pre_market', 'regular', 'post_market'],
        ['regular', 'post_market', 'pre_market', 'overnight'],
        ['regular', 'pre_market', 'post_market', 'overnight', 'overnight'],
        new Array(3),
      ];
      for (const sessions of malformed) {
        assert.equal(validateRule({ rules, order: { ...order, sessions } }), false);
        // Matching bad row/order scopes cannot make malformed arrays valid.
        const broken = { ...rules, orders: [{ ...row, sessions }] };
        assert.equal(validateRule({ rules: broken, order: { ...order, sessions } }), false);
      }
      for (const sessions of [
        ['regular'],
        ['regular', 'pre_market', 'post_market'],
        ['regular', 'pre_market', 'post_market', 'overnight'],
      ]) {
        if (sessions.length === row.sessions.length) continue;
        assert.equal(validateRule({ rules, order: { ...order, sessions } }), false);
        // Even different canonical scopes cannot duplicate one capability.
        const ambiguous = { ...rules, orders: [row, { ...row, sessions }] };
        assert.equal(validateRule({ rules: ambiguous, order }), false);
      }
      const duplicate = { ...rules, orders: [row, plain(row)] };
      assert.equal(validateRule({ rules: duplicate, order }), false);
    }
  }
});

test('exact decimal price boundary/tick validation never rounds and refuses numeric/exponent evidence', async () => {
  const h = rulesHarness();
  const rules = plain(await h.invoke('rules', rulesInput()));
  const { decimal, validateRule } = h.globals.lib.execution;
  const row = rules.orders.find(
    (value) => value.type === 'stop_limit' && value.side === 'sell' && value.positionEffect === 'close' && !value.quantity.fractional,
  );
  for (const [price, expected] of [
    ['0.0001', true],
    ['0.9999', true],
    ['1', true],
    ['1.00', true],
    ['1.01', true],
    ['9007199254740993.01', true],
    ['9007199254740993.001', false],
    ['0.00001', false],
    ['0.99999', false],
    ['1.0001', false],
    ['1.001', false],
    ['0', false],
    ['1e0', false],
    [1, false],
  ]) {
    for (const field of ['limitPrice', 'stopPrice']) {
      const order = { ...row, fractional: false, quantity: '1', limitPrice: '1', stopPrice: '1', [field]: price };
      const original = JSON.stringify(order);
      assert.equal(validateRule({ rules, order }), expected, field + '=' + price);
      assert.equal(JSON.stringify(order), original);
    }
  }
  assert.deepEqual(rules.price, {
    rules: [
      { minInclusive: '0', maxExclusive: '1', tick: '0.0001', precision: 4, rounding: 'nearest_half_up' },
      { minInclusive: '1', maxExclusive: null, tick: '0.01', precision: 2, rounding: 'nearest_half_up' },
    ],
  });
  const order = { ...row, fractional: false, quantity: '1', limitPrice: '1', stopPrice: '1' };
  for (const patch of [{ minInclusive: undefined }, { maxExclusive: undefined }, { maxExclusive: 'infinity' }]) {
    const broken = { ...rules, price: { rules: [{ ...rules.price.rules[1], ...patch }] } };
    assert.equal(validateRule({ rules: broken, order }), false);
  }
  const legacy = {
    ...rules,
    price: {
      rounding: 'nearest_half_up',
      rules: [{ minimum: '1', maximum: 'infinity', minimumInclusive: true, maximumInclusive: false, tick: '0.01', precision: 2 }],
    },
  };
  assert.equal(validateRule({ rules: legacy, order }), false);
  const shifted = { ...rules, price: { rules: [{ ...rules.price.rules[0], minInclusive: '0.00005' }] } };
  assert.equal(validateRule({ rules: shifted, order: { ...order, limitPrice: '0.0001', stopPrice: '0.0001' } }), true);
  assert.equal(validateRule({ rules: shifted, order: { ...order, limitPrice: '0.00015', stopPrice: '0.00015' } }), false);
  assert.equal(decimal.parse('0001.23000').canonical, '1.23');
  assert.equal(decimal.compare('9007199254740993', '9007199254740992'), 1);
  assert.equal(decimal.productAtLeast('0.000000001', '999999999.999999999', '1'), false);
  assert.equal(decimal.productAtLeast('0.000000001', '1000000000', '1'), true);
  for (const value of [null, true, '', '1e-9', '-1', 'Infinity', '9'.repeat(257)]) assert.equal(decimal.parse(value), null);
  assert.equal(h.logs.length, 0);
});
