use crate::types::{DeviceInfo, DeviceStatus, SERVICE_TYPE};
use anyhow::Result;
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct DeviceDiscovery {
    mdns: Arc<ServiceDaemon>,
    devices: Arc<Mutex<HashMap<String, DeviceInfo>>>,
}

impl DeviceDiscovery {
    pub fn new() -> Result<Self> {
        let mdns = ServiceDaemon::new()?;
        Ok(Self {
            mdns: Arc::new(mdns),
            devices: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn register(&self, name: &str, hostname: &str, port: u16, device_id: &str) -> Result<()> {
        let service = ServiceInfo::new(
            SERVICE_TYPE,
            name,
            hostname,
            "",
            port,
            std::collections::HashMap::from([("id".to_string(), device_id.to_string()), ("name".to_string(), name.to_string())]),
        )?;
        self.mdns.register(service)?;
        Ok(())
    }

    pub fn get_devices(&self) -> Arc<Mutex<HashMap<String, DeviceInfo>>> {
        self.devices.clone()
    }

    pub fn start_browsing(&self) -> Result<()> {
        let receiver = self.mdns.browse(SERVICE_TYPE)?;
        let devices = self.devices.clone();

        std::thread::spawn(move || {
            for event in receiver {
                match event {
                    ServiceEvent::ServiceResolved(info) => {
                        let id = info
                            .get_property("id")
                            .and_then(|v| v.val())
                            .map(|b| String::from_utf8_lossy(b).to_string())
                            .unwrap_or_else(|| "unknown".to_string());
                        let name = info
                            .get_property("name")
                            .and_then(|v| v.val())
                            .map(|b| String::from_utf8_lossy(b).to_string())
                            .unwrap_or_else(|| info.get_fullname().to_string());

                        let device = DeviceInfo {
                            id,
                            name,
                            host: info.get_hostname().trim_end_matches('.').to_string(),
                            port: info.get_port(),
                            status: DeviceStatus::Online,
                            transport: None,
                        };

                        let mut map = devices.blocking_lock();
                        map.insert(device.id.clone(), device);
                    }
                    ServiceEvent::ServiceRemoved(_, full_name) => {
                        let mut map = devices.blocking_lock();
                        map.retain(|_, v| {
                            let svc_name = format!("{}.{}", v.name, SERVICE_TYPE);
                            svc_name != full_name
                        });
                    }
                    _ => {}
                }
            }
        });

        Ok(())
    }
}
