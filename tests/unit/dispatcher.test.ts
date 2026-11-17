import type {
  AttemptRepository,
  DeliveryRepository,
  DispatchableDelivery,
} from '../../src/modules/delivery-attempts/delivery-attempts.repository';
import { Dispatcher } from '../../src/modules/delivery-attempts/dispatcher';
import type { WebhookSender } from '../../src/modules/delivery-attempts/webhook-sender';
import type { EndpointRepository } from '../../src/modules/endpoints/endpoints.repository';
import { fakeDbContext, mockOf } from './fakes';

function delivery(attemptCount = 0): DispatchableDelivery {
  return { id: 'd1', endpointId: 'e1', messageId: 'm1', attemptCount } as DispatchableDelivery;
}

describe('Dispatcher.record', () => {
  let deliveries: jest.Mocked<DeliveryRepository>;
  let attempts: jest.Mocked<AttemptRepository>;
  let endpoints: jest.Mocked<EndpointRepository>;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    deliveries = mockOf<DeliveryRepository>('update');
    attempts = mockOf<AttemptRepository>('create');
    endpoints = mockOf<EndpointRepository>('resetFailures', 'incrementFailures', 'disable');
    endpoints.incrementFailures.mockResolvedValue(1);
    dispatcher = new Dispatcher(
      fakeDbContext(),
      deliveries,
      attempts,
      endpoints,
      mockOf<WebhookSender>('send'),
      {
        batchSize: 10,
        leaseSeconds: 60,
        timeoutMs: 1000,
        retryScheduleSeconds: [10, 60],
        retryJitter: 0,
        circuitBreakerThreshold: 3,
      },
    );
  });

  it('stores the attempt, marks the delivery succeeded and resets the endpoint on 2xx', async () => {
    await dispatcher.record(delivery(), { statusCode: 204, responseBody: '', durationMs: 12 });
    expect(attempts.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attemptNumber: 1,
        statusCode: 204,
        durationMs: 12,
        succeeded: true,
      }),
    );
    expect(deliveries.update).toHaveBeenCalledWith(
      expect.anything(),
      'd1',
      expect.objectContaining({ status: 'SUCCEEDED' }),
    );
    expect(endpoints.resetFailures).toHaveBeenCalledWith(expect.anything(), 'e1');
  });

  it('schedules the next attempt from the retry schedule after a failure', async () => {
    const before = Date.now();
    await dispatcher.record(delivery(0), { error: 'ECONNREFUSED', durationMs: 3 });
    const update = deliveries.update.mock.calls[0]![2] as { nextAttemptAt: Date; status?: string };
    expect(update.status).toBeUndefined();
    expect(update.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 10_000);
    expect(endpoints.disable).not.toHaveBeenCalled();
  });

  it('fails the delivery when no retries are left', async () => {
    await dispatcher.record(delivery(2), { statusCode: 500, durationMs: 3 });
    expect(deliveries.update).toHaveBeenCalledWith(
      expect.anything(),
      'd1',
      expect.objectContaining({
        status: 'FAILED',
        attemptCount: 3,
      }),
    );
  });

  it('disables the endpoint on 410 without counting it as a retryable failure', async () => {
    endpoints.disable.mockResolvedValue(true);
    await dispatcher.record(delivery(), { statusCode: 410, durationMs: 3 });
    expect(endpoints.disable).toHaveBeenCalledWith(expect.anything(), 'e1', 'GONE');
    expect(endpoints.incrementFailures).not.toHaveBeenCalled();
  });

  it('opens the circuit when consecutive failures reach the threshold', async () => {
    endpoints.incrementFailures.mockResolvedValue(3);
    endpoints.disable.mockResolvedValue(true);
    await dispatcher.record(delivery(), { statusCode: 503, durationMs: 3 });
    expect(endpoints.disable).toHaveBeenCalledWith(expect.anything(), 'e1', 'FAILING');
  });
});
