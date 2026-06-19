/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^chalk$': '<rootDir>/tests/__mocks__/chalk.ts',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageThreshold: {
    global: { lines: 70 },
  },
  // chalk v5+ is ESM-only; allow ts-jest to transform it in tests
  transformIgnorePatterns: ['node_modules/(?!(chalk|#ansi-styles|supports-color)/)'],
};
