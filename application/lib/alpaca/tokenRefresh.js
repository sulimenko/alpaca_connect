async ({ token }) => {
  const data = {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    AuthParameters: { REFRESH_TOKEN: token },
  };

  return lib.aws.send(data);
};
