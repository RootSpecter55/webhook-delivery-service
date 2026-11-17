import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination';

export const deliveryParams = z.object({ deliveryId: z.uuid() });

export const listDeliveriesQuery = paginationQuerySchema.extend({
  messageId: z.uuid().optional(),
  endpointId: z.uuid().optional(),
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']).optional(),
});

export const listAttemptsQuery = paginationQuerySchema;

export type DeliveryParams = z.infer<typeof deliveryParams>;
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuery>;
export type ListAttemptsQuery = z.infer<typeof listAttemptsQuery>;
