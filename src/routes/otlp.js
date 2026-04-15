/**
 * OTLP HTTP receiver - accepts traces in OTLP JSON format
 * @see https://opentelemetry.io/docs/specs/otlp/#protobuf-encoding
 * Endpoint: POST /v1/traces (Content-Type: application/json)
 */

import express from "express";
import { Trace } from "../models/Trace.js";

const router = express.Router();

/** Extract primitive value from OTLP AnyValue { stringValue, intValue, boolValue, ... } */
function otlpValueToPrimitive(av) {
  if (!av || typeof av !== "object") return av;
  if (av.stringValue !== undefined) return av.stringValue;
  if (av.boolValue !== undefined) return av.boolValue;
  if (av.intValue !== undefined) return av.intValue;
  if (av.doubleValue !== undefined) return av.doubleValue;
  if (av.bytesValue !== undefined) return av.bytesValue;
  if (av.arrayValue?.values)
    return av.arrayValue.values.map(otlpValueToPrimitive);
  if (av.kvlistValue?.values) {
    const obj = {};
    for (const kv of av.kvlistValue.values) {
      if (kv.key) obj[kv.key] = otlpValueToPrimitive(kv.value);
    }
    return obj;
  }
  return null;
}

/** Convert OTLP attributes to { key, value }[] */
function otlpAttributesToModel(attrs) {
  if (!attrs || !Array.isArray(attrs)) return [];
  return attrs
    .filter((a) => a && a.key)
    .map((a) => ({ key: a.key, value: otlpValueToPrimitive(a.value) }));
}

/** Extract service.name from resource attributes */
function getServiceName(resource) {
  const attrs = resource?.attributes || resource?.attributeMap || [];
  const arr = Array.isArray(attrs)
    ? attrs
    : Object.entries(attrs).map(([k, v]) => ({ key: k, value: v }));
  const serviceAttr = arr.find(
    (a) => (a.key === "service.name" || a.key === "service_name") && a.value
  );
  if (serviceAttr) {
    const v = serviceAttr.value;
    return typeof v === "object" && v?.stringValue !== undefined
      ? v.stringValue
      : String(v);
  }
  return null;
}

/** OTLP JSON often sends protobuf enums as strings (e.g. SPAN_KIND_SERVER) — store numeric SpanKind. */
function normalizeSpanKind(kind) {
  if (kind === null || kind === undefined) return 1;
  if (typeof kind === "number" && Number.isFinite(kind)) return kind;
  const s = String(kind).toUpperCase().replace(/\./g, "_");
  const map = {
    SPAN_KIND_UNSPECIFIED: 0,
    SPAN_KIND_INTERNAL: 1,
    SPAN_KIND_SERVER: 2,
    SPAN_KIND_CLIENT: 3,
    SPAN_KIND_PRODUCER: 4,
    SPAN_KIND_CONSUMER: 5,
  };
  if (map[s] !== undefined) return map[s];
  const n = parseInt(String(kind), 10);
  return Number.isNaN(n) ? 1 : n;
}

/** Same for status code — strings like STATUS_CODE_ERROR */
function normalizeStatusCode(code) {
  if (code === null || code === undefined) return 1;
  if (typeof code === "number" && Number.isFinite(code)) return code;
  const s = String(code).toUpperCase().replace(/\./g, "_");
  if (s === "STATUS_CODE_ERROR" || s === "ERROR") return 2;
  if (s === "STATUS_CODE_OK" || s === "OK") return 1;
  if (s === "STATUS_CODE_UNSET" || s === "UNSET") return 0;
  const n = parseInt(String(code), 10);
  return Number.isNaN(n) ? 1 : n;
}

/** Convert OTLP span to Trace model document */
function otlpSpanToDoc(span, serviceName, resource) {
  const startNs = span.startTimeUnixNano ?? span.start_time_unix_nano;
  const endNs = span.endTimeUnixNano ?? span.end_time_unix_nano;
  const startTime = startNs ? new Date(Number(startNs) / 1e6) : new Date();
  const endTime = endNs ? new Date(Number(endNs) / 1e6) : new Date();
  const duration = endTime - startTime;

  const attrs = span.attributes ?? span.attributeMap ?? [];
  const attributes = otlpAttributesToModel(
    Array.isArray(attrs)
      ? attrs
      : Object.entries(attrs).map(([k, v]) => ({ key: k, value: v }))
  );

  const events = (span.events || []).map((e) => ({
    name: e.name,
    timestamp: e.timeUnixNano ? new Date(Number(e.timeUnixNano) / 1e6) : null,
    attributes: otlpAttributesToModel(e.attributes || []),
  }));

  const status = span.status || {};
  const rawStatusCode = status.code ?? status.codeValue ?? 1;
  const statusCode = normalizeStatusCode(rawStatusCode);
  const statusMessage = status.message ?? status.messageValue ?? null;

  const rawKind = span.kind ?? span.kindValue ?? 1;
  const kind = normalizeSpanKind(rawKind);

  return {
    traceId: span.traceId ?? span.trace_id ?? "",
    spanId: span.spanId ?? span.span_id ?? "",
    parentSpanId: span.parentSpanId ?? span.parent_span_id ?? null,
    name: span.name ?? "span",
    kind,
    startTime,
    endTime,
    duration,
    attributes,
    events,
    status: { code: statusCode, message: statusMessage },
    resource: resource ? { serviceName } : {},
    serviceName: serviceName || null,
  };
}

/** Flatten resourceSpans -> scopeSpans -> spans */
function extractSpans(payload) {
  const resourceSpans = payload.resourceSpans ?? payload.resource_spans ?? [];
  const docs = [];

  for (const rs of resourceSpans) {
    const resource = rs.resource ?? {};
    const serviceName = getServiceName(resource);
    const scopeSpans = rs.scopeSpans ?? rs.scope_spans ?? [];

    for (const ss of scopeSpans) {
      const spans = ss.spans ?? [];
      for (const span of spans) {
        docs.push(otlpSpanToDoc(span, serviceName, resource));
      }
    }
  }

  return docs;
}

/**
 * POST /v1/traces
 * OTLP HTTP JSON endpoint - receives ExportTraceServiceRequest
 */
router.post("/", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Invalid OTLP payload" });
    }

    const docs = extractSpans(payload);
    if (docs.length === 0) {
      return res.status(202).send(); // Accepted, nothing to store
    }

    // Use bulkWrite with upsert to handle retries (same span sent twice)
    const ops = docs.map((doc) => ({
      updateOne: {
        filter: { traceId: doc.traceId, spanId: doc.spanId },
        update: { $set: doc },
        upsert: true,
      },
    }));
    await Trace.bulkWrite(ops);
    res.status(200).send();
  } catch (error) {
    console.error("OTLP trace ingest error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
