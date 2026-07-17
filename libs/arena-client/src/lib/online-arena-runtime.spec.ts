import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLIENT_EVENTS,
  PROTOCOL_VERSION,
  SERVER_EVENTS,
  type FullSnapshot,
  type QuickplayResponse,
  type SnapshotPlayer,
  type Welcome,
} from '@dropzone-arena/arena-protocol';

import {
  createOnlineArenaRuntimeDriver,
  type OnlineArenaRuntimeDependencies,
  type OnlineRuntimeAnimationFrames,
  type OnlineRuntimeClock,
  type OnlineRuntimeFetch,
  type OnlineRuntimeFetchResponse,
  type OnlineRuntimePresentation,
  type OnlineRuntimeSocket,
  type OnlineRuntimeSocketOptions,
  type OnlineRuntimeStorage,
} from './online-arena-runtime';
import type {
  OnlineArenaHudSnapshot,
  OnlineArenaRuntimeDriver,
  OnlineArenaStatus,
  OnlineArenaUnavailableReason,
} from './online-arena-runtime-driver';
import type { OnlineArenaPresentationFrame } from './three-arena-presentation';

const TOKEN = 'A'.repeat(43);
const NEXT_TOKEN = 'B'.repeat(43);
const STORAGE_KEY = 'dropzone-arena.online-session.v1';

const drivers: OnlineArenaRuntimeDriver[] = [];

afterEach(() => {
  for (const driver of drivers) driver.dispose();
  drivers.length = 0;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('OnlineArenaRuntime', () => {
  it('surfaces renderer construction failure before any session can be admitted', () => {
    const fetch = vi.fn<OnlineRuntimeFetch>();
    const statuses: OnlineArenaStatus[] = [];
    const unavailable: OnlineArenaUnavailableReason[] = [];
    expect(() =>
      createOnlineArenaRuntimeDriver(
        {
          config: {
            authorityUrl: 'https://authority.example',
            buildId: 'build-1',
            enabled: true,
          },
          host: document.createElement('div'),
          onFieldMenuRequested: vi.fn<() => void>(),
          onHudSnapshot: vi.fn<(snapshot: OnlineArenaHudSnapshot) => void>(),
          onInputReset: vi.fn<() => void>(),
          onReconnectGraceChanged: vi.fn<(remaining: number | null) => void>(),
          onStatus: (status) => statuses.push(status),
          onUnavailable: (reason) => unavailable.push(reason),
          reducedMotion: false,
        },
        {
          createPresentation: () => {
            throw new Error('renderer failed');
          },
          fetch,
        },
      ),
    ).toThrow('Online arena renderer unavailable.');
    expect(fetch).not.toHaveBeenCalled();
    expect(statuses).toEqual(['unavailable']);
    expect(unavailable).toEqual(['renderer']);
  });

  it('creates presentation before explicit admission and owns the token lifecycle', async () => {
    const harness = createHarness();
    harness.queueAdmission(successfulAdmission());

    expect(harness.presentation).toBeDefined();
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.sockets).toHaveLength(0);

    await harness.driver.startQuickplay();

    expect(harness.fetch).toHaveBeenCalledOnce();
    const [url, request] = harness.fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://authority.example/api/quickplay');
    expect(url).not.toContain(TOKEN);
    expect(request).toMatchObject({
      body: JSON.stringify({ buildId: 'build-1', protocolVersion: PROTOCOL_VERSION }),
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(harness.storage.values).toEqual(new Map([[STORAGE_KEY, TOKEN]]));

    const socket = harness.sockets[0];
    expect(socket).toBeDefined();
    if (!socket) return;
    expect(socket.url).toBe('https://authority.example');
    expect(socket.url).not.toContain(TOKEN);
    expect(socket.options).toMatchObject({
      auth: { buildId: 'build-1', protocolVersion: PROTOCOL_VERSION, token: TOKEN },
      autoConnect: false,
      forceNew: true,
      path: '/ws',
      reconnection: false,
      transports: ['polling', 'websocket'],
      withCredentials: false,
    });
    expect(document.body.innerHTML).not.toContain(TOKEN);

    socket.accept();
    socket.serverEmit(SERVER_EVENTS.WELCOME, createWelcome(3));
    expect(harness.statuses).toEqual(['connecting', 'connected']);
    expect(harness.hud.at(-1)).toMatchObject({
      callsign: 'ALPHA',
      dashReady: 1,
      deaths: 0,
      health: 100,
      kills: 0,
      marker: 1,
      population: 1,
      status: 'alive',
    });

    const leaving = harness.driver.leave();
    acknowledgeLast(socket, CLIENT_EVENTS.LEAVE, {
      left: true,
      protocolVersion: PROTOCOL_VERSION,
    });
    await leaving;
    expect(harness.storage.values.has(STORAGE_KEY)).toBe(false);
    expect(socket.disconnectCount).toBe(1);
    expect(harness.presentation.resetOnline).toHaveBeenCalled();
  });

  it('resumes the versioned same-tab token without admission and starts fresh only explicitly', async () => {
    const storage = new MemoryStorage([[STORAGE_KEY, TOKEN]]);
    const harness = createHarness({ storage });

    await harness.driver.startQuickplay();
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.sockets[0]?.options.auth.token).toBe(TOKEN);

    const resumed = harness.sockets[0];
    if (!resumed) return;
    resumed.accept();
    resumed.serverEmit(SERVER_EVENTS.WELCOME, createWelcome(4));
    harness.queueAdmission(successfulAdmission(NEXT_TOKEN, 'player-2', 'BRAVO'));

    const fresh = harness.driver.startFreshQuickplay();
    acknowledgeLast(resumed, CLIENT_EVENTS.LEAVE, {
      left: true,
      protocolVersion: PROTOCOL_VERSION,
    });
    await fresh;

    expect(harness.fetch).toHaveBeenCalledOnce();
    expect(harness.sockets.at(-1)?.options.auth.token).toBe(NEXT_TOKEN);
    expect(storage.values.get(STORAGE_KEY)).toBe(NEXT_TOKEN);
  });

  it('keeps blocked storage recoverable while retaining an in-memory reconnect token', async () => {
    const storage: OnlineRuntimeStorage = {
      getItem: vi.fn<(key: string) => string | null>(() => {
        throw new DOMException('blocked');
      }),
      removeItem: vi.fn<(key: string) => void>(() => {
        throw new DOMException('blocked');
      }),
      setItem: vi.fn<(key: string, value: string) => void>(() => {
        throw new DOMException('blocked');
      }),
    };
    const harness = createHarness({ storage });
    harness.queueAdmission(successfulAdmission());

    await expect(harness.driver.startQuickplay()).resolves.toBeUndefined();
    const first = harness.sockets[0];
    if (!first) return;
    first.accept();
    first.serverEmit(SERVER_EVENTS.WELCOME, createWelcome(1));
    first.drop();
    harness.clock.runDue();

    expect(harness.sockets.at(-1)?.options.auth.token).toBe(TOKEN);
    await expect(harness.driver.leave()).resolves.toBeUndefined();
  });

  it('strictly rejects malformed admission, welcome, snapshot, error, and draining payloads', async () => {
    const malformedAdmission = createHarness();
    malformedAdmission.queueResponse({
      ...successfulAdmission(),
      unexpected: true,
    });
    await malformedAdmission.driver.startQuickplay();
    expect(malformedAdmission.statuses.at(-1)).toBe('unavailable');
    expect(malformedAdmission.sockets).toHaveLength(0);

    for (const eventName of [
      SERVER_EVENTS.WELCOME,
      SERVER_EVENTS.SNAPSHOT,
      SERVER_EVENTS.ERROR,
      SERVER_EVENTS.DRAINING,
    ] as const) {
      const harness = createHarness();
      harness.queueAdmission(successfulAdmission());
      await harness.driver.startQuickplay();
      const socket = harness.sockets[0];
      if (!socket) continue;
      socket.accept();
      if (eventName !== SERVER_EVENTS.WELCOME) {
        socket.serverEmit(SERVER_EVENTS.WELCOME, createWelcome(2));
      }
      socket.serverEmit(eventName, { unexpected: true });
      expect(harness.statuses.at(-1)).toBe('unavailable');
      expect(harness.unavailable.at(-1)).toBe('transport');
    }
  });

  it('maps capacity, incompatibility, draining, expiry, and bounded admission timeout', async () => {
    const capacity = createHarness();
    capacity.queueAdmission(
      quickplayError('CAPACITY', { retryAfterMs: 1_000, retryable: true }),
      false,
      503,
    );
    await capacity.driver.startQuickplay();
    expect(capacity.statuses).toEqual(['connecting', 'capacity']);

    const incompatible = createHarness();
    incompatible.queueAdmission(
      quickplayError('BUILD_MISMATCH', { buildId: 'build-2' }),
      false,
      409,
    );
    await incompatible.driver.startQuickplay();
    expect(incompatible.statuses.at(-1)).toBe('incompatible');

    const newerProtocol = createHarness();
    newerProtocol.queueResponse(
      {
        ...quickplayError('PROTOCOL_MISMATCH'),
        protocolVersion: 2,
      },
      false,
      426,
    );
    await newerProtocol.driver.startQuickplay();
    expect(newerProtocol.statuses.at(-1)).toBe('incompatible');

    const terminal = createHarness();
    terminal.queueAdmission(successfulAdmission());
    await terminal.driver.startQuickplay();
    const socket = terminal.sockets[0];
    if (!socket) return;
    socket.accept();
    socket.serverEmit(SERVER_EVENTS.WELCOME, createWelcome(1));
    socket.serverEmit(SERVER_EVENTS.DRAINING, {
      buildId: 'build-1',
      code: 'SERVER_DRAINING',
      protocolVersion: PROTOCOL_VERSION,
      retryAfterMs: 200,
    });
    expect(terminal.statuses.at(-1)).toBe('draining');

    const expired = createHarness({
      storage: new MemoryStorage([[STORAGE_KEY, TOKEN]]),
    });
    await expired.driver.resumeSession();
    expect(expired.reconnectGrace).toEqual([10]);
    expired.sockets[0]?.serverEmit('connect_error', {
      data: {
        buildId: 'build-1',
        code: 'SESSION_EXPIRED',
        protocolVersion: PROTOCOL_VERSION,
        retryable: false,
      },
    });
    expect(expired.statuses.at(-1)).toBe('expired');
    expect(expired.reconnectGrace.at(-1)).toBeNull();
    expect(expired.storage.values.has(STORAGE_KEY)).toBe(false);

    const timeout = createHarness();
    timeout.fetch.mockImplementationOnce(
      () => new Promise<OnlineRuntimeFetchResponse>(() => undefined),
    );
    const starting = timeout.driver.startQuickplay();
    timeout.clock.advance(4_999);
    expect(timeout.statuses.at(-1)).toBe('connecting');
    timeout.clock.advance(1);
    await starting;
    expect(timeout.statuses.at(-1)).toBe('unavailable');
  });

  it('reconnects with the same token, sends no disconnected input, and waits for a newer full snapshot', async () => {
    const harness = await connectedHarness(10);
    const first = harness.sockets[0];
    if (!first) return;

    dispatchKey('keydown', 'KeyW');
    harness.frames.frame(17);
    expect(first.emissionsFor(CLIENT_EVENTS.INPUT).length).toBeGreaterThan(0);

    first.drop();
    expect(harness.statuses.at(-1)).toBe('reconnecting');
    dispatchKey('keydown', 'KeyD');
    harness.frames.frame(17);
    const disconnectedInputCount = first.emissionsFor(CLIENT_EVENTS.INPUT).length;
    harness.frames.frame(17);
    expect(first.emissionsFor(CLIENT_EVENTS.INPUT)).toHaveLength(
      disconnectedInputCount,
    );

    harness.clock.runDue();
    const second = harness.sockets[1];
    expect(second?.options.auth.token).toBe(TOKEN);
    if (!second) return;
    second.accept();
    second.serverEmit(SERVER_EVENTS.WELCOME, createWelcome(10));
    expect(harness.statuses.at(-1)).toBe('reconnecting');
    harness.frames.frame(17);
    expect(second.emissionsFor(CLIENT_EVENTS.INPUT)).toHaveLength(0);

    second.serverEmit(SERVER_EVENTS.SNAPSHOT, createSnapshot(13));
    expect(harness.statuses.at(-1)).toBe('connected');
    harness.frames.frame(17);
    expect(second.emissionsFor(CLIENT_EVENTS.INPUT).length).toBeGreaterThan(0);
    expect(harness.fetch).toHaveBeenCalledOnce();
  });

  it('reports actual reconnect grace from the active deadline only when integer seconds change', async () => {
    const harness = await connectedHarness(3);
    harness.frames.frame(15_000);
    harness.sockets[0]?.drop();

    expect(harness.reconnectGrace).toEqual([10]);
    harness.frames.frame(999);
    expect(harness.reconnectGrace).toEqual([10]);
    harness.frames.frame(1);
    expect(harness.reconnectGrace).toEqual([10, 9]);

    const reconnecting = harness.sockets[1];
    if (!reconnecting) return;
    reconnecting.accept();
    reconnecting.serverEmit(SERVER_EVENTS.WELCOME, createWelcome(3));
    reconnecting.serverEmit(SERVER_EVENTS.SNAPSHOT, createSnapshot(6));
    expect(harness.reconnectGrace).toEqual([10, 9, null]);
  });

  it('bounds missing leave acknowledgments and rejects malformed acknowledgments', async () => {
    const missing = await connectedHarness(1);
    const missingSocket = missing.sockets[0];
    if (!missingSocket) return;
    const boundedLeave = missing.driver.leave();
    missing.clock.advance(999);
    expect(missingSocket.disconnectCount).toBe(0);
    missing.clock.advance(1);
    await boundedLeave;
    expect(missingSocket.disconnectCount).toBe(1);
    expect(missing.storage.values.has(STORAGE_KEY)).toBe(false);

    const malformed = await connectedHarness(1);
    const malformedSocket = malformed.sockets[0];
    if (!malformedSocket) return;
    const rejectedLeave = malformed.driver.leave();
    acknowledgeLast(malformedSocket, CLIENT_EVENTS.LEAVE, {
      left: true,
      protocolVersion: PROTOCOL_VERSION,
      unexpected: true,
    });
    await rejectedLeave;
    expect(malformed.statuses.at(-1)).toBe('unavailable');
    expect(malformed.unavailable.at(-1)).toBe('transport');
  });

  it('neutralizes controls for field menu, blur, and hiding without hidden-time catch-up', async () => {
    const harness = await connectedHarness(3);
    const socket = harness.sockets[0];
    if (!socket) return;
    dispatchKey('keydown', 'KeyW');
    harness.frames.frame(17);

    harness.driver.openFieldMenu();
    expect(lastInput(socket)).toMatchObject({
      dash: false,
      firing: false,
      move: { x: 0, y: 0 },
    });
    socket.serverEmit(SERVER_EVENTS.SNAPSHOT, createSnapshot(6));
    harness.driver.closeFieldMenu();
    const framesBeforeFreshSnapshot = harness.presentation.frames.length;
    harness.clock.advance(5_000);
    harness.frames.frame(0);
    expect(harness.presentation.frames).toHaveLength(framesBeforeFreshSnapshot);
    expect(harness.presentation.resetOnline).toHaveBeenCalled();
    socket.serverEmit(SERVER_EVENTS.SNAPSHOT, createSnapshot(9));
    harness.frames.frame(17);
    expect(harness.presentation.frames.at(-1)?.localPlayer).not.toBeNull();

    globalThis.dispatchEvent(new Event('blur'));
    expect(lastInput(socket)).toMatchObject({ move: { x: 0, y: 0 } });
    socket.serverEmit(SERVER_EVENTS.SNAPSHOT, createSnapshot(12));
    globalThis.dispatchEvent(new Event('focus'));
    socket.serverEmit(SERVER_EVENTS.SNAPSHOT, createSnapshot(15));
    harness.frames.frame(17);

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(lastInput(socket)).toMatchObject({ move: { x: 0, y: 0 } });
  });

  it('uses one monotonic timestamp when the field menu neutralizes prediction', async () => {
    const harness = createHarness({ clock: new ManualClock(0.01) });
    harness.queueAdmission(successfulAdmission());
    await harness.driver.startQuickplay();
    const socket = harness.sockets[0];
    if (!socket) throw new Error('Expected online socket');
    socket.accept();
    socket.serverEmit(SERVER_EVENTS.WELCOME, createWelcome(0));

    expect(() => harness.driver.openFieldMenu()).not.toThrow();
    expect(lastInput(socket)).toMatchObject({
      dash: false,
      firing: false,
      move: { x: 0, y: 0 },
    });
  });

  it('projects touch firing and dash into bounded input and exposes delayed recovery', async () => {
    const harness = await connectedHarness(0);
    const socket = harness.sockets[0];
    if (!socket) return;
    harness.driver.setTouchMove({ x: 1, y: 0 });
    harness.driver.setTouchAim({ x: 0, y: 1 }, true);
    harness.driver.triggerDash();
    harness.frames.frame(17);

    expect(lastInput(socket)).toMatchObject({
      aim: { x: 0, y: 1 },
      dash: true,
      firing: true,
      move: { x: 1, y: 0 },
    });
    expect(harness.presentation.showLocalMuzzleFeedback).toHaveBeenCalledOnce();

    harness.frames.frame(201);
    expect(harness.statuses.at(-1)).toBe('delayed');
    socket.serverEmit(SERVER_EVENTS.SNAPSHOT, createSnapshot(3));
    harness.frames.frame(1);
    expect(harness.statuses.at(-1)).toBe('connected');
  });

  it('clears and disables combat input across elimination until authoritative respawn', async () => {
    const harness = await connectedHarness(0);
    const socket = harness.sockets[0];
    if (!socket) return;
    harness.driver.setTouchMove({ x: 1, y: 0 });
    harness.frames.frame(17);
    const activeInputCount = socket.emissionsFor(CLIENT_EVENTS.INPUT).length;
    expect(activeInputCount).toBeGreaterThan(0);

    const eliminated = createPlayer('player-1', 'ALPHA', {
      health: 0,
      respawnTicks: 120,
      status: 'eliminated',
    });
    socket.serverEmit(SERVER_EVENTS.SNAPSHOT, createSnapshot(3, [eliminated]));
    expect(harness.inputResets).toHaveLength(1);
    harness.driver.setTouchMove({ x: -1, y: 0 });
    harness.frames.frame(34);
    expect(socket.emissionsFor(CLIENT_EVENTS.INPUT)).toHaveLength(activeInputCount);

    socket.serverEmit(SERVER_EVENTS.SNAPSHOT, createSnapshot(6));
    harness.driver.setTouchMove({ x: -1, y: 0 });
    harness.frames.frame(34);
    expect(socket.emissionsFor(CLIENT_EVENTS.INPUT).length).toBeGreaterThan(
      activeInputCount,
    );
  });

  it('bounds manual reconnect attempts to the configured ten-second window', async () => {
    const harness = await connectedHarness(1);
    harness.sockets[0]?.drop();
    harness.clock.runDue();
    expect(harness.sockets).toHaveLength(2);

    harness.clock.advance(5_000);
    expect(harness.statuses.at(-1)).toBe('reconnecting');
    harness.clock.runDue();
    expect(harness.sockets.length).toBeLessThanOrEqual(3);
    harness.clock.advance(5_000);

    expect(harness.statuses.at(-1)).toBe('unavailable');
    expect(harness.sockets.length).toBeLessThanOrEqual(3);
    expect(harness.sockets.every((socket) => socket.options.auth.token === TOKEN)).toBe(
      true,
    );
    expect(harness.fetch).toHaveBeenCalledOnce();
  });

  it('maps authoritative HUD at no more than 10 Hz and validates low-rate ping acknowledgments', async () => {
    const local = createPlayer('player-1', 'ALPHA', {
      dashCooldownTicks: 68,
      health: 0,
      respawnTicks: 121,
      statistics: { deaths: 3, kills: 4 },
      status: 'eliminated',
    });
    const remote = createPlayer('player-2', 'BRAVO', {
      statistics: { deaths: 1, kills: 2 },
    });
    const harness = await connectedHarness(3, [local, remote]);
    expect(harness.inputResets).toHaveLength(1);
    expect(harness.hud.at(-1)).toMatchObject({
      dashReady: expect.closeTo(1 - 68 / 135),
      deaths: 3,
      health: 0,
      kills: 4,
      population: 2,
      respawnSeconds: 3,
      status: 'eliminated',
    });

    const initialHudCount = harness.hud.length;
    harness.sockets[0]?.serverEmit(
      SERVER_EVENTS.SNAPSHOT,
      createSnapshot(6, [local, remote]),
    );
    harness.frames.frame(99);
    expect(harness.hud).toHaveLength(initialHudCount);
    harness.frames.frame(1);
    expect(harness.hud).toHaveLength(initialHudCount + 1);

    harness.frames.frame(1_900);
    const socket = harness.sockets[0];
    const ping = socket?.emissionsFor(CLIENT_EVENTS.PING).at(-1);
    expect(ping).toBeDefined();
    const pingPayload = ping?.values[0] as { sequence: number } | undefined;
    const acknowledge = ping?.values[1];
    if (typeof acknowledge === 'function' && pingPayload) {
      acknowledge({
        protocolVersion: PROTOCOL_VERSION,
        sequence: pingPayload.sequence,
        serverTick: 120,
      });
    }
    expect(harness.statuses.at(-1)).not.toBe('unavailable');

    harness.frames.frame(2_000);
    const malformedAcknowledgment = socket?.emissionsFor(CLIENT_EVENTS.PING).at(-1)
      ?.values[1];
    if (typeof malformedAcknowledgment === 'function') {
      malformedAcknowledgment({ protocolVersion: PROTOCOL_VERSION, sequence: 2 });
    }
    expect(harness.statuses.at(-1)).toBe('unavailable');
  });

  it('retains renderer-loss grace, then performs a bounded explicit leave without presentation', async () => {
    const harness = await connectedHarness(3);
    const socket = harness.sockets[0];
    if (!socket) return;
    dispatchKey('keydown', 'KeyW');
    harness.frames.frame(17);

    harness.presentation.loseContext();
    expect(lastInput(socket)).toMatchObject({ move: { x: 0, y: 0 } });
    expect(socket.emissionsFor(CLIENT_EVENTS.LEAVE)).toHaveLength(0);
    expect(socket.disconnectCount).toBe(1);
    expect(harness.storage.values.get(STORAGE_KEY)).toBe(TOKEN);
    expect(harness.statuses.at(-1)).toBe('unavailable');
    expect(harness.unavailable.at(-1)).toBe('renderer');
    expect(harness.presentation.dispose).toHaveBeenCalledOnce();

    const leaving = harness.driver.leave();
    const releaseSocket = harness.sockets[1];
    expect(releaseSocket?.options.auth.token).toBe(TOKEN);
    if (!releaseSocket) return;
    releaseSocket.accept();
    acknowledgeLast(releaseSocket, CLIENT_EVENTS.LEAVE, {
      left: true,
      protocolVersion: PROTOCOL_VERSION,
    });
    await leaving;
    expect(releaseSocket.emissionsFor(CLIENT_EVENTS.LEAVE)).toHaveLength(1);
    expect(harness.storage.values.has(STORAGE_KEY)).toBe(false);

    harness.driver.dispose();
    expect(harness.presentation.dispose).toHaveBeenCalledOnce();
  });
});

async function connectedHarness(
  tick: number,
  players: SnapshotPlayer[] = [createPlayer()],
): Promise<RuntimeHarness> {
  const harness = createHarness();
  harness.queueAdmission(successfulAdmission());
  await harness.driver.startQuickplay();
  const socket = harness.sockets[0];
  if (!socket) throw new Error('Expected online socket');
  socket.accept();
  socket.serverEmit(SERVER_EVENTS.WELCOME, createWelcome(tick, players));
  return harness;
}

function createHarness(
  overrides: Partial<OnlineArenaRuntimeDependencies> = {},
): RuntimeHarness {
  const clock =
    overrides.clock instanceof ManualClock ? overrides.clock : new ManualClock();
  const frames = new ManualAnimationFrames(clock);
  const storage =
    overrides.storage instanceof MemoryStorage
      ? overrides.storage
      : new MemoryStorage();
  const sockets: FakeSocket[] = [];
  const presentations: FakePresentation[] = [];
  const responses: OnlineRuntimeFetchResponse[] = [];
  const fetch = vi.fn<OnlineRuntimeFetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected admission request');
    return response;
  });
  const statuses: OnlineArenaStatus[] = [];
  const hud: OnlineArenaHudSnapshot[] = [];
  const inputResets: number[] = [];
  const reconnectGrace: Array<number | null> = [];
  const unavailable: OnlineArenaUnavailableReason[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const dependencies: OnlineArenaRuntimeDependencies = {
    animationFrames: frames,
    clock,
    createPresentation: (options) => {
      const presentation = new FakePresentation(options.onContextLost);
      presentations.push(presentation);
      host.append(presentation.canvas);
      return presentation;
    },
    createSocket: (url, options) => {
      const socket = new FakeSocket(url, options);
      sockets.push(socket);
      return socket;
    },
    fetch,
    storage,
    ...overrides,
  };
  const driver = createOnlineArenaRuntimeDriver(
    {
      config: {
        authorityUrl: 'https://authority.example',
        buildId: 'build-1',
        enabled: true,
      },
      host,
      onFieldMenuRequested: vi.fn<() => void>(),
      onHudSnapshot: (snapshot) => hud.push(snapshot),
      onInputReset: () => inputResets.push(inputResets.length + 1),
      onReconnectGraceChanged: (remaining) => reconnectGrace.push(remaining),
      onStatus: (status) => statuses.push(status),
      onUnavailable: (reason) => unavailable.push(reason),
      reducedMotion: false,
    },
    dependencies,
  );
  drivers.push(driver);
  return {
    clock,
    driver,
    fetch,
    frames,
    get presentation() {
      const presentation = presentations[0];
      if (!presentation) throw new Error('Expected presentation');
      return presentation;
    },
    hud,
    inputResets,
    queueAdmission: (response, ok = true, status = ok ? 200 : 503) => {
      responses.push(fetchResponse(response, ok, status));
    },
    queueResponse: (response, ok = true, status = ok ? 200 : 503) => {
      responses.push(fetchResponse(response, ok, status));
    },
    sockets,
    reconnectGrace,
    statuses,
    storage,
    unavailable,
  };
}

interface RuntimeHarness {
  clock: ManualClock;
  driver: OnlineArenaRuntimeDriver;
  fetch: ReturnType<typeof vi.fn<OnlineRuntimeFetch>>;
  frames: ManualAnimationFrames;
  hud: OnlineArenaHudSnapshot[];
  inputResets: number[];
  presentation: FakePresentation;
  queueAdmission(response: QuickplayResponse, ok?: boolean, status?: number): void;
  queueResponse(response: unknown, ok?: boolean, status?: number): void;
  sockets: FakeSocket[];
  reconnectGrace: Array<number | null>;
  statuses: OnlineArenaStatus[];
  storage: MemoryStorage;
  unavailable: OnlineArenaUnavailableReason[];
}

class ManualClock implements OnlineRuntimeClock {
  private time = 0;
  private nextHandle = 1;
  private readonly timers = new Map<
    number,
    { callback: () => void; deadline: number }
  >();

  constructor(private readonly readStep = 0) {}

  now(): number {
    const value = this.time;
    this.time += this.readStep;
    return value;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, {
      callback,
      deadline: this.time + Math.max(0, delayMs),
    });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle);
  }

  advance(milliseconds: number): void {
    this.time += milliseconds;
    this.runDue();
  }

  runDue(): void {
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.deadline <= this.time)
        .sort((first, second) => first[1].deadline - second[1].deadline)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

class ManualAnimationFrames implements OnlineRuntimeAnimationFrames {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();

  constructor(private readonly clock: ManualClock) {}

  request(callback: FrameRequestCallback): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: unknown): void {
    if (typeof handle === 'number') this.callbacks.delete(handle);
  }

  frame(milliseconds: number): void {
    this.clock.advance(milliseconds);
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(this.clock.now());
  }
}

class MemoryStorage implements OnlineRuntimeStorage {
  readonly values: Map<string, string>;

  constructor(entries: Iterable<readonly [string, string]> = []) {
    this.values = new Map(entries);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

interface Emission {
  eventName: string;
  values: unknown[];
  volatile: boolean;
}

class FakeSocket implements OnlineRuntimeSocket {
  connected = false;
  readonly emissions: Emission[] = [];
  readonly listeners = new Map<string, Array<(...values: unknown[]) => void>>();
  connectCount = 0;
  disconnectCount = 0;
  readonly volatile = {
    emit: (eventName: string, ...values: unknown[]): unknown => {
      this.emissions.push({ eventName, values, volatile: true });
      return this;
    },
  };

  constructor(
    readonly url: string,
    readonly options: OnlineRuntimeSocketOptions,
  ) {}

  connect(): unknown {
    this.connectCount += 1;
    return this;
  }

  disconnect(): unknown {
    this.disconnectCount += 1;
    this.connected = false;
    return this;
  }

  emit(eventName: string, ...values: unknown[]): unknown {
    this.emissions.push({ eventName, values, volatile: false });
    return this;
  }

  on(eventName: string, listener: (...values: unknown[]) => void): unknown {
    const listeners = this.listeners.get(eventName) ?? [];
    listeners.push(listener);
    this.listeners.set(eventName, listeners);
    return this;
  }

  accept(): void {
    this.connected = true;
    this.serverEmit('connect');
  }

  drop(): void {
    this.connected = false;
    this.serverEmit('disconnect', 'transport close');
  }

  serverEmit(eventName: string, ...values: unknown[]): void {
    for (const listener of this.listeners.get(eventName) ?? []) listener(...values);
  }

  emissionsFor(eventName: string): Emission[] {
    return this.emissions.filter((emission) => emission.eventName === eventName);
  }
}

class FakePresentation implements OnlineRuntimePresentation {
  readonly canvas = document.createElement('canvas');
  readonly frames: OnlineArenaPresentationFrame[] = [];
  readonly markers = new Map<string, number>();
  readonly dispose = vi.fn<() => void>();
  readonly processOnlineEvents =
    vi.fn<OnlineRuntimePresentation['processOnlineEvents']>();
  readonly render = vi.fn<OnlineRuntimePresentation['render']>();
  readonly resetOnline = vi.fn<OnlineRuntimePresentation['resetOnline']>();
  readonly setReducedMotion = vi.fn<OnlineRuntimePresentation['setReducedMotion']>();
  readonly showLocalMuzzleFeedback =
    vi.fn<OnlineRuntimePresentation['showLocalMuzzleFeedback']>();

  constructor(private readonly onContextLost: () => void) {
    Object.defineProperty(this.canvas, 'setPointerCapture', {
      configurable: true,
      value: vi.fn<(pointerId: number) => void>(),
    });
  }

  getOnlineMarker(playerId: string): number | null {
    return this.markers.get(playerId) ?? null;
  }

  projectPointerAim(
    _clientX: number,
    _clientY: number,
    _origin: { x: number; y: number },
    fallback: { x: number; y: number },
  ): { x: number; y: number } {
    return fallback;
  }

  syncOnline(frame: OnlineArenaPresentationFrame): void {
    this.frames.push(frame);
    const players = [frame.localPlayer, ...frame.remotePlayers].filter(
      (player): player is SnapshotPlayer => player !== null,
    );
    for (const player of players) {
      if (!this.markers.has(player.id))
        this.markers.set(player.id, this.markers.size + 1);
    }
  }

  loseContext(): void {
    this.onContextLost();
  }
}

function fetchResponse(
  value: unknown,
  ok: boolean,
  status: number,
): OnlineRuntimeFetchResponse {
  return {
    ok,
    status,
    text: async () => JSON.stringify(value),
  };
}

function successfulAdmission(
  token = TOKEN,
  playerId = 'player-1',
  callsign = 'ALPHA',
): QuickplayResponse {
  return {
    arenaId: 'arena-1',
    buildId: 'build-1',
    callsign,
    playerId,
    protocolVersion: PROTOCOL_VERSION,
    reservationExpiresInMs: 10_000,
    status: 'ok',
    token,
  };
}

function quickplayError(
  code:
    | 'BUILD_MISMATCH'
    | 'CAPACITY'
    | 'INVALID_REQUEST'
    | 'ORIGIN_REJECTED'
    | 'PROTOCOL_MISMATCH'
    | 'RATE_LIMITED'
    | 'SERVER_DRAINING'
    | 'SERVICE_UNAVAILABLE',
  overrides: Partial<Extract<QuickplayResponse, { status: 'error' }>> = {},
): QuickplayResponse {
  return {
    buildId: 'build-1',
    code,
    protocolVersion: PROTOCOL_VERSION,
    retryable: false,
    status: 'error',
    ...overrides,
  };
}

function createWelcome(
  tick: number,
  players: SnapshotPlayer[] = [createPlayer()],
): Welcome {
  return {
    arenaId: 'arena-1',
    buildId: 'build-1',
    callsign: 'ALPHA',
    inputRateHz: 30,
    playerId: 'player-1',
    protocolVersion: PROTOCOL_VERSION,
    reconnectGraceMs: 10_000,
    simulationRateHz: 60,
    snapshot: createSnapshot(tick, players),
    snapshotRateHz: 20,
  };
}

function createSnapshot(
  tick: number,
  players: SnapshotPlayer[] = [createPlayer()],
): FullSnapshot {
  return {
    arenaId: 'arena-1',
    buildId: 'build-1',
    events: [],
    players,
    projectiles: [],
    protocolVersion: PROTOCOL_VERSION,
    tick,
  };
}

function createPlayer(
  id = 'player-1',
  callsign = 'ALPHA',
  overrides: Partial<SnapshotPlayer> = {},
): SnapshotPlayer {
  return {
    aim: { x: 0, y: -1 },
    callsign,
    dashCooldownTicks: 0,
    dashTicks: 0,
    fireCooldownTicks: 0,
    health: 100,
    id,
    lastProcessedInputSequence: 0,
    position: { x: 0, y: 0 },
    radius: 0.48,
    respawnTicks: 0,
    spawnProtectionTicks: 0,
    statistics: { deaths: 0, kills: 0 },
    status: 'alive',
    velocity: { x: 0, y: 0 },
    ...overrides,
  };
}

function acknowledgeLast(socket: FakeSocket, eventName: string, value: unknown): void {
  const acknowledgment = socket.emissionsFor(eventName).at(-1)?.values.at(-1);
  if (typeof acknowledgment !== 'function') {
    throw new Error(`Expected ${eventName} acknowledgment`);
  }
  acknowledgment(value);
}

function lastInput(socket: FakeSocket): unknown {
  return socket.emissionsFor(CLIENT_EVENTS.INPUT).at(-1)?.values[0];
}

function dispatchKey(type: 'keydown' | 'keyup', code: string): void {
  globalThis.dispatchEvent(new KeyboardEvent(type, { cancelable: true, code }));
}
