/* eslint-disable camelcase */
({
  access: 'public',
  method: async ({ login, password }) => {
    const user = await api.auth.provider.getUser(login);
    // console.log(login, password, user);
    // if (!user) throw new Error('Incorrect login or password');
    if (!user) return { status: 'unlogged', text: 'Incorrect login or password', token: null };
    if (user.type === 'alpaca') {
      const refreshToken = await api.auth.provider.getRefreshToken(user.login);
      return { status: 'external', text: user.type, refreshToken };
    }
    const { user_id, password: hash } = user;
    const valid = await metarhia.metautil.validatePassword(password, hash);
    // if (!valid) throw new Error('Incorrect login or password');
    // console.log(login, password, user, hash, valid);
    if (!valid) return { status: 'unlogged', text: 'Incorrect login or password', token: null };
    console.log(`Logged user: ${login}`);
    const token = api.auth.provider.generateToken();
    const data = { user_id, login };
    context.client.startSession(token, data);
    const { ip } = context.client;
    await api.auth.provider.createSession(token, data, { ip, login });
    domain.marketData.clients.setClient({
      login: context.client.session.state.login,
      userId: context.client.session.state.user_id,
      client: context.client,
    });
    return { status: 'logged', text: 'Success', token };
  },
});
