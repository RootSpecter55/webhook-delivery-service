import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { errorHandler, notFoundHandler } from './common/error-handler';
import { logger } from './common/logger';
import { sendData } from './common/response';
import { buildContainer, type Container } from './container';
import { applicationsRoutes } from './modules/applications/applications.routes';
import { deliveryAttemptsRoutes } from './modules/delivery-attempts/delivery-attempts.routes';
import { endpointsRoutes } from './modules/endpoints/endpoints.routes';
import { messagesRoutes } from './modules/messages/messages.routes';

export function createApp(container: Container = buildContainer()): Express {
  const { controllers: c, requireAdmin, authenticate } = container;
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => sendData(res, { status: 'ok' }));

  app.use('/applications', applicationsRoutes(c.applications, requireAdmin));
  app.use('/endpoints', endpointsRoutes(c.endpoints, authenticate));
  app.use('/messages', messagesRoutes(c.messages, authenticate));
  app.use('/deliveries', deliveryAttemptsRoutes(c.deliveryAttempts, authenticate));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
