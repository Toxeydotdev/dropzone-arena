import {
  FFA_COLLISION_WORLD,
  FFA_FIXED_STEP_SECONDS,
  stepFfaPlayerMotion,
  type FfaInput,
  type FfaPlayerState,
  type Vector2,
} from '@dropzone-arena/arena-engine';
import {
  INPUT_RATE_HZ,
  MAX_INPUT_SEQUENCE,
  MAX_INPUT_SEQUENCE_ADVANCE,
  PROTOCOL_VERSION,
  SIMULATION_RATE_HZ,
  SNAPSHOT_RATE_HZ,
  type FullSnapshot,
  type SequencedInput,
  type SnapshotPlayer,
  type SnapshotProjectile,
} from '@dropzone-arena/arena-protocol';

import type { ArenaControlState } from './arena-input-controller';

const FIXED_STEP_MS = FFA_FIXED_STEP_SECONDS * 1_000;
const INPUT_INTERVAL_MS = 1_000 / INPUT_RATE_HZ;
const INTERPOLATION_DELAY_TICKS = SIMULATION_RATE_HZ / 10;
const SNAPSHOT_INTERVAL_TICKS = SIMULATION_RATE_HZ / SNAPSHOT_RATE_HZ;
const MAX_EXTRAPOLATION_TICKS = SNAPSHOT_INTERVAL_TICKS * 2;
const MAX_CATCH_UP_STEPS = 5;
const MAX_INPUT_HISTORY = SIMULATION_RATE_HZ * 2;
const MAX_SNAPSHOTS = 8;
const CORRECTION_DURATION_MS = 100;
const CORRECTION_SNAP_DISTANCE = 2;
const TIME_EPSILON_MS = 0.000_001;
const POSITION_EPSILON = 0.000_001;

const NEUTRAL_INPUT: ArenaControlState = {
  aim: { x: 0, y: -1 },
  dash: false,
  firing: false,
  move: { x: 0, y: 0 },
};

export interface OnlineNetcodeOptions {
  arenaId: string;
  playerId: string;
  reducedMotion?: boolean;
}

export interface OnlineNetcodeAdvance {
  localPlayer: SnapshotPlayer | null;
  packets: readonly SequencedInput[];
}

export interface OnlineNetcodePresentation {
  delayed: boolean;
  localPlayer: SnapshotPlayer | null;
  presentationTick: number | null;
  projectiles: readonly SnapshotProjectile[];
  remotePlayers: readonly SnapshotPlayer[];
}

export type OnlineSnapshotDisposition = 'accepted' | 'duplicate' | 'foreign' | 'stale';

export type OnlineNetcodeResetReason = 'interruption' | 'reconnect';

interface PredictionHistoryEntry {
  input: ArenaControlState;
  sequence: number;
}

interface BufferedSnapshot {
  receivedAtMs: number;
  snapshot: FullSnapshot;
}

interface PositionCorrection {
  offset: Vector2;
  startedAtMs: number;
}

interface SampledEntities {
  projectiles: SnapshotProjectile[];
  remotePlayers: SnapshotPlayer[];
}

/**
 * Owns online input sampling and presentation timelines without reading a browser clock
 * or transport. The future runtime supplies every timestamp, input, and snapshot.
 */
export class OnlineNetcode {
  private readonly arenaId: string;
  private readonly playerId: string;
  private reducedMotion: boolean;
  private currentTimeMs: number | null = null;
  private lastAdvanceTimeMs: number | null = null;
  private nextRegularPacketTimeMs: number | null = null;
  private predictionAccumulatorMs = 0;
  private lastAllocatedSequence = 0;
  private lastSentSequence = 0;
  private lastAcknowledgedSequence = 0;
  private latestAcceptedTick: number | null = null;
  private lastPresentationTick: number | null = null;
  private authoritativeLocalPlayer: SnapshotPlayer | null = null;
  private predictedLocalPlayer: SnapshotPlayer | null = null;
  private lastObservedInput = cloneInput(NEUTRAL_INPUT);
  private pendingDash = false;
  private rebaseSequenceOnNextSnapshot = false;
  private correction: PositionCorrection | null = null;
  private readonly packetTimesMs: number[] = [];
  private predictionHistory: PredictionHistoryEntry[] = [];
  private snapshots: BufferedSnapshot[] = [];

  constructor(options: OnlineNetcodeOptions) {
    this.arenaId = options.arenaId;
    this.playerId = options.playerId;
    this.reducedMotion = options.reducedMotion ?? false;
  }

  advance(timeMs: number, input: ArenaControlState): OnlineNetcodeAdvance {
    this.recordTime(timeMs);
    const sampledInput = sanitizeInput(input, this.lastObservedInput.aim);
    const dashPriority = sampledInput.dash && !this.lastObservedInput.dash;
    const neutralPriority =
      isActiveInput(this.lastObservedInput) && !isActiveInput(sampledInput);
    if (dashPriority) this.pendingDash = true;
    this.lastObservedInput = cloneInput(sampledInput);

    const packets: SequencedInput[] = [];
    if (this.predictedLocalPlayer && (dashPriority || neutralPriority)) {
      const priorityInput = dashPriority
        ? sampledInput
        : { ...sampledInput, dash: false, firing: false, move: { x: 0, y: 0 } };
      const packet = this.createPriorityPacket(timeMs, priorityInput);
      if (packet) packets.push(packet);
    }

    if (this.lastAdvanceTimeMs === null) this.lastAdvanceTimeMs = timeMs;
    const elapsedMs = Math.max(0, timeMs - this.lastAdvanceTimeMs);
    this.lastAdvanceTimeMs = timeMs;

    if (!this.predictedLocalPlayer) {
      this.predictionAccumulatorMs = 0;
      return { localPlayer: null, packets };
    }

    this.predictionAccumulatorMs += elapsedMs;
    const availableSteps = Math.floor(
      (this.predictionAccumulatorMs + TIME_EPSILON_MS) / FIXED_STEP_MS,
    );
    const steps = Math.min(availableSteps, MAX_CATCH_UP_STEPS);
    if (availableSteps > MAX_CATCH_UP_STEPS) {
      this.predictionAccumulatorMs %= FIXED_STEP_MS;
    } else {
      this.predictionAccumulatorMs = Math.max(
        0,
        this.predictionAccumulatorMs - steps * FIXED_STEP_MS,
      );
    }

    for (let index = 0; index < steps; index += 1) {
      const stepInput = cloneInput(sampledInput);
      stepInput.dash = this.pendingDash;
      this.pendingDash = false;
      const sequence = this.allocateSequence();
      this.predictedLocalPlayer = predictMotion(this.predictedLocalPlayer, stepInput);
      this.predictionHistory.push({ input: stepInput, sequence });
    }
    if (this.predictionHistory.length > MAX_INPUT_HISTORY) {
      this.predictionHistory.splice(
        0,
        this.predictionHistory.length - MAX_INPUT_HISTORY,
      );
    }

    if (
      packets.length === 0 &&
      this.nextRegularPacketTimeMs !== null &&
      timeMs + TIME_EPSILON_MS >= this.nextRegularPacketTimeMs
    ) {
      const packet = this.createRegularPacket(timeMs, sampledInput);
      if (packet) packets.push(packet);
    }

    return {
      localPlayer: clonePlayer(this.predictedLocalPlayer),
      packets,
    };
  }

  acceptSnapshot(timeMs: number, snapshot: FullSnapshot): OnlineSnapshotDisposition {
    this.recordTime(timeMs);
    if (snapshot.arenaId !== this.arenaId) return 'foreign';
    if (this.latestAcceptedTick !== null) {
      if (snapshot.tick < this.latestAcceptedTick) return 'stale';
      if (snapshot.tick === this.latestAcceptedTick) return 'duplicate';
    }

    const accepted = cloneSnapshot(snapshot);
    const incomingLocal =
      accepted.players.find((player) => player.id === this.playerId) ?? null;
    const initialSnapshot = this.latestAcceptedTick === null;
    const lifeDiscontinuity =
      !initialSnapshot &&
      hasLifeDiscontinuity(
        this.authoritativeLocalPlayer,
        incomingLocal,
        accepted,
        this.playerId,
      );
    const previousPresentedPosition = this.presentedLocalPosition(timeMs);

    if (incomingLocal && this.rebaseSequenceOnNextSnapshot) {
      this.lastAcknowledgedSequence = incomingLocal.lastProcessedInputSequence;
      this.lastAllocatedSequence = incomingLocal.lastProcessedInputSequence;
      this.lastSentSequence = incomingLocal.lastProcessedInputSequence;
      this.packetTimesMs.length = 0;
      this.rebaseSequenceOnNextSnapshot = false;
    } else if (incomingLocal) {
      this.lastAcknowledgedSequence = Math.max(
        this.lastAcknowledgedSequence,
        incomingLocal.lastProcessedInputSequence,
      );
      this.lastAllocatedSequence = Math.max(
        this.lastAllocatedSequence,
        incomingLocal.lastProcessedInputSequence,
      );
      this.lastSentSequence = Math.max(
        this.lastSentSequence,
        incomingLocal.lastProcessedInputSequence,
      );
    }

    if (initialSnapshot || lifeDiscontinuity) {
      this.predictionHistory = [];
      this.snapshots = [];
      this.lastPresentationTick = null;
      this.resetPredictionClock(timeMs);
      this.pendingDash = false;
      this.lastObservedInput = neutralInput(this.lastObservedInput.aim);
    } else {
      this.predictionHistory = this.predictionHistory.filter(
        (entry) => entry.sequence > this.lastAcknowledgedSequence,
      );
    }

    this.authoritativeLocalPlayer = incomingLocal ? clonePlayer(incomingLocal) : null;
    this.predictedLocalPlayer = incomingLocal ? clonePlayer(incomingLocal) : null;
    if (this.predictedLocalPlayer && !lifeDiscontinuity) {
      for (const entry of this.predictionHistory) {
        this.predictedLocalPlayer = predictMotion(
          this.predictedLocalPlayer,
          entry.input,
        );
      }
    }

    if (
      initialSnapshot ||
      lifeDiscontinuity ||
      this.reducedMotion ||
      !previousPresentedPosition ||
      !this.predictedLocalPlayer
    ) {
      this.correction = null;
    } else {
      const offset = {
        x: previousPresentedPosition.x - this.predictedLocalPlayer.position.x,
        y: previousPresentedPosition.y - this.predictedLocalPlayer.position.y,
      };
      const distance = Math.hypot(offset.x, offset.y);
      this.correction =
        distance > POSITION_EPSILON && distance < CORRECTION_SNAP_DISTANCE
          ? { offset, startedAtMs: timeMs }
          : null;
    }

    this.snapshots.push({ receivedAtMs: timeMs, snapshot: accepted });
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots.splice(0, this.snapshots.length - MAX_SNAPSHOTS);
    }
    this.latestAcceptedTick = accepted.tick;
    return 'accepted';
  }

  samplePresentation(timeMs: number): OnlineNetcodePresentation {
    this.recordTime(timeMs);
    const localPlayer = this.predictedLocalPlayer
      ? clonePlayer(this.predictedLocalPlayer)
      : null;
    const localPosition = this.presentedLocalPosition(timeMs);
    if (localPlayer && localPosition) localPlayer.position = localPosition;

    const newest = this.snapshots.at(-1);
    if (!newest) {
      return {
        delayed: true,
        localPlayer,
        presentationTick: null,
        projectiles: [],
        remotePlayers: [],
      };
    }

    const elapsedTicks = ((timeMs - newest.receivedAtMs) / 1_000) * SIMULATION_RATE_HZ;
    const estimatedTargetTick =
      newest.snapshot.tick + Math.max(0, elapsedTicks) - INTERPOLATION_DELAY_TICKS;
    const targetTick = Math.max(
      estimatedTargetTick,
      this.lastPresentationTick ?? Number.NEGATIVE_INFINITY,
    );
    const maximumTick = newest.snapshot.tick + MAX_EXTRAPOLATION_TICKS;
    const delayed = targetTick > maximumTick + Number.EPSILON;
    const boundedTick = Math.min(targetTick, maximumTick);
    const sampled = sampleEntities(this.snapshots, boundedTick, this.playerId);

    const presentationTick = Math.max(
      this.snapshots[0]?.snapshot.tick ?? 0,
      boundedTick,
    );
    this.lastPresentationTick = presentationTick;
    return {
      delayed,
      localPlayer,
      presentationTick,
      projectiles: sampled.projectiles,
      remotePlayers: sampled.remotePlayers,
    };
  }

  reset(timeMs: number, reason: OnlineNetcodeResetReason): SequencedInput | null {
    this.recordTime(timeMs);
    const neutralPacket =
      reason === 'interruption' && this.predictedLocalPlayer
        ? this.createPriorityPacket(timeMs, neutralInput(this.lastObservedInput.aim))
        : null;

    this.snapshots = [];
    this.latestAcceptedTick = null;
    this.lastPresentationTick = null;
    this.authoritativeLocalPlayer = null;
    this.predictedLocalPlayer = null;
    this.predictionHistory = [];
    this.correction = null;
    this.pendingDash = false;
    this.rebaseSequenceOnNextSnapshot = reason === 'reconnect';
    this.lastObservedInput = neutralInput(this.lastObservedInput.aim);
    this.resetPredictionClock(timeMs);
    return neutralPacket;
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
    if (reducedMotion) this.correction = null;
  }

  private createPriorityPacket(
    timeMs: number,
    input: ArenaControlState,
  ): SequencedInput | null {
    if (!this.canEmitPacket(timeMs)) return null;
    const packet = this.emitPacket(timeMs, input, this.allocateSequence());
    this.consumeRegularPacketSlot(timeMs);
    return packet;
  }

  private createRegularPacket(
    timeMs: number,
    input: ArenaControlState,
  ): SequencedInput | null {
    if (!this.canEmitPacket(timeMs)) return null;
    const latestHistory = this.predictionHistory.at(-1);
    const sequence =
      latestHistory &&
      latestHistory.sequence > this.lastSentSequence &&
      inputsEqual(latestHistory.input, input)
        ? latestHistory.sequence
        : this.allocateSequence();
    const packet = this.emitPacket(timeMs, input, sequence);
    this.consumeRegularPacketSlot(timeMs);
    return packet;
  }

  private emitPacket(
    timeMs: number,
    input: ArenaControlState,
    sequence: number,
  ): SequencedInput {
    if (sequence <= this.lastSentSequence) {
      throw new RangeError('Online input sequences must increase.');
    }
    if (sequence - this.lastSentSequence > MAX_INPUT_SEQUENCE_ADVANCE) {
      throw new RangeError('Online input sequence advanced beyond the protocol limit.');
    }
    this.lastSentSequence = sequence;
    this.packetTimesMs.push(timeMs);
    return {
      aim: { ...input.aim },
      dash: input.dash,
      firing: input.firing,
      move: { ...input.move },
      protocolVersion: PROTOCOL_VERSION,
      sequence,
    };
  }

  private canEmitPacket(timeMs: number): boolean {
    const windowStart = timeMs - 1_000;
    while ((this.packetTimesMs[0] ?? Number.POSITIVE_INFINITY) <= windowStart) {
      this.packetTimesMs.shift();
    }
    return this.packetTimesMs.length < INPUT_RATE_HZ;
  }

  private consumeRegularPacketSlot(timeMs: number): void {
    if (this.nextRegularPacketTimeMs === null) {
      this.nextRegularPacketTimeMs = timeMs + INPUT_INTERVAL_MS;
      return;
    }
    if (timeMs + TIME_EPSILON_MS < this.nextRegularPacketTimeMs) {
      this.nextRegularPacketTimeMs += INPUT_INTERVAL_MS;
      return;
    }
    do {
      this.nextRegularPacketTimeMs += INPUT_INTERVAL_MS;
    } while (timeMs + TIME_EPSILON_MS >= this.nextRegularPacketTimeMs);
  }

  private allocateSequence(): number {
    if (this.lastAllocatedSequence >= MAX_INPUT_SEQUENCE) {
      throw new RangeError('Online input sequence exhausted.');
    }
    this.lastAllocatedSequence += 1;
    return this.lastAllocatedSequence;
  }

  private resetPredictionClock(timeMs: number): void {
    this.lastAdvanceTimeMs = timeMs;
    this.predictionAccumulatorMs = 0;
    this.nextRegularPacketTimeMs = timeMs + FIXED_STEP_MS;
  }

  private presentedLocalPosition(timeMs: number): Vector2 | null {
    if (!this.predictedLocalPlayer) return null;
    if (!this.correction) return { ...this.predictedLocalPlayer.position };
    const progress = Math.max(
      0,
      Math.min(1, (timeMs - this.correction.startedAtMs) / CORRECTION_DURATION_MS),
    );
    if (progress >= 1) {
      this.correction = null;
      return { ...this.predictedLocalPlayer.position };
    }
    return {
      x:
        this.predictedLocalPlayer.position.x +
        this.correction.offset.x * (1 - progress),
      y:
        this.predictedLocalPlayer.position.y +
        this.correction.offset.y * (1 - progress),
    };
  }

  private recordTime(timeMs: number): void {
    if (!Number.isFinite(timeMs) || timeMs < 0) {
      throw new RangeError('Online netcode time must be a finite non-negative value.');
    }
    if (this.currentTimeMs !== null && timeMs + TIME_EPSILON_MS < this.currentTimeMs) {
      throw new RangeError('Online netcode time must be monotonic.');
    }
    this.currentTimeMs = Math.max(this.currentTimeMs ?? timeMs, timeMs);
  }
}

function predictMotion(
  player: SnapshotPlayer,
  input: ArenaControlState,
): SnapshotPlayer {
  const predicted = stepFfaPlayerMotion(
    toFfaPlayer(player),
    input as FfaInput,
    FFA_COLLISION_WORLD,
    FFA_FIXED_STEP_SECONDS,
  );
  return {
    ...clonePlayer(player),
    aim: { ...predicted.aim },
    dashCooldownTicks: predicted.dashCooldownTicks,
    dashTicks: predicted.dashTicks,
    position: { ...predicted.position },
    velocity: { ...predicted.velocity },
  };
}

function toFfaPlayer(player: SnapshotPlayer): FfaPlayerState {
  return {
    ...player,
    aim: { ...player.aim },
    position: { ...player.position },
    statistics: { ...player.statistics },
    velocity: { ...player.velocity },
  };
}

function sampleEntities(
  snapshots: readonly BufferedSnapshot[],
  targetTick: number,
  localPlayerId: string,
): SampledEntities {
  const oldest = snapshots[0];
  const newest = snapshots.at(-1);
  if (!oldest || !newest) return { projectiles: [], remotePlayers: [] };
  if (targetTick <= oldest.snapshot.tick) {
    return entitiesFromSnapshot(oldest.snapshot, localPlayerId);
  }

  for (let index = 1; index < snapshots.length; index += 1) {
    const later = snapshots[index];
    const earlier = snapshots[index - 1];
    if (!later || !earlier || targetTick > later.snapshot.tick) continue;
    if (targetTick === later.snapshot.tick) {
      return entitiesFromSnapshot(later.snapshot, localPlayerId);
    }
    const span = later.snapshot.tick - earlier.snapshot.tick;
    const amount = span > 0 ? (targetTick - earlier.snapshot.tick) / span : 1;
    return interpolateEntities(earlier.snapshot, later.snapshot, amount, localPlayerId);
  }

  return extrapolateEntities(
    newest.snapshot,
    targetTick - newest.snapshot.tick,
    localPlayerId,
  );
}

function entitiesFromSnapshot(
  snapshot: FullSnapshot,
  localPlayerId: string,
): SampledEntities {
  return {
    projectiles: snapshot.projectiles.map(cloneProjectile),
    remotePlayers: snapshot.players
      .filter((player) => player.id !== localPlayerId)
      .map(clonePlayer),
  };
}

function interpolateEntities(
  earlier: FullSnapshot,
  later: FullSnapshot,
  amount: number,
  localPlayerId: string,
): SampledEntities {
  const laterPlayers = new Map(later.players.map((player) => [player.id, player]));
  const laterProjectiles = new Map(
    later.projectiles.map((projectile) => [projectile.id, projectile]),
  );
  const remotePlayers: SnapshotPlayer[] = [];
  for (const player of earlier.players) {
    if (player.id === localPlayerId) continue;
    const next = laterPlayers.get(player.id);
    if (!next || player.status !== next.status) {
      remotePlayers.push(clonePlayer(player));
      continue;
    }
    remotePlayers.push({
      ...clonePlayer(player),
      aim: interpolateVector(player.aim, next.aim, amount),
      position: interpolateVector(player.position, next.position, amount),
      velocity: interpolateVector(player.velocity, next.velocity, amount),
    });
  }

  const projectiles: SnapshotProjectile[] = [];
  for (const projectile of earlier.projectiles) {
    const next = laterProjectiles.get(projectile.id);
    if (!next) {
      projectiles.push(cloneProjectile(projectile));
      continue;
    }
    projectiles.push({
      ...projectile,
      vx: interpolate(projectile.vx, next.vx, amount),
      vy: interpolate(projectile.vy, next.vy, amount),
      x: interpolate(projectile.x, next.x, amount),
      y: interpolate(projectile.y, next.y, amount),
    });
  }
  return { projectiles, remotePlayers };
}

function extrapolateEntities(
  snapshot: FullSnapshot,
  deltaTicks: number,
  localPlayerId: string,
): SampledEntities {
  const deltaSeconds = deltaTicks / SIMULATION_RATE_HZ;
  return {
    projectiles: snapshot.projectiles.map((projectile) => ({
      ...projectile,
      x: projectile.x + projectile.vx * deltaSeconds,
      y: projectile.y + projectile.vy * deltaSeconds,
    })),
    remotePlayers: snapshot.players
      .filter((player) => player.id !== localPlayerId)
      .map((player) => ({
        ...clonePlayer(player),
        position:
          player.status === 'alive'
            ? {
                x: player.position.x + player.velocity.x * deltaSeconds,
                y: player.position.y + player.velocity.y * deltaSeconds,
              }
            : { ...player.position },
      })),
  };
}

function hasLifeDiscontinuity(
  previous: SnapshotPlayer | null,
  next: SnapshotPlayer | null,
  snapshot: FullSnapshot,
  playerId: string,
): boolean {
  if (!previous || !next) return previous !== next;
  if (
    previous.status !== next.status ||
    previous.statistics.deaths !== next.statistics.deaths
  ) {
    return true;
  }
  return snapshot.events.some(
    (event) =>
      (event.type === 'player-eliminated' && event.victimId === playerId) ||
      (event.type === 'player-respawned' && event.playerId === playerId) ||
      (event.type === 'player-joined' && event.playerId === playerId),
  );
}

function sanitizeInput(
  input: ArenaControlState,
  fallbackAim: Vector2,
): ArenaControlState {
  return {
    aim: sanitizeVector(input.aim, fallbackAim),
    dash: input.dash === true,
    firing: input.firing === true,
    move: sanitizeVector(input.move, { x: 0, y: 0 }),
  };
}

function sanitizeVector(vector: Vector2, fallback: Vector2): Vector2 {
  if (!Number.isFinite(vector.x) || !Number.isFinite(vector.y)) return { ...fallback };
  const magnitude = Math.hypot(vector.x, vector.y);
  return magnitude > 1
    ? { x: vector.x / magnitude, y: vector.y / magnitude }
    : { ...vector };
}

function neutralInput(aim: Vector2): ArenaControlState {
  return {
    aim: { ...aim },
    dash: false,
    firing: false,
    move: { x: 0, y: 0 },
  };
}

function isActiveInput(input: ArenaControlState): boolean {
  return (
    input.dash ||
    input.firing ||
    Math.abs(input.move.x) > POSITION_EPSILON ||
    Math.abs(input.move.y) > POSITION_EPSILON
  );
}

function inputsEqual(first: ArenaControlState, second: ArenaControlState): boolean {
  return (
    first.aim.x === second.aim.x &&
    first.aim.y === second.aim.y &&
    first.dash === second.dash &&
    first.firing === second.firing &&
    first.move.x === second.move.x &&
    first.move.y === second.move.y
  );
}

function cloneInput(input: ArenaControlState): ArenaControlState {
  return {
    aim: { ...input.aim },
    dash: input.dash,
    firing: input.firing,
    move: { ...input.move },
  };
}

function clonePlayer(player: SnapshotPlayer): SnapshotPlayer {
  return {
    ...player,
    aim: { ...player.aim },
    position: { ...player.position },
    statistics: { ...player.statistics },
    velocity: { ...player.velocity },
  };
}

function cloneProjectile(projectile: SnapshotProjectile): SnapshotProjectile {
  return { ...projectile };
}

function cloneSnapshot(snapshot: FullSnapshot): FullSnapshot {
  return {
    ...snapshot,
    events: snapshot.events.map((event) => ({ ...event })),
    players: snapshot.players.map(clonePlayer),
    projectiles: snapshot.projectiles.map(cloneProjectile),
  };
}

function interpolateVector(first: Vector2, second: Vector2, amount: number): Vector2 {
  return {
    x: interpolate(first.x, second.x, amount),
    y: interpolate(first.y, second.y, amount),
  };
}

function interpolate(first: number, second: number, amount: number): number {
  return first + (second - first) * amount;
}
