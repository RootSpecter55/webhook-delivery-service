import type { Request, Response } from 'express';
import { currentApplication } from '../../common/auth-middleware';
import { sendData, sendPage } from '../../common/response';
import type {
  DeliveryParams,
  ListAttemptsQuery,
  ListDeliveriesQuery,
} from './delivery-attempts.schemas';
import type { DeliveryAttemptsService } from './delivery-attempts.service';

export class DeliveryAttemptsController {
  constructor(private readonly service: DeliveryAttemptsService) {}

  listDeliveries = async (req: Request, res: Response) => {
    const query = req.validated.query as ListDeliveriesQuery;
    sendPage(res, await this.service.listDeliveries(currentApplication(req).id, query));
  };

  getDelivery = async (req: Request, res: Response) => {
    const { deliveryId } = req.validated.params as DeliveryParams;
    sendData(res, await this.service.getDelivery(currentApplication(req).id, deliveryId));
  };

  listAttempts = async (req: Request, res: Response) => {
    const { deliveryId } = req.validated.params as DeliveryParams;
    const query = req.validated.query as ListAttemptsQuery;
    sendPage(res, await this.service.listAttempts(currentApplication(req).id, deliveryId, query));
  };
}
