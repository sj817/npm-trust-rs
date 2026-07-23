//! Protocol-level tests against a mock registry (wiremock).
//!
//! Each test asserts the exact path/method/headers/body the Rust client sends,
//! matching the contract in `docs/api.md`.

use npm_trust::{Client, Error, Permission, TrustConfig};
use serde_json::json;
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn client(server: &MockServer) -> Client {
    Client::builder()
        .base_url(server.uri())
        .token(Some("test-token".into()))
        .max_retries(2)
        .build()
        .unwrap()
}

#[tokio::test]
async fn whoami_sends_bearer_and_parses_username() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/-/whoami"))
        .and(header("authorization", "Bearer test-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "username": "alice" })))
        .mount(&server)
        .await;

    let who = client(&server).whoami().await.unwrap();
    assert_eq!(who.username, "alice");
}

#[tokio::test]
async fn package_exists_maps_200_and_404() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/exists-pkg"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "name": "exists-pkg" })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/missing-pkg"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({ "error": "Not found" })))
        .mount(&server)
        .await;

    let c = client(&server);
    assert!(c.package_exists("exists-pkg").await.unwrap());
    assert!(!c.package_exists("missing-pkg").await.unwrap());
}

#[tokio::test]
async fn list_trust_escapes_scoped_name_and_normalizes_single_object() {
    let server = MockServer::start().await;
    // Scoped name must be escaped: @acme/widget -> @acme%2fwidget
    Mock::given(method("GET"))
        .and(path("/-/package/@acme%2fwidget/trust"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "cfg_1",
            "type": "github",
            "claims": { "repository": "acme/widget", "workflow_ref": { "file": "publish.yml" } },
            "permissions": ["createPackage"]
        })))
        .mount(&server)
        .await;

    let configs = client(&server).list_trust("@acme/widget").await.unwrap();
    assert_eq!(configs.len(), 1);
    assert_eq!(configs[0].id.as_deref(), Some("cfg_1"));
    assert_eq!(configs[0].permissions, vec![Permission::Publish]);
}

#[tokio::test]
async fn create_trust_posts_one_element_array_body() {
    let server = MockServer::start().await;
    let expected_body = json!([{
        "type": "github",
        "claims": { "repository": "acme/widget", "workflow_ref": { "file": "publish.yml" } },
        "permissions": ["createPackage"]
    }]);
    Mock::given(method("POST"))
        .and(path("/-/package/widget/trust"))
        .and(header("authorization", "Bearer test-token"))
        .and(body_json(&expected_body))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "cfg_new",
            "type": "github",
            "claims": { "repository": "acme/widget", "workflow_ref": { "file": "publish.yml" } },
            "permissions": ["createPackage"]
        })))
        .mount(&server)
        .await;

    let cfg = TrustConfig::github("acme/widget", "publish.yml", None, vec![Permission::Publish]);
    let created = client(&server)
        .create_trust("widget", &cfg, None)
        .await
        .unwrap();
    assert_eq!(created[0].id.as_deref(), Some("cfg_new"));
}

#[tokio::test]
async fn revoke_trust_deletes_urlencoded_id() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/-/package/widget/trust/cfg%2F1"))
        .and(header("authorization", "Bearer test-token"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    client(&server)
        .revoke_trust("widget", "cfg/1", None)
        .await
        .unwrap();
}

#[tokio::test]
async fn otp_challenge_is_surfaced_then_replay_with_header_succeeds() {
    let server = MockServer::start().await;

    // First POST with no OTP -> 401 otp challenge.
    Mock::given(method("POST"))
        .and(path("/-/package/widget/trust"))
        .and(header("npm-otp", "123456"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "cfg_ok", "type": "github",
            "claims": { "repository": "acme/widget", "workflow_ref": { "file": "p.yml" } },
            "permissions": ["createPackage"]
        })))
        .mount(&server)
        .await;
    // Without the npm-otp header, respond with the challenge.
    Mock::given(method("POST"))
        .and(path("/-/package/widget/trust"))
        .respond_with(
            ResponseTemplate::new(401)
                .insert_header("www-authenticate", "OTP")
                .set_body_json(json!({ "error": "This operation requires a one-time password" })),
        )
        .mount(&server)
        .await;

    let cfg = TrustConfig::github("acme/widget", "p.yml", None, vec![Permission::Publish]);
    let c = client(&server);

    // No OTP -> OtpRequired.
    let err = c.create_trust("widget", &cfg, None).await.unwrap_err();
    assert!(matches!(err, Error::OtpRequired(_)), "got {err:?}");

    // Replay with OTP -> success.
    let created = c
        .create_trust("widget", &cfg, Some("123456"))
        .await
        .unwrap();
    assert_eq!(created[0].id.as_deref(), Some("cfg_ok"));
}

#[tokio::test]
async fn otp_detected_by_body_heuristic_without_header() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/-/package/widget/trust/x"))
        .respond_with(
            ResponseTemplate::new(401)
                .set_body_string("you need a one-time password to continue"),
        )
        .mount(&server)
        .await;

    let err = client(&server)
        .revoke_trust("widget", "x", None)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::OtpRequired(_)), "got {err:?}");
}

#[tokio::test]
async fn rate_limit_is_retried_then_succeeds() {
    let server = MockServer::start().await;
    // wiremock serves the most-recently-registered matching mock first and honors
    // `up_to_n_times`; register the 429 (limited to one hit) before the success.
    Mock::given(method("GET"))
        .and(path("/-/package/widget/trust"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/-/package/widget/trust"))
        .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "0"))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    let configs = client(&server).list_trust("widget").await.unwrap();
    assert!(configs.is_empty());
}

#[tokio::test]
async fn error_codes_map_to_typed_errors() {
    let cases = [
        (403, "no perms", "Forbidden"),
        (404, "gone", "NotFound"),
        (409, "already exists", "Conflict"),
        (500, "boom", "Registry"),
    ];
    for (status, msg, want) in cases {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/-/package/widget/trust"))
            .respond_with(ResponseTemplate::new(status).set_body_json(json!({ "error": msg })))
            .mount(&server)
            .await;
        // No retries so 500 fails fast.
        let c = Client::builder()
            .base_url(server.uri())
            .token(Some("t".into()))
            .max_retries(0)
            .build()
            .unwrap();
        let err = c.list_trust("widget").await.unwrap_err();
        let got = match err {
            Error::Forbidden(_) => "Forbidden",
            Error::NotFound(_) => "NotFound",
            Error::Conflict(_) => "Conflict",
            Error::Registry { .. } => "Registry",
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(got, want, "status {status}");
    }
}

#[tokio::test]
async fn ip_blocked_maps_from_www_authenticate() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/-/whoami"))
        .respond_with(
            ResponseTemplate::new(401).insert_header("www-authenticate", "IPAddress"),
        )
        .mount(&server)
        .await;
    let err = client(&server).whoami().await.unwrap_err();
    assert!(matches!(err, Error::IpBlocked), "got {err:?}");
}
