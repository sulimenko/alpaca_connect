({
  access: 'public',
  method: async () => {
    const existKeys = domain.clients.alpaca.values.keys();
    console.warn(existKeys);
    return 'in console';
  },
});
