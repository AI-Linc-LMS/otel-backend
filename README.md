# OTEL Backend

Node.js server with MongoDB for storing traces (OpenTelemetry-compatible).

## Prerequisites

- Node.js 18+
- MongoDB (local or Atlas)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy `env.example` to `.env` and configure:

```
PORT=3000
MONGODB_URI=mongodb://localhost:27017/otel-traces
```

3. Start the server:

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/traces` | Store a single trace |
| POST | `/api/traces/batch` | Store multiple traces |
| GET | `/api/traces` | List traces (supports `traceId`, `serviceName`, `startTime`, `endTime`, `limit`) |
| GET | `/api/traces/trace/:traceId` | Get all spans for a trace |
| GET | `/api/traces/table` | Paginated table data for Next.js (see below) |
| GET | `/api/traces/:id` | Get trace by MongoDB _id |
| GET | `/health` | Health check |

### Table endpoint (for Next.js)

`GET /api/traces/table` returns paginated, sortable rows for a data table.

**Query params:** `page`, `limit` (max 100), `sortBy` (e.g. `startTime`, `name`, `duration`), `order` (`asc`|`desc`), `traceId`, `serviceName`, `startTime`, `endTime`.

**Response:**
```json
{
  "data": [
    {
      "id", "traceId", "spanId", "parentSpanId", "name", "kind",
      "serviceName", "startTime", "endTime", "duration",
      "statusCode", "statusMessage", "attributes", "createdAt"
    }
  ],
  "total": 100,
  "page": 1,
  "limit": 20,
  "totalPages": 5
}
```

## Trace Schema

Each trace (span) document includes:

- `traceId`, `spanId`, `parentSpanId` – OpenTelemetry identifiers
- `name`, `kind` – span metadata
- `startTime`, `endTime`, `duration` – timing
- `attributes`, `events` – key-value data
- `status` – code and message
- `resource`, `serviceName` – resource info

## Example: Store a trace

```bash
curl -X POST http://localhost:3000/api/traces \
  -H "Content-Type: application/json" \
  -d '{
    "traceId": "abc123",
    "spanId": "span001",
    "name": "http.request",
    "startTime": "2025-03-14T10:00:00.000Z",
    "endTime": "2025-03-14T10:00:00.150Z",
    "attributes": [{"key": "http.method", "value": "GET"}]
  }'
```

## Netlify deployment

The app runs as a serverless function on Netlify. Set `MONGODB_URI` in the site’s environment variables. All routes are proxied to `/.netlify/functions/server`.
