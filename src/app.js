import express from 'express';
import cors from 'cors';
import tracesRouter from './routes/traces.js';
import statsRouter from './routes/stats.js';
import otlpRouter from './routes/otlp.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/api/traces', tracesRouter);
app.use('/api/stats', statsRouter);
app.use('/v1/traces', otlpRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default app;
