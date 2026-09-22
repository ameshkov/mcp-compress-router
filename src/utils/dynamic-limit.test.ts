import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_DYNAMIC_LIMIT_MAX_SIZE,
  DEFAULT_DYNAMIC_LIMIT_CLIENTS,
  getDynamicLimitMaxSize,
  getDynamicLimitClients,
  isDynamicLimitClient,
  exceedsDynamicLimit,
} from './dynamic-limit.js';

const MAX_SIZE_ENV = 'MCP_COMPRESS_ROUTER_DYNAMIC_LIMIT_MAX_SIZE';
const CLIENTS_ENV = 'MCP_COMPRESS_ROUTER_DYNAMIC_LIMIT_CLIENTS';

describe('dynamic-limit', () => {
  const prevMaxSize = process.env[MAX_SIZE_ENV];
  const prevClients = process.env[CLIENTS_ENV];

  afterEach(() => {
    if (prevMaxSize === undefined) delete process.env[MAX_SIZE_ENV];
    else process.env[MAX_SIZE_ENV] = prevMaxSize;
    if (prevClients === undefined) delete process.env[CLIENTS_ENV];
    else process.env[CLIENTS_ENV] = prevClients;
  });

  describe('env defaults', () => {
    it('returns the documented defaults when the env vars are unset', () => {
      delete process.env[MAX_SIZE_ENV];
      delete process.env[CLIENTS_ENV];

      expect(DEFAULT_DYNAMIC_LIMIT_MAX_SIZE).toBe(2048);
      expect(DEFAULT_DYNAMIC_LIMIT_CLIENTS).toEqual(['claude-code']);
      expect(getDynamicLimitMaxSize()).toBe(2048);
      expect(getDynamicLimitClients()).toEqual(['claude-code']);
    });

    it('honors a positive-integer max size override', () => {
      process.env[MAX_SIZE_ENV] = '500';
      expect(getDynamicLimitMaxSize()).toBe(500);
    });

    it('falls back to the default for invalid max sizes', () => {
      for (const bad of ['not-a-number', '0', '-5', '3.5', '']) {
        process.env[MAX_SIZE_ENV] = bad;
        expect(getDynamicLimitMaxSize()).toBe(DEFAULT_DYNAMIC_LIMIT_MAX_SIZE);
      }
    });

    it('parses a comma-separated client list, trimming and lower-casing', () => {
      process.env[CLIENTS_ENV] = ' OpenCode , CODEX , claude-code ';
      expect(getDynamicLimitClients()).toEqual(['opencode', 'codex', 'claude-code']);
    });

    it('disables the client list when the variable is empty or whitespace', () => {
      for (const empty of ['', '   ', ' , ', ',']) {
        process.env[CLIENTS_ENV] = empty;
        expect(getDynamicLimitClients()).toEqual([]);
      }
    });

    it('returns a fresh array so callers cannot corrupt the defaults', () => {
      delete process.env[CLIENTS_ENV];
      getDynamicLimitClients().push('mutated');
      expect(DEFAULT_DYNAMIC_LIMIT_CLIENTS).toEqual(['claude-code']);
    });
  });

  describe('isDynamicLimitClient', () => {
    it('matches the default client case-insensitively and ignores others', () => {
      delete process.env[CLIENTS_ENV];

      expect(isDynamicLimitClient('claude-code')).toBe(true);
      expect(isDynamicLimitClient('Claude-Code')).toBe(true);
      expect(isDynamicLimitClient('opencode')).toBe(false);
      expect(isDynamicLimitClient(undefined)).toBe(false);
    });

    it('honors a custom client list', () => {
      process.env[CLIENTS_ENV] = 'opencode';
      expect(isDynamicLimitClient('opencode')).toBe(true);
      expect(isDynamicLimitClient('claude-code')).toBe(false);
    });

    it('returns false for every client when the list is disabled', () => {
      process.env[CLIENTS_ENV] = '   ';
      expect(isDynamicLimitClient('claude-code')).toBe(false);
    });
  });

  describe('exceedsDynamicLimit', () => {
    it('flags a listed client only when the description exceeds the cap', () => {
      delete process.env[MAX_SIZE_ENV];
      delete process.env[CLIENTS_ENV];

      expect(exceedsDynamicLimit('x'.repeat(2048), 'claude-code')).toBe(false);
      expect(exceedsDynamicLimit('x'.repeat(2049), 'claude-code')).toBe(true);
    });

    it('never flags clients outside the configured list', () => {
      delete process.env[MAX_SIZE_ENV];
      delete process.env[CLIENTS_ENV];

      expect(exceedsDynamicLimit('x'.repeat(10_000), 'opencode')).toBe(false);
      expect(exceedsDynamicLimit('x'.repeat(10_000), undefined)).toBe(false);
    });

    it('honors a custom max size', () => {
      process.env[MAX_SIZE_ENV] = '10';
      delete process.env[CLIENTS_ENV];

      expect(exceedsDynamicLimit('x'.repeat(10), 'claude-code')).toBe(false);
      expect(exceedsDynamicLimit('x'.repeat(11), 'claude-code')).toBe(true);
    });

    it('is disabled when the client list is empty', () => {
      delete process.env[MAX_SIZE_ENV];
      process.env[CLIENTS_ENV] = '';

      expect(exceedsDynamicLimit('x'.repeat(10_000), 'claude-code')).toBe(false);
    });
  });
});
