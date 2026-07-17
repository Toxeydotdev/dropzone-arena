import type { OnlineArenaConfig } from '@dropzone-arena/arena-client';

const MAX_BUILD_ID_LENGTH = 64;
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface PublicOnlineEnvironment {
  readonly VITE_BUILD_ID?: string;
  readonly VITE_ONLINE_AUTHORITY_URL?: string;
  readonly VITE_ONLINE_ENABLED?: string;
}

export interface PublicOnlineConfigContext {
  readonly browserOrigin: string;
  readonly production: boolean;
}

export function parsePublicOnlineConfig(
  environment: PublicOnlineEnvironment,
  context: PublicOnlineConfigContext,
): OnlineArenaConfig {
  const enabled = environment.VITE_ONLINE_ENABLED;
  if (enabled === undefined) {
    return disabled(
      'Public quickplay is disabled because online enablement is missing.',
    );
  }
  if (enabled === 'false') {
    return disabled('Public quickplay is disabled for this build.');
  }
  if (enabled !== 'true') {
    return disabled(
      'Public quickplay is disabled because online enablement must be exactly "true" or "false".',
    );
  }

  const buildId = environment.VITE_BUILD_ID;
  if (buildId === undefined || buildId.length === 0) {
    return disabled('Public quickplay is disabled because this build has no build ID.');
  }
  if (buildId.length > MAX_BUILD_ID_LENGTH || !BUILD_ID_PATTERN.test(buildId)) {
    return disabled(
      'Public quickplay is disabled because this build has an invalid build ID.',
    );
  }

  const configuredAuthority = environment.VITE_ONLINE_AUTHORITY_URL;
  if (configuredAuthority === undefined || configuredAuthority.length === 0) {
    return disabled(
      'Public quickplay is disabled because no online authority is configured.',
    );
  }
  if (configuredAuthority !== configuredAuthority.trim()) {
    return disabled(
      'Public quickplay is disabled because the online authority is malformed.',
    );
  }
  if (configuredAuthority === '/' && context.production) {
    return disabled(
      'Public quickplay is disabled because same-origin authority is development-only.',
    );
  }

  const authorityValue =
    configuredAuthority === '/' ? context.browserOrigin : configuredAuthority;
  let authority: URL;
  try {
    authority = new URL(authorityValue);
  } catch {
    return disabled(
      'Public quickplay is disabled because the online authority is malformed.',
    );
  }

  if (authority.protocol !== 'http:' && authority.protocol !== 'https:') {
    return disabled(
      'Public quickplay is disabled because the online authority must use HTTP or HTTPS.',
    );
  }
  if (authority.username !== '' || authority.password !== '') {
    return disabled(
      'Public quickplay is disabled because the online authority cannot contain credentials.',
    );
  }
  if (authority.pathname !== '/') {
    return disabled(
      'Public quickplay is disabled because the online authority must not contain a path.',
    );
  }
  if (
    authority.search !== '' ||
    authority.hash !== '' ||
    authorityValue.includes('?') ||
    authorityValue.includes('#')
  ) {
    return disabled(
      'Public quickplay is disabled because the online authority cannot contain a query or hash.',
    );
  }
  const localOrLoopback = isLocalOrLoopback(authority.hostname);
  if (authority.protocol === 'http:' && context.production && !localOrLoopback) {
    return disabled(
      'Public quickplay is disabled because production authority requires HTTPS.',
    );
  }
  if (authority.protocol === 'http:' && !localOrLoopback) {
    return disabled(
      'Public quickplay is disabled because insecure authority is limited to local development.',
    );
  }

  return {
    authorityUrl: authority.origin,
    buildId,
    enabled: true,
  };
}

function disabled(reason: string): OnlineArenaConfig {
  return { enabled: false, reason };
}

function isLocalOrLoopback(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');
  if (
    normalizedHostname === 'localhost' ||
    normalizedHostname.endsWith('.localhost') ||
    normalizedHostname === '::1' ||
    normalizedHostname === '[::1]'
  ) {
    return true;
  }

  const octets = normalizedHostname.split('.');
  return octets.length === 4 && octets[0] === '127';
}
