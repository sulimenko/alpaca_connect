({
  access: 'public',
  method: async ({ keys, activityTypes, direction, after, until, pageSize }) => {
    const alpaca = await domain.clients.alpaca.get({ keys });

    const data = {
      activityTypes: Array.isArray(activityTypes) ? activityTypes : [], // ['FILL', 'CSD', 'CFEE', 'JNLS']
      direction: typeof direction === 'string' && ['asc, desc'].includes(direction) ? direction : 'desc',
      pageSize: typeof direction === 'number' && pageSize >= 1 && pageSize <= 100 ? pageSize : 100,
    };

    if (typeof after !== 'undefined' && after !== null) data.after = new Date(after);
    if (typeof until !== 'undefined' && until !== null) data.until = new Date(until);

    return alpaca.getAccountActivities(data);
  },
});
