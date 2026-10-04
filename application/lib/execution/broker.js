/* global node */
/* eslint-disable camelcase */
async ({ action, data }) => {
  const { orderId, intent } = data;
  const result = (state, broker = null) => ({ version: 2, orderId, state, broker });
  const clientId = 'meta-' + orderId;
  const pinned = data.brokerId !== null && data.brokerId !== undefined;
  let claim;
  let body;
  if (action === 'submit') {
    const quantity = intent?.quantity;
    const price = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
    const valid =
      intent &&
      !Array.isArray(intent) &&
      ['STK', 'OPT'].includes(intent.assetCategory) &&
      typeof intent.symbol === 'string' &&
      /^[A-Z0-9.]{1,64}$/.test(intent.symbol) &&
      typeof quantity === 'number' &&
      Number.isFinite(quantity) &&
      quantity !== 0 &&
      ['market', 'limit', 'stop', 'stop_limit'].includes(intent.type) &&
      ['day', 'gtc', 'ioc', 'fok'].includes(intent.tif) &&
      intent.relation === 'NORMAL' &&
      Array.isArray(intent.related) &&
      intent.related.length === 0 &&
      typeof intent.extended === 'boolean' &&
      [intent.limitPrice, intent.stopPrice].every((value) => value === null || value === undefined || price(value)) &&
      (!['limit', 'stop_limit'].includes(intent.type) || price(intent.limitPrice)) &&
      (!['stop', 'stop_limit'].includes(intent.type) || price(intent.stopPrice)) &&
      (!intent.extended || (intent.type === 'limit' && intent.tif === 'day'));
    if (valid) {
      body = {
        symbol: intent.symbol,
        qty: String(Math.abs(quantity)),
        side: quantity > 0 ? 'buy' : 'sell',
        type: intent.type,
        time_in_force: intent.tif,
        client_order_id: clientId,
        extended_hours: intent.extended,
      };
      if (['limit', 'stop_limit'].includes(intent.type)) body.limit_price = String(intent.limitPrice);
      if (['stop', 'stop_limit'].includes(intent.type)) body.stop_price = String(intent.stopPrice);
      const fingerprintData = {
        body,
        assetCategory: intent.assetCategory,
        limitPrice: intent.limitPrice ?? null,
        stopPrice: intent.stopPrice ?? null,
      };
      const fingerprint = node.crypto.createHash('sha256').update(JSON.stringify(fingerprintData)).digest('hex');
      // Claim before the first await: concurrent calls cannot both own a POST.
      // No credentials or raw intent are stored in this worker-local guard.
      claim = domain.execution.attempts.claim(data, fingerprint);
    }
  }
  // Fresh proof precedes cached/conflicting/invalid-intent outcomes too.
  const identity = await lib.execution.account(data);
  if (!identity.matched) return result('source_unavailable');
  if (action === 'submit') {
    if (!body) return result(domain.execution.attempts.get(data) ? 'ambiguous' : 'rejected');
    if (claim.conflict) return result('ambiguous');
    if (!claim.owner) {
      if (pinned && data.brokerId !== claim.attempt?.brokerId) return result('ambiguous');
      return claim.attempt?.result || result('ambiguous');
    }
    // A supplied broker identity is already evidence requiring recovery.
    // A concurrent lookup may also have proved placement during account proof.
    if (pinned || claim.attempt.brokerId !== null) return result('ambiguous');
  }
  const { base, headers } = identity;
  const response = await lib.execution.request({
    url: base + '/v2/orders' + (action === 'lookup' ? ':by_client_order_id?client_order_id=' + clientId : ''),
    method: action === 'lookup' ? 'GET' : 'POST',
    headers,
    data: action === 'lookup' ? null : body,
  });
  const broker = lib.execution.normalize({ row: response.body, clientId });
  if (action === 'lookup') {
    const prior = domain.execution.attempts.get(data);
    if (response.status === 404) {
      // Absence after known/possible placement (or a pin) is not no exposure.
      return result(prior || pinned ? 'source_unavailable' : 'not_found');
    }
    if (
      response.status !== 200 ||
      !broker ||
      (pinned && data.brokerId !== broker.terminal_id) ||
      (prior &&
        (prior.account !== data.account || prior.live !== data.live || (prior.brokerId !== null && prior.brokerId !== broker.terminal_id)))
    ) {
      return result('source_unavailable');
    }
    // Successful native recovery also blocks subsequent submit in this worker.
    const observed = domain.execution.attempts.claim(data, null).attempt;
    if (observed) {
      if (observed.brokerId === null) observed.brokerId = broker.terminal_id;
      // Replay must reflect native recovery, never an older cached rejection.
      // A recovered zero-fill terminal row is not a fresh submit rejection.
      const terminal = ['cancelled', 'expired', 'rejected'].includes(broker.state);
      observed.result = result(terminal ? 'ambiguous' : 'acknowledged', broker);
    }
    return result('found', broker);
  }
  let outcome = result('ambiguous', broker);
  if (response.status >= 200 && response.status < 300 && broker) {
    const terminal = ['cancelled', 'expired', 'rejected'].includes(broker.state);
    outcome = result(terminal ? 'rejected' : 'acknowledged', broker);
  } else {
    const row = response.body;
    // Only structured native validation/auth rejections without placement or
    // duplicate-ID evidence prove no placement. Never expose upstream text.
    const definite =
      [400, 401, 403, 422].includes(response.status) &&
      row &&
      typeof row === 'object' &&
      !Array.isArray(row) &&
      Number.isSafeInteger(row.code) &&
      row.code >= 40000000 &&
      row.code < 50000000 &&
      typeof row.message === 'string' &&
      row.message.length > 0 &&
      !/client[ _-]?order[ _-]?id|duplicate|unique/i.test(row.message) &&
      ['id', 'client_order_id', 'status', 'qty', 'filled_qty', 'orders', 'Orders'].every((name) => !Object.hasOwn(row, name));
    if (definite) outcome = result('rejected');
  }
  // A lookup can establish identity while this POST is awaiting a response.
  // Late errors/rejections or conflicting identities cannot erase that proof
  // or turn an observed placement into a fresh no-exposure rejection.
  const observedId = claim.attempt.brokerId;
  if (observedId !== null) {
    if (!broker || broker.terminal_id !== observedId || outcome.state !== 'acknowledged') outcome = result('ambiguous');
    // The lookup completed after this POST began; preserve its newer evidence.
  } else {
    if (broker) claim.attempt.brokerId = broker.terminal_id;
    claim.attempt.result = outcome;
  }
  return outcome;
};
