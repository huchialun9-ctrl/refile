use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DeviceStatus {
    Online,
    Offline,
    Busy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub status: DeviceStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransferDirection {
    Send,
    Receive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransferStatus {
    Pending,
    Transferring,
    Verifying,
    Completed,
    Cancelled,
    Failed(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferSession {
    pub id: String,
    pub peer_id: String,
    pub peer_name: String,
    pub file_name: String,
    pub file_size: u64,
    pub file_count: u32,
    pub direction: TransferDirection,
    pub status: TransferStatus,
    pub progress: f64,
    pub speed: f64,
    pub hash: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ControlMessage {
    ConnectRequest {
        session_id: String,
        file_name: String,
        file_size: u64,
        file_count: u32,
    },
    ConnectResponse {
        session_id: String,
        accepted: bool,
    },
    Progress {
        session_id: String,
        bytes_sent: u64,
        speed: f64,
    },
    Complete {
        session_id: String,
        hash: String,
    },
    Error {
        session_id: String,
        message: String,
    },
    Cancel {
        session_id: String,
    },
}

pub const SERVICE_TYPE: &str = "_refile._tcp.local.";
pub const CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4MB
pub const SYNC_INTERVAL_MS: u64 = 200;
pub const CONTROL_PORT: u16 = 0; // auto-assign
pub const DATA_PORT: u16 = 0; // auto-assign
