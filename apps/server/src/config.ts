import {
  BuildIdSchema,
  MAX_INBOUND_MESSAGE_BYTES,
  MAX_PLAYERS_PER_ARENA,
  MAX_QUICKPLAY_BODY_BYTES,
  QUICKPLAY_RESERVATION_TTL_MS,
  RECONNECT_GRACE_MS,
} from '@dropzone-arena/arena-protocol';

export const AUTHORITY_DEFAULTS = Object.freeze({
  admissionEnabled: true,
  connectionAttemptsPerMinute: 60,
  drainTimeoutMs: 2_000,
  maxConnections: 48,
  maxPlayersPerRoom: MAX_PLAYERS_PER_ARENA,
  maxReservations: 16,
  maxRooms: 4,
  maxSessions: 32,
  maxSessionsPerSource: 4,
  quickplayRequestsPerMinute: 12,
  roomIdleTtlMs: 30_000,
  trustedProxyHops: 0,
} as const);

export interface AuthorityConfig {
  readonly admissionEnabled: boolean;
  readonly allowedWebOrigins: readonly string[];
  readonly buildId: string;
  readonly connectionAttemptsPerMinute: number;
  readonly drainTimeoutMs: number;
  readonly host: '0.0.0.0';
  readonly maxConnections: number;
  readonly maxInboundMessageBytes: typeof MAX_INBOUND_MESSAGE_BYTES;
  readonly maxPlayersPerRoom: number;
  readonly maxQuickplayBodyBytes: typeof MAX_QUICKPLAY_BODY_BYTES;
  readonly maxReservations: number;
  readonly maxRooms: number;
  readonly maxSessions: number;
  readonly maxSessionsPerSource: number;
  readonly port: number;
  readonly quickplayRequestsPerMinute: number;
  readonly reconnectGraceMs: typeof RECONNECT_GRACE_MS;
  readonly reservationTtlMs: typeof QUICKPLAY_RESERVATION_TTL_MS;
  readonly roomIdleTtlMs: number;
  readonly trustedProxyHops: number;
}

export class AuthorityConfigurationError extends Error {
  readonly code = 'CONFIGURATION_INVALID';

  constructor(key: string) {
    super(`Invalid authority configuration: ${key}`);
    this.name = 'AuthorityConfigurationError';
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

export function loadAuthorityConfig(
  environment: Environment,
  artifactBuildId = '',
): AuthorityConfig {
  const buildId = required(environment, 'BUILD_ID');
  if (!BuildIdSchema.safeParse(buildId).success) invalid('BUILD_ID');
  if (artifactBuildId !== '' && buildId !== artifactBuildId) invalid('BUILD_ID');

  const port = integer(environment, 'PORT', undefined, 1, 65_535);
  const allowedWebOrigins = origins(required(environment, 'ALLOWED_WEB_ORIGINS'));
  const maxRooms = integer(
    environment,
    'MAX_ROOMS',
    AUTHORITY_DEFAULTS.maxRooms,
    1,
    AUTHORITY_DEFAULTS.maxRooms,
  );
  const maxPlayersPerRoom = integer(
    environment,
    'MAX_PLAYERS_PER_ROOM',
    AUTHORITY_DEFAULTS.maxPlayersPerRoom,
    1,
    MAX_PLAYERS_PER_ARENA,
  );
  const maxSessions = integer(
    environment,
    'MAX_SESSIONS',
    AUTHORITY_DEFAULTS.maxSessions,
    1,
    AUTHORITY_DEFAULTS.maxSessions,
  );
  const maxReservations = integer(
    environment,
    'MAX_RESERVATIONS',
    AUTHORITY_DEFAULTS.maxReservations,
    1,
    AUTHORITY_DEFAULTS.maxReservations,
  );
  const maxSessionsPerSource = integer(
    environment,
    'MAX_SESSIONS_PER_SOURCE',
    AUTHORITY_DEFAULTS.maxSessionsPerSource,
    1,
    AUTHORITY_DEFAULTS.maxSessions,
  );
  const maxConnections = integer(
    environment,
    'MAX_CONNECTIONS',
    AUTHORITY_DEFAULTS.maxConnections,
    1,
    64,
  );

  if (maxSessions > maxRooms * maxPlayersPerRoom) invalid('MAX_SESSIONS');
  if (maxReservations > maxSessions) invalid('MAX_RESERVATIONS');
  if (maxSessionsPerSource > maxSessions) invalid('MAX_SESSIONS_PER_SOURCE');
  if (maxConnections < maxSessions) invalid('MAX_CONNECTIONS');

  return Object.freeze({
    admissionEnabled: boolean(
      environment,
      'ADMISSION_ENABLED',
      AUTHORITY_DEFAULTS.admissionEnabled,
    ),
    allowedWebOrigins: Object.freeze(allowedWebOrigins),
    buildId,
    connectionAttemptsPerMinute: integer(
      environment,
      'CONNECTION_ATTEMPTS_PER_MINUTE',
      AUTHORITY_DEFAULTS.connectionAttemptsPerMinute,
      1,
      120,
    ),
    drainTimeoutMs: integer(
      environment,
      'DRAIN_TIMEOUT_MS',
      AUTHORITY_DEFAULTS.drainTimeoutMs,
      100,
      10_000,
    ),
    host: '0.0.0.0',
    maxConnections,
    maxInboundMessageBytes: MAX_INBOUND_MESSAGE_BYTES,
    maxPlayersPerRoom,
    maxQuickplayBodyBytes: MAX_QUICKPLAY_BODY_BYTES,
    maxReservations,
    maxRooms,
    maxSessions,
    maxSessionsPerSource,
    port,
    quickplayRequestsPerMinute: integer(
      environment,
      'QUICKPLAY_REQUESTS_PER_MINUTE',
      AUTHORITY_DEFAULTS.quickplayRequestsPerMinute,
      1,
      60,
    ),
    reconnectGraceMs: RECONNECT_GRACE_MS,
    reservationTtlMs: QUICKPLAY_RESERVATION_TTL_MS,
    roomIdleTtlMs: integer(
      environment,
      'ROOM_IDLE_TTL_MS',
      AUTHORITY_DEFAULTS.roomIdleTtlMs,
      1_000,
      300_000,
    ),
    trustedProxyHops: integer(
      environment,
      'TRUSTED_PROXY_HOPS',
      AUTHORITY_DEFAULTS.trustedProxyHops,
      0,
      2,
    ),
  });
}

function required(environment: Environment, key: string): string {
  const value = environment[key];
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    invalid(key);
  }
  return value;
}

function integer(
  environment: Environment,
  key: string,
  fallback: number | undefined,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[key];
  if (raw === undefined) {
    if (fallback === undefined) invalid(key);
    return fallback;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) invalid(key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(key);
  return value;
}

function boolean(environment: Environment, key: string, fallback: boolean): boolean {
  const value = environment[key];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return invalid(key);
}

function origins(value: string): string[] {
  const values = value.split(',').map((entry) => entry.trim());
  if (values.length === 0 || values.some((entry) => entry.length === 0)) {
    invalid('ALLOWED_WEB_ORIGINS');
  }

  const unique = new Set<string>();
  for (const origin of values) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      invalid('ALLOWED_WEB_ORIGINS');
    }
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== '/' ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.origin !== origin ||
      origin === '*'
    ) {
      invalid('ALLOWED_WEB_ORIGINS');
    }
    if (unique.has(origin)) invalid('ALLOWED_WEB_ORIGINS');
    unique.add(origin);
  }
  return [...unique];
}

function invalid(key: string): never {
  throw new AuthorityConfigurationError(key);
}
