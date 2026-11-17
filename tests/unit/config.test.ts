import { loadConfig } from '../../src/common/config';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', ADMIN_API_KEY: 'x'.repeat(16) };

describe('loadConfig', () => {
  it('applies safe defaults: private endpoints refused, standard retry schedule', () => {
    expect(loadConfig(base)).toMatchObject({
      ALLOW_PRIVATE_ENDPOINTS: false,
      RETRY_SCHEDULE_SECONDS: [5, 300, 1800, 7200, 18000, 36000],
      CIRCUIT_BREAKER_THRESHOLD: 20,
    });
  });

  it('parses the retry schedule and allows an empty one', () => {
    expect(loadConfig({ ...base, RETRY_SCHEDULE_SECONDS: '1,2,3' }).RETRY_SCHEDULE_SECONDS).toEqual(
      [1, 2, 3],
    );
    expect(loadConfig({ ...base, RETRY_SCHEDULE_SECONDS: '' }).RETRY_SCHEDULE_SECONDS).toEqual([]);
    expect(() => loadConfig({ ...base, RETRY_SCHEDULE_SECONDS: '5,abc' })).toThrow(
      /RETRY_SCHEDULE_SECONDS/,
    );
  });

  it('requires the lease to outlast the send timeout', () => {
    expect(() =>
      loadConfig({ ...base, DELIVERY_TIMEOUT_MS: '10000', DELIVERY_LEASE_SECONDS: '5' }),
    ).toThrow(/DELIVERY_LEASE_SECONDS: must be longer than DELIVERY_TIMEOUT_MS/);
  });

  it('lists every missing or invalid variable in one error', () => {
    expect(() => loadConfig({ ALLOW_PRIVATE_ENDPOINTS: 'yes' })).toThrow(
      /DATABASE_URL[\s\S]*ADMIN_API_KEY[\s\S]*ALLOW_PRIVATE_ENDPOINTS/,
    );
  });
});
