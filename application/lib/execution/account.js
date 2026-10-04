async ({ account, live, credentials }) => {
  const base = live ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
  const headers = {
    'Content-Type': 'application/json',
    'APCA-API-KEY-ID': credentials.pkey,
    'APCA-API-SECRET-KEY': credentials.secret,
  };
  const response = await lib.execution.request({ url: base + '/v2/account', headers });
  const row = response.body;
  const matched =
    response.status === 200 &&
    row &&
    !Array.isArray(row) &&
    [row.account_number, row.id].some((value) => typeof value === 'string' && value === account);
  return { matched, base, headers };
};
