import { describe, expect, it } from 'vitest';

import { ARENA_HALF_SIZE, ARENA_OBSTACLES, type Vector2 } from './arena';
import {
  FFA_COLLISION_WORLD,
  FFA_DASH_COOLDOWN_TICKS,
  FFA_DASH_DURATION_TICKS,
  FFA_FIRE_INTERVAL_TICKS,
  FFA_FIXED_STEP_SECONDS,
  FFA_MAX_PLAYERS,
  FFA_MAX_PROJECTILES,
  FFA_PLAYER_MAX_HEALTH,
  FFA_RESPAWN_TICKS,
  FFA_SPAWN_PROTECTION_TICKS,
  createFfaArenaState,
  joinFfaPlayer,
  leaveFfaPlayer,
  stepFfaArena,
  stepFfaPlayerMotion,
  type FfaArenaState,
  type FfaInput,
  type FfaPlayerState,
  type FfaProjectileState,
} from './ffa-arena';

const IDLE_INPUT: FfaInput = {
  aim: { x: 0, y: -1 },
  dash: false,
  firing: false,
  move: { x: 0, y: 0 },
};

const FIRE_RIGHT_INPUT: FfaInput = {
  ...IDLE_INPUT,
  aim: { x: 1, y: 0 },
  firing: true,
};

describe('FFA arena simulation', () => {
  it('is seeded, serializable, and repeatable across lifecycle and input sequences', () => {
    const run = (): FfaArenaState => {
      let state = createFfaArenaState(0x12_34_56_78);
      state = joinFfaPlayer(state, 'alpha', 'ALPHA-1');
      state = joinFfaPlayer(state, 'bravo', 'BRAVO-2');

      for (let tick = 0; tick < 360; tick += 1) {
        if (tick === 120) state = leaveFfaPlayer(state, 'bravo');
        if (tick === 180) state = joinFfaPlayer(state, 'charlie', 'CHARLIE-3');
        state = stepFfaArena(state, {
          alpha: {
            aim: { x: 1, y: tick % 80 < 40 ? 0.35 : -0.35 },
            dash: tick === 20 || tick === 190,
            firing: tick % 3 !== 0,
            move: { x: tick < 210 ? 0.8 : -0.6, y: 0.3 },
          },
          charlie: {
            aim: { x: -1, y: 0.2 },
            dash: tick === 240,
            firing: tick > 220,
            move: { x: -0.4, y: -0.7 },
          },
        });
      }
      return state;
    };

    const first = run();
    const second = run();
    expect(first).toEqual(second);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(first.tick).toBe(360);
  });

  it('preserves lifecycle order and enforces the hard eight-player limit', () => {
    const initial = createFfaArenaState(41);
    let state = initial;
    for (let index = 0; index < FFA_MAX_PLAYERS; index += 1) {
      state = joinFfaPlayer(state, `player-${index}`, `UNIT-${index}`);
    }

    expect(state.players.map((player) => player.id)).toEqual([
      'player-0',
      'player-1',
      'player-2',
      'player-3',
      'player-4',
      'player-5',
      'player-6',
      'player-7',
    ]);
    const full = joinFfaPlayer(state, 'player-8', 'UNIT-8');
    const duplicate = joinFfaPlayer(state, 'player-3', 'REPLACED');
    expect(full.players).toEqual(state.players);
    expect(full.events).toEqual([]);
    expect(duplicate.players).toEqual(state.players);

    state = {
      ...state,
      projectiles: [projectile(1, 'player-3', { x: 0, y: 0 })],
    };
    const left = leaveFfaPlayer(state, 'player-3');
    expect(left.players.map((player) => player.id)).toEqual([
      'player-0',
      'player-1',
      'player-2',
      'player-4',
      'player-5',
      'player-6',
      'player-7',
    ]);
    expect(left.projectiles).toEqual([]);
    expect(left.events).toEqual([
      { playerId: 'player-3', tick: 0, type: 'player-left' },
    ]);
    const replacement = joinFfaPlayer(left, 'player-8', 'UNIT-8');
    expect(replacement.players.at(-1)?.id).toBe('player-8');
    expect(initial.players).toEqual([]);
  });

  it('processes players in roster order regardless of input record insertion order', () => {
    let state = createFfaArenaState(43);
    state = joinFfaPlayer(state, 'alpha', 'ALPHA');
    state = joinFfaPlayer(state, 'bravo', 'BRAVO');
    state = updatePlayer(state, 'alpha', {
      position: { x: -8, y: 0 },
      spawnProtectionTicks: 0,
    });
    state = updatePlayer(state, 'bravo', {
      position: { x: 8, y: 0 },
      spawnProtectionTicks: 0,
    });

    const reverseInputOrder = stepFfaArena(state, {
      bravo: { ...FIRE_RIGHT_INPUT, aim: { x: -1, y: 0 } },
      alpha: FIRE_RIGHT_INPUT,
    });
    const forwardInputOrder = stepFfaArena(state, {
      alpha: FIRE_RIGHT_INPUT,
      bravo: { ...FIRE_RIGHT_INPUT, aim: { x: -1, y: 0 } },
    });

    expect(reverseInputOrder).toEqual(forwardInputOrder);
    expect(
      reverseInputOrder.events
        .filter((event) => event.type === 'shot')
        .map((event) => event.ownerId),
    ).toEqual(['alpha', 'bravo']);
    expect(reverseInputOrder.projectiles.map((shot) => shot.id)).toEqual([1, 2]);
  });

  it('shares pure normalized movement and dash behavior with authority stepping', () => {
    let state = joinFfaPlayer(createFfaArenaState(47), 'alpha', 'ALPHA');
    state = updatePlayer(state, 'alpha', {
      position: { x: 0, y: 0 },
      spawnProtectionTicks: 0,
      velocity: { x: 0, y: 0 },
    });
    const player = getPlayer(state, 'alpha');
    const input: FfaInput = {
      aim: { x: 4, y: 0 },
      dash: false,
      firing: false,
      move: { x: 1, y: 1 },
    };
    const predicted = stepFfaPlayerMotion(player, input);
    const authoritative = getPlayer(stepFfaArena(state, { alpha: input }), 'alpha');

    expect(authoritative).toEqual(predicted);
    expect(predicted.position.x).toBeGreaterThan(0);
    expect(predicted.position.y).toBeGreaterThan(0);
    expect(predicted.aim).toEqual({ x: 1, y: 0 });
    expect(Math.hypot(predicted.velocity.x, predicted.velocity.y)).toBeLessThanOrEqual(
      6.2,
    );
    expect(player.position).toEqual({ x: 0, y: 0 });

    const dashed = stepFfaPlayerMotion(player, {
      ...IDLE_INPUT,
      aim: { x: 0, y: 1 },
      dash: true,
      move: { x: 1, y: 0 },
    });
    expect(dashed.position.x).toBeCloseTo(16 * FFA_FIXED_STEP_SECONDS);
    expect(dashed.dashCooldownTicks).toBe(FFA_DASH_COOLDOWN_TICKS);
    expect(dashed.dashTicks).toBe(FFA_DASH_DURATION_TICKS);
    expect(() =>
      stepFfaPlayerMotion(player, input, FFA_COLLISION_WORLD, 1 / 30),
    ).toThrow(/fixed 1\/60/);
    expect(() => stepFfaArena(state, { alpha: input }, 1 / 30)).toThrow(/fixed 1\/60/);
  });

  it('resolves arena boundaries and obstacles without player body collision', () => {
    let state = createFfaArenaState(53);
    state = joinFfaPlayer(state, 'alpha', 'ALPHA');
    state = joinFfaPlayer(state, 'bravo', 'BRAVO');
    const radius = getPlayer(state, 'alpha').radius;

    const boundaryPlayer = updatePlayer(state, 'alpha', {
      position: { x: ARENA_HALF_SIZE - radius - 0.01, y: 9 },
      spawnProtectionTicks: 0,
      velocity: { x: 0, y: 0 },
    });
    const bounded = stepFfaPlayerMotion(getPlayer(boundaryPlayer, 'alpha'), {
      ...IDLE_INPUT,
      dash: true,
      move: { x: 1, y: 0 },
    });
    expect(bounded.position.x).toBeLessThanOrEqual(ARENA_HALF_SIZE - radius);

    const obstacle = ARENA_OBSTACLES[0];
    if (!obstacle) throw new Error('Expected the fixed arena obstacle');
    const obstaclePlayer = updatePlayer(state, 'alpha', {
      position: {
        x: obstacle.x - obstacle.halfWidth - radius - 0.01,
        y: obstacle.y,
      },
      spawnProtectionTicks: 0,
      velocity: { x: 0, y: 0 },
    });
    const blocked = stepFfaPlayerMotion(getPlayer(obstaclePlayer, 'alpha'), {
      ...IDLE_INPUT,
      dash: true,
      move: { x: 1, y: 0 },
    });
    expect(blocked.position.x).toBeCloseTo(obstacle.x - obstacle.halfWidth - radius);
    expect(circlePenetratesObstacle(blocked.position, radius, obstacle)).toBe(false);

    state = updatePlayer(state, 'alpha', {
      position: { x: 0, y: 0 },
      spawnProtectionTicks: 0,
      velocity: { x: 0, y: 0 },
    });
    state = updatePlayer(state, 'bravo', {
      position: { x: 0, y: 0 },
      spawnProtectionTicks: 0,
      velocity: { x: 0, y: 0 },
    });
    const overlapped = stepFfaArena(state, {});
    expect(getPlayer(overlapped, 'alpha').position).toEqual({ x: 0, y: 0 });
    expect(getPlayer(overlapped, 'bravo').position).toEqual({ x: 0, y: 0 });
  });

  it('fires at deterministic cadence and never exceeds 96 projectiles', () => {
    let state = joinFfaPlayer(createFfaArenaState(59), 'alpha', 'ALPHA');
    state = updatePlayer(state, 'alpha', {
      position: { x: 0, y: 0 },
      spawnProtectionTicks: 0,
    });
    for (let tick = 0; tick < 60; tick += 1) {
      state = stepFfaArena(state, { alpha: FIRE_RIGHT_INPUT });
    }

    expect(state.nextProjectileId - 1).toBe(Math.ceil(60 / FFA_FIRE_INTERVAL_TICKS));
    expect(state.projectiles.every((shot) => shot.ownerId === 'alpha')).toBe(true);

    state = {
      ...state,
      nextProjectileId: FFA_MAX_PROJECTILES + 1,
      players: state.players.map((player) => ({ ...player, fireCooldownTicks: 0 })),
      projectiles: Array.from({ length: FFA_MAX_PROJECTILES }, (_, index) =>
        projectile(index + 1, 'alpha', { x: 11, y: 11 }, { ttlTicks: 100 }),
      ),
    };
    const capped = stepFfaArena(state, { alpha: FIRE_RIGHT_INPUT });
    expect(capped.projectiles).toHaveLength(FFA_MAX_PROJECTILES);
    expect(capped.nextProjectileId).toBe(FFA_MAX_PROJECTILES + 1);

    const expiring = {
      ...capped,
      projectiles: capped.projectiles.map((shot, index) =>
        index === 0 ? { ...shot, ttlTicks: 1 } : shot,
      ),
    };
    const slotOpened = stepFfaArena(expiring, { alpha: FIRE_RIGHT_INPUT });
    expect(slotOpened.projectiles).toHaveLength(FFA_MAX_PROJECTILES - 1);
    const refilled = stepFfaArena(slotOpened, { alpha: FIRE_RIGHT_INPUT });
    expect(refilled.projectiles).toHaveLength(FFA_MAX_PROJECTILES);
    expect(refilled.nextProjectileId).toBe(FFA_MAX_PROJECTILES + 2);
  });

  it('removes obstacle shots while allowing owner-safe projectiles to pass the owner', () => {
    let state = joinFfaPlayer(createFfaArenaState(61), 'alpha', 'ALPHA');
    state = updatePlayer(state, 'alpha', {
      health: FFA_PLAYER_MAX_HEALTH,
      position: { x: 0, y: 0 },
      spawnProtectionTicks: 0,
    });
    state = {
      ...state,
      nextProjectileId: 2,
      projectiles: [projectile(1, 'alpha', { x: 0, y: 0 })],
    };
    const ownerCollision = stepFfaArena(state, {});
    expect(getPlayer(ownerCollision, 'alpha').health).toBe(FFA_PLAYER_MAX_HEALTH);
    expect(ownerCollision.projectiles).toHaveLength(1);

    const obstacle = ARENA_OBSTACLES[0];
    if (!obstacle) throw new Error('Expected the fixed arena obstacle');
    const obstacleShot = {
      ...ownerCollision,
      projectiles: [
        projectile(
          2,
          'alpha',
          {
            x: obstacle.x - obstacle.halfWidth - 0.12 - 0.05,
            y: obstacle.y,
          },
          { velocity: { x: 17, y: 0 } },
        ),
      ],
    };
    expect(stepFfaArena(obstacleShot, {}).projectiles).toEqual([]);
  });

  it('attributes lethal damage, kills, and deaths exactly once to the final owner', () => {
    let state = createFfaArenaState(67);
    state = joinFfaPlayer(state, 'alpha', 'ALPHA');
    state = joinFfaPlayer(state, 'bravo', 'BRAVO');
    state = joinFfaPlayer(state, 'victim', 'VICTIM');
    state = updatePlayer(state, 'alpha', {
      position: { x: -8, y: -4 },
      spawnProtectionTicks: 0,
    });
    state = updatePlayer(state, 'bravo', {
      position: { x: -8, y: 4 },
      spawnProtectionTicks: 0,
    });
    state = updatePlayer(state, 'victim', {
      position: { x: 8, y: 0 },
      spawnProtectionTicks: 0,
    });
    state = {
      ...state,
      nextProjectileId: 6,
      projectiles: [
        projectile(1, 'alpha', { x: 8, y: 0 }),
        projectile(2, 'alpha', { x: 8, y: 0 }),
        projectile(3, 'alpha', { x: 8, y: 0 }),
        projectile(4, 'bravo', { x: 8, y: 0 }),
        projectile(5, 'alpha', { x: 8, y: 0 }),
      ],
    };

    const eliminated = stepFfaArena(state, {});
    expect(getPlayer(eliminated, 'victim')).toMatchObject({
      health: 0,
      respawnTicks: FFA_RESPAWN_TICKS,
      statistics: { deaths: 1, kills: 0 },
      status: 'eliminated',
    });
    expect(getPlayer(eliminated, 'alpha').statistics.kills).toBe(0);
    expect(getPlayer(eliminated, 'bravo').statistics.kills).toBe(1);
    expect(eliminated.events.filter((event) => event.type === 'hit')).toHaveLength(4);
    expect(
      eliminated.events.filter((event) => event.type === 'player-eliminated'),
    ).toEqual([
      expect.objectContaining({
        killerId: 'bravo',
        projectileId: 4,
        victimId: 'victim',
      }),
    ]);
    expect(eliminated.projectiles.map((shot) => shot.id)).toEqual([5]);

    const stillEliminated = stepFfaArena(eliminated, {});
    expect(getPlayer(stillEliminated, 'victim').statistics.deaths).toBe(1);
    expect(getPlayer(stillEliminated, 'bravo').statistics.kills).toBe(1);
    expect(
      stillEliminated.events.filter((event) => event.type === 'player-eliminated'),
    ).toEqual([]);
  });

  it('selects repeatable safe spawns away from geometry, players, and damaging paths', () => {
    const populate = (): FfaArenaState => {
      let state = createFfaArenaState(71);
      for (let index = 0; index < FFA_MAX_PLAYERS; index += 1) {
        state = joinFfaPlayer(state, `player-${index}`, `UNIT-${index}`);
      }
      return state;
    };
    const first = populate();
    const second = populate();
    expect(first.players.map((player) => player.position)).toEqual(
      second.players.map((player) => player.position),
    );

    for (const player of first.players) {
      expect(Math.abs(player.position.x)).toBeLessThanOrEqual(
        ARENA_HALF_SIZE - player.radius,
      );
      expect(Math.abs(player.position.y)).toBeLessThanOrEqual(
        ARENA_HALF_SIZE - player.radius,
      );
      expect(
        ARENA_OBSTACLES.some((obstacle) =>
          circlePenetratesObstacle(player.position, player.radius, obstacle),
        ),
      ).toBe(false);
      for (const other of first.players) {
        if (other.id === player.id) continue;
        expect(distance(player.position, other.position)).toBeGreaterThanOrEqual(2.2);
      }
    }

    const empty = createFfaArenaState(73);
    const baseline = getPlayer(
      joinFfaPlayer(empty, 'target', 'TARGET'),
      'target',
    ).position;
    const pathShot = projectile(
      1,
      'hazard',
      { x: baseline.x, y: -11 },
      { ttlTicks: 60, velocity: { x: 0, y: 22 } },
    );
    const withPath = joinFfaPlayer(
      { ...empty, nextProjectileId: 2, projectiles: [pathShot] },
      'target',
      'TARGET',
    );
    const selected = getPlayer(withPath, 'target').position;
    expect(selected).not.toEqual(baseline);
    expect(
      withPath.projectiles.every(
        (shot) =>
          pointToSegmentDistance(selected, shot.position, projectileEnd(shot)) >= 1.15,
      ),
    ).toBe(true);
  });

  it('keeps spawn protection for 60 full ticks and then accepts damage', () => {
    let state = twoPlayerState(79);
    for (let tick = 0; tick < FFA_SPAWN_PROTECTION_TICKS; tick += 1) {
      const targetPosition = getPlayer(state, 'target').position;
      const projectileId = state.nextProjectileId;
      state = {
        ...state,
        nextProjectileId: projectileId + 1,
        projectiles: [
          ...state.projectiles,
          projectile(projectileId, 'attacker', targetPosition),
        ],
      };
      state = stepFfaArena(state, {});
      expect(getPlayer(state, 'target').health).toBe(FFA_PLAYER_MAX_HEALTH);
    }

    expect(getPlayer(state, 'target').spawnProtectionTicks).toBe(0);
    const targetPosition = getPlayer(state, 'target').position;
    state = {
      ...state,
      nextProjectileId: state.nextProjectileId + 1,
      projectiles: [
        ...state.projectiles,
        projectile(state.nextProjectileId, 'attacker', targetPosition),
      ],
    };
    const damaged = stepFfaArena(state, {});
    expect(getPlayer(damaged, 'target').health).toBe(75);
  });

  it('cancels spawn protection before accepted fire or dash actions', () => {
    let firingState = twoPlayerState(83);
    const targetPosition = getPlayer(firingState, 'target').position;
    firingState = {
      ...firingState,
      nextProjectileId: 2,
      projectiles: [projectile(1, 'attacker', targetPosition)],
    };
    const fired = stepFfaArena(firingState, { target: FIRE_RIGHT_INPUT });
    expect(getPlayer(fired, 'target').spawnProtectionTicks).toBe(0);
    expect(getPlayer(fired, 'target').health).toBe(75);
    expect(fired.events).toContainEqual(
      expect.objectContaining({ ownerId: 'target', type: 'shot' }),
    );

    const dashed = stepFfaArena(twoPlayerState(89), {
      target: { ...IDLE_INPUT, dash: true, move: { x: 0, y: 1 } },
    });
    expect(getPlayer(dashed, 'target')).toMatchObject({
      dashCooldownTicks: FFA_DASH_COOLDOWN_TICKS,
      dashTicks: FFA_DASH_DURATION_TICKS,
      spawnProtectionTicks: 0,
    });
  });

  it('keeps eliminated players inert and respawns on exactly the 180th later tick', () => {
    let state = twoPlayerState(97);
    state = updatePlayer(state, 'target', { spawnProtectionTicks: 0 });
    const targetPosition = getPlayer(state, 'target').position;
    state = {
      ...state,
      nextProjectileId: 5,
      projectiles: Array.from({ length: 4 }, (_, index) =>
        projectile(index + 1, 'attacker', targetPosition),
      ),
    };
    const eliminated = stepFfaArena(state, {});
    const eliminatedPosition = getPlayer(eliminated, 'target').position;
    expect(getPlayer(eliminated, 'target').status).toBe('eliminated');

    const attemptedAction = stepFfaArena(eliminated, {
      target: {
        aim: { x: 1, y: 0 },
        dash: true,
        firing: true,
        move: { x: 1, y: 0 },
      },
    });
    expect(getPlayer(attemptedAction, 'target').position).toEqual(eliminatedPosition);
    expect(attemptedAction.projectiles).toEqual([]);

    state = attemptedAction;
    for (let tick = 1; tick < FFA_RESPAWN_TICKS - 1; tick += 1) {
      state = stepFfaArena(state, {});
    }
    expect(getPlayer(state, 'target')).toMatchObject({
      respawnTicks: 1,
      status: 'eliminated',
    });

    const respawned = stepFfaArena(state, {});
    expect(getPlayer(respawned, 'target')).toMatchObject({
      health: FFA_PLAYER_MAX_HEALTH,
      respawnTicks: 0,
      statistics: { deaths: 1, kills: 0 },
      status: 'alive',
    });
    expect(getPlayer(respawned, 'attacker').statistics.kills).toBe(1);
    expect(respawned.events).toContainEqual(
      expect.objectContaining({ playerId: 'target', type: 'player-respawned' }),
    );
  });

  it('continues indefinitely through joins, leaves, empty ticks, and a one-player arena', () => {
    let state = joinFfaPlayer(createFfaArenaState(101), 'solo', 'SOLO');
    for (let tick = 0; tick < 1_000; tick += 1) state = stepFfaArena(state, {});
    expect(state.tick).toBe(1_000);
    expect(state.players).toHaveLength(1);
    expect(state).not.toHaveProperty('status');
    expect(state).not.toHaveProperty('round');
    expect(state).not.toHaveProperty('enemies');

    state = leaveFfaPlayer(state, 'solo');
    const empty = stepFfaArena(state, {});
    expect(empty.tick).toBe(1_001);
    expect(empty.players).toEqual([]);
    const liveJoin = joinFfaPlayer(empty, 'new-player', 'NEW');
    expect(liveJoin.tick).toBe(1_001);
    expect(getPlayer(liveJoin, 'new-player').statistics).toEqual({
      deaths: 0,
      kills: 0,
    });
  });

  it('does not mutate caller state or input records', () => {
    let state = joinFfaPlayer(createFfaArenaState(103), 'alpha', 'ALPHA');
    state = joinFfaPlayer(state, 'bravo', 'BRAVO');
    const input = {
      alpha: {
        aim: { x: 1, y: 0.25 },
        dash: true,
        firing: true,
        move: { x: 0.5, y: -0.5 },
      },
    } satisfies Record<string, FfaInput>;
    const stateSnapshot = JSON.stringify(state);
    const inputSnapshot = JSON.stringify(input);

    const next = stepFfaArena(state, input);
    expect(JSON.stringify(state)).toBe(stateSnapshot);
    expect(JSON.stringify(input)).toBe(inputSnapshot);
    expect(next).not.toBe(state);
    expect(next.players[0]).not.toBe(state.players[0]);
    expect(leaveFfaPlayer(state, 'alpha')).not.toBe(state);
  });
});

function twoPlayerState(seed: number): FfaArenaState {
  let state = createFfaArenaState(seed);
  state = joinFfaPlayer(state, 'attacker', 'ATTACKER');
  state = joinFfaPlayer(state, 'target', 'TARGET');
  state = updatePlayer(state, 'attacker', {
    position: { x: -8, y: 0 },
    spawnProtectionTicks: 0,
    velocity: { x: 0, y: 0 },
  });
  return updatePlayer(state, 'target', {
    health: FFA_PLAYER_MAX_HEALTH,
    position: { x: 8, y: 0 },
    spawnProtectionTicks: FFA_SPAWN_PROTECTION_TICKS,
    velocity: { x: 0, y: 0 },
  });
}

function getPlayer(state: FfaArenaState, playerId: string): FfaPlayerState {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error(`Expected player ${playerId}`);
  return player;
}

function updatePlayer(
  state: FfaArenaState,
  playerId: string,
  update: Partial<FfaPlayerState>,
): FfaArenaState {
  return {
    ...state,
    players: state.players.map((player) =>
      player.id === playerId
        ? {
            ...player,
            ...update,
            aim: { ...(update.aim ?? player.aim) },
            position: { ...(update.position ?? player.position) },
            statistics: { ...(update.statistics ?? player.statistics) },
            velocity: { ...(update.velocity ?? player.velocity) },
          }
        : player,
    ),
  };
}

function projectile(
  id: number,
  ownerId: string,
  position: Vector2,
  update: Partial<FfaProjectileState> = {},
): FfaProjectileState {
  return {
    damage: 25,
    id,
    ownerId,
    position: { ...position },
    radius: 0.12,
    ttlTicks: 20,
    velocity: { x: 0, y: 0 },
    ...update,
  };
}

function circlePenetratesObstacle(
  position: Vector2,
  radius: number,
  obstacle: (typeof ARENA_OBSTACLES)[number],
): boolean {
  const closestX = Math.max(
    obstacle.x - obstacle.halfWidth,
    Math.min(obstacle.x + obstacle.halfWidth, position.x),
  );
  const closestY = Math.max(
    obstacle.y - obstacle.halfHeight,
    Math.min(obstacle.y + obstacle.halfHeight, position.y),
  );
  return Math.hypot(position.x - closestX, position.y - closestY) < radius - 0.000_001;
}

function distance(first: Vector2, second: Vector2): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function projectileEnd(shot: FfaProjectileState): Vector2 {
  return {
    x: shot.position.x + shot.velocity.x * shot.ttlTicks * FFA_FIXED_STEP_SECONDS,
    y: shot.position.y + shot.velocity.y * shot.ttlTicks * FFA_FIXED_STEP_SECONDS,
  };
}

function pointToSegmentDistance(point: Vector2, start: Vector2, end: Vector2): number {
  const segment = { x: end.x - start.x, y: end.y - start.y };
  const lengthSquared = segment.x * segment.x + segment.y * segment.y;
  if (lengthSquared === 0) return distance(point, start);
  const amount = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * segment.x + (point.y - start.y) * segment.y) /
        lengthSquared,
    ),
  );
  return distance(point, {
    x: start.x + segment.x * amount,
    y: start.y + segment.y * amount,
  });
}
