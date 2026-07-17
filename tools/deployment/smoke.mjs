import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { DeploymentArgumentError, parseSmokeArguments } from './arguments.mjs';
import {
  Deadline,
  DeploymentCheckError,
  admitCandidateSession,
  checkAuthorityHealth,
  checkExactCors,
  checkStaticWeb,
  cleanupSessions,
  publicFailure,
} from './runtime.mjs';

const HELP = `Usage:
  npm run deploy:smoke -- \\
    --web-url https://candidate.example \\
    --authority-url https://authority.example \\
    --build-id <immutable-build-id> \\
    --source-revision <full-40-or-64-character-git-revision> \\
    --configuration-id <public-configuration-revision>

Options:
  --unlisted-origin <origin>  Known-unlisted HTTPS origin used for rejection.
  --deadline-ms <ms>          Whole-check deadline (default 30000, max 120000).
  --allow-insecure-loopback-for-local-test
                              Explicit test-only escape. HTTP is still rejected
                              unless every insecure target is loopback.
  --help                      Show this help.

The check requires release deployment metadata and validates HTTPS/WSS (or the
explicit loopback-only test escape), revalidated static entry and metadata,
health identity/no-store, exact CORS, anonymous admission, WebSocket welcome,
strictly increasing snapshots, and acknowledged leave.
`;

export async function runSmoke(arguments_ = process.argv.slice(2)) {
  const startedAt = performance.now();
  let options;
  try {
    options = parseSmokeArguments(arguments_);
  } catch (error) {
    reportArgumentFailure(error, startedAt);
    return 1;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const deadline = new Deadline(options.deadlineMs);
  const sessions = [];
  let failure;
  let snapshotCount = 0;

  try {
    await checkStaticWeb(options, deadline);
    await checkAuthorityHealth(options, deadline);
    await checkExactCors(options, deadline);

    const session = await admitCandidateSession(options, deadline);
    sessions.push(session);
    await session.attach(deadline);
    const snapshots = await session.waitForIncreasingSnapshots(2, deadline);
    snapshotCount = snapshots.length;
    const finalSnapshot = snapshots.at(-1);
    if (
      finalSnapshot === undefined ||
      !finalSnapshot.players.some((player) => player.id === session.playerId)
    ) {
      throw new DeploymentCheckError(
        'authoritative-snapshots',
        'local-session-missing',
      );
    }
    await session.leave(deadline);
    await checkAuthorityHealth(options, deadline, 'authority-health-after-leave');
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
        check: 'deployment-smoke',
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
      buildId: options.buildId,
      check: 'deployment-smoke',
      configurationId: options.configurationId,
      elapsedMs: elapsed(startedAt),
      protocolVersion: 1,
      service: 'dropzone-arena-authority',
      snapshots: snapshotCount,
      sourceRevision: options.sourceRevision,
      status: 'passed',
      transport:
        new URL(options.authorityOrigin).protocol === 'https:'
          ? 'wss'
          : 'ws-loopback-local-test',
    })}\n`,
  );
  return 0;
}

function reportArgumentFailure(error, startedAt) {
  process.stderr.write(
    `${JSON.stringify({
      check: 'deployment-smoke',
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
  void runSmoke().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
