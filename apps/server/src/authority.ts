import { createHash, createHmac, randomBytes as cryptoRandomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

import {
  FFA_FIXED_STEP_SECONDS,
  createFfaArenaState,
  joinFfaPlayer,
  leaveFfaPlayer,
  stepFfaArena,
  type FfaArenaState,
  type FfaEvent,
  type FfaInput,
} from '@dropzone-arena/arena-engine';
import {
  CLIENT_EVENTS,
  DrainingSchema,
  HandshakeAuthSchema,
  INPUT_RATE_HZ,
  LeaveRequestSchema,
  MAX_EVENTS_PER_SNAPSHOT,
  PROTOCOL_VERSION,
  PingSchema,
  QuickplayRequestSchema,
  SERVER_EVENTS,
  SIMULATION_RATE_HZ,
  SNAPSHOT_RATE_HZ,
  SequencedInputSchema,
  isEventWithinByteLimit,
  isValidInputSequenceAdvance,
  mapEngineSnapshotToWire,
  type Draining,
  type FullSnapshot,
  type ProtocolErrorCode,
  type QuickplayError,
  type QuickplayErrorCode,
  type QuickplaySuccess,
  type ServerError,
  type Welcome,
} from '@dropzone-arena/arena-protocol';
import { Server as SocketIoServer, type Socket } from 'socket.io';

import type { AuthorityConfig } from './config';

const SCHEDULER_INTERVAL_MS = 1_000 / SIMULATION_RATE_HZ;
const MAX_CATCH_UP_STEPS = 5;
const INPUT_BURST = 45;
const INPUT_DEADMAN_MS = 500;
const OVERLOAD_STRIKES = 3;
const OVERLOAD_RECOVERY_TURNS = SIMULATION_RATE_HZ;
const SOURCE_RECORD_LIMIT = 4_096;
const SOURCE_RECORD_TTL_MS = 5 * 60_000;
const PING_RATE_HZ = 5;
const PING_BURST = 10;

const NEUTRAL_INPUT: FfaInput = Object.freeze({
  aim: Object.freeze({ x: 0, y: -1 }),
  dash: false,
  firing: false,
  move: Object.freeze({ x: 0, y: 0 }),
});

const CALLSIGN_PREFIXES = Object.freeze([
  'Amber',
  'Ash',
  'Copper',
  'Flint',
  'Ivory',
  'Moss',
  'Ochre',
  'Slate',
] as const);
const CALLSIGN_SUFFIXES = Object.freeze([
  'Comet',
  'Falcon',
  'Heron',
  'Kestrel',
  'Lantern',
  'Orbit',
  'Rook',
  'Sparrow',
] as const);

export interface MonotonicClock {
  now(): number;
}

export interface AuthorityScheduler {
  clearInterval(handle: unknown): void;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
  setTimeout(callback: () => void, delayMs: number): unknown;
}

export interface AuthorityRandomSource {
  bytes(size: number): Uint8Array;
}

export type AuthorityLogEvent =
  | 'authority-draining'
  | 'authority-listening'
  | 'authority-stopped'
  | 'request-failed'
  | 'scheduler-unavailable';

export interface AuthorityLogger {
  error(event: AuthorityLogEvent): void;
  info(event: AuthorityLogEvent): void;
}

export interface AuthorityDependencies {
  readonly clock?: MonotonicClock;
  readonly logger?: AuthorityLogger;
  readonly random?: AuthorityRandomSource;
  readonly scheduler?: AuthorityScheduler;
}

export interface AuthorityAddress {
  readonly host: '0.0.0.0';
  readonly origin: string;
  readonly port: number;
}

export interface AuthorityServer {
  readonly httpServer: HttpServer;
  readonly io: SocketIoServer;
  close(): Promise<void>;
  drain(): Promise<void>;
  start(): Promise<AuthorityAddress>;
}

interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

interface SourceRecord {
  connection: TokenBucket;
  lastSeenAt: number;
  quickplay: TokenBucket;
}

interface Reservation {
  callsign: string;
  expiresAt: number;
  playerId: string;
  roomId: string;
  sourceDigest: string;
  tokenDigest: string;
}

interface Session {
  activeSocketId?: string;
  callsign: string;
  connected: boolean;
  generation: number;
  inputBucket: TokenBucket;
  lastAcceptedInputSequence: number;
  lastProcessedInputSequence: number;
  lastRateErrorAt?: number;
  latestInput: FfaInput;
  latestInputAt: number;
  pingBucket: TokenBucket;
  playerId: string;
  reconnectExpiresAt?: number;
  roomId: string;
  sourceDigest: string;
  tokenDigest: string;
}

interface Room {
  createdOrder: number;
  emptySince?: number;
  id: string;
  pendingEvents: FfaEvent[];
  reservationDigests: Set<string>;
  sessionDigests: Set<string>;
  state: FfaArenaState;
}

interface SocketAttachment {
  generation: number;
  tokenDigest: string;
}

type AdmissionResult =
  | { response: QuickplaySuccess; status: 200 }
  | { response: QuickplayError; status: number };

const defaultClock: MonotonicClock = {
  now: () => performance.now(),
};

const defaultScheduler: AuthorityScheduler = {
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
};

const defaultRandom: AuthorityRandomSource = {
  bytes: (size) => cryptoRandomBytes(size),
};

const silentLogger: AuthorityLogger = {
  error: () => undefined,
  info: () => undefined,
};

export function createJsonAuthorityLogger(): AuthorityLogger {
  return {
    error: (event) => console.error(JSON.stringify({ event, level: 'error' })),
    info: (event) => console.info(JSON.stringify({ event, level: 'info' })),
  };
}

export function createAuthorityServer(
  config: AuthorityConfig,
  dependencies: AuthorityDependencies = {},
): AuthorityServer {
  assertFactoryConfig(config);

  const clock = dependencies.clock ?? defaultClock;
  const logger = dependencies.logger ?? silentLogger;
  const random = dependencies.random ?? defaultRandom;
  const scheduler = dependencies.scheduler ?? defaultScheduler;
  const allowedOrigins = new Set(config.allowedWebOrigins);
  const sourceSalt = takeRandomBytes(random, 32);
  const sourceRecords = new Map<string, SourceRecord>();
  const reservations = new Map<string, Reservation>();
  const sessions = new Map<string, Session>();
  const rooms = new Map<string, Room>();
  const socketAttachments = new Map<string, SocketAttachment>();

  let roomSequence = 0;
  let playerSequence = 0;
  let schedulerHandle: unknown;
  let drainNoticeHandle: unknown;
  let drainForceHandle: unknown;
  let started = false;
  let draining = false;
  let schedulerReady = false;
  let schedulerAccumulatorMs = 0;
  let lastSchedulerAt = 0;
  let lastClockValue = -1;
  let overloadStrikeCount = 0;
  let overloadRecoveryTurns = 0;
  let overloaded = false;
  let closePromise: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;
  let stoppedLogged = false;

  const httpServer = createServer(
    { maxHeaderSize: config.maxInboundMessageBytes },
    (request, response) => {
      void handleHttpRequest(request, response).catch(() => {
        logger.error('request-failed');
        if (!response.headersSent) {
          writeQuickplayError(response, 500, 'SERVICE_UNAVAILABLE', true);
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    },
  );
  httpServer.requestTimeout = 5_000;
  httpServer.headersTimeout = 6_000;
  httpServer.keepAliveTimeout = 5_000;

  const io = new SocketIoServer(httpServer, {
    allowEIO3: false,
    allowRequest: (request, callback) => {
      const origin = singleHeader(request.headers.origin);
      if (draining || origin === undefined || !allowedOrigins.has(origin)) {
        callback(null, false);
        return;
      }

      const query =
        request.url === undefined
          ? undefined
          : new URL(request.url, 'http://authority.invalid').searchParams;
      if (query?.has('sid')) {
        callback(null, true);
        return;
      }
      if (io.engine.clientsCount >= config.maxConnections) {
        callback(null, false);
        return;
      }

      const now = readClock();
      if (now === undefined) {
        callback(null, false);
        return;
      }
      const sourceDigest = digestRequestSource(request);
      const accepted = takeSourceToken(
        sourceDigest,
        'connection',
        now,
        config.connectionAttemptsPerMinute / 60_000,
        config.connectionAttemptsPerMinute,
      );
      callback(null, accepted);
    },
    cors: {
      allowedHeaders: ['content-type'],
      credentials: false,
      methods: ['GET', 'POST'],
      origin: (origin, callback) => {
        callback(null, origin !== undefined && allowedOrigins.has(origin));
      },
    },
    httpCompression: false,
    maxHttpBufferSize: config.maxInboundMessageBytes,
    path: '/ws',
    perMessageDeflate: false,
    serveClient: false,
  });

  io.use((socket, next) => {
    const result = attachSocket(socket);
    if ('error' in result) {
      next(connectionError(result.error));
      return;
    }
    socketAttachments.set(socket.id, result.attachment);
    next();
  });

  io.on('connection', (socket) => {
    const session = activeSessionForSocket(socket);
    if (session === undefined) {
      socket.disconnect(true);
      return;
    }
    const room = rooms.get(session.roomId);
    if (room === undefined) {
      emitServerError(socket, 'SESSION_EXPIRED', false);
      socket.disconnect(true);
      return;
    }

    void socket.join(room.id);
    registerSocketHandlers(socket);
    socket.emit(SERVER_EVENTS.WELCOME, createWelcome(session, room));
  });

  async function handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const origin = singleHeader(request.headers.origin);
    if (origin !== undefined && allowedOrigins.has(origin)) {
      applyCors(response, origin);
    }

    if (request.method === 'GET' && request.url === '/api/health') {
      writeHealth(response);
      return;
    }

    if (request.url === '/api/quickplay' && request.method === 'OPTIONS') {
      if (origin === undefined || !allowedOrigins.has(origin)) {
        writeQuickplayError(response, 403, 'ORIGIN_REJECTED', false);
        return;
      }
      response.statusCode = 204;
      response.setHeader('Access-Control-Allow-Headers', 'content-type');
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Cache-Control', 'no-store');
      response.end();
      return;
    }

    if (request.method !== 'POST' || request.url !== '/api/quickplay') {
      writeJson(response, 404, { code: 'NOT_FOUND', status: 'error' });
      return;
    }

    if (origin === undefined || !allowedOrigins.has(origin)) {
      request.resume();
      writeQuickplayError(response, 403, 'ORIGIN_REJECTED', false);
      return;
    }
    if (draining) {
      request.resume();
      writeQuickplayError(
        response,
        503,
        'SERVER_DRAINING',
        true,
        config.drainTimeoutMs,
      );
      return;
    }

    const contentType = singleHeader(request.headers['content-type']);
    const contentEncoding = singleHeader(request.headers['content-encoding']);
    if (
      contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' ||
      (contentEncoding !== undefined && contentEncoding.toLowerCase() !== 'identity')
    ) {
      request.resume();
      writeQuickplayError(response, 415, 'INVALID_REQUEST', false);
      return;
    }

    const body = await readRequestBody(request, config.maxQuickplayBodyBytes);
    if (body.status === 'oversized') {
      writeQuickplayError(response, 413, 'INVALID_REQUEST', false);
      return;
    }
    if (body.status === 'invalid') {
      writeQuickplayError(response, 400, 'INVALID_REQUEST', false);
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(body.value) as unknown;
    } catch {
      writeQuickplayError(response, 400, 'INVALID_REQUEST', false);
      return;
    }
    if (isRecord(value) && Object.hasOwn(value, 'protocolVersion')) {
      if (value.protocolVersion !== PROTOCOL_VERSION) {
        writeQuickplayError(response, 426, 'PROTOCOL_MISMATCH', false);
        return;
      }
    }
    if (
      isRecord(value) &&
      typeof value.buildId === 'string' &&
      value.buildId !== config.buildId
    ) {
      writeQuickplayError(response, 409, 'BUILD_MISMATCH', false);
      return;
    }
    if (!QuickplayRequestSchema.safeParse(value).success) {
      writeQuickplayError(response, 400, 'INVALID_REQUEST', false);
      return;
    }

    const now = readClock();
    if (now === undefined) {
      writeQuickplayError(response, 503, 'SERVICE_UNAVAILABLE', true, 1_000);
      return;
    }
    sweepExpired(now);
    const sourceDigest = digestRequestSource(request);
    if (
      !takeSourceToken(
        sourceDigest,
        'quickplay',
        now,
        config.quickplayRequestsPerMinute / 60_000,
        config.quickplayRequestsPerMinute,
      )
    ) {
      writeQuickplayError(response, 429, 'RATE_LIMITED', true, 5_000);
      return;
    }

    const result = admit(sourceDigest, now);
    writeJson(response, result.status, result.response);
  }

  function writeHealth(response: ServerResponse): void {
    const base = {
      buildId: config.buildId,
      protocolVersion: PROTOCOL_VERSION,
      service: 'dropzone-arena-authority' as const,
    };
    if (draining) {
      writeJson(response, 503, {
        ...base,
        code: 'SERVER_DRAINING',
        status: 'not-ready',
      });
      return;
    }
    if (!started) {
      writeJson(response, 503, { ...base, code: 'STARTING', status: 'not-ready' });
      return;
    }
    if (!schedulerReady || overloaded) {
      writeJson(response, 503, {
        ...base,
        code: 'SCHEDULER_UNAVAILABLE',
        status: 'not-ready',
      });
      return;
    }
    writeJson(response, 200, { ...base, status: 'ready' });
  }

  function admit(sourceDigest: string, now: number): AdmissionResult {
    if (draining)
      return admissionError('SERVER_DRAINING', 503, true, config.drainTimeoutMs);
    if (!started || !schedulerReady || overloaded || !config.admissionEnabled) {
      return admissionError('SERVICE_UNAVAILABLE', 503, true, 1_000);
    }
    if (countSourceSlots(sourceDigest) >= config.maxSessionsPerSource) {
      return admissionError('RATE_LIMITED', 429, true, config.reconnectGraceMs);
    }
    if (
      reservations.size >= config.maxReservations ||
      sessions.size + reservations.size >= config.maxSessions
    ) {
      return admissionError('CAPACITY', 503, true, 1_000);
    }

    try {
      const credential = issueCredential();
      const room = selectAdmissionRoom(now);
      if (room === undefined) return admissionError('CAPACITY', 503, true, 1_000);
      const callsign = generateCallsign(room);
      playerSequence += 1;
      const playerId = `player-${playerSequence.toString(36)}`;
      const reservation: Reservation = {
        callsign,
        expiresAt: now + config.reservationTtlMs,
        playerId,
        roomId: room.id,
        sourceDigest,
        tokenDigest: credential.digest,
      };
      reservations.set(credential.digest, reservation);
      room.reservationDigests.add(credential.digest);
      room.emptySince = undefined;

      return {
        response: {
          arenaId: room.id,
          buildId: config.buildId,
          callsign,
          playerId,
          protocolVersion: PROTOCOL_VERSION,
          reservationExpiresInMs: config.reservationTtlMs,
          status: 'ok',
          token: credential.token,
        },
        status: 200,
      };
    } catch {
      return admissionError('SERVICE_UNAVAILABLE', 503, true, 1_000);
    }
  }

  function selectAdmissionRoom(now: number): Room | undefined {
    let selected: Room | undefined;
    let selectedPopulation = -1;
    for (const room of rooms.values()) {
      const population = room.sessionDigests.size + room.reservationDigests.size;
      if (population >= config.maxPlayersPerRoom) continue;
      if (
        population > selectedPopulation ||
        (population === selectedPopulation &&
          room.createdOrder < (selected?.createdOrder ?? Number.POSITIVE_INFINITY))
      ) {
        selected = room;
        selectedPopulation = population;
      }
    }
    if (selected !== undefined) return selected;
    if (rooms.size >= config.maxRooms) return undefined;

    roomSequence += 1;
    const room: Room = {
      createdOrder: roomSequence,
      emptySince: now,
      id: `arena-${roomSequence.toString(36)}`,
      pendingEvents: [],
      reservationDigests: new Set(),
      sessionDigests: new Set(),
      state: createFfaArenaState(randomUint32()),
    };
    rooms.set(room.id, room);
    return room;
  }

  function generateCallsign(room: Room): string {
    const occupied = new Set<string>();
    for (const digest of room.reservationDigests) {
      const reservation = reservations.get(digest);
      if (reservation !== undefined) occupied.add(reservation.callsign);
    }
    for (const digest of room.sessionDigests) {
      const session = sessions.get(digest);
      if (session !== undefined) occupied.add(session.callsign);
    }

    const candidateCount = CALLSIGN_PREFIXES.length * CALLSIGN_SUFFIXES.length;
    const start = randomUint32() % candidateCount;
    for (let offset = 0; offset < candidateCount; offset += 1) {
      const index = (start + offset) % candidateCount;
      const prefix = CALLSIGN_PREFIXES[Math.floor(index / CALLSIGN_SUFFIXES.length)];
      const suffix = CALLSIGN_SUFFIXES[index % CALLSIGN_SUFFIXES.length];
      const candidate = `${prefix} ${suffix}`;
      if (!occupied.has(candidate)) return candidate;
    }
    throw new Error('Callsign capacity exhausted');
  }

  function issueCredential(): { digest: string; token: string } {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = Buffer.from(takeRandomBytes(random, 32)).toString('base64url');
      const digest = digestToken(token);
      if (!reservations.has(digest) && !sessions.has(digest)) return { digest, token };
    }
    throw new Error('Credential generation failed');
  }

  function attachSocket(
    socket: Socket,
  ): { attachment: SocketAttachment } | { error: ServerError } {
    if (draining)
      return { error: serverError('SERVER_DRAINING', true, config.drainTimeoutMs) };

    const auth = socket.handshake.auth as unknown;
    if (isRecord(auth) && Object.hasOwn(auth, 'protocolVersion')) {
      if (auth.protocolVersion !== PROTOCOL_VERSION) {
        return { error: serverError('PROTOCOL_MISMATCH', false) };
      }
    }
    if (
      isRecord(auth) &&
      typeof auth.buildId === 'string' &&
      auth.buildId !== config.buildId
    ) {
      return { error: serverError('BUILD_MISMATCH', false) };
    }
    const parsed = HandshakeAuthSchema.safeParse(auth);
    if (!parsed.success) return { error: serverError('INVALID_REQUEST', false) };

    const now = readClock();
    if (now === undefined)
      return { error: serverError('SERVICE_UNAVAILABLE', true, 1_000) };
    sweepExpired(now);
    const tokenDigest = digestToken(parsed.data.token);
    let session = sessions.get(tokenDigest);

    if (session === undefined) {
      const reservation = reservations.get(tokenDigest);
      if (reservation === undefined || now >= reservation.expiresAt) {
        if (reservation !== undefined) expireReservation(reservation, now);
        return { error: serverError('SESSION_EXPIRED', false) };
      }
      const room = rooms.get(reservation.roomId);
      if (room === undefined || sessions.size >= config.maxSessions) {
        expireReservation(reservation, now);
        return { error: serverError('SESSION_EXPIRED', false) };
      }

      reservations.delete(tokenDigest);
      room.reservationDigests.delete(tokenDigest);
      const nextState = joinFfaPlayer(
        room.state,
        reservation.playerId,
        reservation.callsign,
      );
      if (!nextState.players.some((player) => player.id === reservation.playerId)) {
        markRoomEmpty(room, now);
        return { error: serverError('CAPACITY', true, 1_000) };
      }
      room.state = nextState;
      appendRoomEvents(room, nextState.events);
      room.sessionDigests.add(tokenDigest);
      room.emptySince = undefined;
      session = {
        callsign: reservation.callsign,
        connected: false,
        generation: 0,
        inputBucket: fullBucket(INPUT_BURST, now),
        lastAcceptedInputSequence: 0,
        lastProcessedInputSequence: 0,
        latestInput: cloneInput(NEUTRAL_INPUT),
        latestInputAt: now,
        pingBucket: fullBucket(PING_BURST, now),
        playerId: reservation.playerId,
        roomId: reservation.roomId,
        sourceDigest: reservation.sourceDigest,
        tokenDigest,
      };
      sessions.set(tokenDigest, session);
    }

    if (session.reconnectExpiresAt !== undefined && now >= session.reconnectExpiresAt) {
      removeSession(session, now, false);
      return { error: serverError('SESSION_EXPIRED', false) };
    }

    const replacedSocketId = session.activeSocketId;
    session.connected = true;
    session.generation += 1;
    session.activeSocketId = socket.id;
    session.reconnectExpiresAt = undefined;
    session.latestInput = neutralInputForSession(session);
    session.latestInputAt = now;
    session.lastAcceptedInputSequence = session.lastProcessedInputSequence;

    if (replacedSocketId !== undefined && replacedSocketId !== socket.id) {
      const replaced = io.sockets.sockets.get(replacedSocketId);
      if (replaced !== undefined) {
        emitServerError(replaced, 'SESSION_REPLACED', false);
        replaced.disconnect(true);
      }
    }

    return {
      attachment: { generation: session.generation, tokenDigest },
    };
  }

  function registerSocketHandlers(socket: Socket): void {
    const knownEvents = new Set<string>(Object.values(CLIENT_EVENTS));
    socket.onAny((eventName: string) => {
      if (knownEvents.has(eventName)) return;
      const session = activeSessionForSocket(socket);
      const now = readClock();
      if (
        session === undefined ||
        now === undefined ||
        !takeBucket(session.inputBucket, now, INPUT_RATE_HZ / 1_000, INPUT_BURST)
      ) {
        return;
      }
      emitServerError(socket, 'INVALID_MESSAGE', false);
    });

    socket.on(CLIENT_EVENTS.INPUT, (payload: unknown) => {
      const session = activeSessionForSocket(socket);
      if (session === undefined) return;
      const now = readClock();
      if (now === undefined) {
        emitServerError(socket, 'SERVICE_UNAVAILABLE', true, 1_000);
        return;
      }
      if (!takeBucket(session.inputBucket, now, INPUT_RATE_HZ / 1_000, INPUT_BURST)) {
        if (
          session.lastRateErrorAt === undefined ||
          now - session.lastRateErrorAt >= 1_000
        ) {
          session.lastRateErrorAt = now;
          emitServerError(socket, 'RATE_LIMITED', true, 1_000);
        }
        return;
      }
      if (
        !isEventWithinByteLimit(
          CLIENT_EVENTS.INPUT,
          payload,
          config.maxInboundMessageBytes,
        )
      ) {
        emitServerError(socket, 'INVALID_MESSAGE', false);
        return;
      }
      if (isRecord(payload) && Object.hasOwn(payload, 'protocolVersion')) {
        if (payload.protocolVersion !== PROTOCOL_VERSION) {
          emitServerError(socket, 'PROTOCOL_MISMATCH', false);
          return;
        }
      }
      const parsed = SequencedInputSchema.safeParse(payload);
      if (!parsed.success) {
        emitServerError(socket, 'INVALID_MESSAGE', false);
        return;
      }
      if (
        !isValidInputSequenceAdvance(
          session.lastAcceptedInputSequence,
          parsed.data.sequence,
        )
      ) {
        emitServerError(socket, 'INVALID_SEQUENCE', false);
        return;
      }

      session.lastAcceptedInputSequence = parsed.data.sequence;
      session.latestInput = {
        aim: { ...parsed.data.aim },
        dash: parsed.data.dash,
        firing: parsed.data.firing,
        move: { ...parsed.data.move },
      };
      session.latestInputAt = now;
    });

    socket.on(
      CLIENT_EVENTS.PING,
      (payload: unknown, acknowledge?: (value: unknown) => void) => {
        const session = activeSessionForSocket(socket);
        if (session === undefined) return;
        const now = readClock();
        if (now === undefined) {
          emitServerError(socket, 'SERVICE_UNAVAILABLE', true, 1_000);
          return;
        }
        if (!takeBucket(session.pingBucket, now, PING_RATE_HZ / 1_000, PING_BURST)) {
          emitServerError(socket, 'RATE_LIMITED', true, 1_000);
          return;
        }
        if (
          !isEventWithinByteLimit(
            CLIENT_EVENTS.PING,
            payload,
            config.maxInboundMessageBytes,
          )
        ) {
          emitServerError(socket, 'INVALID_MESSAGE', false);
          return;
        }
        if (isRecord(payload) && Object.hasOwn(payload, 'protocolVersion')) {
          if (payload.protocolVersion !== PROTOCOL_VERSION) {
            emitServerError(socket, 'PROTOCOL_MISMATCH', false);
            return;
          }
        }
        const parsed = PingSchema.safeParse(payload);
        if (!parsed.success) {
          emitServerError(socket, 'INVALID_MESSAGE', false);
          return;
        }
        const room = rooms.get(session.roomId);
        if (room === undefined) return;
        acknowledge?.({
          protocolVersion: PROTOCOL_VERSION,
          sequence: parsed.data.sequence,
          serverTick: room.state.tick,
        });
      },
    );

    socket.on(
      CLIENT_EVENTS.LEAVE,
      (payload: unknown, acknowledge?: (value: unknown) => void) => {
        const session = activeSessionForSocket(socket);
        if (session === undefined) return;
        const now = readClock();
        if (now === undefined) {
          emitServerError(socket, 'SERVICE_UNAVAILABLE', true, 1_000);
          return;
        }
        if (!takeBucket(session.pingBucket, now, PING_RATE_HZ / 1_000, PING_BURST)) {
          emitServerError(socket, 'RATE_LIMITED', true, 1_000);
          return;
        }
        if (
          !isEventWithinByteLimit(
            CLIENT_EVENTS.LEAVE,
            payload,
            config.maxInboundMessageBytes,
          )
        ) {
          emitServerError(socket, 'INVALID_MESSAGE', false);
          return;
        }
        if (isRecord(payload) && Object.hasOwn(payload, 'protocolVersion')) {
          if (payload.protocolVersion !== PROTOCOL_VERSION) {
            emitServerError(socket, 'PROTOCOL_MISMATCH', false);
            return;
          }
        }
        if (!LeaveRequestSchema.safeParse(payload).success) {
          emitServerError(socket, 'INVALID_MESSAGE', false);
          return;
        }
        removeSession(session, now, false);
        acknowledge?.({ left: true, protocolVersion: PROTOCOL_VERSION });
        socket.disconnect(true);
      },
    );

    socket.on('disconnect', () => {
      const attachment = socketAttachments.get(socket.id);
      socketAttachments.delete(socket.id);
      if (attachment === undefined) return;
      const session = sessions.get(attachment.tokenDigest);
      if (
        session === undefined ||
        session.generation !== attachment.generation ||
        session.activeSocketId !== socket.id
      ) {
        return;
      }
      const now = readClock();
      if (now === undefined) return;
      session.connected = false;
      session.activeSocketId = undefined;
      session.reconnectExpiresAt = now + config.reconnectGraceMs;
      session.latestInput = neutralInputForSession(session);
      session.latestInputAt = now;
      session.lastAcceptedInputSequence = session.lastProcessedInputSequence;
    });
  }

  function activeSessionForSocket(socket: Socket): Session | undefined {
    const attachment = socketAttachments.get(socket.id);
    if (attachment === undefined) return undefined;
    const session = sessions.get(attachment.tokenDigest);
    if (
      session === undefined ||
      session.generation !== attachment.generation ||
      session.activeSocketId !== socket.id ||
      !session.connected
    ) {
      return undefined;
    }
    return session;
  }

  function createWelcome(session: Session, room: Room): Welcome {
    return {
      arenaId: room.id,
      buildId: config.buildId,
      callsign: session.callsign,
      inputRateHz: INPUT_RATE_HZ,
      playerId: session.playerId,
      protocolVersion: PROTOCOL_VERSION,
      reconnectGraceMs: config.reconnectGraceMs,
      simulationRateHz: SIMULATION_RATE_HZ,
      snapshot: createSnapshot(room, []),
      snapshotRateHz: SNAPSHOT_RATE_HZ,
    };
  }

  function runSchedulerTurn(): void {
    if (!started || (draining && closePromise !== undefined)) return;
    const now = readClock();
    if (now === undefined || now < lastSchedulerAt) {
      markSchedulerUnavailable();
      return;
    }

    try {
      sweepExpired(now);
      const elapsed = now - lastSchedulerAt;
      lastSchedulerAt = now;
      schedulerAccumulatorMs += elapsed;
      const availableSteps = Math.floor(
        (schedulerAccumulatorMs + 0.000_001) / SCHEDULER_INTERVAL_MS,
      );
      const steps = Math.min(availableSteps, MAX_CATCH_UP_STEPS);

      if (availableSteps > MAX_CATCH_UP_STEPS) {
        overloadStrikeCount += 1;
        overloadRecoveryTurns = 0;
        if (overloadStrikeCount >= OVERLOAD_STRIKES) overloaded = true;
      } else {
        overloadStrikeCount = Math.max(0, overloadStrikeCount - 1);
        if (overloaded && availableSteps <= 1) {
          overloadRecoveryTurns += 1;
          if (overloadRecoveryTurns >= OVERLOAD_RECOVERY_TURNS) {
            overloaded = false;
            overloadStrikeCount = 0;
            overloadRecoveryTurns = 0;
          }
        } else if (availableSteps > 1) {
          overloadRecoveryTurns = 0;
        }
      }

      for (let step = 0; step < steps; step += 1) stepRooms(now);
      schedulerAccumulatorMs -= steps * SCHEDULER_INTERVAL_MS;
      if (availableSteps > MAX_CATCH_UP_STEPS) {
        schedulerAccumulatorMs %= SCHEDULER_INTERVAL_MS;
      }
    } catch {
      markSchedulerUnavailable();
    }
  }

  function stepRooms(now: number): void {
    for (const room of rooms.values()) {
      if (room.sessionDigests.size === 0) continue;
      const inputs: Record<string, FfaInput> = {};
      for (const digest of room.sessionDigests) {
        const session = sessions.get(digest);
        if (session === undefined) continue;
        const dead =
          !session.connected || now - session.latestInputAt >= INPUT_DEADMAN_MS;
        inputs[session.playerId] = dead
          ? neutralInputForSession(session)
          : cloneInput(session.latestInput);
      }

      const nextState = stepFfaArena(room.state, inputs, FFA_FIXED_STEP_SECONDS);
      room.state = nextState;
      appendRoomEvents(room, nextState.events);
      for (const digest of room.sessionDigests) {
        const session = sessions.get(digest);
        if (session === undefined) continue;
        session.lastProcessedInputSequence = session.lastAcceptedInputSequence;
        if (session.latestInput.dash) {
          session.latestInput = { ...session.latestInput, dash: false };
        }
      }

      if (nextState.tick % (SIMULATION_RATE_HZ / SNAPSHOT_RATE_HZ) === 0) {
        const snapshot = createSnapshot(room, room.pendingEvents);
        room.pendingEvents = [];
        io.to(room.id).volatile.emit(SERVER_EVENTS.SNAPSHOT, snapshot);
      }
    }
  }

  function createSnapshot(room: Room, events: readonly FfaEvent[]): FullSnapshot {
    const sequences: Record<string, number> = {};
    for (const digest of room.sessionDigests) {
      const session = sessions.get(digest);
      if (session !== undefined) {
        sequences[session.playerId] = session.lastProcessedInputSequence;
      }
    }
    return mapEngineSnapshotToWire(
      { ...room.state, events: [...events] },
      {
        arenaId: room.id,
        buildId: config.buildId,
        lastProcessedInputSequenceByPlayer: sequences,
      },
    );
  }

  function appendRoomEvents(room: Room, events: readonly FfaEvent[]): void {
    room.pendingEvents.push(...events);
    if (room.pendingEvents.length > MAX_EVENTS_PER_SNAPSHOT) {
      room.pendingEvents = room.pendingEvents.slice(-MAX_EVENTS_PER_SNAPSHOT);
    }
  }

  function sweepExpired(now: number): void {
    for (const reservation of reservations.values()) {
      if (now >= reservation.expiresAt) expireReservation(reservation, now);
    }
    for (const session of sessions.values()) {
      if (
        !session.connected &&
        session.reconnectExpiresAt !== undefined &&
        now >= session.reconnectExpiresAt
      ) {
        removeSession(session, now, false);
      }
    }
    for (const room of rooms.values()) {
      if (
        room.sessionDigests.size === 0 &&
        room.reservationDigests.size === 0 &&
        room.emptySince !== undefined &&
        now - room.emptySince >= config.roomIdleTtlMs
      ) {
        rooms.delete(room.id);
      }
    }
    for (const [digest, record] of sourceRecords) {
      if (now - record.lastSeenAt >= SOURCE_RECORD_TTL_MS) sourceRecords.delete(digest);
    }
  }

  function expireReservation(reservation: Reservation, now: number): void {
    reservations.delete(reservation.tokenDigest);
    const room = rooms.get(reservation.roomId);
    if (room === undefined) return;
    room.reservationDigests.delete(reservation.tokenDigest);
    markRoomEmpty(room, now);
  }

  function removeSession(session: Session, now: number, disconnect: boolean): void {
    sessions.delete(session.tokenDigest);
    const room = rooms.get(session.roomId);
    if (room !== undefined) {
      room.sessionDigests.delete(session.tokenDigest);
      const nextState = leaveFfaPlayer(room.state, session.playerId);
      room.state = nextState;
      appendRoomEvents(room, nextState.events);
      markRoomEmpty(room, now);
    }
    const socketId = session.activeSocketId;
    session.connected = false;
    session.activeSocketId = undefined;
    session.reconnectExpiresAt = undefined;
    if (disconnect && socketId !== undefined) {
      io.sockets.sockets.get(socketId)?.disconnect(true);
    }
  }

  function markRoomEmpty(room: Room, now: number): void {
    if (room.sessionDigests.size === 0 && room.reservationDigests.size === 0) {
      room.emptySince ??= now;
    }
  }

  function countSourceSlots(sourceDigest: string): number {
    let count = 0;
    for (const reservation of reservations.values()) {
      if (reservation.sourceDigest === sourceDigest) count += 1;
    }
    for (const session of sessions.values()) {
      if (session.sourceDigest === sourceDigest) count += 1;
    }
    return count;
  }

  function digestRequestSource(request: IncomingMessage): string {
    const chain = forwardedAddressChain(request);
    const selectedIndex = Math.max(0, chain.length - config.trustedProxyHops - 1);
    const selected = chain[selectedIndex] ?? 'unavailable';
    return createHmac('sha256', sourceSalt).update(selected).digest('base64url');
  }

  function forwardedAddressChain(request: IncomingMessage): string[] {
    const remote = normalizeAddress(request.socket.remoteAddress) ?? 'unavailable';
    if (config.trustedProxyHops === 0) return [remote];
    if (config.trustedProxyHops === 1) {
      const realAddress = normalizeAddress(singleHeader(request.headers['x-real-ip']));
      if (realAddress !== undefined) return [realAddress, remote];
    }
    const forwarded = singleHeader(request.headers['x-forwarded-for']);
    if (forwarded === undefined) return [remote];
    const addresses = forwarded
      .split(',')
      .map((entry) => normalizeAddress(entry))
      .filter((entry): entry is string => entry !== undefined);
    addresses.push(remote);
    return addresses;
  }

  function takeSourceToken(
    digest: string,
    bucketName: 'connection' | 'quickplay',
    now: number,
    refillPerMs: number,
    capacity: number,
  ): boolean {
    let record = sourceRecords.get(digest);
    if (record === undefined) {
      if (sourceRecords.size >= SOURCE_RECORD_LIMIT) return false;
      record = {
        connection: fullBucket(config.connectionAttemptsPerMinute, now),
        lastSeenAt: now,
        quickplay: fullBucket(config.quickplayRequestsPerMinute, now),
      };
      sourceRecords.set(digest, record);
    }
    record.lastSeenAt = now;
    return takeBucket(record[bucketName], now, refillPerMs, capacity);
  }

  function readClock(): number | undefined {
    const value = clock.now();
    if (!Number.isFinite(value) || value < 0 || value < lastClockValue) {
      markSchedulerUnavailable();
      return undefined;
    }
    lastClockValue = value;
    return value;
  }

  function markSchedulerUnavailable(): void {
    if (schedulerReady) logger.error('scheduler-unavailable');
    schedulerReady = false;
    overloaded = true;
  }

  function randomUint32(): number {
    return Buffer.from(takeRandomBytes(random, 4)).readUInt32BE(0);
  }

  function admissionError(
    code: QuickplayErrorCode,
    status: number,
    retryable: boolean,
    retryAfterMs?: number,
  ): AdmissionResult {
    return {
      response: {
        buildId: config.buildId,
        code,
        protocolVersion: PROTOCOL_VERSION,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        retryable,
        status: 'error',
      },
      status,
    };
  }

  function serverError(
    code: ProtocolErrorCode,
    retryable: boolean,
    retryAfterMs?: number,
  ): ServerError {
    return {
      buildId: config.buildId,
      code,
      protocolVersion: PROTOCOL_VERSION,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      retryable,
    };
  }

  function emitServerError(
    socket: Socket,
    code: ProtocolErrorCode,
    retryable: boolean,
    retryAfterMs?: number,
  ): void {
    socket.emit(SERVER_EVENTS.ERROR, serverError(code, retryable, retryAfterMs));
  }

  function connectionError(payload: ServerError): Error & { data: ServerError } {
    const error = new Error(payload.code) as Error & { data: ServerError };
    error.data = payload;
    return error;
  }

  function writeQuickplayError(
    response: ServerResponse,
    status: number,
    code: QuickplayErrorCode,
    retryable: boolean,
    retryAfterMs?: number,
  ): void {
    const result = admissionError(code, status, retryable, retryAfterMs);
    writeJson(response, result.status, result.response);
  }

  function start(): Promise<AuthorityAddress> {
    if (started) return Promise.reject(new Error('Authority is already started'));
    if (draining) return Promise.reject(new Error('Authority is draining'));
    const now = readClock();
    if (now === undefined)
      return Promise.reject(new Error('Monotonic clock unavailable'));

    try {
      lastSchedulerAt = now;
      schedulerHandle = scheduler.setInterval(runSchedulerTurn, SCHEDULER_INTERVAL_MS);
      schedulerReady = true;
    } catch {
      schedulerReady = false;
      return Promise.reject(new Error('Scheduler unavailable'));
    }

    return new Promise((resolve, reject) => {
      const onError = (): void => {
        httpServer.off('listening', onListening);
        stopScheduler();
        reject(new Error('Authority listen failed'));
      };
      const onListening = (): void => {
        httpServer.off('error', onError);
        const address = httpServer.address();
        if (address === null || typeof address === 'string') {
          stopScheduler();
          reject(new Error('Authority address unavailable'));
          return;
        }
        started = true;
        logger.info('authority-listening');
        resolve({
          host: config.host,
          origin: `http://127.0.0.1:${address.port}`,
          port: address.port,
        });
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(config.port, config.host);
    });
  }

  function drain(): Promise<void> {
    if (closePromise !== undefined) return closePromise;
    draining = true;
    logger.info('authority-draining');
    const payload = DrainingSchema.parse({
      buildId: config.buildId,
      code: 'SERVER_DRAINING',
      protocolVersion: PROTOCOL_VERSION,
      retryAfterMs: config.drainTimeoutMs,
    }) satisfies Draining;
    io.emit(SERVER_EVENTS.DRAINING, payload);

    closePromise = new Promise((resolve) => {
      resolveClose = resolve;
      const noticeMs = Math.min(50, Math.floor(config.drainTimeoutMs / 4));
      drainNoticeHandle = scheduler.setTimeout(beginTransportClose, noticeMs);
      drainForceHandle = scheduler.setTimeout(
        forceTransportClose,
        config.drainTimeoutMs,
      );
    });
    return closePromise;
  }

  function close(): Promise<void> {
    if (closePromise !== undefined) return closePromise;
    draining = true;
    closePromise = new Promise((resolve) => {
      resolveClose = resolve;
      beginTransportClose();
    });
    return closePromise;
  }

  function beginTransportClose(): void {
    stopScheduler();
    if (!started && !httpServer.listening) {
      finishClose();
      return;
    }
    try {
      io.close(finishClose);
    } catch {
      forceTransportClose();
    }
  }

  function forceTransportClose(): void {
    stopScheduler();
    io.disconnectSockets(true);
    try {
      io.engine.close();
    } catch {
      // Engine.IO can already be closed by the graceful path.
    }
    httpServer.closeAllConnections();
    if (httpServer.listening) {
      try {
        httpServer.close();
      } catch {
        // The close callback may have won this race.
      }
    }
    finishClose();
  }

  function finishClose(): void {
    if (resolveClose === undefined) return;
    if (drainNoticeHandle !== undefined) scheduler.clearTimeout(drainNoticeHandle);
    if (drainForceHandle !== undefined) scheduler.clearTimeout(drainForceHandle);
    drainNoticeHandle = undefined;
    drainForceHandle = undefined;
    started = false;
    schedulerReady = false;
    socketAttachments.clear();
    reservations.clear();
    sessions.clear();
    rooms.clear();
    const resolve = resolveClose;
    resolveClose = undefined;
    if (!stoppedLogged) {
      stoppedLogged = true;
      logger.info('authority-stopped');
    }
    resolve();
  }

  function stopScheduler(): void {
    if (schedulerHandle !== undefined) scheduler.clearInterval(schedulerHandle);
    schedulerHandle = undefined;
    schedulerReady = false;
  }

  return { close, drain, httpServer, io, start };
}

function readRequestBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<
  { status: 'invalid' } | { status: 'oversized' } | { status: 'ok'; value: string }
> {
  const contentLength = singleHeader(request.headers['content-length']);
  if (contentLength !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      request.resume();
      return Promise.resolve({ status: 'invalid' });
    }
    if (Number(contentLength) > maximumBytes) {
      request.resume();
      return Promise.resolve({ status: 'oversized' });
    }
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    let settled = false;
    const finish = (
      value:
        | { status: 'invalid' }
        | { status: 'oversized' }
        | { status: 'ok'; value: string },
    ): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      if (oversized) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maximumBytes) {
        oversized = true;
        chunks.length = 0;
        finish({ status: 'oversized' });
        request.off('data', onData);
        request.resume();
        return;
      }
      chunks.push(buffer);
    };
    request.on('data', onData);
    request.on('end', () => {
      if (oversized) finish({ status: 'oversized' });
      else finish({ status: 'ok', value: Buffer.concat(chunks).toString('utf8') });
    });
    request.on('aborted', () => finish({ status: 'invalid' }));
    request.on('error', () => finish({ status: 'invalid' }));
  });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const encoded = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(encoded);
}

function applyCors(response: ServerResponse, origin: string): void {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeAddress(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let candidate = value.trim().toLowerCase();
  if (candidate.startsWith('[') && candidate.endsWith(']')) {
    candidate = candidate.slice(1, -1);
  }
  const zoneIndex = candidate.indexOf('%');
  if (zoneIndex >= 0) candidate = candidate.slice(0, zoneIndex);
  if (candidate.startsWith('::ffff:')) {
    const mapped = candidate.slice('::ffff:'.length);
    if (isIP(mapped) === 4) candidate = mapped;
  }
  const version = isIP(candidate);
  if (version === 4) {
    return candidate
      .split('.')
      .map((part) => Number(part).toString(10))
      .join('.');
  }
  if (version === 6) {
    try {
      return new URL(`http://[${candidate}]`).hostname.slice(1, -1).toLowerCase();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function fullBucket(capacity: number, now: number): TokenBucket {
  return { tokens: capacity, updatedAt: now };
}

function takeBucket(
  bucket: TokenBucket,
  now: number,
  refillPerMs: number,
  capacity: number,
): boolean {
  const elapsed = Math.max(0, now - bucket.updatedAt);
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function takeRandomBytes(random: AuthorityRandomSource, size: number): Uint8Array {
  const value = random.bytes(size);
  if (!(value instanceof Uint8Array) || value.byteLength !== size) {
    throw new TypeError('Random source returned an invalid byte count');
  }
  return Uint8Array.from(value);
}

function cloneInput(input: FfaInput): FfaInput {
  return {
    aim: { ...input.aim },
    dash: input.dash,
    firing: input.firing,
    move: { ...input.move },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertFactoryConfig(config: AuthorityConfig): void {
  if (
    config.host !== '0.0.0.0' ||
    !Number.isSafeInteger(config.port) ||
    config.port < 0 ||
    config.port > 65_535 ||
    config.allowedWebOrigins.length === 0 ||
    config.maxPlayersPerRoom < 1 ||
    config.maxPlayersPerRoom > 8 ||
    config.maxSessions > config.maxRooms * config.maxPlayersPerRoom ||
    config.maxReservations > config.maxSessions
  ) {
    throw new TypeError('Invalid authority configuration');
  }
}

function neutralInputForSession(session: Session): FfaInput {
  return {
    aim: { ...session.latestInput.aim },
    dash: false,
    firing: false,
    move: { x: 0, y: 0 },
  };
}
