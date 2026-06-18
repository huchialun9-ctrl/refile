use anyhow::Result;
use rcgen::{CertificateParams, KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::ServerConfig;
use sha2::Digest;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt};

#[allow(dead_code)]
pub fn hash_sha256(data: &[u8]) -> String {
    let mut hasher = sha2::Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

#[allow(dead_code)]
pub async fn hash_reader(reader: &mut (impl AsyncRead + Unpin)) -> Result<String> {
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 65536];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn create_tls_config() -> Result<Arc<ServerConfig>> {
    let key_pair = KeyPair::generate()?;
    let params = CertificateParams::new(vec!["localhost".to_string()])?;
    let cert = params.self_signed(&key_pair)?;
    let cert_der = CertificateDer::from(cert.der().to_vec());
    let key_der = PrivateKeyDer::try_from(key_pair.serialize_der())
        .map_err(|e| anyhow::anyhow!("{}", e))?;

    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert_der], key_der)?;

    Ok(Arc::new(config))
}

pub fn create_tls_client_config() -> Result<Arc<rustls::ClientConfig>> {
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(
            SkipCertVerifier,
        ))
        .with_no_client_auth();

    Ok(Arc::new(config))
}

// SECURITY: This verifier accepts *any* TLS certificate without validation.
// This is acceptable for a LAN P2P file-transfer app where self-signed
// certs are generated at runtime and there is no PKI.  Do NOT reuse this
// code in an application that connects to untrusted networks or the public
// internet without proper certificate verification.
#[derive(Debug)]
struct SkipCertVerifier;

impl rustls::client::danger::ServerCertVerifier for SkipCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        vec![
            rustls::SignatureScheme::RSA_PKCS1_SHA256,
            rustls::SignatureScheme::RSA_PKCS1_SHA384,
            rustls::SignatureScheme::RSA_PKCS1_SHA512,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP384_SHA384,
            rustls::SignatureScheme::RSA_PSS_SHA256,
            rustls::SignatureScheme::RSA_PSS_SHA384,
            rustls::SignatureScheme::RSA_PSS_SHA512,
        ]
    }
}
