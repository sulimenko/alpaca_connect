/* eslint-disable camelcase */
({
  access: 'private',
  method: async ({ oldPassword, newPassword }) => {
    // console.log('RESET PASSWORD test: ', oldPassword, newPassword);
    // console.log('state: ', context.client.session.state);
    const row = await api.auth.provider.getUser(context.client.session.state.login);
    // console.log('hash row: ', row);
    const res = await metarhia.metautil.validatePassword(oldPassword, row.password);
    // console.log('res: ', res);
    if (!res) return { error: true, status: 'error', text: 'Неверный пароль' };
    // console.log('next point');
    api.auth.provider.updatePassword({ user_id: context.client.session.state.user_id, password: newPassword });
    return { error: false, status: 'success', text: 'Пароль изменён' };
  },
});
