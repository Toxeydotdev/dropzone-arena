import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

import {
  createViteDeploymentMetadataPlugin,
  resolveWebDeploymentMetadata,
} from '../../tools/deployment/metadata.mjs';

const root = import.meta.dirname;
const DEFAULT_ONLINE_AUTHORITY_PROXY_TARGET = 'http://localhost:4302';

export function resolveOnlineAuthorityProxyTarget(value: string | undefined): string {
  const candidate = value ?? DEFAULT_ONLINE_AUTHORITY_PROXY_TARGET;
  let target: URL;

  try {
    target = new URL(candidate);
  } catch {
    throw new Error('ONLINE_AUTHORITY_PROXY_TARGET must be a valid HTTP(S) origin.');
  }

  const hasQueryOrHash =
    target.search !== '' ||
    target.hash !== '' ||
    candidate.includes('?') ||
    candidate.includes('#');
  if (
    candidate.length === 0 ||
    candidate !== candidate.trim() ||
    (target.protocol !== 'http:' && target.protocol !== 'https:') ||
    target.username !== '' ||
    target.password !== '' ||
    target.pathname !== '/' ||
    hasQueryOrHash
  ) {
    throw new Error(
      'ONLINE_AUTHORITY_PROXY_TARGET must be an HTTP(S) origin without credentials, path, query, or hash.',
    );
  }

  return target.origin;
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, root, '');
  const proxyTarget = resolveOnlineAuthorityProxyTarget(
    environment.ONLINE_AUTHORITY_PROXY_TARGET,
  );
  const deploymentMetadata = resolveWebDeploymentMetadata(environment);

  return {
    root,
    cacheDir: '../../node_modules/.vite/apps/web',
    plugins: [react(), createViteDeploymentMetadataPlugin(deploymentMetadata)],
    resolve: {
      alias: {
        '@dropzone-arena/arena-client': `${root}/../../libs/arena-client/src/index.ts`,
        '@dropzone-arena/arena-engine': `${root}/../../libs/arena-engine/src/index.ts`,
      },
    },
    server: {
      host: 'localhost',
      port: 4300,
      strictPort: true,
      proxy: {
        '/api': {
          changeOrigin: false,
          target: proxyTarget,
        },
        '/ws': {
          changeOrigin: false,
          rewriteWsOrigin: false,
          target: proxyTarget,
          ws: true,
        },
      },
    },
    preview: {
      host: 'localhost',
      port: 4301,
      strictPort: true,
    },
    build: {
      outDir: '../../dist/apps/web',
      emptyOutDir: true,
      reportCompressedSize: true,
      rolldownOptions: {
        output: {
          strictExecutionOrder: true,
          codeSplitting: {
            groups: [
              {
                name: 'three-runtime',
                test: /node_modules[\\/]three[\\/]src/,
                minSize: 180_000,
                maxSize: 480_000,
                priority: 20,
              },
            ],
          },
        },
      },
    },
    test: {
      name: 'web',
      watch: false,
      environment: 'jsdom',
      include: ['src/**/*.{spec,test}.{ts,tsx}'],
      setupFiles: ['./src/test-setup.ts'],
      reporters: ['default'],
      coverage: {
        provider: 'v8',
        reportsDirectory: '../../coverage/apps/web',
      },
    },
  };
});
