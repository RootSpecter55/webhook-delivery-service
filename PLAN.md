# PLAN — webhook-delivery-service

A service other apps call to send webhooks to their own customers. An application registers endpoints (URL plus the event types it wants), then posts messages. The service fans each message out to every subscribed endpoint, signs each request, retries failures on a fixed schedule with jitter, disables endpoints that are gone or keep failing, and stores every attempt.

**Stack:** Node 24, TypeScript 5.9 (strict), Express 5, Prisma 7 (`@prisma/adapter-pg`), Zod 4, pino, Jest 30 with Supertest, ESLint and Prettier, PostgreSQL 16. Redis isn't used: the delivery queue is a Postgres table, which the spec asks for.

## Modules

| Module            | Responsibility                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| applications      | Admin creates applications. Each gets an API key, returned once and stored as a SHA-256 hash. The key authenticates every other call.                                                                                                  |
| endpoints         | CRUD for an application's endpoints (URL, event types, description), plus reading the signing secret, rotating it with a grace period, enabling and disabling, and replaying failed deliveries since a time. URLs pass the SSRF check. |
| messages          | `POST /messages` stores the message and creates one delivery row per enabled, subscribed endpoint, in one transaction. An optional idempotency key prevents duplicate messages. Lists messages and replays one.                        |
| delivery-attempts | The dispatcher (used by the worker): claims due deliveries, signs and sends them, records the attempt, schedules a retry or finishes. Also lists deliveries and attempts.                                                              |

**Shared code (`src/common/`):** config, logger, errors and the error handler, the `validate` middleware, pagination, auth middleware (admin key and application key), base repository, Prisma client and transactions, response helpers.

**Entrypoints:** `src/server.ts` (API) and `src/worker.ts` (dispatcher loop with `/health`). Both run from the same image as separate compose services, and the worker runs as two replicas in compose.

**Test receiver (`receiver/`):** a small HTTP server that verifies signatures and can be told to fail (`POST /control {"status": 503}`). It lists what it received. `receiver/verify-signature.ts` is the dependency-free verification code a customer would copy.

## Data model

```
Application     id, name, apiKeyHash (unique), apiKeyPrefix, createdAt
Endpoint        id, applicationId, url, description?, eventTypes text[], status (ENABLED|DISABLED),
                disabledReason? (GONE|FAILING|MANUAL), consecutiveFailures, createdAt, updatedAt
EndpointSecret  id, endpointId, secret, createdAt, expiresAt?        (expiresAt null = current secret)
Message         id, applicationId, eventType, payload (json), idempotencyKey?, createdAt
                unique(applicationId, idempotencyKey)
Delivery        id, messageId, endpointId, status (PENDING|SUCCEEDED|FAILED), attemptCount,
                nextAttemptAt, lastAttemptAt?, completedAt?, createdAt    index(status, nextAttemptAt)
DeliveryAttempt id, deliveryId, attemptNumber, statusCode?, durationMs, responseBody? (≤1 KB), error?,
                succeeded, createdAt
```

All timestamps are `timestamptz`, so they compare correctly with `now()` in the claim query.

## Mechanisms

**Claiming with SKIP LOCKED.** One statement claims a batch of due deliveries:

```sql
UPDATE deliveries SET next_attempt_at = now() + <lease>
WHERE id IN (SELECT d.id FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id
             WHERE d.status = 'PENDING' AND d.next_attempt_at <= now() AND e.status = 'ENABLED'
             ORDER BY d.next_attempt_at LIMIT $n FOR UPDATE OF d SKIP LOCKED)
RETURNING id
```

A second worker skips rows the first has locked, so no delivery is claimed twice. Pushing `next_attempt_at` forward acts as a lease: if a worker dies mid-send, the row becomes due again when the lease runs out.

**Signing.** Every request carries three headers:

- `webhook-id`: the message id, the same on every retry, so receivers can deduplicate.
- `webhook-timestamp`: Unix seconds.
- `webhook-signature`: `v1,<base64 HMAC-SHA256(secret, "id.timestamp.body")>`, one entry per active secret, space-separated.

**Secret rotation:** the old secret gets `expiresAt = now + grace` and a new current secret is created. During the grace period both sign, so a receiver that hasn't switched yet still verifies.

**Retries.** The default schedule after the first attempt is 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, each with ±20% jitter. Outcomes:

| Response                                | Result                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 2xx                                     | Delivery SUCCEEDED; the endpoint's failure counter resets.                                                                |
| 410 Gone                                | Delivery FAILED; endpoint DISABLED (`GONE`).                                                                              |
| Anything else (incl. timeout, 3xx)      | Retry at the next slot, or FAILED once the schedule is used up.                                                           |
| Consecutive failed attempts ≥ threshold | Endpoint DISABLED (`FAILING`). This is the circuit breaker. Its pending deliveries wait and resume when it is re-enabled. |

Redirects are not followed, so a redirect can't be used to reach an internal address.

**SSRF protection:**

- When an endpoint is created or updated, the hostname is resolved and rejected if any address is private, loopback, link-local, CGNAT, multicast or unspecified (IPv4, IPv6 and IPv4-mapped IPv6), using `net.BlockList`.
- When sending, the same check runs inside the HTTP client's DNS `lookup` hook, against the address actually being connected to. That covers DNS rebinding.
- `ALLOW_PRIVATE_ENDPOINTS=true` turns both checks off for local development only (the compose receiver lives on a private Docker network).

**Replay:** `POST /messages/:id/replay` (optionally for one endpoint) and `POST /endpoints/:id/replay-failed {since}` create new delivery rows. History stays intact.

## Endpoints

Envelope: `{ data, meta? }` / `{ error: { code, message, details? } }`. Every list is paginated. `[admin]` is the admin key; everything else uses the application's API key and only sees that application's data.

```
GET    /health
POST   /applications                          [admin]  returns the API key once
GET    /applications                          [admin]
POST   /endpoints
GET    /endpoints
GET    /endpoints/:id
PATCH  /endpoints/:id
DELETE /endpoints/:id
GET    /endpoints/:id/secret
POST   /endpoints/:id/rotate-secret
POST   /endpoints/:id/enable
POST   /endpoints/:id/disable
POST   /endpoints/:id/replay-failed           {since}
POST   /messages                              202, fans out
GET    /messages
GET    /messages/:id
POST   /messages/:id/replay                   {endpointId?}
GET    /deliveries                            ?messageId=&endpointId=&status=
GET    /deliveries/:id
GET    /deliveries/:id/attempts
```

## Tests that prove it

- **Two workers:** two dispatchers drain 40 deliveries concurrently. Each delivery is attempted exactly once, the receiver gets 40 requests, and the two claimed sets don't overlap.
- **Signing:** signatures produced by the service verify with the customer example code. During rotation both the old and the new secret verify; after the grace period only the new one does. Stale timestamps are rejected.
- **Retries:** 500 then 200 gives SUCCEEDED after 2 attempts; an exhausted schedule gives FAILED; the jitter stays within bounds (unit).
- **410** disables the endpoint. **Circuit breaker:** N consecutive failures disable it; re-enabling resumes its pending deliveries.
- **Attempts** store the status code, duration and a body truncated to 1 KB.
- **SSRF:** loopback, private, link-local and metadata addresses are rejected unless the flag is set; a send-time lookup to a private address is blocked.
- **Replay** of one message and of failed deliveries since a time.
- **Unit:** retry policy, signatures, address classification, config, `start-with-secrets`.

## Build order

1. Scaffold. 2. Common layer and schema. 3. applications. 4. endpoints and SSRF. 5. messages and fan-out. 6. delivery-attempts: dispatcher, signing, retries, circuit breaker. 7. Worker entrypoint and receiver. 8. Tests. 9. Deployment files. 10. README.
