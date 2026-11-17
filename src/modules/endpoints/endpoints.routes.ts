import { Router, type RequestHandler } from 'express';
import { validate } from '../../common/validate';
import type { EndpointsController } from './endpoints.controller';
import {
  createEndpointBody,
  endpointParams,
  listEndpointsQuery,
  replayFailedBody,
  updateEndpointBody,
} from './endpoints.schemas';

/** Mounted at /endpoints. Authenticated with the application's API key. */
export function endpointsRoutes(
  controller: EndpointsController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  const params = validate({ params: endpointParams });

  router.post('/', validate({ body: createEndpointBody }), controller.create);
  router.get('/', validate({ query: listEndpointsQuery }), controller.list);
  router.get('/:endpointId', params, controller.get);
  router.patch(
    '/:endpointId',
    validate({ params: endpointParams, body: updateEndpointBody }),
    controller.update,
  );
  router.delete('/:endpointId', params, controller.delete);
  router.get('/:endpointId/secret', params, controller.getSecret);
  router.post('/:endpointId/rotate-secret', params, controller.rotateSecret);
  router.post('/:endpointId/enable', params, controller.enable);
  router.post('/:endpointId/disable', params, controller.disable);
  router.post(
    '/:endpointId/replay-failed',
    validate({ params: endpointParams, body: replayFailedBody }),
    controller.replayFailed,
  );
  return router;
}
