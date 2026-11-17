export type Outcome = 'success' | 'gone' | 'failure';

/** 2xx is success, 410 means "stop sending here", everything else (incl. no response) is retried. */
export function classify(statusCode: number | undefined): Outcome {
  if (statusCode === undefined) return 'failure';
  if (statusCode >= 200 && statusCode < 300) return 'success';
  if (statusCode === 410) return 'gone';
  return 'failure';
}

/**
 * Delay before the next attempt, or null when the schedule is used up.
 *
 * `attemptsMade` counts attempts so far (1 after the first). Each delay gets a random ±jitter
 * share, so endpoints that failed together don't all get retried in the same instant.
 */
export function retryDelayMs(
  attemptsMade: number,
  scheduleSeconds: readonly number[],
  jitter: number,
  random: () => number = Math.random,
): number | null {
  const base = scheduleSeconds[attemptsMade - 1];
  if (base === undefined) return null;
  const factor = 1 + jitter * (random() * 2 - 1);
  return Math.round(base * 1000 * factor);
}
