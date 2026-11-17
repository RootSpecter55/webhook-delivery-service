import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { getConfig } from './config';

// Singleton: one PrismaClient means one connection pool for the whole process.
let client: PrismaClient | undefined;
export function getPrisma(): PrismaClient {
  client ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: getConfig().DATABASE_URL }),
  });
  return client;
}

/** A database handle that services pass to repositories: the root client or a transaction. */
export type Db = PrismaClient | Prisma.TransactionClient;

/** How services get a database handle. Unit tests swap in a fake that needs no database. */
export interface DbContext {
  /** Runs `fn` in one transaction: every write inside commits together or not at all. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  /** The root client, for single reads that need no transaction. */
  client(): Db;
}

export const dbContext: DbContext = {
  transaction: (fn) => getPrisma().$transaction(fn),
  client: () => getPrisma(),
};

/** True when a Prisma error is a unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
