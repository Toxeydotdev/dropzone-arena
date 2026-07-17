import { performance } from 'node:perf_hooks';

import { io as createSocketClient } from 'socket.io-client';
import { z } from 'zod';

import { DEPLOYMENT_PROTOCOL_VERSION, parseDeploymentMetadata } from './metadata.mjs';

const REQUEST_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_PLAYERS_PER_ARENA = 8;
const authorityService = 'dropzone-arena-authority';

const IdentitySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const PublicIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const CallsignSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/);
const TokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/);

const SnapshotPlayerSchema = z
  .object({
    callsign: CallsignSchema,
    id: PublicIdSchema,
  })
  .passthrough();

const SnapshotSchema = z.strictObject({
  arenaId: PublicIdSchema,
  buildId: IdentitySchema,
  events: z.array(z.unknown()).max(8),
  players: z.array(SnapshotPlayerSchema).max(MAX_PLAYERS_PER_ARENA),
  projectiles: z.array(z.unknown()).max(96),
  protocolVersion: z.literal(DEPLOYMENT_PROTOCOL_VERSION),
  tick: z.number().int().nonnegative().safe(),
});

const HealthSchema = z.strictObject({
  buildId: IdentitySchema,
  protocolVersion: z.literal(DEPLOYMENT_PROTOCOL_VERSION),
  service: z.literal(authorityService),
  status: z.literal('ready'),
});

const QuickplaySuccessSchema = z.strictObject({
  arenaId: PublicIdSchema,
  buildId: IdentitySchema,
  callsign: CallsignSchema,
  playerId: PublicIdSchema,
  protocolVersion: z.literal(DEPLOYMENT_PROTOCOL_VERSION),
  reservationExpiresInMs: z.literal(10_000),
  status: z.literal('ok'),
  token: TokenSchema,
});

const QuickplayErrorSchema = z.strictObject({
  buildId: IdentitySchema,
  code: z.enum([
    'INVALID_REQUEST',
    'PROTOCOL_MISMATCH',
    'BUILD_MISMATCH',
    'ORIGIN_REJECTED',
    'RATE_LIMITED',
    'CAPACITY',
    'SERVICE_UNAVAILABLE',
    'SERVER_DRAINING',
  ]),
  protocolVersion: z.literal(DEPLOYMENT_PROTOCOL_VERSION),
  retryAfterMs: z.number().int().nonnegative().max(60_000).optional(),
  retryable: z.boolean(),
  status: z.literal('error'),
});

const WelcomeSchema = z.strictObject({
  arenaId: PublicIdSchema,
  buildId: IdentitySchema,
  callsign: CallsignSchema,
  inputRateHz: z.literal(30),
  playerId: PublicIdSchema,
  protocolVersion: z.literal(DEPLOYMENT_PROTOCOL_VERSION),
  reconnectGraceMs: z.literal(10_000),
  simulationRateHz: z.literal(60),
  snapshot: SnapshotSchema,
  snapshotRateHz: z.literal(20),
});

const ServerErrorSchema = z.strictObject({
  buildId: IdentitySchema,
  code: z.enum([
    'INVALID_REQUEST',
    'PROTOCOL_MISMATCH',
    'BUILD_MISMATCH',
    'ORIGIN_REJECTED',
    'RATE_LIMITED',
    'CAPACITY',
    'SERVICE_UNAVAILABLE',
    'SESSION_EXPIRED',
    'SESSION_REPLACED',
    'INVALID_MESSAGE',
    'INVALID_SEQUENCE',
    'SERVER_DRAINING',
  ]),
  protocolVersion: z.literal(DEPLOYMENT_PROTOCOL_VERSION),
  retryAfterMs: z.number().int().nonnegative().max(60_000).optional(),
  retryable: z.boolean(),
});

const LeaveAckSchema = z.strictObject({
  left: z.literal(true),
  protocolVersion: z.literal(DEPLOYMENT_PROTOCOL_VERSION),
});

export class DeploymentCheckError extends Error {
  constructor(stage, reason) {
    super(`${stage}: ${reason}`);
    this.name = 'DeploymentCheckError';
    this.reason = reason;
    this.stage = stage;
  }
}

export class Deadline {
  #expiresAt;

  constructor(durationMs) {
    this.#expiresAt = performance.now() + durationMs;
  }

  timeout(stage, maximumMs = REQUEST_TIMEOUT_MS) {
    const remaining = Math.floor(this.#expiresAt - performance.now());
    if (remaining <= 0) throw new DeploymentCheckError(stage, 'deadline-exceeded');
    return Math.max(1, Math.min(remaining, maximumMs));
  }
}

export async function checkStaticWeb(options, deadline) {
  const html = await requestText(
    `${options.webOrigin}/`,
    {},
    deadline,
    'static-html',
    MAX_HTML_BYTES,
  );
  requireStatus(html.response, 200, 'static-html');
  requireContentType(html.response, 'text/html', 'static-html');
  requireRevalidated(html.response, 'static-html');
  if (
    !/^\s*<!doctype html>/i.test(html.body) ||
    !/<title>Dropzone Arena<\/title>/i.test(html.body) ||
    !/<div id=["']root["']><\/div>/i.test(html.body)
  ) {
    fail('static-html', 'unexpected-document');
  }

  const deployment = await requestJson(
    `${options.webOrigin}/deployment.json`,
    {},
    deadline,
    'web-deployment-metadata',
  );
  requireStatus(deployment.response, 200, 'web-deployment-metadata');
  requireContentType(
    deployment.response,
    'application/json',
    'web-deployment-metadata',
  );
  requireRevalidated(deployment.response, 'web-deployment-metadata');

  return requireMatchingWebReleaseMetadata(deployment.value, options);
}

export function requireMatchingWebReleaseMetadata(value, options) {
  let metadata;
  try {
    metadata = parseDeploymentMetadata(value);
  } catch {
    fail('web-deployment-metadata', 'response-schema-invalid');
  }
  if (
    metadata.service !== 'dropzone-arena-web' ||
    !metadata.release ||
    metadata.buildId !== options.buildId ||
    metadata.sourceRevision !== options.sourceRevision ||
    metadata.configurationId !== options.configurationId ||
    metadata.protocolVersion !== DEPLOYMENT_PROTOCOL_VERSION ||
    !metadata.publicConfiguration.onlineEnabled ||
    metadata.publicConfiguration.authorityOrigin !== options.authorityOrigin
  ) {
    fail('web-deployment-metadata', 'release-identity-mismatch');
  }
  return metadata;
}

export async function checkAuthorityHealth(
  options,
  deadline,
  stage = 'authority-health',
) {
  const result = await requestJson(
    `${options.authorityOrigin}/api/health`,
    {},
    deadline,
    stage,
  );
  requireStatus(result.response, 200, stage);
  requireNoStore(result.response, stage);
  if (result.response.headers.get('access-control-allow-origin') !== null) {
    fail(stage, 'unexpected-cors-header');
  }
  const health = parsePayload(HealthSchema, result.value, stage);
  if (health.buildId !== options.buildId) fail(stage, 'build-identity-mismatch');
  return health;
}

export async function checkExactCors(options, deadline) {
  const preflight = await requestText(
    `${options.authorityOrigin}/api/quickplay`,
    {
      headers: {
        'Access-Control-Request-Headers': 'content-type',
        'Access-Control-Request-Method': 'POST',
        Origin: options.webOrigin,
      },
      method: 'OPTIONS',
    },
    deadline,
    'cors-allowlisted-origin',
  );
  requireStatus(preflight.response, 204, 'cors-allowlisted-origin');
  requireNoStore(preflight.response, 'cors-allowlisted-origin');
  requireExactCorsOrigin(
    preflight.response,
    options.webOrigin,
    'cors-allowlisted-origin',
  );
  requireHeaderTokens(
    preflight.response,
    'access-control-allow-methods',
    ['post', 'options'],
    'cors-allowlisted-origin',
  );
  requireHeaderTokens(
    preflight.response,
    'access-control-allow-headers',
    ['content-type'],
    'cors-allowlisted-origin',
  );
  requireHeaderTokens(
    preflight.response,
    'vary',
    ['origin'],
    'cors-allowlisted-origin',
  );

  const rejected = await requestJson(
    `${options.authorityOrigin}/api/quickplay`,
    quickplayRequest(options, options.unlistedOrigin),
    deadline,
    'cors-unlisted-origin',
  );
  requireStatus(rejected.response, 403, 'cors-unlisted-origin');
  requireNoStore(rejected.response, 'cors-unlisted-origin');
  if (
    rejected.response.headers.get('access-control-allow-origin') !== null ||
    rejected.response.headers.get('access-control-allow-credentials') !== null
  ) {
    fail('cors-unlisted-origin', 'origin-was-reflected');
  }
  const error = parsePayload(
    QuickplayErrorSchema,
    rejected.value,
    'cors-unlisted-origin',
  );
  if (
    error.code !== 'ORIGIN_REJECTED' ||
    error.retryable ||
    error.buildId !== options.buildId
  ) {
    fail('cors-unlisted-origin', 'unexpected-rejection');
  }
}

export async function admitCandidateSession(options, deadline) {
  const result = await requestJson(
    `${options.authorityOrigin}/api/quickplay`,
    quickplayRequest(options, options.webOrigin),
    deadline,
    'quickplay-admission',
  );
  requireNoStore(result.response, 'quickplay-admission');
  requireExactCorsOrigin(result.response, options.webOrigin, 'quickplay-admission');
  if (result.response.status !== 200) {
    const parsedError = QuickplayErrorSchema.safeParse(result.value);
    const reason = parsedError.success
      ? `admission-${parsedError.data.code.toLowerCase().replaceAll('_', '-')}`
      : `unexpected-http-status-${result.response.status}`;
    fail('quickplay-admission', reason);
  }
  const admission = parsePayload(
    QuickplaySuccessSchema,
    result.value,
    'quickplay-admission',
  );
  if (admission.buildId !== options.buildId) {
    fail('quickplay-admission', 'build-identity-mismatch');
  }
  return new CandidateSession(options, admission);
}

export class CandidateSession {
  #admission;
  #left = false;
  #options;
  #socket;
  #welcome;

  constructor(options, admission) {
    this.#admission = admission;
    this.#options = options;
  }

  get arenaId() {
    return this.#welcome?.arenaId ?? this.#admission.arenaId;
  }

  get playerId() {
    return this.#welcome?.playerId ?? this.#admission.playerId;
  }

  async attach(deadline) {
    this.close();
    const socket = createSocketClient(this.#options.authorityOrigin, {
      auth: {
        buildId: this.#options.buildId,
        protocolVersion: DEPLOYMENT_PROTOCOL_VERSION,
        token: this.#admission.token,
      },
      autoConnect: false,
      extraHeaders: { Origin: this.#options.webOrigin },
      forceNew: true,
      path: '/ws',
      reconnection: false,
      timeout: deadline.timeout('realtime-welcome'),
      transports: ['websocket'],
    });
    this.#socket = socket;

    try {
      const welcomePromise = waitForSocketEvent(
        socket,
        'server:welcome',
        WelcomeSchema,
        deadline,
        'realtime-welcome',
      );
      socket.connect();
      const welcome = await welcomePromise;
      if (
        welcome.buildId !== this.#options.buildId ||
        welcome.arenaId !== this.#admission.arenaId ||
        welcome.playerId !== this.#admission.playerId ||
        welcome.callsign !== this.#admission.callsign ||
        welcome.snapshot.buildId !== this.#options.buildId ||
        welcome.snapshot.arenaId !== welcome.arenaId ||
        !welcome.snapshot.players.some(
          (player) =>
            player.id === welcome.playerId && player.callsign === welcome.callsign,
        )
      ) {
        fail('realtime-welcome', 'session-identity-mismatch');
      }
      if (socket.io.engine?.transport.name !== 'websocket') {
        fail('realtime-welcome', 'websocket-transport-required');
      }
      this.#welcome = welcome;
      return welcome;
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  async waitForIncreasingSnapshots(count, deadline) {
    const socket = this.#socket;
    const welcome = this.#welcome;
    if (socket === undefined || welcome === undefined || !socket.connected) {
      fail('authoritative-snapshots', 'session-not-connected');
    }
    const advanceTick = createIncreasingTickValidator(welcome.snapshot.tick);
    return new Promise((resolve, reject) => {
      const snapshots = [];
      const timeout = setTimeout(
        () => settleFailure('event-timeout'),
        deadline.timeout('authoritative-snapshots'),
      );
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('server:snapshot', onSnapshot);
        socket.off('server:error', onServerError);
        socket.off('disconnect', onDisconnect);
      };
      const settleFailure = (reason) => {
        cleanup();
        reject(new DeploymentCheckError('authoritative-snapshots', reason));
      };
      const onSnapshot = (value) => {
        let snapshot;
        try {
          snapshot = parsePayload(SnapshotSchema, value, 'authoritative-snapshots');
          advanceTick(snapshot.tick);
          if (
            snapshot.buildId !== this.#options.buildId ||
            snapshot.arenaId !== welcome.arenaId
          ) {
            fail('authoritative-snapshots', 'snapshot-identity-mismatch');
          }
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        snapshots.push(snapshot);
        if (snapshots.length < count) return;
        cleanup();
        resolve(snapshots);
      };
      const onServerError = (value) => {
        const parsed = ServerErrorSchema.safeParse(value);
        settleFailure(
          parsed.success
            ? `server-${parsed.data.code.toLowerCase().replaceAll('_', '-')}`
            : 'server-error-invalid',
        );
      };
      const onDisconnect = () => settleFailure('transport-disconnected');

      socket.on('server:snapshot', onSnapshot);
      socket.on('server:error', onServerError);
      socket.on('disconnect', onDisconnect);
    });
  }

  async leave(deadline) {
    if (this.#left) return;
    const socket = this.#socket;
    if (socket === undefined || !socket.connected) {
      fail('clean-leave', 'session-not-connected');
    }

    const acknowledgement = await new Promise((resolve, reject) => {
      socket
        .timeout(deadline.timeout('clean-leave'))
        .emit(
          'client:leave',
          { protocolVersion: DEPLOYMENT_PROTOCOL_VERSION },
          (error, value) => {
            if (error !== null) {
              reject(
                new DeploymentCheckError('clean-leave', 'acknowledgement-timeout'),
              );
              return;
            }
            resolve(value);
          },
        );
    });
    parsePayload(LeaveAckSchema, acknowledgement, 'clean-leave');
    this.#left = true;
    socket.close();
  }

  async cleanup(deadline) {
    try {
      if (this.#left) return;
      if (this.#socket === undefined || !this.#socket.connected) {
        await this.attach(deadline);
      }
      await this.leave(deadline);
    } finally {
      this.close();
    }
  }

  close() {
    this.#socket?.close();
    this.#socket = undefined;
  }
}

export function createIncreasingTickValidator(initialTick) {
  if (!Number.isSafeInteger(initialTick) || initialTick < 0) {
    fail('authoritative-snapshots', 'initial-tick-invalid');
  }
  let previousTick = initialTick;
  return (tick) => {
    if (!Number.isSafeInteger(tick) || tick <= previousTick) {
      fail('authoritative-snapshots', 'ticks-not-strictly-increasing');
    }
    previousTick = tick;
    return tick;
  };
}

export async function cleanupSessions(sessions, timeoutMs = CLEANUP_TIMEOUT_MS) {
  const deadline = new Deadline(timeoutMs);
  const outcomes = await Promise.allSettled(
    sessions.map((session) => session.cleanup(deadline)),
  );
  for (const session of sessions) session.close?.();
  return outcomes.filter((outcome) => outcome.status === 'rejected').length;
}

export function publicFailure(error) {
  if (error instanceof DeploymentCheckError) {
    return { reason: error.reason, stage: error.stage };
  }
  return { reason: 'unexpected-error', stage: 'deployment-check' };
}

function quickplayRequest(options, origin) {
  return {
    body: JSON.stringify({
      buildId: options.buildId,
      protocolVersion: DEPLOYMENT_PROTOCOL_VERSION,
    }),
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
    },
    method: 'POST',
  };
}

async function waitForSocketEvent(socket, eventName, schema, deadline, stage) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => settleFailure('event-timeout'),
      deadline.timeout(stage),
    );
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off(eventName, onValue);
      socket.off('connect_error', onConnectError);
      socket.off('server:error', onServerError);
      socket.off('disconnect', onDisconnect);
    };
    const settleFailure = (reason) => {
      cleanup();
      reject(new DeploymentCheckError(stage, reason));
    };
    const onValue = (value) => {
      try {
        const parsed = parsePayload(schema, value, stage);
        cleanup();
        resolve(parsed);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onConnectError = () => settleFailure('connection-rejected');
    const onServerError = (value) => {
      const parsed = ServerErrorSchema.safeParse(value);
      settleFailure(
        parsed.success
          ? `server-${parsed.data.code.toLowerCase().replaceAll('_', '-')}`
          : 'server-error-invalid',
      );
    };
    const onDisconnect = () => settleFailure('transport-disconnected');

    socket.once(eventName, onValue);
    socket.once('connect_error', onConnectError);
    socket.on('server:error', onServerError);
    socket.once('disconnect', onDisconnect);
  });
}

async function requestJson(url, init, deadline, stage) {
  const result = await requestText(url, init, deadline, stage);
  let value;
  try {
    value = JSON.parse(result.body);
  } catch {
    fail(stage, 'response-json-invalid');
  }
  return { response: result.response, value };
}

async function requestText(
  url,
  init,
  deadline,
  stage,
  maximumBytes = MAX_RESPONSE_BYTES,
) {
  let response;
  let body;
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'follow',
      signal: AbortSignal.timeout(deadline.timeout(stage)),
    });
    const contentLength = response.headers.get('content-length');
    if (
      contentLength !== null &&
      (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > maximumBytes)
    ) {
      fail(stage, 'response-too-large');
    }
    body = await response.text();
  } catch (error) {
    if (error instanceof DeploymentCheckError) throw error;
    fail(stage, 'request-failed');
  }
  if (Buffer.byteLength(body, 'utf8') > maximumBytes) {
    fail(stage, 'response-too-large');
  }
  return { body, response };
}

function parsePayload(schema, value, stage) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(stage, 'response-schema-invalid');
  return parsed.data;
}

function requireStatus(response, status, stage) {
  if (response.status !== status) {
    fail(stage, `unexpected-http-status-${response.status}`);
  }
}

function requireContentType(response, expected, stage) {
  const contentType = response.headers.get('content-type')?.toLowerCase();
  if (contentType === undefined || !contentType.startsWith(expected)) {
    fail(stage, 'content-type-invalid');
  }
}

function requireNoStore(response, stage) {
  const directives = headerTokens(response.headers.get('cache-control'));
  if (!directives.includes('no-store')) fail(stage, 'no-store-required');
}

function requireRevalidated(response, stage) {
  const cacheControl = response.headers.get('cache-control')?.toLowerCase() ?? '';
  if (
    !cacheControl.includes('no-store') &&
    !cacheControl.includes('no-cache') &&
    !cacheControl.includes('must-revalidate') &&
    !/(?:^|,)\s*max-age=0(?:\s*,|$)/.test(cacheControl)
  ) {
    fail(stage, 'revalidation-required');
  }
}

function requireExactCorsOrigin(response, origin, stage) {
  if (
    response.headers.get('access-control-allow-origin') !== origin ||
    response.headers.get('access-control-allow-credentials') !== null
  ) {
    fail(stage, 'exact-cors-origin-required');
  }
}

function requireHeaderTokens(response, header, expected, stage) {
  const actual = headerTokens(response.headers.get(header)).toSorted();
  if (actual.length !== expected.length) fail(stage, `${header}-invalid`);
  const sortedExpected = expected.toSorted();
  if (actual.some((value, index) => value !== sortedExpected[index])) {
    fail(stage, `${header}-invalid`);
  }
}

function headerTokens(value) {
  if (value === null) return [];
  return value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function fail(stage, reason) {
  throw new DeploymentCheckError(stage, reason);
}
