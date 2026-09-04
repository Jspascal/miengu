import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const DETERMINISM_MESSAGE =
  'replay determinism: record the value in the event, never recompute it';

export default tseslint.config(
  // Build output, never source. `npm run build` did not produce `dist/` until Group 7 (the CLI
  // entrypoint gives `tsc` something to emit), so this had no observable effect before now.
  { ignores: ['dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', 'vitest.config.ts', 'test/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Plain Node scripts (test fixtures) reference Node globals directly, without the
    // ambient @types/node declarations a tsconfig-linted file gets. `no-undef` cannot see
    // those, so they are declared explicitly here rather than pulling in a globals package.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    files: [
      // NOT 'src/state/**' — stateHash.ts is deliberately outside the pure zone:
      // it needs hash.ts to exist at all. Listed explicitly so the exemption is
      // visible and a new src/state file must opt in rather than silently inherit.
      'src/state/workitem.ts',
      'src/state/projector.ts',
      'src/supervisor/nextStage.ts',
      'src/supervisor/budget.ts',
      'src/core/ids.ts',
      'src/core/canonical.ts',
      'src/core/provenance.ts',
      'src/core/events.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'node:fs',
            'node:fs/promises',
            'node:crypto',
            'node:child_process',
            'node:os',
            'node:process',
            'node:perf_hooks',
            'node:worker_threads',
            'pino',
          ],
          patterns: [
            '**/clock.js',
            '**/idgen.js',
            '**/hash.js',
            '**/log.js',
            '**/snapshot.js',
            '../executors/*',
            '../cli/*',
            '../config/*',
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: DETERMINISM_MESSAGE,
        },
        {
          selector:
            "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: DETERMINISM_MESSAGE,
        },
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: DETERMINISM_MESSAGE,
        },
        {
          selector: "MemberExpression[object.name='process']",
          message: DETERMINISM_MESSAGE,
        },
        {
          selector: "MemberExpression[object.name='performance']",
          message: DETERMINISM_MESSAGE,
        },
      ],
      'no-restricted-globals': ['error', 'require', '__dirname', '__filename'],
    },
  },
);
