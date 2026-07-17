import { describe, expect, it, vi } from 'vitest';

import {
  DeploymentArgumentError,
  parseLoadArguments,
  parseSmokeArguments,
} from './arguments.mjs';
import {
  createViteDeploymentMetadataPlugin,
  parseDeploymentMetadata,
  resolveAuthorityDeploymentMetadata,
  resolveWebDeploymentMetadata,
} from './metadata.mjs';
import {
  DeploymentCheckError,
  cleanupSessions,
  createIncreasingTickValidator,
  requireMatchingWebReleaseMetadata,
} from './runtime.mjs';

const SOURCE_REVISION = 'a'.repeat(40);
const RELEASE_IDENTITY = {
  DEPLOYMENT_CONFIGURATION_ID: 'candidate-config-7',
  DEPLOYMENT_RELEASE: 'true',
  DEPLOYMENT_SOURCE_REVISION: SOURCE_REVISION,
};

describe('deployment metadata', () => {
  it('keeps ordinary local artifacts deterministic and provider-independent', () => {
    expect(
      resolveAuthorityDeploymentMetadata({
        ALLOWED_WEB_ORIGINS: 'https://provider-origin.example',
        BUILD_ID: 'provider-build',
        DEPLOYMENT_CONFIGURATION_ID: 'provider-config',
        DEPLOYMENT_SOURCE_REVISION: 'b'.repeat(40),
      }),
    ).toEqual({
      buildId: 'local',
      configurationId: 'local',
      protocolVersion: 1,
      publicConfiguration: { allowedWebOrigins: [] },
      release: false,
      schemaVersion: 1,
      service: 'dropzone-arena-authority',
      sourceRevision: 'local',
    });
  });

  it('records exact web release and public authority identity', () => {
    expect(
      resolveWebDeploymentMetadata({
        ...RELEASE_IDENTITY,
        VITE_BUILD_ID: 'candidate-build-7',
        VITE_ONLINE_AUTHORITY_URL: 'https://authority.example.test',
        VITE_ONLINE_ENABLED: 'true',
      }),
    ).toEqual({
      buildId: 'candidate-build-7',
      configurationId: 'candidate-config-7',
      protocolVersion: 1,
      publicConfiguration: {
        authorityOrigin: 'https://authority.example.test',
        onlineEnabled: true,
      },
      release: true,
      schemaVersion: 1,
      service: 'dropzone-arena-web',
      sourceRevision: SOURCE_REVISION,
    });
  });

  it('records exact allowlisted origins in authority release metadata', () => {
    const metadata = resolveAuthorityDeploymentMetadata({
      ...RELEASE_IDENTITY,
      ALLOWED_WEB_ORIGINS:
        'https://candidate.example.test,https://preview.example.test',
      BUILD_ID: 'candidate-build-7',
    });

    expect(metadata.publicConfiguration.allowedWebOrigins).toEqual([
      'https://candidate.example.test',
      'https://preview.example.test',
    ]);
  });

  it.each([
    [{ ...RELEASE_IDENTITY, VITE_ONLINE_ENABLED: 'true' }, 'VITE_BUILD_ID'],
    [
      {
        ...RELEASE_IDENTITY,
        VITE_BUILD_ID: 'candidate-build-7',
        VITE_ONLINE_ENABLED: 'true',
      },
      'VITE_ONLINE_AUTHORITY_URL',
    ],
    [
      {
        ...RELEASE_IDENTITY,
        DEPLOYMENT_SOURCE_REVISION: 'short-revision',
        VITE_BUILD_ID: 'candidate-build-7',
        VITE_ONLINE_ENABLED: 'false',
      },
      'DEPLOYMENT_SOURCE_REVISION',
    ],
  ])(
    'fails release web metadata closed for missing or invalid %s',
    (environment, key) => {
      expect(() => resolveWebDeploymentMetadata(environment)).toThrow(key);
    },
  );

  it('rejects duplicate or non-origin authority allowlists', () => {
    expect(() =>
      resolveAuthorityDeploymentMetadata({
        ...RELEASE_IDENTITY,
        ALLOWED_WEB_ORIGINS:
          'https://candidate.example.test,https://candidate.example.test',
        BUILD_ID: 'candidate-build-7',
      }),
    ).toThrow('ALLOWED_WEB_ORIGINS');
    expect(() =>
      resolveAuthorityDeploymentMetadata({
        ...RELEASE_IDENTITY,
        ALLOWED_WEB_ORIGINS: 'https://candidate.example.test/path',
        BUILD_ID: 'candidate-build-7',
      }),
    ).toThrow('ALLOWED_WEB_ORIGINS');
  });

  it('emits one stable deployment.json asset and rejects extra metadata fields', () => {
    const metadata = resolveWebDeploymentMetadata({});
    const emitted = [];
    const plugin = createViteDeploymentMetadataPlugin(metadata);

    plugin.generateBundle.call({ emitFile: (asset) => emitted.push(asset) });

    expect(emitted).toEqual([
      {
        fileName: 'deployment.json',
        source: `${JSON.stringify(metadata, null, 2)}\n`,
        type: 'asset',
      },
    ]);
    expect(() => parseDeploymentMetadata({ ...metadata, generatedAt: 'now' })).toThrow(
      'Invalid deployment metadata',
    );
  });

  it('rejects a smoke expectation that mismatches release-pair identity', () => {
    const metadata = resolveWebDeploymentMetadata({
      ...RELEASE_IDENTITY,
      VITE_BUILD_ID: 'candidate-build-7',
      VITE_ONLINE_AUTHORITY_URL: 'https://authority.example.test',
      VITE_ONLINE_ENABLED: 'true',
    });
    const expected = {
      authorityOrigin: 'https://authority.example.test',
      buildId: 'candidate-build-7',
      configurationId: 'candidate-config-7',
      sourceRevision: SOURCE_REVISION,
    };

    expect(requireMatchingWebReleaseMetadata(metadata, expected)).toEqual(metadata);
    expect(() =>
      requireMatchingWebReleaseMetadata(metadata, {
        ...expected,
        sourceRevision: 'b'.repeat(40),
      }),
    ).toThrow('release-identity-mismatch');
    expect(() =>
      requireMatchingWebReleaseMetadata(metadata, {
        ...expected,
        authorityOrigin: 'https://other-authority.example.test',
      }),
    ).toThrow('release-identity-mismatch');
  });
});

describe('deployment command arguments', () => {
  const secureSmokeArguments = [
    '--web-url',
    'https://candidate.example.test',
    '--authority-url',
    'https://authority.example.test',
    '--build-id',
    'candidate-build-7',
    '--source-revision',
    SOURCE_REVISION,
    '--configuration-id',
    'candidate-config-7',
  ];

  it('parses fail-closed HTTPS smoke identity with deterministic defaults', () => {
    expect(parseSmokeArguments(secureSmokeArguments)).toMatchObject({
      allowInsecureLoopbackForLocalTest: false,
      authorityOrigin: 'https://authority.example.test',
      buildId: 'candidate-build-7',
      configurationId: 'candidate-config-7',
      deadlineMs: 30_000,
      sourceRevision: SOURCE_REVISION,
      unlistedOrigin: 'https://deployment-smoke-unlisted.invalid',
      webOrigin: 'https://candidate.example.test',
    });
  });

  it('requires the clearly named escape for HTTP and limits it to loopback', () => {
    const localArguments = secureSmokeArguments.map((argument) =>
      argument === 'https://candidate.example.test'
        ? 'http://127.0.0.1:4301'
        : argument === 'https://authority.example.test'
          ? 'http://localhost:4302'
          : argument,
    );
    expect(() => parseSmokeArguments(localArguments)).toThrow(DeploymentArgumentError);
    expect(
      parseSmokeArguments([
        ...localArguments,
        '--allow-insecure-loopback-for-local-test',
      ]),
    ).toMatchObject({
      authorityOrigin: 'http://localhost:4302',
      webOrigin: 'http://127.0.0.1:4301',
    });
    expect(() =>
      parseSmokeArguments([
        ...secureSmokeArguments.map((argument) =>
          argument === 'https://authority.example.test'
            ? 'http://public.example.test'
            : argument,
        ),
        '--allow-insecure-loopback-for-local-test',
      ]),
    ).toThrow('requires HTTPS');
  });

  it('defaults load to 32, requires isolated-candidate confirmation, and rejects 33', () => {
    const base = [
      '--authority-url',
      'https://authority.example.test',
      '--web-origin',
      'https://candidate.example.test',
      '--build-id',
      'candidate-build-7',
    ];
    expect(() => parseLoadArguments(base)).toThrow(
      'confirm-isolated-pre-enable-candidate',
    );
    expect(
      parseLoadArguments([...base, '--confirm-isolated-pre-enable-candidate']),
    ).toMatchObject({ clientCount: 32, deadlineMs: 90_000 });
    expect(() =>
      parseLoadArguments([
        ...base,
        '--confirm-isolated-pre-enable-candidate',
        '--clients',
        '33',
      ]),
    ).toThrow('clients');
  });

  it('does not reflect invalid identity values in argument errors', () => {
    let caught;
    try {
      parseSmokeArguments(
        secureSmokeArguments.map((argument) =>
          argument === 'candidate-build-7' ? 'secret value' : argument,
        ),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeploymentArgumentError);
    expect(caught.message).not.toContain('secret value');

    let unknown;
    try {
      parseSmokeArguments(['--credential-shaped-unknown-option']);
    } catch (error) {
      unknown = error;
    }
    expect(unknown.option).toBe('arguments');
    expect(unknown.message).not.toContain('credential-shaped');
  });
});

describe('deployment runtime helpers', () => {
  it('requires every authoritative tick to increase strictly', () => {
    const advance = createIncreasingTickValidator(12);
    expect(advance(15)).toBe(15);
    expect(advance(18)).toBe(18);
    expect(() => advance(18)).toThrow(DeploymentCheckError);
  });

  it('attempts every cleanup and reports failures without short-circuiting', async () => {
    const firstCleanup = vi.fn(async () => undefined);
    const failedCleanup = vi.fn(async () => {
      throw new Error('cleanup failure');
    });
    const lastCleanup = vi.fn(async () => undefined);
    const sessions = [firstCleanup, failedCleanup, lastCleanup].map((cleanup) => ({
      cleanup,
      close: vi.fn(),
    }));

    await expect(cleanupSessions(sessions, 1_000)).resolves.toBe(1);
    expect(firstCleanup).toHaveBeenCalledOnce();
    expect(failedCleanup).toHaveBeenCalledOnce();
    expect(lastCleanup).toHaveBeenCalledOnce();
    expect(sessions.every((session) => session.close.mock.calls.length === 1)).toBe(
      true,
    );
  });
});
