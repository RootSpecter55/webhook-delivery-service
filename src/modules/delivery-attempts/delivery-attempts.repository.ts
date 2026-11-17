import { BaseRepository } from '../../common/base-repository';
import type { Db } from '../../common/db';
import type { Delivery, DeliveryAttempt, Prisma } from '../../generated/prisma/client';

export class DeliveryRepository extends BaseRepository<
  Delivery,
  Prisma.DeliveryUncheckedCreateInput,
  Prisma.DeliveryUncheckedUpdateInput,
  Prisma.DeliveryWhereInput
> {
  protected delegate(db: Db) {
    return db.delivery;
  }

  async createMany(db: Db, rows: { messageId: string; endpointId: string }[]): Promise<number> {
    if (rows.length === 0) return 0;
    const { count } = await db.delivery.createMany({ data: rows });
    return count;
  }

  /**
   * Claims up to `limit` due deliveries in one statement. FOR UPDATE SKIP LOCKED makes a
   * concurrent worker skip the rows this one is taking, instead of waiting for them or taking
   * them too. Moving next_attempt_at forward by the lease hides the rows until this worker
   * records an outcome; if it dies first, they become due again when the lease runs out.
   */
  async claimDue(db: Db, limit: number, leaseSeconds: number): Promise<string[]> {
    const rows = await db.$queryRaw<{ id: string }[]>`
      UPDATE deliveries
      SET next_attempt_at = now() + make_interval(secs => ${leaseSeconds}), updated_at = now()
      WHERE id IN (
        SELECT d.id FROM deliveries d
        JOIN endpoints e ON e.id = d.endpoint_id
        WHERE d.status = 'PENDING' AND d.next_attempt_at <= now() AND e.status = 'ENABLED'
        ORDER BY d.next_attempt_at
        LIMIT ${limit}
        FOR UPDATE OF d SKIP LOCKED
      )
      RETURNING id`;
    return rows.map((row) => row.id);
  }

  /** Claimed deliveries with what is needed to send them, including every unexpired secret. */
  findForDispatch(db: Db, ids: string[], now: Date) {
    return db.delivery.findMany({
      where: { id: { in: ids } },
      include: {
        message: true,
        endpoint: {
          include: {
            secrets: {
              where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
              orderBy: { createdAt: 'desc' },
            },
          },
        },
      },
    });
  }

  async findFailedMessageIds(db: Db, endpointId: string, since: Date): Promise<string[]> {
    const rows = await db.delivery.findMany({
      where: { endpointId, status: 'FAILED', createdAt: { gte: since } },
      select: { messageId: true },
      distinct: ['messageId'],
    });
    return rows.map((row) => row.messageId);
  }

  findForApplication(db: Db, applicationId: string, id: string) {
    return db.delivery.findFirst({ where: { id, message: { applicationId } } });
  }
}

export type DispatchableDelivery = Awaited<
  ReturnType<DeliveryRepository['findForDispatch']>
>[number];

export class AttemptRepository extends BaseRepository<
  DeliveryAttempt,
  Prisma.DeliveryAttemptUncheckedCreateInput,
  Prisma.DeliveryAttemptUncheckedUpdateInput,
  Prisma.DeliveryAttemptWhereInput
> {
  protected delegate(db: Db) {
    return db.deliveryAttempt;
  }
}
