async ({ token, wallet, symbol, amount }) => {
  const version = 'v1';
  const endpoint = 'transfers';
  const data = {
    symbol,
    amount,
    address: wallet.address,
    chain: wallet.chain,
    asset: wallet.asset === wallet.chain ? 'NATIVE' : wallet.asset,
  };

  return lib.alpaca.sendCabinet({ version, endpoint, token, data });
};
