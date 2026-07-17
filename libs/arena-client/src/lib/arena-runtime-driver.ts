import type { ArenaStats, ArenaStatus, Vector2 } from '@dropzone-arena/arena-engine';

export interface ArenaHudSnapshot {
  combo: number;
  dashReady: number;
  enemyCount: number;
  health: number;
  overdriveTime: number;
  score: number;
  stats: ArenaStats;
  status: ArenaStatus;
  timeRemaining: number;
  wave: number;
}

export interface ArenaRuntimeDriverOptions {
  host: HTMLElement;
  onPauseRequested(): void;
  onRunEnded(snapshot: ArenaHudSnapshot): void;
  onSnapshot(snapshot: ArenaHudSnapshot): void;
  onUnavailable(): void;
  reducedMotion: boolean;
}

export interface ArenaRuntimeDriver {
  dispose(): void;
  pause(): void;
  resume(): void;
  setReducedMotion(reducedMotion: boolean): void;
  setTouchAim(direction: Vector2, firing: boolean): void;
  setTouchMove(direction: Vector2): void;
  start(seed: number): void;
  triggerDash(): void;
}

export type ArenaRuntimeDriverFactory = (
  options: ArenaRuntimeDriverOptions,
) => ArenaRuntimeDriver | Promise<ArenaRuntimeDriver>;

export const defaultArenaRuntimeDriverFactory: ArenaRuntimeDriverFactory = async (
  options,
) => {
  const runtime = await import('./arena-runtime');
  return runtime.createArenaRuntimeDriver(options);
};
