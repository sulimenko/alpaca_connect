({
  values: new Map(),
  async set({ keys }) {
    const client = await lib.alpaca.new({
      account: keys.name,
      keyId: keys.pkey,
      secretKey: keys.secret,
      paper: keys.live !== undefined ? !keys.live : true, // true, false
      feed: 'iex', // 'iex', 'sip'});
    });
    return this.values.set(keys.name, client).get(keys.name);
  },
  async get({ keys }) {
    let client = this.values.get(keys.name);
    if (!client) client = await this.set({ keys });
    // console.log('get: ', client);
    return client;
  },
});
