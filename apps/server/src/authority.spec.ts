import { afterEach, describe, expect, it } from 'vitest';

import {
  CLIENT_EVENTS,
  PROTOCOL_VERSION,
  SERVER_EVENTS,
  type FullSnapshot,
  type QuickplayResponse,
  type ServerError,
  type Welcome,
} from '@dropzone-arena/arena-protocol';
import {
  io as createSocketClient,
  type Socket as ClientSocket,
} from 'socket.io-client';

import {
  createAuthorityServer,
  type AuthorityLogEvent,
  type AuthorityLogger,
  type AuthorityRandomSource,
  type AuthorityScheduler,
  type AuthorityServer,
  type MonotonicClock,
} from './authority';
import { loadAuthorityConfig, type AuthorityConfig } from './config';

const WEB_ORIGIN = 'https://play.example.test';
const OTHER_ORIGIN = 'https://other.example.test';
const BUILD_ID = 'build-test-0123456789';
const STEP_MS = 1_000 / 60;

class ManualClock implements MonotonicClock {
  private value = 0;

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }

  now(): number {
    return this.value;
  }
}

class ManualScheduler implements AuthorityScheduler {
  private nextHandle = 1;
  private readonly intervals = new Map<number, () => void>();
  private readonly timeouts = new Map<
    number,
    { callback: () => void; dueAt: number }
  >();

  constructor(private readonly clock: ManualClock) {}

  clearInterval(handle: unknown): void {
    if (typeof handle === 'number') this.intervals.delete(handle);
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timeouts.delete(handle);
  }

  runIntervals(): void {
    for (const callback of this.intervals.values()) callback();
  }

  runTimeouts(): void {
    let ran: boolean;
    do {
      ran = false;
      for (const [handle, timeout] of this.timeouts) {
        if (timeout.dueAt > this.clock.now()) continue;
        this.timeouts.delete(handle);
        timeout.callback();
        ran = true;
      }
    } while (ran);
  }

  setInterval(callback: () => void): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.intervals.set(handle, callback);
    return handle;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timeouts.set(handle, {
      callback,
      dueAt: this.clock.now() + delayMs,
    });
    return handle;
  }
}

class DeterministicRandom implements AuthorityRandomSource {
  private call = 1;

  bytes(size: number): Uint8Array {
    const value = Uint8Array.from(
      { length: size },
      (_, index) => (this.call * 31 + index * 17) & 0xff,
    );
    this.call += 1;
    return value;
  }
}

interface Harness {
  authority: AuthorityServer;
  clock: ManualClock;
  logs: Array<{ event: AuthorityLogEvent; level: 'error' | 'info' }>;
  origin: string;
  scheduler: ManualScheduler;
}

const authorities = new Set<AuthorityServer>();
const clients = new Set<ClientSocket>();

afterEach(async () => {
  for (const client of clients) client.close();
  clients.clear();
  await Promise.all([...authorities].map((authority) => authority.close()));
  authorities.clear();
});

describe('HTTP authority boundary', () => {
  it('serves non-sensitive no-store health and exact-origin CORS', async () => {
    const harness = await startHarness();
    const health = await fetch(`${harness.origin}/api/health`);

    expect(health.status).toBe(200);
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(health.headers.get('access-control-allow-origin')).toBeNull();
    expect(await health.json()).toEqual({
      buildId: BUILD_ID,
      protocolVersion: PROTOCOL_VERSION,
      service: 'dropzone-arena-authority',
      status: 'ready',
    });

    const preflight = await fetch(`${harness.origin}/api/quickplay`, {
      headers: { Origin: WEB_ORIGIN },
      method: 'OPTIONS',
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();

    const rejected = await quickplay(harness, undefined, OTHER_ORIGIN);
    expect(rejected.response.status).toBe(403);
    expect(rejected.response.headers.get('access-control-allow-origin')).toBeNull();
    expect(rejected.body).toMatchObject({ code: 'ORIGIN_REJECTED', status: 'error' });

    const missingOrigin = await fetch(`${harness.origin}/api/quickplay`, {
      body: JSON.stringify(validQuickplayRequest()),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(missingOrigin.status).toBe(403);
  });

  it('enforces the 1 KiB body ceiling and protocol/build/request schemas', async () => {
    const harness = await startHarness();
    const oversized = await quickplay(harness, {
      ...validQuickplayRequest(),
      padding: 'x'.repeat(1_024),
    });
    expect(oversized.response.status).toBe(413);
    expect(oversized.body).toMatchObject({ code: 'INVALID_REQUEST' });

    const protocolMismatch = await quickplay(harness, {
      buildId: BUILD_ID,
      protocolVersion: 2,
    });
    expect(protocolMismatch.response.status).toBe(426);
    expect(protocolMismatch.body).toMatchObject({ code: 'PROTOCOL_MISMATCH' });

    const buildMismatch = await quickplay(harness, {
      buildId: 'other-build',
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(buildMismatch.response.status).toBe(409);
    expect(buildMismatch.body).toMatchObject({ code: 'BUILD_MISMATCH' });

    const customName = await quickplay(harness, {
      ...validQuickplayRequest(),
      callsign: 'Player supplied',
    });
    expect(customName.response.status).toBe(400);
    expect(customName.body).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('packs the most populated room first and enforces room/process capacity', async () => {
    const harness = await startHarness({
      maxConnections: 4,
      maxPlayersPerRoom: 2,
      maxReservations: 4,
      maxRooms: 2,
      maxSessions: 4,
      maxSessionsPerSource: 1,
      trustedProxyHops: 1,
    });

    const admissions = [];
    for (let index = 1; index <= 4; index += 1) {
      admissions.push(
        await quickplay(harness, undefined, WEB_ORIGIN, {
          'X-Real-IP': `198.51.100.${index}`,
        }),
      );
    }
    const successes = admissions.map(({ body }) => successfulAdmission(body));

    expect(successes[0]?.arenaId).toBe(successes[1]?.arenaId);
    expect(successes[2]?.arenaId).toBe(successes[3]?.arenaId);
    expect(successes[0]?.arenaId).not.toBe(successes[2]?.arenaId);
    expect(new Set(successes.map(({ token }) => token)).size).toBe(4);
    expect(successes.every(({ token }) => token.length === 43)).toBe(true);
    expect(successes[0]?.callsign).not.toBe(successes[1]?.callsign);
    expect(successes[2]?.callsign).not.toBe(successes[3]?.callsign);

    const full = await quickplay(harness, undefined, WEB_ORIGIN, {
      'X-Real-IP': '198.51.100.10',
    });
    expect(full.response.status).toBe(503);
    expect(full.body).toMatchObject({ code: 'CAPACITY', retryable: true });
  });

  it('bounds quickplay by a per-process-salted source digest', async () => {
    const harness = await startHarness({ quickplayRequestsPerMinute: 1 });
    const first = await quickplay(harness);
    const token = successfulAdmission(first.body).token;
    const second = await quickplay(harness);

    expect(second.response.status).toBe(429);
    expect(second.body).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(JSON.stringify(harness.logs)).not.toContain(token);
    expect(JSON.stringify(harness.logs)).not.toContain('127.0.0.1');
  });

  it('ignores client address headers until a proxy boundary is trusted', async () => {
    const harness = await startHarness({
      maxConnections: 2,
      maxPlayersPerRoom: 2,
      maxReservations: 2,
      maxRooms: 1,
      maxSessions: 2,
      maxSessionsPerSource: 1,
      trustedProxyHops: 0,
    });

    const first = await quickplay(harness, undefined, WEB_ORIGIN, {
      'X-Real-IP': '198.51.100.1',
    });
    expect(first.response.status).toBe(200);

    const second = await quickplay(harness, undefined, WEB_ORIGIN, {
      'X-Real-IP': '198.51.100.2',
    });
    expect(second.response.status).toBe(429);
    expect(second.body).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
  });

  it('rejects realtime transport from a non-exact origin before redemption', async () => {
    const harness = await startHarness();
    const admission = successfulAdmission((await quickplay(harness)).body);
    const client = socketClient(harness, admission.token, {}, OTHER_ORIGIN);
    const error = await onceEvent<Error>(client, 'connect_error');

    expect(client.connected).toBe(false);
    expect(error).toBeInstanceOf(Error);
  });

  it('returns stable socket incompatibility errors without redeeming the reservation', async () => {
    const harness = await startHarness();
    const admission = successfulAdmission((await quickplay(harness)).body);
    const incompatible = socketClient(harness, admission.token, {
      protocolVersion: 2,
    });
    const protocolError = await onceEvent<SocketConnectionError>(
      incompatible,
      'connect_error',
    );
    expect(protocolError.data).toMatchObject({
      code: 'PROTOCOL_MISMATCH',
      retryable: false,
    });

    const wrongBuild = socketClient(harness, admission.token, {
      buildId: 'other-build',
    });
    const buildError = await onceEvent<SocketConnectionError>(
      wrongBuild,
      'connect_error',
    );
    expect(buildError.data).toMatchObject({ code: 'BUILD_MISMATCH', retryable: false });

    const connected = await connect(harness, admission.token);
    expect(connected.welcome.playerId).toBe(admission.playerId);
  });
});

describe('authoritative room flow', () => {
  it('joins two clients, emits one 20 Hz room state, accumulates combat events, and acks ping', async () => {
    const harness = await startHarness();
    const firstAdmission = successfulAdmission((await quickplay(harness)).body);
    const secondAdmission = successfulAdmission((await quickplay(harness)).body);
    const first = await connect(harness, firstAdmission.token);
    const second = await connect(harness, secondAdmission.token);

    expect(first.welcome.arenaId).toBe(second.welcome.arenaId);
    expect(second.welcome.snapshot.players).toHaveLength(2);
    const attacker = second.welcome.snapshot.players.find(
      ({ id }) => id === first.welcome.playerId,
    );
    const target = second.welcome.snapshot.players.find(
      ({ id }) => id === second.welcome.playerId,
    );
    expect(attacker).toBeDefined();
    expect(target).toBeDefined();
    if (attacker === undefined || target === undefined) return;

    const direction = normalizedDirection(
      target.position.x - attacker.position.x,
      target.position.y - attacker.position.y,
    );
    first.client.emit(CLIENT_EVENTS.INPUT, {
      aim: direction,
      dash: false,
      firing: true,
      move: { x: 0, y: 0 },
      protocolVersion: PROTOCOL_VERSION,
      sequence: 1,
    });
    await ping(first.client, 1);

    const firstSnapshotPromise = onceEvent<FullSnapshot>(
      first.client,
      SERVER_EVENTS.SNAPSHOT,
    );
    const secondSnapshotPromise = onceEvent<FullSnapshot>(
      second.client,
      SERVER_EVENTS.SNAPSHOT,
    );
    advanceTicks(harness, 3);
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      firstSnapshotPromise,
      secondSnapshotPromise,
    ]);

    expect(firstSnapshot).toEqual(secondSnapshot);
    expect(firstSnapshot.tick).toBe(3);
    expect(firstSnapshot.players).toHaveLength(2);
    expect(
      firstSnapshot.players.find(({ id }) => id === first.welcome.playerId)
        ?.lastProcessedInputSequence,
    ).toBe(1);
    expect(firstSnapshot.events).toContainEqual(
      expect.objectContaining({ ownerId: first.welcome.playerId, type: 'shot' }),
    );

    const nextSnapshotPromise = onceEvent<FullSnapshot>(
      first.client,
      SERVER_EVENTS.SNAPSHOT,
    );
    advanceTicks(harness, 3);
    expect((await nextSnapshotPromise).tick).toBe(6);

    const pong = await ping(first.client, 7);
    expect(pong).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      sequence: 7,
      serverTick: 6,
    });
  });

  it('rejects malformed and impossible input, enforces 30/s burst 45, and closes oversized transport', async () => {
    const harness = await startHarness();
    const admission = successfulAdmission((await quickplay(harness)).body);
    const { client, welcome } = await connect(harness, admission.token);
    const errors: ServerError[] = [];
    client.on(SERVER_EVENTS.ERROR, (error: ServerError) => errors.push(error));

    client.emit(CLIENT_EVENTS.INPUT, {
      ...neutralInput(1),
      outcome: { health: 100 },
    });
    client.emit(CLIENT_EVENTS.INPUT, neutralInput(46));
    for (let sequence = 1; sequence <= 43; sequence += 1) {
      client.emit(CLIENT_EVENTS.INPUT, neutralInput(sequence));
    }
    const rateError = waitFor(
      client,
      SERVER_EVENTS.ERROR,
      (error: ServerError) => error.code === 'RATE_LIMITED',
    );
    client.emit(CLIENT_EVENTS.INPUT, neutralInput(44));
    await rateError;

    expect(errors.some(({ code }) => code === 'INVALID_MESSAGE')).toBe(true);
    expect(errors.some(({ code }) => code === 'INVALID_SEQUENCE')).toBe(true);
    const snapshotPromise = onceEvent<FullSnapshot>(client, SERVER_EVENTS.SNAPSHOT);
    advanceTicks(harness, 3);
    const snapshot = await snapshotPromise;
    expect(
      snapshot.players.find(({ id }) => id === welcome.playerId)
        ?.lastProcessedInputSequence,
    ).toBe(43);

    harness.clock.advance(1_000);
    harness.scheduler.runIntervals();
    const duplicateError = waitFor(
      client,
      SERVER_EVENTS.ERROR,
      (error: ServerError) => error.code === 'INVALID_SEQUENCE',
    );
    client.emit(CLIENT_EVENTS.INPUT, neutralInput(43));
    await duplicateError;

    const disconnected = onceEvent<string>(client, 'disconnect');
    client.emit(CLIENT_EVENTS.INPUT, {
      ...neutralInput(44),
      padding: 'x'.repeat(9 * 1_024),
    });
    await disconnected;
    expect(client.connected).toBe(false);
  });

  it('neutralizes held input after 500 ms, caps catch-up at five, and gates overload admission', async () => {
    const harness = await startHarness();
    const admission = successfulAdmission((await quickplay(harness)).body);
    const { client, welcome } = await connect(harness, admission.token);

    client.emit(CLIENT_EVENTS.INPUT, {
      aim: { x: 1, y: 0 },
      dash: false,
      firing: false,
      move: { x: 1, y: 0 },
      protocolVersion: PROTOCOL_VERSION,
      sequence: 1,
    });
    await ping(client, 1);
    const moving = await advanceWithSnapshots(harness, client, 30);
    const movingPlayer = moving.players.find(({ id }) => id === welcome.playerId);
    expect(movingPlayer?.velocity.x).toBeGreaterThan(0);

    const stopped = await advanceWithSnapshots(harness, client, 30);
    const stoppedPlayer = stopped.players.find(({ id }) => id === welcome.playerId);
    expect(Math.abs(stoppedPlayer?.velocity.x ?? 1)).toBeLessThan(
      Math.abs(movingPlayer?.velocity.x ?? 0),
    );

    const beforeCatchUp = await ping(client, 1);
    harness.clock.advance(1_000);
    harness.scheduler.runIntervals();
    const afterCatchUp = await ping(client, 2);
    expect(afterCatchUp.serverTick - beforeCatchUp.serverTick).toBe(5);

    for (let strike = 0; strike < 2; strike += 1) {
      harness.clock.advance(1_000);
      harness.scheduler.runIntervals();
    }
    const health = await fetch(`${harness.origin}/api/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ code: 'SCHEDULER_UNAVAILABLE' });
    const gated = await quickplay(harness);
    expect(gated.response.status).toBe(503);
    expect(gated.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('atomically replaces generations, resumes current state in grace, and expires without input buffering', async () => {
    const harness = await startHarness();
    const admission = successfulAdmission((await quickplay(harness)).body);
    const first = await connect(harness, admission.token);
    const replacedError = waitFor(
      first.client,
      SERVER_EVENTS.ERROR,
      (error: ServerError) => error.code === 'SESSION_REPLACED',
    );
    const firstDisconnected = onceEvent<string>(first.client, 'disconnect');
    const replacement = await connect(harness, admission.token);

    expect((await replacedError).code).toBe('SESSION_REPLACED');
    await firstDisconnected;
    expect(replacement.welcome.playerId).toBe(first.welcome.playerId);
    expect(replacement.welcome.callsign).toBe(first.welcome.callsign);

    replacement.client.emit(CLIENT_EVENTS.INPUT, {
      aim: { x: 1, y: 0 },
      dash: false,
      firing: false,
      move: { x: 1, y: 0 },
      protocolVersion: PROTOCOL_VERSION,
      sequence: 1,
    });
    await ping(replacement.client, 1);

    const replacementId = replacement.client.id;
    if (replacementId === undefined) throw new Error('Expected replacement socket id');
    const replacementDisconnected = onceEvent<string>(replacement.client, 'disconnect');
    harness.authority.io.sockets.sockets.get(replacementId)?.disconnect(true);
    await replacementDisconnected;

    advanceTicks(harness, 60);
    const resumed = await connect(harness, admission.token);
    expect(resumed.welcome.playerId).toBe(first.welcome.playerId);
    expect(resumed.welcome.callsign).toBe(first.welcome.callsign);
    expect(resumed.welcome.snapshot.tick).toBeGreaterThan(
      replacement.welcome.snapshot.tick,
    );
    const resumedPlayer = resumed.welcome.snapshot.players.find(
      ({ id }) => id === first.welcome.playerId,
    );
    const replacementPlayer = replacement.welcome.snapshot.players.find(
      ({ id }) => id === first.welcome.playerId,
    );
    expect(resumedPlayer?.statistics).toEqual({ deaths: 0, kills: 0 });
    expect(resumedPlayer?.lastProcessedInputSequence).toBe(0);
    expect(resumedPlayer?.position).toEqual(replacementPlayer?.position);
    expect(resumedPlayer?.spawnProtectionTicks).toBe(0);

    const resumedId = resumed.client.id;
    if (resumedId === undefined) throw new Error('Expected resumed socket id');
    const resumedDisconnected = onceEvent<string>(resumed.client, 'disconnect');
    harness.authority.io.sockets.sockets.get(resumedId)?.disconnect(true);
    await resumedDisconnected;
    harness.clock.advance(10_001);
    harness.scheduler.runIntervals();

    const expiredClient = socketClient(harness, admission.token);
    const expired = await onceEvent<SocketConnectionError>(
      expiredClient,
      'connect_error',
    );
    expect(expired.data).toMatchObject({ code: 'SESSION_EXPIRED', retryable: false });
  });

  it('expires unredeemed reservations in ten seconds and idle rooms on their bound', async () => {
    const harness = await startHarness();
    const first = successfulAdmission((await quickplay(harness)).body);

    harness.clock.advance(10_001);
    harness.scheduler.runIntervals();
    const expiredClient = socketClient(harness, first.token);
    const expired = await onceEvent<SocketConnectionError>(
      expiredClient,
      'connect_error',
    );
    expect(expired.data).toMatchObject({ code: 'SESSION_EXPIRED' });

    harness.clock.advance(30_001);
    harness.scheduler.runIntervals();
    const next = successfulAdmission((await quickplay(harness)).body);
    expect(next.arenaId).not.toBe(first.arenaId);
  });

  it('releases explicit leave immediately and invalidates reconnect eligibility', async () => {
    const harness = await startHarness({
      maxPlayersPerRoom: 1,
      maxReservations: 4,
      maxSessions: 4,
    });
    const admission = successfulAdmission((await quickplay(harness)).body);
    const { client } = await connect(harness, admission.token);
    const acknowledgment = await leave(client);

    expect(acknowledgment).toEqual({ left: true, protocolVersion: PROTOCOL_VERSION });
    const expiredClient = socketClient(harness, admission.token);
    const expired = await onceEvent<SocketConnectionError>(
      expiredClient,
      'connect_error',
    );
    expect(expired.data).toMatchObject({ code: 'SESSION_EXPIRED' });

    const replacement = await quickplay(harness);
    expect(replacement.response.status).toBe(200);
  });
});

describe('bounded drain', () => {
  it('fails readiness/admission, reliably notifies clients, and closes within the configured bound', async () => {
    const harness = await startHarness({ drainTimeoutMs: 200 });
    const admission = successfulAdmission((await quickplay(harness)).body);
    const { client } = await connect(harness, admission.token);
    const drainingEvent = onceEvent<Record<string, unknown>>(
      client,
      SERVER_EVENTS.DRAINING,
    );
    const disconnected = onceEvent<string>(client, 'disconnect');
    const drainPromise = harness.authority.drain();
    const notice = await drainingEvent;

    expect(notice).toEqual({
      buildId: BUILD_ID,
      code: 'SERVER_DRAINING',
      protocolVersion: PROTOCOL_VERSION,
      retryAfterMs: 200,
    });
    expect(notice).not.toHaveProperty('migration');

    const health = await fetch(`${harness.origin}/api/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ code: 'SERVER_DRAINING' });
    const admissionDuringDrain = await quickplay(harness);
    expect(admissionDuringDrain.response.status).toBe(503);
    expect(admissionDuringDrain.body).toMatchObject({ code: 'SERVER_DRAINING' });

    harness.clock.advance(50);
    harness.scheduler.runTimeouts();
    await drainPromise;
    await disconnected;
    expect(harness.authority.httpServer.listening).toBe(false);
  });
});

async function startHarness(
  overrides: Partial<AuthorityConfig> = {},
): Promise<Harness> {
  const clock = new ManualClock();
  const scheduler = new ManualScheduler(clock);
  const logs: Harness['logs'] = [];
  const logger: AuthorityLogger = {
    error: (event) => logs.push({ event, level: 'error' }),
    info: (event) => logs.push({ event, level: 'info' }),
  };
  const base = loadAuthorityConfig({
    ALLOWED_WEB_ORIGINS: WEB_ORIGIN,
    BUILD_ID,
    PORT: '3000',
  });
  const config: AuthorityConfig = { ...base, port: 0, ...overrides };
  const authority = createAuthorityServer(config, {
    clock,
    logger,
    random: new DeterministicRandom(),
    scheduler,
  });
  authorities.add(authority);
  const address = await authority.start();
  return { authority, clock, logs, origin: address.origin, scheduler };
}

async function quickplay(
  harness: Harness,
  body: unknown = validQuickplayRequest(),
  origin = WEB_ORIGIN,
  headers: Record<string, string> = {},
): Promise<{ body: QuickplayResponse; response: Response }> {
  const response = await fetch(`${harness.origin}/api/quickplay`, {
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...headers,
    },
    method: 'POST',
  });
  return { body: (await response.json()) as QuickplayResponse, response };
}

function validQuickplayRequest(): Record<string, unknown> {
  return { buildId: BUILD_ID, protocolVersion: PROTOCOL_VERSION };
}

function successfulAdmission(response: QuickplayResponse) {
  if (response.status !== 'ok') throw new Error(`Admission failed: ${response.code}`);
  return response;
}

function socketClient(
  harness: Harness,
  token: string,
  auth: Record<string, unknown> = {},
  origin = WEB_ORIGIN,
): ClientSocket {
  const client = createSocketClient(harness.origin, {
    auth: {
      buildId: BUILD_ID,
      protocolVersion: PROTOCOL_VERSION,
      token,
      ...auth,
    },
    autoConnect: false,
    extraHeaders: { Origin: origin },
    forceNew: true,
    path: '/ws',
    reconnection: false,
    transports: ['websocket'],
  });
  clients.add(client);
  client.connect();
  return client;
}

async function connect(
  harness: Harness,
  token: string,
): Promise<{ client: ClientSocket; welcome: Welcome }> {
  const client = socketClient(harness, token);
  const welcome = await onceEvent<Welcome>(client, SERVER_EVENTS.WELCOME);
  return { client, welcome };
}

function onceEvent<T>(socket: ClientSocket, eventName: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(eventName, (value: T) => resolve(value));
  });
}

function waitFor<T>(
  socket: ClientSocket,
  eventName: string,
  predicate: (value: T) => boolean,
): Promise<T> {
  return new Promise((resolve) => {
    const listener = (value: T): void => {
      if (!predicate(value)) return;
      socket.off(eventName, listener);
      resolve(value);
    };
    socket.on(eventName, listener);
  });
}

function advanceTicks(harness: Harness, ticks: number): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    harness.clock.advance(STEP_MS);
    harness.scheduler.runIntervals();
  }
}

async function advanceWithSnapshots(
  harness: Harness,
  client: ClientSocket,
  ticks: number,
): Promise<FullSnapshot> {
  if (ticks % 3 !== 0) throw new Error('Snapshot advances must use three-tick groups');
  let snapshot: FullSnapshot | undefined;
  for (let tick = 0; tick < ticks; tick += 3) {
    const next = onceEvent<FullSnapshot>(client, SERVER_EVENTS.SNAPSHOT);
    advanceTicks(harness, 3);
    snapshot = await next;
  }
  if (snapshot === undefined) throw new Error('Expected an authoritative snapshot');
  return snapshot;
}

function neutralInput(sequence: number) {
  return {
    aim: { x: 0, y: -1 },
    dash: false,
    firing: false,
    move: { x: 0, y: 0 },
    protocolVersion: PROTOCOL_VERSION,
    sequence,
  };
}

function normalizedDirection(x: number, y: number): { x: number; y: number } {
  const magnitude = Math.hypot(x, y);
  if (magnitude === 0) return { x: 0, y: -1 };
  return { x: (x / magnitude) * 0.999, y: (y / magnitude) * 0.999 };
}

function ping(
  client: ClientSocket,
  sequence: number,
): Promise<{ protocolVersion: number; sequence: number; serverTick: number }> {
  return new Promise((resolve) => {
    client.emit(
      CLIENT_EVENTS.PING,
      { protocolVersion: PROTOCOL_VERSION, sequence },
      resolve,
    );
  });
}

function leave(client: ClientSocket): Promise<unknown> {
  return new Promise((resolve) => {
    client.emit(CLIENT_EVENTS.LEAVE, { protocolVersion: PROTOCOL_VERSION }, resolve);
  });
}

interface SocketConnectionError extends Error {
  data?: ServerError;
}
