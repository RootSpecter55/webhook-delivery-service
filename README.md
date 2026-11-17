# webhook-delivery-service

A service other applications call to send webhooks to their own customers. An application registers endpoints (a URL plus the event types it wants) and posts messages. The service:

- fans each message out to every subscribed endpoint;
- signs every request;
- retries failures on a fixed schedule with jitter;
- disables endpoints that are gone or keep failing;
- stores every attempt.

The interesting parts:

- **Workers claim deliveries with `SELECT … FOR UPDATE SKIP LOCKED`.** Any number of workers can run without two of them sending the same delivery.
- **HMAC-SHA256 signatures over `id.timestamp.body`.** Secret rotation keeps the old secret signing for a grace period.
- **A circuit breaker.**
- **SSRF protection,** checked both when the URL is saved and again at connect time.

**What runs where:** everything runs locally with Docker, with no cloud account or API keys. The compose stack includes a small test receiver that verifies signatures and can be told to fail. The project is **not deployed**.

**Stack:** Node 24, TypeScript (strict), Express 5, Prisma 7, PostgreSQL 16, Zod, Jest + Supertest, ESLint + Prettier. No Redis: the delivery queue is a Postgres table.

## Architecture

```mermaid
flowchart LR
  App[Your application] -->|"POST /messages<br/>Bearer whk_…"| API

  subgraph API["API process"]
    direction TB
    R[routes → controllers] --> SV[services]
  end
  SV -->|"one transaction:<br/>message + one delivery per<br/>subscribed endpoint"| PG[(PostgreSQL)]

  subgraph Workers["Worker processes (same codebase, N replicas)"]
    W1[Dispatcher 1]
    W2[Dispatcher 2]
  end
  PG -->|"claim due rows<br/>FOR UPDATE SKIP LOCKED"| W1 & W2
  W1 & W2 -->|"signed POST<br/>(guarded DNS lookup)"| C[Customer endpoints]
  W1 & W2 -->|"attempt row,<br/>retry or finish,<br/>circuit breaker"| PG
```

```
src/
  common/      config, logger, errors + handler, validate, pagination, auth (admin key and
               application key), url-safety (SSRF), db, base repository, response helpers
  modules/     applications, endpoints, messages,
               delivery-attempts (dispatcher, signature, retry policy, HTTP sender)
  container.ts composition root
  app.ts       HTTP API          server.ts  API entrypoint        worker.ts  worker entrypoint
receiver/      verify-signature.ts (customer example), server.ts (local test receiver)
scripts/       start-with-secrets.ts (container entrypoint), delivery-throughput.ts
tests/         unit/ (pure functions, services with mocked repositories), integration/ (real Postgres)
```

Each feature module has `routes → controller → service → repository` plus its own Zod `schemas`. The dispatcher is a service: it sends through a `WebhookSender` interface and stores results through repositories.

## Data model

```mermaid
erDiagram
  applications ||--o{ endpoints : owns
  applications ||--o{ messages : sends
  endpoints ||--|{ endpoint_secrets : "signs with"
  messages ||--o{ deliveries : "fans out to"
  endpoints ||--o{ deliveries : receives
  deliveries ||--o{ delivery_attempts : records

  applications {
    uuid id PK
    string name
    string api_key_hash UK "sha256"
    string api_key_prefix
  }
  endpoints {
    uuid id PK
    uuid application_id FK
    string url
    text_array event_types
    enum status "ENABLED or DISABLED"
    string disabled_reason "GONE, FAILING or MANUAL"
    int consecutive_failures
  }
  endpoint_secrets {
    uuid id PK
    uuid endpoint_id FK
    string secret
    timestamptz expires_at "null = current"
  }
  messages {
    uuid id PK
    uuid application_id FK
    string event_type
    json payload
    string idempotency_key "unique per application"
  }
  deliveries {
    uuid id PK
    uuid message_id FK
    uuid endpoint_id FK
    enum status "PENDING, SUCCEEDED or FAILED"
    int attempt_count
    timestamptz next_attempt_at "also the claim lease"
  }
  delivery_attempts {
    uuid id PK
    uuid delivery_id FK
    int attempt_number
    int status_code
    int duration_ms
    string response_body "first 1 KB"
    string error
  }
```

## Run it

Requires Docker.

```bash
cp .env.example .env      # ALLOW_PRIVATE_ENDPOINTS=true, so endpoints can point at the compose receiver
docker compose up --build
```

This starts Postgres (host port **5447**), runs migrations, then starts the **api** on <http://localhost:3000>, **two worker replicas** and the **test receiver** on <http://localhost:4000>.

```bash
J='Content-Type: application/json'
KEY=$(curl -s localhost:3000/applications -H 'Authorization: Bearer change-me-admin-api-key' -H "$J" \
  -d '{"name":"Acme"}' | jq -r .data.apiKey)
A="Authorization: Bearer $KEY"

# An endpoint pointing at the receiver (by its compose hostname); the response includes the secret
SECRET=$(curl -s localhost:3000/endpoints -H "$A" -H "$J" \
  -d '{"url":"http://receiver:4000/hooks","eventTypes":["invoice.paid"]}' | jq -r .data.secret)

# Tell the receiver the secret, so it can verify signatures
curl -s localhost:4000/control -H "$J" -d "{\"secrets\":[\"$SECRET\"]}"

curl -s localhost:3000/messages -H "$A" -H "$J" -d '{"eventType":"invoice.paid","payload":{"invoiceId":"inv_1"}}'
curl -s localhost:4000/received | jq '.data[0]'          # {"type":"invoice.paid","verified":true,"answered":200,…}

# Make the receiver fail, then watch the retry (first retry after ~5 s)
curl -s localhost:4000/control -H "$J" -d '{"status":503}'
curl -s "localhost:3000/deliveries?status=PENDING" -H "$A" | jq '.data[] | {attemptCount, nextAttemptAt}'
curl -s localhost:4000/control -H "$J" -d '{"status":200}'

# 410 Gone disables the endpoint
curl -s localhost:4000/control -H "$J" -d '{"status":410}'
```

### Verifying a webhook (customer side)

`receiver/verify-signature.ts` is the code a customer would copy. It needs only `node:crypto`:

```ts
import { verifyWebhook } from './verify-signature';

// rawBody: the request body exactly as received (not re-serialised JSON)
if (!verifyWebhook([process.env.WEBHOOK_SECRET!], req.headers, rawBody)) {
  return res.status(401).end();
}
```

It checks three things:

1. The timestamp is within 5 minutes.
2. It recomputes `HMAC-SHA256(secret, "<webhook-id>.<webhook-timestamp>.<body>")`.
3. The result matches any `v1,<base64>` entry in `webhook-signature`, compared in constant time.

### Tests and lint

```bash
docker compose up -d postgres   # tests use the webhooks_test database, created automatically
npm ci
npm run lint
npm test                        # unit + integration
```

Integration tests start the real receiver in-process on a random port and call `dispatcher.runOnce()` directly, so they don't depend on timing.

## Endpoints

Every response uses one envelope: `{ "data": … }`, plus `"meta": { page, pageSize, total, totalPages }` on lists. Errors are `{ "error": { "code", "message", "details"? } }`. Every list takes `?page=&pageSize=` (max 100). Bodies, query strings and path params are all validated. **admin** is the admin key; everything else uses the application's API key and only sees that application's data (other applications' ids give 404).

| Method | Path                                 | Access | Notes                                                                                      |
| ------ | ------------------------------------ | ------ | ------------------------------------------------------------------------------------------ |
| GET    | `/health`                            | public |                                                                                            |
| POST   | `/applications`                      | admin  | Returns the API key once                                                                   |
| GET    | `/applications`                      | admin  |                                                                                            |
| POST   | `/endpoints`                         | app    | `{url, eventTypes[], description?}`; SSRF-checked; returns the secret                      |
| GET    | `/endpoints` · `/endpoints/:id`      | app    | `?status=`                                                                                 |
| PATCH  | `/endpoints/:id`                     | app    | URL changes are SSRF-checked again                                                         |
| DELETE | `/endpoints/:id`                     | app    |                                                                                            |
| GET    | `/endpoints/:id/secret`              | app    | The current signing secret                                                                 |
| POST   | `/endpoints/:id/rotate-secret`       | app    | New secret; the old one keeps signing for the grace period                                 |
| POST   | `/endpoints/:id/enable` · `/disable` | app    | Enabling resets the failure count                                                          |
| POST   | `/endpoints/:id/replay-failed`       | app    | `{since}`: new deliveries for failed messages since then                                   |
| POST   | `/messages`                          | app    | 202. `{eventType, payload, idempotencyKey?}`; a repeated key returns 200 with the original |
| GET    | `/messages` · `/messages/:id`        | app    | `?eventType=`                                                                              |
| POST   | `/messages/:id/replay`               | app    | `{endpointId?}`                                                                            |
| GET    | `/deliveries` · `/deliveries/:id`    | app    | `?messageId=&endpointId=&status=`                                                          |
| GET    | `/deliveries/:id/attempts`           | app    | Status code, duration, first 1 KB of the body, error                                       |

## Key design decisions

**A Postgres table as the queue, claimed with SKIP LOCKED.** Deliveries are rows. `DeliveryRepository.claimDue()` claims a batch in one statement: `UPDATE … WHERE id IN (SELECT … FOR UPDATE OF d SKIP LOCKED) RETURNING id`. A concurrent worker skips locked rows instead of waiting for them or taking them too. The claim also moves `next_attempt_at` forward by the lease (60 s), which hides the row until this worker records an outcome. If the worker dies mid-send, the row becomes due again when the lease runs out. No separate broker is needed, and fan-out is atomic with the message insert. `tests/integration/two-workers.test.ts` runs two dispatchers over 40 deliveries and checks each one was claimed and attempted exactly once.

**Signatures.** Each request carries:

- `webhook-id`: the message id, the same on every retry, so receivers can deduplicate.
- `webhook-timestamp`.
- `webhook-signature: v1,<base64>`.

The signature is HMAC-SHA256 over `id.timestamp.body`, with the header names of the Standard Webhooks spec. The timestamp lets receivers reject replays of old requests. A unit test checks the signature against a vector computed independently with `openssl`.

**Rotation without downtime.** Each secret is a row. Rotating sets `expires_at = now + SECRET_ROTATION_GRACE_HOURS` on the current secret and adds a new one. The worker signs with every unexpired secret, so `webhook-signature` holds two entries during the grace period. A receiver still configured with either secret verifies successfully.

**Retries, 410 and the circuit breaker** (`Dispatcher.record`, one transaction per attempt):

- **2xx:** the delivery is done and the endpoint's failure count resets.
- **410 Gone:** the delivery fails and the endpoint is disabled (`GONE`).
- **Anything else** (timeouts, network errors and redirects included): the next retry is scheduled from `RETRY_SCHEDULE_SECONDS` (default 5 s, 5 min, 30 min, 2 h, 5 h, 10 h) ±`RETRY_JITTER`. When the schedule is used up, the delivery fails.

Every failure also increments the endpoint's consecutive-failure count atomically. At `CIRCUIT_BREAKER_THRESHOLD` the endpoint is disabled (`FAILING`). Its pending deliveries stay pending, and they resume when someone re-enables it.

**SSRF protection in two places** (`src/common/url-safety.ts`):

- **When a URL is saved:** the hostname is resolved, and the URL is rejected if any address is loopback, private, link-local (including the 169.254.169.254 metadata address), CGNAT, multicast, reserved or NAT64. The check uses `net.BlockList`, which also catches IPv4-mapped IPv6 forms.
- **When sending:** the same check runs inside the HTTP client's DNS `lookup` hook, for the address actually being connected to. A hostname that later starts pointing inside the network (DNS rebinding) is still refused. IP-literal URLs skip DNS, so they are checked directly.

Redirects are never followed, and only the first 1 KB of a response is read. `ALLOW_PRIVATE_ENDPOINTS=true` turns the checks off, for local development only: the compose receiver lives on a private Docker network. The API and worker log a warning when it is on, and the ECS templates set it to `false`.

**API keys and secrets.** Application API keys are random 192-bit values stored as SHA-256 hashes: a fast hash is fine for high-entropy keys, and lookup is by hash. Endpoint signing secrets have to be readable to sign with, so they are stored as-is (see limitations).

**Patterns, only where they earn their place.**

- _Singleton:_ the Prisma client and config.
- _Repository:_ all data access.

There is no factory: there is one sender implementation, and tests swap it through the composition root. There is no state-machine table either: a delivery only moves from PENDING to SUCCEEDED or FAILED, and the endpoint only toggles between ENABLED and DISABLED.

## Results

Not yet measured, run `npm run bench:delivery`.

## Known limitations

- **Signing secrets are stored in plain text** in `endpoint_secrets`, because they must be readable to sign with. A production system would encrypt them with a KMS key.
- **At-least-once delivery.** If a worker sends successfully but dies before recording the outcome, the lease expires and the delivery is sent again. Receivers should deduplicate on `webhook-id`.
- **No ordering guarantee** between messages to the same endpoint: retries and parallel workers can reorder them.
- **The circuit breaker counts consecutive failed attempts** and has no half-open state. Re-enabling is manual, through `POST /endpoints/:id/enable`.
- **No per-endpoint rate limiting.** A burst of messages is sent as fast as workers can claim them.
- **The test receiver is shipped in the same image** for convenience. It is only started by docker-compose, never by the ECS templates.
- **Old attempts and deliveries are never pruned.**
- **The deploy workflow and ECS templates have never been run.**

## Deployment

| File                                     | Purpose                                                                                                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                             | Multi-stage build: compiles TypeScript, then ships production dependencies and `dist/` only. Runs as the non-root `node` user, with a healthcheck on `/health`. The same image runs the API and, with the `worker` argument, the worker.                        |
| `scripts/start-with-secrets.ts`          | Container entrypoint. With `SECRETS_SOURCE=aws` it loads one JSON secret (`SECRET_ID`) from AWS Secrets Manager into the environment; with `local` it uses `.env`. It fails fast if the secret or a required key is missing, then starts the API or the worker. |
| `deploy/ecs-task-definition.json`        | ECS Fargate task definition template for the API, with `${…}` placeholders for account id, region, image tag, role ARNs and secret id. `ALLOW_PRIVATE_ENDPOINTS` is `false`.                                                                                    |
| `deploy/ecs-task-definition.worker.json` | The same for the worker, a separate service that can run several tasks at once.                                                                                                                                                                                 |
| `.github/workflows/deploy.yml`           | Manual-only (`workflow_dispatch`) workflow. It assumes an AWS role through GitHub OIDC (no stored keys), builds and pushes the image to ECR, fills in both task definitions with `envsubst` and updates both ECS services.                                      |
| `.github/workflows/ci.yml`               | Runs lint, typecheck and the full test suite against a Postgres service container on every push and pull request.                                                                                                                                               |

Deployment config is provided as a reference. This project has not been deployed.
