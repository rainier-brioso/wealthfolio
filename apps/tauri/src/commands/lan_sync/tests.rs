use super::*;
use crate::database::DatabaseRuntime;
use std::collections::HashMap;
use wealthfolio_core::{accounts::NewAccount, profiles::ProfilePaths, secrets::SecretStore};

#[derive(Default)]
struct MemorySecrets(Mutex<HashMap<String, String>>);
impl SecretStore for MemorySecrets {
    fn get_secret(&self, key: &str) -> wealthfolio_core::Result<Option<String>> {
        Ok(self
            .0
            .lock()
            .expect("test secret store lock")
            .get(key)
            .cloned())
    }
    fn set_secret(&self, key: &str, value: &str) -> wealthfolio_core::Result<()> {
        self.0
            .lock()
            .expect("test secret store lock")
            .insert(key.into(), value.into());
        Ok(())
    }
    fn delete_secret(&self, key: &str) -> wealthfolio_core::Result<()> {
        self.0.lock().expect("test secret store lock").remove(key);
        Ok(())
    }
}

async fn fixture() -> (tempfile::TempDir, DatabaseRuntime, Arc<ServiceContext>) {
    let dir = tempfile::tempdir().expect("test profile directory");
    let runtime = DatabaseRuntime::for_profile(
        uuid::Uuid::new_v4(),
        ProfilePaths {
            root: dir.path().into(),
            database: dir.path().join("app.db"),
        },
        Arc::new(MemorySecrets::default()),
        Arc::default(),
    );
    runtime.initialize_for_test(None).await;
    let context = runtime.context().expect("initialized test profile");
    (dir, runtime, context)
}

async fn account(context: &ServiceContext, name: &str) -> String {
    context
        .account_service()
        .create_account(NewAccount {
            id: None,
            name: name.into(),
            account_type: "cash".into(),
            group: None,
            currency: "EUR".into(),
            is_default: false,
            is_active: true,
            platform_id: None,
            account_number: None,
            meta: None,
            provider: None,
            provider_account_id: None,
            is_archived: false,
            tracking_mode: Default::default(),
        })
        .await
        .expect("create test account")
        .id
}

async fn host(context: &Arc<ServiceContext>) -> Config {
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test address");
    let address = match socket.local_addr().expect("test listener address") {
        std::net::SocketAddr::V4(address) => address,
        _ => unreachable!(),
    };
    drop(socket);
    let id = uuid::Uuid::new_v4().to_string();
    let config = Config {
        invitation: Invitation {
            address,
            pairing_id: uuid::Uuid::new_v4().to_string(),
            host_id: id.clone(),
            key: crypto::generate_root_key(),
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            app_version: env!("CARGO_PKG_VERSION").into(),
        },
        device_id: id,
        peer_id: None,
        host: true,
    };
    save(context, &config).expect("save test host pairing");
    ensure_listener(context, &config)
        .await
        .expect("start test host listener");
    config
}

fn client(invitation: Invitation) -> Config {
    Config {
        peer_id: Some(invitation.host_id.clone()),
        invitation,
        device_id: uuid::Uuid::new_v4().to_string(),
        host: false,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn wifi_bootstrap_bidirectional_offline_retry_and_duplicate_delivery() {
    let (_dir_a, runtime_a, desktop) = fixture().await;
    let (_dir_b, runtime_b, mobile) = fixture().await;
    let baseline = account(&desktop, "Before pairing").await;
    let host = host(&desktop).await;
    let client = client(host.invitation.clone());
    save(&mobile, &client).unwrap();
    cycle(&mobile, &client).await.unwrap();
    assert!(!mobile
        .app_sync_repository()
        .needs_bootstrap(&client.device_id)
        .unwrap());
    assert!(mobile
        .account_service()
        .get_all_accounts()
        .unwrap()
        .iter()
        .any(|a| a.id == baseline));
    assert!(pending(&desktop).await.unwrap().is_empty());

    desktop.lan_sync.stop().await;
    let mobile_id = account(&mobile, "Created offline on mobile").await;
    let desktop_id = account(&desktop, "Created offline on desktop").await;
    let queued = pending(&mobile).await.unwrap();
    assert!(cycle(&mobile, &client).await.is_err());
    assert_eq!(pending(&mobile).await.unwrap().len(), queued.len());
    ensure_listener(&desktop, &host).await.unwrap();

    // Simulate a committed push whose response was lost: resend the identical
    // event page before the client marks it sent. Replay must remain idempotent.
    for _ in 0..2 {
        let reply = lan::call(
            &client.invitation,
            &client.device_id,
            Action::Exchange {
                events: queued.clone(),
            },
        )
        .await
        .unwrap();
        assert!(matches!(reply, Reply::Events { .. }));
    }
    cycle(&mobile, &client).await.unwrap();
    for context in [&desktop, &mobile] {
        let accounts = context.account_service().get_all_accounts().unwrap();
        for id in [&baseline, &mobile_id, &desktop_id] {
            assert_eq!(accounts.iter().filter(|a| &a.id == id).count(), 1);
        }
        assert!(pending(context).await.unwrap().is_empty());
    }
    // Concurrent offline edits of the same row use the existing LWW rule.
    for (context, name) in [(&desktop, "Desktop edit"), (&mobile, "Latest mobile edit")] {
        let row = context
            .account_service()
            .get_all_accounts()
            .unwrap()
            .into_iter()
            .find(|a| a.id == baseline)
            .unwrap();
        let mut value = serde_json::to_value(row).unwrap();
        value["name"] = serde_json::json!(name);
        let update: wealthfolio_core::accounts::AccountUpdate =
            serde_json::from_value(value).unwrap();
        context
            .account_service()
            .update_account(update)
            .await
            .unwrap();
    }
    cycle(&mobile, &client).await.unwrap();
    for context in [&desktop, &mobile] {
        let row = context
            .account_service()
            .get_all_accounts()
            .unwrap()
            .into_iter()
            .find(|a| a.id == baseline)
            .unwrap();
        assert_eq!(row.name, "Latest mobile edit");
    }

    // Deletions also travel from mobile to desktop.
    mobile
        .account_service()
        .delete_account(&mobile_id)
        .await
        .unwrap();
    cycle(&mobile, &client).await.unwrap();
    assert!(!desktop
        .account_service()
        .get_all_accounts()
        .unwrap()
        .iter()
        .any(|a| a.id == mobile_id));

    let mut wrong = client.invitation.clone();
    wrong.key = crypto::generate_root_key();
    assert!(lan::call(&wrong, &client.device_id, Action::Bootstrap)
        .await
        .is_err());
    assert!(lan::call(
        &client.invitation,
        &uuid::Uuid::new_v4().to_string(),
        Action::Bootstrap
    )
    .await
    .is_err());
    desktop
        .active
        .store(false, std::sync::atomic::Ordering::SeqCst);
    assert!(lan::call(
        &client.invitation,
        &client.device_id,
        Action::Exchange { events: vec![] }
    )
    .await
    .is_err());
    desktop.lan_sync.stop().await;
    runtime_a.shutdown_for_test().await;
    runtime_b.shutdown_for_test().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn wifi_join_refuses_to_replace_an_existing_portfolio() {
    let (_dir_a, runtime_a, desktop) = fixture().await;
    let (_dir_b, runtime_b, mobile) = fixture().await;
    let existing = account(&mobile, "Keep me").await;
    let host = host(&desktop).await;
    let config = client(host.invitation.clone());
    assert!(bootstrap(&mobile, &config)
        .await
        .unwrap_err()
        .contains("empty profile"));
    assert!(mobile
        .account_service()
        .get_all_accounts()
        .unwrap()
        .iter()
        .any(|a| a.id == existing));
    assert!(load(&desktop).unwrap().unwrap().peer_id.is_none());
    desktop.lan_sync.stop().await;
    runtime_a.shutdown_for_test().await;
    runtime_b.shutdown_for_test().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn wifi_recovers_lost_initial_ack_without_overwriting_offline_mobile_edits() {
    let (_dir_a, runtime_a, desktop) = fixture().await;
    let (_dir_b, runtime_b, mobile) = fixture().await;
    let baseline = account(&desktop, "Initial desktop account").await;
    let host = host(&desktop).await;
    let client = client(host.invitation.clone());
    save(&mobile, &client).unwrap();
    let Reply::Snapshot { blob, event_ids } =
        lan::call(&client.invitation, &client.device_id, Action::Bootstrap)
            .await
            .unwrap()
    else {
        panic!("snapshot required")
    };
    let ack = serde_json::to_string(&(client.invitation.pairing_id.clone(), event_ids)).unwrap();
    mobile
        .settings_service()
        .set_setting_value(BOOTSTRAP_ACK_SETTING, &ack)
        .await
        .unwrap();
    let image = wealthfolio_device_sync::snapshot::decode(
        &BASE64.decode(blob).unwrap(),
        &client.invitation.key,
        1,
    )
    .unwrap();
    let stage = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(stage.path(), image).unwrap();
    mobile
        .app_sync_repository()
        .restore_lan_snapshot_from_file(
            stage.path().to_string_lossy().into_owned(),
            client.device_id.clone(),
        )
        .await
        .unwrap();
    desktop.lan_sync.stop().await;
    assert!(bootstrap(&mobile, &client).await.is_err());
    let mobile_edit = account(&mobile, "Mobile edit after completed import").await;
    let desktop_edit = account(&desktop, "Desktop edit after snapshot boundary").await;
    ensure_listener(&desktop, &host).await.unwrap();
    cycle(&mobile, &client).await.unwrap();
    for context in [&desktop, &mobile] {
        let accounts = context.account_service().get_all_accounts().unwrap();
        for id in [&baseline, &mobile_edit, &desktop_edit] {
            assert_eq!(accounts.iter().filter(|a| &a.id == id).count(), 1);
        }
        assert!(pending(context).await.unwrap().is_empty());
    }
    desktop.lan_sync.stop().await;
    runtime_a.shutdown_for_test().await;
    runtime_b.shutdown_for_test().await;
}

#[tokio::test]
async fn wifi_client_rejects_a_valid_ciphertext_for_a_different_request() {
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = match socket.local_addr().unwrap() {
        std::net::SocketAddr::V4(address) => address,
        _ => unreachable!(),
    };
    let invitation = Invitation {
        address,
        pairing_id: uuid::Uuid::new_v4().to_string(),
        host_id: uuid::Uuid::new_v4().to_string(),
        key: crypto::generate_root_key(),
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        app_version: env!("CARGO_PKG_VERSION").into(),
    };
    let server_invitation = invitation.clone();
    let router = axum::Router::new().route(
        "/v1/exchange",
        axum::routing::post(move |body: String| {
            let invitation = server_invitation.clone();
            async move {
                let request: lan::Request = lan::open(&body, &invitation.key).unwrap();
                lan::seal(
                    &lan::Response {
                        pairing_id: request.pairing_id,
                        request_id: uuid::Uuid::new_v4().to_string(),
                        device_id: invitation.host_id,
                        reply: Reply::Acknowledged,
                    },
                    &invitation.key,
                )
                .unwrap()
            }
        }),
    );
    let task = tokio::spawn(async move {
        axum::serve(socket, router).await.unwrap();
    });
    let error = lan::call(
        &invitation,
        &uuid::Uuid::new_v4().to_string(),
        Action::Acknowledge { event_ids: vec![] },
    )
    .await
    .err()
    .expect("a response for a different request must be rejected");
    assert!(error.contains("does not match this request"));
    task.abort();
    let _ = task.await;
}
