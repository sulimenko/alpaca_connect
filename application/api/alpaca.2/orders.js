({
  access: 'public',
  method: async ({ keys, status, limit }) => {
    const alpaca = await domain.clients.alpaca.get({ keys });
    const responce = lib.utils.makeResult('orders', { orders: [] });

    status = status && ['all', 'closed', 'open'].includes(status) ? status : 'open';
    limit = limit && typeof limit === 'number' ? limit : 20;

    responce.data.orders = await alpaca.getOrders({ status, limit });
    return responce;
  },
});
