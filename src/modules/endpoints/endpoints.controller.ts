import type { Request, Response } from 'express';
import { currentApplication } from '../../common/auth-middleware';
import { sendData, sendPage } from '../../common/response';
import type {
  CreateEndpointInput,
  EndpointParams,
  ListEndpointsQuery,
  ReplayFailedInput,
  UpdateEndpointInput,
} from './endpoints.schemas';
import type { EndpointsService } from './endpoints.service';

export class EndpointsController {
  constructor(private readonly service: EndpointsService) {}

  create = async (req: Request, res: Response) => {
    const input = req.validated.body as CreateEndpointInput;
    sendData(res, await this.service.create(currentApplication(req).id, input), 201);
  };

  list = async (req: Request, res: Response) => {
    const query = req.validated.query as ListEndpointsQuery;
    sendPage(res, await this.service.list(currentApplication(req).id, query));
  };

  get = async (req: Request, res: Response) => {
    const { endpointId } = req.validated.params as EndpointParams;
    sendData(res, await this.service.get(currentApplication(req).id, endpointId));
  };

  update = async (req: Request, res: Response) => {
    const { endpointId } = req.validated.params as EndpointParams;
    const input = req.validated.body as UpdateEndpointInput;
    sendData(res, await this.service.update(currentApplication(req).id, endpointId, input));
  };

  delete = async (req: Request, res: Response) => {
    const { endpointId } = req.validated.params as EndpointParams;
    await this.service.delete(currentApplication(req).id, endpointId);
    res.status(204).end();
  };

  getSecret = async (req: Request, res: Response) => {
    const { endpointId } = req.validated.params as EndpointParams;
    sendData(res, await this.service.getSecret(currentApplication(req).id, endpointId));
  };

  rotateSecret = async (req: Request, res: Response) => {
    const { endpointId } = req.validated.params as EndpointParams;
    sendData(res, await this.service.rotateSecret(currentApplication(req).id, endpointId));
  };

  enable = async (req: Request, res: Response) => {
    const { endpointId } = req.validated.params as EndpointParams;
    sendData(res, await this.service.enable(currentApplication(req).id, endpointId));
  };

  disable = async (req: Request, res: Response) => {
    const { endpointId } = req.validated.params as EndpointParams;
    sendData(res, await this.service.disable(currentApplication(req).id, endpointId));
  };

  replayFailed = async (req: Request, res: Response) => {
    const { endpointId } = req.validated.params as EndpointParams;
    const input = req.validated.body as ReplayFailedInput;
    sendData(
      res,
      await this.service.replayFailed(currentApplication(req).id, endpointId, input),
      202,
    );
  };
}
