({
  access: 'public',
  method: async ({ token }) => {
    const restored = context.client.restoreSession(token);
    // console.log(token, restored, context.client.sessions);
    if (restored) return { status: 'logged' };
    const data = await api.auth.provider.readSession(token);
    if (data) {
      context.client.startSession(token, data);
      // console.log('restore: ', context.client.session.state, JSON.stringify(context));
      domain.marketData.clients.setClient({
        login: context.client.session.state.login,
        userId: context.client.session.state.user_id,
        client: context.client,
      });
      return { status: 'logged' };
    }
    return { status: 'not logged' };
  },
});
