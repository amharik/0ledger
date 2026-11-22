use crate::crypto::SealedEnvelope;
use crate::SyncError;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};

/// A byte channel for sealed envelopes. Implementations are deliberately
/// unaware of ledgers, UI toolkits, or encryption details.
pub trait Transport {
    fn send(&mut self, envelope: &SealedEnvelope) -> Result<(), SyncError>;
    fn receive(&mut self) -> Result<Option<SealedEnvelope>, SyncError>;
}

/// In-memory transport for tests and same-process handoff.
#[derive(Debug, Default)]
pub struct MemoryTransport {
    pub outbox: VecDeque<SealedEnvelope>,
    pub inbox: VecDeque<SealedEnvelope>,
}

impl MemoryTransport {
    pub fn new() -> Self {
        Self::default()
    }

    /// Move everything this transport sent into another transport's inbox.
    pub fn deliver_to(&mut self, other: &mut MemoryTransport) {
        other.inbox.append(&mut self.outbox);
    }
}

impl Transport for MemoryTransport {
    fn send(&mut self, envelope: &SealedEnvelope) -> Result<(), SyncError> {
        self.outbox.push_back(envelope.clone());
        Ok(())
    }

    fn receive(&mut self) -> Result<Option<SealedEnvelope>, SyncError> {
        Ok(self.inbox.pop_front())
    }
}

/// File-based transport for device-to-device sync over a shared folder
/// (USB drive, synced cloud folder, network share). Each envelope is written
/// atomically and consumed by moving it into a `processed/` directory.
#[derive(Debug, Clone)]
pub struct FileTransport {
    dir: PathBuf,
}

impl FileTransport {
    pub fn new(dir: impl AsRef<Path>) -> Result<Self, SyncError> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir)?;
        fs::create_dir_all(dir.join("processed"))?;
        Ok(Self { dir })
    }

    fn next_outbound_path(&self) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        self.dir.join(format!("{stamp}.envelope.json"))
    }
}

impl Transport for FileTransport {
    fn send(&mut self, envelope: &SealedEnvelope) -> Result<(), SyncError> {
        let target = self.next_outbound_path();
        let temp = target.with_extension("tmp");
        fs::write(&temp, envelope.to_json()?)?;
        fs::rename(&temp, &target)?;
        Ok(())
    }

    fn receive(&mut self) -> Result<Option<SealedEnvelope>, SyncError> {
        let mut entries: Vec<PathBuf> = fs::read_dir(&self.dir)?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension().map(|e| e == "json").unwrap_or(false)
                    && path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.ends_with(".envelope.json"))
                        .unwrap_or(false)
            })
            .collect();
        entries.sort();

        let Some(path) = entries.into_iter().next() else {
            return Ok(None);
        };
        let raw = fs::read_to_string(&path)?;
        let envelope = SealedEnvelope::from_json(&raw)?;
        let processed = self
            .dir
            .join("processed")
            .join(path.file_name().unwrap_or_default());
        fs::rename(&path, processed)?;
        Ok(Some(envelope))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::change::ChangeSet;
    use crate::crypto::{open, seal, SyncKey};

    #[test]
    fn memory_transport_round_trips() {
        let key = SyncKey::generate().unwrap();
        let set = ChangeSet::new("dev-a", 1, vec![]);
        let envelope = seal(&key, "dev-a", "2025-01-01T00:00:00Z", &set).unwrap();

        let mut sender = MemoryTransport::new();
        let mut receiver = MemoryTransport::new();
        sender.send(&envelope).unwrap();
        sender.deliver_to(&mut receiver);

        let received = receiver.receive().unwrap().unwrap();
        assert_eq!(open(&key, &received).unwrap(), set);
    }

    #[test]
    fn file_transport_round_trips() {
        let dir = std::env::temp_dir().join(format!(
            "0ledger-sync-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let key = SyncKey::generate().unwrap();
        let set = ChangeSet::new("dev-a", 1, vec![]);
        let envelope = seal(&key, "dev-a", "2025-01-01T00:00:00Z", &set).unwrap();

        let mut transport = FileTransport::new(&dir).unwrap();
        transport.send(&envelope).unwrap();
        let received = transport.receive().unwrap().unwrap();
        assert_eq!(open(&key, &received).unwrap(), set);

        let _ = fs::remove_dir_all(&dir);
    }
}
