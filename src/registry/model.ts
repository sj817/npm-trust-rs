//! Trusted-publishing data model. JSON shapes mirror the npm registry trust API
//! (`docs/api.md` §4) exactly: a config serializes to `{ id?, type, claims, permissions }`,
//! with `id` omitted on create and optional claim fields omitted when absent (never null).

/** Allowed actions on a trusted-publisher config (npm wire values). */
export type Permission = 'createPackage' | 'createStagedPackage'

export const Permission = {
  /** `--allow-publish` */
  Publish: 'createPackage' as Permission,
  /** `--allow-stage-publish` */
  StagePublish: 'createStagedPackage' as Permission,
}

export interface CircleciClaims {
  'oidc.circleci.com/context-ids'?: string[]
  'oidc.circleci.com/org-id': string
  'oidc.circleci.com/pipeline-definition-id': string
  'oidc.circleci.com/project-id': string
  /** `github.com/owner/repo`, no scheme. */
  'oidc.circleci.com/vcs-origin': string
}

export type Claims = CircleciClaims | GithubClaims | GitlabClaims

export interface FileRef {
  file: string
}

export interface GithubClaims {
  environment?: string
  repository: string
  workflow_ref: FileRef
}

export interface GitlabClaims {
  ci_config_ref_uri: FileRef
  environment?: string
  project_path: string
}

export type ProviderKind = 'circleci' | 'github' | 'gitlab'

/** A trust configuration. Flattened `type` + `claims` match the wire envelope. */
export interface TrustConfig {
  claims: Claims
  /** Absent in create requests; echoed by the registry in responses. */
  id?: string
  permissions: Permission[]
  type: ProviderKind
}

/** Whoami response. */
export interface Whoami {
  username: string
}

/**
 * The slice of a version manifest (`GET /<name>/<tag>`) npt reads: for a native
 * addon, `optionalDependencies` names the per-platform sub-packages and
 * `repository` says where the binding should point.
 */
export interface Manifest {
  name: string
  optionalDependencies?: Record<string, string>
  repository?: unknown
  version: string
}

/** Build a GitHub Actions trust config. `environment` is omitted when undefined. */
export function githubTrust(
  repository: string,
  workflowFile: string,
  environment: string | undefined,
  permissions: Permission[],
): TrustConfig {
  const claims: GithubClaims = { repository, workflow_ref: { file: workflowFile } }
  if (environment !== undefined && environment !== '') claims.environment = environment
  return { type: 'github', claims, permissions }
}

/** Build a GitLab CI trust config. `environment` is omitted when undefined. */
export function gitlabTrust(
  projectPath: string,
  pipelineFile: string,
  environment: string | undefined,
  permissions: Permission[],
): TrustConfig {
  const claims: GitlabClaims = {
    project_path: projectPath,
    ci_config_ref_uri: { file: pipelineFile },
  }
  if (environment !== undefined && environment !== '') claims.environment = environment
  return { type: 'gitlab', claims, permissions }
}

/** Human label for a permission (`publish` / `stage publish`). */
export function permissionLabel(p: Permission): string {
  return p === 'createStagedPackage' ? 'stage publish' : 'publish'
}

/**
 * True if two configs describe the same binding: identical provider + claims and
 * the same permission set (order-insensitive), ignoring `id`.
 */
export function sameBinding(a: TrustConfig, b: TrustConfig): boolean {
  if (a.type !== b.type) return false
  if (!deepEqual(a.claims, b.claims)) return false
  const pa = a.permissions.toSorted((x, y) => x.localeCompare(y))
  const pb = b.permissions.toSorted((x, y) => x.localeCompare(y))
  return pa.length === pb.length && pa.every((v, i) => v === pb[i])
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  const bk = Object.keys(bo)
  if (ak.length !== bk.length) return false
  return ak.every(k => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]))
}
