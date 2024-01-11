({
  access: 'public',
  method: async ({ keys }) => {
    const alpaca = await domain.clients.alpaca.get({ keys });
    return alpaca.getAccount();
  },
});
