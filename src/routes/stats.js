/**
 * Analytics / quick stats for dashboards (graphs, KPIs, tables).
 * Query params (all routes):
 *   - from, to: ISO datetimes (default: last 30 days, STATS_DEFAULT_LOOKBACK_DAYS)
 *   - serviceName: optional filter
 *   - serverOnly: "true" | "false" (default false) — if true, only SERVER spans (kind 2 / SPAN_KIND_SERVER)
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

/** Default window when from/to omitted (override with STATS_DEFAULT_LOOKBACK_DAYS, max ~10y) */
function defaultLookbackMs() {
  const d = parseFloat(process.env.STATS_DEFAULT_LOOKBACK_DAYS);
  if (!Number.isNaN(d) && d > 0 && d <= 3660) {
    return d * 24 * 60 * 60 * 1000;
  }
  return 30 * 24 * 60 * 60 * 1000;
}

/** DB may store kind as number 2 or legacy string from OTLP JSON */
const SPAN_KIND_SERVER_MATCH = [2, '2', 'SPAN_KIND_SERVER'];

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
    : new Date(now.getTime() - defaultLookbackMs());

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
    m.kind = { $in: SPAN_KIND_SERVER_MATCH };
  }
  return m;
}

/** Helps debug “all zeros” in prod (time window vs kind filter vs empty DB). */
async function fetchStatsDiagnostics({ from, to, serviceName, serverOnly }) {
  const timeOnly = { startTime: { $gte: from, $lte: to } };
  if (serviceName) {
    timeOnly.serviceName = new RegExp(
      String(serviceName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i',
    );
  }
  const fullMatch = baseMatch({ from, to, serviceName, serverOnly });

  const [documentsInTimeRange, documentsAfterFilters, estimatedTotalInCollection] =
    await Promise.all([
      Trace.countDocuments(timeOnly),
      Trace.countDocuments(fullMatch),
      Trace.estimatedDocumentCount(),
    ]);

  let hint;
  if (documentsAfterFilters === 0) {
    if (documentsInTimeRange > 0) {
      hint = serverOnly
        ? 'Spans exist in this time range but none match SERVER kind. Try ?serverOnly=false (many frameworks emit INTERNAL spans), or fix OTLP kind normalization on ingest.'
        : 'Spans exist in this time range but filters exclude them (check serviceName).';
    } else if (estimatedTotalInCollection > 0) {
      hint =
        'No spans in this time window. Widen the range with ?from=&to= or set STATS_DEFAULT_LOOKBACK_DAYS (default 30 days).';
    } else {
      hint = 'No trace documents in the collection.';
    }
  }

  return {
    documentsInTimeRange,
    documentsAfterFilters,
    estimatedTotalInCollection,
    ...(hint ? { hint } : {}),
  };
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

/** First attribute value matching any of keys (flat { key, value }[]). */
function attrFirst(keys) {
  return {
    $arrayElemAt: [
      {
        $filter: {
          input: { $ifNull: ['$attributes', []] },
          as: 'a',
          cond: { $in: ['$$a.key', keys] },
        },
      },
      0,
    ],
  };
}

/**
 * After failure stages: set _apiGroupKey — uses http.route/target, url.full/http.url path,
 * span name patterns "POST /api/...", and comma-joins multiple path hints on one span.
 */
function buildApiEndpointGroupStages() {
  return [
    {
      $addFields: {
        _attrMethod: attrFirst(['http.request.method', 'http.method', '_method']),
        _attrRoute: attrFirst([
          'http.route',
          'http.route.template',
          'next.route',
          'aspnetcore.routing.endpoint',
          'fastapi.route',
        ]),
        _attrTarget: attrFirst(['http.target', 'url.path', 'http.path', 'path.template']),
        _attrUrlFull: attrFirst(['url.full']),
        _attrHttpUrl: attrFirst(['http.url', 'http.request.url', 'request.url']),
        _attrGraphql: attrFirst(['graphql.operation.name']),
        _attrRpc: attrFirst(['rpc.method', 'grpc.method']),
      },
    },
    {
      $addFields: {
        _httpMethod: {
          $toUpper: {
            $trim: {
              input: {
                $convert: {
                  input: '$_attrMethod.value',
                  to: 'string',
                  onError: '',
                  onNull: '',
                },
              },
            },
          },
        },
        _httpRoute: {
          $trim: {
            input: {
              $convert: {
                input: '$_attrRoute.value',
                to: 'string',
                onError: '',
                onNull: '',
              },
            },
          },
        },
        _httpTarget: {
          $trim: {
            input: {
              $convert: {
                input: '$_attrTarget.value',
                to: 'string',
                onError: '',
                onNull: '',
              },
            },
          },
        },
        _rawUrl: {
          $let: {
            vars: {
              u1: {
                $trim: {
                  input: {
                    $convert: {
                      input: '$_attrUrlFull.value',
                      to: 'string',
                      onError: '',
                      onNull: '',
                    },
                  },
                },
              },
              u2: {
                $trim: {
                  input: {
                    $convert: {
                      input: '$_attrHttpUrl.value',
                      to: 'string',
                      onError: '',
                      onNull: '',
                    },
                  },
                },
              },
            },
            in: {
              $cond: [
                { $gt: [{ $strLenCP: '$$u1' }, 0] },
                '$$u1',
                '$$u2',
              ],
            },
          },
        },
      },
    },
    {
      $addFields: {
        _parsedFromName: {
          $regexFind: {
            input: { $ifNull: ['$name', ''] },
            regex: '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\s+(.+)$',
            options: 'i',
          },
        },
        _pathFromFullUrl: {
          $let: {
            vars: {
              u: '$_rawUrl',
              rf: {
                $regexFind: {
                  input: '$_rawUrl',
                  regex: '^https?://[^/?#]+([^?#]*)',
                  options: 'i',
                },
              },
            },
            in: {
              $let: {
                vars: {
                  cap: {
                    $trim: {
                      input: {
                        $ifNull: [{ $arrayElemAt: ['$$rf.captures', 0] }, ''],
                      },
                    },
                  },
                },
                in: {
                  $cond: [
                    { $gt: [{ $strLenCP: '$$cap' }, 0] },
                    '$$cap',
                    {
                      $cond: [
                        {
                          $regexMatch: {
                            input: { $ifNull: ['$$u', ''] },
                            regex: '^/',
                          },
                        },
                        {
                          $trim: {
                            input: {
                              $arrayElemAt: [
                                { $split: [{ $ifNull: ['$$u', ''] }, '?'] },
                                0,
                              ],
                            },
                          },
                        },
                        '',
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    {
      $addFields: {
        _httpMethodFromName: {
          $toUpper: {
            $trim: {
              input: {
                $ifNull: [{ $arrayElemAt: ['$_parsedFromName.captures', 0] }, ''],
              },
            },
          },
        },
        _httpPathFromName: {
          $trim: {
            input: {
              $arrayElemAt: [
                {
                  $split: [
                    {
                      $convert: {
                        input: {
                          $ifNull: [{ $arrayElemAt: ['$_parsedFromName.captures', 1] }, ''],
                        },
                        to: 'string',
                        onError: '',
                        onNull: '',
                      },
                    },
                    '?',
                  ],
                },
                0,
              ],
            },
          },
        },
        _extraHint: {
          $let: {
            vars: {
              g: {
                $trim: {
                  input: {
                    $convert: {
                      input: '$_attrGraphql.value',
                      to: 'string',
                      onError: '',
                      onNull: '',
                    },
                  },
                },
              },
              r: {
                $trim: {
                  input: {
                    $convert: {
                      input: '$_attrRpc.value',
                      to: 'string',
                      onError: '',
                      onNull: '',
                    },
                  },
                },
              },
            },
            in: {
              $cond: [
                { $gt: [{ $strLenCP: '$$g' }, 0] },
                '$$g',
                '$$r',
              ],
            },
          },
        },
      },
    },
    {
      $addFields: {
        _finalMethod: {
          $cond: [
            { $gt: [{ $strLenCP: '$_httpMethod' }, 0] },
            '$_httpMethod',
            {
              $cond: [
                { $gt: [{ $strLenCP: '$_httpMethodFromName' }, 0] },
                '$_httpMethodFromName',
                {
                  $toUpper: {
                    $trim: {
                      input: {
                        $convert: {
                          input: { $ifNull: ['$name', ''] },
                          to: 'string',
                          onError: '',
                          onNull: '',
                        },
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
        _pathCandidates: {
          $filter: {
            input: [
              '$_httpRoute',
              '$_httpTarget',
              '$_pathFromFullUrl',
              '$_httpPathFromName',
              '$_extraHint',
            ],
            as: 'p',
            cond: {
              $gt: [
                {
                  $strLenCP: {
                    $trim: {
                      input: {
                        $convert: {
                          input: '$$p',
                          to: 'string',
                          onError: '',
                          onNull: '',
                        },
                      },
                    },
                  },
                },
                0,
              ],
            },
          },
        },
      },
    },
    {
      $addFields: {
        _pathsUnique: { $setUnion: ['$_pathCandidates', []] },
      },
    },
    {
      $addFields: {
        _pathsJoined: {
          $reduce: {
            input: '$_pathsUnique',
            initialValue: '',
            in: {
              $cond: [
                { $eq: ['$$value', ''] },
                { $toString: '$$this' },
                { $concat: ['$$value', ', ', { $toString: '$$this' }] },
              ],
            },
          },
        },
      },
    },
    {
      $addFields: {
        _apiGroupKey: {
          $let: {
            vars: {
              m: '$_finalMethod',
              pj: '$_pathsJoined',
              n: { $ifNull: ['$name', ''] },
            },
            in: {
              $cond: [
                { $gt: [{ $strLenCP: '$$pj' }, 0] },
                {
                  $trim: {
                    input: {
                      $cond: [
                        { $gt: [{ $strLenCP: '$$m' }, 0] },
                        { $concat: ['$$m', ' ', '$$pj'] },
                        '$$pj',
                      ],
                    },
                  },
                },
                '$$n',
              ],
            },
          },
        },
      },
    },
    {
      $addFields: {
        _apiGroupKey: {
          $cond: [
            { $gt: [{ $strLenCP: { $ifNull: ['$_apiGroupKey', ''] } }, 0] },
            '$_apiGroupKey',
            { $ifNull: ['$name', '(unnamed)'] },
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
    const serverOnly = parseBool(req.query.serverOnly, false);
    const serviceName = req.query.serviceName || null;
    const bucket = parseBucket(req);
    const limit = parseLimit(req);
    const countHttpStatusErrors = includeHttpStatusErrors(req);
    const failStages = buildFailureDetectionStages(countHttpStatusErrors);
    const apiGroupStages = buildApiEndpointGroupStages();
    const $match = baseMatch({ from, to, serviceName, serverOnly });

    const [
      overviewAgg,
      timeSeriesAgg,
      byEndpointFailures,
      byEndpointSlow,
      byService,
      diagnostics,
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
        ...apiGroupStages,
        {
          $group: {
            _id: '$_apiGroupKey',
            total: { $sum: 1 },
            failed: { $sum: { $cond: ['$_isFailed', 1, 0] } },
            avgDurationMs: { $avg: '$duration' },
            maxDurationMs: { $max: '$duration' },
            uniquePathsJoined: { $addToSet: '$_pathsJoined' },
            distinctSpanNames: { $addToSet: '$name' },
          },
        },
        { $match: { failed: { $gt: 0 } } },
        { $sort: { failed: -1, total: -1 } },
        { $limit: limit },
      ]).exec(),

      Trace.aggregate([
        { $match },
        ...failStages,
        ...apiGroupStages,
        {
          $group: {
            _id: '$_apiGroupKey',
            total: { $sum: 1 },
            failed: { $sum: { $cond: ['$_isFailed', 1, 0] } },
            avgDurationMs: { $avg: '$duration' },
            maxDurationMs: { $max: '$duration' },
            uniquePathsJoined: { $addToSet: '$_pathsJoined' },
            distinctSpanNames: { $addToSet: '$name' },
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

      fetchStatsDiagnostics({ from, to, serviceName, serverOnly }),
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
      frequentlyFailingApis: byEndpointFailures.map(formatEndpointAggregationRow),
      slowestApis: byEndpointSlow.map(formatEndpointAggregationRow),
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
      diagnostics,
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

/** Group _id is only HTTP verb — append comma-separated paths or span names from the bucket. */
const METHOD_ONLY_AGG_NAME = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;

function formatEndpointAggregationRow(row) {
  const t = row.total || 0;
  const f = row.failed || 0;
  const ok = Math.max(0, t - f);
  const idStr = String(row._id ?? '(unnamed)').trim();
  let name = idStr;

  const pathVariants = (row.uniquePathsJoined || []).filter(
    (p) => p != null && String(p).trim().length > 0,
  );
  const spanNames = [
    ...new Set(
      (row.distinctSpanNames || [])
        .map((n) => String(n).trim())
        .filter(Boolean),
    ),
  ];

  if (METHOD_ONLY_AGG_NAME.test(idStr)) {
    if (pathVariants.length > 0) {
      name = `${idStr} ${pathVariants.join(', ')}`;
    } else if (spanNames.length > 1) {
      name = spanNames.join(', ');
    } else if (spanNames.length === 1 && !METHOD_ONLY_AGG_NAME.test(spanNames[0])) {
      name = `${idStr} ${spanNames[0]}`;
    }
  }

  return {
    name,
    total: t,
    failed: f,
    successful: ok,
    successRatePercent: t > 0 ? Math.round((ok / t) * 10000) / 100 : null,
    avgDurationMs: round2(row.avgDurationMs),
    maxDurationMs: row.maxDurationMs ?? null,
  };
}

/**
 * GET /api/stats/overview — lightweight KPIs only
 */
router.get('/overview', async (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const serverOnly = parseBool(req.query.serverOnly, false);
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
    const serverOnly = parseBool(req.query.serverOnly, false);
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
    const serverOnly = parseBool(req.query.serverOnly, false);
    const serviceName = req.query.serviceName || null;
    const limit = parseLimit(req);
    const sort = (req.query.sort || 'failures').toLowerCase();
    const countHttpStatusErrors = includeHttpStatusErrors(req);
    const failStages = buildFailureDetectionStages(countHttpStatusErrors);
    const apiGroupStages = buildApiEndpointGroupStages();
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
      ...apiGroupStages,
      {
        $group: {
          _id: '$_apiGroupKey',
          total: { $sum: 1 },
          failed: { $sum: { $cond: ['$_isFailed', 1, 0] } },
          avgDurationMs: { $avg: '$duration' },
          maxDurationMs: { $max: '$duration' },
          uniquePathsJoined: { $addToSet: '$_pathsJoined' },
          distinctSpanNames: { $addToSet: '$name' },
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
      endpoints: rows.map(formatEndpointAggregationRow),
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message });
  }
});

export default router;
