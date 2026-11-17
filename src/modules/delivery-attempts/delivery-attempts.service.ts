import type { DbContext } from '../../common/db';
import { NotFoundError } from '../../common/errors';
import { toPage, toSkipTake } from '../../common/pagination';
import type { AttemptRepository, DeliveryRepository } from './delivery-attempts.repository';
import type { ListAttemptsQuery, ListDeliveriesQuery } from './delivery-attempts.schemas';

export class DeliveryAttemptsService {
  constructor(
    private readonly db: DbContext,
    private readonly deliveries: DeliveryRepository,
    private readonly attempts: AttemptRepository,
  ) {}

  async listDeliveries(applicationId: string, query: ListDeliveriesQuery) {
    const { messageId, endpointId, status } = query;
    const { items, total } = await this.deliveries.list(this.db.client(), {
      where: {
        message: { applicationId },
        ...(messageId ? { messageId } : {}),
        ...(endpointId ? { endpointId } : {}),
        ...(status ? { status } : {}),
      },
      ...toSkipTake(query),
      orderBy: { createdAt: 'desc' },
    });
    return toPage(items, total, query);
  }

  async getDelivery(applicationId: string, deliveryId: string) {
    const delivery = await this.deliveries.findForApplication(
      this.db.client(),
      applicationId,
      deliveryId,
    );
    if (!delivery) throw new NotFoundError('Delivery');
    return delivery;
  }

  async listAttempts(applicationId: string, deliveryId: string, query: ListAttemptsQuery) {
    await this.getDelivery(applicationId, deliveryId);
    const { items, total } = await this.attempts.list(this.db.client(), {
      where: { deliveryId },
      ...toSkipTake(query),
      orderBy: { attemptNumber: 'asc' },
    });
    return toPage(items, total, query);
  }
}
