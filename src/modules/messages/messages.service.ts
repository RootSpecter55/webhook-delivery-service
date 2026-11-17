import type { DbContext } from '../../common/db';
import { isUniqueViolation } from '../../common/db';
import { ConflictError, NotFoundError } from '../../common/errors';
import { toPage, toSkipTake } from '../../common/pagination';
import type { Prisma } from '../../generated/prisma/client';
import type { DeliveryRepository } from '../delivery-attempts/delivery-attempts.repository';
import type { EndpointRepository } from '../endpoints/endpoints.repository';
import type { MessageRepository } from './messages.repository';
import type { ListMessagesQuery, ReplayMessageInput, SendMessageInput } from './messages.schemas';

export class MessagesService {
  constructor(
    private readonly db: DbContext,
    private readonly messages: MessageRepository,
    private readonly endpoints: EndpointRepository,
    private readonly deliveries: DeliveryRepository,
  ) {}

  /**
   * Stores the message and creates one delivery per enabled endpoint subscribed to its event
   * type, in one transaction. Sending happens later, in the worker.
   */
  async send(applicationId: string, input: SendMessageInput) {
    const db = this.db.client();
    if (input.idempotencyKey) {
      const existing = await this.messages.findByIdempotencyKey(
        db,
        applicationId,
        input.idempotencyKey,
      );
      if (existing) return { message: existing, deliveryCount: null, duplicate: true };
    }

    try {
      return await this.db.transaction(async (tx) => {
        const message = await this.messages.create(tx, {
          applicationId,
          eventType: input.eventType,
          payload: input.payload as Prisma.InputJsonObject,
          idempotencyKey: input.idempotencyKey,
        });
        const subscribed = await this.endpoints.findSubscribed(tx, applicationId, input.eventType);
        const deliveryCount = await this.deliveries.createMany(
          tx,
          subscribed.map((endpoint) => ({ messageId: message.id, endpointId: endpoint.id })),
        );
        return { message, deliveryCount, duplicate: false };
      });
    } catch (err) {
      // Two requests with the same key at the same moment: the second loses on the unique key.
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.messages.findByIdempotencyKey(
          db,
          applicationId,
          input.idempotencyKey,
        );
        if (existing) return { message: existing, deliveryCount: null, duplicate: true };
      }
      throw err;
    }
  }

  async list(applicationId: string, query: ListMessagesQuery) {
    const { items, total } = await this.messages.list(this.db.client(), {
      where: { applicationId, ...(query.eventType ? { eventType: query.eventType } : {}) },
      ...toSkipTake(query),
      orderBy: { createdAt: 'desc' },
    });
    return toPage(items, total, query);
  }

  async get(applicationId: string, messageId: string) {
    const message = await this.messages.findForApplication(
      this.db.client(),
      applicationId,
      messageId,
    );
    if (!message) throw new NotFoundError('Message');
    return message;
  }

  /** New deliveries for one message: to one endpoint, or to every currently subscribed one. */
  async replay(applicationId: string, messageId: string, { endpointId }: ReplayMessageInput) {
    const message = await this.get(applicationId, messageId);
    return this.db.transaction(async (tx) => {
      let targets: string[];
      if (endpointId) {
        const endpoint = await this.endpoints.findForApplication(tx, applicationId, endpointId);
        if (!endpoint) throw new NotFoundError('Endpoint');
        if (endpoint.status !== 'ENABLED') {
          throw new ConflictError('Enable the endpoint before replaying to it');
        }
        targets = [endpoint.id];
      } else {
        const subscribed = await this.endpoints.findSubscribed(
          tx,
          applicationId,
          message.eventType,
        );
        targets = subscribed.map((e) => e.id);
      }
      const deliveryCount = await this.deliveries.createMany(
        tx,
        targets.map((id) => ({ messageId, endpointId: id })),
      );
      return { deliveryCount };
    });
  }
}
