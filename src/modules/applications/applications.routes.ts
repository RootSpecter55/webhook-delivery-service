import { Router, type RequestHandler } from 'express';
import { validate } from '../../common/validate';
import type { ApplicationsController } from './applications.controller';
import { createApplicationBody, listApplicationsQuery } from './applications.schemas';

/** Mounted at /applications. Admin only. */
export function applicationsRoutes(
  controller: ApplicationsController,
  requireAdmin: RequestHandler,
): Router {
  const router = Router();
  router.use(requireAdmin);
  router.post('/', validate({ body: createApplicationBody }), controller.create);
  router.get('/', validate({ query: listApplicationsQuery }), controller.list);
  return router;
}
