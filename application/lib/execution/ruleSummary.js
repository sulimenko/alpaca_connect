({ orders }) => {
  const quantity = { fractional: orders.some((row) => row.quantity.fractional) };
  for (const name of ['minimum', 'step', 'maximum', 'minimumNotional']) {
    const first = orders[0].quantity[name];
    quantity[name] = orders.every((row) => JSON.stringify(row.quantity[name]) === JSON.stringify(first)) ? first : null;
  }
  return quantity;
};
