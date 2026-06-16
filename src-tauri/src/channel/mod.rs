use crate::types::ControlMessage;
use anyhow::Result;
use std::net::SocketAddr;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::{TlsAcceptor, TlsConnector};
use crate::crypto::{create_tls_client_config, create_tls_config};

#[derive(Debug, Clone)]
pub struct IncomingMsg {
    pub msg: ControlMessage,
    pub peer_addr: SocketAddr,
}

pub struct ControlChannel {
    pub sender: mpsc::Sender<IncomingMsg>,
    pub receiver: mpsc::Receiver<IncomingMsg>,
}

async fn handle_control_conn(
    tls_stream: tokio_rustls::TlsStream<TcpStream>,
    tx: mpsc::Sender<IncomingMsg>,
    peer_addr: SocketAddr,
) {
    let (reader, _writer) = tokio::io::split(tls_stream);
    let mut buf_reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();
        match buf_reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                if let Ok(msg) = serde_json::from_str::<ControlMessage>(line.trim()) {
                    if tx.send(IncomingMsg { msg, peer_addr }).await.is_err() {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
}

impl ControlChannel {
    pub async fn listen(port: u16) -> Result<(Self, u16)> {
        let listener = TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
        let actual_port = listener.local_addr()?.port();
        let tls_config = create_tls_config()?;
        let acceptor = TlsAcceptor::from(tls_config);
        let (tx, rx) = mpsc::channel::<IncomingMsg>(256);
        let tx_clone = tx.clone();

        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, peer_addr)) => {
                        match acceptor.accept(stream).await {
                            Ok(tls_stream) => {
                                let tx = tx_clone.clone();
                                tokio::spawn(async move {
                                    handle_control_conn(tokio_rustls::TlsStream::Server(tls_stream), tx, peer_addr).await;
                                });
                            }
                            Err(e) => log::error!("TLS accept error: {}", e),
                        }
                    }
                    Err(e) => {
                        log::error!("Accept error: {}", e);
                        break;
                    }
                }
            }
        });

        Ok((ControlChannel { sender: tx, receiver: rx }, actual_port))
    }

    pub async fn connect(host: &str, port: u16) -> Result<(mpsc::Sender<ControlMessage>, mpsc::Receiver<ControlMessage>)> {
        let tls_config = create_tls_client_config()?;
        let connector = TlsConnector::from(tls_config);
        let stream = TcpStream::connect(format!("{}:{}", host, port)).await?;
        let domain = rustls::pki_types::ServerName::try_from("localhost")
            .map_err(|_| anyhow::anyhow!("Invalid DNS name"))?;
        let tls_stream = connector.connect(domain, stream).await?;
        let (tx, mut rx) = mpsc::channel::<ControlMessage>(256);
        let (incoming_tx, incoming_rx) = mpsc::channel::<ControlMessage>(256);

        let (reader, mut writer) = tokio::io::split(tls_stream);
        let mut buf_reader = BufReader::new(reader);

        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let json = serde_json::to_string(&msg).unwrap();
                if let Err(e) = writer.write_all(format!("{}\n", json).as_bytes()).await {
                    log::error!("Write error: {}", e);
                    break;
                }
            }
        });

        tokio::spawn(async move {
            let mut line = String::new();
            loop {
                line.clear();
                match buf_reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {
                        if let Ok(msg) = serde_json::from_str::<ControlMessage>(line.trim()) {
                            let _ = incoming_tx.send(msg).await;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok((tx, incoming_rx))
    }
}
