import serverless from 'serverless-http';
import mongoose from 'mongoose';
import app from '../../src/app.js';
import { connectDB } from '../../src/config/db.js';

const serverlessHandler = serverless(app, { binary: false });

export const handler = async (event, context) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await connectDB();
    }
  } catch (err) {
    console.error('DB connect failed:', err);
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Database unavailable' }),
    };
  }
  return serverlessHandler(event, context);
};
