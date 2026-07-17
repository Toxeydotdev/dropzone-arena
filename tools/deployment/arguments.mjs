import { isIP } from 'node:net';

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const sourceRevisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LOOPBACK_ESCAPE = 'allow-insecure-loopback-for-local-test';

export class DeploymentArgumentError extends Error {
  constructor(option, reason = 'is invalid') {
    super(`Deployment option --${option} ${reason}.`);
    this.name = 'DeploymentArgumentError';
    this.option = option;
  }
}

export function parseSmokeArguments(arguments_) {
  const options = parseOptions(arguments_, {
    [LOOPBACK_ESCAPE]: 'flag',
    'authority-url': 'value',
    'build-id': 'value',
    'configuration-id': 'value',
    'deadline-ms': 'value',
    'source-revision': 'value',
    'unlisted-origin': 'value',
    'web-url': 'value',
  });
  if (options.help) return options;

  const allowInsecureLoopbackForLocalTest = options[LOOPBACK_ESCAPE] === true;
  const webOrigin = requiredOrigin(options, 'web-url');
  const authorityOrigin = requiredOrigin(options, 'authority-url');
  const unlistedOrigin = optionalOrigin(
    options,
    'unlisted-origin',
    'https://deployment-smoke-unlisted.invalid',
  );
  requireDistinctOrigins(webOrigin, authorityOrigin, 'authority-url');
  requireDistinctOrigins(webOrigin, unlistedOrigin, 'unlisted-origin');
  requireDistinctOrigins(authorityOrigin, unlistedOrigin, 'unlisted-origin');
  assertSecureOrigin(webOrigin, allowInsecureLoopbackForLocalTest, 'web-url');
  assertSecureOrigin(
    authorityOrigin,
    allowInsecureLoopbackForLocalTest,
    'authority-url',
  );
  assertSecureOrigin(
    unlistedOrigin,
    allowInsecureLoopbackForLocalTest,
    'unlisted-origin',
  );

  return {
    allowInsecureLoopbackForLocalTest,
    authorityOrigin,
    buildId: requiredIdentity(options, 'build-id'),
    configurationId: requiredIdentity(options, 'configuration-id'),
    deadlineMs: optionalInteger(options, 'deadline-ms', 30_000, 5_000, 120_000),
    help: false,
    sourceRevision: requiredSourceRevision(options),
    unlistedOrigin,
    webOrigin,
  };
}

export function parseLoadArguments(arguments_) {
  const options = parseOptions(arguments_, {
    [LOOPBACK_ESCAPE]: 'flag',
    'authority-url': 'value',
    'build-id': 'value',
    clients: 'value',
    'confirm-isolated-pre-enable-candidate': 'flag',
    'deadline-ms': 'value',
    'web-origin': 'value',
  });
  if (options.help) return options;
  if (options['confirm-isolated-pre-enable-candidate'] !== true) {
    throw new DeploymentArgumentError(
      'confirm-isolated-pre-enable-candidate',
      'must be explicitly provided',
    );
  }

  const allowInsecureLoopbackForLocalTest = options[LOOPBACK_ESCAPE] === true;
  const authorityOrigin = requiredOrigin(options, 'authority-url');
  const webOrigin = requiredOrigin(options, 'web-origin');
  requireDistinctOrigins(webOrigin, authorityOrigin, 'authority-url');
  assertSecureOrigin(
    authorityOrigin,
    allowInsecureLoopbackForLocalTest,
    'authority-url',
  );
  assertSecureOrigin(webOrigin, allowInsecureLoopbackForLocalTest, 'web-origin');

  return {
    allowInsecureLoopbackForLocalTest,
    authorityOrigin,
    buildId: requiredIdentity(options, 'build-id'),
    clientCount: optionalInteger(options, 'clients', 32, 1, 32),
    deadlineMs: optionalInteger(options, 'deadline-ms', 90_000, 10_000, 300_000),
    help: false,
    webOrigin,
  };
}

function parseOptions(arguments_, specification) {
  const parsed = { help: false };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--help' || argument === '-h') {
      if (arguments_.length !== 1) throw new DeploymentArgumentError('help');
      return { help: true };
    }
    if (argument === undefined || !argument.startsWith('--')) {
      throw new DeploymentArgumentError('arguments');
    }

    const equalsIndex = argument.indexOf('=');
    const key = argument.slice(2, equalsIndex < 0 ? undefined : equalsIndex);
    const kind = specification[key];
    if (kind === undefined) throw new DeploymentArgumentError('arguments');
    if (Object.hasOwn(parsed, key)) throw new DeploymentArgumentError(key);

    if (kind === 'flag') {
      if (equalsIndex >= 0) throw new DeploymentArgumentError(key);
      parsed[key] = true;
      continue;
    }

    const inlineValue = equalsIndex < 0 ? undefined : argument.slice(equalsIndex + 1);
    const value = inlineValue ?? arguments_[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new DeploymentArgumentError(key, 'requires a value');
    }
    if (inlineValue === undefined) index += 1;
    parsed[key] = value;
  }

  return parsed;
}

function requiredOrigin(options, key) {
  const value = requiredString(options, key);
  return parseOrigin(value, key);
}

function optionalOrigin(options, key, fallback) {
  const value = options[key];
  return parseOrigin(typeof value === 'string' ? value : fallback, key);
}

function parseOrigin(value, key) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new DeploymentArgumentError(key);
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== value
  ) {
    throw new DeploymentArgumentError(key);
  }
  return parsed.origin;
}

function assertSecureOrigin(origin, allowLoopback, key) {
  const parsed = new URL(origin);
  if (parsed.protocol === 'https:') return;
  if (allowLoopback && isLoopbackHostname(parsed.hostname)) return;
  throw new DeploymentArgumentError(
    key,
    `requires HTTPS unless --${LOOPBACK_ESCAPE} targets loopback`,
  );
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split('.')[0] === '127';
}

function requireDistinctOrigins(left, right, key) {
  if (left === right)
    throw new DeploymentArgumentError(key, 'must use a distinct origin');
}

function requiredIdentity(options, key) {
  const value = requiredString(options, key);
  if (value.length > 64 || !identityPattern.test(value) || value === 'local') {
    throw new DeploymentArgumentError(key);
  }
  return value;
}

function requiredSourceRevision(options) {
  const value = requiredString(options, 'source-revision');
  if (!sourceRevisionPattern.test(value)) {
    throw new DeploymentArgumentError('source-revision');
  }
  return value;
}

function optionalInteger(options, key, fallback, minimum, maximum) {
  const raw = options[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) {
    throw new DeploymentArgumentError(key);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DeploymentArgumentError(key);
  }
  return value;
}

function requiredString(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new DeploymentArgumentError(key, 'is required');
  }
  return value;
}
