const path = require('node:path');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 3001;
const dist = path.resolve(__dirname, '../docs/.vitepress/dist');

app.use(express.json({ limit: '2mb' }));
app.use('/api/practice', require('../modules/listening/backend.cjs').createPracticeRouter());
app.use(express.static(dist, { extensions: ['html'] }));

app.listen(port, '0.0.0.0', () => {
  console.log(`Listening module is available at http://localhost:${port}/listening`);
});
