mod channel;
mod crypto;
mod discovery;
mod engine;
mod sync;
mod transfer;
mod types;

use crate::discovery::DeviceDiscovery;
use crate::engine::TransferEngine;
use crate::types::{DeviceInfo, TransferSession, TransferStatus};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, State};
use tokio::sync::Mutex;

pub struct AppState {
    pub discovery: Mutex<Option<Arc<Mutex<DeviceDiscovery>>>>,
    pub engine: Mutex<Option<TransferEngine>>,
    pub device_id: String,
    pub device_name: String,
    pub transfers: Arc<Mutex<HashMap<String, TransferSession>>>,
}

#[tauri::command]
async fn start_discovery(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let name = whoami::fallible::hostname().unwrap_or_else(|_| "unknown".to_string());
    let device_id = uuid::Uuid::new_v4().to_string();

    let discovery = DeviceDiscovery::new().map_err(|e| e.to_string())?;
    discovery.start_browsing().map_err(|e| e.to_string())?;

    let discovery_arc = Arc::new(Mutex::new(discovery));
    let devices_map = {
        let d = discovery_arc.lock().await;
        d.get_devices()
    };

    let engine = TransferEngine::new(device_id.clone(), name.clone());
    let app_clone = app_handle.clone();
    let transfers = state.transfers.clone();
    engine
        .start(app_clone, discovery_arc.clone(), transfers)
        .await
        .map_err(|e| e.to_string())?;

    let ctrl_port = *engine.control_port().lock().await;
    {
        let d = discovery_arc.lock().await;
        d.register(&name, &name, ctrl_port, &device_id)
            .map_err(|e| e.to_string())?;
    }

    let app_clone = app_handle.clone();
    let devices_clone = devices_map.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let map = devices_clone.lock().await;
            let list: Vec<DeviceInfo> = map.values().cloned().collect();
            let _ = app_clone.emit("devices-update", &list);
        }
    });

    let mut d = state.discovery.lock().await;
    *d = Some(discovery_arc);

    let mut e = state.engine.lock().await;
    *e = Some(engine);

    Ok(())
}

#[tauri::command]
async fn get_devices(state: State<'_, AppState>) -> Result<Vec<DeviceInfo>, String> {
    let d = state.discovery.lock().await;
    if let Some(ref discovery) = *d {
        let map = discovery.lock().await;
        let devices = map.get_devices();
        let list = devices.lock().await;
        Ok(list.values().cloned().collect())
    } else {
        Ok(vec![])
    }
}

#[tauri::command]
async fn send_file(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    peer_id: String,
    file_path: String,
) -> Result<String, String> {
    let engine = state.engine.lock().await;
    let engine_ref = engine.as_ref().ok_or("Engine not started")?;

    let peer = {
        let d = state.discovery.lock().await;
        let disc = d.as_ref().ok_or("Discovery not started")?;
        let map = disc.lock().await;
        let devices = map.get_devices();
        let list = devices.lock().await;
        list.get(&peer_id).cloned().ok_or("Peer not found")?
    };

    engine_ref
        .initiate_send(app_handle, peer, file_path, state.transfers.clone())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_transfers(state: State<'_, AppState>) -> Result<Vec<TransferSession>, String> {
    let transfers = state.transfers.lock().await;
    Ok(transfers.values().cloned().collect())
}

#[tauri::command]
async fn accept_transfer(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    let engine = state.engine.lock().await;
    let engine_ref = engine.as_ref().ok_or("Engine not started")?;
    engine_ref
        .accept_incoming(app_handle, session_id, state.transfers.clone())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cancel_transfer(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    {
        let mut transfers = state.transfers.lock().await;
        if let Some(session) = transfers.get_mut(&session_id) {
            session.status = TransferStatus::Cancelled;
        }
    }
    let _ = app_handle.emit("transfer-cancelled", &session_id);
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
            engine: Mutex::new(None),
            device_id: get_device_id(),
            device_name: whoami::fallible::hostname().unwrap_or_else(|_| "unknown".to_string()),
            transfers: Arc::new(Mutex::new(HashMap::new())),
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
