import { ENGINE_PACKAGE } from './index';

describe('engine package scaffold', () => {
  it('is a valid, importable workspace', () => {
    expect(ENGINE_PACKAGE).toBe('engine');
  });
});
