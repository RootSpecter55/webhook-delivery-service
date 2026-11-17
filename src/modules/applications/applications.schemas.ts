import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination';

export const createApplicationBody = z.object({ name: z.string().trim().min(1).max(100) });
export const listApplicationsQuery = paginationQuerySchema;

export type CreateApplicationInput = z.infer<typeof createApplicationBody>;
export type ListApplicationsQuery = z.infer<typeof listApplicationsQuery>;
