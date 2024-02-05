async ({ version, endpoint, token, data }) => {
  // console.log(version, endpoint, token, data);
  const url = 'https://wallet.alpaca.markets';

  return metarhia.metautil
    .fetch(url + '/' + version + '/' + endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        'Content-Type': 'application/json',
        Origin: 'https://app.alpaca.markets',
        Referer: 'https://app.alpaca.markets/',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      },
      body: JSON.stringify(data),
    })
    .then((res) => (res.status === 200 ? res.json() : res.text()));
};
