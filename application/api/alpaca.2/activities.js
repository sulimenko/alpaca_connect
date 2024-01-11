({
  access: 'public',
  method: async ({ keys, activityTypes, direction, date, pageSize }) => {
    const alpaca = await domain.clients.alpaca.get({ keys });

    activityTypes = activityTypes ? activityTypes : undefined; // ['FILL', 'CSD', 'CFEE', 'JNLS']
    direction = direction ? direction : 'desc';
    const after = date ? date : undefined;
    pageSize = pageSize ? pageSize : 100;

    return alpaca.getAccountActivities({ activityTypes, direction, after, pageSize });
  },
});
