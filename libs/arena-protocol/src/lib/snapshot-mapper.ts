import {
  FullSnapshotSchema,
  MAX_EVENTS_PER_SNAPSHOT,
  MAX_PLAYERS_PER_ARENA,
  MAX_PROJECTILES_PER_SNAPSHOT,
  MAX_WORLD_COORDINATE,
  MAX_WORLD_VELOCITY,
  PROTOCOL_VERSION,
  WIRE_QUANTIZATION_DECIMALS,
  type FullSnapshot,
  type SnapshotEvent,
} from './protocol';

export interface EngineSnapshotVectorSource {
  readonly x: number;
  readonly y: number;
}

export interface EngineSnapshotPlayerSource {
  readonly aim: EngineSnapshotVectorSource;
  readonly callsign: string;
  readonly dashCooldownTicks: number;
  readonly dashTicks: number;
  readonly fireCooldownTicks: number;
  readonly health: number;
  readonly id: string;
  readonly position: EngineSnapshotVectorSource;
  readonly radius: number;
  readonly respawnTicks: number;
  readonly spawnProtectionTicks: number;
  readonly statistics: {
    readonly deaths: number;
    readonly kills: number;
  };
  readonly status: 'alive' | 'eliminated';
  readonly velocity: EngineSnapshotVectorSource;
}

export interface EngineSnapshotProjectileSource {
  readonly damage: number;
  readonly id: number;
  readonly ownerId: string;
  readonly position: EngineSnapshotVectorSource;
  readonly radius: number;
  readonly ttlTicks: number;
  readonly velocity: EngineSnapshotVectorSource;
}

export type EngineSnapshotEventSource =
  | {
      readonly playerId: string;
      readonly position: EngineSnapshotVectorSource;
      readonly tick: number;
      readonly type: 'dash';
    }
  | {
      readonly damage: number;
      readonly ownerId: string;
      readonly position: EngineSnapshotVectorSource;
      readonly projectileId: number;
      readonly targetId: string;
      readonly tick: number;
      readonly type: 'hit';
    }
  | {
      readonly killerId: string;
      readonly position: EngineSnapshotVectorSource;
      readonly projectileId: number;
      readonly tick: number;
      readonly type: 'player-eliminated';
      readonly victimId: string;
    }
  | {
      readonly playerId: string;
      readonly position: EngineSnapshotVectorSource;
      readonly tick: number;
      readonly type: 'player-joined';
    }
  | {
      readonly playerId: string;
      readonly tick: number;
      readonly type: 'player-left';
    }
  | {
      readonly playerId: string;
      readonly position: EngineSnapshotVectorSource;
      readonly tick: number;
      readonly type: 'player-respawned';
    }
  | {
      readonly ownerId: string;
      readonly position: EngineSnapshotVectorSource;
      readonly projectileId: number;
      readonly tick: number;
      readonly type: 'shot';
    };

export interface EngineSnapshotSource {
  readonly events: readonly EngineSnapshotEventSource[];
  readonly players: readonly EngineSnapshotPlayerSource[];
  readonly projectiles: readonly EngineSnapshotProjectileSource[];
  readonly tick: number;
}

export interface SnapshotMappingContext {
  readonly arenaId: string;
  readonly buildId: string;
  readonly lastProcessedInputSequenceByPlayer: Readonly<
    Record<string, number | undefined>
  >;
}

const QUANTIZATION_FACTOR = 10 ** WIRE_QUANTIZATION_DECIMALS;

function quantizeFinite(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new TypeError('Snapshot numbers must be finite.');
  if (value < minimum || value > maximum) {
    throw new RangeError(`Snapshot number must be between ${minimum} and ${maximum}.`);
  }

  const quantized =
    (Math.sign(value) * Math.round(Math.abs(value) * QUANTIZATION_FACTOR)) /
    QUANTIZATION_FACTOR;
  if (!Number.isFinite(quantized))
    throw new RangeError('Quantized snapshot number overflowed.');
  return Object.is(quantized, -0) ? 0 : quantized;
}

function mapPosition(vector: EngineSnapshotVectorSource) {
  return {
    x: quantizeFinite(vector.x, -MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
    y: quantizeFinite(vector.y, -MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
  };
}

function mapVelocity(vector: EngineSnapshotVectorSource) {
  return {
    x: quantizeFinite(vector.x, -MAX_WORLD_VELOCITY, MAX_WORLD_VELOCITY),
    y: quantizeFinite(vector.y, -MAX_WORLD_VELOCITY, MAX_WORLD_VELOCITY),
  };
}

function mapDirection(vector: EngineSnapshotVectorSource) {
  if (vector.x * vector.x + vector.y * vector.y > 1 + Number.EPSILON * 4) {
    throw new RangeError('Snapshot direction magnitude cannot exceed 1.');
  }

  return {
    x: quantizeFinite(vector.x, -1, 1),
    y: quantizeFinite(vector.y, -1, 1),
  };
}

function mapEvent(event: EngineSnapshotEventSource): SnapshotEvent {
  switch (event.type) {
    case 'dash': {
      const position = mapPosition(event.position);
      return {
        playerId: event.playerId,
        tick: event.tick,
        type: event.type,
        ...position,
      };
    }
    case 'hit': {
      const position = mapPosition(event.position);
      return {
        damage: event.damage,
        ownerId: event.ownerId,
        projectileId: event.projectileId,
        targetId: event.targetId,
        tick: event.tick,
        type: event.type,
        ...position,
      };
    }
    case 'player-eliminated': {
      const position = mapPosition(event.position);
      return {
        killerId: event.killerId,
        projectileId: event.projectileId,
        tick: event.tick,
        type: event.type,
        victimId: event.victimId,
        ...position,
      };
    }
    case 'player-joined':
    case 'player-respawned': {
      const position = mapPosition(event.position);
      return {
        playerId: event.playerId,
        tick: event.tick,
        type: event.type,
        ...position,
      };
    }
    case 'player-left':
      return { playerId: event.playerId, tick: event.tick, type: event.type };
    case 'shot': {
      const position = mapPosition(event.position);
      return {
        ownerId: event.ownerId,
        projectileId: event.projectileId,
        tick: event.tick,
        type: event.type,
        ...position,
      };
    }
  }
}

export function mapEngineSnapshotToWire(
  source: EngineSnapshotSource,
  context: SnapshotMappingContext,
): FullSnapshot {
  if (source.players.length > MAX_PLAYERS_PER_ARENA) {
    throw new RangeError(
      `Snapshot cannot contain more than ${MAX_PLAYERS_PER_ARENA} players.`,
    );
  }
  if (source.projectiles.length > MAX_PROJECTILES_PER_SNAPSHOT) {
    throw new RangeError(
      `Snapshot cannot contain more than ${MAX_PROJECTILES_PER_SNAPSHOT} projectiles.`,
    );
  }

  const events = source.events.slice(-MAX_EVENTS_PER_SNAPSHOT).map(mapEvent);
  const snapshot = {
    arenaId: context.arenaId,
    buildId: context.buildId,
    events,
    players: source.players.map((player) => ({
      aim: mapDirection(player.aim),
      callsign: player.callsign,
      dashCooldownTicks: player.dashCooldownTicks,
      dashTicks: player.dashTicks,
      fireCooldownTicks: player.fireCooldownTicks,
      health: player.health,
      id: player.id,
      lastProcessedInputSequence: Object.hasOwn(
        context.lastProcessedInputSequenceByPlayer,
        player.id,
      )
        ? (context.lastProcessedInputSequenceByPlayer[player.id] ?? 0)
        : 0,
      position: mapPosition(player.position),
      radius: quantizeFinite(player.radius, 0.001, 4),
      respawnTicks: player.respawnTicks,
      spawnProtectionTicks: player.spawnProtectionTicks,
      statistics: {
        deaths: player.statistics.deaths,
        kills: player.statistics.kills,
      },
      status: player.status,
      velocity: mapVelocity(player.velocity),
    })),
    projectiles: source.projectiles.map((projectile) => ({
      id: projectile.id,
      ownerId: projectile.ownerId,
      vx: quantizeFinite(
        projectile.velocity.x,
        -MAX_WORLD_VELOCITY,
        MAX_WORLD_VELOCITY,
      ),
      vy: quantizeFinite(
        projectile.velocity.y,
        -MAX_WORLD_VELOCITY,
        MAX_WORLD_VELOCITY,
      ),
      x: quantizeFinite(
        projectile.position.x,
        -MAX_WORLD_COORDINATE,
        MAX_WORLD_COORDINATE,
      ),
      y: quantizeFinite(
        projectile.position.y,
        -MAX_WORLD_COORDINATE,
        MAX_WORLD_COORDINATE,
      ),
    })),
    protocolVersion: PROTOCOL_VERSION,
    tick: source.tick,
  };

  return FullSnapshotSchema.parse(snapshot);
}
