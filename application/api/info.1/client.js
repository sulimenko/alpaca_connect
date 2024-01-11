({
  access: 'public',
  method: async () => {
    const existKeys = domain.marketData.alpacaClient.values.keys();
    console.warn(existKeys);
    return 'in console';
  },
});
