import { defineConfig } from 'oxlint';

// Oxlint config for mcp-compress-router.
//
// Unlike ESLint, oxlint has no single "recommended" preset. Rules are
// grouped into categories (`correctness`, `suspicious`, `restriction`,
// `pedantic`, `style`, `perf`, `nursery`). We enable only `correctness`
// (error), the closest match to the previous `eslint:recommended` +
// `tseslint:recommended` safety-critical rules. The stricter/stylistic
// categories (`suspicious`, `restriction`, `pedantic`, `style`) are left
// off: they forbid idiomatic modern TypeScript and the project's own
// conventions (e.g. `_`-prefixed private fields, optional chaining,
// object spread, `undefined`), which the previous ESLint config never
// enforced.
//
// `no-unused-vars`, `max-lines`, `max-lines-per-function` and
// `preserve-caught-error` are set explicitly so the project's existing
// hard gates keep firing.
export default defineConfig({
  env: {
    node: true,
    es2022: true,
  },
  categories: {
    correctness: 'error',
  },
  // The previous ESLint config extended `tseslint:recommended`, so keep the
  // `typescript` plugin enabled. Plugins not listed here (e.g. `unicorn`,
  // `react`, `jest`) are disabled — the project never used them, and oxlint
  // would otherwise fire rules the old config never enforced. Core `oxc`/
  // `eslint` rules are always active and are not affected by this list.
  plugins: ['typescript'],
  rules: {
    'no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      },
    ],
    'max-lines': [
      'error',
      {
        max: 300,
        skipBlankLines: true,
        skipComments: true,
      },
    ],
    'max-lines-per-function': [
      'error',
      {
        max: 50,
        skipBlankLines: true,
        skipComments: true,
      },
    ],
    'preserve-caught-error': 'error',
  },
  overrides: [
    {
      files: ['**/*.test.ts', 'test/**'],
      rules: {
        'max-lines-per-function': 'off',
        'max-lines': [
          'error',
          {
            max: 500,
            skipBlankLines: true,
            skipComments: true,
          },
        ],
      },
    },
  ],
});
