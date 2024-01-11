/* eslint-disable no-undef */
/* eslint-disable camelcase */
({
  access: 'public',
  method: async ({ keys, start, end, period, timeframe, extended }) => {
    const alpaca = await domain.clients.alpaca.get({ keys });

    date_start = start ? start : undefined;
    date_end = end ? end : undefined;
    period = period && ['1M', '3M', '6M', '1A', 'all', 'intraday'].includes(period) ? period : '1М';
    timeframe = timeframe && ['1Min', '5Min', '15Min', '1H', '1D'].includes(timeframe) ? timeframe : '1D';
    extended_hours = extended !== undefined && typeof extended === 'boolean' ? extended : true;

    return alpaca.getPositions({ date_start, date_end, period, timeframe, extended_hours });
  },
});
