({ account, settings, asset }) => {
  const { decimal } = lib.execution;
  const orders = [];
  const attributes = asset.attributes;
  const fractional = settings.fractional_trading === true && asset.fractionable === true;
  const short =
    account.shorting_enabled === true &&
    settings.no_shorting === false &&
    ['2', '4'].includes(account.multiplier) &&
    ['2', '4'].includes(settings.max_margin_multiplier) &&
    decimal.compare(account.equity, '2000') !== null &&
    decimal.compare(account.equity, '2000') >= 0 &&
    asset.marginable === true &&
    asset.shortable === true &&
    asset.easy_to_borrow === true;
  const sessions = ['regular', 'pre_market', 'post_market'];
  // An explicit attributes array proves absence of the documented halt marker.
  // If newer boolean fields are supplied, they must agree with that proof.
  const overnight =
    settings.disable_overnight_trading === false &&
    attributes.includes('overnight_tradable') &&
    !attributes.includes('overnight_halted') &&
    (!Object.hasOwn(asset, 'overnight_tradable') || asset.overnight_tradable === true) &&
    (!Object.hasOwn(asset, 'overnight_halted') || asset.overnight_halted === false);
  if (overnight) sessions.push('overnight');
  for (const fraction of fractional ? [false, true] : [false]) {
    const effects = [
      { side: 'buy', positionEffect: 'open' },
      { side: 'sell', positionEffect: 'close' },
    ];
    // Closing a short is a whole-share buy flow. Fractional sells are close-long.
    if (!fraction) effects.push({ side: 'buy', positionEffect: 'close' });
    if (!fraction && short) effects.push({ side: 'sell', positionEffect: 'open' });
    for (const session of sessions) {
      if (fraction && session !== 'regular' && !attributes.includes('fractional_eh_enabled')) continue;
      const extended = session !== 'regular';
      for (const type of extended ? ['limit'] : ['market', 'limit', 'stop', 'stop_limit']) {
        // Ordinary native equity support is the entitlement here; no invented
        // account flag. IOC/FOK never expands beyond whole regular market/limit.
        let tifs = ['day'];
        if (!extended && !fraction) tifs = ['market', 'limit'].includes(type) ? ['day', 'gtc', 'ioc', 'fok'] : ['day', 'gtc'];
        for (const tif of tifs) {
          for (const effect of effects) {
            orders.push({
              type,
              tif,
              session,
              extended,
              relation: 'NORMAL',
              orderClass: 'simple',
              quantityMode: fraction ? 'fractional' : 'whole',
              ...effect,
              quantity: {
                fractional: fraction,
                minimum: fraction ? '0.000000001' : '1',
                step: fraction ? '0.000000001' : '1',
                // Native equity account/configuration/asset contracts do not
                // define a finite per-order qty cap. Ignore unconfirmed extras.
                maximum: 'infinity',
                minimumNotional: effect.side === 'buy' ? { amount: '1', currency: 'USD' } : null,
              },
            });
          }
        }
      }
    }
  }
  return orders;
};
