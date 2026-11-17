import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination';

export const messageParams = z.object({ messageId: z.uuid() });

export const sendMessageBody = z.object({
  eventType: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_.-]+$/, 'lowercase letters, digits, dots, dashes and underscores'),
  payload: z.record(z.string(), z.unknown()),
  /** A retried POST with the same key returns the original message instead of a new one. */
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const replayMessageBody = z.object({ endpointId: z.uuid().optional() });

export const listMessagesQuery = paginationQuerySchema.extend({
  eventType: z.string().min(1).max(100).optional(),
});

export type MessageParams = z.infer<typeof messageParams>;
export type SendMessageInput = z.infer<typeof sendMessageBody>;
export type ReplayMessageInput = z.infer<typeof replayMessageBody>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuery>;
