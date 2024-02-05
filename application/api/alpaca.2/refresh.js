({
  access: 'public',
  method: async ({ refreshToken }) => {
    return lib.alpaca.tokenRefresh({ token: refreshToken });
  },
});
