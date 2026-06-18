use crate::crypto::{create_tls_client_config, create_tls_config};
use crate::types::{CHUNK_SIZE, DATA_PORT};
use anyhow::Result;
use bytes::BytesMut;
use sha2::Digest;
use std::path::Path;
use std::sync::Arc;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_rustls::{TlsAcceptor, TlsConnector};

pub struct TransferStats {
    pub bytes_sent: Arc<Mutex<u64>>,
    #[allow(dead_code)]
    pub total_bytes: u64,
    pub start_time: Arc<Mutex<std::time::Instant>>,
}

impl TransferStats {
    pub fn new(total_bytes: u64) -> Self {
        Self {
            bytes_sent: Arc::new(Mutex::new(0)),
            total_bytes,
            start_time: Arc::new(Mutex::new(std::time::Instant::now())),
        }
    }

    #[allow(dead_code)]
    pub async fn progress(&self) -> f64 {
        let sent = *self.bytes_sent.lock().await;
        if self.total_bytes == 0 {
            return 0.0;
        }
        sent as f64 / self.total_bytes as f64
    }

    pub async fn speed(&self) -> f64 {
        let sent = *self.bytes_sent.lock().await;
        let elapsed = self.start_time.lock().await.elapsed().as_secs_f64();
        if elapsed == 0.0 {
            return 0.0;
        }
        sent as f64 / elapsed
    }
}

pub async fn send_file(stream: &mut (impl AsyncWriteExt + Unpin), path: &Path, stats: &TransferStats) -> Result<String> {
    let mut file = fs::File::open(path).await?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = BytesMut::with_capacity(CHUNK_SIZE);
    buf.resize(CHUNK_SIZE, 0);

    loop {
        let n = file.read(&mut buf[..CHUNK_SIZE]).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        stream.write_all(&buf[..n]).await?;
        let mut sent = stats.bytes_sent.lock().await;
        *sent += n as u64;
    }

    stream.flush().await?;
    Ok(hex::encode(hasher.finalize()))
}

pub async fn send_file_with_session(
    stream: &mut (impl AsyncWriteExt + Unpin),
    session_id: &str,
    path: &Path,
    stats: &TransferStats,
) -> Result<String> {
    let id_bytes = session_id.as_bytes();
    let len = id_bytes.len() as u32;
    stream.write_all(&len.to_le_bytes()).await?;
    stream.write_all(id_bytes).await?;
    send_file(stream, path, stats).await
}

pub async fn receive_file(stream: &mut (impl AsyncReadExt + Unpin), path: &Path, total_bytes: u64) -> Result<String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut file = fs::File::create(path).await?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = BytesMut::with_capacity(CHUNK_SIZE);
    buf.resize(CHUNK_SIZE, 0);
    let mut remaining = total_bytes;

    while remaining > 0 {
        let to_read = std::cmp::min(CHUNK_SIZE as u64, remaining) as usize;
        let n = stream.read(&mut buf[..to_read]).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).await?;
        remaining -= n as u64;
    }

    file.flush().await?;
    Ok(hex::encode(hasher.finalize()))
}

pub async fn receive_file_with_session(
    stream: &mut (impl AsyncReadExt + Unpin),
    path: &Path,
    total_bytes: u64,
) -> Result<(String, String)> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let id_len = u32::from_le_bytes(len_buf) as usize;
    let mut id_buf = vec![0u8; id_len];
    stream.read_exact(&mut id_buf).await?;
    let session_id = String::from_utf8(id_buf)?;
    let hash = receive_file(stream, path, total_bytes).await?;
    Ok((session_id, hash))
}

pub struct TransferServer {
    listener: TcpListener,
    acceptor: TlsAcceptor,
}

impl TransferServer {
    pub async fn new() -> Result<(Self, u16)> {
        let listener = TcpListener::bind(format!("0.0.0.0:{}", DATA_PORT)).await?;
        let port = listener.local_addr()?.port();
        let tls_config = create_tls_config()?;
        let acceptor = TlsAcceptor::from(tls_config);
        Ok((Self { listener, acceptor }, port))
    }

    pub async fn accept(&self) -> Result<tokio_rustls::TlsStream<TcpStream>> {
        let (stream, _) = self.listener.accept().await?;
        let tls = self.acceptor.accept(stream).await?;
        Ok(tokio_rustls::TlsStream::Server(tls))
    }
}

pub async fn connect_data(host: &str, port: u16) -> Result<tokio_rustls::TlsStream<TcpStream>> {
    let tls_config = create_tls_client_config()?;
    let connector = TlsConnector::from(tls_config);
    let stream = TcpStream::connect(format!("{}:{}", host, port)).await?;
    let domain = rustls::pki_types::ServerName::try_from("localhost")
        .map_err(|_| anyhow::anyhow!("Invalid DNS name"))?;
    let tls = connector.connect(domain, stream).await?;
    Ok(tokio_rustls::TlsStream::Client(tls))
}
