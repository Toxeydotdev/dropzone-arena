import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'arena-protocol',
    watch: false,
    passWithNoTests: true,
    environment: 'node',
    include: ['src/**/*.{spec,test}.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/libs/arena-protocol',
    },
  },
});
