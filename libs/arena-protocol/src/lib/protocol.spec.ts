import { describe, expect, it } from 'vitest';

import {
  AcknowledgedInputSequenceSchema,
  ArenaIdSchema,
  BuildIdSchema,
  CLIENT_ACK_SCHEMAS,
  CLIENT_EVENTS,
  CLIENT_EVENT_SCHEMAS,
  CallsignSchema,
  ControlVectorSchema,
  DrainingSchema,
  FullSnapshotSchema,
  HEALTH_NOT_READY_CODES,
  HandshakeAuthSchema,
  HealthResponseSchema,
  INPUT_RATE_HZ,
  InputSequenceSchema,
  LeaveAckSchema,
  LeaveRequestSchema,
  MAX_EVENTS_PER_SNAPSHOT,
  MAX_INBOUND_MESSAGE_BYTES,
  MAX_INPUT_SEQUENCE,
  MAX_INPUT_SEQUENCE_ADVANCE,
  MAX_PING_SEQUENCE,
  MAX_PLAYERS_PER_ARENA,
  MAX_PROJECTILES_PER_SNAPSHOT,
  MAX_QUICKPLAY_BODY_BYTES,
  MAX_SNAPSHOT_MESSAGE_BYTES,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_VERSION,
  PingSchema,
  PlayerIdSchema,
  PongSchema,
  QUICKPLAY_ERROR_CODES,
  QUICKPLAY_RESERVATION_TTL_MS,
  QuickplayErrorSchema,
  QuickplayRequestSchema,
  QuickplayResponseSchema,
  QuickplaySuccessSchema,
  RECONNECT_GRACE_MS,
  SERVER_EVENTS,
  SERVER_EVENT_SCHEMAS,
  SIMULATION_RATE_HZ,
  SNAPSHOT_RATE_HZ,
  SequencedInputSchema,
  ServerErrorSchema,
  SessionTokenSchema,
  WelcomeSchema,
  encodedEventByteLength,
  encodedJsonByteLength,
  isEventWithinByteLimit,
  isJsonWithinByteLimit,
  isValidInputSequenceAdvance,
  utf8ByteLength,
} from '..';

const BUILD_ID = 'build-0123456789abcdef';
const ARENA_ID = 'arena-01';
const PLAYER_ID = 'player-01';
const CALLSIGN = 'Copper Falcon';
const SESSION_TOKEN = 'A'.repeat(43);

const VALID_PLAYER = {
  aim: { x: 0.6, y: 0.8 },
  callsign: CALLSIGN,
  dashCooldownTicks: 12,
  dashTicks: 0,
  fireCooldownTicks: 3,
  health: 75,
  id: PLAYER_ID,
  lastProcessedInputSequence: 41,
  position: { x: 1.125, y: -2.25 },
  radius: 0.48,
  respawnTicks: 0,
  spawnProtectionTicks: 24,
  statistics: { deaths: 2, kills: 4 },
  status: 'alive' as const,
  velocity: { x: 3.5, y: -1.25 },
};

const VALID_SNAPSHOT = {
  arenaId: ARENA_ID,
  buildId: BUILD_ID,
  events: [
    {
      ownerId: PLAYER_ID,
      projectileId: 9,
      tick: 120,
      type: 'shot' as const,
      x: 1.25,
      y: -2.5,
    },
  ],
  players: [VALID_PLAYER],
  projectiles: [
    {
      id: 9,
      ownerId: PLAYER_ID,
      vx: 17,
      vy: 0,
      x: 1.75,
      y: -2.5,
    },
  ],
  protocolVersion: PROTOCOL_VERSION,
  tick: 120,
};

const VALID_INPUT = {
  aim: { x: 0, y: 1 },
  dash: false,
  firing: true,
  move: { x: 0.6, y: -0.8 },
  protocolVersion: PROTOCOL_VERSION,
  sequence: 42,
};

const VALID_WELCOME = {
  arenaId: ARENA_ID,
  buildId: BUILD_ID,
  callsign: CALLSIGN,
  inputRateHz: INPUT_RATE_HZ,
  playerId: PLAYER_ID,
  protocolVersion: PROTOCOL_VERSION,
  reconnectGraceMs: RECONNECT_GRACE_MS,
  simulationRateHz: SIMULATION_RATE_HZ,
  snapshot: VALID_SNAPSHOT,
  snapshotRateHz: SNAPSHOT_RATE_HZ,
};

interface RuntimeSchema {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
}

function jsonRoundTrip(schema: RuntimeSchema, value: unknown): unknown {
  return schema.parse(JSON.parse(JSON.stringify(value)) as unknown);
}

describe('protocol v1 records', () => {
  it('exports the fixed v1 event surface and limits', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(CLIENT_EVENTS).toStrictEqual({
      INPUT: 'client:input',
      LEAVE: 'client:leave',
      PING: 'client:ping',
    });
    expect(SERVER_EVENTS).toStrictEqual({
      DRAINING: 'server:draining',
      ERROR: 'server:error',
      SNAPSHOT: 'server:snapshot',
      WELCOME: 'server:welcome',
    });
    expect(Object.keys(CLIENT_EVENT_SCHEMAS)).toStrictEqual(
      Object.values(CLIENT_EVENTS),
    );
    expect(Object.keys(CLIENT_ACK_SCHEMAS)).toStrictEqual([
      CLIENT_EVENTS.LEAVE,
      CLIENT_EVENTS.PING,
    ]);
    expect(Object.keys(SERVER_EVENT_SCHEMAS)).toStrictEqual(
      Object.values(SERVER_EVENTS),
    );
    expect(MAX_PLAYERS_PER_ARENA).toBe(8);
    expect(MAX_PROJECTILES_PER_SNAPSHOT).toBe(96);
    expect(MAX_EVENTS_PER_SNAPSHOT).toBe(8);
    expect(MAX_INBOUND_MESSAGE_BYTES).toBe(8 * 1024);
    expect(MAX_SNAPSHOT_MESSAGE_BYTES).toBe(12 * 1024);
  });

  it('round-trips health, admission, auth, realtime, and acknowledgement records', () => {
    const cases: ReadonlyArray<readonly [RuntimeSchema, unknown]> = [
      [
        HealthResponseSchema,
        {
          buildId: BUILD_ID,
          protocolVersion: PROTOCOL_VERSION,
          service: 'dropzone-arena-authority',
          status: 'ready',
        },
      ],
      [
        HealthResponseSchema,
        {
          buildId: BUILD_ID,
          code: 'SERVER_DRAINING',
          protocolVersion: PROTOCOL_VERSION,
          service: 'dropzone-arena-authority',
          status: 'not-ready',
        },
      ],
      [
        QuickplayRequestSchema,
        { buildId: BUILD_ID, protocolVersion: PROTOCOL_VERSION },
      ],
      [
        QuickplaySuccessSchema,
        {
          arenaId: ARENA_ID,
          buildId: BUILD_ID,
          callsign: CALLSIGN,
          playerId: PLAYER_ID,
          protocolVersion: PROTOCOL_VERSION,
          reservationExpiresInMs: QUICKPLAY_RESERVATION_TTL_MS,
          status: 'ok',
          token: SESSION_TOKEN,
        },
      ],
      [
        QuickplayErrorSchema,
        {
          buildId: BUILD_ID,
          code: 'CAPACITY',
          protocolVersion: PROTOCOL_VERSION,
          retryAfterMs: 2_000,
          retryable: true,
          status: 'error',
        },
      ],
      [
        HandshakeAuthSchema,
        { buildId: BUILD_ID, protocolVersion: PROTOCOL_VERSION, token: SESSION_TOKEN },
      ],
      [SequencedInputSchema, VALID_INPUT],
      [LeaveRequestSchema, { protocolVersion: PROTOCOL_VERSION }],
      [LeaveAckSchema, { left: true, protocolVersion: PROTOCOL_VERSION }],
      [PingSchema, { protocolVersion: PROTOCOL_VERSION, sequence: 7 }],
      [PongSchema, { protocolVersion: PROTOCOL_VERSION, sequence: 7, serverTick: 120 }],
      [FullSnapshotSchema, VALID_SNAPSHOT],
      [WelcomeSchema, VALID_WELCOME],
      [
        ServerErrorSchema,
        {
          buildId: BUILD_ID,
          code: 'SESSION_EXPIRED',
          protocolVersion: PROTOCOL_VERSION,
          retryable: false,
        },
      ],
      [
        DrainingSchema,
        {
          buildId: BUILD_ID,
          code: 'SERVER_DRAINING',
          protocolVersion: PROTOCOL_VERSION,
          retryAfterMs: 5_000,
        },
      ],
    ];

    for (const [schema, value] of cases) {
      expect(jsonRoundTrip(schema, value)).toStrictEqual(value);
    }

    expect(QuickplayResponseSchema.parse(cases[3]?.[1])).toStrictEqual(cases[3]?.[1]);
    expect(QuickplayResponseSchema.parse(cases[4]?.[1])).toStrictEqual(cases[4]?.[1]);
  });

  it('rejects unknown outer fields on every public record', () => {
    const cases: ReadonlyArray<readonly [RuntimeSchema, Record<string, unknown>]> = [
      [
        HealthResponseSchema,
        {
          buildId: BUILD_ID,
          protocolVersion: PROTOCOL_VERSION,
          service: 'dropzone-arena-authority',
          status: 'ready',
        },
      ],
      [
        QuickplayRequestSchema,
        { buildId: BUILD_ID, protocolVersion: PROTOCOL_VERSION },
      ],
      [
        QuickplaySuccessSchema,
        {
          arenaId: ARENA_ID,
          buildId: BUILD_ID,
          callsign: CALLSIGN,
          playerId: PLAYER_ID,
          protocolVersion: PROTOCOL_VERSION,
          reservationExpiresInMs: QUICKPLAY_RESERVATION_TTL_MS,
          status: 'ok',
          token: SESSION_TOKEN,
        },
      ],
      [
        QuickplayErrorSchema,
        {
          buildId: BUILD_ID,
          code: 'CAPACITY',
          protocolVersion: PROTOCOL_VERSION,
          retryable: true,
          status: 'error',
        },
      ],
      [
        HandshakeAuthSchema,
        { buildId: BUILD_ID, protocolVersion: PROTOCOL_VERSION, token: SESSION_TOKEN },
      ],
      [SequencedInputSchema, VALID_INPUT],
      [LeaveRequestSchema, { protocolVersion: PROTOCOL_VERSION }],
      [LeaveAckSchema, { left: true, protocolVersion: PROTOCOL_VERSION }],
      [PingSchema, { protocolVersion: PROTOCOL_VERSION, sequence: 1 }],
      [PongSchema, { protocolVersion: PROTOCOL_VERSION, sequence: 1, serverTick: 120 }],
      [FullSnapshotSchema, VALID_SNAPSHOT],
      [WelcomeSchema, VALID_WELCOME],
      [
        ServerErrorSchema,
        {
          buildId: BUILD_ID,
          code: 'INVALID_MESSAGE',
          protocolVersion: PROTOCOL_VERSION,
          retryable: false,
        },
      ],
      [
        DrainingSchema,
        {
          buildId: BUILD_ID,
          code: 'SERVER_DRAINING',
          protocolVersion: PROTOCOL_VERSION,
        },
      ],
    ];

    for (const [schema, value] of cases) {
      expect(schema.safeParse({ ...value, unknownField: true }).success).toBe(false);
    }
  });

  it('rejects unsupported protocol versions everywhere they can enter the contract', () => {
    const cases: ReadonlyArray<readonly [RuntimeSchema, Record<string, unknown>]> = [
      [
        HealthResponseSchema,
        {
          buildId: BUILD_ID,
          protocolVersion: PROTOCOL_VERSION,
          service: 'dropzone-arena-authority',
          status: 'ready',
        },
      ],
      [
        QuickplayRequestSchema,
        { buildId: BUILD_ID, protocolVersion: PROTOCOL_VERSION },
      ],
      [
        HandshakeAuthSchema,
        { buildId: BUILD_ID, protocolVersion: PROTOCOL_VERSION, token: SESSION_TOKEN },
      ],
      [SequencedInputSchema, VALID_INPUT],
      [LeaveRequestSchema, { protocolVersion: PROTOCOL_VERSION }],
      [LeaveAckSchema, { left: true, protocolVersion: PROTOCOL_VERSION }],
      [PingSchema, { protocolVersion: PROTOCOL_VERSION, sequence: 1 }],
      [PongSchema, { protocolVersion: PROTOCOL_VERSION, sequence: 1, serverTick: 120 }],
      [FullSnapshotSchema, VALID_SNAPSHOT],
      [WelcomeSchema, VALID_WELCOME],
      [
        ServerErrorSchema,
        {
          buildId: BUILD_ID,
          code: 'PROTOCOL_MISMATCH',
          protocolVersion: PROTOCOL_VERSION,
          retryable: false,
        },
      ],
      [
        DrainingSchema,
        {
          buildId: BUILD_ID,
          code: 'SERVER_DRAINING',
          protocolVersion: PROTOCOL_VERSION,
        },
      ],
    ];

    for (const [schema, value] of cases) {
      expect(schema.safeParse({ ...value, protocolVersion: 2 }).success).toBe(false);
    }
  });

  it('keeps stable exhaustive health and error code sets', () => {
    for (const code of HEALTH_NOT_READY_CODES) {
      expect(
        HealthResponseSchema.safeParse({
          buildId: BUILD_ID,
          code,
          protocolVersion: PROTOCOL_VERSION,
          service: 'dropzone-arena-authority',
          status: 'not-ready',
        }).success,
      ).toBe(true);
    }

    for (const code of PROTOCOL_ERROR_CODES) {
      expect(
        ServerErrorSchema.safeParse({
          buildId: BUILD_ID,
          code,
          protocolVersion: PROTOCOL_VERSION,
          retryable: false,
        }).success,
      ).toBe(true);
    }

    for (const code of QUICKPLAY_ERROR_CODES) {
      expect(
        QuickplayErrorSchema.safeParse({
          buildId: BUILD_ID,
          code,
          protocolVersion: PROTOCOL_VERSION,
          retryable: false,
          status: 'error',
        }).success,
      ).toBe(true);
    }

    expect(
      QuickplayErrorSchema.safeParse({
        buildId: BUILD_ID,
        code: 'SESSION_EXPIRED',
        protocolVersion: PROTOCOL_VERSION,
        retryable: false,
        status: 'error',
      }).success,
    ).toBe(false);
    expect(
      ServerErrorSchema.safeParse({
        buildId: BUILD_ID,
        code: 'SOME_NEW_ERROR',
        protocolVersion: PROTOCOL_VERSION,
        retryable: false,
      }).success,
    ).toBe(false);
  });
});

describe('hostile value validation', () => {
  it('accepts bounded IDs, callsigns, and 256-bit base64url tokens', () => {
    expect(ArenaIdSchema.safeParse(`a${'b'.repeat(63)}`).success).toBe(true);
    expect(PlayerIdSchema.safeParse(`p${'0'.repeat(63)}`).success).toBe(true);
    expect(BuildIdSchema.safeParse(`b${'0'.repeat(63)}`).success).toBe(true);
    expect(CallsignSchema.safeParse('Copper-Falcon 7').success).toBe(true);
    expect(CallsignSchema.safeParse('A'.repeat(32)).success).toBe(true);
    expect(SessionTokenSchema.safeParse(SESSION_TOKEN).success).toBe(true);
    expect(SessionTokenSchema.safeParse(`${'a'.repeat(41)}_-`).success).toBe(true);
  });

  it.each([
    [ArenaIdSchema, 'arena/1'],
    [ArenaIdSchema, `a${'b'.repeat(64)}`],
    [PlayerIdSchema, '.player'],
    [PlayerIdSchema, 'player 1'],
    [BuildIdSchema, 'build id'],
    [BuildIdSchema, '../release'],
    [CallsignSchema, 'AB'],
    [CallsignSchema, ' Copper'],
    [CallsignSchema, 'Copper  Falcon'],
    [CallsignSchema, 'Copper--Falcon'],
    [CallsignSchema, 'Copper<script>'],
    [CallsignSchema, 'A'.repeat(33)],
    [SessionTokenSchema, 'A'.repeat(42)],
    [SessionTokenSchema, 'A'.repeat(44)],
    [SessionTokenSchema, `${'A'.repeat(42)}+`],
    [SessionTokenSchema, `${'A'.repeat(42)}=`],
  ])('rejects an invalid public string %#', (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('rejects non-finite, non-integral, and out-of-range input values', () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(
        SequencedInputSchema.safeParse({ ...VALID_INPUT, move: { x: value, y: 0 } })
          .success,
      ).toBe(false);
      expect(InputSequenceSchema.safeParse(value).success).toBe(false);
    }

    expect(ControlVectorSchema.safeParse({ x: 1.01, y: 0 }).success).toBe(false);
    expect(ControlVectorSchema.safeParse({ x: 0.8, y: 0.8 }).success).toBe(false);
    expect(ControlVectorSchema.safeParse({ x: 0, y: 0 }).success).toBe(true);
    expect(InputSequenceSchema.safeParse(0).success).toBe(false);
    expect(InputSequenceSchema.safeParse(1.5).success).toBe(false);
    expect(InputSequenceSchema.safeParse(MAX_INPUT_SEQUENCE).success).toBe(true);
    expect(InputSequenceSchema.safeParse(MAX_INPUT_SEQUENCE + 1).success).toBe(false);
    expect(AcknowledgedInputSequenceSchema.safeParse(0).success).toBe(true);
    expect(AcknowledgedInputSequenceSchema.safeParse(-1).success).toBe(false);
    expect(
      PingSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, sequence: 0 }).success,
    ).toBe(false);
    expect(
      PingSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        sequence: MAX_PING_SEQUENCE + 1,
      }).success,
    ).toBe(false);
  });

  it('validates monotonic sequence advances and rejects stale or impossible jumps', () => {
    expect(isValidInputSequenceAdvance(0, 1)).toBe(true);
    expect(isValidInputSequenceAdvance(0, MAX_INPUT_SEQUENCE_ADVANCE)).toBe(true);
    expect(isValidInputSequenceAdvance(10, 10 + MAX_INPUT_SEQUENCE_ADVANCE)).toBe(true);
    expect(isValidInputSequenceAdvance(10, 10)).toBe(false);
    expect(isValidInputSequenceAdvance(10, 9)).toBe(false);
    expect(isValidInputSequenceAdvance(10, 10 + MAX_INPUT_SEQUENCE_ADVANCE + 1)).toBe(
      false,
    );
    expect(isValidInputSequenceAdvance(-1, 1)).toBe(false);
    expect(isValidInputSequenceAdvance(0, 1.5)).toBe(false);
    expect(
      isValidInputSequenceAdvance(MAX_INPUT_SEQUENCE, MAX_INPUT_SEQUENCE + 1),
    ).toBe(false);
  });

  it('rejects outcome declarations and nested unknown fields in input', () => {
    expect(
      SequencedInputSchema.safeParse({ ...VALID_INPUT, health: 100 }).success,
    ).toBe(false);
    expect(
      SequencedInputSchema.safeParse({
        ...VALID_INPUT,
        move: { ...VALID_INPUT.move, position: 10 },
      }).success,
    ).toBe(false);
    expect(
      SequencedInputSchema.safeParse({
        ...VALID_INPUT,
        aim: { ...VALID_INPUT.aim, targetId: PLAYER_ID },
      }).success,
    ).toBe(false);
  });

  it('rejects non-finite, unquantized, oversized, duplicate, and unknown snapshot values', () => {
    expect(
      FullSnapshotSchema.safeParse({
        ...VALID_SNAPSHOT,
        players: [
          { ...VALID_PLAYER, position: { ...VALID_PLAYER.position, x: Number.NaN } },
        ],
      }).success,
    ).toBe(false);
    expect(
      FullSnapshotSchema.safeParse({
        ...VALID_SNAPSHOT,
        projectiles: [
          { ...VALID_SNAPSHOT.projectiles[0], vx: Number.POSITIVE_INFINITY },
        ],
      }).success,
    ).toBe(false);
    expect(
      FullSnapshotSchema.safeParse({
        ...VALID_SNAPSHOT,
        players: [
          { ...VALID_PLAYER, position: { ...VALID_PLAYER.position, x: 1.000_1 } },
        ],
      }).success,
    ).toBe(false);
    expect(
      FullSnapshotSchema.safeParse({
        ...VALID_SNAPSHOT,
        players: [{ ...VALID_PLAYER, health: 101 }],
      }).success,
    ).toBe(false);
    expect(
      FullSnapshotSchema.safeParse({
        ...VALID_SNAPSHOT,
        players: [VALID_PLAYER, { ...VALID_PLAYER }],
      }).success,
    ).toBe(false);
    expect(
      FullSnapshotSchema.safeParse({
        ...VALID_SNAPSHOT,
        players: [VALID_PLAYER, { ...VALID_PLAYER, id: 'player-02' }],
      }).success,
    ).toBe(false);
    expect(
      FullSnapshotSchema.safeParse({
        ...VALID_SNAPSHOT,
        projectiles: [
          VALID_SNAPSHOT.projectiles[0],
          { ...VALID_SNAPSHOT.projectiles[0] },
        ],
      }).success,
    ).toBe(false);
    expect(
      FullSnapshotSchema.safeParse({
        ...VALID_SNAPSHOT,
        players: [{ ...VALID_PLAYER, statistics: { deaths: 2, kills: 4, score: 10 } }],
      }).success,
    ).toBe(false);
    expect(
      FullSnapshotSchema.safeParse({
        ...VALID_SNAPSHOT,
        projectiles: [{ ...VALID_SNAPSHOT.projectiles[0], ttlTicks: 90 }],
      }).success,
    ).toBe(false);
    expect(
      FullSnapshotSchema.safeParse({
        ...VALID_SNAPSHOT,
        events: [{ ...VALID_SNAPSHOT.events[0], connectionId: 'internal' }],
      }).success,
    ).toBe(false);
  });

  it('requires welcome identity and release metadata to match its full snapshot', () => {
    expect(
      WelcomeSchema.safeParse({ ...VALID_WELCOME, arenaId: 'arena-02' }).success,
    ).toBe(false);
    expect(
      WelcomeSchema.safeParse({ ...VALID_WELCOME, buildId: 'build-other' }).success,
    ).toBe(false);
    expect(
      WelcomeSchema.safeParse({ ...VALID_WELCOME, playerId: 'player-02' }).success,
    ).toBe(false);
    expect(
      WelcomeSchema.safeParse({ ...VALID_WELCOME, callsign: 'Steel Heron' }).success,
    ).toBe(false);
    expect(
      WelcomeSchema.safeParse({ ...VALID_WELCOME, simulationRateHz: 59 }).success,
    ).toBe(false);
    expect(WelcomeSchema.safeParse({ ...VALID_WELCOME, inputRateHz: 31 }).success).toBe(
      false,
    );
    expect(
      WelcomeSchema.safeParse({ ...VALID_WELCOME, snapshotRateHz: 21 }).success,
    ).toBe(false);
    expect(
      WelcomeSchema.safeParse({ ...VALID_WELCOME, token: SESSION_TOKEN }).success,
    ).toBe(false);
  });

  it('allows only bounded retry metadata and non-reflective errors', () => {
    const error = {
      buildId: BUILD_ID,
      code: 'SERVICE_UNAVAILABLE',
      protocolVersion: PROTOCOL_VERSION,
      retryAfterMs: 60_000,
      retryable: true,
    } as const;
    expect(ServerErrorSchema.safeParse(error).success).toBe(true);
    expect(
      ServerErrorSchema.safeParse({ ...error, retryAfterMs: 60_001 }).success,
    ).toBe(false);
    expect(
      ServerErrorSchema.safeParse({ ...error, message: 'reflected input' }).success,
    ).toBe(false);
    expect(
      DrainingSchema.safeParse({
        buildId: BUILD_ID,
        code: 'SERVICE_UNAVAILABLE',
        protocolVersion: PROTOCOL_VERSION,
      }).success,
    ).toBe(false);
  });
});

describe('encoded payload budgets', () => {
  it('measures UTF-8 and non-JSON values without platform APIs', () => {
    expect(utf8ByteLength('A')).toBe(1);
    expect(utf8ByteLength('\u00a2')).toBe(2);
    expect(utf8ByteLength('\u20ac')).toBe(3);
    expect(utf8ByteLength('\ud800\udf48')).toBe(4);
    expect(encodedJsonByteLength({ ok: true })).toBe(Buffer.byteLength('{"ok":true}'));
    expect(() => encodedJsonByteLength(undefined)).toThrow(TypeError);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(isJsonWithinByteLimit(cyclic, 100)).toBe(false);
    expect(isJsonWithinByteLimit({}, -1)).toBe(false);
    expect(isEventWithinByteLimit(CLIENT_EVENTS.INPUT, cyclic, 100)).toBe(false);
  });

  it('keeps the complete input event far below the 8 KiB inbound assumption', () => {
    expect(encodedEventByteLength(CLIENT_EVENTS.INPUT, VALID_INPUT)).toBeLessThan(
      MAX_INBOUND_MESSAGE_BYTES,
    );
    expect(
      isEventWithinByteLimit(
        CLIENT_EVENTS.INPUT,
        VALID_INPUT,
        MAX_INBOUND_MESSAGE_BYTES,
      ),
    ).toBe(true);

    const oversizedPacket = {
      ...VALID_INPUT,
      padding: 'x'.repeat(MAX_INBOUND_MESSAGE_BYTES),
    };
    expect(
      isEventWithinByteLimit(
        CLIENT_EVENTS.INPUT,
        oversizedPacket,
        MAX_INBOUND_MESSAGE_BYTES,
      ),
    ).toBe(false);
    expect(SequencedInputSchema.safeParse(oversizedPacket).success).toBe(false);
  });

  it('keeps quickplay bodies bounded independently of realtime messages', () => {
    const request = { buildId: BUILD_ID, protocolVersion: PROTOCOL_VERSION };
    expect(encodedJsonByteLength(request)).toBeLessThan(MAX_QUICKPLAY_BODY_BYTES);
    expect(QuickplayRequestSchema.safeParse(request).success).toBe(true);
    expect(
      QuickplayRequestSchema.safeParse({
        ...request,
        padding: 'x'.repeat(MAX_QUICKPLAY_BODY_BYTES),
      }).success,
    ).toBe(false);
  });
});
