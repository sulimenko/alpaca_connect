async ({ data }) => {
  const failure = (reason, state = 'unavailable') => ({ version: 1, state, reason });
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const instrument = data?.instrument;
  if (
    !object(data) ||
    data.version !== 1 ||
    typeof data.account !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(data.account) ||
    typeof data.live !== 'boolean' ||
    !object(data.credentials) ||
    !['pkey', 'secret'].every(
      (name) =>
        typeof data.credentials[name] === 'string' && data.credentials[name].trim() !== '' && !/[\r\n]/.test(data.credentials[name]),
    ) ||
    !object(instrument) ||
    typeof instrument.symbol !== 'string' ||
    !/^[A-Z0-9.]{1,64}$/.test(instrument.symbol) ||
    typeof instrument.assetCategory !== 'string' ||
    typeof instrument.exchange !== 'string' ||
    typeof instrument.currency !== 'string'
  ) {
    return failure('invalid_request');
  }
  if (instrument.assetCategory !== 'STK' || instrument.currency !== 'USD') return failure('unsupported_instrument', 'unsupported');
  // This is the documented native listed-equity domain, not an OTC fallback.
  if (!['AMEX', 'ARCA', 'BATS', 'NYSE', 'NASDAQ', 'NYSEARCA'].includes(instrument.exchange)) {
    return failure('unsupported_exchange', 'unsupported');
  }
  const identity = await lib.execution.rulesAccount(data);
  if (!identity) return failure('account_unavailable');
  const { base, headers, row: account } = identity;
  const configuration = await lib.execution.request({ url: base + '/v2/account/configurations', headers });
  const settings = configuration.body;
  if (
    configuration.status !== 200 ||
    !object(settings) ||
    settings.suspend_trade !== false ||
    !['fractional_trading', 'no_shorting', 'disable_overnight_trading', 'ptp_no_exception_entry'].every(
      (name) => !Object.hasOwn(settings, name) || typeof settings[name] === 'boolean',
    ) ||
    (Object.hasOwn(settings, 'max_margin_multiplier') && !['1', '2', '4'].includes(settings.max_margin_multiplier))
  ) {
    return failure('configuration_unavailable');
  }
  const response = await lib.execution.request({ url: base + '/v2/assets/' + encodeURIComponent(instrument.symbol), headers });
  const asset = response.body;
  if (
    response.status !== 200 ||
    !object(asset) ||
    asset.class !== 'us_equity' ||
    asset.symbol !== instrument.symbol ||
    asset.exchange !== instrument.exchange ||
    asset.status !== 'active' ||
    asset.tradable !== true ||
    !Array.isArray(asset.attributes) ||
    !asset.attributes.every((attribute) => typeof attribute === 'string' && /^[a-z][a-z_]*$/.test(attribute)) ||
    new Set(asset.attributes).size !== asset.attributes.length
  ) {
    return failure('asset_unavailable');
  }
  const known = [
    'ipo',
    'ptp_no_exception',
    'ptp_with_exception',
    'has_options',
    'options_late_close',
    'fractional_eh_enabled',
    'overnight_tradable',
    'overnight_halted',
  ];
  // No special-case matrix or locate workflow is proven by these endpoints.
  if (
    asset.attributes.some(
      (attribute) => !known.includes(attribute) || ['ipo', 'ptp_no_exception', 'ptp_with_exception'].includes(attribute),
    )
  ) {
    return failure('asset_restriction', 'unsupported');
  }
  const orders = lib.execution.ruleMatrix({ account, settings, asset });
  if (orders.length === 0) return failure('rules_unavailable');
  return {
    version: 1,
    state: 'ready',
    identity: { terminal: 'ALPACA', externalAccount: data.account, live: data.live },
    instrument: {
      symbol: instrument.symbol,
      assetCategory: instrument.assetCategory,
      exchange: instrument.exchange,
      currency: 'USD',
    },
    orders,
    quantity: lib.execution.ruleSummary({ orders }),
    price: {
      rounding: 'nearest_half_up',
      rules: [
        { minimum: '0', maximum: '1', minimumInclusive: true, maximumInclusive: false, tick: '0.0001', precision: 4 },
        { minimum: '1', maximum: 'infinity', minimumInclusive: true, maximumInclusive: false, tick: '0.01', precision: 2 },
      ],
    },
  };
};
