import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@dropzone-arena/arena-engine': `${root}/../arena-engine/src/index.ts`,
      '@dropzone-arena/arena-protocol': `${root}/../arena-protocol/src/index.ts`,
    },
  },
  test: {
    name: 'arena-client',
    watch: false,
    environment: 'jsdom',
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/libs/arena-client',
    },
  },
});
