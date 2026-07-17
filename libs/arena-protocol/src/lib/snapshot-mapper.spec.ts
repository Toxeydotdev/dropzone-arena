import { describe, expect, it } from 'vitest';

import {
  CLIENT_EVENTS,
  FullSnapshotSchema,
  MAX_EVENTS_PER_SNAPSHOT,
  MAX_INBOUND_MESSAGE_BYTES,
  MAX_PLAYERS_PER_ARENA,
  MAX_PROJECTILES_PER_SNAPSHOT,
  MAX_SNAPSHOT_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  SERVER_EVENTS,
  SequencedInputSchema,
  encodedEventByteLength,
  mapEngineSnapshotToWire,
  type EngineSnapshotEventSource,
  type EngineSnapshotPlayerSource,
  type EngineSnapshotProjectileSource,
  type EngineSnapshotSource,
  type SnapshotMappingContext,
} from '..';

const CONTEXT: SnapshotMappingContext = {
  arenaId: 'arena-01',
  buildId: '0123456789abcdef0123456789abcdef01234567',
  lastProcessedInputSequenceByPlayer: { 'player-00': 17 },
};

function createPlayer(index = 0): EngineSnapshotPlayerSource {
  return {
    aim: { x: 0.123_456, y: 0.5 },
    callsign: `Copper Falcon ${index}`,
    dashCooldownTicks: 135,
    dashTicks: 10,
    fireCooldownTicks: 8,
    health: 100,
    id: `player-${index.toString().padStart(2, '0')}`,
    position: { x: 1.234_56, y: -0.000_1 },
    radius: 0.480_4,
    respawnTicks: 0,
    spawnProtectionTicks: 60,
    statistics: { deaths: index, kills: index + 1 },
    status: 'alive',
    velocity: { x: -6.234_56, y: 2.345_67 },
  };
}

function createProjectile(index = 0): EngineSnapshotProjectileSource {
  return {
    damage: 25,
    id: index,
    ownerId: 'player-00',
    position: { x: -4.567_89, y: 3.456_78 },
    radius: 0.12,
    ttlTicks: 90,
    velocity: { x: 16.987_65, y: -0.000_1 },
  };
}

function createSource(
  overrides: Partial<EngineSnapshotSource> = {},
): EngineSnapshotSource {
  return {
    events: [],
    players: [createPlayer()],
    projectiles: [createProjectile()],
    tick: 1_234,
    ...overrides,
  };
}

function createAllEventTypes(): EngineSnapshotEventSource[] {
  const position = { x: 1.234_56, y: -2.345_67 };
  return [
    { playerId: 'player-00', position, tick: 10, type: 'dash' },
    {
      damage: 25,
      ownerId: 'player-00',
      position,
      projectileId: 1,
      targetId: 'player-01',
      tick: 11,
      type: 'hit',
    },
    {
      killerId: 'player-00',
      position,
      projectileId: 1,
      tick: 12,
      type: 'player-eliminated',
      victimId: 'player-01',
    },
    { playerId: 'player-01', position, tick: 13, type: 'player-joined' },
    { playerId: 'player-01', tick: 14, type: 'player-left' },
    { playerId: 'player-01', position, tick: 15, type: 'player-respawned' },
    {
      ownerId: 'player-00',
      position,
      projectileId: 2,
      tick: 16,
      type: 'shot',
    },
  ];
}

describe('engine snapshot to wire mapping', () => {
  it('maps a structural source, quantizes finite values, and carries prediction fields', () => {
    const snapshot = mapEngineSnapshotToWire(
      createSource({ events: createAllEventTypes() }),
      CONTEXT,
    );

    expect(snapshot.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(snapshot.arenaId).toBe(CONTEXT.arenaId);
    expect(snapshot.buildId).toBe(CONTEXT.buildId);
    expect(snapshot.tick).toBe(1_234);
    expect(snapshot.players[0]).toStrictEqual({
      aim: { x: 0.123, y: 0.5 },
      callsign: 'Copper Falcon 0',
      dashCooldownTicks: 135,
      dashTicks: 10,
      fireCooldownTicks: 8,
      health: 100,
      id: 'player-00',
      lastProcessedInputSequence: 17,
      position: { x: 1.235, y: 0 },
      radius: 0.48,
      respawnTicks: 0,
      spawnProtectionTicks: 60,
      statistics: { deaths: 0, kills: 1 },
      status: 'alive',
      velocity: { x: -6.235, y: 2.346 },
    });
    expect(snapshot.projectiles[0]).toStrictEqual({
      id: 0,
      ownerId: 'player-00',
      vx: 16.988,
      vy: 0,
      x: -4.568,
      y: 3.457,
    });
    expect(snapshot.events.map((event) => event.type)).toStrictEqual([
      'dash',
      'hit',
      'player-eliminated',
      'player-joined',
      'player-left',
      'player-respawned',
      'shot',
    ]);
    expect(snapshot.events[0]).toMatchObject({ x: 1.235, y: -2.346 });
    expect(FullSnapshotSchema.parse(snapshot)).toStrictEqual(snapshot);
  });

  it('whitelists wire fields and defaults missing acknowledgements to zero', () => {
    const player = { ...createPlayer(), internalOnly: 'player-state' };
    const projectile = { ...createProjectile(), internalOnly: 'projectile-state' };
    const source = {
      events: [],
      internalOnly: 'arena-state',
      nextProjectileId: 20,
      players: [player],
      projectiles: [projectile],
      randomState: 123,
      tick: 5,
    };
    const context = {
      arenaId: 'arena-01',
      buildId: 'build-01',
      internalOnly: 'mapping-state',
      lastProcessedInputSequenceByPlayer: {},
    };

    const snapshot = mapEngineSnapshotToWire(source, context);

    expect(snapshot.players[0]?.lastProcessedInputSequence).toBe(0);
    expect(snapshot).not.toHaveProperty('internalOnly');
    expect(snapshot).not.toHaveProperty('nextProjectileId');
    expect(snapshot).not.toHaveProperty('randomState');
    expect(snapshot.players[0]).not.toHaveProperty('internalOnly');
    expect(snapshot.projectiles[0]).not.toHaveProperty('internalOnly');
    expect(snapshot.projectiles[0]).not.toHaveProperty('damage');
    expect(snapshot.projectiles[0]).not.toHaveProperty('radius');
    expect(snapshot.projectiles[0]).not.toHaveProperty('ttlTicks');
  });

  it('uses own acknowledgement entries rather than inherited record properties', () => {
    const player = {
      ...createPlayer(),
      callsign: 'Copper Constructor',
      id: 'constructor',
    };
    const snapshot = mapEngineSnapshotToWire(
      createSource({ players: [player], projectiles: [] }),
      { ...CONTEXT, lastProcessedInputSequenceByPlayer: {} },
    );

    expect(snapshot.players[0]?.lastProcessedInputSequence).toBe(0);
  });

  it('retains only the newest bounded presentation events in source order', () => {
    const events: EngineSnapshotEventSource[] = Array.from(
      { length: MAX_EVENTS_PER_SNAPSHOT + 3 },
      (_, index) => ({
        playerId: 'player-00',
        position: { x: 0, y: 0 },
        tick: index,
        type: 'dash',
      }),
    );

    const snapshot = mapEngineSnapshotToWire(createSource({ events }), CONTEXT);

    expect(snapshot.events).toHaveLength(MAX_EVENTS_PER_SNAPSHOT);
    expect(snapshot.events.map((event) => event.tick)).toStrictEqual([
      3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('rejects non-finite and out-of-range source values before they reach the wire', () => {
    const invalidSources = [
      createSource({
        players: [{ ...createPlayer(), position: { x: Number.NaN, y: 0 } }],
      }),
      createSource({
        players: [
          { ...createPlayer(), velocity: { x: Number.POSITIVE_INFINITY, y: 0 } },
        ],
      }),
      createSource({
        players: [{ ...createPlayer(), aim: { x: 0.8, y: 0.8 } }],
      }),
      createSource({
        players: [{ ...createPlayer(), position: { x: 64.000_1, y: 0 } }],
      }),
      createSource({
        players: [{ ...createPlayer(), radius: Number.NEGATIVE_INFINITY }],
      }),
      createSource({
        projectiles: [
          { ...createProjectile(), position: { x: 0, y: Number.POSITIVE_INFINITY } },
        ],
      }),
      createSource({
        projectiles: [{ ...createProjectile(), velocity: { x: -64.001, y: 0 } }],
      }),
      createSource({ tick: Number.NaN }),
    ];

    for (const source of invalidSources) {
      expect(() => mapEngineSnapshotToWire(source, CONTEXT)).toThrow(
        /finite|between|magnitude|NaN/,
      );
    }
  });

  it('rejects invalid source records after mapping instead of coercing them', () => {
    expect(() =>
      mapEngineSnapshotToWire(
        createSource({ players: [{ ...createPlayer(), health: 100.5 }] }),
        CONTEXT,
      ),
    ).toThrow(/expected int/);
    expect(() =>
      mapEngineSnapshotToWire(
        createSource({ players: [{ ...createPlayer(), id: 'bad/id' }] }),
        CONTEXT,
      ),
    ).toThrow(/must match pattern/);
    expect(() =>
      mapEngineSnapshotToWire(
        createSource({ tick: Number.MAX_SAFE_INTEGER + 1 }),
        CONTEXT,
      ),
    ).toThrow(/Too big/);
    expect(() =>
      mapEngineSnapshotToWire(createSource(), {
        ...CONTEXT,
        lastProcessedInputSequenceByPlayer: { 'player-00': 0x1_0000_0000 },
      }),
    ).toThrow(/Too big/);
  });
});

describe('snapshot entity and byte boundaries', () => {
  it('accepts exactly eight players and rejects a ninth before mapping work', () => {
    const players = Array.from({ length: MAX_PLAYERS_PER_ARENA }, (_, index) =>
      createPlayer(index),
    );
    const snapshot = mapEngineSnapshotToWire(
      createSource({ players, projectiles: [] }),
      CONTEXT,
    );
    expect(snapshot.players).toHaveLength(MAX_PLAYERS_PER_ARENA);

    expect(() =>
      mapEngineSnapshotToWire(
        createSource({ players: [...players, createPlayer(MAX_PLAYERS_PER_ARENA)] }),
        CONTEXT,
      ),
    ).toThrow(RangeError);
    expect(
      FullSnapshotSchema.safeParse({
        ...snapshot,
        players: [...snapshot.players, createPlayer(MAX_PLAYERS_PER_ARENA)],
      }).success,
    ).toBe(false);
  });

  it('accepts exactly 96 projectiles and rejects a 97th before mapping work', () => {
    const projectiles = Array.from(
      { length: MAX_PROJECTILES_PER_SNAPSHOT },
      (_, index) => createProjectile(index),
    );
    const snapshot = mapEngineSnapshotToWire(createSource({ projectiles }), CONTEXT);
    expect(snapshot.projectiles).toHaveLength(MAX_PROJECTILES_PER_SNAPSHOT);

    expect(() =>
      mapEngineSnapshotToWire(
        createSource({
          projectiles: [...projectiles, createProjectile(MAX_PROJECTILES_PER_SNAPSHOT)],
        }),
        CONTEXT,
      ),
    ).toThrow(RangeError);
    expect(
      FullSnapshotSchema.safeParse({
        ...snapshot,
        projectiles: [
          ...snapshot.projectiles,
          { ...snapshot.projectiles[0], id: MAX_PROJECTILES_PER_SNAPSHOT },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a directly supplied ninth event while the mapper bounds source events', () => {
    const snapshot = mapEngineSnapshotToWire(
      createSource({
        events: Array.from({ length: MAX_EVENTS_PER_SNAPSHOT }, (_, index) => ({
          playerId: 'player-00',
          position: { x: 0, y: 0 },
          tick: index,
          type: 'dash' as const,
        })),
      }),
      CONTEXT,
    );
    expect(snapshot.events).toHaveLength(MAX_EVENTS_PER_SNAPSHOT);
    expect(
      FullSnapshotSchema.safeParse({
        ...snapshot,
        events: [...snapshot.events, snapshot.events[0]],
      }).success,
    ).toBe(false);
  });

  it('keeps a representative maximum snapshot within the encoded 12 KiB budget', () => {
    const players = Array.from({ length: MAX_PLAYERS_PER_ARENA }, (_, index) =>
      createPlayer(index),
    );
    const projectiles = Array.from(
      { length: MAX_PROJECTILES_PER_SNAPSHOT },
      (_, index) => ({
        ...createProjectile(index),
        ownerId: players[index % players.length]?.id ?? 'player-00',
      }),
    );
    const events: EngineSnapshotEventSource[] = Array.from(
      { length: MAX_EVENTS_PER_SNAPSHOT },
      (_, index) => ({
        killerId: players[index]?.id ?? 'player-00',
        position: { x: -12.345, y: 12.345 },
        projectileId: index,
        tick: 999_999,
        type: 'player-eliminated',
        victimId: players[(index + 1) % players.length]?.id ?? 'player-01',
      }),
    );
    const lastProcessedInputSequenceByPlayer = Object.fromEntries(
      players.map((player, index) => [player.id, 10_000 + index]),
    );

    const snapshot = mapEngineSnapshotToWire(
      createSource({ events, players, projectiles, tick: 999_999 }),
      { ...CONTEXT, lastProcessedInputSequenceByPlayer },
    );
    const encodedBytes = encodedEventByteLength(SERVER_EVENTS.SNAPSHOT, snapshot);

    expect(snapshot.players).toHaveLength(MAX_PLAYERS_PER_ARENA);
    expect(snapshot.projectiles).toHaveLength(MAX_PROJECTILES_PER_SNAPSHOT);
    expect(snapshot.events).toHaveLength(MAX_EVENTS_PER_SNAPSHOT);
    expect(encodedBytes).toBeLessThanOrEqual(MAX_SNAPSHOT_MESSAGE_BYTES);
    expect(
      FullSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot))),
    ).toStrictEqual(snapshot);
  });

  it('rejects a count-valid snapshot whose encoded identifiers exceed the byte budget', () => {
    const players = Array.from({ length: MAX_PLAYERS_PER_ARENA }, (_, index) =>
      createPlayer(index),
    );
    const projectiles = Array.from(
      { length: MAX_PROJECTILES_PER_SNAPSHOT },
      (_, index) => createProjectile(index),
    );
    const snapshot = mapEngineSnapshotToWire(
      createSource({ players, projectiles }),
      CONTEXT,
    );
    const bloated = {
      ...snapshot,
      arenaId: 'a'.repeat(64),
      buildId: 'b'.repeat(64),
      players: snapshot.players.map((player, index) => ({
        ...player,
        callsign: `${String.fromCharCode(65 + index)}${'x'.repeat(31)}`,
        id: `p${index}${'x'.repeat(62)}`,
      })),
      projectiles: snapshot.projectiles.map((projectile) => ({
        ...projectile,
        ownerId: 'o'.repeat(64),
      })),
    };

    expect(encodedEventByteLength(SERVER_EVENTS.SNAPSHOT, bloated)).toBeGreaterThan(
      MAX_SNAPSHOT_MESSAGE_BYTES,
    );
    const result = FullSnapshotSchema.safeParse(bloated);
    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues.some((issue) => issue.message.includes('12 KiB'))).toBe(true);
  });

  it('keeps the largest valid sequenced input inside the 8 KiB inbound budget', () => {
    const input = SequencedInputSchema.parse({
      aim: { x: -1, y: 0 },
      dash: true,
      firing: true,
      move: { x: 0, y: 1 },
      protocolVersion: PROTOCOL_VERSION,
      sequence: 0xffff_ffff,
    });

    expect(encodedEventByteLength(CLIENT_EVENTS.INPUT, input)).toBeLessThanOrEqual(
      MAX_INBOUND_MESSAGE_BYTES,
    );
  });
});
