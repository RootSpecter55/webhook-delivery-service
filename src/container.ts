import { createAdminAuth, createApplicationAuth } from './common/auth-middleware';
import { getConfig, type Config } from './common/config';
import { dbContext } from './common/db';
import type { Resolve } from './common/url-safety';
import { ApplicationsController } from './modules/applications/applications.controller';
import { ApplicationRepository } from './modules/applications/applications.repository';
import { ApplicationsService } from './modules/applications/applications.service';
import { DeliveryAttemptsController } from './modules/delivery-attempts/delivery-attempts.controller';
import {
  AttemptRepository,
  DeliveryRepository,
} from './modules/delivery-attempts/delivery-attempts.repository';
import { DeliveryAttemptsService } from './modules/delivery-attempts/delivery-attempts.service';
import { Dispatcher } from './modules/delivery-attempts/dispatcher';
import { HttpWebhookSender, type WebhookSender } from './modules/delivery-attempts/webhook-sender';
import { EndpointsController } from './modules/endpoints/endpoints.controller';
import {
  EndpointRepository,
  EndpointSecretRepository,
} from './modules/endpoints/endpoints.repository';
import { EndpointsService } from './modules/endpoints/endpoints.service';
import { MessagesController } from './modules/messages/messages.controller';
import { MessageRepository } from './modules/messages/messages.repository';
import { MessagesService } from './modules/messages/messages.service';

/** Tests replace config values, the DNS resolver or the sender here instead of patching modules. */
export type ContainerOverrides = {
  config?: Partial<Config>;
  resolve?: Resolve;
  sender?: WebhookSender;
};

/** Composition root: builds every repository, service and controller in one place. */
export function buildContainer(overrides: ContainerOverrides = {}) {
  const config: Config = { ...getConfig(), ...overrides.config };

  const repos = {
    applications: new ApplicationRepository(),
    endpoints: new EndpointRepository(),
    secrets: new EndpointSecretRepository(),
    messages: new MessageRepository(),
    deliveries: new DeliveryRepository(),
    attempts: new AttemptRepository(),
  };

  const services = {
    applications: new ApplicationsService(dbContext, repos.applications),
    endpoints: new EndpointsService(dbContext, repos.endpoints, repos.secrets, repos.deliveries, {
      allowPrivateEndpoints: config.ALLOW_PRIVATE_ENDPOINTS,
      rotationGraceHours: config.SECRET_ROTATION_GRACE_HOURS,
      resolve: overrides.resolve,
    }),
    messages: new MessagesService(dbContext, repos.messages, repos.endpoints, repos.deliveries),
    deliveryAttempts: new DeliveryAttemptsService(dbContext, repos.deliveries, repos.attempts),
  };

  /** The worker's dispatcher. Each call returns an independent one, as a second worker would be. */
  function createDispatcher() {
    return new Dispatcher(
      dbContext,
      repos.deliveries,
      repos.attempts,
      repos.endpoints,
      overrides.sender ?? new HttpWebhookSender(config.ALLOW_PRIVATE_ENDPOINTS),
      {
        batchSize: config.DELIVERY_BATCH_SIZE,
        leaseSeconds: config.DELIVERY_LEASE_SECONDS,
        timeoutMs: config.DELIVERY_TIMEOUT_MS,
        retryScheduleSeconds: config.RETRY_SCHEDULE_SECONDS,
        retryJitter: config.RETRY_JITTER,
        circuitBreakerThreshold: config.CIRCUIT_BREAKER_THRESHOLD,
      },
    );
  }

  return {
    config,
    repos,
    services,
    createDispatcher,
    requireAdmin: createAdminAuth(config.ADMIN_API_KEY),
    authenticate: createApplicationAuth(services.applications.resolve),
    controllers: {
      applications: new ApplicationsController(services.applications),
      endpoints: new EndpointsController(services.endpoints),
      messages: new MessagesController(services.messages),
      deliveryAttempts: new DeliveryAttemptsController(services.deliveryAttempts),
    },
  };
}

export type Container = ReturnType<typeof buildContainer>;
