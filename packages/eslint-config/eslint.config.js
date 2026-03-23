/**
 * @zerobias-org/eslint-config — shared flat config for all Hub modules
 *
 * Used by Gradle lint task: eslint --config node_modules/@zerobias-org/eslint-config/eslint.config.js
 * Module developers don't create eslint configs — this is the platform standard.
 */

import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    // Global ignores — must be a separate config object with ONLY ignores
    ignores: [
      '**/generated/**',
      '**/hub-sdk/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/build/**',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // TypeScript
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',

      // Code quality
      'no-console': 'off',
      'no-param-reassign': 'off',
      'no-plusplus': ['error', { allowForLoopAfterthoughts: true }],
      'max-len': ['warn', { code: 140, ignoreComments: true, ignoreStrings: true }],
    },
  },
];
