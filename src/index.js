import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDB } from "./config/db.js";
import tracesRouter from "./routes/traces.js";
import otlpRouter from "./routes/otlp.js";

const app = express();
const PORT = process.env.PORT || 4138;

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Routes
app.use("/api/traces", tracesRouter);
app.use("/v1/traces", otlpRouter);

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Start server
async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Traces API: http://localhost:${PORT}/api/traces`);
    console.log(`OTLP endpoint: http://localhost:${PORT}/v1/traces`);
  });
}

start().catch(console.error);
