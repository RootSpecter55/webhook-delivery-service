import type { Request, Response } from 'express';
import { sendData, sendPage } from '../../common/response';
import type { CreateApplicationInput, ListApplicationsQuery } from './applications.schemas';
import type { ApplicationsService } from './applications.service';

export class ApplicationsController {
  constructor(private readonly service: ApplicationsService) {}

  create = async (req: Request, res: Response) => {
    sendData(res, await this.service.create(req.validated.body as CreateApplicationInput), 201);
  };

  list = async (req: Request, res: Response) => {
    sendPage(res, await this.service.list(req.validated.query as ListApplicationsQuery));
  };
}
