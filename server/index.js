const { createApp } = require('./app');

const port = process.env.PORT || 4177;
const app = createApp();

app.listen(port, () => {
  console.log(`Palantir Console running at http://localhost:${port}`);
});
