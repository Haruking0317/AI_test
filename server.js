require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');

const app = express();
app.use(helmet());
app.use(express.json({ limit: '1mb' }));

const ORIGIN = process.env.ORIGIN || '*';
app.use(cors({ origin: ORIGIN }));

const limiter = rateLimit({ windowMs: 60_000, max: parseInt(process.env.RATE_LIMIT || '60') });
app.use(limiter);

const API_KEY = process.env.API_KEY || 'change-me';
const LM_URL = process.env.LM_URL || 'http://127.0.0.1:1234';

app.post('/api/chat', async (req, res) => {
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const upstream = await fetch(`${LM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const json = await upstream.json();
      res.status(upstream.status).json(json);
    } else {
      const text = await upstream.text();
      res.status(upstream.status).send(text);
    }
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('AI proxy is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
