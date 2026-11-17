import { BaseRepository } from '../../common/base-repository';
import type { Db } from '../../common/db';
import type { Endpoint, Prisma } from '../../generated/prisma/client';

export type DisabledReason = 'GONE' | 'FAILING' | 'MANUAL';

export class EndpointRepository extends BaseRepository<
  Endpoint,
  Prisma.EndpointUncheckedCreateInput,
  Prisma.EndpointUncheckedUpdateInput,
  Prisma.EndpointWhereInput
> {
  protected delegate(db: Db) {
    return db.endpoint;
  }

  findForApplication(db: Db, applicationId: string, id: string) {
    return db.endpoint.findFirst({ where: { id, applicationId } });
  }

  /** Enabled endpoints of the application that subscribe to this event type. */
  findSubscribed(db: Db, applicationId: string, eventType: string) {
    return db.endpoint.findMany({
      where: { applicationId, status: 'ENABLED', eventTypes: { has: eventType } },
    });
  }

  async resetFailures(db: Db, id: string): Promise<void> {
    await db.endpoint.update({ where: { id }, data: { consecutiveFailures: 0 } });
  }

  /** Atomic increment; returns the new count, so concurrent failures are all counted. */
  async incrementFailures(db: Db, id: string): Promise<number> {
    const endpoint = await db.endpoint.update({
      where: { id },
      data: { consecutiveFailures: { increment: 1 } },
    });
    return endpoint.consecutiveFailures;
  }

  /** Disables only if still enabled, so an automatic reason never overwrites a manual one. */
  async disable(db: Db, id: string, reason: DisabledReason): Promise<boolean> {
    const { count } = await db.endpoint.updateMany({
      where: { id, status: 'ENABLED' },
      data: { status: 'DISABLED', disabledReason: reason },
    });
    return count === 1;
  }
}

export class EndpointSecretRepository {
  create(db: Db, endpointId: string, secret: string) {
    return db.endpointSecret.create({ data: { endpointId, secret } });
  }

  findCurrent(db: Db, endpointId: string) {
    return db.endpointSecret.findFirst({ where: { endpointId, expiresAt: null } });
  }

  /** Puts an end date on the current secret; it keeps signing until then. */
  async expireCurrent(db: Db, endpointId: string, expiresAt: Date): Promise<void> {
    await db.endpointSecret.updateMany({
      where: { endpointId, expiresAt: null },
      data: { expiresAt },
    });
  }
}
