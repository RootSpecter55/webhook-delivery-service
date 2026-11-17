import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination';

export const endpointParams = z.object({ endpointId: z.uuid() });

const eventType = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_.-]+$/, 'lowercase letters, digits, dots, dashes and underscores');

const fields = {
  url: z.url({ protocol: /^https?$/ }).max(2000),
  description: z.string().trim().max(500).optional(),
  eventTypes: z
    .array(eventType)
    .min(1)
    .max(100)
    .transform((types) => [...new Set(types)]),
};

export const createEndpointBody = z.object(fields);

export const updateEndpointBody = z
  .object(fields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'at least one field is required');

export const listEndpointsQuery = paginationQuerySchema.extend({
  status: z.enum(['ENABLED', 'DISABLED']).optional(),
});

export const replayFailedBody = z.object({ since: z.iso.datetime({ offset: true }) });

export type EndpointParams = z.infer<typeof endpointParams>;
export type CreateEndpointInput = z.infer<typeof createEndpointBody>;
export type UpdateEndpointInput = z.infer<typeof updateEndpointBody>;
export type ListEndpointsQuery = z.infer<typeof listEndpointsQuery>;
export type ReplayFailedInput = z.infer<typeof replayFailedBody>;
