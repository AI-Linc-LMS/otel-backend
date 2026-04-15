import 'dotenv/config';
import app from './app.js';
import { connectDB } from './config/db.js';

const PORT = process.env.PORT || 4138;

async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Traces API: http://localhost:${PORT}/api/traces`);
    console.log(`Stats API: http://localhost:${PORT}/api/stats`);
    console.log(`OTLP endpoint: http://localhost:${PORT}/v1/traces`);
  });
}

start().catch(console.error);
