import {
  ARENA_HALF_SIZE,
  ARENA_OBSTACLES,
  FIXED_STEP_SECONDS,
  type ArenaObstacle,
  type Vector2,
} from './arena';

export const FFA_FIXED_STEP_SECONDS = FIXED_STEP_SECONDS;
export const FFA_MAX_PLAYERS = 8;
export const FFA_MAX_PROJECTILES = 96;
export const FFA_PLAYER_MAX_HEALTH = 100;
export const FFA_RESPAWN_TICKS = 180;
export const FFA_SPAWN_PROTECTION_TICKS = 60;
export const FFA_FIRE_INTERVAL_TICKS = 8;
export const FFA_DASH_COOLDOWN_TICKS = 135;
export const FFA_DASH_DURATION_TICKS = 10;

const FFA_PLAYER_RADIUS = 0.48;
const FFA_PLAYER_SPEED = 6.2;
const FFA_PROJECTILE_RADIUS = 0.12;
const FFA_PROJECTILE_SPEED = 17;
const FFA_PROJECTILE_DAMAGE = 25;
const FFA_PROJECTILE_LIFETIME_TICKS = 90;
const FFA_DASH_SPEED = 16;
const FFA_SPAWN_PLAYER_CLEARANCE = 2.2;
const FFA_SPAWN_PATH_CLEARANCE = FFA_PLAYER_RADIUS + FFA_PROJECTILE_RADIUS + 0.55;

export interface FfaInput {
  aim: Vector2;
  dash: boolean;
  firing: boolean;
  move: Vector2;
}

export type FfaInputsByPlayer = Readonly<Record<string, FfaInput | undefined>>;
export type FfaPlayerStatus = 'alive' | 'eliminated';

export interface FfaPlayerStatistics {
  deaths: number;
  kills: number;
}

export interface FfaPlayerState {
  aim: Vector2;
  callsign: string;
  dashCooldownTicks: number;
  dashTicks: number;
  fireCooldownTicks: number;
  health: number;
  id: string;
  position: Vector2;
  radius: number;
  respawnTicks: number;
  spawnProtectionTicks: number;
  statistics: FfaPlayerStatistics;
  status: FfaPlayerStatus;
  velocity: Vector2;
}

export interface FfaProjectileState {
  damage: number;
  id: number;
  ownerId: string;
  position: Vector2;
  radius: number;
  ttlTicks: number;
  velocity: Vector2;
}

export type FfaEvent =
  | { playerId: string; position: Vector2; tick: number; type: 'dash' }
  | {
      damage: number;
      ownerId: string;
      position: Vector2;
      projectileId: number;
      targetId: string;
      tick: number;
      type: 'hit';
    }
  | {
      killerId: string;
      position: Vector2;
      projectileId: number;
      tick: number;
      type: 'player-eliminated';
      victimId: string;
    }
  | {
      playerId: string;
      position: Vector2;
      tick: number;
      type: 'player-joined';
    }
  | { playerId: string; tick: number; type: 'player-left' }
  | {
      playerId: string;
      position: Vector2;
      tick: number;
      type: 'player-respawned';
    }
  | {
      ownerId: string;
      position: Vector2;
      projectileId: number;
      tick: number;
      type: 'shot';
    };

export interface FfaArenaState {
  events: FfaEvent[];
  nextProjectileId: number;
  players: FfaPlayerState[];
  projectiles: FfaProjectileState[];
  randomState: number;
  tick: number;
}

export interface FfaCollisionWorld {
  readonly halfSize: number;
  readonly obstacles: readonly ArenaObstacle[];
}

const FFA_OBSTACLES: readonly ArenaObstacle[] = Object.freeze(
  ARENA_OBSTACLES.map((obstacle) => Object.freeze({ ...obstacle })),
);

export const FFA_COLLISION_WORLD: FfaCollisionWorld = Object.freeze({
  halfSize: ARENA_HALF_SIZE,
  obstacles: FFA_OBSTACLES,
});

const NEUTRAL_INPUT: FfaInput = {
  aim: { x: 0, y: -1 },
  dash: false,
  firing: false,
  move: { x: 0, y: 0 },
};

const SPAWN_COORDINATES = [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10] as const;
const FFA_SPAWN_CANDIDATES: readonly Vector2[] = SPAWN_COORDINATES.flatMap((y) =>
  SPAWN_COORDINATES.map((x) => ({ x, y })),
).filter((position) => isValidSpawnGeometry(position));

export function createFfaArenaState(seed: number): FfaArenaState {
  return {
    events: [],
    nextProjectileId: 1,
    players: [],
    projectiles: [],
    randomState: seed >>> 0 || 1,
    tick: 0,
  };
}

export function joinFfaPlayer(
  state: FfaArenaState,
  playerId: string,
  callsign: string,
): FfaArenaState {
  const next = cloneFfaState(state);
  if (
    next.players.length >= FFA_MAX_PLAYERS ||
    next.players.some((player) => player.id === playerId)
  ) {
    return next;
  }

  const position = selectSafeSpawn(next, playerId);
  next.players.push({
    aim: { x: 0, y: -1 },
    callsign,
    dashCooldownTicks: 0,
    dashTicks: 0,
    fireCooldownTicks: 0,
    health: FFA_PLAYER_MAX_HEALTH,
    id: playerId,
    position,
    radius: FFA_PLAYER_RADIUS,
    respawnTicks: 0,
    spawnProtectionTicks: FFA_SPAWN_PROTECTION_TICKS,
    statistics: { deaths: 0, kills: 0 },
    status: 'alive',
    velocity: { x: 0, y: 0 },
  });
  next.events.push({
    playerId,
    position: { ...position },
    tick: next.tick,
    type: 'player-joined',
  });
  return next;
}

export function leaveFfaPlayer(state: FfaArenaState, playerId: string): FfaArenaState {
  const next = cloneFfaState(state);
  const playerIndex = next.players.findIndex((player) => player.id === playerId);
  if (playerIndex < 0) return next;

  next.players.splice(playerIndex, 1);
  next.projectiles = next.projectiles.filter(
    (projectile) => projectile.ownerId !== playerId,
  );
  next.events.push({ playerId, tick: next.tick, type: 'player-left' });
  return next;
}

export function stepFfaPlayerMotion(
  player: FfaPlayerState,
  input: FfaInput,
  collisionWorld: FfaCollisionWorld = FFA_COLLISION_WORLD,
  deltaSeconds = FFA_FIXED_STEP_SECONDS,
): FfaPlayerState {
  assertFixedStep(deltaSeconds);
  const next = cloneFfaPlayer(player);
  if (next.status === 'eliminated') return next;

  next.dashCooldownTicks = decrementTicks(next.dashCooldownTicks);
  next.dashTicks = decrementTicks(next.dashTicks);
  next.fireCooldownTicks = decrementTicks(next.fireCooldownTicks);
  next.aim = normalizeFinite(input.aim, next.aim);
  const move = normalizeWithMagnitudeCap(input.move);

  if (input.dash && next.dashCooldownTicks === 0) {
    const dashDirection =
      lengthSquared(move) > 0 ? normalizeFinite(move, next.aim) : next.aim;
    next.velocity = scale(dashDirection, FFA_DASH_SPEED);
    next.dashCooldownTicks = FFA_DASH_COOLDOWN_TICKS;
    next.dashTicks = FFA_DASH_DURATION_TICKS;
    next.spawnProtectionTicks = 0;
  } else if (next.dashTicks === 0) {
    const desiredVelocity = scale(move, FFA_PLAYER_SPEED);
    const blend = Math.min(1, deltaSeconds * 17);
    next.velocity.x += (desiredVelocity.x - next.velocity.x) * blend;
    next.velocity.y += (desiredVelocity.y - next.velocity.y) * blend;
  }

  next.position.x += next.velocity.x * deltaSeconds;
  next.position.y += next.velocity.y * deltaSeconds;
  confineToArena(next.position, next.velocity, next.radius, collisionWorld.halfSize);
  for (const obstacle of collisionWorld.obstacles) {
    resolveCircleRectangle(next.position, next.velocity, next.radius, obstacle);
  }
  return next;
}

export function stepFfaArena(
  state: FfaArenaState,
  inputsByPlayer: FfaInputsByPlayer,
  deltaSeconds = FFA_FIXED_STEP_SECONDS,
): FfaArenaState {
  assertFixedStep(deltaSeconds);
  const next = cloneFfaState(state);
  next.tick += 1;

  respawnPlayers(next);

  for (let index = 0; index < next.players.length; index += 1) {
    const player = next.players[index];
    if (!player || player.status === 'eliminated') continue;

    const input = inputsByPlayer[player.id] ?? NEUTRAL_INPUT;
    const dashPosition = { ...player.position };
    const moved = stepFfaPlayerMotion(player, input, FFA_COLLISION_WORLD, deltaSeconds);
    next.players[index] = moved;

    const dashStarted =
      input.dash &&
      moved.dashCooldownTicks === FFA_DASH_COOLDOWN_TICKS &&
      moved.dashTicks === FFA_DASH_DURATION_TICKS;
    if (dashStarted) {
      next.events.push({
        playerId: moved.id,
        position: dashPosition,
        tick: next.tick,
        type: 'dash',
      });
    }

    if (
      input.firing &&
      moved.fireCooldownTicks === 0 &&
      next.projectiles.length < FFA_MAX_PROJECTILES
    ) {
      moved.spawnProtectionTicks = 0;
      moved.fireCooldownTicks = FFA_FIRE_INTERVAL_TICKS;
      const position = add(
        moved.position,
        scale(moved.aim, moved.radius + FFA_PROJECTILE_RADIUS + 0.08),
      );
      const projectile: FfaProjectileState = {
        damage: FFA_PROJECTILE_DAMAGE,
        id: takeProjectileId(next),
        ownerId: moved.id,
        position,
        radius: FFA_PROJECTILE_RADIUS,
        ttlTicks: FFA_PROJECTILE_LIFETIME_TICKS,
        velocity: scale(moved.aim, FFA_PROJECTILE_SPEED),
      };
      next.projectiles.push(projectile);
      next.events.push({
        ownerId: moved.id,
        position: { ...position },
        projectileId: projectile.id,
        tick: next.tick,
        type: 'shot',
      });
    }
  }

  updateProjectiles(next);
  for (const player of next.players) {
    if (player.status === 'alive' && player.spawnProtectionTicks > 0) {
      player.spawnProtectionTicks -= 1;
    }
  }
  return next;
}

function cloneFfaState(state: FfaArenaState): FfaArenaState {
  return {
    ...state,
    events: [],
    players: state.players.slice(0, FFA_MAX_PLAYERS).map(cloneFfaPlayer),
    projectiles: state.projectiles.slice(0, FFA_MAX_PROJECTILES).map((projectile) => ({
      ...projectile,
      position: { ...projectile.position },
      velocity: { ...projectile.velocity },
    })),
  };
}

function cloneFfaPlayer(player: FfaPlayerState): FfaPlayerState {
  return {
    ...player,
    aim: { ...player.aim },
    position: { ...player.position },
    statistics: { ...player.statistics },
    velocity: { ...player.velocity },
  };
}

function respawnPlayers(state: FfaArenaState): void {
  for (const player of state.players) {
    if (player.status !== 'eliminated') continue;

    player.respawnTicks = decrementTicks(player.respawnTicks);
    if (player.respawnTicks > 0) continue;

    const position = selectSafeSpawn(state, player.id);
    player.aim = { x: 0, y: -1 };
    player.dashCooldownTicks = 0;
    player.dashTicks = 0;
    player.fireCooldownTicks = 0;
    player.health = FFA_PLAYER_MAX_HEALTH;
    player.position = position;
    player.respawnTicks = 0;
    player.spawnProtectionTicks = FFA_SPAWN_PROTECTION_TICKS;
    player.status = 'alive';
    player.velocity = { x: 0, y: 0 };
    state.events.push({
      playerId: player.id,
      position: { ...position },
      tick: state.tick,
      type: 'player-respawned',
    });
  }
}

function updateProjectiles(state: FfaArenaState): void {
  for (const projectile of state.projectiles) {
    projectile.ttlTicks = decrementTicks(projectile.ttlTicks);
    projectile.position.x += projectile.velocity.x * FFA_FIXED_STEP_SECONDS;
    projectile.position.y += projectile.velocity.y * FFA_FIXED_STEP_SECONDS;
    if (
      Math.abs(projectile.position.x) > ARENA_HALF_SIZE - projectile.radius ||
      Math.abs(projectile.position.y) > ARENA_HALF_SIZE - projectile.radius ||
      FFA_OBSTACLES.some((obstacle) =>
        circleIntersectsRectangle(projectile.position, projectile.radius, obstacle),
      )
    ) {
      projectile.ttlTicks = 0;
    }
  }

  for (const projectile of state.projectiles) {
    if (projectile.ttlTicks <= 0) continue;
    const target = state.players.find(
      (player) =>
        player.status === 'alive' &&
        player.id !== projectile.ownerId &&
        distanceSquared(player.position, projectile.position) <=
          (player.radius + projectile.radius) ** 2,
    );
    if (!target) continue;

    projectile.ttlTicks = 0;
    if (target.spawnProtectionTicks > 0 || target.dashTicks > 0) continue;

    const damage = Math.min(target.health, projectile.damage);
    target.health -= damage;
    state.events.push({
      damage,
      ownerId: projectile.ownerId,
      position: { ...target.position },
      projectileId: projectile.id,
      targetId: target.id,
      tick: state.tick,
      type: 'hit',
    });
    if (target.health > 0) continue;

    target.health = 0;
    target.status = 'eliminated';
    target.respawnTicks = FFA_RESPAWN_TICKS;
    target.spawnProtectionTicks = 0;
    target.dashTicks = 0;
    target.velocity = { x: 0, y: 0 };
    target.statistics.deaths += 1;
    const killer = state.players.find((player) => player.id === projectile.ownerId);
    if (killer) killer.statistics.kills += 1;
    state.events.push({
      killerId: projectile.ownerId,
      position: { ...target.position },
      projectileId: projectile.id,
      tick: state.tick,
      type: 'player-eliminated',
      victimId: target.id,
    });
  }

  state.projectiles = state.projectiles.filter((projectile) => projectile.ttlTicks > 0);
}

function selectSafeSpawn(state: FfaArenaState, playerId: string): Vector2 {
  const livingPlayers = state.players.filter(
    (player) => player.status === 'alive' && player.id !== playerId,
  );
  const dangerousProjectiles = state.projectiles.filter(
    (projectile) => projectile.ttlTicks > 0 && projectile.ownerId !== playerId,
  );
  const candidateOffset = Math.floor(nextRandom(state) * FFA_SPAWN_CANDIDATES.length);
  let bestSafe: Vector2 | undefined;
  let bestSafeScore = -1;
  let bestFallback: Vector2 | undefined;
  let bestFallbackScore = -1;

  for (let offset = 0; offset < FFA_SPAWN_CANDIDATES.length; offset += 1) {
    const candidateIndex = (candidateOffset + offset) % FFA_SPAWN_CANDIDATES.length;
    const candidate = FFA_SPAWN_CANDIDATES[candidateIndex];
    if (!candidate) continue;

    const playerDistance = minimumPlayerDistanceSquared(candidate, livingPlayers);
    if (playerDistance < FFA_SPAWN_PLAYER_CLEARANCE ** 2) continue;
    const pathDistance = minimumProjectilePathDistanceSquared(
      candidate,
      dangerousProjectiles,
    );
    const score = Math.min(playerDistance, pathDistance);
    if (score > bestFallbackScore) {
      bestFallback = candidate;
      bestFallbackScore = score;
    }
    if (pathDistance >= FFA_SPAWN_PATH_CLEARANCE ** 2 && score > bestSafeScore) {
      bestSafe = candidate;
      bestSafeScore = score;
    }
  }

  const fallbackIndex = candidateOffset % FFA_SPAWN_CANDIDATES.length;
  const selected = bestSafe ??
    bestFallback ??
    FFA_SPAWN_CANDIDATES[fallbackIndex] ?? { x: 0, y: 0 };
  if (!bestSafe) {
    state.projectiles = state.projectiles.filter(
      (projectile) =>
        projectile.ownerId === playerId ||
        projectilePathDistanceSquared(selected, projectile) >=
          FFA_SPAWN_PATH_CLEARANCE ** 2,
    );
  }
  return { ...selected };
}

function minimumPlayerDistanceSquared(
  position: Vector2,
  players: readonly FfaPlayerState[],
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const player of players) {
    minimum = Math.min(minimum, distanceSquared(position, player.position));
  }
  return minimum;
}

function minimumProjectilePathDistanceSquared(
  position: Vector2,
  projectiles: readonly FfaProjectileState[],
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const projectile of projectiles) {
    minimum = Math.min(minimum, projectilePathDistanceSquared(position, projectile));
  }
  return minimum;
}

function projectilePathDistanceSquared(
  position: Vector2,
  projectile: FfaProjectileState,
): number {
  const end = add(
    projectile.position,
    scale(projectile.velocity, projectile.ttlTicks * FFA_FIXED_STEP_SECONDS),
  );
  return pointToSegmentDistanceSquared(position, projectile.position, end);
}

function pointToSegmentDistanceSquared(
  point: Vector2,
  start: Vector2,
  end: Vector2,
): number {
  const segment = subtract(end, start);
  const segmentLengthSquared = lengthSquared(segment);
  if (segmentLengthSquared <= 0.000_001) return distanceSquared(point, start);

  const fromStart = subtract(point, start);
  const projection =
    (fromStart.x * segment.x + fromStart.y * segment.y) / segmentLengthSquared;
  const amount = Math.max(0, Math.min(1, projection));
  return distanceSquared(point, add(start, scale(segment, amount)));
}

function isValidSpawnGeometry(position: Vector2): boolean {
  const limit = ARENA_HALF_SIZE - FFA_PLAYER_RADIUS;
  return (
    Math.abs(position.x) <= limit &&
    Math.abs(position.y) <= limit &&
    !FFA_OBSTACLES.some((obstacle) =>
      circleIntersectsRectangle(position, FFA_PLAYER_RADIUS, obstacle),
    )
  );
}

function confineToArena(
  position: Vector2,
  velocity: Vector2,
  radius: number,
  halfSize: number,
): void {
  const limit = halfSize - radius;
  if (position.x < -limit || position.x > limit) {
    position.x = Math.max(-limit, Math.min(limit, position.x));
    velocity.x = 0;
  }
  if (position.y < -limit || position.y > limit) {
    position.y = Math.max(-limit, Math.min(limit, position.y));
    velocity.y = 0;
  }
}

function resolveCircleRectangle(
  position: Vector2,
  velocity: Vector2,
  radius: number,
  obstacle: ArenaObstacle,
): void {
  const relativeX = position.x - obstacle.x;
  const relativeY = position.y - obstacle.y;
  if (
    Math.abs(relativeX) <= obstacle.halfWidth &&
    Math.abs(relativeY) <= obstacle.halfHeight
  ) {
    const horizontalExit = obstacle.halfWidth - Math.abs(relativeX);
    const verticalExit = obstacle.halfHeight - Math.abs(relativeY);
    if (horizontalExit < verticalExit) {
      const direction = relativeX < 0 ? -1 : 1;
      position.x = obstacle.x + direction * (obstacle.halfWidth + radius);
      if (velocity.x * direction < 0) velocity.x = 0;
    } else {
      const direction = relativeY < 0 ? -1 : 1;
      position.y = obstacle.y + direction * (obstacle.halfHeight + radius);
      if (velocity.y * direction < 0) velocity.y = 0;
    }
    return;
  }

  const closest = {
    x: Math.max(
      obstacle.x - obstacle.halfWidth,
      Math.min(obstacle.x + obstacle.halfWidth, position.x),
    ),
    y: Math.max(
      obstacle.y - obstacle.halfHeight,
      Math.min(obstacle.y + obstacle.halfHeight, position.y),
    ),
  };
  const difference = subtract(position, closest);
  const squaredDistance = lengthSquared(difference);
  if (squaredDistance >= radius ** 2 || squaredDistance <= 0.000_001) return;

  const distance = Math.sqrt(squaredDistance);
  const normal = scale(difference, 1 / distance);
  const push = radius - distance;
  position.x += normal.x * push;
  position.y += normal.y * push;
  const inwardSpeed = velocity.x * normal.x + velocity.y * normal.y;
  if (inwardSpeed < 0) {
    velocity.x -= normal.x * inwardSpeed;
    velocity.y -= normal.y * inwardSpeed;
  }
}

function circleIntersectsRectangle(
  position: Vector2,
  radius: number,
  obstacle: ArenaObstacle,
): boolean {
  const closestX = Math.max(
    obstacle.x - obstacle.halfWidth,
    Math.min(obstacle.x + obstacle.halfWidth, position.x),
  );
  const closestY = Math.max(
    obstacle.y - obstacle.halfHeight,
    Math.min(obstacle.y + obstacle.halfHeight, position.y),
  );
  return distanceSquared(position, { x: closestX, y: closestY }) <= radius ** 2;
}

function assertFixedStep(deltaSeconds: number): void {
  if (deltaSeconds !== FFA_FIXED_STEP_SECONDS) {
    throw new RangeError('FFA simulation requires fixed 1/60 second steps');
  }
}

function decrementTicks(value: number): number {
  return Math.max(0, value - 1);
}

function takeProjectileId(state: FfaArenaState): number {
  const id = state.nextProjectileId;
  state.nextProjectileId += 1;
  return id;
}

function nextRandom(state: FfaArenaState): number {
  state.randomState = (Math.imul(state.randomState, 1_664_525) + 1_013_904_223) >>> 0;
  return state.randomState / 4_294_967_296;
}

function add(first: Vector2, second: Vector2): Vector2 {
  return { x: first.x + second.x, y: first.y + second.y };
}

function subtract(first: Vector2, second: Vector2): Vector2 {
  return { x: first.x - second.x, y: first.y - second.y };
}

function scale(vector: Vector2, amount: number): Vector2 {
  return { x: vector.x * amount, y: vector.y * amount };
}

function lengthSquared(vector: Vector2): number {
  return vector.x * vector.x + vector.y * vector.y;
}

function normalizeFinite(vector: Vector2, fallback: Vector2): Vector2 {
  if (!Number.isFinite(vector.x) || !Number.isFinite(vector.y)) return { ...fallback };
  const magnitude = Math.sqrt(lengthSquared(vector));
  return magnitude > 0.0001 ? scale(vector, 1 / magnitude) : { ...fallback };
}

function normalizeWithMagnitudeCap(vector: Vector2): Vector2 {
  if (!Number.isFinite(vector.x) || !Number.isFinite(vector.y)) return { x: 0, y: 0 };
  const magnitude = Math.sqrt(lengthSquared(vector));
  return magnitude > 1 ? scale(vector, 1 / magnitude) : { ...vector };
}

function distanceSquared(first: Vector2, second: Vector2): number {
  return lengthSquared(subtract(first, second));
}
