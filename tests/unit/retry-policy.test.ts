import { classify, retryDelayMs } from '../../src/modules/delivery-attempts/retry-policy';

describe('classify', () => {
  it('treats 2xx as success, 410 as gone and everything else as a failure', () => {
    expect([200, 201, 204, 299].map(classify)).toEqual(Array(4).fill('success'));
    expect(classify(410)).toBe('gone');
    expect([undefined, 301, 400, 404, 429, 500, 503].map(classify)).toEqual(
      Array(7).fill('failure'),
    );
  });
});

describe('retryDelayMs', () => {
  const schedule = [5, 300, 1800];

  it('follows the schedule, one entry per attempt made', () => {
    const noJitter = () => 0.5; // random() = 0.5 means a factor of exactly 1
    expect(retryDelayMs(1, schedule, 0.2, noJitter)).toBe(5_000);
    expect(retryDelayMs(2, schedule, 0.2, noJitter)).toBe(300_000);
    expect(retryDelayMs(3, schedule, 0.2, noJitter)).toBe(1_800_000);
  });

  it('returns null once the schedule is used up', () => {
    expect(retryDelayMs(4, schedule, 0.2)).toBeNull();
    expect(retryDelayMs(1, [], 0.2)).toBeNull();
  });

  it('keeps jitter within ±jitter of the base delay', () => {
    expect(retryDelayMs(2, schedule, 0.2, () => 0)).toBe(240_000);
    expect(retryDelayMs(2, schedule, 0.2, () => 0.999999)).toBe(360_000);
    for (let i = 0; i < 1000; i++) {
      const delay = retryDelayMs(2, schedule, 0.2)!;
      expect(delay).toBeGreaterThanOrEqual(240_000);
      expect(delay).toBeLessThanOrEqual(360_000);
    }
  });
});
