import type { Application } from '../../src/generated/prisma/client';
import type { ApplicationRepository } from '../../src/modules/applications/applications.repository';
import {
  ApplicationsService,
  hashApiKey,
} from '../../src/modules/applications/applications.service';
import { fakeDbContext, mockOf } from './fakes';

describe('ApplicationsService', () => {
  it('stores a hash of the key and returns the key once', async () => {
    const repo = mockOf<ApplicationRepository>('create');
    repo.create.mockImplementation(
      async (_db, data) => ({ id: 'a1', createdAt: new Date(), ...data }) as Application,
    );
    const service = new ApplicationsService(fakeDbContext(), repo);

    const { apiKey, application } = await service.create({ name: 'Acme' });

    expect(apiKey).toMatch(/^whk_[A-Za-z0-9_-]{32}$/);
    expect(repo.create.mock.calls[0]![1]).toMatchObject({
      apiKeyHash: hashApiKey(apiKey),
      apiKeyPrefix: apiKey.slice(0, 10),
    });
    expect(application).not.toHaveProperty('apiKeyHash');
  });

  it('resolves a key to its application, or null', async () => {
    const repo = mockOf<ApplicationRepository>('findByKeyHash');
    const service = new ApplicationsService(fakeDbContext(), repo);
    repo.findByKeyHash
      .mockResolvedValueOnce({ id: 'a1', name: 'Acme' } as Application)
      .mockResolvedValueOnce(null);

    expect(await service.resolve('whk_good')).toEqual({ id: 'a1', name: 'Acme' });
    expect(repo.findByKeyHash).toHaveBeenCalledWith(expect.anything(), hashApiKey('whk_good'));
    expect(await service.resolve('whk_bad')).toBeNull();
  });
});
