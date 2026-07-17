import { describe, expect, it } from 'vitest';

import {
  parsePublicOnlineConfig,
  type PublicOnlineConfigContext,
  type PublicOnlineEnvironment,
} from './online-config';

const DEVELOPMENT_CONTEXT: PublicOnlineConfigContext = {
  browserOrigin: 'http://localhost:4300',
  production: false,
};

const ENABLED_ENVIRONMENT: PublicOnlineEnvironment = {
  VITE_BUILD_ID: 'local-development',
  VITE_ONLINE_AUTHORITY_URL: 'https://arena.example.test',
  VITE_ONLINE_ENABLED: 'true',
};

describe('parsePublicOnlineConfig', () => {
  it('defaults missing enablement to an explicit disabled reason', () => {
    expect(parsePublicOnlineConfig({}, DEVELOPMENT_CONTEXT)).toEqual({
      enabled: false,
      reason: expect.stringContaining('enablement is missing'),
    });
  });

  it('honors explicit disablement without requiring the remaining configuration', () => {
    expect(
      parsePublicOnlineConfig({ VITE_ONLINE_ENABLED: 'false' }, DEVELOPMENT_CONTEXT),
    ).toEqual({
      enabled: false,
      reason: expect.stringContaining('disabled for this build'),
    });
  });

  it.each(['TRUE', '1', 'yes', ' true '])(
    'rejects non-exact enablement value %j',
    (VITE_ONLINE_ENABLED) => {
      expect(
        parsePublicOnlineConfig({ VITE_ONLINE_ENABLED }, DEVELOPMENT_CONTEXT),
      ).toEqual({
        enabled: false,
        reason: expect.stringContaining('must be exactly'),
      });
    },
  );

  it('requires a build ID when online play is enabled', () => {
    expect(
      parsePublicOnlineConfig(
        { ...ENABLED_ENVIRONMENT, VITE_BUILD_ID: undefined },
        DEVELOPMENT_CONTEXT,
      ),
    ).toEqual({
      enabled: false,
      reason: expect.stringContaining('no build ID'),
    });
  });

  it.each(['../release', '-release', 'build id', `b${'0'.repeat(64)}`])(
    'rejects build ID %j outside the public contract',
    (VITE_BUILD_ID) => {
      expect(
        parsePublicOnlineConfig(
          { ...ENABLED_ENVIRONMENT, VITE_BUILD_ID },
          DEVELOPMENT_CONTEXT,
        ),
      ).toEqual({
        enabled: false,
        reason: expect.stringContaining('invalid build ID'),
      });
    },
  );

  it('accepts the maximum public build ID length', () => {
    const buildId = `b${'0'.repeat(63)}`;
    expect(
      parsePublicOnlineConfig(
        { ...ENABLED_ENVIRONMENT, VITE_BUILD_ID: buildId },
        DEVELOPMENT_CONTEXT,
      ),
    ).toEqual({
      authorityUrl: 'https://arena.example.test',
      buildId,
      enabled: true,
    });
  });

  it('requires an authority when online play is enabled', () => {
    expect(
      parsePublicOnlineConfig(
        { ...ENABLED_ENVIRONMENT, VITE_ONLINE_AUTHORITY_URL: undefined },
        DEVELOPMENT_CONTEXT,
      ),
    ).toEqual({
      enabled: false,
      reason: expect.stringContaining('no online authority'),
    });
  });

  it.each(['not a URL', '/api', 'ftp://arena.example.test'])(
    'rejects malformed or unsupported authority %j',
    (VITE_ONLINE_AUTHORITY_URL) => {
      expect(
        parsePublicOnlineConfig(
          { ...ENABLED_ENVIRONMENT, VITE_ONLINE_AUTHORITY_URL },
          DEVELOPMENT_CONTEXT,
        ).enabled,
      ).toBe(false);
    },
  );

  it('rejects credentialed authority URLs', () => {
    expect(
      parsePublicOnlineConfig(
        {
          ...ENABLED_ENVIRONMENT,
          VITE_ONLINE_AUTHORITY_URL: 'https://player:secret@arena.example.test',
        },
        DEVELOPMENT_CONTEXT,
      ),
    ).toEqual({
      enabled: false,
      reason: expect.stringContaining('credentials'),
    });
  });

  it.each([
    'https://arena.example.test/api',
    'https://arena.example.test/?region=local',
    'https://arena.example.test/#status',
  ])('rejects non-origin authority URL %j', (VITE_ONLINE_AUTHORITY_URL) => {
    expect(
      parsePublicOnlineConfig(
        { ...ENABLED_ENVIRONMENT, VITE_ONLINE_AUTHORITY_URL },
        DEVELOPMENT_CONTEXT,
      ).enabled,
    ).toBe(false);
  });

  it('rejects insecure public authority URLs in production', () => {
    expect(
      parsePublicOnlineConfig(
        {
          ...ENABLED_ENVIRONMENT,
          VITE_ONLINE_AUTHORITY_URL: 'http://arena.example.test',
        },
        { ...DEVELOPMENT_CONTEXT, production: true },
      ),
    ).toEqual({
      enabled: false,
      reason: expect.stringContaining('requires HTTPS'),
    });
  });

  it.each([
    'http://localhost:4302',
    'http://game.localhost:4302',
    'http://127.0.0.1:4302',
    'http://[::1]:4302',
  ])('allows local development authority %j', (VITE_ONLINE_AUTHORITY_URL) => {
    expect(
      parsePublicOnlineConfig(
        { ...ENABLED_ENVIRONMENT, VITE_ONLINE_AUTHORITY_URL },
        DEVELOPMENT_CONTEXT,
      ),
    ).toEqual({
      authorityUrl: VITE_ONLINE_AUTHORITY_URL,
      buildId: 'local-development',
      enabled: true,
    });
  });

  it('allows loopback HTTP for a production-build E2E authority', () => {
    expect(
      parsePublicOnlineConfig(
        {
          ...ENABLED_ENVIRONMENT,
          VITE_ONLINE_AUTHORITY_URL: 'http://127.0.0.1:4302',
        },
        { ...DEVELOPMENT_CONTEXT, production: true },
      ),
    ).toEqual({
      authorityUrl: 'http://127.0.0.1:4302',
      buildId: 'local-development',
      enabled: true,
    });
  });

  it('rejects insecure non-local authority URLs in development', () => {
    expect(
      parsePublicOnlineConfig(
        {
          ...ENABLED_ENVIRONMENT,
          VITE_ONLINE_AUTHORITY_URL: 'http://arena.example.test',
        },
        DEVELOPMENT_CONTEXT,
      ).enabled,
    ).toBe(false);
  });

  it('normalizes the development root authority to the browser origin', () => {
    expect(
      parsePublicOnlineConfig(
        { ...ENABLED_ENVIRONMENT, VITE_ONLINE_AUTHORITY_URL: '/' },
        DEVELOPMENT_CONTEXT,
      ),
    ).toEqual({
      authorityUrl: 'http://localhost:4300',
      buildId: 'local-development',
      enabled: true,
    });
  });

  it('accepts a secure origin in production', () => {
    expect(
      parsePublicOnlineConfig(ENABLED_ENVIRONMENT, {
        browserOrigin: 'https://dropzone.example.test',
        production: true,
      }),
    ).toEqual({
      authorityUrl: 'https://arena.example.test',
      buildId: 'local-development',
      enabled: true,
    });
  });
});
