// Internal common-wire validation. This does not change v2 submit validation.
// valuationPrice is explicit caller evidence for qty-based minimum order value;
// it is never converted to a notional submission or a broker fill guarantee.
({ rules, order, valuationPrice = null }) => {
  const { decimal } = lib.execution;
  if (rules?.version !== 1 || rules.state !== 'ready' || !order || !Array.isArray(rules.orders)) return false;
  const canonical = ['regular', 'pre_market', 'post_market', 'overnight'];
  const validSessions = (sessions) =>
    Array.isArray(sessions) &&
    [1, 3, 4].includes(sessions.length) &&
    canonical.slice(0, sessions.length).every((value, i) => sessions[i] === value);
  if (!validSessions(order.sessions)) return false;
  const keys = ['type', 'tif', 'relation', 'orderClass', 'quantityMode', 'side', 'positionEffect'];
  const rows = rules.orders.filter((row) => keys.every((key) => row[key] === order[key]) && row.quantity?.fractional === order.fractional);
  if (rows.length !== 1) return false;
  const row = rows[0];
  const quantity = row.quantity;
  if (
    !validSessions(row.sessions) ||
    row.sessions.length !== order.sessions.length ||
    !row.sessions.every((value, i) => value === order.sessions[i]) ||
    typeof quantity.fractional !== 'boolean' ||
    row.quantityMode !== (quantity.fractional ? 'fractional' : 'whole') ||
    decimal.compare(quantity.minimum, '0') !== 1 ||
    decimal.compare(quantity.step, '0') !== 1 ||
    decimal.compare(order.quantity, quantity.minimum) === null ||
    decimal.compare(order.quantity, quantity.minimum) < 0 ||
    !decimal.onGrid(order.quantity, quantity.step) ||
    (!quantity.fractional && !decimal.onGrid(order.quantity, '1')) ||
    (quantity.maximum !== 'infinity' &&
      (decimal.compare(order.quantity, quantity.maximum) === null || decimal.compare(order.quantity, quantity.maximum) > 0))
  ) {
    return false;
  }
  const validPrice = (value) => {
    if (decimal.compare(value, '0') !== 1 || !Array.isArray(rules.price?.rules)) return false;
    const candidates = rules.price.rules.filter((rule) => {
      const lower = decimal.compare(value, rule.minInclusive);
      const upper = rule.maxExclusive === null ? -1 : decimal.compare(value, rule.maxExclusive);
      return lower !== null && upper !== null && lower >= 0 && upper < 0;
    });
    return candidates.length === 1 && decimal.onGrid(value, candidates[0].tick);
  };
  if (['limit', 'stop_limit'].includes(row.type) && !validPrice(order.limitPrice)) return false;
  if (['stop', 'stop_limit'].includes(row.type) && !validPrice(order.stopPrice)) return false;
  if (quantity.minimumNotional !== null) {
    if (
      quantity.minimumNotional?.currency !== 'USD' ||
      decimal.compare(quantity.minimumNotional.amount, '0') !== 1 ||
      !decimal.productAtLeast(order.quantity, valuationPrice, quantity.minimumNotional.amount)
    ) {
      return false;
    }
  }
  return true;
};
