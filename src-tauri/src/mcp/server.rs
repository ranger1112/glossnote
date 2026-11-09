use crate::mcp::tools::GlossnoteServer;
use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use std::sync::Arc;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;

pub fn router(app: AppHandle, token: String, cancel: CancellationToken) -> Router {
    let server = GlossnoteServer::new(app);
    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default()
            // rmcp 默认只接受 loopback Host；这里再显式写一遍，避免上游默认值变化。
            .with_allowed_hosts(["127.0.0.1", "localhost", "::1"])
            // 空 allowlist + enforce = 任何带 Origin 的请求都拒绝。
            .enforce_origin_validation()
            .with_max_request_body_bytes(MAX_REQUEST_BYTES)
            .with_cancellation_token(cancel),
    );

    let expected = format!("/mcp/{token}");
    Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(
            Arc::<str>::from(expected),
            token_guard,
        ))
}

fn token_matches(path: &str, expected: &str) -> bool {
    path == expected
}

async fn token_guard(State(expected): State<Arc<str>>, request: Request, next: Next) -> Response {
    if !token_matches(request.uri().path(), &expected) {
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use rmcp::{
        model::{ServerCapabilities, ServerConfig},
        ServerHandler,
    };

    #[test]
    fn token_path_must_match_exactly() {
        assert!(token_matches("/mcp/abc", "/mcp/abc"));
        assert!(!token_matches("/mcp/abc/", "/mcp/abc"));
        assert!(!token_matches("/mcp/wrong", "/mcp/abc"));
        assert!(!token_matches("/mcp", "/mcp/abc"));
    }

    #[derive(Clone)]
    struct Dummy;

    impl ServerHandler for Dummy {
        fn get_info(&self) -> ServerConfig {
            ServerConfig::new(ServerCapabilities::builder().build())
        }
    }

    #[tokio::test]
    async fn origin_header_is_rejected() {
        let service = StreamableHttpService::new(
            || Ok(Dummy),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default().enforce_origin_validation(),
        );
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/mcp/abc")
            .header("Host", "127.0.0.1:8765")
            .header("Origin", "http://evil.example")
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .body(Body::from("{}"))
            .unwrap();
        let response = service.handle(request).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
