use futures_util::FutureExt;
use rsipstack::dialog::authenticate::{handle_client_authenticate, Credential};
use rsipstack::sip::prelude::*;
use rsipstack::sip::{self, typed, Header, Method, SipMessage, StatusCode, Uri};
use rsipstack::transaction::key::{TransactionKey, TransactionRole};
use rsipstack::transaction::transaction::Transaction;
use rsipstack::transport::stream::StreamConnection;
use rsipstack::transport::tcp::TcpConnection;
use rsipstack::transport::tls::{TlsConfig, TlsConnection};
use rsipstack::transport::udp::UdpConnection;
use rsipstack::transport::{SipAddr, SipConnection, TransportLayer};
use rsipstack::EndpointBuilder as RsEndpointBuilder;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::error::CommandError;
use crate::ratelimit::SIP_RATE_LIMITER;

const MAX_CALLER_ID_LENGTH: usize = 128;
const MIN_REGISTER_EXPIRY: u32 = 30;
const MAX_REGISTER_EXPIRY: u32 = 86400;
const MIN_PORT: u16 = 1;
const MAX_PORT: u16 = 65535;

#[derive(Debug, Clone)]
pub struct SipConfig {
    pub username: String,
    pub password: SecretString,
    pub server: String,
    pub port: Option<u16>,
    pub protocol: Option<String>,
    pub auth_username: Option<String>,
    pub register_expiry: Option<u32>,
}

impl Serialize for SipConfig {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("SipConfig", 7)?;
        st.serialize_field("username", &self.username)?;
        st.serialize_field("password", self.password.expose_secret())?;
        st.serialize_field("server", &self.server)?;
        st.serialize_field("port", &self.port)?;
        st.serialize_field("protocol", &self.protocol)?;
        st.serialize_field("authUsername", &self.auth_username)?;
        st.serialize_field("registerExpiry", &self.register_expiry)?;
        st.end()
    }
}

impl<'de> Deserialize<'de> for SipConfig {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raw {
            username: String,
            password: String,
            server: String,
            port: Option<u16>,
            protocol: Option<String>,
            auth_username: Option<String>,
            register_expiry: Option<u32>,
        }
        let raw = Raw::deserialize(d)?;
        Ok(Self {
            username: raw.username,
            password: SecretString::from(raw.password),
            server: raw.server,
            port: raw.port,
            protocol: raw.protocol,
            auth_username: raw.auth_username,
            register_expiry: raw.register_expiry,
        })
    }
}

impl SipConfig {
    fn contains_sip_dangerous_chars(s: &str) -> bool {
        s.chars().any(|c| {
            matches!(
                c,
                '\r' | '\n' | '"' | '(' | ')' | '<' | '>' | '\\' | ',' | '?' | '[' | ']'
            )
        })
    }

    pub fn validate(&self) -> Result<(), CommandError> {
        if self.username.is_empty() {
            return Err(CommandError::invalid_input("SIP username is required"));
        }
        if self.username.len() > 128 {
            return Err(CommandError::invalid_input(
                "SIP username exceeds maximum length of 128 characters",
            ));
        }
        if Self::contains_sip_dangerous_chars(&self.username) {
            return Err(CommandError::invalid_input(
                "SIP username contains invalid characters",
            ));
        }
        if self.server.is_empty() {
            return Err(CommandError::invalid_input("SIP server is required"));
        }
        if self.server.len() > 256 {
            return Err(CommandError::invalid_input(
                "SIP server address exceeds maximum length",
            ));
        }
        if Self::contains_sip_dangerous_chars(&self.server) {
            return Err(CommandError::invalid_input(
                "SIP server contains invalid characters",
            ));
        }
        if let Some(port) = self.port {
            if !(MIN_PORT..=MAX_PORT).contains(&port) {
                return Err(CommandError::invalid_input(format!(
                    "SIP port must be between {} and {}",
                    MIN_PORT, MAX_PORT
                )));
            }
        }
        if let Some(ref protocol) = self.protocol {
            let upper = protocol.to_uppercase();
            if upper != "UDP" && upper != "TCP" && upper != "TLS" {
                return Err(CommandError::invalid_input(format!(
                    "Unsupported protocol: {}. Use UDP, TCP, or TLS",
                    protocol
                )));
            }
        }
        if let Some(expiry) = self.register_expiry {
            if !(MIN_REGISTER_EXPIRY..=MAX_REGISTER_EXPIRY).contains(&expiry) {
                return Err(CommandError::invalid_input(format!(
                    "Registration expiry must be between {} and {} seconds",
                    MIN_REGISTER_EXPIRY, MAX_REGISTER_EXPIRY
                )));
            }
        }
        let pw = self.password.expose_secret();
        if pw.is_empty() {
            return Err(CommandError::invalid_input("SIP password is required"));
        }
        if pw.len() > 512 {
            return Err(CommandError::invalid_input(
                "SIP password exceeds maximum length of 512 characters",
            ));
        }
        if let Some(ref auth_user) = self.auth_username {
            if auth_user.len() > 128 {
                return Err(CommandError::invalid_input(
                    "Auth username exceeds maximum length of 128 characters",
                ));
            }
            if Self::contains_sip_dangerous_chars(auth_user) {
                return Err(CommandError::invalid_input(
                    "Auth username contains invalid characters",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SipStatus {
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteData {
    pub caller_number: String,
    pub caller_name: String,
}

fn user_safe_sip_error(msg: &str) -> String {
    if msg.contains("Connection refused") || msg.contains("os error") {
        "Connection to SIP server failed. Check server address and port.".to_string()
    } else if msg.contains("DNS resolution failed") || msg.contains("No addresses found") {
        "Could not resolve SIP server hostname. Check server address.".to_string()
    } else if msg.contains("Timeout") || msg.contains("timeout") {
        "SIP server did not respond. Check server availability.".to_string()
    } else {
        format!("SIP error: {}", msg.chars().take(128).collect::<String>())
    }
}

fn sanitize_caller_id(s: &str) -> String {
    s.chars()
        .filter(|&c| c.is_ascii_graphic() || c == ' ')
        .collect::<String>()
        .chars()
        .take(MAX_CALLER_ID_LENGTH)
        .collect()
}

/// Determine the local IP address that the OS will use for outbound traffic
/// to the given server address. Creates a temporary UDP socket — no actual
/// data is sent; only local OS syscalls are made.
fn get_local_ip_for(server_addr: std::net::SocketAddr) -> std::net::IpAddr {
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if socket.connect(server_addr).is_ok() {
            if let Ok(local) = socket.local_addr() {
                let ip = local.ip();
                if !ip.is_unspecified() && !ip.is_loopback() {
                    return ip;
                }
            }
        }
    }
    // Fallback — some servers accept this, others use the source IP anyway.
    std::net::IpAddr::V4(std::net::Ipv4Addr::new(0, 0, 0, 0))
}

fn safe_emit(handle: &AppHandle, event: &str, payload: impl serde::Serialize + Clone) {
    if let Err(e) = handle.emit(event, payload) {
        log::error!("[sip] Failed to emit {}: {}", event, e);
    }
}

fn extract_invite_caller(text: &SipMessage) -> (String, String) {
    let mut caller_number = "Unknown".to_string();
    let mut caller_name = String::new();
    if let Ok(from_header) = text.from_header() {
        let from_val = from_header.value();
        if let Some(q1) = from_val.find('"') {
            if let Some(q2) = from_val[q1 + 1..].find('"') {
                caller_name = from_val[q1 + 1..q1 + 1 + q2].to_string();
            }
        }
        if let Some(at_pos) = from_val.find('@') {
            let before_at = &from_val[..at_pos];
            if let Some(colon_pos) = before_at.rfind(':') {
                caller_number = before_at[colon_pos + 1..].to_string();
            } else if let Some(sip_prefix) = before_at.rfind("sip:") {
                caller_number = before_at[sip_prefix + 4..].to_string();
            }
        }
    }
    (
        sanitize_caller_id(&caller_number),
        sanitize_caller_id(&caller_name),
    )
}

async fn create_transport(
    protocol: &str,
    server_ip: std::net::IpAddr,
    port: u16,
    server_hostname: &str,
    cancel_token: CancellationToken,
) -> Result<(SipConnection, u16), String> {
    match protocol {
        "TCP" => {
            let target = SipAddr {
                r#type: Some(sip::Transport::Tcp),
                addr: sip::HostWithPort {
                    host: sip::Host::IpAddr(server_ip),
                    port: Some(sip::transport::Port::from(port)),
                },
            };
            let tcp = TcpConnection::connect(&target, Some(cancel_token))
                .await
                .map_err(|e| format!("TCP connect failed: {}", e))?;
            let local_port = tcp.get_addr().addr.port.map(|p| p.value()).unwrap_or(0);
            Ok((SipConnection::Tcp(tcp), local_port))
        }
        "TLS" => {
            let target = SipAddr {
                r#type: Some(sip::Transport::Tls),
                addr: sip::HostWithPort {
                    host: sip::Host::IpAddr(server_ip),
                    port: Some(sip::transport::Port::from(port)),
                },
            };
            let cert_result = rustls_native_certs::load_native_certs();
            let mut ca_pem = String::new();
            for cert in &cert_result.certs {
                let der = cert.as_ref();
                let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, der);
                ca_pem.push_str("-----BEGIN CERTIFICATE-----\n");
                for chunk in b64.as_bytes().chunks(64) {
                    ca_pem.push_str(&String::from_utf8_lossy(chunk));
                    ca_pem.push('\n');
                }
                ca_pem.push_str("-----END CERTIFICATE-----\n");
            }
            let tls_config = TlsConfig {
                ca_certs: Some(ca_pem.into_bytes()),
                sni_hostname: Some(server_hostname.to_string()),
                ..Default::default()
            };
            let tls = TlsConnection::connect(&target, Some(&tls_config), None, Some(cancel_token))
                .await
                .map_err(|e| format!("TLS connect failed: {}", e))?;
            let local_port = tls.get_addr().addr.port.map(|p| p.value()).unwrap_or(0);
            Ok((SipConnection::Tls(tls), local_port))
        }
        _ => {
            let udp = UdpConnection::create_connection(
                "0.0.0.0:0"
                    .parse()
                    .map_err(|e| format!("Invalid bind address: {}", e))?,
                None,
                Some(cancel_token),
            )
            .await
            .map_err(|e| format!("Failed to bind UDP: {}", e))?;
            let local_port = udp.get_addr().addr.port.map(|p| p.value()).unwrap_or(5060);
            Ok((SipConnection::Udp(udp), local_port))
        }
    }
}

pub struct SipClient {
    pub connected: Arc<Mutex<bool>>,
    pub handle: AppHandle,
    pub task_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl SipClient {
    pub fn new(handle: AppHandle) -> Self {
        Self {
            connected: Arc::new(Mutex::new(false)),
            handle,
            task_handle: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn start(&self, config: SipConfig) {
        let handle = self.handle.clone();
        let connected = self.connected.clone();

        let join_handle = tokio::spawn(async move {
            let future = std::panic::AssertUnwindSafe(async move {
                let server = config.server.clone();
                let protocol = config.protocol.as_deref().unwrap_or("UDP").to_string();
                let port = config
                    .port
                    .unwrap_or(if protocol == "TLS" { 5061 } else { 5060 });

                let server_addr =
                    match tokio::net::lookup_host(format!("{}:{}", server, port)).await {
                        Ok(mut addrs) => match addrs.next() {
                            Some(addr) => addr,
                            None => {
                                safe_emit(
                                    &handle,
                                    "sip:status",
                                    SipStatus {
                                        status: "error".to_string(),
                                        message: Some(user_safe_sip_error(&format!(
                                            "No addresses found for {}:{}",
                                            server, port
                                        ))),
                                    },
                                );
                                return;
                            }
                        },
                        Err(e) => {
                            safe_emit(
                                &handle,
                                "sip:status",
                                SipStatus {
                                    status: "error".to_string(),
                                    message: Some(user_safe_sip_error(&format!(
                                        "DNS resolution failed: {}",
                                        e
                                    ))),
                                },
                            );
                            return;
                        }
                    };

                let cancel_token = CancellationToken::new();
                let (transport, local_port) = match create_transport(
                    &protocol,
                    server_addr.ip(),
                    port,
                    &server,
                    cancel_token.child_token(),
                )
                .await
                {
                    Ok(t) => t,
                    Err(e) => {
                        safe_emit(
                            &handle,
                            "sip:status",
                            SipStatus {
                                status: "error".to_string(),
                                message: Some(user_safe_sip_error(&e)),
                            },
                        );
                        return;
                    }
                };

                safe_emit(
                    &handle,
                    "sip:status",
                    SipStatus {
                        status: "connecting".to_string(),
                        message: Some(format!("Bound to {} port {}", protocol, local_port)),
                    },
                );

                // Build TransportLayer and Endpoint for transaction handling.
                // add_connection registers TCP/TLS (they have a remote address);
                // add_transport also registers UDP (no remote address) into the
                // listen set that serve_listens() and lookup() traverse.
                let transport_layer = TransportLayer::new(cancel_token.child_token());
                transport_layer.add_connection(transport.clone());
                transport_layer.add_transport(transport.clone());

                let endpoint = RsEndpointBuilder::new()
                    .with_user_agent("CallerFlash")
                    .with_transport_layer(transport_layer)
                    .with_cancel_token(cancel_token.child_token())
                    .build();

                let endpoint_inner = endpoint.inner.clone();
                let mut incoming = match endpoint.incoming_transactions() {
                    Ok(rx) => rx,
                    Err(e) => {
                        log::error!("[sip] Failed to get incoming transactions: {}", e);
                        safe_emit(
                            &handle,
                            "sip:status",
                            SipStatus {
                                status: "error".to_string(),
                                message: Some(
                                    "Internal error: failed to initialize SIP".to_string(),
                                ),
                            },
                        );
                        return;
                    }
                };

                let serve_handle = handle.clone();
                let endpoint_serve = tokio::spawn({
                    let inner = endpoint_inner.clone();
                    async move {
                        log::info!("[sip] Endpoint serve task started");
                        safe_emit(
                            &serve_handle,
                            "sip:log",
                            serde_json::json!({
                                "message": "SIP endpoint serve task started"
                            }),
                        );
                        let _ = inner.serve().await;
                        log::warn!("[sip] Endpoint serve task exited!");
                        safe_emit(
                            &serve_handle,
                            "sip:log",
                            serde_json::json!({
                                "message": "SIP endpoint serve task EXITED"
                            }),
                        );
                    }
                });

                let server_transport_param = match protocol.as_str() {
                    "TCP" => ";transport=tcp",
                    "TLS" => ";transport=tls",
                    _ => "",
                };
                let server_uri = match Uri::try_from(
                    format!("sip:{}:{}{}", config.server, port, server_transport_param).as_str(),
                ) {
                    Ok(u) => u,
                    Err(e) => {
                        log::error!("[sip] Invalid server URI: {}", e);
                        safe_emit(
                            &handle,
                            "sip:status",
                            SipStatus {
                                status: "error".to_string(),
                                message: Some("Invalid server address".to_string()),
                            },
                        );
                        return;
                    }
                };

                let auth_username = config
                    .auth_username
                    .clone()
                    .unwrap_or_else(|| config.username.clone());
                let credential = Credential {
                    username: auth_username,
                    password: config.password.expose_secret().to_string(),
                    realm: None,
                };

                let expiry = config.register_expiry.unwrap_or(300);
                let refresh_ms = std::cmp::max((expiry as u64).saturating_sub(15) * 1000, 30_000);
                let mut consecutive_failures = 0u32;

                // Build initial REGISTER request
                let call_id = rsipstack::transaction::make_call_id(Some("127.0.0.1"));
                let from_to_uri = match Uri::try_from(
                    format!("sip:{}@{}", config.username, config.server).as_str(),
                ) {
                    Ok(u) => u,
                    Err(e) => {
                        log::error!("[sip] Invalid From/To URI: {}", e);
                        return;
                    }
                };
                // Determine the local IP for the Contact header. The SIP server uses
                // this to route incoming calls back to us; it must be our address,
                // not the server's.
                let local_ip = get_local_ip_for(std::net::SocketAddr::new(server_addr.ip(), port));
                let local_ip_str = local_ip.to_string();
                let mut contact_uri = match Uri::try_from({
                    let transport_param = match protocol.as_str() {
                        "TCP" => ";transport=tcp",
                        "TLS" => ";transport=tls",
                        _ => "",
                    };
                    format!(
                        "sip:{}@{}:{}{}",
                        config.username, local_ip_str, local_port, transport_param
                    )
                    .as_str()
                }) {
                    Ok(u) => u,
                    Err(e) => {
                        log::error!("[sip] Invalid Contact URI: {}", e);
                        return;
                    }
                };

                // Shared state for public address discovered from REGISTER response Via received/rport
                let external_addr: Arc<Mutex<Option<(String, u16)>>> = Arc::new(Mutex::new(None));

                let mut cseq = 1u32;

                let _ = handle.emit(
                    "sip:log",
                    serde_json::json!({"message": format!("[SIP] Starting registration — server: {}:{}, expiry: {}, protocol: {}", config.server, port, expiry, protocol)}),
                );
                let _ = handle.emit(
                    "sip:log",
                    serde_json::json!({"message": format!("[SIP] Contact URI: {} (local addr: {}:{})", contact_uri, local_ip_str, local_port)}),
                );

                #[allow(clippy::too_many_arguments)]
                async fn do_register(
                    endpoint_inner: &Arc<rsipstack::transaction::endpoint::EndpointInner>,
                    server_uri: &Uri,
                    from_to_uri: &Uri,
                    contact_uri: &Uri,
                    call_id: &sip::headers::CallId,
                    cseq: &mut u32,
                    expiry: u32,
                    credential: &Credential,
                    handle: &AppHandle,
                    connected: &Arc<Mutex<bool>>,
                    consecutive_failures: &mut u32,
                    local_sip_addr: &SipAddr,
                    external_addr: &Arc<Mutex<Option<(String, u16)>>>,
                ) -> bool {
                    *cseq += 1;
                    let via = match endpoint_inner.get_via(Some(local_sip_addr.clone()), None) {
                        Ok(v) => v,
                        Err(e) => {
                            log::error!("[sip] Failed to create Via: {}", e);
                            safe_emit(
                                handle,
                                "sip:status",
                                SipStatus {
                                    status: "error".to_string(),
                                    message: Some(format!("SIP internal error (Via): {}", e)),
                                },
                            );
                            *consecutive_failures += 1;
                            return false;
                        }
                    };
                    let from = typed::From {
                        display_name: None,
                        uri: from_to_uri.clone(),
                        params: vec![],
                    }
                    .with_tag(rsipstack::transaction::make_tag());
                    let to = typed::To {
                        display_name: None,
                        uri: from_to_uri.clone(),
                        params: vec![],
                    };

                    let mut request = endpoint_inner.make_request(
                        Method::Register,
                        server_uri.clone(),
                        via,
                        from,
                        to,
                        *cseq,
                        None,
                    );

                    let contact = typed::Contact {
                        display_name: None,
                        uri: contact_uri.clone(),
                        params: vec![sip::Param::Expires(sip::param::Expires::new(
                            expiry.to_string(),
                        ))],
                    };

                    request.headers.unique_push(call_id.clone().into());
                    request.headers.unique_push(contact.into());
                    request
                        .headers
                        .unique_push(Header::Expires(sip::headers::Expires::from(
                            expiry.to_string(),
                        )));
                    request
                        .headers
                        .unique_push(sip::headers::UserAgent::new("CallerFlash").into());

                    let key = match TransactionKey::from_request(&request, TransactionRole::Client)
                    {
                        Ok(k) => k,
                        Err(e) => {
                            log::error!("[sip] Failed to create transaction key: {}", e);
                            safe_emit(
                                handle,
                                "sip:status",
                                SipStatus {
                                    status: "error".to_string(),
                                    message: Some(format!(
                                        "SIP internal error (transaction key): {}",
                                        e
                                    )),
                                },
                            );
                            *consecutive_failures += 1;
                            return false;
                        }
                    };

                    let mut tx =
                        Transaction::new_client(key, request, endpoint_inner.clone(), None);

                    if let Err(e) = tx.send().await {
                        log::error!("[sip] Failed to send REGISTER: {}", e);
                        safe_emit(
                            handle,
                            "sip:status",
                            SipStatus {
                                status: "error".to_string(),
                                message: Some(format!("Failed to send REGISTER: {}", e)),
                            },
                        );
                        *consecutive_failures += 1;
                        return false;
                    }

                    let mut auth_sent = false;

                    loop {
                        // Bound each REGISTER response wait so a server that never
                        // replies cannot leave the client stuck "connecting" forever.
                        let recv =
                            tokio::time::timeout(std::time::Duration::from_secs(15), tx.receive())
                                .await;
                        let msg = match recv {
                            Ok(Some(m)) => m,
                            Ok(None) => break,
                            Err(_) => {
                                log::error!(
                                    "[sip] REGISTER timed out after 15s — no response from server"
                                );
                                safe_emit(
                                    handle,
                                    "sip:status",
                                    SipStatus {
                                        status: "error".to_string(),
                                        message: Some(
                                            "Registration timed out — no response from server"
                                                .to_string(),
                                        ),
                                    },
                                );
                                *consecutive_failures += 1;
                                return false;
                            }
                        };
                        if let SipMessage::Response(resp) = msg {
                            match resp.status_code {
                                StatusCode::Unauthorized
                                | StatusCode::ProxyAuthenticationRequired => {
                                    if auth_sent {
                                        let reason = resp.reason_phrase().unwrap_or("").to_string();
                                        log::error!(
                                            "[sip] Auth retry failed: {} {}",
                                            resp.status_code.code(),
                                            reason
                                        );
                                        safe_emit(
                                            handle,
                                            "sip:status",
                                            SipStatus {
                                                status: "error".to_string(),
                                                message: Some(format!(
                                                    "Authentication retry failed: {} {}",
                                                    resp.status_code.code(),
                                                    reason
                                                )),
                                            },
                                        );
                                        *consecutive_failures += 1;
                                        return false;
                                    }
                                    *cseq += 1;
                                    match handle_client_authenticate(*cseq, &tx, resp, credential)
                                        .await
                                    {
                                        Ok(auth_tx) => {
                                            tx = auth_tx;
                                            if let Err(e) = tx.send().await {
                                                log::error!(
                                                    "[sip] Failed to send auth REGISTER: {}",
                                                    e
                                                );
                                                *consecutive_failures += 1;
                                                return false;
                                            }
                                            auth_sent = true;
                                        }
                                        Err(e) => {
                                            log::error!(
                                                "[sip] Auth challenge handling failed: {}",
                                                e
                                            );
                                            safe_emit(
                                                handle,
                                                "sip:status",
                                                SipStatus {
                                                    status: "error".to_string(),
                                                    message: Some(format!(
                                                        "Auth challenge handling failed: {}",
                                                        e
                                                    )),
                                                },
                                            );
                                            *consecutive_failures += 1;
                                            return false;
                                        }
                                    }
                                }
                                StatusCode::OK => {
                                    *connected.lock().await = true;
                                    *consecutive_failures = 0;

                                    // Detect public address from Via received/rport (RFC 3581)
                                    if external_addr.lock().await.is_none() {
                                        if let Some(addr) = resp.via_received() {
                                            let public_addr = (
                                                addr.host.to_string(),
                                                addr.port.map(|p| p.0).unwrap_or(5060),
                                            );
                                            *external_addr.lock().await = Some(public_addr.clone());
                                            log::info!(
                                                "[sip] Detected public address: {}:{}",
                                                public_addr.0,
                                                public_addr.1
                                            );
                                            safe_emit(
                                                handle,
                                                "sip:log",
                                                serde_json::json!({
                                                    "message": format!(
                                                        "[SIP] Detected public address: {}:{}",
                                                        public_addr.0, public_addr.1
                                                    )
                                                }),
                                            );
                                        }
                                    }

                                    safe_emit(
                                        handle,
                                        "sip:status",
                                        SipStatus {
                                            status: "registered".to_string(),
                                            message: None,
                                        },
                                    );
                                    log::info!("[sip] Registered successfully");
                                    return true;
                                }
                                _ => {
                                    let reason = resp.reason_phrase().unwrap_or("").to_string();
                                    let code = resp.status_code.code();
                                    log::error!("[sip] Registration failed: {} {}", code, reason);
                                    safe_emit(
                                        handle,
                                        "sip:status",
                                        SipStatus {
                                            status: "error".to_string(),
                                            message: Some(format!(
                                                "Registration failed: {} {}",
                                                code, reason
                                            )),
                                        },
                                    );
                                    *consecutive_failures += 1;
                                    return false;
                                }
                            }
                        }
                    }

                    *consecutive_failures += 1;
                    false
                }

                // Initial registration — its return value is NOT discarded anymore.
                // If it fails, we abort the task immediately (do_register already
                // emitted a sip:status error event).
                let local_sip_addr = match &transport {
                    // Use the transport's own address as-is so get_via can find it
                    // in the transport layer. For UDP the host will be 0.0.0.0 but
                    // the SIP server sends responses to the UDP packet's source IP.
                    SipConnection::Udp(u) => u.get_addr().clone(),
                    SipConnection::Tcp(t) => t.get_addr().clone(),
                    SipConnection::Tls(t) => t.get_addr().clone(),
                    _ => {
                        log::error!("[sip] Unsupported transport type for Via");
                        cancel_token.cancel();
                        endpoint_serve.abort();
                        return;
                    }
                };
                let registered = do_register(
                    &endpoint_inner,
                    &server_uri,
                    &from_to_uri,
                    &contact_uri,
                    &call_id,
                    &mut cseq,
                    expiry,
                    &credential,
                    &handle,
                    &connected,
                    &mut consecutive_failures,
                    &local_sip_addr,
                    &external_addr,
                )
                .await;

                if !registered {
                    log::error!("[sip] Initial registration failed — aborting task");
                    cancel_token.cancel();
                    endpoint_serve.abort();
                    return;
                }

                // After initial registration, re-register immediately with the corrected
                // public Contact header if we discovered our public IP:port from the
                // server's Via received/rport (RFC 3581 NAT traversal).
                if let Some((ref public_ip, public_port)) = *external_addr.lock().await {
                    let transport_param = match protocol.as_str() {
                        "TCP" => ";transport=tcp",
                        "TLS" => ";transport=tls",
                        _ => "",
                    };
                    let new_contact_str = format!(
                        "sip:{}@{}:{}{}",
                        config.username, public_ip, public_port, transport_param
                    );
                    if let Ok(new_contact) = Uri::try_from(new_contact_str.as_str()) {
                        log::info!(
                            "[sip] Updating Contact to public address: {}:{}",
                            public_ip,
                            public_port
                        );
                        safe_emit(
                            &handle,
                            "sip:log",
                            serde_json::json!({
                                "message": format!(
                                    "[SIP] Updating Contact to public address: {}:{}",
                                    public_ip, public_port
                                )
                            }),
                        );
                        contact_uri = new_contact;
                        let _ = do_register(
                            &endpoint_inner,
                            &server_uri,
                            &from_to_uri,
                            &contact_uri,
                            &call_id,
                            &mut cseq,
                            expiry,
                            &credential,
                            &handle,
                            &connected,
                            &mut consecutive_failures,
                            &local_sip_addr,
                            &external_addr,
                        )
                        .await;
                    }
                }

                // Main loop: re-registration + INVITE listener.
                // This loop only runs when the initial registration succeeded
                // (the !registered check above exits on failure).
                let mut heartbeat_counter = 0u64;
                loop {
                    let base_ms = refresh_ms;
                    let backoff_ms = base_ms * 2u64.pow(consecutive_failures.min(6));
                    let delay_ms = backoff_ms.min(3_600_000);

                    tokio::select! {
                        result = incoming.recv() => {
                            match result {
                                Some(mut tx) => {
                                    // DIAG: Log every incoming transaction (method + key) so we can see what
                                    // hits the Rust code even if the frontend event handler never fires.
                                    log::info!("[sip] Incoming transaction: method={:?}, key={}", tx.original.method, tx.key);
                                    safe_emit(&handle, "sip:log", serde_json::json!({
                                        "message": format!("Incoming SIP transaction: method={:?}, key={}", tx.original.method, tx.key)
                                    }));

                                    if tx.original.method == Method::Invite {
                                        safe_emit(&handle, "sip:log", serde_json::json!({
                                            "message": "Processing INVITE transaction in Rust loop"
                                        }));

                                        let (caller_number, caller_name) =
                                            extract_invite_caller(&SipMessage::Request(tx.original.clone()));

                                        safe_emit(&handle, "sip:log", serde_json::json!({
                                            "message": format!("Emitting sip:invite to frontend (caller={}, name={})", caller_number, caller_name)
                                        }));

                                        let invite_data = InviteData {
                                            caller_number,
                                            caller_name,
                                        };
                                        safe_emit(&handle, "sip:invite", invite_data);

                                    // Send 180 Ringing so the caller hears ringing while the notification is shown.
                                    // The SIP server will eventually time out the call via its ring-no-answer timer.
                                    match tx.reply(StatusCode::Ringing).await {
                                            Ok(_) => {
                                                safe_emit(&handle, "sip:log", serde_json::json!({
                                                    "message": "180 Ringing sent successfully"
                                                }));
                                            }
                                            Err(e) => {
                                                log::error!("[sip] Failed to reply to INVITE: {}", e);
                                                safe_emit(&handle, "sip:log", serde_json::json!({
                                                    "message": format!("Failed to reply to INVITE: {}", e)
                                                }));
                                            }
                                        }
                                    } else {
                                        safe_emit(&handle, "sip:log", serde_json::json!({
                                            "message": format!("Non-INVITE transaction ignored: method={:?}", tx.original.method)
                                        }));
                                    }
                                }
                                None => {
                                    log::error!("[sip] INCOMING CHANNEL CLOSED - no more transactions will be received!");
                                    safe_emit(&handle, "sip:log", serde_json::json!({
                                        "message": "INCOMING CHANNEL CLOSED - server transactions will not be received"
                                    }));
                                    break;
                                }
                            }
                        }
                        _ = tokio::time::sleep(std::time::Duration::from_millis(delay_ms)) => {
                            heartbeat_counter += 1;
                            if heartbeat_counter % 10 == 0 {
                                log::info!("[sip] Heartbeat: loop alive, registered={}, delay_ms={}", *connected.lock().await, delay_ms);
                                safe_emit(&handle, "sip:log", serde_json::json!({
                                    "message": format!("SIP loop heartbeat: registered={}, delay_ms={}", *connected.lock().await, delay_ms)
                                }));
                            }

                            if !*connected.lock().await {
                                break;
                            }

                            let still_registered = do_register(
                                &endpoint_inner,
                                &server_uri,
                                &from_to_uri,
                                &contact_uri,
                                &call_id,
                                &mut cseq,
                                expiry,
                                &credential,
                                &handle,
                                &connected,
                                &mut consecutive_failures,
                                &local_sip_addr,
                                &external_addr,
                            ).await;

                            if !still_registered {
                                safe_emit(
                                    &handle,
                                    "sip:status",
                                    SipStatus {
                                        status: "error".to_string(),
                                        message: Some("Registration refresh failed".to_string()),
                                    },
                                );
                            }
                        }
                        _ = cancel_token.cancelled() => break,
                    }
                }

                cancel_token.cancel();
                endpoint_serve.abort();
            });

            if let Err(panic) = future.catch_unwind().await {
                log::error!("[sip] connection task panicked: {:?}", panic);
            }
        });

        let mut handle = self.task_handle.lock().await;
        if let Some(prev) = handle.take() {
            prev.abort();
        }
        *handle = Some(join_handle);
    }

    pub fn disconnect(&self) {
        let connected = self.connected.clone();
        let task_handle = self.task_handle.clone();
        tokio::spawn(async move {
            *connected.lock().await = false;
            let mut handle = task_handle.lock().await;
            if let Some(h) = handle.take() {
                h.abort();
            }
        });
    }
}

#[tauri::command]
pub async fn sip_connect(
    app: AppHandle,
    config: SipConfig,
) -> Result<serde_json::Value, CommandError> {
    if !SIP_RATE_LIMITER.check("sip_connect") {
        return Err(CommandError::rate_limited());
    }
    if let Err(e) = config.validate() {
        log::error!("[sip] sip_connect: config validation failed: {}", e);
        return Err(CommandError::invalid_input(format!("Config: {}", e)));
    }
    let sip_client = match app.try_state::<SipClient>() {
        Some(c) => c,
        None => {
            log::error!("[sip] sip_connect: SipClient not registered");
            return Err(CommandError::startup("SIP client not initialized"));
        }
    };
    sip_client.start(config).await;
    Ok(serde_json::json!({"success": true}))
}

#[tauri::command]
pub async fn sip_disconnect(app: AppHandle) -> Result<serde_json::Value, CommandError> {
    if !SIP_RATE_LIMITER.check("sip_disconnect") {
        return Err(CommandError::rate_limited());
    }
    let sip_client = app.state::<SipClient>();
    sip_client.disconnect();
    app.emit(
        "sip:status",
        SipStatus {
            status: "disconnected".to_string(),
            message: None,
        },
    )
    .map_err(|e| CommandError::sip(format!("Failed to emit disconnect: {}", e)))?;
    Ok(serde_json::json!({"success": true}))
}

#[tauri::command]
pub async fn sip_test_connection(config: SipConfig) -> Result<serde_json::Value, CommandError> {
    if !SIP_RATE_LIMITER.check("sip_test_connection") {
        return Err(CommandError::rate_limited());
    }
    if config.server.trim().is_empty() {
        return Err(CommandError::invalid_input("SIP server is required"));
    }
    let server = config.server.clone();
    let protocol = config.protocol.as_deref().unwrap_or("UDP").to_uppercase();
    let port = config
        .port
        .unwrap_or(if protocol == "TLS" { 5061 } else { 5060 });

    let dns_start = std::time::Instant::now();
    let dns_result = match tokio::net::lookup_host(format!("{}:{}", server, port)).await {
        Ok(mut addrs) => match addrs.next() {
            Some(addr) => {
                let elapsed = dns_start.elapsed();
                let family = if addr.is_ipv4() { "IPv4" } else { "IPv6" };
                Ok((addr, family.to_string(), elapsed.as_millis() as u64))
            }
            None => Err(format!("No addresses found for {}:{}", server, port)),
        },
        Err(e) => Err(format!("DNS resolution failed: {}", e)),
    };

    match dns_result {
        Ok((addr, family, dns_ms)) => {
            let port_check = if protocol == "TCP" || protocol == "TLS" {
                let probe_start = std::time::Instant::now();
                match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    tokio::net::TcpStream::connect(addr),
                )
                .await
                {
                    Ok(Ok(_)) => serde_json::json!({
                        "reachable": true,
                        "latencyMs": probe_start.elapsed().as_millis(),
                        "detail": "TCP connect succeeded"
                    }),
                    Ok(Err(e)) => serde_json::json!({
                        "reachable": false,
                        "detail": format!("{}", e)
                    }),
                    Err(_) => serde_json::json!({
                        "reachable": false,
                        "detail": "TCP connect timed out after 5s"
                    }),
                }
            } else {
                // UDP is connectionless — verify we can open a local socket to send from.
                match tokio::net::UdpSocket::bind("0.0.0.0:0").await {
                    Ok(_) => serde_json::json!({
                        "reachable": "local-ok",
                        "detail": "Local UDP socket bind OK"
                    }),
                    Err(e) => serde_json::json!({
                        "reachable": false,
                        "detail": format!("UDP bind failed: {}", e)
                    }),
                }
            };
            Ok(serde_json::json!({
                "success": true,
                "server": server,
                "port": port,
                "protocol": protocol,
                "dns": { "resolved": true, "ip": addr.ip().to_string(), "family": family, "timeMs": dns_ms },
                "portCheck": port_check
            }))
        }
        Err(err_msg) => Ok(serde_json::json!({
            "success": false,
            "server": server,
            "port": port,
            "protocol": protocol,
            "dns": { "resolved": false, "error": err_msg },
            "portCheck": null
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sip_config_validation_passes_valid() {
        fn test_config(pw: &str) -> SipConfig {
            SipConfig {
                username: "user".to_string(),
                password: SecretString::from(pw),
                server: "sip.example.com".to_string(),
                port: Some(5060),
                protocol: Some("UDP".to_string()),
                auth_username: None,
                register_expiry: Some(300),
            }
        }
        assert!(test_config("pass").validate().is_ok());
    }

    #[test]
    fn test_sip_config_validation_rejects_empty_username() {
        let config = SipConfig {
            username: "".to_string(),
            password: SecretString::from("pass"),
            server: "sip.example.com".to_string(),
            port: None,
            protocol: None,
            auth_username: None,
            register_expiry: None,
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_sip_config_validation_rejects_empty_server() {
        let config = SipConfig {
            username: "user".to_string(),
            password: SecretString::from("pass"),
            server: "".to_string(),
            port: None,
            protocol: None,
            auth_username: None,
            register_expiry: None,
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_sip_config_validation_rejects_bad_protocol() {
        let config = SipConfig {
            username: "user".to_string(),
            password: SecretString::from("pass"),
            server: "sip.example.com".to_string(),
            port: None,
            protocol: Some("HTTP".to_string()),
            auth_username: None,
            register_expiry: None,
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_sip_config_validation_rejects_bad_port() {
        let config = SipConfig {
            username: "user".to_string(),
            password: SecretString::from("pass"),
            server: "sip.example.com".to_string(),
            port: Some(0),
            protocol: None,
            auth_username: None,
            register_expiry: None,
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_sip_config_validation_rejects_bad_expiry() {
        let config = SipConfig {
            username: "user".to_string(),
            password: SecretString::from("pass"),
            server: "sip.example.com".to_string(),
            port: None,
            protocol: None,
            auth_username: None,
            register_expiry: Some(99999),
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_sanitize_caller_id_strips_non_ascii() {
        let dirty = "hello\x00world\x01test";
        let clean = sanitize_caller_id(dirty);
        assert!(!clean.contains('\x00'));
        assert!(!clean.contains('\x01'));
        assert_eq!(clean, "helloworldtest");
    }

    #[test]
    fn test_sanitize_caller_id_truncates() {
        let long = "a".repeat(200);
        let clean = sanitize_caller_id(&long);
        assert_eq!(clean.len(), 128);
    }

    #[test]
    fn test_extract_invite_caller() {
        let msg: SipMessage = concat!(
            "INVITE sip:user@example.com SIP/2.0\r\n",
            "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bKtest\r\n",
            "From: \"John Doe\" <sip:1234@example.com>;tag=abc\r\n",
            "To: <sip:user@example.com>\r\n",
            "Call-ID: test@host\r\n",
            "CSeq: 1 INVITE\r\n",
            "Content-Length: 0\r\n",
            "\r\n"
        )
        .try_into()
        .unwrap();
        let (number, name) = extract_invite_caller(&msg);
        assert_eq!(number, "1234");
        assert_eq!(name, "John Doe");
    }
}
