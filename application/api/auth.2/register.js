({
  access: 'private',
  method: async ({ userId, type = 'ptfin', login, password }) => {
    const hash = await metarhia.metautil.hashPassword(password);
    await api.auth.provider.registerUser({ userId, type, login, hash });
    const token = await context.client.startSession();
    return { status: 'success', token };
  },
});
