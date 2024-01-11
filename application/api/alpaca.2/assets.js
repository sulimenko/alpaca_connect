/* eslint-disable camelcase */
/* eslint-disable no-undef */
({
  access: 'public',
  method: async ({ symbol, status, type }) => {
    // console.info(symbol, status, type);
    const responce = lib.utils.makeResult('assets', { samples: [] });

    if (symbol) {
      responce.data.samples = await domain.marketData.alpacaClient.get({ key: 'main' }).getAsset(symbol);
      return responce;
    }

    status = status !== undefined && ['active', 'inactive'].includes(status) ? status : undefined;
    const asset_class = type !== undefined && ['us_equity', 'crypto'].includes(type) ? type : undefined;
    // console.info(status, asset_class, responce);

    responce.data.samples = await domain.marketData.alpacaClient.get({ key: 'main' }).getAssets({
      status,
      asset_class,
    });

    return responce;
  },
});
