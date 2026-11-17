/**
 * Measures delivery throughput against a running stack (API, workers and the test receiver).
 *
 *   docker compose up --build
 *   npm run bench:delivery                                  # 500 messages
 *   MESSAGES=2000 API_URL=http://host:3000 RECEIVER_URL=http://host:4000 npm run bench:delivery
 *
 * 1. Creates an application and one endpoint pointing at the receiver, and gives the receiver
 *    the endpoint's secret so every request is verified.
 * 2. Posts MESSAGES messages, CONCURRENCY at a time.
 * 3. Polls until every delivery is SUCCEEDED or FAILED, then prints counts, time taken and
 *    deliveries per second.
 *
 * The receiver answers immediately, so this measures the service and workers, not a slow
 * customer endpoint. Everything runs on one machine: the numbers describe this setup only.
 */
import { performance } from 'node:perf_hooks';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const RECEIVER_URL = process.env.RECEIVER_URL ?? 'http://localhost:4000';
/** The receiver URL as the workers see it (inside the compose network). */
const ENDPOINT_URL = process.env.ENDPOINT_URL ?? 'http://receiver:4000/hooks';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? 'change-me-admin-api-key';
const MESSAGES = Number(process.env.MESSAGES ?? 500);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 300_000);

async function call<T>(url: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
  });
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${url} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function countDeliveries(apiKey: string, status: string): Promise<number> {
  const page = await call<{ meta: { total: number } }>(
    `${API_URL}/deliveries?status=${status}&pageSize=1`,
    { token: apiKey },
  );
  return page.meta.total;
}

async function main() {
  const { data: app } = await call<{ data: { apiKey: string } }>(`${API_URL}/applications`, {
    method: 'POST',
    token: ADMIN_API_KEY,
    body: JSON.stringify({ name: `bench-${Date.now()}` }),
  });
  const { data: endpoint } = await call<{ data: { secret: string } }>(`${API_URL}/endpoints`, {
    method: 'POST',
    token: app.apiKey,
    body: JSON.stringify({ url: ENDPOINT_URL, eventTypes: ['bench.event'] }),
  });
  await call(`${RECEIVER_URL}/control`, {
    method: 'POST',
    body: JSON.stringify({ secrets: [endpoint.secret], status: 200 }),
  });

  const started = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < MESSAGES) {
        const n = next++;
        await call(`${API_URL}/messages`, {
          method: 'POST',
          token: app.apiKey,
          body: JSON.stringify({ eventType: 'bench.event', payload: { n } }),
        });
      }
    }),
  );
  const postedSeconds = (performance.now() - started) / 1000;

  let succeeded = 0;
  let failed = 0;
  while (performance.now() - started < TIMEOUT_MS) {
    succeeded = await countDeliveries(app.apiKey, 'SUCCEEDED');
    failed = await countDeliveries(app.apiKey, 'FAILED');
    if (succeeded + failed >= MESSAGES) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const totalSeconds = (performance.now() - started) / 1000;

  console.log(`messages: ${MESSAGES}, concurrency: ${CONCURRENCY}`);
  console.log(`posted in ${postedSeconds.toFixed(1)} s`);
  console.log(
    `succeeded: ${succeeded}, failed: ${failed}, unfinished: ${MESSAGES - succeeded - failed}`,
  );
  console.log(`all finished after ${totalSeconds.toFixed(1)} s`);
  console.log(`throughput: ${((succeeded + failed) / totalSeconds).toFixed(1)} deliveries/s`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
