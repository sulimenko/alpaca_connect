/* eslint-disable no-unused-vars */
/* eslint-disable camelcase */
({
  access: 'public',
  method: async ({ login, password, session }) => {
    const user = await api.auth.provider.getUser(login);
    const { user_id, password: hash } = user;

    lib.alpaca.sessionSave({ login, session });
    const valid = await metarhia.metautil.validatePassword(password, hash);
    // if (!valid) throw new Error('Incorrect login or password');
    if (!valid) {
      api.auth.provider.updatePassword({ user_id, password });
      console.error('Update password: ', login, password);
    }
    console.log('Logged user: ', login);
    const token = api.auth.provider.generateToken();
    const data = { user_id, login };
    context.client.startSession(token, data);
    const { ip } = context.client;
    await api.auth.provider.createSession(token, data, { ip, login, type: 'main' });
    domain.marketData.clients.setClient({
      login: context.client.session.state.login,
      userId: context.client.session.state.user_id,
      client: context.client,
    });
    return { status: 'logged', text: 'Success', token };
  },
});
