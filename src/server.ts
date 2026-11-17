import { createApp } from './app';
import { getConfig } from './common/config';
import { getPrisma } from './common/db';
import { logger } from './common/logger';

export function startServer() {
  const config = getConfig();
  if (config.ALLOW_PRIVATE_ENDPOINTS) {
    logger.warn(
      'ALLOW_PRIVATE_ENDPOINTS=true: SSRF protection is off. Use only for local development.',
    );
  }
  const server = createApp().listen(config.PORT, () => {
    logger.info(`API listening on port ${config.PORT}`);
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => {
      void getPrisma()
        .$disconnect()
        .finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  startServer();
}
