({
  access: 'public',
  method: async ({ token, wallet, symbol, amount }) => {
    // console.log(token, wallet, symbol, amount);
    return lib.alpaca.transfer({ token, wallet, symbol, amount });
  },
});
