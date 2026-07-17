import { FFA_DASH_COOLDOWN_TICKS, type Vector2 } from '@dropzone-arena/arena-engine';
import {
  BuildIdSchema,
  CLIENT_EVENTS,
  DrainingSchema,
  FullSnapshotSchema,
  HandshakeAuthSchema,
  LeaveAckSchema,
  MAX_PING_SEQUENCE,
  PROTOCOL_VERSION,
  PongSchema,
  QuickplayResponseSchema,
  SERVER_EVENTS,
  SIMULATION_RATE_HZ,
  ServerErrorSchema,
  SessionTokenSchema,
  WelcomeSchema,
  utf8ByteLength,
  type FullSnapshot,
  type QuickplayError,
  type QuickplaySuccess,
  type ServerError,
  type SnapshotPlayer,
  type Welcome,
} from '@dropzone-arena/arena-protocol';
import { io as createSocketIoClient } from 'socket.io-client';

import { ArenaInputController } from './arena-input-controller';
import type {
  OnlineArenaHudSnapshot,
  OnlineArenaRuntimeDriver,
  OnlineArenaRuntimeDriverOptions,
  OnlineArenaStatus,
  OnlineArenaUnavailableReason,
} from './online-arena-runtime-driver';
import { OnlineNetcode } from './online-netcode';
import {
  ThreeArenaPresentation,
  type OnlineArenaPresentationFrame,
  type ThreeArenaPresentationOptions,
} from './three-arena-presentation';

const SESSION_STORAGE_KEY = 'dropzone-arena.online-session.v1';
const ADMISSION_TIMEOUT_MS = 5_000;
const CONNECTION_TIMEOUT_MS = 5_000;
const MAX_RECONNECT_WINDOW_MS = 10_000;
const LEAVE_ACK_TIMEOUT_MS = 1_000;
const PING_INTERVAL_MS = 2_000;
const PING_ACK_TIMEOUT_MS = 1_500;
const HUD_INTERVAL_MS = 100;
const MAX_FRAME_MS = 100;
const MAX_QUICKPLAY_RESPONSE_BYTES = 16 * 1024;
const RECONNECT_DELAYS_MS = [0, 250, 500, 1_000, 2_000] as const;

export interface OnlineRuntimeClock {
  clearTimeout(handle: unknown): void;
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
}

export interface OnlineRuntimeAnimationFrames {
  cancel(handle: unknown): void;
  request(callback: FrameRequestCallback): unknown;
}

export interface OnlineRuntimeStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface OnlineRuntimeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type OnlineRuntimeFetch = (
  input: string,
  init: RequestInit,
) => Promise<OnlineRuntimeFetchResponse>;

export interface OnlineRuntimeSocketOptions {
  auth: {
    buildId: string;
    protocolVersion: number;
    token: string;
  };
  autoConnect: false;
  forceNew: true;
  path: '/ws';
  reconnection: false;
  transports: ['polling', 'websocket'];
  upgrade: true;
  withCredentials: false;
}

export interface OnlineRuntimeSocket {
  readonly connected: boolean;
  readonly volatile: {
    emit(eventName: string, ...values: unknown[]): unknown;
  };
  connect(): unknown;
  disconnect(): unknown;
  emit(eventName: string, ...values: unknown[]): unknown;
  on(eventName: string, listener: (...values: unknown[]) => void): unknown;
}

export interface OnlineRuntimePresentation {
  readonly canvas: HTMLCanvasElement;
  dispose(): void;
  getOnlineMarker(playerId: string): number | null;
  processOnlineEvents(events: FullSnapshot['events'], localPlayerId: string): void;
  projectPointerAim(
    clientX: number,
    clientY: number,
    origin: Vector2,
    fallback: Vector2,
  ): Vector2;
  render(deltaSeconds: number, elapsedSeconds: number): void;
  resetOnline(retainMarkers?: boolean): void;
  setReducedMotion(reducedMotion: boolean): void;
  showLocalMuzzleFeedback(player: SnapshotPlayer): void;
  syncOnline(frame: OnlineArenaPresentationFrame): void;
}

export interface OnlineArenaRuntimeDependencies {
  animationFrames?: OnlineRuntimeAnimationFrames;
  clock?: OnlineRuntimeClock;
  createPresentation?(
    options: ThreeArenaPresentationOptions,
  ): OnlineRuntimePresentation;
  createSocket?(
    authorityUrl: string,
    options: OnlineRuntimeSocketOptions,
  ): OnlineRuntimeSocket;
  fetch?: OnlineRuntimeFetch;
  storage?: OnlineRuntimeStorage | null;
}

interface SessionIdentity {
  arenaId: string;
  callsign: string;
  playerId: string;
}

export function createOnlineArenaRuntimeDriver(
  options: OnlineArenaRuntimeDriverOptions,
  dependencies: OnlineArenaRuntimeDependencies = {},
): OnlineArenaRuntimeDriver {
  return new OnlineArenaRuntime(options, dependencies);
}

class OnlineArenaRuntime implements OnlineArenaRuntimeDriver {
  private readonly authorityUrl: string;
  private readonly reconnectWindowMs: number;
  private readonly clock: OnlineRuntimeClock;
  private readonly animationFrames: OnlineRuntimeAnimationFrames;
  private readonly fetch: OnlineRuntimeFetch;
  private readonly createSocket: NonNullable<
    OnlineArenaRuntimeDependencies['createSocket']
  >;
  private readonly storage: OnlineRuntimeStorage | null;
  private readonly input: ArenaInputController;
  private readonly presentation: OnlineRuntimePresentation;

  private animationFrame: unknown = null;
  private admissionAbort: AbortController | null = null;
  private admissionTimeout: unknown = null;
  private connectionTimeout: unknown = null;
  private reconnectTimeout: unknown = null;
  private pingTimeout: unknown = null;
  private socket: OnlineRuntimeSocket | null = null;
  private netcode: OnlineNetcode | null = null;
  private latestSnapshot: FullSnapshot | null = null;
  private expectedAdmission: QuickplaySuccess | null = null;
  private identity: SessionIdentity | null = null;
  private activeToken: string | null = null;
  private currentStatus: OnlineArenaStatus | null = null;
  private operation = 0;
  private reconnectAttempt = 0;
  private reconnectDeadline = 0;
  private lastReconnectGraceSeconds: number | null = null;
  private freshTickFloor: number | null = null;
  private snapshotReady = false;
  private welcomeReceived = false;
  private menuOpen = false;
  private browserInterrupted = false;
  private disposed = false;
  private unavailableReported = false;
  private presentationActive = false;
  private reducedMotion: boolean;
  private lastFiring = false;
  private lastFrameTime: number;
  private nextHudAt = Number.POSITIVE_INFINITY;
  private nextPingAt = Number.POSITIVE_INFINITY;
  private pingSequence = 0;
  private pendingPingSequence: number | null = null;

  constructor(
    private readonly options: OnlineArenaRuntimeDriverOptions,
    dependencies: OnlineArenaRuntimeDependencies,
  ) {
    this.authorityUrl = normalizeAuthorityUrl(options.config.authorityUrl);
    if (!BuildIdSchema.safeParse(options.config.buildId).success) {
      throw new TypeError('Online arena build configuration is invalid.');
    }
    this.reconnectWindowMs = Math.min(
      MAX_RECONNECT_WINDOW_MS,
      Math.max(1_000, options.config.reconnectWindowMs ?? MAX_RECONNECT_WINDOW_MS),
    );
    this.clock = dependencies.clock ?? browserClock;
    this.animationFrames = dependencies.animationFrames ?? browserAnimationFrames;
    this.fetch = dependencies.fetch ?? browserFetch;
    this.createSocket = dependencies.createSocket ?? browserSocketFactory;
    this.storage =
      dependencies.storage === undefined
        ? readBrowserSessionStorage()
        : dependencies.storage;
    this.reducedMotion = options.reducedMotion;
    this.lastFrameTime = this.clock.now();

    let presentation: OnlineRuntimePresentation | null = null;
    let input: ArenaInputController | null = null;
    try {
      presentation =
        dependencies.createPresentation?.({
          host: options.host,
          onContextLost: this.handleContextLost,
          reducedMotion: options.reducedMotion,
        }) ??
        new ThreeArenaPresentation({
          host: options.host,
          onContextLost: this.handleContextLost,
          reducedMotion: options.reducedMotion,
        });
      const createdPresentation = presentation;
      input = new ArenaInputController({
        element: createdPresentation.canvas,
        getAimOrigin: () =>
          this.netcode?.samplePresentation(this.clock.now()).localPlayer?.position ??
          null,
        onInterruption: this.handleBrowserInterruption,
        onMenuRequested: this.handleMenuRequested,
        projectPointerAim: (clientX, clientY, origin, fallback) =>
          createdPresentation.projectPointerAim(clientX, clientY, origin, fallback),
      });
      this.presentation = createdPresentation;
      this.input = input;
    } catch {
      input?.dispose();
      presentation?.dispose();
      options.onStatus('unavailable');
      options.onUnavailable('renderer');
      throw new Error('Online arena renderer unavailable.');
    }

    globalThis.addEventListener('focus', this.handleBrowserReturn);
    document.addEventListener('visibilitychange', this.handleVisibilityReturn);
    this.animationFrame = this.animationFrames.request(this.tick);
  }

  async startQuickplay(): Promise<void> {
    if (this.disposed || this.snapshotReady) return;
    const token = this.activeToken ?? this.readStoredToken();
    if (token) {
      this.activeToken = token;
      this.beginTokenConnection(token, 'connecting');
      return;
    }
    await this.beginAdmission();
  }

  async startFreshQuickplay(): Promise<void> {
    if (this.disposed) return;
    await this.leave();
    if (!this.disposed) await this.beginAdmission();
  }

  async resumeSession(): Promise<void> {
    if (this.disposed) return;
    const token = this.activeToken ?? this.readStoredToken();
    if (!token) {
      this.setStatus('expired');
      return;
    }
    this.activeToken = token;
    this.beginTokenConnection(token, 'reconnecting');
  }

  openFieldMenu(): void {
    if (this.disposed || this.menuOpen) return;
    this.menuOpen = true;
    this.waitForFreshSnapshot(true, false);
  }

  closeFieldMenu(): void {
    if (this.disposed || !this.menuOpen) return;
    this.menuOpen = false;
    this.waitForFreshSnapshot(false, false);
  }

  setReducedMotion(reducedMotion: boolean): void {
    if (this.disposed) return;
    this.reducedMotion = reducedMotion;
    this.presentation.setReducedMotion(reducedMotion);
    this.netcode?.setReducedMotion(reducedMotion);
  }

  setTouchAim(direction: Vector2, firing: boolean): void {
    this.input.setTouchAim(direction, firing);
  }

  setTouchMove(direction: Vector2): void {
    this.input.setTouchMove(direction);
  }

  triggerDash(): void {
    this.input.triggerDash();
  }

  async leave(): Promise<void> {
    if (this.disposed) {
      const token = this.activeToken ?? this.readStoredToken();
      this.clearToken();
      if (token) await this.leaveDisposedSession(token);
      return;
    }
    const socket = this.socket;
    this.operation += 1;
    this.cancelAdmission();
    this.clearReconnectTimeout();
    this.input.clear();
    this.input.setEnabled(false);
    this.sendPriorityNeutral();
    this.activeToken = null;
    this.removeStoredToken();

    let invalidAcknowledgment = false;
    if (socket?.connected) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          this.clock.clearTimeout(timeout);
          resolve();
        };
        const timeout = this.clock.setTimeout(finish, LEAVE_ACK_TIMEOUT_MS);
        socket.emit(
          CLIENT_EVENTS.LEAVE,
          { protocolVersion: PROTOCOL_VERSION },
          (value: unknown) => {
            const parsed = LeaveAckSchema.safeParse(value);
            invalidAcknowledgment =
              !parsed.success || parsed.data.protocolVersion !== PROTOCOL_VERSION;
            finish();
          },
        );
      });
    }

    if (this.socket === socket) this.disconnectCurrentSocket();
    this.resetSessionState();
    if (invalidAcknowledgment) this.reportUnavailable('transport');
  }

  private async leaveDisposedSession(token: string): Promise<void> {
    const auth = HandshakeAuthSchema.safeParse({
      buildId: this.options.config.buildId,
      protocolVersion: PROTOCOL_VERSION,
      token,
    });
    if (!auth.success) return;
    const socket = this.createSocket(this.authorityUrl, {
      auth: auth.data,
      autoConnect: false,
      forceNew: true,
      path: '/ws',
      reconnection: false,
      transports: ['polling', 'websocket'],
      upgrade: true,
      withCredentials: false,
    });
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timeout);
        socket.disconnect();
        resolve();
      };
      const timeout = this.clock.setTimeout(finish, LEAVE_ACK_TIMEOUT_MS);
      socket.on('connect', () => {
        socket.emit(CLIENT_EVENTS.LEAVE, { protocolVersion: PROTOCOL_VERSION }, finish);
      });
      socket.on('connect_error', finish);
      socket.on(SERVER_EVENTS.ERROR, finish);
      socket.connect();
    });
  }

  dispose(): void {
    this.disposeRuntime();
  }

  private async beginAdmission(): Promise<void> {
    const operation = this.beginOperation();
    this.setStatus('connecting');
    const abort = new AbortController();
    this.admissionAbort = abort;
    const timeout = new Promise<never>((_resolve, reject) => {
      this.admissionTimeout = this.clock.setTimeout(() => {
        abort.abort();
        if (operation === this.operation && !this.disposed) this.failTransport();
        reject(new Error('Online admission timed out.'));
      }, ADMISSION_TIMEOUT_MS);
    });

    try {
      const response = await Promise.race([
        this.fetch(`${this.authorityUrl}/api/quickplay`, {
          body: JSON.stringify({
            buildId: this.options.config.buildId,
            protocolVersion: PROTOCOL_VERSION,
          }),
          cache: 'no-store',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
          signal: abort.signal,
        }),
        timeout,
      ]);
      const text = await response.text();
      if (
        operation !== this.operation ||
        this.disposed ||
        abort.signal.aborted ||
        utf8ByteLength(text) > MAX_QUICKPLAY_RESPONSE_BYTES
      ) {
        if (operation === this.operation && !this.disposed) {
          this.failTransport();
        }
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        this.failTransport();
        return;
      }
      const parsed = QuickplayResponseSchema.safeParse(value);
      if (!parsed.success) {
        if (response.status === 409 || response.status === 426) {
          this.failIncompatible();
        } else {
          this.failTransport();
        }
        return;
      }
      if (parsed.data.status === 'error') {
        if (
          parsed.data.buildId !== this.options.config.buildId &&
          parsed.data.code !== 'BUILD_MISMATCH'
        ) {
          this.failIncompatible();
          return;
        }
        this.handleAdmissionError(parsed.data);
        return;
      }
      if (parsed.data.buildId !== this.options.config.buildId) {
        this.failIncompatible();
        return;
      }
      if (!response.ok) {
        this.failTransport();
        return;
      }

      this.expectedAdmission = parsed.data;
      this.activeToken = parsed.data.token;
      this.storeToken(parsed.data.token);
      this.startSocketWindow(operation, parsed.data.token);
    } catch {
      if (operation === this.operation && !this.disposed) this.failTransport();
    } finally {
      if (this.admissionAbort === abort) {
        this.admissionAbort = null;
        this.clearAdmissionTimeout();
      }
    }
  }

  private beginTokenConnection(
    token: string,
    status: 'connecting' | 'reconnecting',
  ): void {
    const previousIdentity = this.identity;
    const previousTick = this.latestSnapshot?.tick ?? this.freshTickFloor;
    const operation = this.beginOperation();
    this.identity = previousIdentity;
    this.freshTickFloor = previousTick ?? null;
    this.activeToken = token;
    this.reconnectDeadline = this.clock.now() + this.reconnectWindowMs;
    this.setStatus(status);
    this.startSocketWindow(operation, token);
  }

  private startSocketWindow(operation: number, token: string): void {
    this.reconnectAttempt = 0;
    this.reconnectDeadline = this.clock.now() + this.reconnectWindowMs;
    this.emitReconnectGrace(this.clock.now());
    this.openSocket(operation, token);
  }

  private openSocket(operation: number, token: string): void {
    if (operation !== this.operation || this.disposed) return;
    const now = this.clock.now();
    const remaining = this.reconnectDeadline - now;
    if (remaining <= 0) {
      this.failTransport();
      return;
    }

    this.disconnectCurrentSocket();
    const auth = HandshakeAuthSchema.safeParse({
      buildId: this.options.config.buildId,
      protocolVersion: PROTOCOL_VERSION,
      token,
    });
    if (!auth.success) {
      this.clearToken();
      this.setStatus('expired');
      return;
    }
    const socket = this.createSocket(this.authorityUrl, {
      auth: auth.data,
      autoConnect: false,
      forceNew: true,
      path: '/ws',
      reconnection: false,
      transports: ['polling', 'websocket'],
      upgrade: true,
      withCredentials: false,
    });
    this.socket = socket;
    this.welcomeReceived = false;
    this.snapshotReady = false;
    this.connectionTimeout = this.clock.setTimeout(
      () => {
        if (this.socket !== socket || operation !== this.operation) return;
        this.handleSocketInterruption(operation, token);
      },
      Math.min(CONNECTION_TIMEOUT_MS, remaining),
    );

    socket.on(SERVER_EVENTS.WELCOME, (value) => {
      if (!this.isCurrentSocket(socket, operation)) return;
      this.handleWelcome(value, operation, token);
    });
    socket.on(SERVER_EVENTS.SNAPSHOT, (value) => {
      if (!this.isCurrentSocket(socket, operation)) return;
      this.handleSnapshot(value);
    });
    socket.on(SERVER_EVENTS.ERROR, (value) => {
      if (!this.isCurrentSocket(socket, operation)) return;
      this.handleServerErrorPayload(value, operation, token);
    });
    socket.on(SERVER_EVENTS.DRAINING, (value) => {
      if (!this.isCurrentSocket(socket, operation)) return;
      const parsed = DrainingSchema.safeParse(value);
      if (!parsed.success || parsed.data.buildId !== this.options.config.buildId) {
        if (parsed.success) this.failIncompatible();
        else this.failTransport();
        return;
      }
      this.waitForFreshSnapshot(true, true);
      this.clearReconnectTimeout();
      this.disconnectCurrentSocket();
      this.setStatus('draining');
    });
    socket.on('connect_error', (value) => {
      if (!this.isCurrentSocket(socket, operation)) return;
      const data = readErrorData(value);
      if (data !== undefined) {
        const parsed = ServerErrorSchema.safeParse(data);
        if (!parsed.success) {
          this.failTransport();
          return;
        }
        if (
          parsed.data.buildId !== this.options.config.buildId &&
          parsed.data.code !== 'BUILD_MISMATCH'
        ) {
          this.failIncompatible();
          return;
        }
        this.handleServerError(parsed.data, operation, token);
        return;
      }
      this.handleSocketInterruption(operation, token);
    });
    socket.on('disconnect', () => {
      if (!this.isCurrentSocket(socket, operation)) return;
      this.handleSocketInterruption(operation, token);
    });
    socket.connect();
  }

  private handleWelcome(value: unknown, operation: number, token: string): void {
    const parsed = WelcomeSchema.safeParse(value);
    if (!parsed.success) {
      this.failTransport();
      return;
    }
    if (!this.isCompatibleWelcome(parsed.data)) {
      this.failIncompatible();
      return;
    }
    const welcome = parsed.data;
    if (this.expectedAdmission && !matchesAdmission(welcome, this.expectedAdmission)) {
      this.failTransport();
      return;
    }
    if (
      this.identity &&
      (welcome.arenaId !== this.identity.arenaId ||
        welcome.playerId !== this.identity.playerId ||
        welcome.callsign !== this.identity.callsign)
    ) {
      this.clearToken();
      this.setStatus('expired');
      this.disconnectCurrentSocket();
      return;
    }

    this.identity = {
      arenaId: welcome.arenaId,
      callsign: welcome.callsign,
      playerId: welcome.playerId,
    };
    this.expectedAdmission = null;
    this.netcode = new OnlineNetcode({
      arenaId: welcome.arenaId,
      playerId: welcome.playerId,
      reducedMotion: this.reducedMotion,
    });
    this.welcomeReceived = true;
    this.acceptValidatedSnapshot(welcome.snapshot);
    if (this.freshTickFloor === null || welcome.snapshot.tick > this.freshTickFloor) {
      this.activateFreshSnapshot();
    }
    if (!this.snapshotReady && this.clock.now() >= this.reconnectDeadline) {
      this.handleSocketInterruption(operation, token);
    }
  }

  private handleSnapshot(value: unknown): void {
    const parsed = FullSnapshotSchema.safeParse(value);
    if (
      !parsed.success ||
      !this.welcomeReceived ||
      !this.identity ||
      parsed.data.arenaId !== this.identity.arenaId
    ) {
      this.failTransport();
      return;
    }
    if (parsed.data.buildId !== this.options.config.buildId) {
      this.failIncompatible();
      return;
    }
    const disposition = this.acceptValidatedSnapshot(parsed.data);
    if (
      disposition === 'accepted' &&
      !this.snapshotReady &&
      (this.freshTickFloor === null || parsed.data.tick > this.freshTickFloor)
    ) {
      this.activateFreshSnapshot();
    }
  }

  private acceptValidatedSnapshot(
    snapshot: FullSnapshot,
  ): 'accepted' | 'duplicate' | 'foreign' | 'stale' {
    const netcode = this.netcode;
    const identity = this.identity;
    if (!netcode || !identity) return 'foreign';
    const disposition = netcode.acceptSnapshot(this.clock.now(), snapshot);
    if (disposition !== 'accepted') return disposition;
    const previousLocalStatus = this.localPlayer()?.status;
    this.latestSnapshot = snapshot;
    const localStatus = this.localPlayer()?.status;
    if (localStatus === 'eliminated' && previousLocalStatus !== 'eliminated') {
      this.input.clear();
      this.lastFiring = false;
      this.options.onInputReset();
    }
    this.updateInputEnabled();
    this.presentation.processOnlineEvents(snapshot.events, identity.playerId);
    return disposition;
  }

  private activateFreshSnapshot(): void {
    const netcode = this.netcode;
    const identity = this.identity;
    if (!netcode || !identity) return;
    this.snapshotReady = true;
    this.freshTickFloor = null;
    this.clearConnectionTimeout();
    const now = this.clock.now();
    const frame = netcode.samplePresentation(now);
    this.presentation.syncOnline(frame);
    this.presentationActive = true;
    this.lastFrameTime = now;
    this.nextHudAt = now;
    this.nextPingAt = now + PING_INTERVAL_MS;
    this.setStatus(frame.delayed ? 'delayed' : 'connected');
    this.updateInputEnabled();
    this.emitHudSnapshot();
    this.nextHudAt = now + HUD_INTERVAL_MS;
  }

  private handleServerErrorPayload(
    value: unknown,
    operation: number,
    token: string,
  ): void {
    const parsed = ServerErrorSchema.safeParse(value);
    if (!parsed.success) {
      this.failTransport();
      return;
    }
    if (
      parsed.data.buildId !== this.options.config.buildId &&
      parsed.data.code !== 'BUILD_MISMATCH'
    ) {
      this.failIncompatible();
      return;
    }
    this.handleServerError(parsed.data, operation, token);
  }

  private handleServerError(
    error: ServerError,
    operation: number,
    token: string,
  ): void {
    switch (error.code) {
      case 'PROTOCOL_MISMATCH':
      case 'BUILD_MISMATCH':
        this.clearToken();
        this.disconnectCurrentSocket();
        this.setStatus('incompatible');
        return;
      case 'SESSION_EXPIRED':
      case 'SESSION_REPLACED':
        this.clearToken();
        this.disconnectCurrentSocket();
        this.setStatus('expired');
        return;
      case 'CAPACITY':
      case 'RATE_LIMITED':
        if (error.retryable) {
          this.handleSocketInterruption(operation, token, error.retryAfterMs);
        } else {
          this.clearToken();
          this.disconnectCurrentSocket();
          this.setStatus('capacity');
        }
        return;
      case 'SERVER_DRAINING':
        this.waitForFreshSnapshot(true, true);
        this.disconnectCurrentSocket();
        this.setStatus('draining');
        return;
      case 'SERVICE_UNAVAILABLE':
        if (error.retryable) {
          this.handleSocketInterruption(operation, token, error.retryAfterMs);
        } else {
          this.failTransport();
        }
        return;
      case 'INVALID_REQUEST':
      case 'ORIGIN_REJECTED':
      case 'INVALID_MESSAGE':
      case 'INVALID_SEQUENCE':
        this.failTransport();
        return;
    }
  }

  private handleAdmissionError(error: QuickplayError): void {
    switch (error.code) {
      case 'PROTOCOL_MISMATCH':
      case 'BUILD_MISMATCH':
        this.setStatus('incompatible');
        break;
      case 'CAPACITY':
      case 'RATE_LIMITED':
        this.setStatus('capacity');
        break;
      case 'SERVER_DRAINING':
        this.setStatus('draining');
        break;
      case 'INVALID_REQUEST':
      case 'ORIGIN_REJECTED':
      case 'SERVICE_UNAVAILABLE':
        this.reportUnavailable('transport');
        break;
    }
  }

  private handleSocketInterruption(
    operation: number,
    token: string,
    requestedDelayMs = 0,
  ): void {
    if (operation !== this.operation || this.disposed) return;
    if (this.currentStatus === 'connected' || this.currentStatus === 'delayed') {
      this.reconnectDeadline = this.clock.now() + this.reconnectWindowMs;
    }
    this.waitForFreshSnapshot(true, true);
    this.disconnectCurrentSocket();
    this.scheduleReconnect(operation, token, requestedDelayMs);
  }

  private scheduleReconnect(
    operation: number,
    token: string,
    requestedDelayMs: number,
  ): void {
    this.clearReconnectTimeout();
    const remaining = this.reconnectDeadline - this.clock.now();
    if (remaining <= 0) {
      this.failTransport();
      return;
    }
    this.setStatus('reconnecting');
    const backoff =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
      ] ??
      RECONNECT_DELAYS_MS.at(-1) ??
      0;
    this.reconnectAttempt += 1;
    const delay = Math.min(remaining, Math.max(backoff, requestedDelayMs));
    this.reconnectTimeout = this.clock.setTimeout(() => {
      this.reconnectTimeout = null;
      this.openSocket(operation, token);
    }, delay);
  }

  private waitForFreshSnapshot(sendNeutral: boolean, reconnect: boolean): void {
    const now = this.clock.now();
    const floor = this.latestSnapshot?.tick ?? this.freshTickFloor;
    this.freshTickFloor = floor ?? null;
    this.snapshotReady = false;
    this.input.clear();
    this.input.setEnabled(false);
    this.options.onInputReset();
    this.lastFiring = false;
    const neutralPacket = this.netcode?.reset(
      now,
      reconnect ? 'reconnect' : 'interruption',
    );
    if (sendNeutral && neutralPacket && this.socket?.connected) {
      this.socket.volatile.emit(CLIENT_EVENTS.INPUT, neutralPacket);
    }
    if (reconnect) {
      this.welcomeReceived = false;
      this.netcode = null;
    }
    this.presentation.resetOnline(true);
    this.presentationActive = false;
    this.lastFrameTime = now;
    this.nextHudAt = Number.POSITIVE_INFINITY;
    this.clearPendingPing();
  }

  private sendPriorityNeutral(): void {
    const socket = this.socket;
    const netcode = this.netcode;
    if (!socket?.connected || !netcode) return;
    const packet = netcode.reset(this.clock.now(), 'interruption');
    if (packet) socket.volatile.emit(CLIENT_EVENTS.INPUT, packet);
  }

  private readonly tick = (): void => {
    if (this.disposed) return;
    const now = this.clock.now();
    this.emitReconnectGrace(now);
    const deltaMs = Math.min(MAX_FRAME_MS, Math.max(0, now - this.lastFrameTime));
    this.lastFrameTime = now;
    const netcode = this.netcode;
    if (netcode && this.welcomeReceived && this.snapshotReady) {
      if (this.canControl()) {
        const control = this.input.read();
        if (control.firing && !this.lastFiring) {
          const localPlayer = netcode.samplePresentation(now).localPlayer;
          if (localPlayer) this.presentation.showLocalMuzzleFeedback(localPlayer);
        }
        this.lastFiring = control.firing;
        const advance = netcode.advance(now, control);
        for (const packet of advance.packets) this.sendGameplayInput(packet);
      } else {
        this.lastFiring = false;
      }

      const frame = netcode.samplePresentation(now);
      this.presentation.syncOnline(frame);
      this.presentationActive = true;
      if (
        this.snapshotReady &&
        (this.currentStatus === 'connected' || this.currentStatus === 'delayed')
      ) {
        this.setStatus(frame.delayed ? 'delayed' : 'connected');
      }
      if (this.snapshotReady && now >= this.nextHudAt) {
        this.emitHudSnapshot();
        this.nextHudAt = now + HUD_INTERVAL_MS;
      }
      if (this.snapshotReady && now >= this.nextPingAt) this.sendPing(now);
    } else if (this.presentationActive) {
      this.presentation.resetOnline(true);
      this.presentationActive = false;
    }
    this.presentation.render(deltaMs / 1_000, now / 1_000);
    this.animationFrame = this.animationFrames.request(this.tick);
  };

  private sendGameplayInput(packet: unknown): void {
    const socket = this.socket;
    if (!socket?.connected || !this.canControl()) return;
    socket.volatile.emit(CLIENT_EVENTS.INPUT, packet);
  }

  private sendPing(now: number): void {
    const socket = this.socket;
    if (!socket?.connected || this.pendingPingSequence !== null) return;
    this.pingSequence =
      this.pingSequence >= MAX_PING_SEQUENCE ? 1 : this.pingSequence + 1;
    const sequence = this.pingSequence;
    this.pendingPingSequence = sequence;
    this.nextPingAt = now + PING_INTERVAL_MS;
    this.pingTimeout = this.clock.setTimeout(() => {
      if (this.pendingPingSequence !== sequence) return;
      this.pendingPingSequence = null;
      this.pingTimeout = null;
      if (this.currentStatus === 'connected') this.setStatus('delayed');
    }, PING_ACK_TIMEOUT_MS);
    socket.volatile.emit(
      CLIENT_EVENTS.PING,
      { protocolVersion: PROTOCOL_VERSION, sequence },
      (value: unknown) => {
        if (this.pendingPingSequence !== sequence) return;
        this.clearPendingPing();
        const parsed = PongSchema.safeParse(value);
        if (!parsed.success || parsed.data.sequence !== sequence) this.failTransport();
      },
    );
  }

  private emitHudSnapshot(): void {
    const snapshot = this.latestSnapshot;
    const identity = this.identity;
    if (!snapshot || !identity) return;
    const local = snapshot.players.find((player) => player.id === identity.playerId);
    if (!local) {
      this.failTransport();
      return;
    }
    const roster = snapshot.players
      .map((player, index) => ({
        callsign: player.callsign,
        deaths: player.statistics.deaths,
        kills: player.statistics.kills,
        marker: this.presentation.getOnlineMarker(player.id) ?? index + 1,
        status: player.status,
        you: player.id === identity.playerId,
      }))
      .sort((first, second) => first.marker - second.marker);
    const hud: OnlineArenaHudSnapshot = {
      callsign: local.callsign,
      dashReady: clamp01(1 - local.dashCooldownTicks / FFA_DASH_COOLDOWN_TICKS),
      deaths: local.statistics.deaths,
      health: local.health,
      kills: local.statistics.kills,
      marker: this.presentation.getOnlineMarker(local.id) ?? 1,
      population: snapshot.players.length,
      respawnSeconds: Math.ceil(local.respawnTicks / SIMULATION_RATE_HZ),
      roster,
      status: local.status,
    };
    this.options.onHudSnapshot(hud);
  }

  private canControl(): boolean {
    return (
      this.snapshotReady &&
      this.welcomeReceived &&
      this.socket?.connected === true &&
      this.localPlayer()?.status === 'alive' &&
      !this.menuOpen &&
      !this.browserInterrupted &&
      !this.disposed
    );
  }

  private updateInputEnabled(): void {
    this.input.setEnabled(this.canControl());
  }

  private beginOperation(): number {
    this.operation += 1;
    this.cancelAdmission();
    this.clearReconnectTimeout();
    this.disconnectCurrentSocket();
    this.resetSessionState();
    this.unavailableReported = false;
    return this.operation;
  }

  private resetSessionState(): void {
    this.input.clear();
    this.input.setEnabled(false);
    this.netcode = null;
    this.latestSnapshot = null;
    this.expectedAdmission = null;
    this.identity = null;
    this.freshTickFloor = null;
    this.snapshotReady = false;
    this.welcomeReceived = false;
    this.lastFiring = false;
    this.nextHudAt = Number.POSITIVE_INFINITY;
    this.nextPingAt = Number.POSITIVE_INFINITY;
    this.clearPendingPing();
    this.presentation.resetOnline();
    this.presentationActive = false;
  }

  private failTransport(): void {
    if (this.disposed) return;
    this.waitForFreshSnapshot(true, true);
    this.clearReconnectTimeout();
    this.disconnectCurrentSocket();
    this.reportUnavailable('transport');
  }

  private failIncompatible(): void {
    if (this.disposed) return;
    this.waitForFreshSnapshot(true, true);
    this.clearReconnectTimeout();
    this.disconnectCurrentSocket();
    this.clearToken();
    this.setStatus('incompatible');
  }

  private reportUnavailable(reason: OnlineArenaUnavailableReason): void {
    this.setStatus('unavailable');
    if (this.unavailableReported) return;
    this.unavailableReported = true;
    this.options.onUnavailable(reason);
  }

  private setStatus(status: OnlineArenaStatus): void {
    if (this.disposed || this.currentStatus === status) return;
    this.currentStatus = status;
    this.options.onStatus(status);
    this.emitReconnectGrace(this.clock.now());
  }

  private emitReconnectGrace(now: number): void {
    const remainingSeconds =
      this.currentStatus === 'reconnecting'
        ? Math.max(0, Math.ceil((this.reconnectDeadline - now) / 1_000))
        : null;
    if (remainingSeconds === this.lastReconnectGraceSeconds) return;
    this.lastReconnectGraceSeconds = remainingSeconds;
    this.options.onReconnectGraceChanged(remainingSeconds);
  }

  private localPlayer(): SnapshotPlayer | undefined {
    const identity = this.identity;
    return identity
      ? this.latestSnapshot?.players.find((player) => player.id === identity.playerId)
      : undefined;
  }

  private isCompatibleWelcome(welcome: Welcome): boolean {
    return (
      welcome.buildId === this.options.config.buildId &&
      welcome.snapshot.buildId === this.options.config.buildId &&
      welcome.protocolVersion === PROTOCOL_VERSION
    );
  }

  private isCurrentSocket(socket: OnlineRuntimeSocket, operation: number): boolean {
    return !this.disposed && this.socket === socket && this.operation === operation;
  }

  private disconnectCurrentSocket(): void {
    this.clearConnectionTimeout();
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.disconnect();
  }

  private cancelAdmission(): void {
    this.admissionAbort?.abort();
    this.admissionAbort = null;
    this.clearAdmissionTimeout();
  }

  private clearAdmissionTimeout(): void {
    if (this.admissionTimeout === null) return;
    this.clock.clearTimeout(this.admissionTimeout);
    this.admissionTimeout = null;
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeout === null) return;
    this.clock.clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout === null) return;
    this.clock.clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = null;
  }

  private clearPendingPing(): void {
    if (this.pingTimeout !== null) this.clock.clearTimeout(this.pingTimeout);
    this.pingTimeout = null;
    this.pendingPingSequence = null;
  }

  private readStoredToken(): string | null {
    if (!this.storage) return null;
    try {
      const token = this.storage.getItem(SESSION_STORAGE_KEY);
      if (!token) return null;
      if (SessionTokenSchema.safeParse(token).success) return token;
      this.storage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
    return null;
  }

  private storeToken(token: string): void {
    try {
      this.storage?.setItem(SESSION_STORAGE_KEY, token);
    } catch {
      // In-memory reconnect remains available when sessionStorage is blocked.
    }
  }

  private removeStoredToken(): void {
    try {
      this.storage?.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Explicit leave still clears the in-memory credential and transport.
    }
  }

  private clearToken(): void {
    this.activeToken = null;
    this.removeStoredToken();
  }

  private readonly handleMenuRequested = (): void => {
    if (this.disposed) return;
    this.openFieldMenu();
    this.options.onFieldMenuRequested();
  };

  private readonly handleBrowserInterruption = (): void => {
    if (this.disposed || this.browserInterrupted) return;
    this.browserInterrupted = true;
    this.waitForFreshSnapshot(true, false);
  };

  private readonly handleBrowserReturn = (): void => {
    if (
      this.disposed ||
      !this.browserInterrupted ||
      document.visibilityState === 'hidden'
    ) {
      return;
    }
    this.browserInterrupted = false;
    this.waitForFreshSnapshot(false, false);
  };

  private readonly handleVisibilityReturn = (): void => {
    if (document.visibilityState !== 'hidden') this.handleBrowserReturn();
  };

  private readonly handleContextLost = (): void => {
    if (this.disposed) return;
    this.sendPriorityNeutral();
    this.options.onInputReset();
    this.setStatus('unavailable');
    this.options.onUnavailable('renderer');
    this.disposeRuntime();
  };

  private disposeRuntime(): void {
    if (this.disposed) return;
    this.input.clear();
    this.sendPriorityNeutral();
    this.disposed = true;
    this.operation += 1;
    this.cancelAdmission();
    this.clearReconnectTimeout();
    this.clearPendingPing();
    this.disconnectCurrentSocket();
    if (this.animationFrame !== null) {
      this.animationFrames.cancel(this.animationFrame);
      this.animationFrame = null;
    }
    globalThis.removeEventListener('focus', this.handleBrowserReturn);
    document.removeEventListener('visibilitychange', this.handleVisibilityReturn);
    this.input.dispose();
    this.presentation.dispose();
  }
}

const browserClock: OnlineRuntimeClock = {
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
};

const browserAnimationFrames: OnlineRuntimeAnimationFrames = {
  cancel: (handle) => cancelAnimationFrame(handle as number),
  request: (callback) => requestAnimationFrame(callback),
};

const browserFetch: OnlineRuntimeFetch = (input, init) => fetch(input, init);

const browserSocketFactory: NonNullable<
  OnlineArenaRuntimeDependencies['createSocket']
> = (authorityUrl, options) =>
  createSocketIoClient(authorityUrl, options) as unknown as OnlineRuntimeSocket;

function readBrowserSessionStorage(): OnlineRuntimeStorage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function normalizeAuthorityUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('Online arena authority URL is invalid.');
  }
  return url.origin;
}

function matchesAdmission(welcome: Welcome, admission: QuickplaySuccess): boolean {
  return (
    welcome.arenaId === admission.arenaId &&
    welcome.buildId === admission.buildId &&
    welcome.callsign === admission.callsign &&
    welcome.playerId === admission.playerId
  );
}

function readErrorData(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'data' in value
    ? value.data
    : undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
