({
  access: 'public',
  method: async ({ keys, orderId }) => {
    // console.log(keys);
    const alpaca = await domain.clients.alpaca.get({ keys });
    const responce = lib.utils.makeResult('getOrder', { orders: [] });
    responce.data.orders.push(await alpaca.getOrder(orderId));
    return responce;
  },
});
