(() => {
  // Non-secret, worker-local receipts bridge a lost HTTP response. Meta's
  // durable placement barriers remain authoritative across connector restart.
  // Unknown attempts never turn into permission to place another order.
  const attempts = new Map();
  // orderId is Meta's durable operation identity. Changing account/environment
  // must conflict with an existing attempt, rather than opening a second slot.
  const key = ({ orderId }) => orderId;
  const get = (data) => attempts.get(key(data)) || null;
  const claim = (data, fingerprint) => {
    const existing = get(data);
    if (existing) {
      const conflict = existing.account !== data.account || existing.live !== data.live || existing.fingerprint !== fingerprint;
      return { owner: false, conflict, attempt: existing };
    }
    if (attempts.size >= 10000) return { owner: false, conflict: true, attempt: null };
    const attempt = { account: data.account, live: data.live, fingerprint, brokerId: null, result: null };
    attempts.set(key(data), attempt); // synchronous, before the first await
    return { owner: true, conflict: false, attempt };
  };
  return { get, claim };
})();
