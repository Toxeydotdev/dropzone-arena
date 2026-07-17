import { describe, expect, it } from 'vitest';

import {
  AUTHORITY_DEFAULTS,
  AuthorityConfigurationError,
  loadAuthorityConfig,
} from './config';

const VALID_ENVIRONMENT = {
  ALLOWED_WEB_ORIGINS: 'https://play.example.test,http://localhost:4300',
  BUILD_ID: 'build-0123456789abcdef',
  PORT: '3000',
} as const;

describe('authority configuration', () => {
  it('loads typed bounded defaults and always binds the provider port on all interfaces', () => {
    const config = loadAuthorityConfig(VALID_ENVIRONMENT);

    expect(config).toMatchObject({
      ...AUTHORITY_DEFAULTS,
      allowedWebOrigins: ['https://play.example.test', 'http://localhost:4300'],
      buildId: 'build-0123456789abcdef',
      host: '0.0.0.0',
      maxInboundMessageBytes: 8 * 1024,
      maxQuickplayBodyBytes: 1024,
      port: 3000,
      reconnectGraceMs: 10_000,
      reservationTtlMs: 10_000,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.allowedWebOrigins)).toBe(true);
  });

  it.each([
    ['PORT', { ...VALID_ENVIRONMENT, PORT: undefined }],
    ['PORT', { ...VALID_ENVIRONMENT, PORT: '0' }],
    ['PORT', { ...VALID_ENVIRONMENT, PORT: '3000.5' }],
    ['BUILD_ID', { ...VALID_ENVIRONMENT, BUILD_ID: '' }],
    ['BUILD_ID', { ...VALID_ENVIRONMENT, BUILD_ID: '../secret' }],
    ['ALLOWED_WEB_ORIGINS', { ...VALID_ENVIRONMENT, ALLOWED_WEB_ORIGINS: '' }],
    ['ALLOWED_WEB_ORIGINS', { ...VALID_ENVIRONMENT, ALLOWED_WEB_ORIGINS: '*' }],
    [
      'ALLOWED_WEB_ORIGINS',
      { ...VALID_ENVIRONMENT, ALLOWED_WEB_ORIGINS: 'https://play.example.test/' },
    ],
    [
      'ALLOWED_WEB_ORIGINS',
      { ...VALID_ENVIRONMENT, ALLOWED_WEB_ORIGINS: 'https://play.example.test/path' },
    ],
    [
      'ALLOWED_WEB_ORIGINS',
      {
        ...VALID_ENVIRONMENT,
        ALLOWED_WEB_ORIGINS: 'https://play.example.test,https://play.example.test',
      },
    ],
    ['ADMISSION_ENABLED', { ...VALID_ENVIRONMENT, ADMISSION_ENABLED: 'yes' }],
    ['TRUSTED_PROXY_HOPS', { ...VALID_ENVIRONMENT, TRUSTED_PROXY_HOPS: '3' }],
    ['MAX_PLAYERS_PER_ROOM', { ...VALID_ENVIRONMENT, MAX_PLAYERS_PER_ROOM: '9' }],
    ['MAX_ROOMS', { ...VALID_ENVIRONMENT, MAX_ROOMS: '5' }],
    ['MAX_SESSIONS', { ...VALID_ENVIRONMENT, MAX_ROOMS: '1' }],
    [
      'MAX_RESERVATIONS',
      { ...VALID_ENVIRONMENT, MAX_RESERVATIONS: '16', MAX_SESSIONS: '8' },
    ],
    ['MAX_CONNECTIONS', { ...VALID_ENVIRONMENT, MAX_CONNECTIONS: '31' }],
    [
      'MAX_SESSIONS_PER_SOURCE',
      { ...VALID_ENVIRONMENT, MAX_SESSIONS_PER_SOURCE: '33' },
    ],
    ['DRAIN_TIMEOUT_MS', { ...VALID_ENVIRONMENT, DRAIN_TIMEOUT_MS: '99' }],
  ])('fails closed for invalid %s without reflecting its value', (key, environment) => {
    let caught: unknown;
    try {
      loadAuthorityConfig(environment);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuthorityConfigurationError);
    expect((caught as Error).message).toBe(`Invalid authority configuration: ${key}`);
    expect((caught as Error).message).not.toContain('secret');
  });

  it('accepts only explicit boolean and bounded capacity/rate overrides', () => {
    const config = loadAuthorityConfig({
      ...VALID_ENVIRONMENT,
      ADMISSION_ENABLED: 'false',
      CONNECTION_ATTEMPTS_PER_MINUTE: '24',
      DRAIN_TIMEOUT_MS: '500',
      MAX_CONNECTIONS: '8',
      MAX_PLAYERS_PER_ROOM: '2',
      MAX_RESERVATIONS: '4',
      MAX_ROOMS: '2',
      MAX_SESSIONS: '4',
      MAX_SESSIONS_PER_SOURCE: '2',
      QUICKPLAY_REQUESTS_PER_MINUTE: '6',
      ROOM_IDLE_TTL_MS: '1000',
      TRUSTED_PROXY_HOPS: '1',
    });

    expect(config).toMatchObject({
      admissionEnabled: false,
      connectionAttemptsPerMinute: 24,
      drainTimeoutMs: 500,
      maxConnections: 8,
      maxPlayersPerRoom: 2,
      maxReservations: 4,
      maxRooms: 2,
      maxSessions: 4,
      maxSessionsPerSource: 2,
      quickplayRequestsPerMinute: 6,
      roomIdleTtlMs: 1000,
      trustedProxyHops: 1,
    });
  });

  it('allows the isolated candidate load bounds without changing production defaults', () => {
    const config = loadAuthorityConfig({
      ...VALID_ENVIRONMENT,
      MAX_SESSIONS_PER_SOURCE: '32',
      QUICKPLAY_REQUESTS_PER_MINUTE: '60',
    });

    expect(AUTHORITY_DEFAULTS.maxSessionsPerSource).toBe(4);
    expect(AUTHORITY_DEFAULTS.quickplayRequestsPerMinute).toBe(12);
    expect(config.maxSessionsPerSource).toBe(32);
    expect(config.quickplayRequestsPerMinute).toBe(60);
  });

  it('rejects a runtime build identity that differs from the release artifact', () => {
    expect(() => loadAuthorityConfig(VALID_ENVIRONMENT, 'other-build')).toThrow(
      'Invalid authority configuration: BUILD_ID',
    );
    expect(
      loadAuthorityConfig(VALID_ENVIRONMENT, VALID_ENVIRONMENT.BUILD_ID).buildId,
    ).toBe(VALID_ENVIRONMENT.BUILD_ID);
  });
});
