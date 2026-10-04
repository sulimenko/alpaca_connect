/* global node */
/* eslint-disable camelcase */
({
  timeout: 45000,
  // HTTP hook bypasses the ordinary public RPC envelope. It authenticates
  // before examining credentials and never logs args, headers or exceptions.
  async router({ method, args, verb, headers }) {
    if (
      verb !== 'POST' ||
      !['execution/submit', 'execution/lookup', 'execution/marketdata', 'execution/capabilities', 'execution/rules'].includes(method)
    ) {
      return { state: 'invalid' };
    }
    const expected = config.execution.token;
    const provided = headers?.authorization;
    if (
      typeof expected !== 'string' ||
      expected.length < 32 ||
      headers?.['x-service-identity'] !== config.execution.identity ||
      typeof provided !== 'string'
    ) {
      return { state: 'unauthorized' };
    }
    const left = Buffer.from('Bearer ' + expected);
    const right = Buffer.from(provided);
    if (left.length !== right.length || !node.crypto.timingSafeEqual(left, right)) return { state: 'unauthorized' };
    if (method === 'execution/capabilities') {
      return {
        version: 2,
        terminal: 'ALPACA',
        contract: 'meta-alpaca-v2-2',
        submit: true,
        recovery: 'client_order_id',
        restart_safe: true,
        marketdata: true,
      };
    }
    try {
      // Rules has its own v1 schema and never enters v2/orderId validation.
      if (method === 'execution/rules') return await lib.execution.rules({ data: args });
      return await lib.execution.handle({ action: method.split('/')[1], data: args });
    } catch {
      if (method === 'execution/rules') return { version: 1, state: 'unavailable', reason: 'source_unavailable' };
      const orderId = Number.isSafeInteger(args?.orderId) && args.orderId > 0 ? args.orderId : null;
      return { version: 2, orderId, state: 'source_unavailable' };
    }
  },
});
