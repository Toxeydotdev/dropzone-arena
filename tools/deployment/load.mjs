import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { DeploymentArgumentError, parseLoadArguments } from './arguments.mjs';
import {
  Deadline,
  DeploymentCheckError,
  admitCandidateSession,
  checkAuthorityHealth,
  cleanupSessions,
  publicFailure,
} from './runtime.mjs';

const HELP = `Usage:
  npm run deploy:load -- \\
    --authority-url https://authority.example \\
    --web-origin https://candidate.example \\
    --build-id <immutable-build-id> \\
    --confirm-isolated-pre-enable-candidate

Options:
  --clients <1-32>            Client count (default and representative: 32).
  --deadline-ms <ms>          Whole-check deadline (default 90000, max 300000).
  --allow-insecure-loopback-for-local-test
                              Explicit test-only escape. HTTP is still rejected
                              unless every insecure target is loopback.
  --help                      Show this help.

Isolated pre-enable candidate requirement:
  Temporarily set MAX_SESSIONS_PER_SOURCE=32 and
  QUICKPLAY_REQUESTS_PER_MINUTE=60 while retaining MAX_SESSIONS=32,
  MAX_ROOMS=4, and MAX_PLAYERS_PER_ROOM=8. Restore the production defaults
  MAX_SESSIONS_PER_SOURCE=4 and QUICKPLAY_REQUESTS_PER_MINUTE=12 before public
  enablement. This command sends no bypass header and must not target public play.
`;

const TEMPORARY_CANDIDATE_CONFIGURATION = Object.freeze({
  MAX_SESSIONS_PER_SOURCE: 32,
  QUICKPLAY_REQUESTS_PER_MINUTE: 60,
});
const PUBLIC_CONFIGURATION_TO_RESTORE = Object.freeze({
  MAX_SESSIONS_PER_SOURCE: 4,
  QUICKPLAY_REQUESTS_PER_MINUTE: 12,
});

export async function runLoad(arguments_ = process.argv.slice(2)) {
  const startedAt = performance.now();
  let options;
  try {
    options = parseLoadArguments(arguments_);
  } catch (error) {
    reportArgumentFailure(error, startedAt);
    return 1;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  writeEvidence({
    check: 'candidate-load',
    isolatedPreEnableCandidate: true,
    restoreBeforePublicEnablement: PUBLIC_CONFIGURATION_TO_RESTORE,
    stage: 'precondition',
    temporaryConfiguration: TEMPORARY_CANDIDATE_CONFIGURATION,
  });

  const deadline = new Deadline(options.deadlineMs);
  const sessions = [];
  let arenaCounts = [];
  let failure;

  try {
    await checkAuthorityHealth(options, deadline, 'authority-health-before-load');

    for (let index = 0; index < options.clientCount; index += 1) {
      const session = await admitCandidateSession(options, deadline);
      sessions.push(session);
      await session.attach(deadline);
      const attached = index + 1;
      if (attached % 8 === 0 || attached === options.clientCount) {
        writeEvidence({
          attachedClients: attached,
          check: 'candidate-load',
          elapsedMs: elapsed(startedAt),
          stage: 'attach-progress',
        });
      }
    }

    const groups = groupSessionsByArena(sessions);
    arenaCounts = [...groups.values()].map((group) => group.length).toSorted();
    assertPackedCapacity(options.clientCount, arenaCounts);

    const snapshotSets = await Promise.all(
      sessions.map((session) => session.waitForIncreasingSnapshots(2, deadline)),
    );
    for (const [index, session] of sessions.entries()) {
      const snapshots = snapshotSets[index];
      const finalSnapshot = snapshots?.at(-1);
      const expectedGroup = groups.get(session.arenaId);
      if (finalSnapshot === undefined || expectedGroup === undefined) {
        throw new DeploymentCheckError(
          'authoritative-snapshots',
          'snapshot-evidence-missing',
        );
      }
      const expectedPlayers = new Set(
        expectedGroup.map((candidate) => candidate.playerId),
      );
      const observedPlayers = new Set(finalSnapshot.players.map((player) => player.id));
      if (
        finalSnapshot.players.length !== expectedGroup.length ||
        observedPlayers.size !== expectedPlayers.size ||
        [...expectedPlayers].some((playerId) => !observedPlayers.has(playerId))
      ) {
        throw new DeploymentCheckError(
          'authoritative-snapshots',
          'arena-roster-mismatch',
        );
      }
    }

    await checkAuthorityHealth(options, deadline, 'authority-health-under-load');
    const leaveOutcomes = await Promise.allSettled(
      sessions.map((session) => session.leave(deadline)),
    );
    const leaveFailures = leaveOutcomes.filter(
      (outcome) => outcome.status === 'rejected',
    ).length;
    if (leaveFailures > 0) {
      throw new DeploymentCheckError(
        'clean-leave',
        `acknowledgement-failures-${leaveFailures}`,
      );
    }
  } catch (error) {
    failure = error;
  }

  const cleanupFailures = await cleanupSessions(sessions);
  if (failure !== undefined || cleanupFailures > 0) {
    const publicError = publicFailure(
      failure ?? new DeploymentCheckError('clean-leave', 'cleanup-failed'),
    );
    process.stderr.write(
      `${JSON.stringify({
        attachedClients: sessions.length,
        check: 'candidate-load',
        cleanupFailures,
        elapsedMs: elapsed(startedAt),
        ...publicError,
        status: 'failed',
      })}\n`,
    );
    return 1;
  }

  process.stdout.write(
    `${JSON.stringify({
      arenas: arenaCounts.length,
      buildId: options.buildId,
      capacityValidated: options.clientCount === 32,
      check: 'candidate-load',
      clients: options.clientCount,
      elapsedMs: elapsed(startedAt),
      health: 'ready',
      playersPerArena: arenaCounts,
      protocolVersion: 1,
      snapshotsPerClient: 2,
      status: 'passed',
    })}\n`,
  );
  return 0;
}

function groupSessionsByArena(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const group = groups.get(session.arenaId) ?? [];
    group.push(session);
    groups.set(session.arenaId, group);
  }
  return groups;
}

function assertPackedCapacity(clientCount, counts) {
  const expectedArenaCount = Math.ceil(clientCount / 8);
  const expectedCounts = Array.from({ length: expectedArenaCount }, (_, index) =>
    index === 0 && clientCount % 8 !== 0 ? clientCount % 8 : 8,
  ).toSorted();
  if (
    counts.length !== expectedCounts.length ||
    counts.some((count, index) => count !== expectedCounts[index])
  ) {
    throw new DeploymentCheckError('arena-capacity', 'room-packing-mismatch');
  }
  if (
    clientCount === 32 &&
    (counts.length !== 4 || counts.some((count) => count !== 8))
  ) {
    throw new DeploymentCheckError('arena-capacity', 'four-full-arenas-required');
  }
}

function writeEvidence(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function reportArgumentFailure(error, startedAt) {
  process.stderr.write(
    `${JSON.stringify({
      check: 'candidate-load',
      elapsedMs: elapsed(startedAt),
      option: error instanceof DeploymentArgumentError ? error.option : 'arguments',
      reason: 'invalid-arguments',
      status: 'failed',
    })}\n`,
  );
}

function elapsed(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

const executablePath = process.argv[1];
if (
  executablePath !== undefined &&
  import.meta.url === pathToFileURL(executablePath).href
) {
  void runLoad().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
