//! Encrypted direct-peer protocol. No Connect admission, credentials or relay.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::net::{Ipv4Addr, SocketAddrV4};
use wealthfolio_core::sync::{SyncEntity, SyncOperation, SyncOutboxEvent, SNAPSHOT_SCHEMA_VERSION};

use crate::crypto;

pub const MAX_WIRE_BYTES: usize = 96 * 1024 * 1024;
pub const MAX_PAGE_EVENTS: usize = 500;
pub const MAX_PAGE_BYTES: usize = 6 * 1024 * 1024;
const INVITE_PREFIX: &str = "wealthfolio-lan-v1:";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invitation {
    pub address: SocketAddrV4,
    pub pairing_id: String,
    pub host_id: String,
    pub key: String,
    pub schema_version: i32,
    pub app_version: String,
}

impl Invitation {
    pub fn validate(&self) -> Result<(), String> {
        validate_address(&self.address)?;
        uuid::Uuid::parse_str(&self.pairing_id).map_err(|_| "Invalid pairing identifier")?;
        uuid::Uuid::parse_str(&self.host_id).map_err(|_| "Invalid host identifier")?;
        if self.schema_version != SNAPSHOT_SCHEMA_VERSION
            || self.app_version != env!("CARGO_PKG_VERSION")
        {
            return Err("Both devices must run the same app version".into());
        }
        // derive_dek validates the secret's length as well as its encoding.
        crypto::derive_dek(&self.key, 1)?;
        Ok(())
    }

    pub fn encode(&self) -> Result<String, String> {
        self.validate()?;
        Ok(format!(
            "{INVITE_PREFIX}{}",
            URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(self).map_err(|_| "Could not encode invitation")?)
        ))
    }

    pub fn decode(value: &str) -> Result<Self, String> {
        if value.len() > 4096 {
            return Err("Invalid invitation".into());
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(
                value
                    .trim()
                    .strip_prefix(INVITE_PREFIX)
                    .ok_or("Invalid invitation")?,
            )
            .map_err(|_| "Invalid invitation")?;
        let invitation: Self = serde_json::from_slice(&bytes).map_err(|_| "Invalid invitation")?;
        invitation.validate()?;
        Ok(invitation)
    }
}

pub fn validate_address(address: &SocketAddrV4) -> Result<(), String> {
    let ip = address.ip();
    if address.port() == 0
        || !(ip.is_private() || ip.is_loopback())
        || ip.octets()[3] == 255
        || *ip == Ipv4Addr::UNSPECIFIED
    {
        return Err("Enter a private Wi-Fi IPv4 address and a valid port".into());
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub event_id: String,
    pub entity: SyncEntity,
    pub entity_id: String,
    pub op: SyncOperation,
    pub client_timestamp: String,
    pub payload: serde_json::Value,
}

impl Event {
    pub fn from_outbox(row: SyncOutboxEvent) -> Result<Self, String> {
        Ok(Self {
            event_id: row.event_id,
            entity: row.entity,
            entity_id: row.entity_id,
            op: row.op,
            client_timestamp: row.client_timestamp,
            payload: serde_json::from_str(&row.payload).map_err(|_| "Invalid local event")?,
        })
    }

    pub fn validate(&self) -> Result<(), String> {
        uuid::Uuid::parse_str(&self.event_id).map_err(|_| "Invalid event identifier")?;
        if self.entity_id.is_empty()
            || self.entity_id.len() > 256
            || !self
                .entity_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
            || !self.payload.is_object()
        {
            return Err("Invalid sync event".into());
        }
        chrono::DateTime::parse_from_rfc3339(&self.client_timestamp)
            .map_err(|_| "Invalid event timestamp")?;
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Bootstrap,
    Exchange { events: Vec<Event> },
    Acknowledge { event_ids: Vec<String> },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub app_version: String,
    pub schema_version: i32,
    pub pairing_id: String,
    pub request_id: String,
    pub device_id: String,
    pub action: Action,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Reply {
    Snapshot {
        blob: String,
        event_ids: Vec<String>,
    },
    Events {
        accepted: Vec<String>,
        events: Vec<Event>,
    },
    Acknowledged,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Response {
    pub pairing_id: String,
    pub request_id: String,
    pub device_id: String,
    pub reply: Reply,
}

pub fn seal<T: Serialize>(value: &T, key: &str) -> Result<String, String> {
    let text = serde_json::to_string(value).map_err(|_| "Could not encode LAN message")?;
    if text.len() > MAX_WIRE_BYTES / 4 * 3 - 64 {
        return Err("LAN message exceeds size limit".into());
    }
    crypto::encrypt(
        &crypto::derive_session_key(key, "wealthfolio/lan/v1")?,
        &text,
    )
}

pub fn open<T: DeserializeOwned>(body: &str, key: &str) -> Result<T, String> {
    if body.len() > MAX_WIRE_BYTES {
        return Err("LAN message exceeds size limit".into());
    }
    let text = crypto::decrypt(
        &crypto::derive_session_key(key, "wealthfolio/lan/v1")?,
        body,
    )
    .map_err(|_| "LAN message authentication failed")?;
    serde_json::from_str(&text).map_err(|_| "Invalid LAN message".into())
}

/// This client never resolves names, uses a proxy, follows redirects or sends
/// its invitation key. Authentication is inside the encrypted body.
pub async fn call(
    invitation: &Invitation,
    device_id: &str,
    action: Action,
) -> Result<Reply, String> {
    invitation.validate()?;
    let request = Request {
        app_version: env!("CARGO_PKG_VERSION").into(),
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        pairing_id: invitation.pairing_id.clone(),
        request_id: uuid::Uuid::new_v4().to_string(),
        device_id: device_id.into(),
        action,
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| "Could not create LAN client")?;
    let mut response = client
        .post(format!("http://{}/v1/exchange", invitation.address))
        .header("Content-Type", "text/plain")
        .body(seal(&request, &invitation.key)?)
        .send()
        .await
        .map_err(|_| "Desktop unavailable. Check Wi-Fi, address, firewall and unlocked profile.")?
        .error_for_status()
        .map_err(|_| "Desktop refused the LAN request. Check pairing and app versions.")?;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "LAN transfer interrupted")?
    {
        if body.len() + chunk.len() > MAX_WIRE_BYTES {
            return Err("LAN response exceeds size limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    let response: Response = open(
        std::str::from_utf8(&body).map_err(|_| "Invalid LAN response")?,
        &invitation.key,
    )?;
    if response.pairing_id != request.pairing_id
        || response.request_id != request.request_id
        || response.device_id != invitation.host_id
    {
        return Err("LAN response does not match this request".into());
    }
    Ok(response.reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invitations_reject_public_destinations_and_incompatible_versions() {
        let mut invite = Invitation {
            address: "192.168.1.10:18457".parse().unwrap(),
            pairing_id: uuid::Uuid::new_v4().to_string(),
            host_id: uuid::Uuid::new_v4().to_string(),
            key: crypto::generate_root_key(),
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            app_version: env!("CARGO_PKG_VERSION").into(),
        };
        assert_eq!(
            Invitation::decode(&invite.encode().unwrap()).unwrap().key,
            invite.key
        );
        for address in [
            "8.8.8.8:80",
            "169.254.169.254:80",
            "0.0.0.0:80",
            "192.168.1.255:80",
            "127.0.0.1:0",
        ] {
            invite.address = address.parse().unwrap();
            assert!(invite.validate().is_err());
        }
        invite.address = "10.0.0.5:18457".parse().unwrap();
        invite.app_version = "old".into();
        assert!(invite.validate().is_err());
    }

    #[test]
    fn wire_messages_authenticate_and_do_not_accept_reflected_requests() {
        let key = crypto::generate_root_key();
        let request = Request {
            app_version: env!("CARGO_PKG_VERSION").into(),
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            pairing_id: "pair".into(),
            request_id: "request".into(),
            device_id: "device".into(),
            action: Action::Bootstrap,
        };
        let body = seal(&request, &key).unwrap();
        assert!(!body.contains("pair"));
        assert!(open::<Request>(&body, &key).is_ok());
        assert!(open::<Response>(&body, &key).is_err());
        assert!(open::<Request>(&body, &crypto::generate_root_key()).is_err());
        let mut tampered = body.into_bytes();
        tampered[10] = if tampered[10] == b'A' { b'B' } else { b'A' };
        assert!(open::<Request>(std::str::from_utf8(&tampered).unwrap(), &key).is_err());
    }
}
