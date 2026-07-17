import {
  DASH_COOLDOWN_SECONDS,
  FIXED_STEP_SECONDS,
  createArenaState,
  stepArena,
  type ArenaInput,
  type ArenaState,
  type Vector2,
} from '@dropzone-arena/arena-engine';

import { ArenaInputController } from './arena-input-controller';
import type {
  ArenaHudSnapshot,
  ArenaRuntimeDriver,
  ArenaRuntimeDriverOptions,
} from './arena-runtime-driver';
import { ThreeArenaPresentation } from './three-arena-presentation';

const MAX_FRAME_SECONDS = 0.1;
const MAX_CATCH_UP_STEPS = 5;
const HUD_INTERVAL_SECONDS = 0.1;

export function createArenaRuntimeDriver(
  options: ArenaRuntimeDriverOptions,
): ArenaRuntimeDriver {
  return new ThreeArenaRuntime(options);
}

class ThreeArenaRuntime implements ArenaRuntimeDriver {
  private readonly input: ArenaInputController;
  private readonly presentation: ThreeArenaPresentation;
  private animationFrame = 0;
  private state: ArenaState | null = null;
  private playing = false;
  private disposed = false;
  private unavailable = false;
  private accumulator = 0;
  private hudAccumulator = 0;
  private lastFrameTime = 0;

  constructor(private readonly options: ArenaRuntimeDriverOptions) {
    let presentation: ThreeArenaPresentation | null = null;
    let input: ArenaInputController | null = null;
    try {
      const createdPresentation = new ThreeArenaPresentation({
        host: options.host,
        onContextLost: this.handleContextLost,
        reducedMotion: options.reducedMotion,
      });
      presentation = createdPresentation;
      input = new ArenaInputController({
        element: createdPresentation.canvas,
        getAimOrigin: () => this.state?.player.position ?? null,
        onInterruption: this.handleInterruption,
        onMenuRequested: this.handleMenuRequested,
        projectPointerAim: (clientX, clientY, origin, fallback) =>
          createdPresentation.projectPointerAim(clientX, clientY, origin, fallback),
      });
      this.presentation = createdPresentation;
      this.input = input;
      this.lastFrameTime = performance.now();
      this.animationFrame = requestAnimationFrame(this.tick);
    } catch (error) {
      input?.dispose();
      presentation?.dispose();
      throw error;
    }
  }

  start(seed: number): void {
    if (this.disposed) return;
    this.presentation.resetLocal();
    this.state = createArenaState(seed);
    this.playing = true;
    this.accumulator = 0;
    this.hudAccumulator = 0;
    this.lastFrameTime = performance.now();
    this.input.clear();
    this.input.setEnabled(true);
    this.presentation.syncLocal(this.state);
    this.options.onSnapshot(toHudSnapshot(this.state));
  }

  pause(): void {
    if (this.disposed || !this.playing) return;
    this.playing = false;
    this.accumulator = 0;
    this.input.setEnabled(false);
  }

  resume(): void {
    if (this.disposed || !this.state || this.state.status !== 'playing') return;
    this.playing = true;
    this.accumulator = 0;
    this.lastFrameTime = performance.now();
    this.input.setEnabled(true);
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.presentation.setReducedMotion(reducedMotion);
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.playing = false;
    cancelAnimationFrame(this.animationFrame);
    this.input.dispose();
    this.presentation.dispose();
  }

  private readonly tick = (time: number): void => {
    if (this.disposed) return;
    const frameSeconds = Math.min(
      MAX_FRAME_SECONDS,
      Math.max(0, (time - this.lastFrameTime) / 1_000),
    );
    this.lastFrameTime = time;

    if (this.playing && this.state) {
      this.accumulator = Math.min(
        this.accumulator + frameSeconds,
        FIXED_STEP_SECONDS * MAX_CATCH_UP_STEPS,
      );
      let steps = 0;
      while (
        this.accumulator >= FIXED_STEP_SECONDS &&
        steps < MAX_CATCH_UP_STEPS &&
        this.state.status === 'playing'
      ) {
        const input: ArenaInput = this.input.read();
        this.state = stepArena(this.state, input, FIXED_STEP_SECONDS);
        this.presentation.processLocalEvents(this.state.events);
        this.accumulator -= FIXED_STEP_SECONDS;
        steps += 1;
      }

      this.hudAccumulator += frameSeconds;
      if (this.hudAccumulator >= HUD_INTERVAL_SECONDS) {
        this.hudAccumulator %= HUD_INTERVAL_SECONDS;
        this.options.onSnapshot(toHudSnapshot(this.state));
      }

      if (this.state.status !== 'playing') {
        this.playing = false;
        this.input.setEnabled(false);
        const snapshot = toHudSnapshot(this.state);
        this.options.onSnapshot(snapshot);
        this.options.onRunEnded(snapshot);
      }
    }

    if (this.state) this.presentation.syncLocal(this.state);
    this.presentation.render(frameSeconds, time / 1_000);
    this.animationFrame = requestAnimationFrame(this.tick);
  };

  private readonly handleInterruption = (): void => {
    if (this.playing) this.requestPause();
  };

  private readonly handleMenuRequested = (): void => {
    if (this.playing) this.requestPause();
  };

  private readonly handleContextLost = (): void => {
    if (this.unavailable || this.disposed) return;
    this.unavailable = true;
    this.dispose();
    this.options.onUnavailable();
  };

  private requestPause(): void {
    this.pause();
    this.options.onPauseRequested();
  }
}

function toHudSnapshot(state: ArenaState): ArenaHudSnapshot {
  return {
    combo: state.combo,
    dashReady: clamp01(1 - state.player.dashCooldown / DASH_COOLDOWN_SECONDS),
    enemyCount: state.enemies.length,
    health: state.player.health,
    overdriveTime: state.player.overdriveTime,
    score: state.score,
    stats: { ...state.stats },
    status: state.status,
    timeRemaining: state.timeRemaining,
    wave: state.wave,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
