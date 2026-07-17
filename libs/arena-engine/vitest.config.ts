import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'arena-engine',
    watch: false,
    environment: 'node',
    include: ['src/**/*.{spec,test}.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/libs/arena-engine',
    },
  },
});
