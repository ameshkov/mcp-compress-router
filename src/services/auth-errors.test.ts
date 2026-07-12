import { describe, it, expect } from 'vitest';
import { GuidedAuthError } from './index.js';

describe('GuidedAuthError', () => {
  it('is an instance of Error', () => {
    const err = new GuidedAuthError('figma');
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of GuidedAuthError', () => {
    const err = new GuidedAuthError('figma');
    expect(err).toBeInstanceOf(GuidedAuthError);
  });

  it('carries the server name', () => {
    const err = new GuidedAuthError('figma');
    expect(err.serverName).toBe('figma');
  });

  it('has a descriptive message containing the server name', () => {
    const err = new GuidedAuthError('figma');
    expect(err.message).toContain('figma');
    expect(err.message).toContain('Authentication');
  });

  it('sets the name property to GuidedAuthError', () => {
    const err = new GuidedAuthError('figma');
    expect(err.name).toBe('GuidedAuthError');
  });
});
