import { Metacom } from './metacom.js';

class Application {
  constructor() {
    const protocol = location.protocol === 'http:' ? 'ws' : 'wss';
    this.metacom = Metacom.create(`${protocol}://${location.host}/api`);
  }
}

window.addEventListener('load', async () => {
  window.application = new Application();
  window.api = window.application.metacom.api;
  await application.metacom.load('alpaca', 'auth', 'example', 'files');
  const token = localStorage.getItem('metarhia.session.token');
  // console.log(token);
  let logged = false;
  if (token) {
    const res = await api.auth.restore({ token });
    logged = res.status === 'logged';
  }
  if (!logged) {
    const res = await api.auth.signin({ login: 'sulimenko', password: '123' });
    if (res.token) {
      localStorage.setItem('metarhia.session.token', res.token);
    }
  }
});
