import { z } from 'zod';

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export type PageMeta = { page: number; pageSize: number; total: number; totalPages: number };

export type Page<T> = { items: T[]; meta: PageMeta };

export function toSkipTake({ page, pageSize }: PaginationQuery) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

export function toPage<T>(items: T[], total: number, { page, pageSize }: PaginationQuery): Page<T> {
  return { items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}
