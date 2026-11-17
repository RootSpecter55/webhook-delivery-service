import { Router, type RequestHandler } from 'express';
import { validate } from '../../common/validate';
import type { MessagesController } from './messages.controller';
import {
  listMessagesQuery,
  messageParams,
  replayMessageBody,
  sendMessageBody,
} from './messages.schemas';

/** Mounted at /messages. Authenticated with the application's API key. */
export function messagesRoutes(
  controller: MessagesController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  router.post('/', validate({ body: sendMessageBody }), controller.send);
  router.get('/', validate({ query: listMessagesQuery }), controller.list);
  router.get('/:messageId', validate({ params: messageParams }), controller.get);
  router.post(
    '/:messageId/replay',
    validate({ params: messageParams, body: replayMessageBody }),
    controller.replay,
  );
  return router;
}
