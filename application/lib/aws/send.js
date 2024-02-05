async (data) => {
  const url = 'https://cognito-idp.us-east-1.amazonaws.com/';
  const body = { ClientId: '3tgca6mnp6g138dbkcs7lq7j0a' };
  for (const key of Object.keys(data)) {
    body[key] = data[key];
  }

  console.log(body);

  return metarhia.metautil
    .fetch(url, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        'Content-Type': 'application/x-amz-json-1.1',
        Origin: 'https://app.alpaca.markets',
        Referer: 'https://app.alpaca.markets/',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
        'X-Amz-User-Agent': 'aws-amplify/5.0.4 js',
      },
      body: JSON.stringify(body),
    })
    .then((res) => (res.status === 200 ? res.json() : res.text()));
};
