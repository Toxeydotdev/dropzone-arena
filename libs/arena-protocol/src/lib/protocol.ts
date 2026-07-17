import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

export const CLIENT_EVENTS = Object.freeze({
  INPUT: 'client:input',
  LEAVE: 'client:leave',
  PING: 'client:ping',
} as const);

export const SERVER_EVENTS = Object.freeze({
  DRAINING: 'server:draining',
  ERROR: 'server:error',
  SNAPSHOT: 'server:snapshot',
  WELCOME: 'server:welcome',
} as const);

export const MAX_PLAYERS_PER_ARENA = 8;
export const MAX_PROJECTILES_PER_SNAPSHOT = 96;
export const MAX_EVENTS_PER_SNAPSHOT = 8;
export const MAX_INBOUND_MESSAGE_BYTES = 8 * 1024;
export const MAX_SNAPSHOT_MESSAGE_BYTES = 12 * 1024;
export const MAX_QUICKPLAY_BODY_BYTES = 1024;
export const MAX_INPUT_SEQUENCE = 0xffff_ffff;
export const MAX_INPUT_SEQUENCE_ADVANCE = 45;
export const MAX_PING_SEQUENCE = 0xffff_ffff;
export const SIMULATION_RATE_HZ = 60;
export const INPUT_RATE_HZ = 30;
export const SNAPSHOT_RATE_HZ = 20;
export const RECONNECT_GRACE_MS = 10_000;
export const QUICKPLAY_RESERVATION_TTL_MS = 10_000;
export const WIRE_QUANTIZATION_DECIMALS = 3;
export const MAX_WORLD_COORDINATE = 64;
export const MAX_WORLD_VELOCITY = 64;

const MAX_PUBLIC_ID_LENGTH = 64;
const MAX_BUILD_ID_LENGTH = 64;
const MAX_CALLSIGN_LENGTH = 32;
const SESSION_TOKEN_LENGTH = 43;
const MAX_STATE_COUNTER = 0xffff_ffff;
const MAX_STATE_DURATION_TICKS = 3_600;
const MAX_PLAYER_RADIUS = 4;
const MAX_RETRY_AFTER_MS = 60_000;
const SOCKET_IO_EVENT_PREFIX = '42';
const QUANTIZATION_FACTOR = 10 ** WIRE_QUANTIZATION_DECIMALS;

const publicIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const buildIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const callsignPattern = /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/;
const sessionTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export const PROTOCOL_ERROR_CODES = [
  'INVALID_REQUEST',
  'PROTOCOL_MISMATCH',
  'BUILD_MISMATCH',
  'ORIGIN_REJECTED',
  'RATE_LIMITED',
  'CAPACITY',
  'SERVICE_UNAVAILABLE',
  'SESSION_EXPIRED',
  'SESSION_REPLACED',
  'INVALID_MESSAGE',
  'INVALID_SEQUENCE',
  'SERVER_DRAINING',
] as const;

export const QUICKPLAY_ERROR_CODES = [
  'INVALID_REQUEST',
  'PROTOCOL_MISMATCH',
  'BUILD_MISMATCH',
  'ORIGIN_REJECTED',
  'RATE_LIMITED',
  'CAPACITY',
  'SERVICE_UNAVAILABLE',
  'SERVER_DRAINING',
] as const;

export const HEALTH_NOT_READY_CODES = [
  'STARTING',
  'CONFIGURATION_INVALID',
  'SCHEDULER_UNAVAILABLE',
  'SERVER_DRAINING',
] as const;

export function utf8ByteLength(value: string): number {
  let bytes = 0;

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }

  return bytes;
}

export function encodedJsonByteLength(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError('Value cannot be encoded as JSON.');
  }

  return utf8ByteLength(encoded);
}

export function encodedEventByteLength(eventName: string, payload: unknown): number {
  return utf8ByteLength(
    `${SOCKET_IO_EVENT_PREFIX}${JSON.stringify([eventName, payload])}`,
  );
}

export function isJsonWithinByteLimit(value: unknown, maximumBytes: number): boolean {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return false;

  try {
    return encodedJsonByteLength(value) <= maximumBytes;
  } catch {
    return false;
  }
}

export function isEventWithinByteLimit(
  eventName: string,
  payload: unknown,
  maximumBytes: number,
): boolean {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return false;

  try {
    return encodedEventByteLength(eventName, payload) <= maximumBytes;
  } catch {
    return false;
  }
}

function isQuantized(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const quantized =
    Math.round(Math.abs(value) * QUANTIZATION_FACTOR) / QUANTIZATION_FACTOR;
  return Math.abs(Math.abs(value) - quantized) <= Number.EPSILON * QUANTIZATION_FACTOR;
}

function quantizedNumberSchema(minimum: number, maximum: number) {
  return z
    .number()
    .finite()
    .min(minimum)
    .max(maximum)
    .refine(
      isQuantized,
      `Must use at most ${WIRE_QUANTIZATION_DECIMALS} decimal places.`,
    );
}

const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);
const NonNegativeSafeIntegerSchema = z
  .number()
  .finite()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const StateCounterSchema = z.number().finite().int().min(0).max(MAX_STATE_COUNTER);
const StateDurationSchema = z
  .number()
  .finite()
  .int()
  .min(0)
  .max(MAX_STATE_DURATION_TICKS);
const RetryAfterSchema = z.number().finite().int().min(0).max(MAX_RETRY_AFTER_MS);

export const ArenaIdSchema = z
  .string()
  .min(1)
  .max(MAX_PUBLIC_ID_LENGTH)
  .regex(publicIdPattern);
export const PlayerIdSchema = z
  .string()
  .min(1)
  .max(MAX_PUBLIC_ID_LENGTH)
  .regex(publicIdPattern);
export const BuildIdSchema = z
  .string()
  .min(1)
  .max(MAX_BUILD_ID_LENGTH)
  .regex(buildIdPattern);
export const CallsignSchema = z
  .string()
  .min(3)
  .max(MAX_CALLSIGN_LENGTH)
  .regex(callsignPattern);
export const SessionTokenSchema = z
  .string()
  .length(SESSION_TOKEN_LENGTH)
  .regex(sessionTokenPattern);
export const InputSequenceSchema = z
  .number()
  .finite()
  .int()
  .min(1)
  .max(MAX_INPUT_SEQUENCE);
export const AcknowledgedInputSequenceSchema = z
  .number()
  .finite()
  .int()
  .min(0)
  .max(MAX_INPUT_SEQUENCE);
export const PingSequenceSchema = z
  .number()
  .finite()
  .int()
  .min(1)
  .max(MAX_PING_SEQUENCE);
export const TickSchema = NonNegativeSafeIntegerSchema;
export const ProtocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
export const QuickplayErrorCodeSchema = z.enum(QUICKPLAY_ERROR_CODES);

export const ControlVectorSchema = z
  .strictObject({
    x: z.number().finite().min(-1).max(1),
    y: z.number().finite().min(-1).max(1),
  })
  .refine(({ x, y }) => x * x + y * y <= 1 + Number.EPSILON * 4, {
    message: 'Control vector magnitude cannot exceed 1.',
  });

export const WirePositionSchema = z.strictObject({
  x: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
  y: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
});

export const WireVelocitySchema = z.strictObject({
  x: quantizedNumberSchema(-MAX_WORLD_VELOCITY, MAX_WORLD_VELOCITY),
  y: quantizedNumberSchema(-MAX_WORLD_VELOCITY, MAX_WORLD_VELOCITY),
});

export const WireDirectionSchema = z
  .strictObject({
    x: quantizedNumberSchema(-1, 1),
    y: quantizedNumberSchema(-1, 1),
  })
  .refine(({ x, y }) => x * x + y * y <= 1 + 0.002, {
    message: 'Direction vector magnitude cannot exceed 1 after quantization.',
  });

export const PlayerStatisticsSchema = z.strictObject({
  deaths: StateCounterSchema,
  kills: StateCounterSchema,
});

export const SnapshotPlayerSchema = z.strictObject({
  aim: WireDirectionSchema,
  callsign: CallsignSchema,
  dashCooldownTicks: StateDurationSchema,
  dashTicks: StateDurationSchema,
  fireCooldownTicks: StateDurationSchema,
  health: z.number().finite().int().min(0).max(100),
  id: PlayerIdSchema,
  lastProcessedInputSequence: AcknowledgedInputSequenceSchema,
  position: WirePositionSchema,
  radius: quantizedNumberSchema(0.001, MAX_PLAYER_RADIUS),
  respawnTicks: StateDurationSchema,
  spawnProtectionTicks: StateDurationSchema,
  statistics: PlayerStatisticsSchema,
  status: z.enum(['alive', 'eliminated']),
  velocity: WireVelocitySchema,
});

// Projectile vectors are flat on the wire because this record can occur 96 times per snapshot.
export const SnapshotProjectileSchema = z.strictObject({
  id: NonNegativeSafeIntegerSchema,
  ownerId: PlayerIdSchema,
  vx: quantizedNumberSchema(-MAX_WORLD_VELOCITY, MAX_WORLD_VELOCITY),
  vy: quantizedNumberSchema(-MAX_WORLD_VELOCITY, MAX_WORLD_VELOCITY),
  x: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
  y: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
});

const DashEventSchema = z.strictObject({
  playerId: PlayerIdSchema,
  tick: TickSchema,
  type: z.literal('dash'),
  x: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
  y: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
});

const HitEventSchema = z.strictObject({
  damage: z.number().finite().int().min(1).max(100),
  ownerId: PlayerIdSchema,
  projectileId: NonNegativeSafeIntegerSchema,
  targetId: PlayerIdSchema,
  tick: TickSchema,
  type: z.literal('hit'),
  x: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
  y: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
});

const PlayerEliminatedEventSchema = z.strictObject({
  killerId: PlayerIdSchema,
  projectileId: NonNegativeSafeIntegerSchema,
  tick: TickSchema,
  type: z.literal('player-eliminated'),
  victimId: PlayerIdSchema,
  x: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
  y: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
});

const PlayerJoinedEventSchema = z.strictObject({
  playerId: PlayerIdSchema,
  tick: TickSchema,
  type: z.literal('player-joined'),
  x: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
  y: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
});

const PlayerLeftEventSchema = z.strictObject({
  playerId: PlayerIdSchema,
  tick: TickSchema,
  type: z.literal('player-left'),
});

const PlayerRespawnedEventSchema = z.strictObject({
  playerId: PlayerIdSchema,
  tick: TickSchema,
  type: z.literal('player-respawned'),
  x: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
  y: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
});

const ShotEventSchema = z.strictObject({
  ownerId: PlayerIdSchema,
  projectileId: NonNegativeSafeIntegerSchema,
  tick: TickSchema,
  type: z.literal('shot'),
  x: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
  y: quantizedNumberSchema(-MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE),
});

export const SnapshotEventSchema = z.discriminatedUnion('type', [
  DashEventSchema,
  HitEventSchema,
  PlayerEliminatedEventSchema,
  PlayerJoinedEventSchema,
  PlayerLeftEventSchema,
  PlayerRespawnedEventSchema,
  ShotEventSchema,
]);

const FullSnapshotObjectSchema = z
  .strictObject({
    arenaId: ArenaIdSchema,
    buildId: BuildIdSchema,
    events: z.array(SnapshotEventSchema).max(MAX_EVENTS_PER_SNAPSHOT),
    players: z.array(SnapshotPlayerSchema).max(MAX_PLAYERS_PER_ARENA),
    projectiles: z.array(SnapshotProjectileSchema).max(MAX_PROJECTILES_PER_SNAPSHOT),
    protocolVersion: ProtocolVersionSchema,
    tick: TickSchema,
  })
  .superRefine(({ players, projectiles }, context) => {
    const playerIds = new Set<string>();
    const callsigns = new Set<string>();
    for (const [index, player] of players.entries()) {
      if (playerIds.has(player.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Player IDs must be unique.',
          path: ['players', index, 'id'],
        });
      }
      if (callsigns.has(player.callsign)) {
        context.addIssue({
          code: 'custom',
          message: 'Callsigns must be unique within an arena.',
          path: ['players', index, 'callsign'],
        });
      }
      playerIds.add(player.id);
      callsigns.add(player.callsign);
    }

    const projectileIds = new Set<number>();
    for (const [index, projectile] of projectiles.entries()) {
      if (projectileIds.has(projectile.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Projectile IDs must be unique.',
          path: ['projectiles', index, 'id'],
        });
      }
      projectileIds.add(projectile.id);
    }
  });

export const FullSnapshotSchema = FullSnapshotObjectSchema.refine(
  (snapshot) =>
    isEventWithinByteLimit(
      SERVER_EVENTS.SNAPSHOT,
      snapshot,
      MAX_SNAPSHOT_MESSAGE_BYTES,
    ),
  { message: 'Encoded snapshot exceeds the 12 KiB wire budget.' },
);

const HealthBaseShape = {
  buildId: BuildIdSchema,
  protocolVersion: ProtocolVersionSchema,
  service: z.literal('dropzone-arena-authority'),
};

const ReadyHealthSchema = z.strictObject({
  ...HealthBaseShape,
  status: z.literal('ready'),
});

const NotReadyHealthSchema = z.strictObject({
  ...HealthBaseShape,
  code: z.enum(HEALTH_NOT_READY_CODES),
  status: z.literal('not-ready'),
});

export const HealthResponseSchema = z.discriminatedUnion('status', [
  ReadyHealthSchema,
  NotReadyHealthSchema,
]);

export const QuickplayRequestSchema = z
  .strictObject({
    buildId: BuildIdSchema,
    protocolVersion: ProtocolVersionSchema,
  })
  .refine((request) => isJsonWithinByteLimit(request, MAX_QUICKPLAY_BODY_BYTES), {
    message: 'Quickplay request exceeds the 1 KiB body budget.',
  });

export const QuickplaySuccessSchema = z.strictObject({
  arenaId: ArenaIdSchema,
  buildId: BuildIdSchema,
  callsign: CallsignSchema,
  playerId: PlayerIdSchema,
  protocolVersion: ProtocolVersionSchema,
  reservationExpiresInMs: z.literal(QUICKPLAY_RESERVATION_TTL_MS),
  status: z.literal('ok'),
  token: SessionTokenSchema,
});

export const QuickplayErrorSchema = z.strictObject({
  buildId: BuildIdSchema,
  code: QuickplayErrorCodeSchema,
  protocolVersion: ProtocolVersionSchema,
  retryAfterMs: RetryAfterSchema.optional(),
  retryable: z.boolean(),
  status: z.literal('error'),
});

export const QuickplayResponseSchema = z.discriminatedUnion('status', [
  QuickplaySuccessSchema,
  QuickplayErrorSchema,
]);

export const HandshakeAuthSchema = z.strictObject({
  buildId: BuildIdSchema,
  protocolVersion: ProtocolVersionSchema,
  token: SessionTokenSchema,
});

export const SequencedInputSchema = z
  .strictObject({
    aim: ControlVectorSchema,
    dash: z.boolean(),
    firing: z.boolean(),
    move: ControlVectorSchema,
    protocolVersion: ProtocolVersionSchema,
    sequence: InputSequenceSchema,
  })
  .refine(
    (input) =>
      isEventWithinByteLimit(CLIENT_EVENTS.INPUT, input, MAX_INBOUND_MESSAGE_BYTES),
    { message: 'Encoded input exceeds the 8 KiB inbound message budget.' },
  );

export function isValidInputSequenceAdvance(
  lastProcessedSequence: number,
  candidateSequence: number,
): boolean {
  if (!AcknowledgedInputSequenceSchema.safeParse(lastProcessedSequence).success)
    return false;
  if (!InputSequenceSchema.safeParse(candidateSequence).success) return false;

  const advance = candidateSequence - lastProcessedSequence;
  return advance > 0 && advance <= MAX_INPUT_SEQUENCE_ADVANCE;
}

export const LeaveRequestSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
});

export const LeaveAckSchema = z.strictObject({
  left: z.literal(true),
  protocolVersion: ProtocolVersionSchema,
});

export const PingSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  sequence: PingSequenceSchema,
});

export const PongSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  sequence: PingSequenceSchema,
  serverTick: TickSchema,
});

export const WelcomeSchema = z
  .strictObject({
    arenaId: ArenaIdSchema,
    buildId: BuildIdSchema,
    callsign: CallsignSchema,
    inputRateHz: z.literal(INPUT_RATE_HZ),
    playerId: PlayerIdSchema,
    protocolVersion: ProtocolVersionSchema,
    reconnectGraceMs: z.literal(RECONNECT_GRACE_MS),
    simulationRateHz: z.literal(SIMULATION_RATE_HZ),
    snapshot: FullSnapshotSchema,
    snapshotRateHz: z.literal(SNAPSHOT_RATE_HZ),
  })
  .superRefine((welcome, context) => {
    if (welcome.arenaId !== welcome.snapshot.arenaId) {
      context.addIssue({
        code: 'custom',
        message: 'Welcome and snapshot arena IDs must match.',
        path: ['snapshot', 'arenaId'],
      });
    }
    if (welcome.buildId !== welcome.snapshot.buildId) {
      context.addIssue({
        code: 'custom',
        message: 'Welcome and snapshot build IDs must match.',
        path: ['snapshot', 'buildId'],
      });
    }

    const localPlayer = welcome.snapshot.players.find(
      (player) => player.id === welcome.playerId,
    );
    if (localPlayer?.callsign !== welcome.callsign) {
      context.addIssue({
        code: 'custom',
        message: 'Welcome identity must exist in the snapshot.',
        path: ['playerId'],
      });
    }
  });

export const ServerErrorSchema = z.strictObject({
  buildId: BuildIdSchema,
  code: ProtocolErrorCodeSchema,
  protocolVersion: ProtocolVersionSchema,
  retryAfterMs: RetryAfterSchema.optional(),
  retryable: z.boolean(),
});

export const DrainingSchema = z.strictObject({
  buildId: BuildIdSchema,
  code: z.literal('SERVER_DRAINING'),
  protocolVersion: ProtocolVersionSchema,
  retryAfterMs: RetryAfterSchema.optional(),
});

export const CLIENT_EVENT_SCHEMAS = Object.freeze({
  [CLIENT_EVENTS.INPUT]: SequencedInputSchema,
  [CLIENT_EVENTS.LEAVE]: LeaveRequestSchema,
  [CLIENT_EVENTS.PING]: PingSchema,
});

export const CLIENT_ACK_SCHEMAS = Object.freeze({
  [CLIENT_EVENTS.LEAVE]: LeaveAckSchema,
  [CLIENT_EVENTS.PING]: PongSchema,
});

export const SERVER_EVENT_SCHEMAS = Object.freeze({
  [SERVER_EVENTS.DRAINING]: DrainingSchema,
  [SERVER_EVENTS.ERROR]: ServerErrorSchema,
  [SERVER_EVENTS.SNAPSHOT]: FullSnapshotSchema,
  [SERVER_EVENTS.WELCOME]: WelcomeSchema,
});

export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;
export type QuickplayErrorCode = z.infer<typeof QuickplayErrorCodeSchema>;
export type ArenaId = z.infer<typeof ArenaIdSchema>;
export type PlayerId = z.infer<typeof PlayerIdSchema>;
export type BuildId = z.infer<typeof BuildIdSchema>;
export type Callsign = z.infer<typeof CallsignSchema>;
export type SessionToken = z.infer<typeof SessionTokenSchema>;
export type ControlVector = z.infer<typeof ControlVectorSchema>;
export type WirePosition = z.infer<typeof WirePositionSchema>;
export type WireVelocity = z.infer<typeof WireVelocitySchema>;
export type WireDirection = z.infer<typeof WireDirectionSchema>;
export type PlayerStatistics = z.infer<typeof PlayerStatisticsSchema>;
export type SnapshotPlayer = z.infer<typeof SnapshotPlayerSchema>;
export type SnapshotProjectile = z.infer<typeof SnapshotProjectileSchema>;
export type SnapshotEvent = z.infer<typeof SnapshotEventSchema>;
export type FullSnapshot = z.infer<typeof FullSnapshotSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type QuickplayRequest = z.infer<typeof QuickplayRequestSchema>;
export type QuickplaySuccess = z.infer<typeof QuickplaySuccessSchema>;
export type QuickplayError = z.infer<typeof QuickplayErrorSchema>;
export type QuickplayResponse = z.infer<typeof QuickplayResponseSchema>;
export type HandshakeAuth = z.infer<typeof HandshakeAuthSchema>;
export type SequencedInput = z.infer<typeof SequencedInputSchema>;
export type LeaveRequest = z.infer<typeof LeaveRequestSchema>;
export type LeaveAck = z.infer<typeof LeaveAckSchema>;
export type Ping = z.infer<typeof PingSchema>;
export type Pong = z.infer<typeof PongSchema>;
export type Welcome = z.infer<typeof WelcomeSchema>;
export type ServerError = z.infer<typeof ServerErrorSchema>;
export type Draining = z.infer<typeof DrainingSchema>;
