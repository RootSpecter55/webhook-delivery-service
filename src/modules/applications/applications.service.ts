import { createHash, randomBytes } from 'node:crypto';
import type { AuthApplication } from '../../common/auth-middleware';
import type { DbContext } from '../../common/db';
import { toPage, toSkipTake } from '../../common/pagination';
import type { Application } from '../../generated/prisma/client';
import type { ApplicationRepository } from './applications.repository';
import type { CreateApplicationInput, ListApplicationsQuery } from './applications.schemas';

/** Only the SHA-256 of a key is stored, so a database leak does not leak usable keys. */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function toView(application: Application) {
  const { apiKeyHash: _omit, ...rest } = application;
  return rest;
}

export class ApplicationsService {
  constructor(
    private readonly db: DbContext,
    private readonly applications: ApplicationRepository,
  ) {}

  /** Returns the API key once. A high-entropy random key needs no slow hash, only a lookup one. */
  async create(input: CreateApplicationInput) {
    const apiKey = `whk_${randomBytes(24).toString('base64url')}`;
    const application = await this.applications.create(this.db.client(), {
      name: input.name,
      apiKeyHash: hashApiKey(apiKey),
      apiKeyPrefix: apiKey.slice(0, 10),
    });
    return { application: toView(application), apiKey };
  }

  async list(query: ListApplicationsQuery) {
    const { items, total } = await this.applications.list(this.db.client(), toSkipTake(query));
    return toPage(items.map(toView), total, query);
  }

  /** Used by the auth middleware. */
  resolve = async (apiKey: string): Promise<AuthApplication | null> => {
    const application = await this.applications.findByKeyHash(this.db.client(), hashApiKey(apiKey));
    return application ? { id: application.id, name: application.name } : null;
  };
}
