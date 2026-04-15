import express from 'express';
import { Trace } from '../models/Trace.js';

const router = express.Router();

// Store a single trace
router.post('/', async (req, res) => {
  try {
    const traceData = req.body;
    
    // Normalize timestamps if sent as numbers (nanoseconds)
    if (typeof traceData.startTime === 'number') {
      traceData.startTime = new Date(traceData.startTime / 1e6);
    }
    if (typeof traceData.endTime === 'number') {
      traceData.endTime = new Date(traceData.endTime / 1e6);
    }
    
    // Calculate duration in milliseconds
    if (traceData.startTime && traceData.endTime) {
      traceData.duration = new Date(traceData.endTime) - new Date(traceData.startTime);
    }

    const trace = new Trace(traceData);
    await trace.save();
    res.status(201).json(trace);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Store multiple traces (batch)
router.post('/batch', async (req, res) => {
  try {
    const traces = req.body.traces || req.body;
    const normalized = Array.isArray(traces) ? traces : [traces];

    const docs = normalized.map((t) => {
      if (typeof t.startTime === 'number') t.startTime = new Date(t.startTime / 1e6);
      if (typeof t.endTime === 'number') t.endTime = new Date(t.endTime / 1e6);
      if (t.startTime && t.endTime) {
        t.duration = new Date(t.endTime) - new Date(t.startTime);
      }
      return new Trace(t);
    });

    const saved = await Trace.insertMany(docs);
    res.status(201).json({ count: saved.length, traces: saved });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Table endpoint for Next.js: paginated, sortable rows for UI table
router.get('/table', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortBy = 'startTime',
      order = 'desc',
      traceId,
      serviceName,
      startTime,
      endTime,
    } = req.query;

    const filter = {};
    if (traceId) filter.traceId = traceId;
    if (serviceName) filter.serviceName = new RegExp(serviceName, 'i');
    if (startTime || endTime) {
      filter.startTime = {};
      if (startTime) filter.startTime.$gte = new Date(startTime);
      if (endTime) filter.startTime.$lte = new Date(endTime);
    }

    const sortOrder = order === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortOrder };
    const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.min(100, Math.max(1, parseInt(limit, 10)));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));

    const [rows, total] = await Promise.all([
      Trace.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Trace.countDocuments(filter),
    ]);

    const data = rows.map((doc) => ({
      id: doc._id.toString(),
      traceId: doc.traceId,
      spanId: doc.spanId,
      parentSpanId: doc.parentSpanId ?? null,
      name: doc.name,
      kind: doc.kind,
      serviceName: doc.serviceName ?? null,
      startTime: doc.startTime,
      endTime: doc.endTime,
      duration: doc.duration ?? null,
      statusCode: doc.status?.code ?? 1,
      statusMessage: doc.status?.message ?? null,
      attributes: doc.attributes ?? [],
      createdAt: doc.createdAt,
    }));

    res.json({
      data,
      total,
      page: parseInt(page, 10),
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all spans for a traceId (must be before /:id)
router.get('/trace/:traceId', async (req, res) => {
  try {
    const traces = await Trace.find({ traceId: req.params.traceId })
      .sort({ startTime: 1 })
      .lean();
    res.json(traces);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get trace by ID
router.get('/:id', async (req, res) => {
  try {
    const trace = await Trace.findById(req.params.id);
    if (!trace) return res.status(404).json({ error: 'Trace not found' });
    res.json(trace);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List traces with optional filters
router.get('/', async (req, res) => {
  try {
    const { traceId, serviceName, startTime, endTime, limit = 100 } = req.query;
    const filter = {};

    if (traceId) filter.traceId = traceId;
    if (serviceName) filter.serviceName = serviceName;
    if (startTime || endTime) {
      filter.startTime = {};
      if (startTime) filter.startTime.$gte = new Date(startTime);
      if (endTime) filter.startTime.$lte = new Date(endTime);
    }

    const traces = await Trace.find(filter)
      .sort({ startTime: -1 })
      .limit(parseInt(limit, 10))
      .lean();

    res.json(traces);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
