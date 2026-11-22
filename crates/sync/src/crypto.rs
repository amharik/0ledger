use crate::change::ChangeSet;
use crate::SyncError;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use serde::{Deserialize, Serialize};
use std::fmt;

const ENVELOPE_VERSION: u32 = 1;
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

/// A 256-bit workspace sync key. Pairing is out-of-band (QR code, copy/paste,
/// or an OS share sheet); the key never leaves the user's devices.
#[derive(Clone, PartialEq, Eq)]
pub struct SyncKey([u8; KEY_LEN]);

impl fmt::Debug for SyncKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SyncKey(<redacted>)")
    }
}

impl SyncKey {
    pub fn generate() -> Result<Self, SyncError> {
        let mut bytes = [0_u8; KEY_LEN];
        getrandom::getrandom(&mut bytes)
            .map_err(|e| SyncError::Crypto(format!("random source unavailable: {e}")))?;
        Ok(Self(bytes))
    }

    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }

    pub fn to_base64(&self) -> String {
        B64.encode(self.0)
    }

    pub fn from_base64(value: &str) -> Result<Self, SyncError> {
        let bytes = B64
            .decode(value.trim())
            .map_err(|e| SyncError::InvalidKey(e.to_string()))?;
        let array: [u8; KEY_LEN] = bytes
            .try_into()
            .map_err(|_| SyncError::InvalidKey("sync key must be 32 bytes".into()))?;
        Ok(Self(array))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedEnvelope {
    pub version: u32,
    pub sender: String,
    pub nonce: String,
    pub ciphertext: String,
    pub created_at: String,
}

impl SealedEnvelope {
    pub fn to_json(&self) -> Result<String, SyncError> {
        Ok(serde_json::to_string(self)?)
    }

    pub fn from_json(value: &str) -> Result<Self, SyncError> {
        Ok(serde_json::from_str(value)?)
    }
}

fn aad(version: u32, sender: &str, created_at: &str) -> Vec<u8> {
    format!("{version}:{sender}:{created_at}").into_bytes()
}

/// Encrypt and authenticate a change set into a transportable envelope.
pub fn seal(
    key: &SyncKey,
    sender: impl Into<String>,
    created_at: impl Into<String>,
    changes: &ChangeSet,
) -> Result<SealedEnvelope, SyncError> {
    let sender = sender.into();
    let created_at = created_at.into();
    let plaintext = serde_json::to_vec(changes)?;

    let mut nonce_bytes = [0_u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce_bytes)
        .map_err(|e| SyncError::Crypto(format!("random source unavailable: {e}")))?;

    let cipher = ChaCha20Poly1305::new(Key::from_slice(key.as_bytes()));
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: &aad(ENVELOPE_VERSION, &sender, &created_at),
            },
        )
        .map_err(|_| SyncError::Crypto("encryption failed".into()))?;

    Ok(SealedEnvelope {
        version: ENVELOPE_VERSION,
        sender,
        nonce: B64.encode(nonce_bytes),
        ciphertext: B64.encode(ciphertext),
        created_at,
    })
}

/// Decrypt and authenticate an envelope, returning the contained change set.
pub fn open(key: &SyncKey, envelope: &SealedEnvelope) -> Result<ChangeSet, SyncError> {
    if envelope.version != ENVELOPE_VERSION {
        return Err(SyncError::UnsupportedVersion(envelope.version));
    }
    let nonce_bytes = B64
        .decode(&envelope.nonce)
        .map_err(|_| SyncError::Tampered)?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(SyncError::Tampered);
    }
    let ciphertext = B64
        .decode(&envelope.ciphertext)
        .map_err(|_| SyncError::Tampered)?;

    let cipher = ChaCha20Poly1305::new(Key::from_slice(key.as_bytes()));
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &ciphertext,
                aad: &aad(envelope.version, &envelope.sender, &envelope.created_at),
            },
        )
        .map_err(|_| SyncError::Tampered)?;

    Ok(serde_json::from_slice(&plaintext)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::change::{Change, ChangeOp};

    fn sample() -> ChangeSet {
        ChangeSet::new(
            "dev-a",
            3,
            vec![Change::new(
                "ledger",
                "led_1",
                ChangeOp::Upsert,
                "{\"id\":\"led_1\"}",
                3,
                "dev-a",
                "2025-01-01T00:00:00Z",
            )],
        )
    }

    #[test]
    fn round_trips_through_envelope() {
        let key = SyncKey::generate().unwrap();
        let envelope = seal(&key, "dev-a", "2025-01-01T00:00:00Z", &sample()).unwrap();
        let opened = open(&key, &envelope).unwrap();
        assert_eq!(opened, sample());
    }

    #[test]
    fn rejects_wrong_key() {
        let key = SyncKey::generate().unwrap();
        let other = SyncKey::generate().unwrap();
        let envelope = seal(&key, "dev-a", "2025-01-01T00:00:00Z", &sample()).unwrap();
        assert!(matches!(open(&other, &envelope), Err(SyncError::Tampered)));
    }

    #[test]
    fn rejects_tampered_metadata() {
        let key = SyncKey::generate().unwrap();
        let mut envelope = seal(&key, "dev-a", "2025-01-01T00:00:00Z", &sample()).unwrap();
        envelope.sender = "attacker".to_string();
        assert!(matches!(open(&key, &envelope), Err(SyncError::Tampered)));
    }

    #[test]
    fn key_serializes_as_base64() {
        let key = SyncKey::generate().unwrap();
        let restored = SyncKey::from_base64(&key.to_base64()).unwrap();
        assert_eq!(key, restored);
    }
}
