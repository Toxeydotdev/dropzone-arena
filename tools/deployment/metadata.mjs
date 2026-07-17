import { z } from 'zod';

export const DEPLOYMENT_METADATA_SCHEMA_VERSION = 1;
export const DEPLOYMENT_PROTOCOL_VERSION = 1;

const LOCAL_IDENTITY = 'local';
const WEB_SERVICE = 'dropzone-arena-web';
const AUTHORITY_SERVICE = 'dropzone-arena-authority';
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const sourceRevisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const IdentitySchema = z.string().min(1).max(64).regex(identityPattern);
const SourceRevisionSchema = z.union([
  z.literal(LOCAL_IDENTITY),
  z.string().regex(sourceRevisionPattern),
]);
const PublicOriginSchema = z.string().refine(isExactHttpOrigin, {
  message: 'Must be an exact HTTP(S) origin.',
});

const DeploymentBaseShape = {
  buildId: IdentitySchema,
  configurationId: IdentitySchema,
  protocolVersion: z.literal(DEPLOYMENT_PROTOCOL_VERSION),
  release: z.boolean(),
  schemaVersion: z.literal(DEPLOYMENT_METADATA_SCHEMA_VERSION),
  sourceRevision: SourceRevisionSchema,
};

const WebDeploymentMetadataSchema = z.strictObject({
  ...DeploymentBaseShape,
  publicConfiguration: z.strictObject({
    authorityOrigin: z.union([PublicOriginSchema, z.literal('same-origin'), z.null()]),
    onlineEnabled: z.boolean(),
  }),
  service: z.literal(WEB_SERVICE),
});

const AuthorityDeploymentMetadataSchema = z.strictObject({
  ...DeploymentBaseShape,
  publicConfiguration: z.strictObject({
    allowedWebOrigins: z.array(PublicOriginSchema).max(16),
  }),
  service: z.literal(AUTHORITY_SERVICE),
});

const DeploymentMetadataSchema = z.discriminatedUnion('service', [
  WebDeploymentMetadataSchema,
  AuthorityDeploymentMetadataSchema,
]);

export function resolveWebDeploymentMetadata(environment) {
  const release = resolveReleaseMode(environment);
  const identity = resolveIdentity(environment, 'VITE_BUILD_ID', release, true);
  const enabledValue = environment.VITE_ONLINE_ENABLED;
  if (release && enabledValue === undefined) {
    invalid('VITE_ONLINE_ENABLED');
  }
  if (
    enabledValue !== undefined &&
    enabledValue !== 'true' &&
    enabledValue !== 'false'
  ) {
    invalid('VITE_ONLINE_ENABLED');
  }

  const onlineEnabled = enabledValue === 'true';
  let authorityOrigin = null;
  if (onlineEnabled) {
    const configuredAuthority = required(environment, 'VITE_ONLINE_AUTHORITY_URL');
    if (configuredAuthority === '/') {
      if (release) invalid('VITE_ONLINE_AUTHORITY_URL');
      authorityOrigin = 'same-origin';
    } else {
      if (!isExactHttpOrigin(configuredAuthority)) {
        invalid('VITE_ONLINE_AUTHORITY_URL');
      }
      authorityOrigin = new URL(configuredAuthority).origin;
    }
  }

  return parseDeploymentMetadata({
    ...identity,
    publicConfiguration: { authorityOrigin, onlineEnabled },
    release,
    service: WEB_SERVICE,
  });
}

export function resolveAuthorityDeploymentMetadata(environment) {
  const release = resolveReleaseMode(environment);
  const identity = resolveIdentity(environment, 'BUILD_ID', release, false);
  const allowedWebOrigins = release
    ? parseOriginList(required(environment, 'ALLOWED_WEB_ORIGINS'))
    : [];

  return parseDeploymentMetadata({
    ...identity,
    publicConfiguration: { allowedWebOrigins },
    release,
    service: AUTHORITY_SERVICE,
  });
}

export function parseDeploymentMetadata(value) {
  const parsed = DeploymentMetadataSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid deployment metadata.');
  return parsed.data;
}

export function createViteDeploymentMetadataPlugin(metadata) {
  const validated = parseDeploymentMetadata(metadata);
  const source = `${JSON.stringify(validated, null, 2)}\n`;

  return {
    apply: 'build',
    generateBundle() {
      this.emitFile({
        fileName: 'deployment.json',
        source,
        type: 'asset',
      });
    },
    name: 'dropzone-arena-deployment-metadata',
  };
}

function resolveIdentity(environment, buildIdKey, release, useLocalBuildId) {
  const buildId = release
    ? required(environment, buildIdKey)
    : useLocalBuildId
      ? (environment[buildIdKey] ?? LOCAL_IDENTITY)
      : LOCAL_IDENTITY;
  if (!IdentitySchema.safeParse(buildId).success) invalid(buildIdKey);

  if (!release) {
    return {
      buildId,
      configurationId: LOCAL_IDENTITY,
      protocolVersion: DEPLOYMENT_PROTOCOL_VERSION,
      schemaVersion: DEPLOYMENT_METADATA_SCHEMA_VERSION,
      sourceRevision: LOCAL_IDENTITY,
    };
  }

  const sourceRevision = required(environment, 'DEPLOYMENT_SOURCE_REVISION');
  const configurationId = required(environment, 'DEPLOYMENT_CONFIGURATION_ID');
  if (!sourceRevisionPattern.test(sourceRevision)) {
    invalid('DEPLOYMENT_SOURCE_REVISION');
  }
  if (
    configurationId === LOCAL_IDENTITY ||
    !IdentitySchema.safeParse(configurationId).success
  ) {
    invalid('DEPLOYMENT_CONFIGURATION_ID');
  }
  if (buildId === LOCAL_IDENTITY) invalid(buildIdKey);

  return {
    buildId,
    configurationId,
    protocolVersion: DEPLOYMENT_PROTOCOL_VERSION,
    schemaVersion: DEPLOYMENT_METADATA_SCHEMA_VERSION,
    sourceRevision,
  };
}

function resolveReleaseMode(environment) {
  const value = environment.DEPLOYMENT_RELEASE;
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  return invalid('DEPLOYMENT_RELEASE');
}

function parseOriginList(value) {
  const origins = value.split(',').map((entry) => entry.trim());
  if (
    origins.length === 0 ||
    origins.some((origin) => !isExactHttpOrigin(origin)) ||
    new Set(origins).size !== origins.length
  ) {
    invalid('ALLOWED_WEB_ORIGINS');
  }
  return origins;
}

function isExactHttpOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return (
    (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.pathname === '/' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.origin === value
  );
}

function required(environment, key) {
  const value = environment[key];
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    invalid(key);
  }
  return value;
}

function invalid(key) {
  throw new Error(`Invalid deployment metadata configuration: ${key}`);
}
