import type { Request, Response } from 'express';
import { currentApplication } from '../../common/auth-middleware';
import { sendData, sendPage } from '../../common/response';
import type {
  ListMessagesQuery,
  MessageParams,
  ReplayMessageInput,
  SendMessageInput,
} from './messages.schemas';
import type { MessagesService } from './messages.service';

export class MessagesController {
  constructor(private readonly service: MessagesService) {}

  /** 202 for a new message (delivery is asynchronous), 200 for an idempotent repeat. */
  send = async (req: Request, res: Response) => {
    const input = req.validated.body as SendMessageInput;
    const result = await this.service.send(currentApplication(req).id, input);
    sendData(res, result, result.duplicate ? 200 : 202);
  };

  list = async (req: Request, res: Response) => {
    const query = req.validated.query as ListMessagesQuery;
    sendPage(res, await this.service.list(currentApplication(req).id, query));
  };

  get = async (req: Request, res: Response) => {
    const { messageId } = req.validated.params as MessageParams;
    sendData(res, await this.service.get(currentApplication(req).id, messageId));
  };

  replay = async (req: Request, res: Response) => {
    const { messageId } = req.validated.params as MessageParams;
    const input = req.validated.body as ReplayMessageInput;
    sendData(res, await this.service.replay(currentApplication(req).id, messageId, input), 202);
  };
}
