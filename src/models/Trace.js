import mongoose from 'mongoose';

const attributeSchema = new mongoose.Schema({
  key: String,
  value: mongoose.Schema.Types.Mixed,
}, { _id: false });

const eventSchema = new mongoose.Schema({
  name: String,
  timestamp: Date,
  attributes: [attributeSchema],
}, { _id: false });

const traceSchema = new mongoose.Schema({
  traceId: {
    type: String,
    required: true,
    index: true,
  },
  spanId: {
    type: String,
    required: true,
    index: true,
  },
  parentSpanId: {
    type: String,
    default: null,
    index: true,
  },
  name: {
    type: String,
    required: true,
  },
  kind: {
    type: Number,
    default: 1, // 0=unspecified, 1=internal, 2=server, 3=client, 4=producer, 5=consumer
  },
  startTime: {
    type: Date,
    required: true,
    index: true,
  },
  endTime: {
    type: Date,
    required: true,
  },
  attributes: [attributeSchema],
  events: [eventSchema],
  status: {
    code: { type: Number, default: 1 }, // 0=unset, 1=ok, 2=error
    message: String,
  },
  resource: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {},
  },
  serviceName: {
    type: String,
    index: true,
  },
  duration: {
    type: Number,
    index: true,
  },
}, {
  timestamps: true,
});

// Compound index for common queries
traceSchema.index({ traceId: 1, spanId: 1 }, { unique: true });
traceSchema.index({ startTime: -1 });
traceSchema.index({ serviceName: 1, startTime: -1 });

export const Trace = mongoose.model('Trace', traceSchema);
