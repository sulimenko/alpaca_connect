async ({ account, keyId, secretKey, paper, feed }) => {
  const Alpaca = npm.alpacahqAlpacaTradeApi;
  const client = new Alpaca({
    keyId,
    secretKey,
    paper,
    feed,
  });

  return new Promise((resolve) => {
    client.trade_ws.onConnect(async () => {
      console.log(`Connected acc ${account}`);
      client.trade_ws.subscribe(['trade_updates', 'account_updates']);
      resolve(client);
    });
    client.trade_ws.onStateChange((newState) => {
      console.log(`State acc ${account} changed to ${newState}`);
    });
    client.trade_ws.onOrderUpdate((data) => {
      const event = { account, orders: [] };
      event.orders.push(data.order);
      lib.alpaca.updateStatus(event);
    });
    client.trade_ws.onAccountUpdate((data) => {
      console.log(`Account ${account} updates: ${JSON.stringify(data)}`);
    });
    client.trade_ws.onDisconnect(() => {
      console.log(`Disconnected acc ${account}`);
    });
    client.trade_ws.connect();
  });
};
