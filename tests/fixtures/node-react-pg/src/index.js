const express = require('express');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());

app.get('/api/v1/health', (_req, res) => {
  res.json({ status: 'ok', port: Number(PORT) });
});

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
