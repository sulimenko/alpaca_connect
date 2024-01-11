({
  paper: {
    key: process.env.alpaca_paper_key,
    secret: process.env.alpaca_paper_secret,
    paper: true,
  },
  main: {
    key: process.env.alpaca_main_key,
    secret: process.env.alpaca_main_secret,
    paper: false,
  },
});
