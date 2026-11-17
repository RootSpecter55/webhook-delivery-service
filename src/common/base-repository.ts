import type { Db } from './db';

/**
 * The subset of a Prisma model delegate (e.g. `db.invite`) that generic CRUD needs.
 * Prisma's own delegate types are heavily generic, so subclasses adapt to this shape.
 */
export interface CrudDelegate<T, CreateInput, UpdateInput, Where> {
  findFirst(args: { where: Where }): Promise<T | null>;
  findMany(args: { where?: Where; skip?: number; take?: number; orderBy?: object }): Promise<T[]>;
  count(args: { where?: Where }): Promise<number>;
  create(args: { data: CreateInput }): Promise<T>;
  update(args: { where: { id: string }; data: UpdateInput }): Promise<T>;
  delete(args: { where: { id: string } }): Promise<T>;
}

export type ListArgs<Where> = { where?: Where; skip: number; take: number; orderBy?: object };

/** Repository pattern: generic data access shared by every module; services never touch Prisma. */
export abstract class BaseRepository<T, CreateInput, UpdateInput, Where extends object> {
  protected abstract delegate(db: Db): CrudDelegate<T, CreateInput, UpdateInput, Where>;

  findById(db: Db, id: string): Promise<T | null> {
    return this.delegate(db).findFirst({ where: { id } as Where });
  }

  async list(
    db: Db,
    { where, skip, take, orderBy }: ListArgs<Where>,
  ): Promise<{ items: T[]; total: number }> {
    const delegate = this.delegate(db);
    const items = await delegate.findMany({
      where,
      skip,
      take,
      orderBy: orderBy ?? { createdAt: 'asc' },
    });
    const total = await delegate.count({ where });
    return { items, total };
  }

  create(db: Db, data: CreateInput): Promise<T> {
    return this.delegate(db).create({ data });
  }

  update(db: Db, id: string, data: UpdateInput): Promise<T> {
    return this.delegate(db).update({ where: { id }, data });
  }

  delete(db: Db, id: string): Promise<T> {
    return this.delegate(db).delete({ where: { id } });
  }
}
