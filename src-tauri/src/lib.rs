mod channel;
mod crypto;
mod discovery;
mod sync;
mod transfer;
mod types;

use crate::discovery::DeviceDiscovery;
use crate::types::{DeviceInfo, TransferDirection, TransferSession, TransferStatus};
use std::collections::HashMap;
use tauri::State;
use tokio::sync::Mutex;

pub struct AppState {
    pub discovery: Mutex<Option<DeviceDiscovery>>,
    pub device_id: String,
    pub device_name: String,
    pub transfers: Mutex<HashMap<String, TransferSession>>,
}

#[tauri::command]
async fn start_discovery(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let name = whoami::fallible::hostname().unwrap_or_else(|_| "unknown".to_string());
    let device_id = uuid::Uuid::new_v4().to_string();

    let discovery = DeviceDiscovery::new().map_err(|e| e.to_string())?;
    let port = 9876;
    discovery
        .register(&name, &name, port, &device_id)
        .map_err(|e| e.to_string())?;
    discovery.start_browsing().map_err(|e| e.to_string())?;

    let mut d = state.discovery.lock().await;
    *d = Some(discovery);

    Ok(())
}

#[tauri::command]
async fn get_devices(state: State<'_, AppState>) -> Result<Vec<DeviceInfo>, String> {
    let d = state.discovery.lock().await;
    if let Some(ref discovery) = *d {
        let map = discovery.get_devices();
        let devices = map.lock().await;
        Ok(devices.values().cloned().collect())
    } else {
        Ok(vec![])
    }
}

#[tauri::command]
async fn send_file(
    state: State<'_, AppState>,
    peer_id: String,
    file_path: String,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let session = TransferSession {
        id: session_id.clone(),
        peer_id,
        peer_name: String::new(),
        file_name: file_path.split('\\').last().unwrap_or("unknown").to_string(),
        file_size: 0,
        file_count: 1,
        direction: TransferDirection::Send,
        status: TransferStatus::Pending,
        progress: 0.0,
        speed: 0.0,
        hash: String::new(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    let mut transfers = state.transfers.lock().await;
    transfers.insert(session_id.clone(), session);

    Ok(session_id)
}

#[tauri::command]
async fn get_transfers(state: State<'_, AppState>) -> Result<Vec<TransferSession>, String> {
    let transfers = state.transfers.lock().await;
    Ok(transfers.values().cloned().collect())
}

#[tauri::command]
async fn accept_transfer(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut transfers = state.transfers.lock().await;
    if let Some(session) = transfers.get_mut(&session_id) {
        session.status = TransferStatus::Transferring;
    }
    Ok(())
}

#[tauri::command]
async fn cancel_transfer(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut transfers = state.transfers.lock().await;
    if let Some(session) = transfers.get_mut(&session_id) {
        session.status = TransferStatus::Cancelled;
    }
    Ok(())
}

fn get_device_id() -> String {
    let hostname = whoami::fallible::hostname().unwrap_or_else(|_| "unknown".to_string());
    format!("reflie-{}", hostname)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            discovery: Mutex::new(None),
            device_id: get_device_id(),
            device_name: whoami::fallible::hostname().unwrap_or_else(|_| "unknown".to_string()),
            transfers: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_discovery,
            get_devices,
            send_file,
            get_transfers,
            accept_transfer,
            cancel_transfer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
