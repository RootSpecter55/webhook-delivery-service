import { BaseRepository } from '../../common/base-repository';
import type { Db } from '../../common/db';
import type { Application, Prisma } from '../../generated/prisma/client';

export class ApplicationRepository extends BaseRepository<
  Application,
  Prisma.ApplicationUncheckedCreateInput,
  Prisma.ApplicationUncheckedUpdateInput,
  Prisma.ApplicationWhereInput
> {
  protected delegate(db: Db) {
    return db.application;
  }

  findByKeyHash(db: Db, apiKeyHash: string) {
    return db.application.findUnique({ where: { apiKeyHash } });
  }
}
