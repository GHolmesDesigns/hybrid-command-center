import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    coverage: { reporter: ['text'] },
    projects: [
      {
        test: {
          name: 'shared',
          environment: 'node',
          include: ['shared/**/*.test.ts'],
          setupFiles: ['./shared/test-setup.ts'],
        },
      },
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['client/**/*.test.tsx'],
          setupFiles: ['./client/src/test-setup.ts'],
        },
      },
    ],
  },
});
