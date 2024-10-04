({
  access: 'public',
  method: async ({ keys, status, after, until, limit, direction }) => {
    const alpaca = await domain.clients.alpaca.get({ keys });
    const responce = lib.utils.makeResult('orders', { orders: [] });

    const data = {
      status: typeof status !== 'undefined' && status !== null && ['all', 'closed', 'open'].includes(status) ? status : 'open',
      direction: typeof direction === 'string' && ['asc, desc'].includes(direction) ? direction : 'desc',
      limit: typeof limit === 'number' && limit >= 1 && limit <= 50 ? limit : 50,
    };

    if (typeof after !== 'undefined' && after !== null) data.after = new Date(after);
    if (typeof until !== 'undefined' && until !== null) data.until = new Date(until);

    responce.data.orders = await alpaca.getOrders(data);
    return responce;
  },
});
