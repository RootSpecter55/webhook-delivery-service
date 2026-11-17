// Test environment: runs before every test file, before any app module reads config.
// Uses a separate database so tests never touch local development data.
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? 'postgresql://app:app@localhost:5447/webhooks_test',
  ADMIN_API_KEY: 'test-admin-key-0123456789',
  // The test receiver listens on 127.0.0.1. SSRF tests turn this off explicitly.
  ALLOW_PRIVATE_ENDPOINTS: 'true',
  DELIVERY_TIMEOUT_MS: '2000',
  DELIVERY_BATCH_SIZE: '5',
  DELIVERY_LEASE_SECONDS: '60',
  // Three attempts in total, retried immediately, no jitter: deterministic tests.
  RETRY_SCHEDULE_SECONDS: '0,0',
  RETRY_JITTER: '0',
  CIRCUIT_BREAKER_THRESHOLD: '5',
  SECRET_ROTATION_GRACE_HOURS: '24',
});
