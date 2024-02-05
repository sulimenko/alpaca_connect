/* eslint-disable no-unused-vars */
/* eslint-disable camelcase */
/* eslint-disable no-undef */
({
  access: 'public',
  method: async ({
    keys,
    symbol,
    qty,
    side,
    type,
    tif,
    extended,
    client_order_id,
    limit_price,
    stop_loss,
    stop_price,
    take_profit,
    trail_price,
  }) => {
    const alpaca = await domain.clients.alpaca.get({ keys });
    const responce = lib.utils.makeResult('createOrder', { orders: [] });

    const data = { symbol, qty };
    data.side = side && ['buy', 'sell'].includes(side) ? side : undefined;
    data.type = type && ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'].includes(type) ? type : 'market';
    data.time_in_force = tif && ['day', 'gtc', 'opg', 'ioc'].includes(tif) ? tif : 'day';

    if (extended && extended === true) data.extended_hours = true;
    if (client_order_id) data.client_order_id = String(client_order_id);
    if (limit_price && typeof limit_price === 'number') data.limit_price = limit_price;
    // if (stop_loss && typeof stop_loss === 'number') data.stop_loss = stop_loss;
    // if (stop_price && typeof stop_price === 'number')
    // data.stop_price = stop_price;
    // if (take_profit && typeof take_profit === 'number')
    // data.take_profit = take_profit;
    // if (take_profit && typeof take_profit === 'number')
    // data.trail_price = trail_price;

    console.warn(data);

    responce.data.orders.push(await alpaca.createOrder(data));
    return responce;
  },
});
