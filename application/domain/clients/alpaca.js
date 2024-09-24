({
  values: new Map(),
  async set({ keys }) {
    const client = await lib.alpaca.new({
      account: keys.account,
      keyId: keys.pkey,
      secretKey: keys.secret,
      paper: keys.live !== undefined ? !keys.live : true, // true, false
      feed: 'iex', // 'iex', 'sip'});
    });
    return this.values.set(keys.account, client).get(keys.account);
  },
  async get({ keys }) {
    let client = this.values.get(keys.account);
    if (!client) client = await this.set({ keys });
    // console.log('get: ', client);
    return client;
  },
});
