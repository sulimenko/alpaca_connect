({
  access: 'public',
  method: async ({ keys, orderId }) => {
    const alpaca = await domain.clients.alpaca.get({ keys });
    const responce = lib.utils.makeResult('cancelOrder', { orders: [] });

    await alpaca.cancelOrder(orderId);
    responce.data.orders.push(await alpaca.getOrder(orderId));
    return responce;
  },
});
