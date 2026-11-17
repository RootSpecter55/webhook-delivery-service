const shared = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  clearMocks: true,
};

/** @type {import('jest').Config} */
export default {
  projects: [
    { ...shared, displayName: 'unit', roots: ['<rootDir>/tests/unit'] },
    {
      ...shared,
      displayName: 'integration',
      roots: ['<rootDir>/tests/integration'],
      // Creates the test database if needed and applies migrations.
      globalSetup: '<rootDir>/tests/global-setup.ts',
    },
  ],
};
