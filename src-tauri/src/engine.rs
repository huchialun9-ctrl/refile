use crate::channel::{ControlChannel, IncomingMsg};
use crate::discovery::DeviceDiscovery;
use crate::sync::ProgressSync;
use crate::transfer::{connect_data, TransferServer, TransferStats, send_file, receive_file};
use crate::types::*;
use anyhow::Result;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::Mutex;

type PendingResponses = Arc<Mutex<HashMap<String, oneshot::Sender<ControlMessage>>>>;

pub struct TransferEngine {
    device_id: String,
    device_name: String,
    control_port: Arc<Mutex<u16>>,
    data_port: Arc<Mutex<u16>>,
    transfer_server: Arc<Mutex<Option<Arc<TransferServer>>>>,
    pending_responses: PendingResponses,
    session_channels: Arc<Mutex<HashMap<String, mpsc::Sender<ControlMessage>>>>,
}

impl TransferEngine {
    pub fn new(device_id: String, device_name: String) -> Self {
        Self {
            device_id,
            device_name,
            control_port: Arc::new(Mutex::new(0)),
            data_port: Arc::new(Mutex::new(0)),
            transfer_server: Arc::new(Mutex::new(None)),
            pending_responses: Arc::new(Mutex::new(HashMap::new())),
            session_channels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn control_port(&self) -> Arc<Mutex<u16>> {
        self.control_port.clone()
    }

    pub async fn cancel_session(&self, session_id: &str) {
        let mut sc = self.session_channels.lock().await;
        if let Some(tx) = sc.remove(session_id) {
            let _ = tx.send(ControlMessage::Cancel { session_id: session_id.to_string() }).await;
        }
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn device_name(&self) -> &str {
        &self.device_name
    }

    pub async fn start(
        &self,
        app_handle: tauri::AppHandle,
        _discovery: Arc<Mutex<DeviceDiscovery>>,
        transfers: Arc<Mutex<HashMap<String, TransferSession>>>,
    ) -> Result<()> {
        let (ctrl, ctrl_port) = ControlChannel::listen(0).await?;
        *self.control_port.lock().await = ctrl_port;

        let (srv, data_port) = TransferServer::new().await?;
        *self.data_port.lock().await = data_port;
        *self.transfer_server.lock().await = Some(Arc::new(srv));

        let pending = self.pending_responses.clone();
        let transfers_clone = transfers.clone();
        let app_clone = app_handle.clone();

        tokio::spawn(async move {
            let mut rx = ctrl.receiver;
            while let Some(incoming) = rx.recv().await {
                let IncomingMsg { msg, peer_addr } = incoming;
                match &msg {
                    ControlMessage::ConnectResponse { session_id, .. } => {
                        let mut p = pending.lock().await;
                        if let Some(tx) = p.remove(session_id) {
                            let _ = tx.send(msg);
                        }
                    }
                    ControlMessage::ConnectRequest { session_id, file_name, file_size, file_count, sender_port, .. } => {
                        let peer_ip = peer_addr.ip().to_string();
                        let peer_id = format!("{}:{}", peer_ip, sender_port);
                        let session = TransferSession {
                            id: session_id.clone(),
                            peer_id: peer_id.clone(),
                            peer_name: peer_ip.clone(),
                            file_name: file_name.clone(),
                            file_size: *file_size,
                            file_count: *file_count,
                            direction: TransferDirection::Receive,
                            status: TransferStatus::Pending,
                            progress: 0.0,
                            speed: 0.0,
                            hash: String::new(),
                            created_at: chrono::Utc::now().to_rfc3339(),
                        };
                        let mut t = transfers_clone.lock().await;
                        t.insert(session_id.clone(), session.clone());
                        let _ = app_clone.emit("transfer-request", &session);
                    }
                    ControlMessage::Progress { session_id, bytes_sent, speed } => {
                        let mut t = transfers_clone.lock().await;
                        if let Some(session) = t.get_mut(session_id) {
                            session.progress = if session.file_size > 0 {
                                *bytes_sent as f64 / session.file_size as f64
                            } else { 0.0 };
                            session.speed = *speed;
                        }
                        let _ = app_clone.emit("transfer-progress", &serde_json::json!({
                            "id": session_id, "bytes_sent": bytes_sent, "speed": speed
                        }));
                    }
                    ControlMessage::Complete { session_id, hash } => {
                        let mut t = transfers_clone.lock().await;
                        if let Some(session) = t.get_mut(session_id) {
                            session.status = TransferStatus::Completed;
                            session.progress = 1.0;
                            session.hash = hash.clone();
                        }
                        let _ = app_clone.emit("transfer-complete", &session_id);
                    }
                    ControlMessage::Error { session_id, message } => {
                        let mut t = transfers_clone.lock().await;
                        if let Some(session) = t.get_mut(session_id) {
                            session.status = TransferStatus::Failed(message.clone());
                        }
                        let _ = app_clone.emit("transfer-error", &serde_json::json!({
                            "id": session_id, "message": message
                        }));
                    }
                    ControlMessage::Cancel { session_id } => {
                        let mut t = transfers_clone.lock().await;
                        if let Some(session) = t.get_mut(session_id) {
                            session.status = TransferStatus::Cancelled;
                        }
                        let _ = app_clone.emit("transfer-cancelled", &session_id);
                    }
                }
            }
        });

        Ok(())
    }

    pub async fn initiate_send(
        &self,
        app_handle: tauri::AppHandle,
        peer: DeviceInfo,
        file_path: String,
        transfers: Arc<Mutex<HashMap<String, TransferSession>>>,
    ) -> Result<String> {
        let path = Path::new(&file_path);
        let file_size = tokio::fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
        let file_name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let session_id = uuid::Uuid::new_v4().to_string();

        {
            let mut t = transfers.lock().await;
            t.insert(session_id.clone(), TransferSession {
                id: session_id.clone(),
                peer_id: peer.id.clone(),
                peer_name: peer.name.clone(),
                file_name: file_name.clone(),
                file_size,
                file_count: 1,
                direction: TransferDirection::Send,
                status: TransferStatus::Pending,
                progress: 0.0,
                speed: 0.0,
                hash: String::new(),
                created_at: chrono::Utc::now().to_rfc3339(),
            });
        }

        let sid = session_id.clone();
        let transfers_clone = transfers.clone();
        let pending = self.pending_responses.clone();
        let my_port = *self.control_port.lock().await;
        let s_channels = self.session_channels.clone();

        tokio::spawn(async move {
            if let Err(e) = Self::do_send(
                app_handle.clone(),
                peer, file_path, sid.clone(), transfers_clone.clone(),
                pending, my_port, s_channels,
            ).await {
                let mut t = transfers_clone.lock().await;
                if let Some(s) = t.get_mut(&sid) {
                    s.status = TransferStatus::Failed(e.to_string());
                }
                let _ = app_handle.emit("transfer-error", &serde_json::json!({
                    "id": sid, "message": e.to_string()
                }));
            }
        });

        Ok(session_id)
    }

    async fn do_send(
        app_handle: tauri::AppHandle,
        peer: DeviceInfo,
        file_path: String,
        session_id: String,
        transfers: Arc<Mutex<HashMap<String, TransferSession>>>,
        pending: PendingResponses,
        my_port: u16,
        session_channels: Arc<Mutex<HashMap<String, mpsc::Sender<ControlMessage>>>>,
    ) -> Result<()> {
        let path = Path::new(&file_path);
        let file_size = tokio::fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string();

        let (control_tx, _control_rx) = ControlChannel::connect(&peer.host, peer.port).await?;
        {
            let mut sc = session_channels.lock().await;
            sc.insert(session_id.clone(), control_tx.clone());
        }

        let (resp_tx, resp_rx) = oneshot::channel();
        {
            let mut p = pending.lock().await;
            p.insert(session_id.clone(), resp_tx);
        }

        control_tx.send(ControlMessage::ConnectRequest {
            session_id: session_id.clone(),
            file_name,
            file_size,
            file_count: 1,
            sender_host: String::new(),
            sender_port: my_port,
        }).await.map_err(|e| anyhow::anyhow!("Send error: {}", e))?;

        let response = resp_rx.await.map_err(|_| anyhow::anyhow!("No response from peer"))?;
        let data_port = match response {
            ControlMessage::ConnectResponse { accepted: true, data_port, .. } => data_port,
            ControlMessage::ConnectResponse { accepted: false, .. } => anyhow::bail!("Peer rejected transfer"),
            ControlMessage::Cancel { .. } => anyhow::bail!("Peer cancelled transfer"),
            _ => anyhow::bail!("Unexpected response"),
        };

        {
            let mut t = transfers.lock().await;
            if let Some(s) = t.get_mut(&session_id) {
                s.status = TransferStatus::Transferring;
            }
        }
        let _ = app_handle.emit("transfer-progress", &serde_json::json!({
            "id": session_id, "bytes_sent": 0u64, "speed": 0.0
        }));

        let mut data_stream = connect_data(&peer.host, data_port).await?;

        let stats = Arc::new(TransferStats::new(file_size));
        let progress_sync = ProgressSync::new(
            session_id.clone(),
            control_tx.clone(),
            stats.bytes_sent.clone(),
            file_size,
        );
        progress_sync.start().await;

        let app_clone_progress = app_handle.clone();
        let sid_progress = session_id.clone();
        let stats_clone = stats.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(SYNC_INTERVAL_MS)).await;
                let current = *stats_clone.bytes_sent.lock().await;
                let speed = stats_clone.speed().await;
                let _ = app_clone_progress.emit("transfer-progress", &serde_json::json!({
                    "id": sid_progress,
                    "bytes_sent": current,
                    "speed": speed,
                }));
                if current >= file_size {
                    break;
                }
            }
        });

        let hash = send_file(&mut data_stream, &path, &stats.as_ref()).await?;

        control_tx.send(ControlMessage::Complete {
            session_id: session_id.clone(),
            hash,
        }).await.ok();

        let mut t = transfers.lock().await;
        if let Some(s) = t.get_mut(&session_id) {
            s.status = TransferStatus::Completed;
            s.progress = 1.0;
        }
        let _ = app_handle.emit("transfer-complete", &session_id);

        Ok(())
    }

    pub async fn accept_incoming(
        &self,
        app_handle: tauri::AppHandle,
        session_id: String,
        transfers: Arc<Mutex<HashMap<String, TransferSession>>>,
    ) -> Result<()> {
        let (session, sender_ip, sender_port) = {
            let t = transfers.lock().await;
            let s = t.get(&session_id).cloned();
            match s {
                Some(ref s) => {
                    let parts: Vec<&str> = s.peer_id.splitn(2, ':').collect();
                    if parts.len() == 2 {
                        let ip = parts[0].to_string();
                        let port: u16 = parts[1].parse().unwrap_or(0);
                        (Some(s.clone()), ip, port)
                    } else {
                        (Some(s.clone()), s.peer_id.clone(), 0)
                    }
                }
                None => (None, String::new(), 0),
            }
        };

        if sender_port == 0 {
            anyhow::bail!("Sender control port unknown");
        }

        if let Some(mut session) = session {
            session.status = TransferStatus::Transferring;
            let data_port = *self.data_port.lock().await;

            {
                let mut t = transfers.lock().await;
                t.insert(session_id.clone(), session.clone());
            }

            let _ = app_handle.emit("transfer-progress", &serde_json::json!({
                "id": session_id, "bytes_sent": 0u64, "speed": 0.0
            }));

            let (ctrl_tx, _ctrl_rx) = ControlChannel::connect(&sender_ip, sender_port).await?;

            ctrl_tx.send(ControlMessage::ConnectResponse {
                session_id: session_id.clone(),
                accepted: true,
                data_port,
            }).await.ok();

            let srv_arc = self.transfer_server.lock().await.as_ref().cloned().unwrap();
            {
                let mut sc = self.session_channels.lock().await;
                sc.insert(session_id.clone(), ctrl_tx.clone());
            }

            let sid = session_id.clone();
            let transfers_clone = transfers.clone();

            tokio::spawn(async move {
                if let Err(e) = Self::do_receive(
                    app_handle.clone(), sid.clone(), transfers_clone.clone(),
                    srv_arc,
                ).await {
                    let mut t = transfers_clone.lock().await;
                    if let Some(s) = t.get_mut(&sid) {
                        s.status = TransferStatus::Failed(e.to_string());
                    }
                    let _ = app_handle.emit("transfer-error", &serde_json::json!({
                        "id": sid, "message": e.to_string()
                    }));
                }
            });
        }

        Ok(())
    }

    async fn do_receive(
        app_handle: tauri::AppHandle,
        session_id: String,
        transfers: Arc<Mutex<HashMap<String, TransferSession>>>,
        srv: Arc<TransferServer>,
    ) -> Result<()> {
        let data_stream = srv.accept().await?;
        let (reader, _) = tokio::io::split(data_stream);
        let mut buf_reader = tokio::io::BufReader::new(reader);

        let session_info = {
            let t = transfers.lock().await;
            t.get(&session_id).cloned()
        };

        let file_name = session_info.as_ref().map(|s| s.file_name.clone()).unwrap_or_else(|| "unknown".to_string());
        let file_size = session_info.as_ref().map(|s| s.file_size).unwrap_or(0);

        let downloads = app_handle.path().app_data_dir().map_err(|e| anyhow::anyhow!("{e}"))?;
        let dest_path = downloads.join("downloads").join(&file_name);
        let hash = receive_file(&mut buf_reader, &dest_path, file_size).await?;

        let mut t = transfers.lock().await;
        if let Some(s) = t.get_mut(&session_id) {
            s.status = TransferStatus::Completed;
            s.progress = 1.0;
            s.hash = hash;
        }
        let _ = app_handle.emit("transfer-complete", &session_id);

        Ok(())
    }
}