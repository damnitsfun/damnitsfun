const base = require('../../jest.preset.js');

/**
 * Two projects:
 *  - `engine`: our own tests (src/**, test/**), compiled with the strict engine
 *    tsconfig. These import the vendored library through vendor-dist (built by
 *    the `pretest` hook), so vendored source is never type-checked here.
 *  - `vendor-uno`: the vendored Jest suite, run UNMODIFIED with the vendored
 *    (non-strict) tsconfig. Proves T1 — vendored tests pass with zero edits.
 */
const { passWithNoTests, ...projectBase } = base;

module.exports = {
  passWithNoTests,
  projects: [
    {
      ...projectBase,
      displayName: 'engine',
      rootDir: __dirname,
      testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/test/**/*.test.ts'],
    },
    {
      displayName: 'vendor-uno',
      rootDir: __dirname,
      testEnvironment: 'node',
      testMatch: ['<rootDir>/vendor/uno/test/**/*.ts'],
      transform: {
        '^.+\\.ts$': [
          'ts-jest',
          { tsconfig: '<rootDir>/tsconfig.vendor-test.json', isolatedModules: false },
        ],
      },
    },
  ],
};
