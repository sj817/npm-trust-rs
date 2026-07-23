//! # npm-trust
//!
//! A native Rust client for the npm registry **Trusted Publishing** (OIDC) API —
//! the endpoints behind `npm trust`. It talks to `registry.npmjs.org` directly and
//! does **not** shell out to npm, so it works regardless of the local npm version
//! (including npm 9/10, which lack the `npm trust` command).
//!
//! The wire protocol is documented in [`docs/api.md`](https://github.com/sj817/npm-trust-rs/blob/main/docs/api.md),
//! extracted from npm CLI source at tag v11.16.0.
//!
//! ## Example
//!
//! ```no_run
//! use npm_trust::{Client, TrustConfig, Permission, npmrc};
//!
//! # async fn run() -> Result<(), Box<dyn std::error::Error>> {
//! let token = npmrc::resolve_token().map(|c| c.token);
//! let client = Client::builder().token(token).build()?;
//!
//! // Validate identity.
//! let me = client.whoami().await?;
//! println!("logged in as {}", me.username);
//!
//! // Create a GitHub Actions binding.
//! let cfg = TrustConfig::github("my-org/my-repo", "publish.yml", None, vec![Permission::Publish]);
//! match client.create_trust("my-pkg", &cfg, None).await {
//!     Ok(created) => println!("bound: {:?}", created),
//!     Err(npm_trust::Error::OtpRequired(_)) => {
//!         // prompt for OTP, then retry with `Some(otp)`
//!     }
//!     Err(e) => return Err(e.into()),
//! }
//! # Ok(())
//! # }
//! ```

mod client;
mod error;
pub mod model;
pub mod npmrc;

pub use client::{Client, ClientBuilder, DEFAULT_REGISTRY};
pub use error::{Error, OtpChallenge, Result, WebOtp};
pub use model::{
    CircleciClaims, FileRef, GithubClaims, GitlabClaims, Permission, Provider, TrustConfig, Whoami,
};
