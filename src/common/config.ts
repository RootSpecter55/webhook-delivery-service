import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((value) => value === 'true');

/** "5,300,1800" -> [5, 300, 1800]. Empty means no retries. */
const secondsList = z
  .string()
  .regex(/^(\d+(,\d+)*)?$/, 'comma-separated whole seconds, e.g. 5,300,1800')
  .transform((value) => (value === '' ? [] : value.split(',').map(Number)));

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.string().url(),
    ADMIN_API_KEY: z.string().min(16),

    ALLOW_PRIVATE_ENDPOINTS: bool.default(false),

    DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
    DELIVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    DELIVERY_LEASE_SECONDS: z.coerce.number().int().min(1).default(60),
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    RETRY_SCHEDULE_SECONDS: secondsList.default([5, 300, 1800, 7200, 18000, 36000]),
    RETRY_JITTER: z.coerce.number().min(0).max(1).default(0.2),
    CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().min(1).default(20),
    SECRET_ROTATION_GRACE_HOURS: z.coerce.number().min(0).default(24),
  })
  .refine((env) => env.DELIVERY_LEASE_SECONDS * 1000 > env.DELIVERY_TIMEOUT_MS, {
    path: ['DELIVERY_LEASE_SECONDS'],
    message: 'must be longer than DELIVERY_TIMEOUT_MS, or a slow send could be claimed twice',
  });

export type Config = z.infer<typeof configSchema>;

/** Parses and validates env vars. Throws one error listing every problem, so startup fails fast. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
  }
  return result.data;
}

// Singleton: config is read once and shared, so every module sees the same validated values.
let cached: Config | undefined;
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
