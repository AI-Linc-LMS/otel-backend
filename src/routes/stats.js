/**
 * Analytics / quick stats for dashboards (graphs, KPIs, tables).
 * Query params (all routes):
 *   - from, to: ISO datetimes (default: last 24h)
 *   - serviceName: optional filter
 *   - serverOnly: "true" | "false" (default true) — only span kind SERVER (2), typical for HTTP APIs
 *   - bucket: "minute" | "hour" | "day" (default hour) — for timeseries
 *   - limit: max rows for ranked lists (default 25, max 100)
 *   - httpErrors: "true" | "false" (default true) — count HTTP 4xx/5xx from span attributes as failures
 *     (OTel often leaves span status OK for 403; see http.response.status_code / http.status_code)
 */
import express from 'express';
import { Trace } from '../models/Trace.js';

const router = express.Router();

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

function parseBool(v, defaultVal) {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return defaultVal;
}

function parseRange(req) {
  const now = new Date();
  const to = req.query.to ? new Date(req.query.to) : now;
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(now.getTime() - 24 * 60 * 60 * 1000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    const err = new Error('Invalid from or to date');
    err.status = 400;
    throw err;
  }
  if (from > to) {
    const err = new Error('from must be before or equal to to');
    err.status = 400;
    throw err;
  }

  return { from, to };
}

function baseMatch({ from, to, serviceName, serverOnly }) {
  const m = {
    startTime: { $gte: from, $lte: to },
  };
  if (serviceName) {
    m.serviceName = new RegExp(String(serviceName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  if (serverOnly) {
    m.kind = 2; // OpenTelemetry SpanKind.SERVER
  }
  return m;
}

function parseBucket(req) {
  const b = (req.query.bucket || 'hour').toLowerCase();
  if (!['minute', 'hour', 'day'].includes(b)) {
    const err = new Error('bucket must be minute, hour, or day');
    err.status = 400;
    throw err;
  }
  return b;
}

function parseLimit(req) {
  const n = parseInt(req.query.limit, 10);
  if (Number.isNaN(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

/** Treat HTTP 4xx/5xx in attributes as failed (default). Set httpErrors=false for OTel status only. */
function includeHttpStatusErrors(req) {
  return parseBool(req.query.httpErrors, true);
}

/** OpenTelemetry semantic convention keys for HTTP response status */
const HTTP_STATUS_ATTR_KEYS = [
  'http.response.status_code',
  'http.status_code',
];

/**
 * Stages after $match: set _isFailed = OTel ERROR (status.code 2) OR (optional) HTTP status 400–599 from attributes.
 */
function buildFailureDetectionStages(countHttpStatusErrors) {
  if (!countHttpStatusErrors) {
    return [
      {
        $addFields: {
          _isFailed: { $eq: ['$status.code', 2] },
        },
      },
    ];
  }

  return [
    {
      $addFields: {
        _httpAttr: {
          $arrayElemAt: [
            {
              $filter: {
                input: { $ifNull: ['$attributes', []] },
                as: 'a',
                cond: {
                  $in: ['$$a.key', HTTP_STATUS_ATTR_KEYS],
                },
              },
            },
            0,
          ],
        },
      },
    },
    {
      $addFields: {
        _httpStatusInt: {
          $convert: {
            input: '$_httpAttr.value',
            to: 'int',
            onError: null,
            onNull: null,
          },
        },
      },
    },
    {
      $addFields: {
        _isFailed: {
          $or: [
            { $eq: ['$status.code', 2] },
            {
              $and: [
                { $ne: ['$_httpStatusInt', null] },
                { $gte: ['$_httpStatusInt', 400] },
                { $lte: ['$_httpStatusInt', 599] },
              ],
            },
          ],
        },
      },
    },
  ];
}

/**
 * GET /api/stats
 * Single payload for dashboards: overview + timeseries + ranked endpoints + by service.
 */
router.get('/', async (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const serverOnly = parseBool(req.query.serverOnly, true);
    const serviceName = req.query.serviceName || null;
    const bucket = parseBucket(req);
    const limit = parseLimit(req);
    const countHttpStatusErrors = includeHttpStatusErrors(req);
    const failStages = buildFailureDetectionStages(countHttpStatusErrors);
    const $match = baseMatch({ from, to, serviceName, serverOnly });

    const [
      overviewAgg,
      timeSeriesAgg,
      byEndpointFailures,
      byEndpointSlow,
      byService,
    ] = await Promise.all([
      // Overview + percentiles (MongoDB 5.2+)
      Trace.aggregate([
        { $match },
        ...failStages,
        {
          $group: {
            _id: null,
            totalRequests: { $sum: 1 },
            failedRequests: { $sum: { $cond: ['$_isFailed', 1, 0] } },
            avgDurationMs: { $avg: '$duration' },
            minDurationMs: { $min: '$duration' },
            maxDurationMs: { $max: '$duration' },
            durationPercentiles: {
              $percentile: {
                input: '$duration',
                p: [0.5, 0.95, 0.99],
                method: 'approximate',
              },
            },
          },
        },
      ]).exec(),

      Trace.aggregate([
        { $match },
        ...failStages,
        {
          $group: {
            _id: {
              $dateTrunc: { date: '$startTime', unit: bucket },
            },
            total: { $sum: 1 },
            failed: { $sum: { $cond: ['$_isFailed', 1, 0] } },
            avgDurationMs: { $avg: '$duration' },
          },
        },
        { $sort: { _id: 1 } },
      ]).exec(),

      Trace.aggregate([
        { $match },
        ...failStages,
        {
          $group: {
            _id: '$name',
            total: { $sum: 1 },
            failed: { $sum: { $cond: ['$_isFailed', 1, 0] } },
            avgDurationMs: { $avg: '$duration' },
            maxDurationMs: { $max: '$duration' },
          },
        },
        { $match: { failed: { $gt: 0 } } },
        { $sort: { failed: -1, total: -1 } },
        { $limit: limit },
      ]).exec(),

      Trace.aggregate([
        { $match },
        ...failStages,
        {
          $group: {
            _id: '$name',
            total: { $sum: 1 },
            failed: { $sum: { $cond: ['$_isFailed', 1, 0] } },
            avgDurationMs: { $avg: '$duration' },
            maxDurationMs: { $max: '$duration' },
          },
        },
        { $match: { total: { $gte: 1 } } },
        { $sort: { avgDurationMs: -1 } },
        { $limit: limit },
      ]).exec(),

      Trace.aggregate([
        { $match },
        ...failStages,
        {
          $group: {
            _id: { $ifNull: ['$serviceName', '(unknown)'] },
            total: { $sum: 1 },
            failed: { $sum: { $cond: ['$_isFailed', 1, 0] } },
            avgDurationMs: { $avg: '$duration' },
          },
        },
        { $sort: { total: -1 } },
        { $limit: limit },
      ]).exec(),
    ]);

    const ov = overviewAgg[0] || {};
    const total = ov.totalRequests || 0;
    const failed = ov.failedRequests || 0;
    const successful = Math.max(0, total - failed);
    const pct = total > 0 ? (successful / total) * 100 : null;
    const errPct = total > 0 ? (failed / total) * 100 : null;
    const perc = ov.durationPercentiles || [];

    const overview = {
      totalRequests: total,
      successfulRequests: successful,
      failedRequests: failed,
      successRatePercent: pct != null ? Math.round(pct * 100) / 100 : null,
      errorRatePercent: errPct != null ? Math.round(errPct * 100) / 100 : null,
      avgDurationMs: round2(ov.avgDurationMs),
      minDurationMs: ov.minDurationMs ?? null,
      maxDurationMs: ov.maxDurationMs ?? null,
      p50DurationMs: round2(perc[0]),
      p95DurationMs: round2(perc[1]),
      p99DurationMs: round2(perc[2]),
    };

    const timeSeries = timeSeriesAgg.map((row) => ({
      bucketStart: row._id,
      total: row.total,
      failed: row.failed,
      success: row.total - row.failed,
      avgDurationMs: round2(row.avgDurationMs),
    }));

    const mapEndpoint = (row) => {
      const t = row.total || 0;
      const f = row.failed || 0;
      const ok = Math.max(0, t - f);
      return {
        name: row._id || '(unnamed)',
        total: t,
        failed: f,
        successful: ok,
        successRatePercent:
          t > 0 ? Math.round((ok / t) * 10000) / 100 : null,
        avgDurationMs: round2(row.avgDurationMs),
        maxDurationMs: row.maxDurationMs ?? null,
      };
    };

    res.json({
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        bucket,
        serverOnly,
        serviceNameFilter: serviceName,
        httpErrors: countHttpStatusErrors,
        failureCountsAs: countHttpStatusErrors
          ? 'OpenTelemetry status ERROR (code 2) OR HTTP status 400–599 in attributes (http.response.status_code / http.status_code)'
          : 'OpenTelemetry status ERROR (code 2) only',
      },
      overview,
      timeSeries,
      frequentlyFailingApis: byEndpointFailures.map(mapEndpoint),
      slowestApis: byEndpointSlow.map(mapEndpoint),
      byService: byService.map((row) => {
        const t = row.total || 0;
        const f = row.failed || 0;
        const ok = Math.max(0, t - f);
        return {
          serviceName: row._id,
          total: t,
          failed: f,
          successful: ok,
          successRatePercent:
            t > 0 ? Math.round((ok / t) * 10000) / 100 : null,
          avgDurationMs: round2(row.avgDurationMs),
        };
      }),
    });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500 && /percentile|dateTrunc|not.*supported/i.test(error.message || '')) {
      return res.status(500).json({
        error: error.message,
        hint: 'Overview uses $percentile and timeseries uses $dateTrunc; require MongoDB 5.2+ and 5.0+ respectively.',
      });
    }
    res.status(status).json({ error: error.message });
  }
});

function round2(n) {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(Number(n) * 100) / 100;
}

/**
 * GET /api/stats/overview — lightweight KPIs only
 */
router.get('/overview', async (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const serverOnly = parseBool(req.query.serverOnly, true);
    const serviceName = req.query.serviceName || null;
    const countHttpStatusErrors = includeHttpStatusErrors(req);
    const failStages = buildFailureDetectionStages(countHttpStatusErrors);
    const $match = baseMatch({ from, to, serviceName, serverOnly });

    const [row] = await Trace.aggregate([
      { $match },
      ...failStages,
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          failedRequests: { $sum: { $cond: ['$_isFailed', 1, 0] } },
          avgDurationMs: { $avg: '$duration' },
          minDurationMs: { $min: '$duration' },
          maxDurationMs: { $max: '$duration' },
          durationPercentiles: {
            $percentile: {
              input: '$duration',
              p: [0.5, 0.95, 0.99],
              method: 'approximate',
            },
          },
        },
      },
    ]).exec();

    const ov = row || {};
    const total = ov.totalRequests || 0;
    const failed = ov.failedRequests || 0;
    const successful = Math.max(0, total - failed);
    const perc = ov.durationPercentiles || [];

    res.json({
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        serverOnly,
        serviceNameFilter: serviceName,
        httpErrors: countHttpStatusErrors,
        failureCountsAs: countHttpStatusErrors
          ? 'OpenTelemetry status ERROR (code 2) OR HTTP status 400–599 in attributes'
          : 'OpenTelemetry status ERROR (code 2) only',
      },
      totalRequests: total,
      successfulRequests: successful,
      failedRequests: failed,
      successRatePercent:
        total > 0 ? Math.round((successful / total) * 10000) / 100 : null,
      errorRatePercent:
        total > 0 ? Math.round((failed / total) * 10000) / 100 : null,
      avgDurationMs: round2(ov.avgDurationMs),
      minDurationMs: ov.minDurationMs ?? null,
      maxDurationMs: ov.maxDurationMs ?? null,
      p50DurationMs: round2(perc[0]),
      p95DurationMs: round2(perc[1]),
      p99DurationMs: round2(perc[2]),
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message });
  }
});

/**
 * GET /api/stats/timeseries — for charts (requests / failures / latency per bucket)
 */
router.get('/timeseries', async (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const serverOnly = parseBool(req.query.serverOnly, true);
    const serviceName = req.query.serviceName || null;
    const bucket = parseBucket(req);
    const countHttpStatusErrors = includeHttpStatusErrors(req);
    const failStages = buildFailureDetectionStages(countHttpStatusErrors);
    const $match = baseMatch({ from, to, serviceName, serverOnly });

    const rows = await Trace.aggregate([
      { $match },
      ...failStages,
      {
        $group: {
          _id: {
            $dateTrunc: { date: '$startTime', unit: bucket },
          },
          total: { $sum: 1 },
          failed: { $sum: { $cond: ['$_isFailed', 1, 0] } },
          avgDurationMs: { $avg: '$duration' },
        },
      },
      { $sort: { _id: 1 } },
    ]).exec();

    res.json({
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        bucket,
        serverOnly,
        serviceNameFilter: serviceName,
        httpErrors: countHttpStatusErrors,
      },
      series: rows.map((row) => ({
        bucketStart: row._id,
        total: row.total,
        failed: row.failed,
        success: row.total - row.failed,
        avgDurationMs: round2(row.avgDurationMs),
      })),
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message });
  }
});

/**
 * GET /api/stats/endpoints
 * sort: failures | slowest | lowest_success (default failures)
 */
router.get('/endpoints', async (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const serverOnly = parseBool(req.query.serverOnly, true);
    const serviceName = req.query.serviceName || null;
    const limit = parseLimit(req);
    const sort = (req.query.sort || 'failures').toLowerCase();
    const countHttpStatusErrors = includeHttpStatusErrors(req);
    const failStages = buildFailureDetectionStages(countHttpStatusErrors);
    const $match = baseMatch({ from, to, serviceName, serverOnly });

    const sortStage =
      sort === 'slowest'
        ? { avgDurationMs: -1, total: -1 }
        : sort === 'lowest_success'
          ? { successRate: 1, total: -1 }
          : { failed: -1, total: -1 };

    const pipeline = [
      { $match },
      ...failStages,
      {
        $group: {
          _id: '$name',
          total: { $sum: 1 },
          failed: { $sum: { $cond: ['$_isFailed', 1, 0] } },
          avgDurationMs: { $avg: '$duration' },
          maxDurationMs: { $max: '$duration' },
        },
      },
      {
        $addFields: {
          successful: { $subtract: ['$total', '$failed'] },
          successRate: {
            $cond: [
              { $gt: ['$total', 0] },
              { $divide: [{ $subtract: ['$total', '$failed'] }, '$total'] },
              null,
            ],
          },
        },
      },
      { $sort: sortStage },
      { $limit: limit },
    ];

    const rows = await Trace.aggregate(pipeline).exec();

    res.json({
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        serverOnly,
        serviceNameFilter: serviceName,
        httpErrors: countHttpStatusErrors,
      },
      sort,
      endpoints: rows.map((row) => {
        const t = row.total || 0;
        const f = row.failed || 0;
        const ok = Math.max(0, t - f);
        return {
          name: row._id || '(unnamed)',
          total: t,
          failed: f,
          successful: ok,
          successRatePercent:
            t > 0 ? Math.round((ok / t) * 10000) / 100 : null,
          avgDurationMs: round2(row.avgDurationMs),
          maxDurationMs: row.maxDurationMs ?? null,
        };
      }),
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message });
  }
});

export default router;
