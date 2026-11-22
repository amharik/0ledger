use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const CHANGESET_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeOp {
    Upsert,
    Delete,
}

impl ChangeOp {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeOp::Upsert => "upsert",
            ChangeOp::Delete => "delete",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "upsert" => Some(ChangeOp::Upsert),
            "delete" => Some(ChangeOp::Delete),
            _ => None,
        }
    }
}

/// A single replicated mutation. `payload` is the JSON representation of the
/// entity for upserts and empty for deletes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub entity_type: String,
    pub entity_id: String,
    pub op: ChangeOp,
    pub payload: String,
    pub lamport: u64,
    pub device_id: String,
    pub content_hash: String,
    pub created_at: String,
}

impl Change {
    pub fn new(
        entity_type: impl Into<String>,
        entity_id: impl Into<String>,
        op: ChangeOp,
        payload: impl Into<String>,
        lamport: u64,
        device_id: impl Into<String>,
        created_at: impl Into<String>,
    ) -> Self {
        let entity_type = entity_type.into();
        let entity_id = entity_id.into();
        let payload = payload.into();
        let device_id = device_id.into();
        let created_at = created_at.into();
        let content_hash =
            compute_hash(&entity_type, &entity_id, op, &payload, lamport, &device_id);
        Self {
            entity_type,
            entity_id,
            op,
            payload,
            lamport,
            device_id,
            content_hash,
            created_at,
        }
    }

    /// Ordering key used for deterministic conflict resolution.
    pub fn version(&self) -> (u64, &str) {
        (self.lamport, self.device_id.as_str())
    }
}

pub fn compute_hash(
    entity_type: &str,
    entity_id: &str,
    op: ChangeOp,
    payload: &str,
    lamport: u64,
    device_id: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(entity_type.as_bytes());
    hasher.update(b"|");
    hasher.update(entity_id.as_bytes());
    hasher.update(b"|");
    hasher.update(op.as_str().as_bytes());
    hasher.update(b"|");
    hasher.update(payload.as_bytes());
    hasher.update(b"|");
    hasher.update(lamport.to_le_bytes());
    hasher.update(b"|");
    hasher.update(device_id.as_bytes());
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub schema_version: u32,
    pub device_id: String,
    pub lamport: u64,
    pub changes: Vec<Change>,
}

impl ChangeSet {
    pub fn new(device_id: impl Into<String>, lamport: u64, changes: Vec<Change>) -> Self {
        Self {
            schema_version: CHANGESET_SCHEMA_VERSION,
            device_id: device_id.into(),
            lamport,
            changes,
        }
    }
}

/// Merge two change lists using last-writer-wins on `(lamport, device_id)`.
/// The result contains exactly one winning change per `(entity_type, entity_id)`.
pub fn merge_changes(existing: &[Change], incoming: &[Change]) -> Vec<Change> {
    let mut winners: BTreeMap<(String, String), Change> = BTreeMap::new();

    for change in existing.iter().chain(incoming.iter()) {
        let key = (change.entity_type.clone(), change.entity_id.clone());
        match winners.get(&key) {
            Some(current) if current.version() >= change.version() => {}
            _ => {
                winners.insert(key, change.clone());
            }
        }
    }

    let mut merged: Vec<Change> = winners.into_values().collect();
    merged.sort_by(|a, b| {
        a.entity_type
            .cmp(&b.entity_type)
            .then_with(|| a.entity_id.cmp(&b.entity_id))
    });
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(entity: &str, lamport: u64, device: &str) -> Change {
        Change::new(
            "ledger",
            entity,
            ChangeOp::Upsert,
            format!("{{\"lamport\":{lamport}}}"),
            lamport,
            device,
            "2025-01-01T00:00:00Z",
        )
    }

    #[test]
    fn highest_lamport_wins() {
        let merged = merge_changes(&[change("a", 1, "dev-a")], &[change("a", 2, "dev-b")]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].lamport, 2);
    }

    #[test]
    fn device_id_breaks_ties_deterministically() {
        let left = change("a", 5, "dev-a");
        let right = change("a", 5, "dev-b");
        let one = merge_changes(std::slice::from_ref(&left), std::slice::from_ref(&right));
        let two = merge_changes(&[right], &[left]);
        assert_eq!(one, two);
        assert_eq!(one[0].device_id, "dev-b");
    }

    #[test]
    fn content_hash_is_stable() {
        let a = change("a", 1, "dev-a");
        let b = change("a", 1, "dev-a");
        assert_eq!(a.content_hash, b.content_hash);
    }
}
