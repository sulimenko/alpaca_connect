/* eslint-disable camelcase */
/* eslint-disable no-undef */
({
  access: 'public',
  method: async ({ keys, symbol, status, type }) => {
    // console.info(keys, symbol, status, type);
    const responce = lib.utils.makeResult('assets', { samples: [] });

    if (symbol) {
      responce.data.samples = await domain.clients.alpaca.get({ keys }).getAsset(symbol);
      return responce;
    }

    status = status !== undefined && ['active', 'inactive'].includes(status.toLowerCase()) ? status.toLowerCase() : undefined;
    const asset_class = type !== undefined && ['us_equity', 'crypto'].includes(type.toLowerCase()) ? type.toLowerCase() : undefined;
    // console.info(status, asset_class, responce);

    const client = await domain.clients.alpaca.get({ keys });
    responce.data.samples = await client.getAssets({
      status,
      asset_class,
    });

    return responce;
  },
});
