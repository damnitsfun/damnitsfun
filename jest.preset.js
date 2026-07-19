/**
 * Shared Jest preset for the TS workspaces (engine, api, reference-agent).
 * Each workspace's jest.config.js does: module.exports = require('../../jest.preset.js');
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts', '**/src/**/*.test.ts'],
  passWithNoTests: true,
};
