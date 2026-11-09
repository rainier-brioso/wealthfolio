use super::*;
use crate::env::test_env::{MockEnvironment, MockSettingsService};
use crate::{ChatConfig, ChatService};
use std::sync::RwLock;

#[test]
fn matching_allows_cold_local_models_more_than_two_minutes_without_extending_cloud_requests() {
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("ai_providers.json")).unwrap();
    // Exercise the actual provider classification used by matching.
    let providers = catalog["providers"].as_object().unwrap();
    for id in ["custom", "ollama", "openai"] {
        let provider = &providers[id];
        let timeout = matching_timeout(provider["type"].as_str().unwrap());
        if id == "openai" {
            assert_eq!(timeout, Duration::from_secs(120));
        } else {
            assert_eq!(timeout, Duration::from_secs(600));
        }
    }
}

fn context() -> ImportMatchContext {
    serde_json::from_value(serde_json::json!({
      "operations":[{"id":"S1","date":"2026-10-29","settlementDate":"2026-11-02","kind":"BUY","name":"Developed WRD","isin":"IE0000000001","quantity":"2","unitPrice":"50","amount":"100","currency":"EUR"}],
      "movements":[{"id":"C1","date":"2026-10-29","valueDate":"2026-11-02","operation":"SUSCRIPCION IIC","concept":"Developed World","amount":"-100","currency":"EUR"}],
      "reserved":[],"candidates":[{"operationId":"S1","movementIds":["C1"]}]
    })).unwrap()
}
fn response(cash: Option<&str>) -> ModelResponse {
    ModelResponse {
        proposals: vec![ModelProposal {
            operation_id: "S1".into(),
            movement_id: cash.map(str::to_owned),
            reason: "Amount and settlement agree".into(),
        }],
    }
}

#[test]
fn matching_validates_proposals_and_abstention_without_changing_source() {
    let c = context();
    validate_context(&c).unwrap();
    assert_eq!(
        validate_response(&c, response(Some("C1")))
            .unwrap()
            .proposals
            .len(),
        1
    );
    assert_eq!(
        validate_response(&c, response(None))
            .unwrap()
            .abstained_count,
        1
    );
    assert!(validate_response(&c, response(Some("invented"))).is_err());
    let mut wrong = context();
    wrong.movements[0].amount = "-200".into();
    assert_eq!(
        validate_response(&wrong, response(Some("C1")))
            .unwrap()
            .rejected_count,
        1
    );
    wrong = context();
    wrong.movements[0].value_date = "2026-11-03".into();
    assert_eq!(
        validate_response(&wrong, response(Some("C1")))
            .unwrap()
            .rejected_count,
        1
    );
    wrong = context();
    wrong.movements[0].amount = "100".into();
    assert_eq!(
        validate_response(&wrong, response(Some("C1")))
            .unwrap()
            .rejected_count,
        1
    );
}

#[test]
fn matching_rejects_missing_duplicate_or_reserved_ids_without_greedy_acceptance() {
    let mut c = context();
    let mut other = c.operations[0].clone();
    other.id = "S2".into();
    c.operations.push(other);
    c.candidates.push(MatchCandidates {
        operation_id: "S2".into(),
        movement_ids: vec!["C1".into()],
    });
    assert!(validate_response(&c, response(Some("C1"))).is_err());
    let mut repeated = response(Some("C1"));
    repeated.proposals.push(ModelProposal {
        operation_id: "S2".into(),
        movement_id: Some("C1".into()),
        reason: "same".into(),
    });
    assert!(validate_response(&c, repeated).is_err());
    c.reserved.push(MatchPair {
        operation_id: "S2".into(),
        movement_id: "C1".into(),
    });
    assert!(validate_context(&c).is_err());
    let mut oversized = context();
    oversized.movements[0].concept = "x".repeat(1001);
    assert!(validate_context(&oversized).is_err());
}

#[tokio::test]
async fn matching_disabled_provider_is_rejected_before_network_or_chat_persistence() {
    let env = Arc::new(MockEnvironment::new());
    let service = ChatService::new(env, ChatConfig::default());
    assert!(service
        .suggest_import_matches(ImportMatchRequest {
            provider_id: "custom".into(),
            model_id: "fixture".into(),
            context: context()
        })
        .await
        .is_err());
    assert!(service
        .list_threads_paginated(&Default::default())
        .unwrap()
        .threads
        .is_empty());
}

#[tokio::test]
async fn matching_uses_selected_custom_model_with_chat_tools_disabled_and_no_chat_repository() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        let body = loop {
            let count = socket.read(&mut buffer).await.unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&bytes[..index]);
                let length: usize = head
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse().ok())
                    })
                    .unwrap();
                if bytes.len() >= index + 4 + length {
                    break serde_json::from_slice::<serde_json::Value>(
                        &bytes[index + 4..index + 4 + length],
                    )
                    .unwrap();
                }
            }
        };
        let tool = body["tools"][0]["function"]["name"].as_str().unwrap();
        assert_eq!(body["model"], "qwen3.8-fixture");
        assert_eq!(body["tools"].as_array().unwrap().len(), 1);
        assert_eq!(body["reasoning_effort"], "none");
        assert!(String::from_utf8_lossy(&bytes).starts_with("POST /v1/chat/completions "));
        let data=serde_json::json!({"id":"fixture","object":"chat.completion","created":1,"model":"qwen3.8-fixture","choices":[{"index":0,"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":tool,"arguments":serde_json::json!({"proposals":[{"operationId":"S1","movementId":"C1","reason":"Same date and amount"}]}).to_string()}}]}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}).to_string();
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",data.len(),data).as_bytes()).await.unwrap();
    });
    let mut env = MockEnvironment::new();
    env.settings_service=Arc::new(MockSettingsService{settings:RwLock::new(HashMap::from([(
        AI_PROVIDER_SETTINGS_KEY.to_string(),serde_json::json!({"schemaVersion":2,"providers":{"custom":{"enabled":true,"customUrl":url,"favoriteModels":["qwen3.8-fixture"],"modelCapabilityOverrides":{"qwen3.8-fixture":{"tools":false}}}}}).to_string()
    )]))});
    let service = ChatService::new(Arc::new(env), ChatConfig::default());
    let result = service
        .suggest_import_matches(ImportMatchRequest {
            provider_id: "custom".into(),
            model_id: "qwen3.8-fixture".into(),
            context: context(),
        })
        .await
        .unwrap();
    assert_eq!(result.proposals.len(), 1);
    server.await.unwrap();
    assert!(service
        .list_threads_paginated(&Default::default())
        .unwrap()
        .threads
        .is_empty());
}
