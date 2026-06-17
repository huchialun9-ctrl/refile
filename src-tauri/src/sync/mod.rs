use crate::types::{ControlMessage, SYNC_INTERVAL_MS};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

pub struct ProgressSync {
    session_id: String,
    control_tx: tokio::sync::mpsc::Sender<ControlMessage>,
    bytes_sent: Arc<Mutex<u64>>,
    total_bytes: u64,
    last_bytes: Arc<Mutex<u64>>,
    last_time: Arc<Mutex<Instant>>,
    running: Arc<Mutex<bool>>,
}

impl ProgressSync {
    pub fn new(
        session_id: String,
        control_tx: tokio::sync::mpsc::Sender<ControlMessage>,
        bytes_sent: Arc<Mutex<u64>>,
        total_bytes: u64,
    ) -> Self {
        Self {
            session_id,
            control_tx,
            bytes_sent,
            total_bytes,
            last_bytes: Arc::new(Mutex::new(0)),
            last_time: Arc::new(Mutex::new(Instant::now())),
            running: Arc::new(Mutex::new(true)),
        }
    }

    pub async fn start(&self) {
        let session_id = self.session_id.clone();
        let control_tx = self.control_tx.clone();
        let bytes_sent = self.bytes_sent.clone();
        let total_bytes = self.total_bytes;
        let last_bytes = self.last_bytes.clone();
        let last_time = self.last_time.clone();
        let running = self.running.clone();

        tokio::spawn(async move {
            while *running.lock().await {
                tokio::time::sleep(tokio::time::Duration::from_millis(SYNC_INTERVAL_MS)).await;

                let current = *bytes_sent.lock().await;
                if current >= total_bytes && total_bytes > 0 {
                    break;
                }

                let mut prev = last_bytes.lock().await;
                let mut prev_time = last_time.lock().await;
                let now = Instant::now();
                let elapsed = now.duration_since(*prev_time).as_secs_f64();
                let speed = if elapsed > 0.0 {
                    (current - *prev) as f64 / elapsed
                } else {
                    0.0
                };

                *prev = current;
                *prev_time = now;

                let msg = ControlMessage::Progress {
                    session_id: session_id.clone(),
                    bytes_sent: current,
                    speed,
                };

                if control_tx.send(msg).await.is_err() {
                    break;
                }
            }

            let mut running_lock = running.lock().await;
            *running_lock = false;
        });
    }

    pub async fn stop(&self) {
        let mut running = self.running.lock().await;
        *running = false;
    }
}
