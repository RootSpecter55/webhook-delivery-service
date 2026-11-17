import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { getConfig } from './common/config';
import { getPrisma } from './common/db';
import { logger } from './common/logger';
import { buildContainer } from './container';

/** If the loop has not finished an iteration for this long, /health fails. */
const STALE_AFTER_MS = 60_000;

/**
 * Worker entrypoint: claims and sends deliveries in a loop. Run as many copies as needed;
 * claiming with SKIP LOCKED keeps them from sending the same delivery. Serves only GET /health.
 */
export function startWorker() {
  const config = getConfig();
  if (config.ALLOW_PRIVATE_ENDPOINTS) {
    logger.warn(
      'ALLOW_PRIVATE_ENDPOINTS=true: SSRF protection is off. Use only for local development.',
    );
  }
  const dispatcher = buildContainer().createDispatcher();
  let lastTick = Date.now();
  let running = true;

  const loop = (async () => {
    while (running) {
      try {
        const handled = await dispatcher.runOnce();
        lastTick = Date.now();
        if (handled.length === 0) await sleep(config.POLL_INTERVAL_MS);
      } catch (err) {
        logger.error({ err }, 'Dispatch failed, retrying');
        await sleep(1000);
      }
    }
  })();

  const health = createServer((req, res) => {
    const ok = Date.now() - lastTick < STALE_AFTER_MS;
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        ok
          ? { data: { status: 'ok' } }
          : { error: { code: 'UNHEALTHY', message: 'Dispatch loop is stuck' } },
      ),
    );
  });
  health.listen(config.PORT, () => logger.info(`Worker running, health on port ${config.PORT}`));

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, finishing the current batch`);
    running = false;
    await loop;
    health.close();
    await getPrisma().$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  startWorker();
}
