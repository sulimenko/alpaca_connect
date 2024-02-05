async ({ token }) => {
  const data = {
    Token: token,
  };

  return lib.aws.send(data);
};
