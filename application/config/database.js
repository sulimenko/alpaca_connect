({
  host: process.env.db_host || '127.0.0.1',
  port: process.env.db_port || 5432,
  database: process.env.db_database,
  user: process.env.db_users,
  password: process.env.db_password,
});
