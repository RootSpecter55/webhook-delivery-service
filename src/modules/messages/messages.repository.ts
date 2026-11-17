import { BaseRepository } from '../../common/base-repository';
import type { Db } from '../../common/db';
import type { Message, Prisma } from '../../generated/prisma/client';

export class MessageRepository extends BaseRepository<
  Message,
  Prisma.MessageUncheckedCreateInput,
  Prisma.MessageUncheckedUpdateInput,
  Prisma.MessageWhereInput
> {
  protected delegate(db: Db) {
    return db.message;
  }

  findForApplication(db: Db, applicationId: string, id: string) {
    return db.message.findFirst({ where: { id, applicationId } });
  }

  findByIdempotencyKey(db: Db, applicationId: string, idempotencyKey: string) {
    return db.message.findUnique({
      where: { applicationId_idempotencyKey: { applicationId, idempotencyKey } },
    });
  }
}
