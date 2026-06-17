mod bluetooth;
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
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;

pub struct AppState {
    pub discovery: Mutex<Option<Arc<Mutex<DeviceDiscovery>>>>,
    pub engine: Mutex<Option<TransferEngine>>,
    pub device_id: String,
    pub device_name: String,
    pub transfers: Arc<Mutex<HashMap<String, TransferSession>>>,
    /// BLE-discovered devices (separate map, merged on emit)
    pub bt_devices: Arc<Mutex<HashMap<String, DeviceInfo>>>,
    /// Whether Bluetooth scanning/advertising is active
    pub bt_enabled: Arc<Mutex<bool>>,
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
    let bt_devices = state.bt_devices.clone();

    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let mut list: Vec<DeviceInfo> = {
                let map = devices_clone.lock().await;
                map.values().cloned().collect()
            };
            // Merge BLE-discovered devices
            {
                let bt_map = bt_devices.lock().await;
                for dev in bt_map.values() {
                    // Only add BT device if not already present via mDNS
                    if !list.iter().any(|d| d.host == dev.host && d.port == dev.port) {
                        list.push(dev.clone());
                    }
                }
            }
            let _ = app_clone.emit("devices-update", &list);
        }
    });

    let mut d = state.discovery.lock().await;
    *d = Some(discovery_arc);

    let mut e = state.engine.lock().await;
    *e = Some(engine);

    Ok(())
}

/// Start Bluetooth scanning and advertising.
/// Returns `Ok(())` if started. Returns an error string if Bluetooth is unavailable.
#[tauri::command]
async fn start_bluetooth(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    {
        let mut enabled = state.bt_enabled.lock().await;
        if *enabled {
            return Ok(()); // already running
        }
        *enabled = true;
    }

    // Emit status immediately
    let _ = app_handle.emit("bluetooth-status", &serde_json::json!({"enabled": true}));

    // Start advertising (best-effort — some platforms may not support it)
    if let Ok(host) = local_ip_address::local_ip() {
        let engine = state.engine.lock().await;
        if let Some(ref eng) = *engine {
            let ctrl_port = *eng.control_port().lock().await;
            drop(engine);
            let name = whoami::fallible::hostname().unwrap_or_else(|_| "unknown".to_string());
            if let Err(e) = bluetooth::start_advertising(&host.to_string(), ctrl_port, &name) {
                log::warn!("BLE advertising unavailable: {}", e);
                let _ = app_handle.emit(
                    "bluetooth-status",
                    &serde_json::json!({"enabled": true, "advertise_error": e.to_string()}),
                );
            }
        }
    }

    // Start BLE scanning in background
    let bt_devices = state.bt_devices.clone();
    let bt_enabled = state.bt_enabled.clone();
    tokio::spawn(async move {
        bluetooth::scan_loop(bt_devices, bt_enabled).await;
    });

    Ok(())
}

/// Stop Bluetooth scanning and advertising.
#[tauri::command]
async fn stop_bluetooth(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    {
        let mut enabled = state.bt_enabled.lock().await;
        *enabled = false;
    }
    bluetooth::stop_advertising();
    state.bt_devices.lock().await.clear();
    let _ = app_handle.emit("bluetooth-status", &serde_json::json!({"enabled": false}));
    Ok(())
}

/// Return current Bluetooth enabled state.
#[tauri::command]
async fn get_bluetooth_status(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(*state.bt_enabled.lock().await)
}

#[tauri::command]
async fn my_info(state: State<'_, AppState>) -> Result<(String, u16), String> {
    let engine = state.engine.lock().await;
    let engine_ref = engine.as_ref().ok_or("Engine not started")?;
    let ctrl_port = *engine_ref.control_port().lock().await;

    let host = local_ip_address::local_ip()
        .map_err(|e| e.to_string())?;

    Ok((host.to_string(), ctrl_port))
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
async fn write_temp_file(
    data_base64: String,
    file_name: String,
) -> Result<String, String> {
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &data_base64,
    )
    .map_err(|e| e.to_string())?;
    let temp_dir = std::env::temp_dir().join("reflie");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| e.to_string())?;
    let path = temp_dir.join(&file_name);
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
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

    // Look up in LAN devices first, then BT devices
    let peer = {
        let d = state.discovery.lock().await;
        let disc = d.as_ref().ok_or("Discovery not started")?;
        let map = disc.lock().await;
        let devices = map.get_devices();
        let list = devices.lock().await;
        if let Some(dev) = list.get(&peer_id).cloned() {
            dev
        } else {
            drop(list);
            drop(map);
            drop(disc);
            drop(d);
            let bt = state.bt_devices.lock().await;
            bt.get(&peer_id)
                .cloned()
                .ok_or_else(|| format!("Peer not found: {}", peer_id))?
        }
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
    if let Some(ref engine) = *state.engine.lock().await {
        engine.cancel_session(&session_id).await;
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
            bt_devices: Arc::new(Mutex::new(HashMap::new())),
            bt_enabled: Arc::new(Mutex::new(false)),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            use tauri::menu::{Menu, MenuItem};
            let show = MenuItem::with_id(app, "show", "顯示視窗", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "離開", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let _tray = tauri::tray::TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_discovery,
            get_devices,
            my_info,
            send_file,
            write_temp_file,
            get_transfers,
            accept_transfer,
            cancel_transfer,
            start_bluetooth,
            stop_bluetooth,
            get_bluetooth_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
