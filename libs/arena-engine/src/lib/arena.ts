export const FIXED_STEP_SECONDS = 1 / 60;
export const RUN_DURATION_SECONDS = 90;
export const ARENA_HALF_SIZE = 12;

const PLAYER_RADIUS = 0.48;
const PLAYER_SPEED = 6.2;
const PLAYER_MAX_HEALTH = 100;
const PLAYER_FIRE_INTERVAL = 0.135;
const PLAYER_PROJECTILE_SPEED = 17;
const DASH_SPEED = 16;
const DASH_DURATION = 0.16;
export const DASH_COOLDOWN_SECONDS = 2.25;
const COMBO_WINDOW = 3.5;
const MAX_ENEMIES = 26;

export interface Vector2 {
  x: number;
  y: number;
}

export interface ArenaInput {
  aim: Vector2;
  dash: boolean;
  firing: boolean;
  move: Vector2;
}

export type ArenaStatus = 'playing' | 'defeated' | 'extracted';
export type EnemyKind = 'runner' | 'gunner' | 'brute';
export type PickupKind = 'repair' | 'overdrive';

export interface PlayerState {
  aim: Vector2;
  dashCooldown: number;
  dashTime: number;
  fireCooldown: number;
  health: number;
  invulnerableTime: number;
  overdriveTime: number;
  position: Vector2;
  radius: number;
  velocity: Vector2;
}

export interface EnemyState {
  contactCooldown: number;
  health: number;
  id: number;
  kind: EnemyKind;
  maxHealth: number;
  phase: number;
  position: Vector2;
  radius: number;
  velocity: Vector2;
  weaponCooldown: number;
}

export interface ProjectileState {
  damage: number;
  id: number;
  owner: 'player' | 'enemy';
  position: Vector2;
  radius: number;
  ttl: number;
  velocity: Vector2;
}

export interface PickupState {
  id: number;
  kind: PickupKind;
  position: Vector2;
  radius: number;
  ttl: number;
}

export interface ArenaObstacle {
  halfHeight: number;
  halfWidth: number;
  x: number;
  y: number;
}

export type ArenaEvent =
  | { type: 'dash'; position: Vector2 }
  | { type: 'enemy-destroyed'; enemyId: number; kind: EnemyKind; position: Vector2 }
  | { type: 'game-over'; status: Exclude<ArenaStatus, 'playing'> }
  | { type: 'hit'; position: Vector2; target: 'enemy' | 'player' }
  | { type: 'pickup'; kind: PickupKind; position: Vector2 }
  | { type: 'shot'; owner: 'player' | 'enemy'; position: Vector2 };

export interface ArenaStats {
  damageTaken: number;
  eliminations: number;
  hits: number;
  shots: number;
}

export interface ArenaState {
  combo: number;
  comboTimer: number;
  elapsed: number;
  enemies: EnemyState[];
  events: ArenaEvent[];
  nextId: number;
  pickups: PickupState[];
  player: PlayerState;
  projectiles: ProjectileState[];
  randomState: number;
  score: number;
  spawnTimer: number;
  stats: ArenaStats;
  status: ArenaStatus;
  timeRemaining: number;
  wave: number;
}

export const ARENA_OBSTACLES: readonly ArenaObstacle[] = [
  { x: -4.2, y: -2.6, halfWidth: 1.35, halfHeight: 0.72 },
  { x: 4.3, y: 2.7, halfWidth: 1.35, halfHeight: 0.72 },
  { x: -1.1, y: 4.9, halfWidth: 0.72, halfHeight: 1.45 },
  { x: 1.1, y: -4.9, halfWidth: 0.72, halfHeight: 1.45 },
];

const ZERO_INPUT: ArenaInput = {
  aim: { x: 0, y: -1 },
  dash: false,
  firing: false,
  move: { x: 0, y: 0 },
};

export function createArenaState(seed = 0x51_9a_2d_7b): ArenaState {
  const normalizedSeed = seed >>> 0 || 1;
  let state: ArenaState = {
    combo: 0,
    comboTimer: 0,
    elapsed: 0,
    enemies: [],
    events: [],
    nextId: 1,
    pickups: [],
    player: {
      aim: { x: 0, y: -1 },
      dashCooldown: 0,
      dashTime: 0,
      fireCooldown: 0,
      health: PLAYER_MAX_HEALTH,
      invulnerableTime: 0,
      overdriveTime: 0,
      position: { x: 0, y: 0 },
      radius: PLAYER_RADIUS,
      velocity: { x: 0, y: 0 },
    },
    projectiles: [],
    randomState: normalizedSeed,
    score: 0,
    spawnTimer: 0.8,
    stats: { damageTaken: 0, eliminations: 0, hits: 0, shots: 0 },
    status: 'playing',
    timeRemaining: RUN_DURATION_SECONDS,
    wave: 1,
  };

  for (let index = 0; index < 3; index += 1) {
    state = spawnEnemy(state, 'runner');
  }

  return state;
}

export function stepArena(
  state: ArenaState,
  input: ArenaInput = ZERO_INPUT,
  deltaSeconds = FIXED_STEP_SECONDS,
): ArenaState {
  if (state.status !== 'playing') return cloneState(state, []);

  const delta = Number.isFinite(deltaSeconds)
    ? Math.min(Math.max(deltaSeconds, 0), 0.1)
    : FIXED_STEP_SECONDS;
  if (delta === 0) return cloneState(state, []);

  let next = cloneState(state, []);
  next.elapsed = Math.min(RUN_DURATION_SECONDS, next.elapsed + delta);
  next.timeRemaining = Math.max(0, RUN_DURATION_SECONDS - next.elapsed);
  next.wave = Math.min(5, Math.floor(next.elapsed / 18) + 1);
  next.comboTimer = Math.max(0, next.comboTimer - delta);
  if (next.comboTimer === 0) next.combo = 0;

  updatePlayer(next, input, delta);
  updateSpawning(next, delta);
  updateEnemies(next, delta);
  updateProjectiles(next, delta);
  updatePickups(next, delta);

  if (next.player.health <= 0) {
    next.player.health = 0;
    next.status = 'defeated';
    next.events.push({ type: 'game-over', status: 'defeated' });
  } else if (next.timeRemaining <= 0) {
    next.status = 'extracted';
    next.score += 1_000 + Math.round(next.player.health * 10);
    next.events.push({ type: 'game-over', status: 'extracted' });
  }

  return next;
}

function cloneState(state: ArenaState, events: ArenaEvent[]): ArenaState {
  return {
    ...state,
    enemies: state.enemies.map((enemy) => ({
      ...enemy,
      position: { ...enemy.position },
      velocity: { ...enemy.velocity },
    })),
    events,
    pickups: state.pickups.map((pickup) => ({
      ...pickup,
      position: { ...pickup.position },
    })),
    player: {
      ...state.player,
      aim: { ...state.player.aim },
      position: { ...state.player.position },
      velocity: { ...state.player.velocity },
    },
    projectiles: state.projectiles.map((projectile) => ({
      ...projectile,
      position: { ...projectile.position },
      velocity: { ...projectile.velocity },
    })),
    stats: { ...state.stats },
  };
}

function updatePlayer(state: ArenaState, input: ArenaInput, delta: number): void {
  const player = state.player;
  player.dashCooldown = Math.max(0, player.dashCooldown - delta);
  player.dashTime = Math.max(0, player.dashTime - delta);
  player.fireCooldown = Math.max(0, player.fireCooldown - delta);
  player.invulnerableTime = Math.max(0, player.invulnerableTime - delta);
  player.overdriveTime = Math.max(0, player.overdriveTime - delta);

  const aim = normalize(input.aim, player.aim);
  player.aim = aim;
  const move = normalizeWithMagnitudeCap(input.move);

  if (input.dash && player.dashCooldown === 0) {
    const dashDirection = lengthSquared(move) > 0 ? normalize(move, aim) : aim;
    player.velocity = scale(dashDirection, DASH_SPEED);
    player.dashCooldown = DASH_COOLDOWN_SECONDS;
    player.dashTime = DASH_DURATION;
    player.invulnerableTime = Math.max(player.invulnerableTime, DASH_DURATION + 0.08);
    state.events.push({ type: 'dash', position: { ...player.position } });
  } else if (player.dashTime === 0) {
    const desiredVelocity = scale(move, PLAYER_SPEED);
    const blend = Math.min(1, delta * 17);
    player.velocity.x += (desiredVelocity.x - player.velocity.x) * blend;
    player.velocity.y += (desiredVelocity.y - player.velocity.y) * blend;
  }

  player.position.x += player.velocity.x * delta;
  player.position.y += player.velocity.y * delta;
  confineToArena(player.position, player.velocity, player.radius);
  for (const obstacle of ARENA_OBSTACLES) {
    resolveCircleRectangle(player.position, player.velocity, player.radius, obstacle);
  }

  if (input.firing && player.fireCooldown === 0) {
    const interval =
      player.overdriveTime > 0 ? PLAYER_FIRE_INTERVAL * 0.58 : PLAYER_FIRE_INTERVAL;
    player.fireCooldown = interval;
    const origin = add(player.position, scale(aim, player.radius + 0.28));
    state.projectiles.push({
      damage: player.overdriveTime > 0 ? 2 : 1,
      id: takeId(state),
      owner: 'player',
      position: origin,
      radius: 0.12,
      ttl: 1.25,
      velocity: scale(aim, PLAYER_PROJECTILE_SPEED),
    });
    state.stats.shots += 1;
    state.events.push({ type: 'shot', owner: 'player', position: origin });
  }
}

function updateSpawning(state: ArenaState, delta: number): void {
  state.spawnTimer -= delta;
  if (state.spawnTimer > 0 || state.enemies.length >= MAX_ENEMIES) return;

  const kindRoll = random(state);
  const kind: EnemyKind =
    state.wave >= 3 && kindRoll > 0.83
      ? 'brute'
      : state.wave >= 2 && kindRoll > 0.56
        ? 'gunner'
        : 'runner';
  const spawned = spawnEnemy(state, kind);
  state.enemies = spawned.enemies;
  state.nextId = spawned.nextId;
  state.randomState = spawned.randomState;
  const pressure = state.wave * 0.105 + state.elapsed * 0.0025;
  state.spawnTimer = Math.max(0.42, 1.22 - pressure) * (0.82 + random(state) * 0.36);
}

function spawnEnemy(state: ArenaState, forcedKind?: EnemyKind): ArenaState {
  const next = cloneState(state, [...state.events]);
  const edge = Math.floor(random(next) * 4);
  const offset = (random(next) * 2 - 1) * (ARENA_HALF_SIZE - 1.5);
  const margin = ARENA_HALF_SIZE - 0.45;
  const position =
    edge === 0
      ? { x: offset, y: -margin }
      : edge === 1
        ? { x: margin, y: offset }
        : edge === 2
          ? { x: offset, y: margin }
          : { x: -margin, y: offset };
  const kind = forcedKind ?? 'runner';
  const profile = enemyProfile(kind);
  next.enemies.push({
    contactCooldown: random(next) * 0.25,
    health: profile.health,
    id: takeId(next),
    kind,
    maxHealth: profile.health,
    phase: random(next) * Math.PI * 2,
    position,
    radius: profile.radius,
    velocity: { x: 0, y: 0 },
    weaponCooldown: 0.45 + random(next) * 0.8,
  });
  return next;
}

function updateEnemies(state: ArenaState, delta: number): void {
  const player = state.player;
  for (const enemy of state.enemies) {
    enemy.contactCooldown = Math.max(0, enemy.contactCooldown - delta);
    enemy.weaponCooldown = Math.max(0, enemy.weaponCooldown - delta);
    enemy.phase += delta;

    const toPlayer = subtract(player.position, enemy.position);
    const distance = Math.max(0.001, length(toPlayer));
    const direction = scale(toPlayer, 1 / distance);
    const profile = enemyProfile(enemy.kind);
    let desiredDirection = direction;

    if (enemy.kind === 'gunner') {
      const distanceDrive = distance > 7.5 ? 1 : distance < 5.2 ? -0.75 : 0;
      const strafe = { x: -direction.y, y: direction.x };
      const strafeSign = enemy.id % 2 === 0 ? 1 : -1;
      desiredDirection = normalize(
        add(scale(direction, distanceDrive), scale(strafe, strafeSign * 0.82)),
        direction,
      );
      if (enemy.weaponCooldown === 0 && distance < 11) {
        const origin = add(enemy.position, scale(direction, enemy.radius + 0.2));
        state.projectiles.push({
          damage: 12,
          id: takeId(state),
          owner: 'enemy',
          position: origin,
          radius: 0.16,
          ttl: 2.2,
          velocity: scale(direction, 7.2 + state.wave * 0.3),
        });
        enemy.weaponCooldown = Math.max(0.75, 1.55 - state.wave * 0.08);
        state.events.push({ type: 'shot', owner: 'enemy', position: origin });
      }
    }

    const desiredVelocity = scale(desiredDirection, profile.speed + state.wave * 0.08);
    const blend = Math.min(1, delta * 7.5);
    enemy.velocity.x += (desiredVelocity.x - enemy.velocity.x) * blend;
    enemy.velocity.y += (desiredVelocity.y - enemy.velocity.y) * blend;
    enemy.position.x += enemy.velocity.x * delta;
    enemy.position.y += enemy.velocity.y * delta;
    confineToArena(enemy.position, enemy.velocity, enemy.radius);
    for (const obstacle of ARENA_OBSTACLES) {
      resolveCircleRectangle(enemy.position, enemy.velocity, enemy.radius, obstacle);
    }

    if (
      distanceSquared(enemy.position, player.position) <=
        (enemy.radius + player.radius) ** 2 &&
      enemy.contactCooldown === 0
    ) {
      enemy.contactCooldown = 0.8;
      damagePlayer(state, profile.contactDamage, enemy.position);
    }
  }

  separateEnemies(state.enemies);
}

function updateProjectiles(state: ArenaState, delta: number): void {
  for (const projectile of state.projectiles) {
    projectile.ttl -= delta;
    projectile.position.x += projectile.velocity.x * delta;
    projectile.position.y += projectile.velocity.y * delta;
    if (
      Math.abs(projectile.position.x) > ARENA_HALF_SIZE ||
      Math.abs(projectile.position.y) > ARENA_HALF_SIZE ||
      ARENA_OBSTACLES.some((obstacle) =>
        pointInsideRectangle(projectile.position, obstacle),
      )
    ) {
      projectile.ttl = 0;
    }
  }

  const destroyed = new Set<number>();
  for (const projectile of state.projectiles) {
    if (projectile.ttl <= 0) continue;
    if (projectile.owner === 'player') {
      const enemy = state.enemies.find(
        (candidate) =>
          !destroyed.has(candidate.id) &&
          distanceSquared(projectile.position, candidate.position) <=
            (projectile.radius + candidate.radius) ** 2,
      );
      if (!enemy) continue;
      projectile.ttl = 0;
      enemy.health -= projectile.damage;
      state.stats.hits += 1;
      state.events.push({
        type: 'hit',
        target: 'enemy',
        position: { ...enemy.position },
      });
      if (enemy.health <= 0) destroyed.add(enemy.id);
    } else if (
      distanceSquared(projectile.position, state.player.position) <=
      (projectile.radius + state.player.radius) ** 2
    ) {
      projectile.ttl = 0;
      damagePlayer(state, projectile.damage, projectile.position);
    }
  }

  if (destroyed.size > 0) {
    for (const enemy of state.enemies) {
      if (!destroyed.has(enemy.id)) continue;
      state.combo = Math.min(8, state.combo + 1);
      state.comboTimer = COMBO_WINDOW;
      state.score += enemyProfile(enemy.kind).score * state.combo;
      state.stats.eliminations += 1;
      state.events.push({
        type: 'enemy-destroyed',
        enemyId: enemy.id,
        kind: enemy.kind,
        position: { ...enemy.position },
      });
      if (random(state) < 0.17) {
        state.pickups.push({
          id: takeId(state),
          kind: random(state) < 0.55 ? 'repair' : 'overdrive',
          position: { ...enemy.position },
          radius: 0.34,
          ttl: 10,
        });
      }
    }
    state.enemies = state.enemies.filter((enemy) => !destroyed.has(enemy.id));
  }

  state.projectiles = state.projectiles.filter((projectile) => projectile.ttl > 0);
}

function updatePickups(state: ArenaState, delta: number): void {
  for (const pickup of state.pickups) pickup.ttl -= delta;
  const collected = new Set<number>();
  for (const pickup of state.pickups) {
    if (
      distanceSquared(pickup.position, state.player.position) >
      (pickup.radius + state.player.radius) ** 2
    ) {
      continue;
    }
    collected.add(pickup.id);
    if (pickup.kind === 'repair') {
      state.player.health = Math.min(PLAYER_MAX_HEALTH, state.player.health + 24);
    } else {
      state.player.overdriveTime = Math.max(state.player.overdriveTime, 6);
      state.player.dashCooldown = 0;
    }
    state.score += 50;
    state.events.push({
      type: 'pickup',
      kind: pickup.kind,
      position: { ...pickup.position },
    });
  }
  state.pickups = state.pickups.filter(
    (pickup) => pickup.ttl > 0 && !collected.has(pickup.id),
  );
}

function damagePlayer(state: ArenaState, amount: number, source: Vector2): void {
  const player = state.player;
  if (player.invulnerableTime > 0 || player.dashTime > 0) return;
  player.health -= amount;
  player.invulnerableTime = 0.62;
  const knockback = normalize(subtract(player.position, source), player.aim);
  player.velocity = add(player.velocity, scale(knockback, 4.5));
  state.combo = 0;
  state.comboTimer = 0;
  state.stats.damageTaken += amount;
  state.events.push({
    type: 'hit',
    target: 'player',
    position: { ...player.position },
  });
}

function enemyProfile(kind: EnemyKind): {
  contactDamage: number;
  health: number;
  radius: number;
  score: number;
  speed: number;
} {
  switch (kind) {
    case 'runner':
      return { contactDamage: 14, health: 2, radius: 0.44, score: 100, speed: 2.65 };
    case 'gunner':
      return { contactDamage: 10, health: 3, radius: 0.52, score: 175, speed: 2.05 };
    case 'brute':
      return { contactDamage: 24, health: 7, radius: 0.72, score: 300, speed: 1.55 };
  }
}

function separateEnemies(enemies: EnemyState[]): void {
  for (let firstIndex = 0; firstIndex < enemies.length; firstIndex += 1) {
    const first = enemies[firstIndex];
    if (!first) continue;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < enemies.length;
      secondIndex += 1
    ) {
      const second = enemies[secondIndex];
      if (!second) continue;
      const difference = subtract(second.position, first.position);
      const minimumDistance = first.radius + second.radius;
      const squaredDistance = lengthSquared(difference);
      if (squaredDistance >= minimumDistance ** 2) continue;
      const direction = normalize(difference, { x: 1, y: 0 });
      const overlap =
        (minimumDistance - Math.sqrt(Math.max(0.0001, squaredDistance))) / 2;
      first.position.x -= direction.x * overlap;
      first.position.y -= direction.y * overlap;
      second.position.x += direction.x * overlap;
      second.position.y += direction.y * overlap;
    }
  }
}

function confineToArena(position: Vector2, velocity: Vector2, radius: number): void {
  const limit = ARENA_HALF_SIZE - radius;
  if (position.x < -limit || position.x > limit) {
    position.x = Math.max(-limit, Math.min(limit, position.x));
    velocity.x *= -0.2;
  }
  if (position.y < -limit || position.y > limit) {
    position.y = Math.max(-limit, Math.min(limit, position.y));
    velocity.y *= -0.2;
  }
}

function resolveCircleRectangle(
  position: Vector2,
  velocity: Vector2,
  radius: number,
  obstacle: ArenaObstacle,
): void {
  const closestX = Math.max(
    obstacle.x - obstacle.halfWidth,
    Math.min(obstacle.x + obstacle.halfWidth, position.x),
  );
  const closestY = Math.max(
    obstacle.y - obstacle.halfHeight,
    Math.min(obstacle.y + obstacle.halfHeight, position.y),
  );
  let difference = { x: position.x - closestX, y: position.y - closestY };
  let distance = length(difference);
  if (distance >= radius) return;

  if (distance < 0.0001) {
    const horizontalPenetration =
      obstacle.halfWidth + radius - Math.abs(position.x - obstacle.x);
    const verticalPenetration =
      obstacle.halfHeight + radius - Math.abs(position.y - obstacle.y);
    difference =
      horizontalPenetration < verticalPenetration
        ? { x: position.x < obstacle.x ? -1 : 1, y: 0 }
        : { x: 0, y: position.y < obstacle.y ? -1 : 1 };
    distance = 0;
  } else {
    difference = scale(difference, 1 / distance);
  }

  const push = radius - distance;
  position.x += difference.x * push;
  position.y += difference.y * push;
  const inwardSpeed = velocity.x * difference.x + velocity.y * difference.y;
  if (inwardSpeed < 0) {
    velocity.x -= difference.x * inwardSpeed;
    velocity.y -= difference.y * inwardSpeed;
  }
}

function pointInsideRectangle(point: Vector2, obstacle: ArenaObstacle): boolean {
  return (
    Math.abs(point.x - obstacle.x) <= obstacle.halfWidth &&
    Math.abs(point.y - obstacle.y) <= obstacle.halfHeight
  );
}

function takeId(state: ArenaState): number {
  const id = state.nextId;
  state.nextId += 1;
  return id;
}

function random(state: ArenaState): number {
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

function length(vector: Vector2): number {
  return Math.sqrt(lengthSquared(vector));
}

function normalize(vector: Vector2, fallback: Vector2): Vector2 {
  const magnitude = length(vector);
  return magnitude > 0.0001 ? scale(vector, 1 / magnitude) : { ...fallback };
}

function normalizeWithMagnitudeCap(vector: Vector2): Vector2 {
  const magnitude = length(vector);
  return magnitude > 1 ? scale(vector, 1 / magnitude) : { ...vector };
}

function distanceSquared(first: Vector2, second: Vector2): number {
  return lengthSquared(subtract(first, second));
}
