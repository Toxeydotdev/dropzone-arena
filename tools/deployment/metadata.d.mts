import type { PluginOption } from 'vite';

export const DEPLOYMENT_METADATA_SCHEMA_VERSION: 1;
export const DEPLOYMENT_PROTOCOL_VERSION: 1;

interface DeploymentIdentity {
  readonly buildId: string;
  readonly configurationId: string;
  readonly protocolVersion: 1;
  readonly release: boolean;
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
}

export interface WebDeploymentMetadata extends DeploymentIdentity {
  readonly publicConfiguration: {
    readonly authorityOrigin: string | null;
    readonly onlineEnabled: boolean;
  };
  readonly service: 'dropzone-arena-web';
}

export interface AuthorityDeploymentMetadata extends DeploymentIdentity {
  readonly publicConfiguration: {
    readonly allowedWebOrigins: readonly string[];
  };
  readonly service: 'dropzone-arena-authority';
}

export type DeploymentMetadata = AuthorityDeploymentMetadata | WebDeploymentMetadata;

type Environment = Readonly<Record<string, string | undefined>>;

export function resolveWebDeploymentMetadata(
  environment: Environment,
): WebDeploymentMetadata;

export function resolveAuthorityDeploymentMetadata(
  environment: Environment,
): AuthorityDeploymentMetadata;

export function parseDeploymentMetadata(value: unknown): DeploymentMetadata;

export function createViteDeploymentMetadataPlugin(
  metadata: DeploymentMetadata,
): PluginOption;
