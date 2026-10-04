({ action, data }) => {
  const orderId = Number.isSafeInteger(data?.orderId) && data.orderId > 0 ? data.orderId : null;
  const prior = orderId === null ? null : domain.execution.attempts.get({ orderId });
  const submitFailure = prior ? 'ambiguous' : 'rejected';
  const invalid = {
    version: 2,
    orderId,
    state: action === 'submit' ? submitFailure : 'source_unavailable',
  };
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    data?.version !== 2 ||
    (action !== 'marketdata' && orderId === null) ||
    typeof data.account !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(data.account) ||
    typeof data.live !== 'boolean' ||
    !data.credentials ||
    !['pkey', 'secret'].every(
      (name) =>
        typeof data.credentials[name] === 'string' && data.credentials[name].trim() !== '' && !/[\r\n]/.test(data.credentials[name]),
    ) ||
    (data.brokerId !== null &&
      data.brokerId !== undefined &&
      (typeof data.brokerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.brokerId)))
  ) {
    return invalid;
  }
  if (action === 'marketdata') return lib.execution.marketData({ data });
  if (!['submit', 'lookup'].includes(action)) return invalid;
  return lib.execution.broker({ action, data });
};
