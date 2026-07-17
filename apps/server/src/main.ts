import { pathToFileURL } from 'node:url';

import { createAuthorityServer, createJsonAuthorityLogger } from './authority';
import { loadAuthorityConfig } from './config';

declare const __AUTHORITY_ARTIFACT_BUILD_ID__: string;

export * from './authority';
export * from './config';

export async function runAuthority(): Promise<void> {
  const logger = createJsonAuthorityLogger();
  let authority: ReturnType<typeof createAuthorityServer>;
  try {
    authority = createAuthorityServer(
      loadAuthorityConfig(process.env, __AUTHORITY_ARTIFACT_BUILD_ID__),
      { logger },
    );
    await authority.start();
  } catch {
    console.error(JSON.stringify({ event: 'configuration-invalid', level: 'error' }));
    process.exitCode = 1;
    return;
  }

  process.once('SIGTERM', () => {
    void authority.drain().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  });
}

const executablePath = process.argv[1];
if (
  executablePath !== undefined &&
  import.meta.url === pathToFileURL(executablePath).href
) {
  void runAuthority();
}
