async ({ account, live, credentials }) => {
  // Keep the full native row call-local. The v2 account helper is unchanged.
  const base = live ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
  const headers = {
    'Content-Type': 'application/json',
    'APCA-API-KEY-ID': credentials.pkey,
    'APCA-API-SECRET-KEY': credentials.secret,
  };
  const response = await lib.execution.request({ url: base + '/v2/account', headers });
  const row = response.body;
  if (
    response.status !== 200 ||
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    ![row.account_number, row.id].some((value) => typeof value === 'string' && value === account) ||
    row.status !== 'ACTIVE' ||
    !['account_blocked', 'trading_blocked', 'trade_suspended_by_user'].every((name) => row[name] === false)
  ) {
    return null;
  }
  return { base, headers, row };
};
