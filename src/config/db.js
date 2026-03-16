import mongoose from 'mongoose';

export async function connectDB() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/otel-traces';
    await mongoose.connect(mongoUri);
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    if (process.env.NETLIFY !== 'true') process.exit(1);
    throw error;
  }
}
