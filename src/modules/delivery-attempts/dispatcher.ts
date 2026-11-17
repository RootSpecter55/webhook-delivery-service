import type { DbContext } from '../../common/db';
import { logger } from '../../common/logger';
import type { EndpointRepository } from '../endpoints/endpoints.repository';
import type {
  AttemptRepository,
  DeliveryRepository,
  DispatchableDelivery,
} from './delivery-attempts.repository';
import { classify, retryDelayMs } from './retry-policy';
import { webhookHeaders } from './signature';
import type { SendResult, WebhookSender } from './webhook-sender';

export type DispatcherOptions = {
  batchSize: number;
  leaseSeconds: number;
  timeoutMs: number;
  retryScheduleSeconds: readonly number[];
  retryJitter: number;
  circuitBreakerThreshold: number;
};

/**
 * The worker's job: claim due deliveries, send them, record what happened. Several dispatchers
 * (in one process or many) can run at once; claiming makes sure each delivery goes to one.
 */
export class Dispatcher {
  constructor(
    private readonly db: DbContext,
    private readonly deliveries: DeliveryRepository,
    private readonly attempts: AttemptRepository,
    private readonly endpoints: EndpointRepository,
    private readonly sender: WebhookSender,
    private readonly options: DispatcherOptions,
  ) {}

  /** Claims and sends one batch. Returns the ids it handled. */
  async runOnce(): Promise<string[]> {
    const db = this.db.client();
    const ids = await this.deliveries.claimDue(
      db,
      this.options.batchSize,
      this.options.leaseSeconds,
    );
    if (ids.length === 0) return [];

    const batch = await this.deliveries.findForDispatch(db, ids, new Date());
    await Promise.all(batch.map((delivery) => this.deliver(delivery)));
    return ids;
  }

  private async deliver(delivery: DispatchableDelivery): Promise<void> {
    const { message, endpoint } = delivery;
    const body = JSON.stringify({
      id: message.id,
      type: message.eventType,
      createdAt: message.createdAt.toISOString(),
      data: message.payload,
    });
    const secrets = endpoint.secrets.map((s) => s.secret);
    const result = await this.sender.send({
      url: endpoint.url,
      headers: webhookHeaders(secrets, message.id, body),
      body,
      timeoutMs: this.options.timeoutMs,
    });
    await this.record(delivery, result);
  }

  /** Stores the attempt and moves the delivery and endpoint on, in one transaction. */
  async record(delivery: DispatchableDelivery, result: SendResult): Promise<void> {
    const now = new Date();
    const attemptNumber = delivery.attemptCount + 1;
    const outcome = classify(result.statusCode);

    await this.db.transaction(async (tx) => {
      await this.attempts.create(tx, {
        deliveryId: delivery.id,
        attemptNumber,
        statusCode: result.statusCode ?? null,
        durationMs: result.durationMs,
        responseBody: result.responseBody ?? null,
        error: result.error ?? null,
        succeeded: outcome === 'success',
      });
      const progress = { attemptCount: attemptNumber, lastAttemptAt: now };

      if (outcome === 'success') {
        await this.deliveries.update(tx, delivery.id, {
          ...progress,
          status: 'SUCCEEDED',
          completedAt: now,
        });
        await this.endpoints.resetFailures(tx, delivery.endpointId);
        return;
      }

      if (outcome === 'gone') {
        await this.deliveries.update(tx, delivery.id, {
          ...progress,
          status: 'FAILED',
          completedAt: now,
        });
        if (await this.endpoints.disable(tx, delivery.endpointId, 'GONE')) {
          logger.warn({ endpointId: delivery.endpointId }, 'Endpoint answered 410, disabled');
        }
        return;
      }

      const delay = retryDelayMs(
        attemptNumber,
        this.options.retryScheduleSeconds,
        this.options.retryJitter,
      );
      await this.deliveries.update(
        tx,
        delivery.id,
        delay === null
          ? { ...progress, status: 'FAILED', completedAt: now }
          : { ...progress, nextAttemptAt: new Date(now.getTime() + delay) },
      );

      // Circuit breaker: an endpoint that keeps failing is switched off until someone re-enables it.
      const failures = await this.endpoints.incrementFailures(tx, delivery.endpointId);
      if (
        failures >= this.options.circuitBreakerThreshold &&
        (await this.endpoints.disable(tx, delivery.endpointId, 'FAILING'))
      ) {
        logger.warn(
          { endpointId: delivery.endpointId, failures },
          'Endpoint keeps failing, disabled',
        );
      }
    });
  }
}
