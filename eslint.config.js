import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  // `.worktrees` holds git worktrees for other branches, each a second checkout of this
  // repository. Linting into them makes every run report a second candidate tsconfig root
  // and fail on every file, so a stray worktree breaks `npm run lint` for the branch in hand.
  { ignores: ['dist', 'node_modules', 'playwright-report', 'test-results', '.worktrees'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...reactRefresh.configs.vite.rules,
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  { rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  {
    // The server runs under `node --experimental-strip-types`, which erases type annotations
    // without rewriting code. A constructor parameter property (`constructor(private db: Db)`)
    // is the one TypeScript form that needs a rewrite to mean anything, so Node refuses to load
    // the file at all. Vite transpiles it, so unit tests and the build both pass and only the
    // real server falls over — this rule moves that failure back to `npm run lint`.
    files: ['server/**/*.ts', 'shared/**/*.ts'],
    rules: { '@typescript-eslint/parameter-properties': ['error', { prefer: 'class-property' }] },
  },
);
