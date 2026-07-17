import { describe, expect, it } from 'vitest';

import {
  ARENA_HALF_SIZE,
  FIXED_STEP_SECONDS,
  RUN_DURATION_SECONDS,
  createArenaState,
  stepArena,
  type ArenaInput,
  type ArenaState,
} from './arena';

const IDLE_INPUT: ArenaInput = {
  aim: { x: 0, y: -1 },
  dash: false,
  firing: false,
  move: { x: 0, y: 0 },
};

describe('arena simulation', () => {
  it('is repeatable for the same seed and input sequence', () => {
    const inputs = Array.from(
      { length: 240 },
      (_, index): ArenaInput => ({
        aim: { x: 1, y: index % 60 < 30 ? 0.25 : -0.25 },
        dash: index === 30,
        firing: index > 10,
        move: { x: index < 120 ? 1 : -0.5, y: 0.4 },
      }),
    );

    const run = (): ArenaState =>
      inputs.reduce(
        (state, input) => stepArena(state, input, FIXED_STEP_SECONDS),
        createArenaState(42),
      );

    expect(run()).toEqual(run());
  });

  it('moves the player while keeping them inside the arena', () => {
    let state = createArenaState(7);
    for (let index = 0; index < 600; index += 1) {
      state = stepArena(state, { ...IDLE_INPUT, move: { x: 1, y: 1 } });
    }

    expect(Math.abs(state.player.position.x)).toBeLessThan(ARENA_HALF_SIZE);
    expect(Math.abs(state.player.position.y)).toBeLessThan(ARENA_HALF_SIZE);
    expect(state.player.position.x).toBeGreaterThan(0);
  });

  it('fires at a bounded cadence and records shots', () => {
    let state = createArenaState(11);
    for (let index = 0; index < 60; index += 1) {
      state = stepArena(state, { ...IDLE_INPUT, firing: true });
    }

    expect(state.stats.shots).toBeGreaterThanOrEqual(7);
    expect(state.stats.shots).toBeLessThanOrEqual(9);
    expect(state.projectiles.every((projectile) => projectile.owner === 'player')).toBe(
      true,
    );
  });

  it('grants a bounded dash with immediate invulnerability', () => {
    const initial = createArenaState(13);
    const dashed = stepArena(initial, {
      ...IDLE_INPUT,
      dash: true,
      move: { x: 1, y: 0 },
    });

    expect(dashed.player.position.x).toBeGreaterThan(initial.player.position.x);
    expect(dashed.player.dashCooldown).toBeGreaterThan(2);
    expect(dashed.player.invulnerableTime).toBeGreaterThan(0);
    expect(dashed.events).toContainEqual(expect.objectContaining({ type: 'dash' }));
  });

  it('awards a successful extraction when the run clock expires', () => {
    const initial = createArenaState(17);
    const almostFinished: ArenaState = {
      ...initial,
      elapsed: RUN_DURATION_SECONDS - FIXED_STEP_SECONDS / 2,
      enemies: [],
      spawnTimer: 10,
      timeRemaining: FIXED_STEP_SECONDS / 2,
    };
    const finished = stepArena(almostFinished, IDLE_INPUT);

    expect(finished.status).toBe('extracted');
    expect(finished.timeRemaining).toBe(0);
    expect(finished.score).toBeGreaterThanOrEqual(2_000);
  });

  it('does not mutate the caller state', () => {
    const initial = createArenaState(19);
    const snapshot = structuredClone(initial);
    stepArena(initial, { ...IDLE_INPUT, firing: true });
    expect(initial).toEqual(snapshot);
  });
});
