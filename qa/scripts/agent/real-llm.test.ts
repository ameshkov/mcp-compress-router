import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REAL_LLM_MODEL,
  resolveRealLlmModel,
  resolveRealLlmOptions,
  splitRealModelRef,
} from './real-llm.js';

describe('resolveRealLlmModel', () => {
  it('uses the default model without requiring the API key', () => {
    expect(resolveRealLlmModel({})).toBe(DEFAULT_REAL_LLM_MODEL);
  });

  it('uses the configured model when set', () => {
    expect(resolveRealLlmModel({ QA_REAL_LLM_MODEL: 'openrouter/deepseek/v4' })).toBe(
      'openrouter/deepseek/v4',
    );
  });

  it('treats a blank model as unset', () => {
    expect(resolveRealLlmModel({ QA_REAL_LLM_MODEL: '   ' })).toBe(DEFAULT_REAL_LLM_MODEL);
  });
});

describe('resolveRealLlmOptions', () => {
  it('requires the OpenRouter API key', () => {
    expect(() => resolveRealLlmOptions({})).toThrow(/QA_OPENROUTER_API_KEY/);
  });

  it('uses the default model when QA_REAL_LLM_MODEL is unset', () => {
    const options = resolveRealLlmOptions({ QA_OPENROUTER_API_KEY: 'key' });
    expect(options.model).toBe(DEFAULT_REAL_LLM_MODEL);
  });

  it('uses the configured model when set', () => {
    const options = resolveRealLlmOptions({
      QA_OPENROUTER_API_KEY: 'key',
      QA_REAL_LLM_MODEL: 'openrouter/deepseek/deepseek-v4.1-flash',
    });
    expect(options.model).toBe('openrouter/deepseek/deepseek-v4.1-flash');
  });
});

describe('splitRealModelRef', () => {
  it('splits a provider/model reference', () => {
    expect(splitRealModelRef('openrouter/~deepseek/deepseek-flash-latest')).toEqual({
      provider: 'openrouter',
      model: '~deepseek/deepseek-flash-latest',
    });
  });

  it('rejects another provider', () => {
    expect(() => splitRealModelRef('deepseek/deepseek-v4.1-flash')).toThrow(/openrouter/);
  });

  it('rejects a malformed reference', () => {
    expect(() => splitRealModelRef('nodash')).toThrow(/<provider>\/<model>/);
    expect(() => splitRealModelRef('openrouter/')).toThrow(/<provider>\/<model>/);
  });
});
