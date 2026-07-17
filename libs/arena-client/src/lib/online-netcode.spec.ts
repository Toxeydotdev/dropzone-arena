import { describe, expect, it } from 'vitest';

import {
  FFA_COLLISION_WORLD,
  FFA_FIXED_STEP_SECONDS,
  stepFfaPlayerMotion,
  type FfaPlayerState,
} from '@dropzone-arena/arena-engine';
import {
  FullSnapshotSchema,
  INPUT_RATE_HZ,
  PROTOCOL_VERSION,
  SequencedInputSchema,
  SIMULATION_RATE_HZ,
  type FullSnapshot,
  type SnapshotEvent,
  type SnapshotPlayer,
  type SnapshotProjectile,
} from '@dropzone-arena/arena-protocol';

import type { ArenaControlState } from './arena-input-controller';
import { OnlineNetcode } from './online-netcode';

const STEP_MS = 1_000 / SIMULATION_RATE_HZ;
const ACTIVE_INPUT: ArenaControlState = {
  aim: { x: 1, y: 0 },
  dash: false,
  firing: false,
  move: { x: 1, y: 0 },
};
const NEUTRAL_INPUT: ArenaControlState = {
  aim: { x: 0, y: -1 },
  dash: false,
  firing: false,
  move: { x: 0, y: 0 },
};

describe('OnlineNetcode', () => {
  it('predicts at fixed 60 Hz while emitting protocol-valid input at 30 Hz', () => {
    const initialPlayer = createPlayer('alpha', {
      position: { x: -10, y: 9 },
    });
    const netcode = createNetcode();
    expect(
      netcode.acceptSnapshot(0, createSnapshot(0, { players: [initialPlayer] })),
    ).toBe('accepted');

    const packetTimes: number[] = [];
    const packets = [];
    netcode.advance(0, ACTIVE_INPUT);
    let update = netcode.advance(0, ACTIVE_INPUT);
    for (let step = 1; step <= SIMULATION_RATE_HZ; step += 1) {
      const timeMs = step * STEP_MS;
      update = netcode.advance(timeMs, ACTIVE_INPUT);
      for (const packet of update.packets) {
        packets.push(packet);
        packetTimes.push(timeMs);
      }
    }

    expect(packets).toHaveLength(INPUT_RATE_HZ);
    expect(packets.map((packet) => packet.sequence)).toEqual(
      Array.from({ length: INPUT_RATE_HZ }, (_, index) => index * 2 + 1),
    );
    for (const packet of packets) {
      expect(SequencedInputSchema.parse(packet)).toStrictEqual(packet);
    }
    for (let index = 1; index < packetTimes.length; index += 1) {
      expect((packetTimes[index] ?? 0) - (packetTimes[index - 1] ?? 0)).toBeCloseTo(
        1_000 / INPUT_RATE_HZ,
      );
    }

    let expected: FfaPlayerState = cloneAsFfaPlayer(initialPlayer);
    for (let step = 0; step < SIMULATION_RATE_HZ; step += 1) {
      expected = stepFfaPlayerMotion(
        expected,
        ACTIVE_INPUT,
        FFA_COLLISION_WORLD,
        FFA_FIXED_STEP_SECONDS,
      );
    }
    expect(update.localPlayer?.position.x).toBeCloseTo(expected.position.x, 10);
    expect(update.localPlayer?.position.y).toBeCloseTo(expected.position.y, 10);
    expect(update.localPlayer?.velocity.x).toBeCloseTo(expected.velocity.x, 10);
  });

  it('prioritizes dash and neutral packets immediately without permitting a priority flood', () => {
    const netcode = createNetcode();
    netcode.acceptSnapshot(0, createSnapshot(0));

    netcode.advance(0, ACTIVE_INPUT);
    const regular = netcode.advance(STEP_MS, ACTIVE_INPUT).packets;
    const dash = netcode.advance(STEP_MS + 1, {
      ...ACTIVE_INPUT,
      dash: true,
    }).packets;
    expect(netcode.advance(STEP_MS + 2, ACTIVE_INPUT).packets).toHaveLength(0);
    const neutral = netcode.advance(STEP_MS + 3, NEUTRAL_INPUT).packets;
    const interruption = netcode.reset(STEP_MS + 4, 'interruption');

    expect(regular).toMatchObject([{ dash: false, sequence: 1 }]);
    expect(dash).toMatchObject([{ dash: true, sequence: 2 }]);
    expect(neutral).toMatchObject([
      {
        dash: false,
        firing: false,
        move: { x: 0, y: 0 },
        sequence: 3,
      },
    ]);
    expect(interruption).toMatchObject({
      dash: false,
      firing: false,
      move: { x: 0, y: 0 },
      sequence: 4,
    });
    for (const packet of [...regular, ...dash, ...neutral, interruption]) {
      expect(SequencedInputSchema.safeParse(packet).success).toBe(true);
    }

    const bounded = createNetcode();
    bounded.acceptSnapshot(0, createSnapshot(0));
    const priorityPackets = [];
    for (let index = 0; index < 80; index += 1) {
      const update = bounded.advance(0, {
        ...NEUTRAL_INPUT,
        dash: index % 2 === 0,
      });
      priorityPackets.push(...update.packets);
    }
    expect(priorityPackets).toHaveLength(INPUT_RATE_HZ);
  });

  it('resets to authority, discards acknowledged steps, and replays only newer 60 Hz history', () => {
    const netcode = createNetcode({ reducedMotion: true });
    const initial = createPlayer('alpha', {
      position: { x: -8, y: 9 },
      velocity: { x: 0, y: 0 },
    });
    netcode.acceptSnapshot(0, createSnapshot(0, { players: [initial] }));
    netcode.advance(0, ACTIVE_INPUT);
    for (let step = 1; step <= 6; step += 1) {
      netcode.advance(step * STEP_MS, ACTIVE_INPUT);
    }

    const authority = createPlayer('alpha', {
      lastProcessedInputSequence: 3,
      position: { x: -7.8, y: 9 },
      velocity: { x: 1, y: 0 },
    });
    expect(
      netcode.acceptSnapshot(
        6 * STEP_MS + 1,
        createSnapshot(3, { players: [authority] }),
      ),
    ).toBe('accepted');
    const reconciled = netcode.advance(6 * STEP_MS + 1, ACTIVE_INPUT).localPlayer;

    let expected: FfaPlayerState = cloneAsFfaPlayer(authority);
    for (let step = 0; step < 3; step += 1) {
      expected = stepFfaPlayerMotion(expected, ACTIVE_INPUT);
    }
    expect(reconciled?.position.x).toBeCloseTo(expected.position.x, 10);
    expect(reconciled?.velocity.x).toBeCloseTo(expected.velocity.x, 10);
    expect(reconciled?.lastProcessedInputSequence).toBe(3);
  });

  it('bounds sequence-tagged prediction history and the authoritative snapshot buffer', () => {
    const netcode = createNetcode({ reducedMotion: true });
    const authority = createPlayer('alpha', {
      position: { x: -10, y: 9 },
    });
    netcode.acceptSnapshot(0, createSnapshot(0, { players: [authority] }));
    netcode.advance(0, ACTIVE_INPUT);
    for (let step = 1; step <= 130; step += 1) {
      netcode.advance(step * STEP_MS, ACTIVE_INPUT);
    }

    const reconciliationTime = 130 * STEP_MS + 1;
    netcode.acceptSnapshot(
      reconciliationTime,
      createSnapshot(3, { players: [authority] }),
    );
    const reconciled = netcode.advance(reconciliationTime, ACTIVE_INPUT).localPlayer;
    let expected: FfaPlayerState = cloneAsFfaPlayer(authority);
    for (let step = 0; step < 120; step += 1) {
      expected = stepFfaPlayerMotion(expected, ACTIVE_INPUT);
    }
    expect(reconciled?.position.x).toBeCloseTo(expected.position.x, 10);

    for (let index = 2; index <= 12; index += 1) {
      netcode.acceptSnapshot(
        reconciliationTime + index,
        createSnapshot(index * 3, {
          players: [
            createPlayer('alpha', {
              lastProcessedInputSequence: 0,
              position: { x: -10, y: 9 },
            }),
          ],
        }),
      );
    }
    const internals = netcode as unknown as {
      predictionHistory: Array<{ sequence: number }>;
      snapshots: unknown[];
    };
    expect(internals.predictionHistory).toHaveLength(120);
    expect(internals.snapshots).toHaveLength(8);
    expect(
      internals.predictionHistory.every(
        (entry, index, entries) =>
          index === 0 || entry.sequence > (entries[index - 1]?.sequence ?? 0),
      ),
    ).toBe(true);
  });

  it('rejects stale, duplicate, and foreign-arena snapshots without replacing authority', () => {
    const netcode = createNetcode({ reducedMotion: true });
    netcode.acceptSnapshot(
      0,
      createSnapshot(10, {
        players: [createPlayer('alpha', { health: 90, position: { x: 1, y: 0 } })],
      }),
    );
    expect(
      netcode.acceptSnapshot(
        50,
        createSnapshot(13, {
          players: [createPlayer('alpha', { health: 80, position: { x: 2, y: 0 } })],
        }),
      ),
    ).toBe('accepted');
    expect(
      netcode.acceptSnapshot(
        51,
        createSnapshot(12, {
          players: [createPlayer('alpha', { health: 1, position: { x: 9, y: 0 } })],
        }),
      ),
    ).toBe('stale');
    expect(
      netcode.acceptSnapshot(
        52,
        createSnapshot(13, {
          players: [createPlayer('alpha', { health: 1, position: { x: 9, y: 0 } })],
        }),
      ),
    ).toBe('duplicate');
    expect(
      netcode.acceptSnapshot(
        53,
        createSnapshot(99, {
          arenaId: 'arena-foreign',
          players: [createPlayer('alpha', { health: 1, position: { x: 9, y: 0 } })],
        }),
      ),
    ).toBe('foreign');

    expect(netcode.samplePresentation(54).localPlayer).toMatchObject({
      health: 80,
      position: { x: 2, y: 0 },
    });
  });

  it('interpolates through jitter and a missing snapshot, then bounds extrapolation and holds delayed', () => {
    const netcode = createNetcode({ reducedMotion: true });
    netcode.acceptSnapshot(0, movingWorldSnapshot(0));
    const beforeLateSnapshot = netcode.samplePresentation(119);
    netcode.acceptSnapshot(120, movingWorldSnapshot(3));
    const afterLateSnapshot = netcode.samplePresentation(120);
    expect(afterLateSnapshot.presentationTick).toBeCloseTo(
      beforeLateSnapshot.presentationTick ?? 0,
    );
    expect(afterLateSnapshot.remotePlayers[0]?.position.x).toBeCloseTo(
      beforeLateSnapshot.remotePlayers[0]?.position.x ?? 0,
    );
    netcode.acceptSnapshot(205, movingWorldSnapshot(9));

    const interpolated = netcode.samplePresentation(255);
    expect(interpolated.presentationTick).toBeCloseTo(6);
    expect(interpolated.remotePlayers[0]?.position.x).toBeCloseTo(6);
    expect(interpolated.projectiles[0]?.x).toBeCloseTo(6);
    expect(interpolated.delayed).toBe(false);

    const extrapolationLimit = netcode.samplePresentation(405);
    expect(extrapolationLimit.presentationTick).toBeCloseTo(15);
    expect(extrapolationLimit.remotePlayers[0]?.position.x).toBeCloseTo(15);
    expect(extrapolationLimit.projectiles[0]?.x).toBeCloseTo(15);
    expect(extrapolationLimit.delayed).toBe(false);

    const delayed = netcode.samplePresentation(406);
    expect(delayed.delayed).toBe(true);
    expect(delayed.remotePlayers[0]?.position.x).toBeCloseTo(15);
    expect(delayed.projectiles[0]?.x).toBeCloseTo(15);
    const held = netcode.samplePresentation(650);
    expect(held.delayed).toBe(true);
    expect(held.remotePlayers[0]?.position.x).toBeCloseTo(15);
    expect(held.projectiles[0]?.x).toBeCloseTo(15);
  });

  it('blends sub-two-unit local corrections for 100 ms and snaps larger corrections', () => {
    const netcode = createNetcode();
    netcode.acceptSnapshot(0, createSnapshot(0));
    netcode.acceptSnapshot(
      50,
      createSnapshot(3, {
        players: [createPlayer('alpha', { position: { x: 1, y: 0 } })],
      }),
    );

    expect(netcode.samplePresentation(50).localPlayer?.position.x).toBeCloseTo(0);
    expect(netcode.samplePresentation(100).localPlayer?.position.x).toBeCloseTo(0.5);
    expect(netcode.samplePresentation(150).localPlayer?.position.x).toBeCloseTo(1);

    netcode.acceptSnapshot(
      160,
      createSnapshot(6, {
        players: [createPlayer('alpha', { position: { x: 4, y: 0 } })],
      }),
    );
    expect(netcode.samplePresentation(160).localPlayer?.position.x).toBe(4);
  });

  it('uses the shared FFA collision world for local obstacle prediction', () => {
    const obstacle = FFA_COLLISION_WORLD.obstacles[0];
    if (!obstacle) throw new Error('Expected the fixed FFA obstacle.');
    const player = createPlayer('alpha', {
      position: {
        x: obstacle.x - obstacle.halfWidth - 0.48 - 0.01,
        y: obstacle.y,
      },
    });
    const netcode = createNetcode({ reducedMotion: true });
    netcode.acceptSnapshot(0, createSnapshot(0, { players: [player] }));
    netcode.advance(0, ACTIVE_INPUT);
    const predicted = netcode.advance(STEP_MS, {
      ...ACTIVE_INPUT,
      dash: true,
    }).localPlayer;

    expect(predicted?.position.x).toBeCloseTo(
      obstacle.x - obstacle.halfWidth - player.radius,
    );
    expect(predicted?.position.y).toBeCloseTo(obstacle.y);
  });

  it('snaps and resets prediction across elimination and authoritative respawn', () => {
    const netcode = createNetcode();
    netcode.acceptSnapshot(0, createSnapshot(0));
    netcode.advance(0, ACTIVE_INPUT);
    for (let step = 1; step <= 4; step += 1) {
      netcode.advance(step * STEP_MS, ACTIVE_INPUT);
    }

    const eliminationTime = 4 * STEP_MS + 1;
    const eliminated = createPlayer('alpha', {
      health: 0,
      position: { x: 1, y: 0 },
      respawnTicks: 180,
      spawnProtectionTicks: 0,
      statistics: { deaths: 1, kills: 2 },
      status: 'eliminated',
      velocity: { x: 0, y: 0 },
    });
    netcode.acceptSnapshot(
      eliminationTime,
      createSnapshot(3, {
        events: [eliminationEvent(3)],
        players: [eliminated],
      }),
    );
    expect(netcode.samplePresentation(eliminationTime).localPlayer).toMatchObject({
      health: 0,
      position: { x: 1, y: 0 },
      respawnTicks: 180,
      statistics: { deaths: 1, kills: 2 },
      status: 'eliminated',
    });

    for (let step = 1; step <= 180; step += 1) {
      netcode.advance(eliminationTime + step * STEP_MS, ACTIVE_INPUT);
    }
    expect(
      netcode.samplePresentation(eliminationTime + 180 * STEP_MS).localPlayer,
    ).toMatchObject({
      health: 0,
      position: { x: 1, y: 0 },
      respawnTicks: 180,
      status: 'eliminated',
    });

    const respawnTime = eliminationTime + 180 * STEP_MS + 1;
    const respawned = createPlayer('alpha', {
      health: 100,
      position: { x: -8, y: 8 },
      spawnProtectionTicks: 60,
      statistics: { deaths: 1, kills: 2 },
    });
    netcode.acceptSnapshot(
      respawnTime,
      createSnapshot(183, {
        events: [respawnEvent(183)],
        players: [respawned],
      }),
    );
    expect(netcode.samplePresentation(respawnTime).localPlayer).toMatchObject({
      health: 100,
      position: { x: -8, y: 8 },
      spawnProtectionTicks: 60,
      statistics: { deaths: 1, kills: 2 },
      status: 'alive',
    });
  });

  it('clears correction and rebases sequence state for reconnect', () => {
    const reduced = createNetcode();
    reduced.acceptSnapshot(0, createSnapshot(0));
    reduced.acceptSnapshot(
      50,
      createSnapshot(3, {
        players: [createPlayer('alpha', { position: { x: 1, y: 0 } })],
      }),
    );
    expect(reduced.samplePresentation(50).localPlayer?.position.x).toBeCloseTo(0);
    reduced.setReducedMotion(true);
    expect(reduced.samplePresentation(50).localPlayer?.position.x).toBe(1);

    const reconnecting = createNetcode();
    reconnecting.acceptSnapshot(
      0,
      createSnapshot(30, {
        players: [createPlayer('alpha'), createPlayer('bravo')],
      }),
    );
    reconnecting.advance(0, ACTIVE_INPUT);
    let priorSequence = 0;
    for (let step = 1; step <= 4; step += 1) {
      for (const packet of reconnecting.advance(step * STEP_MS, ACTIVE_INPUT).packets) {
        priorSequence = packet.sequence;
      }
    }
    const resetTime = 4 * STEP_MS + 1;
    expect(reconnecting.reset(resetTime, 'reconnect')).toBeNull();
    expect(reconnecting.samplePresentation(resetTime)).toMatchObject({
      delayed: true,
      localPlayer: null,
      projectiles: [],
      remotePlayers: [],
    });
    expect(reconnecting.advance(resetTime + 100, ACTIVE_INPUT)).toEqual({
      localPlayer: null,
      packets: [],
    });

    const freshTime = resetTime + 100;
    expect(
      reconnecting.acceptSnapshot(
        freshTime,
        createSnapshot(1, {
          players: [createPlayer('alpha', { position: { x: 9, y: 9 } })],
        }),
      ),
    ).toBe('accepted');
    expect(reconnecting.samplePresentation(freshTime).localPlayer?.position).toEqual({
      x: 9,
      y: 9,
    });
    const resumed = reconnecting.advance(freshTime + STEP_MS, ACTIVE_INPUT);
    expect(priorSequence).toBeGreaterThan(0);
    expect(resumed.packets[0]?.sequence).toBe(1);
    expect(SequencedInputSchema.safeParse(resumed.packets[0]).success).toBe(true);
  });

  it('rebases a reconnect after more than the maximum accepted sequence gap', () => {
    const netcode = createNetcode({ reducedMotion: true });
    netcode.acceptSnapshot(0, createSnapshot(0));
    netcode.advance(0, ACTIVE_INPUT);
    for (let step = 1; step <= 120; step += 1) {
      netcode.advance(step * STEP_MS, ACTIVE_INPUT);
    }

    const resetTime = 120 * STEP_MS + 1;
    netcode.reset(resetTime, 'reconnect');
    const reconnectTime = resetTime + 100;
    netcode.acceptSnapshot(
      reconnectTime,
      createSnapshot(10, {
        players: [createPlayer('alpha', { lastProcessedInputSequence: 3 })],
      }),
    );

    const resumed = netcode.advance(reconnectTime + STEP_MS, ACTIVE_INPUT);
    expect(resumed.packets[0]?.sequence).toBe(4);
    expect(SequencedInputSchema.safeParse(resumed.packets[0]).success).toBe(true);
  });

  it('changes only local motion fields and leaves every authority-only fact untouched', () => {
    const local = createPlayer('alpha', {
      callsign: 'ALPHA PRIME',
      fireCooldownTicks: 7,
      health: 73,
      radius: 0.48,
      spawnProtectionTicks: 45,
      statistics: { deaths: 2, kills: 4 },
    });
    const projectile: SnapshotProjectile = {
      id: 17,
      ownerId: 'bravo',
      vx: -4,
      vy: 0,
      x: 3,
      y: 2,
    };
    const snapshot = createSnapshot(0, {
      players: [local, createPlayer('bravo')],
      projectiles: [projectile],
    });
    expect(FullSnapshotSchema.safeParse(snapshot).success).toBe(true);
    const untouchedSnapshot = structuredClone(snapshot);
    const netcode = createNetcode({ reducedMotion: true });
    netcode.acceptSnapshot(0, snapshot);

    const attackingInput: ArenaControlState = {
      aim: { x: 1, y: 0 },
      dash: true,
      firing: true,
      move: { x: 1, y: 0 },
    };
    netcode.advance(0, attackingInput);
    let update = netcode.advance(0, attackingInput);
    for (let step = 1; step <= 20; step += 1) {
      update = netcode.advance(step * STEP_MS, {
        ...attackingInput,
        dash: false,
      });
    }

    expect(update.localPlayer).toMatchObject({
      callsign: 'ALPHA PRIME',
      fireCooldownTicks: 7,
      health: 73,
      lastProcessedInputSequence: 0,
      radius: 0.48,
      respawnTicks: 0,
      spawnProtectionTicks: 45,
      statistics: { deaths: 2, kills: 4 },
      status: 'alive',
    });
    expect(update.localPlayer?.dashCooldownTicks).toBeGreaterThan(0);
    expect(snapshot).toStrictEqual(untouchedSnapshot);
    const presentation = netcode.samplePresentation(20 * STEP_MS);
    expect(presentation.projectiles).toHaveLength(1);
    expect(presentation.projectiles[0]?.id).toBe(17);
    expect(presentation.localPlayer).toMatchObject({
      health: 73,
      statistics: { deaths: 2, kills: 4 },
      status: 'alive',
    });
  });
});

function createNetcode(overrides: Partial<{ reducedMotion: boolean }> = {}) {
  return new OnlineNetcode({
    arenaId: 'arena-one',
    playerId: 'alpha',
    ...overrides,
  });
}

function createPlayer(
  id: 'alpha' | 'bravo' = 'alpha',
  overrides: Partial<SnapshotPlayer> = {},
): SnapshotPlayer {
  return {
    aim: { x: 0, y: -1 },
    callsign: id === 'alpha' ? 'ALPHA' : 'BRAVO',
    dashCooldownTicks: 0,
    dashTicks: 0,
    fireCooldownTicks: 0,
    health: 100,
    id,
    lastProcessedInputSequence: 0,
    position: { x: 0, y: 0 },
    radius: 0.48,
    respawnTicks: 0,
    spawnProtectionTicks: 0,
    statistics: { deaths: 0, kills: 0 },
    status: 'alive',
    velocity: { x: 0, y: 0 },
    ...overrides,
  };
}

function createSnapshot(
  tick: number,
  overrides: Partial<FullSnapshot> = {},
): FullSnapshot {
  return {
    arenaId: 'arena-one',
    buildId: 'build-1',
    events: [],
    players: [createPlayer()],
    projectiles: [],
    protocolVersion: PROTOCOL_VERSION,
    tick,
    ...overrides,
  };
}

function movingWorldSnapshot(tick: number): FullSnapshot {
  return createSnapshot(tick, {
    players: [
      createPlayer('alpha'),
      createPlayer('bravo', {
        position: { x: tick, y: 2 },
        velocity: { x: 60, y: 0 },
      }),
    ],
    projectiles: [
      {
        id: 7,
        ownerId: 'bravo',
        vx: 60,
        vy: 0,
        x: tick,
        y: 2,
      },
    ],
  });
}

function eliminationEvent(tick: number): SnapshotEvent {
  return {
    killerId: 'bravo',
    projectileId: 9,
    tick,
    type: 'player-eliminated',
    victimId: 'alpha',
    x: 1,
    y: 0,
  };
}

function respawnEvent(tick: number): SnapshotEvent {
  return {
    playerId: 'alpha',
    tick,
    type: 'player-respawned',
    x: -8,
    y: 8,
  };
}

function cloneAsFfaPlayer(player: SnapshotPlayer): FfaPlayerState {
  return {
    ...player,
    aim: { ...player.aim },
    position: { ...player.position },
    statistics: { ...player.statistics },
    velocity: { ...player.velocity },
  };
}
