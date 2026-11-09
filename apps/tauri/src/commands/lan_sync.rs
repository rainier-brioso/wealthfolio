//! Native Wi-Fi transport. Desktop hosts; one paired native client exchanges
//! durable outbox pages using the existing database replay rules.
#[cfg(desktop)]
use std::sync::Weak;
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use wealthfolio_core::{
    events::DomainEvent,
    secrets::{LAN_SYNC_CONFIG_KEY, SYNC_IDENTITY_KEY},
    sync::SNAPSHOT_SCHEMA_VERSION,
};
use wealthfolio_device_sync::{
    crypto,
    lan::{self, Action, Event, Invitation, Reply},
};

use crate::{context::ServiceContext, profiles::ProfileAccess};

const DEFAULT_PORT: u16 = 18457;
const BOOTSTRAP_ACK_SETTING: &str = "lan_sync.pending_bootstrap_ack";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    invitation: Invitation,
    device_id: String,
    peer_id: Option<String>,
    host: bool,
}

#[derive(Default)]
pub struct LanRuntime {
    listener: tokio::sync::Mutex<Option<Listener>>,
    status: Mutex<(Option<String>, Option<String>)>,
}

struct Listener {
    cancel: tokio_util::sync::CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl LanRuntime {
    pub async fn stop(&self) {
        if let Some(mut listener) = self.listener.lock().await.take() {
            listener.cancel.cancel();
            if tokio::time::timeout(std::time::Duration::from_secs(3), &mut listener.task)
                .await
                .is_err()
            {
                listener.task.abort();
                let _ = listener.task.await;
            }
        }
    }

    fn record(&self, result: &Result<(), String>) {
        if let Ok(mut status) = self.status.lock() {
            match result {
                Ok(()) => {
                    status.0 = Some(chrono::Utc::now().to_rfc3339());
                    status.1 = None;
                }
                Err(error) => status.1 = Some(error.clone()),
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanStatus {
    role: Option<&'static str>,
    listening: bool,
    address: Option<String>,
    paired: bool,
    ready: bool,
    last_sync_at: Option<String>,
    error: Option<String>,
}

fn load(context: &ServiceContext) -> Result<Option<Config>, String> {
    context
        .secret_store
        .get_secret(LAN_SYNC_CONFIG_KEY)
        .map_err(|_| "Could not read LAN pairing".to_string())?
        .map(|value| {
            let mut config: Config = serde_json::from_str(&value)
                .map_err(|_| "Invalid stored LAN pairing".to_string())?;
            // Invitations describe the running build. Persistent pairing keys
            // survive app updates; every request verifies the actual peer build.
            config.invitation.app_version = env!("CARGO_PKG_VERSION").into();
            config.invitation.schema_version = SNAPSHOT_SCHEMA_VERSION;
            Ok(config)
        })
        .transpose()
}

fn save(context: &ServiceContext, config: &Config) -> Result<(), String> {
    let value = serde_json::to_string(config).map_err(|_| "Could not encode LAN pairing")?;
    context
        .secret_store
        .set_secret(LAN_SYNC_CONFIG_KEY, &value)
        .map_err(|_| "Could not save LAN pairing".into())
}

fn local_only(context: &ServiceContext) -> Result<(), String> {
    if !context.is_active() {
        return Err("PROFILE_LOCKED".into());
    }
    if context
        .secret_store
        .get_secret(SYNC_IDENTITY_KEY)
        .map_err(|_| "Could not inspect sync identity")?
        .is_some()
    {
        return Err("Disconnect Connect device sync before enabling Wi-Fi sync".into());
    }
    Ok(())
}

fn changed(context: &ServiceContext) {
    context
        .domain_event_sink
        .emit(DomainEvent::device_sync_pull_complete());
}

async fn pending(context: &ServiceContext) -> Result<Vec<Event>, String> {
    let repository = context.app_sync_repository();
    let rows = tokio::task::spawn_blocking(move || {
        repository.list_pending_outbox(lan::MAX_PAGE_EVENTS as i64)
    })
    .await
    .map_err(|_| "Could not read pending changes")?
    .map_err(|_| "Could not read pending changes")?;
    let mut events = Vec::new();
    let mut size = 0;
    for row in rows {
        let event = Event::from_outbox(row)?;
        let bytes = serde_json::to_vec(&event)
            .map_err(|_| "Invalid pending change")?
            .len();
        if size + bytes > lan::MAX_PAGE_BYTES {
            if events.is_empty() {
                return Err("A change exceeds the Wi-Fi page size limit".into());
            }
            break;
        }
        size += bytes;
        events.push(event);
    }
    Ok(events)
}

async fn apply(context: &ServiceContext, events: Vec<Event>) -> Result<usize, String> {
    if events.len() > lan::MAX_PAGE_EVENTS {
        return Err("Too many events in a page".into());
    }
    let mut rows = Vec::with_capacity(events.len());
    for event in events {
        event.validate()?;
        rows.push((
            event.entity,
            event.entity_id,
            event.op,
            event.event_id,
            event.client_timestamp,
            0,
            event.payload,
        ));
    }
    context
        .app_sync_repository()
        .apply_lan_events_batch(rows)
        .await
        .map_err(|_| "A page could not be applied. Its changes remain pending.".into())
}

async fn acknowledge(context: &ServiceContext, ids: Vec<String>) -> Result<(), String> {
    for id in &ids {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid acknowledgement")?;
    }
    // SQLite variable limits also apply to the initial snapshot boundary.
    for chunk in ids.chunks(400) {
        context
            .app_sync_repository()
            .mark_outbox_sent(chunk.to_vec())
            .await
            .map_err(|_| "Could not save acknowledgement")?;
    }
    Ok(())
}

#[cfg(desktop)]
async fn ensure_listener(context: &Arc<ServiceContext>, config: &Config) -> Result<(), String> {
    let mut slot = context.lan_sync.listener.lock().await;
    if slot
        .as_ref()
        .is_some_and(|listener| !listener.task.is_finished())
    {
        return Ok(());
    }
    let address = config.invitation.address;
    lan::validate_address(&address)?;
    let listener = tokio::net::TcpListener::bind(address).await.map_err(|_| {
        "Could not listen on this Wi-Fi address. Check the address and port.".to_string()
    })?;
    let cancel = tokio_util::sync::CancellationToken::new();
    let shutdown = cancel.clone();
    let weak = Arc::downgrade(context);
    let task = tokio::spawn(async move {
        let router = axum::Router::new()
            .route("/v1/exchange", axum::routing::post(handle_request))
            .layer(axum::extract::DefaultBodyLimit::max(lan::MAX_WIRE_BYTES))
            .with_state(weak);
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown.cancelled_owned())
            .await;
    });
    *slot = Some(Listener { cancel, task });
    Ok(())
}

#[cfg(mobile)]
async fn ensure_listener(_context: &Arc<ServiceContext>, _config: &Config) -> Result<(), String> {
    Err("Host Wi-Fi sync from the desktop application".into())
}

#[cfg(desktop)]
async fn handle_request(
    axum::extract::State(weak): axum::extract::State<Weak<ServiceContext>>,
    body: String,
) -> Result<String, axum::http::StatusCode> {
    // The listener owns only a Weak context, so locking or switching profiles
    // does not leave a live financial database exposed on the network.
    let context = weak
        .upgrade()
        .ok_or(axum::http::StatusCode::SERVICE_UNAVAILABLE)?;
    let result = receive(&context, &body).await;
    context
        .lan_sync
        .record(&result.as_ref().map(|_| ()).map_err(Clone::clone));
    result.map_err(|_| axum::http::StatusCode::BAD_REQUEST)
}

#[cfg(desktop)]
async fn receive(context: &Arc<ServiceContext>, body: &str) -> Result<String, String> {
    let _guard = context.sync_lifecycle.lock().await;
    local_only(context)?;
    let mut config = load(context)?.ok_or("Wi-Fi sync is disabled")?;
    if !config.host {
        return Err("This device is not a Wi-Fi host".into());
    }
    let request: lan::Request = lan::open(body, &config.invitation.key)?;
    if request.app_version != env!("CARGO_PKG_VERSION")
        || request.schema_version != SNAPSHOT_SCHEMA_VERSION
    {
        return Err("Both devices must run the same app version".into());
    }
    uuid::Uuid::parse_str(&request.request_id).map_err(|_| "Invalid request identifier")?;
    uuid::Uuid::parse_str(&request.device_id).map_err(|_| "Invalid device identifier")?;
    if request.pairing_id != config.invitation.pairing_id || request.device_id == config.device_id {
        return Err("Invalid pairing".into());
    }
    if let Some(peer) = &config.peer_id {
        if peer != &request.device_id {
            return Err("A mobile device is already paired".into());
        }
    } else {
        if !matches!(request.action, Action::Bootstrap) {
            return Err("Bootstrap required".into());
        }
        config.peer_id = Some(request.device_id.clone());
        save(context, &config)?;
    }
    let reply = match request.action {
        Action::Bootstrap => {
            let (image, event_ids) = context
                .app_sync_repository()
                .export_snapshot_with_outbox(Vec::new())
                .await
                .map_err(|_| "Could not prepare initial portfolio")?;
            let blob =
                wealthfolio_device_sync::snapshot::encode(&image, &config.invitation.key, 1)?;
            Reply::Snapshot {
                blob: BASE64.encode(blob),
                event_ids,
            }
        }
        Action::Exchange { events } => {
            let accepted = events.iter().map(|e| e.event_id.clone()).collect();
            if apply(context, events).await? > 0 {
                changed(context);
            }
            Reply::Events {
                accepted,
                events: pending(context).await?,
            }
        }
        Action::Acknowledge { event_ids } => {
            acknowledge(context, event_ids).await?;
            Reply::Acknowledged
        }
    };
    if !context.is_active() {
        return Err("PROFILE_LOCKED".into());
    }
    lan::seal(
        &lan::Response {
            pairing_id: request.pairing_id,
            request_id: request.request_id,
            device_id: config.device_id,
            reply,
        },
        &config.invitation.key,
    )
}

async fn bootstrap(context: &Arc<ServiceContext>, config: &Config) -> Result<(), String> {
    if !context
        .app_sync_repository()
        .needs_bootstrap(&config.device_id)
        .map_err(|_| "Could not inspect initial sync")?
    {
        return finish_bootstrap_ack(context, config).await;
    }
    let summary = context
        .app_sync_repository()
        .get_local_sync_overwrite_risk_summary()
        .map_err(|_| "Could not inspect local portfolio")?;
    if summary.total_rows != 0 {
        return Err(
            "Join Wi-Fi sync using an empty profile. Your current portfolio has been kept.".into(),
        );
    }
    let reply = lan::call(&config.invitation, &config.device_id, Action::Bootstrap).await?;
    let Reply::Snapshot { blob, event_ids } = reply else {
        return Err("Expected an initial portfolio".into());
    };
    // Persist the precise exported boundary before committing the snapshot.
    // After a crash/lost ACK, retry that boundary rather than acknowledging
    // newer desktop writes or restoring over later mobile edits.
    let ack = serde_json::to_string(&(config.invitation.pairing_id.clone(), event_ids))
        .map_err(|_| "Invalid bootstrap acknowledgement")?;
    context
        .settings_service()
        .set_setting_value(BOOTSTRAP_ACK_SETTING, &ack)
        .await
        .map_err(|_| "Could not save bootstrap acknowledgement")?;
    let bytes = BASE64
        .decode(blob)
        .map_err(|_| "Invalid initial portfolio")?;
    let image = wealthfolio_device_sync::snapshot::decode(&bytes, &config.invitation.key, 1)?;
    if !context.is_active() {
        return Err("PROFILE_LOCKED".into());
    }
    // The existing restore importer copies only allowlisted sync tables and
    // records bootstrap completion atomically; it does not replace the live DB.
    let scratch =
        wealthfolio_storage_sqlite::db::profile_scratch_dir(&context.data_root.to_string_lossy())
            .map_err(|_| "Could not create private staging directory")?;
    let path = scratch.join(format!("wf_snapshot_lan_{}.db", uuid::Uuid::new_v4()));
    std::fs::write(&path, image).map_err(|_| "Could not stage initial portfolio")?;
    let result = context
        .app_sync_repository()
        .restore_lan_snapshot_from_file(
            path.to_string_lossy().into_owned(),
            config.device_id.clone(),
        )
        .await
        .map_err(|_| {
            "Could not import initial portfolio. An empty profile is required.".to_string()
        });
    let _ = std::fs::remove_file(path);
    result?;
    changed(context);
    finish_bootstrap_ack(context, config).await
}

async fn finish_bootstrap_ack(context: &ServiceContext, config: &Config) -> Result<(), String> {
    let value = context
        .settings_service()
        .get_setting_value(BOOTSTRAP_ACK_SETTING)
        .map_err(|_| "Could not read bootstrap acknowledgement")?;
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Ok(());
    };
    let (pairing_id, event_ids): (String, Vec<String>) =
        serde_json::from_str(&value).map_err(|_| "Invalid saved bootstrap acknowledgement")?;
    if pairing_id != config.invitation.pairing_id {
        return Err("Bootstrap pairing changed".into());
    }
    let reply = lan::call(
        &config.invitation,
        &config.device_id,
        Action::Acknowledge { event_ids },
    )
    .await?;
    if !matches!(reply, Reply::Acknowledged) {
        return Err("Expected bootstrap acknowledgement".into());
    }
    context
        .settings_service()
        .set_setting_value(BOOTSTRAP_ACK_SETTING, "")
        .await
        .map_err(|_| "Could not finish bootstrap acknowledgement")?;
    Ok(())
}

async fn cycle(context: &Arc<ServiceContext>, config: &Config) -> Result<(), String> {
    bootstrap(context, config).await?;
    // Drain pages fairly, with a bounded cycle. Remaining pages continue at the
    // next foreground tick; failed pages remain in the transactional outbox.
    for _ in 0..20 {
        local_only(context)?;
        let outgoing = pending(context).await?;
        let expected: Vec<_> = outgoing
            .iter()
            .map(|event| event.event_id.clone())
            .collect();
        let reply = lan::call(
            &config.invitation,
            &config.device_id,
            Action::Exchange { events: outgoing },
        )
        .await?;
        let Reply::Events { accepted, events } = reply else {
            return Err("Expected a sync page".into());
        };
        if accepted != expected {
            return Err("Unexpected sync acknowledgement".into());
        }
        let incoming: Vec<_> = events.iter().map(|event| event.event_id.clone()).collect();
        local_only(context)?;
        if apply(context, events).await? > 0 {
            changed(context);
        }
        acknowledge(context, accepted.clone()).await?;
        if !incoming.is_empty() {
            let reply = lan::call(
                &config.invitation,
                &config.device_id,
                Action::Acknowledge {
                    event_ids: incoming.clone(),
                },
            )
            .await?;
            if !matches!(reply, Reply::Acknowledged) {
                return Err("Expected a sync acknowledgement".into());
            }
        }
        if accepted.is_empty() && incoming.is_empty() {
            break;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn lan_sync_status(state: ProfileAccess) -> Result<LanStatus, String> {
    let context = state.context()?;
    let config = load(&context)?;
    let listening = context
        .lan_sync
        .listener
        .lock()
        .await
        .as_ref()
        .is_some_and(|l| !l.task.is_finished());
    let (last_sync_at, error) = context
        .lan_sync
        .status
        .lock()
        .map_err(|_| "LAN status unavailable")?
        .clone();
    let ready = match &config {
        Some(config) if !config.host => !context
            .app_sync_repository()
            .needs_bootstrap(&config.device_id)
            .map_err(|_| "Could not inspect initial sync")?,
        Some(_) => true,
        None => false,
    };
    Ok(LanStatus {
        role: config
            .as_ref()
            .map(|c| if c.host { "host" } else { "client" }),
        listening,
        address: config.as_ref().map(|c| c.invitation.address.to_string()),
        paired: config
            .as_ref()
            .is_some_and(|c| !c.host || c.peer_id.is_some()),
        ready,
        last_sync_at,
        error,
    })
}

#[tauri::command]
pub async fn lan_sync_host(
    address: Option<String>,
    state: ProfileAccess,
) -> Result<String, String> {
    if cfg!(mobile) {
        return Err("Host Wi-Fi sync from the desktop application".into());
    }
    let context = state.context()?;
    let _connect = state.connect_guard()?;
    let _guard = context.sync_lifecycle.lock().await;
    local_only(&context)?;
    let mut config = if let Some(config) = load(&context)? {
        if !config.host {
            return Err("Disconnect the current Wi-Fi pairing first".into());
        }
        config
    } else {
        let ip = local_ip_address::local_ip().map_err(|_| "Wi-Fi address unavailable")?;
        let std::net::IpAddr::V4(ip) = ip else {
            return Err("An IPv4 Wi-Fi address is required".into());
        };
        Config {
            invitation: Invitation {
                address: std::net::SocketAddrV4::new(ip, DEFAULT_PORT),
                pairing_id: uuid::Uuid::new_v4().to_string(),
                host_id: uuid::Uuid::new_v4().to_string(),
                key: crypto::generate_root_key(),
                schema_version: SNAPSHOT_SCHEMA_VERSION,
                app_version: env!("CARGO_PKG_VERSION").into(),
            },
            device_id: String::new(),
            peer_id: None,
            host: true,
        }
    };
    config.device_id = config.invitation.host_id.clone();
    if let Some(address) = address.filter(|a| !a.trim().is_empty()) {
        let parsed = address.parse().map_err(|_| "Invalid Wi-Fi address:port")?;
        lan::validate_address(&parsed)?;
        if parsed != config.invitation.address {
            context.lan_sync.stop().await;
        }
        config.invitation.address = parsed;
    }
    config.invitation.validate()?;
    save(&context, &config)?;
    ensure_listener(&context, &config).await?;
    config.invitation.encode()
}

#[tauri::command]
pub async fn lan_sync_join(invitation: String, state: ProfileAccess) -> Result<(), String> {
    let context = state.context()?;
    let _connect = state.connect_guard()?;
    let _guard = context.sync_lifecycle.lock().await;
    local_only(&context)?;
    let invitation = Invitation::decode(&invitation)?;
    if load(&context)?.is_some() {
        return Err("Disconnect the current Wi-Fi pairing first".into());
    }
    if context
        .app_sync_repository()
        .get_local_sync_overwrite_risk_summary()
        .map_err(|_| "Could not inspect local portfolio")?
        .total_rows
        != 0
    {
        return Err(
            "Join Wi-Fi sync using an empty profile. Your current portfolio has been kept.".into(),
        );
    }
    let config = Config {
        peer_id: Some(invitation.host_id.clone()),
        invitation,
        device_id: uuid::Uuid::new_v4().to_string(),
        host: false,
    };
    save(&context, &config)?;
    let result = cycle(&context, &config).await;
    context.lan_sync.record(&result);
    result
}

#[tauri::command]
pub async fn lan_sync_tick(state: ProfileAccess) -> Result<(), String> {
    let context = state.context()?;
    let _connect = state.connect_guard()?;
    // Foreground/resume signals may overlap. Do not queue duplicate cycles.
    let Ok(_guard) = context.sync_lifecycle.try_lock() else {
        return Ok(());
    };
    let Some(config) = load(&context)? else {
        return Ok(());
    };
    local_only(&context)?;
    let result = if config.host {
        ensure_listener(&context, &config).await
    } else {
        cycle(&context, &config).await
    };
    // Hosting without an exchange is not a successful data synchronization.
    if !config.host || result.is_err() {
        context.lan_sync.record(&result);
    }
    result
}

#[tauri::command]
pub async fn lan_sync_update_address(address: String, state: ProfileAccess) -> Result<(), String> {
    let context = state.context()?;
    let _guard = context.sync_lifecycle.lock().await;
    local_only(&context)?;
    let mut config = load(&context)?.ok_or("Pair a desktop first")?;
    if config.host {
        return Err("Change the host address using Start Wi-Fi sync".into());
    }
    let address = address.parse().map_err(|_| "Invalid Wi-Fi address:port")?;
    lan::validate_address(&address)?;
    config.invitation.address = address;
    save(&context, &config)
}

#[tauri::command]
pub async fn lan_sync_disconnect(state: ProfileAccess) -> Result<(), String> {
    let context = state.context()?;
    let _guard = context.sync_lifecycle.lock().await;
    context.lan_sync.stop().await;
    context
        .secret_store
        .delete_secret(LAN_SYNC_CONFIG_KEY)
        .map_err(|_| "Could not remove LAN pairing")?;
    context
        .settings_service()
        .set_setting_value(BOOTSTRAP_ACK_SETTING, "")
        .await
        .map_err(|_| "Could not clear bootstrap acknowledgement")?;
    if let Ok(mut status) = context.lan_sync.status.lock() {
        *status = (None, None);
    }
    Ok(())
}

#[cfg(all(test, desktop))]
mod tests;
