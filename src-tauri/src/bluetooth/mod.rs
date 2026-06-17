use crate::types::{DeviceInfo, DeviceStatus};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Bluetooth transport layer.
///
/// Discovery strategy:
///   1. This device advertises via BLE manufacturer data:
///      [magic: b"RF"][ip: 4 bytes][port: 2 bytes LE][name: ≤16 bytes UTF-8]
///      Company ID: 0xFFFF (reserved / testing)
///
///   2. Scanning uses `btleplug` (Central role) to find peers that broadcast
///      the above manufacturer data, then parses IP + port and injects them
///      into the shared device map.
///
///   File transfer still uses the existing TCP/TLS engine — Bluetooth is used
///   only for discovery and IP/port exchange.

const MANUFACTURER_ID: u16 = 0xFFFF;
const MAGIC: [u8; 2] = [b'R', b'F'];

// ── Advertising ──────────────────────────────────────────────────────────────

/// Start BLE peripheral advertising so other re/file instances can discover us.
/// Encodes local IP + control port + device name into manufacturer data.
#[cfg(target_os = "linux")]
pub fn start_advertising(ip: &str, port: u16, name: &str) -> Result<()> {
    use std::process::Command;

    let ip_parts: Vec<u8> = ip
        .split('.')
        .filter_map(|s| s.parse::<u8>().ok())
        .take(4)
        .collect();
    if ip_parts.len() != 4 {
        return Err(anyhow!("Invalid IP address: {}", ip));
    }

    let name_bytes = name.as_bytes();
    let name_len = name_bytes.len().min(16);

    // AD data layout (total ≤ 31 significant bytes):
    //   Flags:        02 01 06
    //   Manufacturer: [len] FF FF FF 52 46 [ip×4] [port×2] [name…]
    //   type(1) + company(2) + magic(2) + ip(4) + port(2) + name
    let mfr_payload_len = 1 + 2 + 2 + 4 + 2 + name_len;
    let sig_bytes = 3 + 1 + mfr_payload_len; // flags(3) + len_byte(1) + payload

    let mut args: Vec<String> = vec![
        "-i".into(), "hci0".into(),
        "cmd".into(), "0x08".into(), "0x0008".into(),
        format!("{:02x}", sig_bytes),
        // Flags
        "02".into(), "01".into(), "06".into(),
        // Manufacturer specific
        format!("{:02x}", mfr_payload_len),
        "ff".into(),        // type = Manufacturer Specific
        "ff".into(),        // company ID lo
        "ff".into(),        // company ID hi
        "52".into(),        // 'R'
        "46".into(),        // 'F'
    ];
    for b in &ip_parts {
        args.push(format!("{:02x}", b));
    }
    args.push(format!("{:02x}", port & 0xFF));
    args.push(format!("{:02x}", port >> 8));
    for b in &name_bytes[..name_len] {
        args.push(format!("{:02x}", b));
    }
    // Pad to 31 bytes
    for _ in 0..(31usize.saturating_sub(sig_bytes)) {
        args.push("00".into());
    }

    Command::new("hciconfig").args(["hci0", "up"]).output().ok();
    Command::new("hciconfig").args(["hci0", "leadv", "3"]).output().ok();
    Command::new("hcitool")
        .args(&args)
        .output()
        .map_err(|e| anyhow!("hcitool advertising failed: {}", e))?;

    Ok(())
}

#[cfg(target_os = "macos")]
pub fn start_advertising(_ip: &str, _port: u16, _name: &str) -> Result<()> {
    // macOS: CoreBluetooth peripheral advertising — planned for future release.
    // The app can still receive from macOS peers that advertise from other platforms.
    Err(anyhow!("BLE advertising not yet supported on macOS — please use LAN discovery"))
}

#[cfg(target_os = "windows")]
pub fn start_advertising(_ip: &str, _port: u16, _name: &str) -> Result<()> {
    // Windows: BluetoothLEAdvertisementPublisher — planned after resolving
    // windows-core v0.61 / v0.62 dependency conflict with Tauri.
    Err(anyhow!("BLE advertising not yet supported on Windows — please use LAN discovery"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub fn start_advertising(_ip: &str, _port: u16, _name: &str) -> Result<()> {
    Err(anyhow!("BLE advertising not supported on this platform"))
}

/// Stop BLE advertising.
#[cfg(target_os = "linux")]
pub fn stop_advertising() {
    let _ = std::process::Command::new("hciconfig")
        .args(["hci0", "noleadv"])
        .output();
}

#[cfg(not(target_os = "linux"))]
pub fn stop_advertising() {}

// ── Scanning ─────────────────────────────────────────────────────────────────

/// Continuously scan for re/file BLE advertisements and populate `bt_devices`.
/// Call this inside a `tokio::spawn` — it runs until `enabled` becomes false.
pub async fn scan_loop(
    bt_devices: Arc<Mutex<HashMap<String, DeviceInfo>>>,
    enabled: Arc<Mutex<bool>>,
) {
    if let Err(e) = scan_loop_inner(bt_devices, enabled).await {
        log::warn!("BLE scan ended: {}", e);
    }
}

async fn scan_loop_inner(
    bt_devices: Arc<Mutex<HashMap<String, DeviceInfo>>>,
    enabled: Arc<Mutex<bool>>,
) -> Result<()> {
    use btleplug::api::{Central as _, CentralEvent, Manager as _, Peripheral as _, ScanFilter};
    use btleplug::platform::Manager;
    use futures_util::StreamExt;

    let manager = Manager::new().await?;
    let adapters = manager.adapters().await?;
    let adapter = adapters
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("No Bluetooth adapter found"))?;

    adapter.start_scan(ScanFilter::default()).await?;

    let mut events = adapter.events().await?;

    while let Some(event) = events.next().await {
        if !*enabled.lock().await {
            break;
        }
        match event {
            CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id) => {
                let peripheral = match adapter.peripheral(&id).await {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                let props = match peripheral.properties().await {
                    Ok(Some(p)) => p,
                    _ => continue,
                };

                if let Some(mfr_data) = props.manufacturer_data.get(&MANUFACTURER_ID) {
                    if mfr_data.len() >= 8
                        && mfr_data[0] == MAGIC[0]
                        && mfr_data[1] == MAGIC[1]
                    {
                        let ip = format!(
                            "{}.{}.{}.{}",
                            mfr_data[2], mfr_data[3], mfr_data[4], mfr_data[5]
                        );
                        let port = u16::from_le_bytes([mfr_data[6], mfr_data[7]]);
                        let device_name = if mfr_data.len() > 8 {
                            String::from_utf8_lossy(&mfr_data[8..])
                                .trim_end_matches('\0')
                                .to_string()
                        } else {
                            props
                                .local_name
                                .unwrap_or_else(|| format!("BT-{}", &id.to_string()[..8]))
                        };

                        if port == 0 {
                            continue;
                        }

                        let device_id = format!("bt-{}", id);
                        let device = DeviceInfo {
                            id: device_id.clone(),
                            name: device_name,
                            host: ip,
                            port,
                            status: DeviceStatus::Online,
                            transport: Some("bluetooth".to_string()),
                        };

                        let mut map = bt_devices.lock().await;
                        map.insert(device_id, device);
                    }
                }
            }
            CentralEvent::DeviceDisconnected(id) => {
                let key = format!("bt-{}", id);
                bt_devices.lock().await.remove(&key);
            }
            _ => {}
        }
    }

    Ok(())
}
