async ({ data }) => {
  const { kind, symbol, symbols, start, end, limit } = data;
  const unavailable = { state: 'source_unavailable' };
  const validSymbol = (value) => typeof value === 'string' && /^[A-Z0-9.]{1,64}$/.test(value);
  const identity = await lib.execution.account(data);
  if (!identity.matched) return unavailable;
  const { headers } = identity;
  if (kind === 'bars') {
    if (!validSymbol(symbol) || !Number.isInteger(limit) || limit < 1 || limit > 10000) return unavailable;
    const query = new URLSearchParams({ timeframe: '1Hour', limit: String(limit), feed: 'iex' });
    for (const [name, value] of [
      ['start', start],
      ['end', end],
    ]) {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return unavailable;
      query.set(name, value);
    }
    if (start !== null && start !== undefined && end !== null && end !== undefined && Date.parse(start) > Date.parse(end)) {
      return unavailable;
    }
    const rows = [];
    const tokens = new Set();
    let token;
    do {
      if (token) query.set('page_token', token);
      query.set('limit', String(limit - rows.length));
      const response = await lib.execution.request({ url: 'https://data.alpaca.markets/v2/stocks/' + symbol + '/bars?' + query, headers });
      if (response.status !== 200 || !Array.isArray(response.body?.bars) || response.body.bars.length > limit - rows.length) {
        return unavailable;
      }
      for (const bar of response.body.bars) {
        if (
          !bar ||
          !['c', 'h', 'l', 'o', 'n', 'v'].every((name) => typeof bar[name] === 'number' && Number.isFinite(bar[name]) && bar[name] >= 0) ||
          !Number.isSafeInteger(bar.n) ||
          typeof bar.t !== 'string' ||
          !Number.isFinite(Date.parse(bar.t)) ||
          bar.h < Math.max(bar.o, bar.c, bar.l) ||
          bar.l > Math.min(bar.o, bar.c, bar.h)
        ) {
          return unavailable;
        }
        rows.push({ close: bar.c, high: bar.h, low: bar.l, open: bar.o, timestamp: Date.parse(bar.t), turnover: bar.n, volume: bar.v });
      }
      const next = response.body.next_page_token;
      if (next !== null && next !== undefined) {
        if (typeof next !== 'string' || next.length === 0 || next.length > 2048 || tokens.has(next) || response.body.bars.length === 0) {
          return unavailable;
        }
        tokens.add(next);
      }
      token = next;
    } while (token && rows.length < limit);
    return { state: 'found', rows: rows.slice(0, limit) };
  }
  if (kind !== 'snapshots' || !Array.isArray(symbols) || !symbols.length || symbols.length > 100 || !symbols.every(validSymbol)) {
    return unavailable;
  }
  const query = new URLSearchParams({ symbols: symbols.join(','), feed: 'iex' });
  const response = await lib.execution.request({ url: 'https://data.alpaca.markets/v2/stocks/snapshots?' + query, headers });
  if (response.status !== 200 || !response.body || typeof response.body !== 'object' || Array.isArray(response.body)) return unavailable;
  const rows = [];
  for (const name of symbols) {
    const row = response.body[name];
    const price = row?.latestTrade?.p;
    const previous = row?.prevDailyBar?.c;
    if (
      typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price <= 0 ||
      typeof previous !== 'number' ||
      !Number.isFinite(previous) ||
      previous <= 0
    ) {
      return unavailable;
    }
    const change = price - previous;
    const changeP = (price / previous - 1) * 100;
    if (!Number.isFinite(change) || !Number.isFinite(changeP)) return unavailable;
    rows.push({
      symbol: name,
      price: price.toFixed(2),
      prevClose: previous.toFixed(2),
      change: change.toFixed(2),
      changeP: changeP.toFixed(2),
    });
  }
  return { state: 'found', rows };
};
