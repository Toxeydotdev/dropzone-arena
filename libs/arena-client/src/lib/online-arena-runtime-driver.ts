import type { Vector2 } from '@dropzone-arena/arena-engine';

export type OnlineArenaStatus =
  | 'connecting'
  | 'connected'
  | 'delayed'
  | 'reconnecting'
  | 'draining'
  | 'expired'
  | 'incompatible'
  | 'capacity'
  | 'unavailable';

export type OnlineArenaUnavailableReason = 'renderer' | 'transport';

export interface EnabledOnlineArenaConfig {
  authorityUrl: string;
  buildId: string;
  enabled: true;
  reconnectWindowMs?: number;
}

export interface DisabledOnlineArenaConfig {
  enabled: false;
  reason: string;
}

export type OnlineArenaConfig = DisabledOnlineArenaConfig | EnabledOnlineArenaConfig;

export interface OnlineArenaRosterEntry {
  callsign: string;
  deaths: number;
  kills: number;
  marker: number;
  status: 'alive' | 'eliminated';
  you: boolean;
}

export interface OnlineArenaHudSnapshot {
  callsign: string;
  dashReady: number;
  deaths: number;
  health: number;
  kills: number;
  marker: number;
  population: number;
  respawnSeconds: number;
  roster: readonly OnlineArenaRosterEntry[];
  status: 'alive' | 'eliminated';
}

export interface OnlineArenaRuntimeDriverOptions {
  config: EnabledOnlineArenaConfig;
  host: HTMLElement;
  onFieldMenuRequested(): void;
  onHudSnapshot(snapshot: OnlineArenaHudSnapshot): void;
  onInputReset(): void;
  onReconnectGraceChanged(remainingSeconds: number | null): void;
  onStatus(status: OnlineArenaStatus): void;
  onUnavailable(reason: OnlineArenaUnavailableReason): void;
  reducedMotion: boolean;
}

export interface OnlineArenaRuntimeDriver {
  closeFieldMenu(): void;
  dispose(): void;
  leave(): Promise<void>;
  openFieldMenu(): void;
  resumeSession(): Promise<void>;
  setReducedMotion(reducedMotion: boolean): void;
  setTouchAim(direction: Vector2, firing: boolean): void;
  setTouchMove(direction: Vector2): void;
  startFreshQuickplay(): Promise<void>;
  startQuickplay(): Promise<void>;
  triggerDash(): void;
}

export type OnlineArenaRuntimeDriverFactory = (
  options: OnlineArenaRuntimeDriverOptions,
) => OnlineArenaRuntimeDriver | Promise<OnlineArenaRuntimeDriver>;

interface OnlineArenaRuntimeModule {
  createOnlineArenaRuntimeDriver(
    options: OnlineArenaRuntimeDriverOptions,
  ): OnlineArenaRuntimeDriver;
}

type OnlineArenaRuntimeModuleLoader = () => Promise<OnlineArenaRuntimeModule>;

export function createLazyOnlineArenaRuntimeDriverFactory(
  loadRuntime: OnlineArenaRuntimeModuleLoader,
): OnlineArenaRuntimeDriverFactory {
  return async (options) => {
    const runtime = await loadRuntime();
    return runtime.createOnlineArenaRuntimeDriver(options);
  };
}

export const defaultOnlineArenaRuntimeDriverFactory =
  createLazyOnlineArenaRuntimeDriverFactory(() => import('./online-arena-runtime'));
