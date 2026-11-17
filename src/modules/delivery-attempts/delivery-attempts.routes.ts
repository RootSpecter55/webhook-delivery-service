import { Router, type RequestHandler } from 'express';
import { validate } from '../../common/validate';
import type { DeliveryAttemptsController } from './delivery-attempts.controller';
import {
  deliveryParams,
  listAttemptsQuery,
  listDeliveriesQuery,
} from './delivery-attempts.schemas';

/** Mounted at /deliveries. Authenticated with the application's API key. */
export function deliveryAttemptsRoutes(
  controller: DeliveryAttemptsController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  router.get('/', validate({ query: listDeliveriesQuery }), controller.listDeliveries);
  router.get('/:deliveryId', validate({ params: deliveryParams }), controller.getDelivery);
  router.get(
    '/:deliveryId/attempts',
    validate({ params: deliveryParams, query: listAttemptsQuery }),
    controller.listAttempts,
  );
  return router;
}
