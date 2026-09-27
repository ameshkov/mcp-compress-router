import { describe, expect, it } from 'vitest';
import { scriptArgs } from './args.js';

describe('script arguments', () => {
  it('drops separator arguments', () => {
    expect(scriptArgs(['--', '--mode', 'router'])).toEqual(['--mode', 'router']);
  });

  it('keeps ordinary arguments untouched', () => {
    expect(scriptArgs(['--agents', 'claude,opencode'])).toEqual(['--agents', 'claude,opencode']);
  });
});
