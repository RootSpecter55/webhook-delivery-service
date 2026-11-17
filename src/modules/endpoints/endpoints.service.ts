import { randomBytes } from 'node:crypto';
import type { DbContext } from '../../common/db';
import { ConflictError, NotFoundError } from '../../common/errors';
import { toPage, toSkipTake } from '../../common/pagination';
import { assertSafeUrl, type Resolve } from '../../common/url-safety';
import type { DeliveryRepository } from '../delivery-attempts/delivery-attempts.repository';
import type { EndpointRepository, EndpointSecretRepository } from './endpoints.repository';
import type {
  CreateEndpointInput,
  ListEndpointsQuery,
  ReplayFailedInput,
  UpdateEndpointInput,
} from './endpoints.schemas';

export function generateSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

export type EndpointsOptions = {
  allowPrivateEndpoints: boolean;
  rotationGraceHours: number;
  /** DNS resolver for the SSRF check. Tests pass a fake one. */
  resolve?: Resolve;
};

export class EndpointsService {
  constructor(
    private readonly db: DbContext,
    private readonly endpoints: EndpointRepository,
    private readonly secrets: EndpointSecretRepository,
    private readonly deliveries: DeliveryRepository,
    private readonly options: EndpointsOptions,
  ) {}

  private checkUrl(url: string) {
    return assertSafeUrl(url, {
      allowPrivate: this.options.allowPrivateEndpoints,
      resolve: this.options.resolve,
    });
  }

  private async load(applicationId: string, endpointId: string) {
    const endpoint = await this.endpoints.findForApplication(
      this.db.client(),
      applicationId,
      endpointId,
    );
    if (!endpoint) throw new NotFoundError('Endpoint');
    return endpoint;
  }

  /** Returns the signing secret once here; it can be read again via getSecret. */
  async create(applicationId: string, input: CreateEndpointInput) {
    await this.checkUrl(input.url);
    return this.db.transaction(async (tx) => {
      const endpoint = await this.endpoints.create(tx, { applicationId, ...input });
      const secret = await this.secrets.create(tx, endpoint.id, generateSecret());
      return { ...endpoint, secret: secret.secret };
    });
  }

  async list(applicationId: string, query: ListEndpointsQuery) {
    const { items, total } = await this.endpoints.list(this.db.client(), {
      where: { applicationId, ...(query.status ? { status: query.status } : {}) },
      ...toSkipTake(query),
    });
    return toPage(items, total, query);
  }

  get(applicationId: string, endpointId: string) {
    return this.load(applicationId, endpointId);
  }

  async update(applicationId: string, endpointId: string, input: UpdateEndpointInput) {
    await this.load(applicationId, endpointId);
    if (input.url) await this.checkUrl(input.url);
    return this.endpoints.update(this.db.client(), endpointId, input);
  }

  async delete(applicationId: string, endpointId: string) {
    await this.load(applicationId, endpointId);
    await this.endpoints.delete(this.db.client(), endpointId);
  }

  async getSecret(applicationId: string, endpointId: string) {
    await this.load(applicationId, endpointId);
    const current = await this.secrets.findCurrent(this.db.client(), endpointId);
    if (!current) throw new NotFoundError('Signing secret');
    return { secret: current.secret };
  }

  /**
   * Replaces the signing secret. The old one keeps signing for the grace period, so requests
   * carry both signatures and a receiver that has not switched yet can still verify them.
   */
  async rotateSecret(applicationId: string, endpointId: string) {
    await this.load(applicationId, endpointId);
    const previousExpiresAt = new Date(
      Date.now() + this.options.rotationGraceHours * 60 * 60 * 1000,
    );
    return this.db.transaction(async (tx) => {
      await this.secrets.expireCurrent(tx, endpointId, previousExpiresAt);
      const secret = await this.secrets.create(tx, endpointId, generateSecret());
      return { secret: secret.secret, previousSecretExpiresAt: previousExpiresAt };
    });
  }

  /** Re-enabling resets the failure count; pending deliveries are picked up again. */
  async enable(applicationId: string, endpointId: string) {
    await this.load(applicationId, endpointId);
    return this.endpoints.update(this.db.client(), endpointId, {
      status: 'ENABLED',
      disabledReason: null,
      consecutiveFailures: 0,
    });
  }

  async disable(applicationId: string, endpointId: string) {
    await this.load(applicationId, endpointId);
    await this.endpoints.disable(this.db.client(), endpointId, 'MANUAL');
    return this.load(applicationId, endpointId);
  }

  /** New deliveries for every message that failed to reach this endpoint since `since`. */
  async replayFailed(applicationId: string, endpointId: string, { since }: ReplayFailedInput) {
    const endpoint = await this.load(applicationId, endpointId);
    if (endpoint.status !== 'ENABLED') {
      throw new ConflictError('Enable the endpoint before replaying to it');
    }
    return this.db.transaction(async (tx) => {
      const messageIds = await this.deliveries.findFailedMessageIds(
        tx,
        endpointId,
        new Date(since),
      );
      await this.deliveries.createMany(
        tx,
        messageIds.map((messageId) => ({ messageId, endpointId })),
      );
      return { replayed: messageIds.length };
    });
  }
}
