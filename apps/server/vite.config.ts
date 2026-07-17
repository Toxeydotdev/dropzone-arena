import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

import {
  createViteDeploymentMetadataPlugin,
  resolveAuthorityDeploymentMetadata,
} from '../../tools/deployment/metadata.mjs';

const root = import.meta.dirname;

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, root, '');
  const deploymentMetadata = resolveAuthorityDeploymentMetadata(environment);

  return {
    root,
    cacheDir: '../../node_modules/.vite/apps/server',
    define: {
      __AUTHORITY_ARTIFACT_BUILD_ID__: JSON.stringify(
        deploymentMetadata.release ? deploymentMetadata.buildId : '',
      ),
    },
    plugins: [createViteDeploymentMetadataPlugin(deploymentMetadata)],
    resolve: {
      alias: {
        '@dropzone-arena/arena-engine': `${root}/../../libs/arena-engine/src/index.ts`,
        '@dropzone-arena/arena-protocol': `${root}/../../libs/arena-protocol/src/index.ts`,
      },
    },
    build: {
      target: 'node24',
      outDir: '../../dist/apps/server',
      emptyOutDir: true,
      sourcemap: true,
      ssr: 'src/main.ts',
      rolldownOptions: {
        output: {
          entryFileNames: 'main.js',
          format: 'es',
        },
      },
    },
    test: {
      name: 'server',
      watch: false,
      passWithNoTests: true,
      environment: 'node',
      include: [
        'src/**/*.{spec,test}.ts',
        '../../tools/deployment/**/*.{spec,test}.mjs',
      ],
      reporters: ['default'],
      coverage: {
        provider: 'v8',
        reportsDirectory: '../../coverage/apps/server',
      },
    },
  };
});
