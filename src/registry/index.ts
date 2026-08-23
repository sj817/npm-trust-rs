//! Native TypeScript client for the npm registry Trusted Publishing (OIDC) API.
//!
//! See `docs/api.md` for the reverse-engineered wire protocol this implements.

export { Client, DEFAULT_REGISTRY } from './client'
export type { ClientOptions } from './client'

export {
  ConflictError,
  DecodeError,
  ForbiddenError,
  IpBlockedError,
  isRetryable,
  NetworkError,
  NoCredentialsError,
  NotFoundError,
  NptError,
  OtpRequiredError,
  RateLimitedError,
  RegistryError,
  UnauthorizedError,
} from './errors'
export type { OtpChallenge, WebOtp } from './errors'

export { githubTrust, gitlabTrust, Permission, permissionLabel, sameBinding } from './model'
export type {
  CircleciClaims,
  Claims,
  FileRef,
  GithubClaims,
  GitlabClaims,
  ProviderKind,
  TrustConfig,
  Whoami,
} from './model'

export {
  credentialSourceLabel,
  DEFAULT_REGISTRY_HOST,
  resolveToken,
  tokenFromNpmrcStr,
  userNpmrcPath,
} from './npmrc'
export type { Credential, CredentialSource } from './npmrc'
