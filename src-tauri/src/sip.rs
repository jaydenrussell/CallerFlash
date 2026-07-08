use futures_util::FutureExt;
use md5::{Digest, Md5};
use rand::Rng;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::error::CommandError;
use crate::ratelimit::SIP_RATE_LIMITER;

const MAX_CALLER_ID_LENGTH: usize = 128;
const MIN_REGISTER_EXPIRY: u32 = 30;
const MAX_REGISTER_EXPIRY: u32 = 86400;
const MIN_PORT: u16 = 1;
const SIP_INVITE_CHANNEL_SIZE: usize = 50;
const MAX_SIP_MESSAGE_SIZE: usize = 65536;

enum SipTransport {
    Udp(Arc<UdpSocket>),
    Tcp(Arc<Mutex<TcpStream>>),
    Tls(Arc<Mutex<tokio_rustls::TlsStream<TcpStream>>>),
}

impl SipTransport {
    async fn send(&self, data: &[u8], addr: std::net::SocketAddr) -> Result<(), String> {
        match self {
            Self::Udp(sock) => {
                sock.send_to(data, addr).await.map_err(|e| e.to_string())?;
            }
            Self::Tcp(stream) => {
                let mut s = stream.lock().await;
                s.write_all(data).await.map_err(|e| e.to_string())?;
            }
            Self::Tls(stream) => {
                let mut s = stream.lock().await;
                s.write_all(data).await.map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    async fn recv_message(&self) -> Result<Vec<u8>, String> {
        match self {
            Self::Udp(sock) => {
                let mut buf = vec![0u8; MAX_SIP_MESSAGE_SIZE];
                let (len, _) = sock.recv_from(&mut buf).await.map_err(|e| e.to_string())?;
                buf.truncate(len);
                Ok(buf)
            }
            Self::Tcp(stream) => {
                let mut s = stream.lock().await;
                read_sip_message(&mut *s).await
            }
            Self::Tls(stream) => {
                let mut s = stream.lock().await;
                read_sip_message(&mut *s).await
            }
        }
    }

    async fn recv_message_timeout(
        &self,
        timeout: std::time::Duration,
    ) -> Result<Vec<u8>, String> {
        tokio::time::timeout(timeout, self.recv_message())
            .await
            .map_err(|_| "Response timed out".to_string())?
    }
}

async fn read_sip_message(
    stream: &mut (impl AsyncReadExt + Unpin),
) -> Result<Vec<u8>, String> {
    let mut buf = Vec::with_capacity(4096);
    let mut header_end = None;

    loop {
        let mut tmp = [0u8; 1024];
        let n = stream.read(&mut tmp).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("Connection closed".to_string());
        }
        buf.extend_from_slice(&tmp[..n]);

        if header_end.is_none() {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = Some(pos + 4);
            }
        }

        if let Some(end) = header_end {
            let header_section = &buf[..end];
            let header_text = std::str::from_utf8(header_section).map_err(|_| "Invalid UTF-8 in SIP headers".to_string())?;

            let content_length = header_text
                .lines()
                .find(|l| l.to_uppercase().starts_with("CONTENT-LENGTH"))
                .and_then(|l| l.split(':').nth(1))
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0);

            let total = end + content_length;
            if buf.len() >= total {
                buf.truncate(total);
                return Ok(buf);
            }
        }

        if buf.len() > MAX_SIP_MESSAGE_SIZE {
            return Err("SIP message exceeds maximum size".to_string());
        }
    }
}

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
        st.serialize_field("auth_username", &self.auth_username)?;
        st.serialize_field("register_expiry", &self.register_expiry)?;
        st.end()
    }
}

impl<'de> Deserialize<'de> for SipConfig {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
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
            if port < MIN_PORT {
                return Err(CommandError::invalid_input(format!(
                    "SIP port must be at least {}",
                    MIN_PORT
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
        if self.password.expose_secret().len() > 512 {
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
pub struct InviteData {
    pub caller_number: String,
    pub caller_name: String,
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

    fn md5_hex(data: &str) -> String {
        let mut hasher = Md5::new();
        hasher.update(data.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    #[allow(clippy::too_many_arguments)]
    fn compute_digest_response(
        username: &str,
        realm: &str,
        password: &str,
        method: &str,
        uri: &str,
        nonce: &str,
        nc: &str,
        cnonce: &str,
        qop: Option<&str>,
    ) -> String {
        let ha1 = Self::md5_hex(&format!("{}:{}:{}", username, realm, password));
        let ha2 = Self::md5_hex(&format!("{}:{}", method, uri));
        match qop {
            Some(_) => Self::md5_hex(&format!(
                "{}:{}:{}:{}:{}:{}",
                ha1,
                nonce,
                nc,
                cnonce,
                qop.unwrap_or("auth"),
                ha2
            )),
            None => Self::md5_hex(&format!("{}:{}:{}", ha1, nonce, ha2)),
        }
    }

    fn parse_sip_response(data: &[u8]) -> (u16, String, HashMap<String, String>) {
        let text = String::from_utf8_lossy(data);
        let mut lines = text.lines();
        let mut status_code = 0u16;
        let mut reason = String::new();

        if let Some(status_line) = lines.next() {
            let parts: Vec<&str> = status_line.splitn(3, ' ').collect();
            if parts.len() >= 2 {
                status_code = parts[1].parse().unwrap_or(0);
                reason = parts.get(2).unwrap_or(&"").to_string();
            }
        }

        let mut headers = HashMap::new();
        for line in lines {
            let line = line.trim();
            if line.is_empty() {
                break;
            }
            if let Some(pos) = line.find(':') {
                let key = line[..pos].trim().to_string();
                let value = line[pos + 1..].trim().to_string();
                headers.insert(key, value);
            }
        }

        (status_code, reason, headers)
    }

    fn parse_www_authenticate(header: &str) -> HashMap<String, String> {
        let mut params = HashMap::new();
        let rest = header.strip_prefix("Digest ").unwrap_or(header);

        let mut in_quoted = false;
        let mut key = String::new();
        let mut value = String::new();
        let mut parsing_key = true;

        for ch in rest.chars() {
            match ch {
                '"' => in_quoted = !in_quoted,
                '=' if !in_quoted && parsing_key => {
                    parsing_key = false;
                }
                ',' | ';' if !in_quoted => {
                    if !key.is_empty() {
                        params.insert(key.trim().to_lowercase(), value.trim().to_string());
                    }
                    key.clear();
                    value.clear();
                    parsing_key = true;
                }
                ' ' if !in_quoted => {}
                ch => {
                    if parsing_key {
                        key.push(ch);
                    } else {
                        value.push(ch);
                    }
                }
            }
        }
        if !key.is_empty() {
            params.insert(key.trim().to_lowercase(), value.trim().to_string());
        }

        params
    }

    fn build_register_message(
        username: &str,
        server: &str,
        port: u16,
        local_port: u16,
        call_id: &str,
        cseq_val: u32,
        auth_header: Option<&str>,
        expires_val: u32,
        protocol: &str,
    ) -> String {
        let branch = format!("z9hG4bK{}", Uuid::new_v4().to_string().split('-').next().unwrap_or("a"));
        let tag = Uuid::new_v4().to_string().split('-').next().unwrap_or("b").to_string();
        let transport = if protocol == "TCP" { "TCP" } else if protocol == "TLS" { "TLS" } else { "UDP" };

        let mut msg = format!("REGISTER sip:{}:{} SIP/2.0\r\n", server, port);
        msg.push_str(&format!("Via: SIP/2.0/{} 127.0.0.1:{};branch={}\r\n", transport, local_port, branch));
        msg.push_str("Max-Forwards: 70\r\n");
        msg.push_str(&format!("From: <sip:{}@{}>;tag={}\r\n", username, server, tag));
        msg.push_str(&format!("To: <sip:{}@{}>\r\n", username, server));
        msg.push_str(&format!("Call-ID: {}\r\n", call_id));
        msg.push_str(&format!("CSeq: {} REGISTER\r\n", cseq_val));
        msg.push_str(&format!("Contact: <sip:{}@127.0.0.1:{}>\r\n", username, local_port));
        msg.push_str(&format!("Expires: {}\r\n", expires_val));
        msg.push_str("User-Agent: CallerFlash\r\n");
        if let Some(auth) = auth_header {
            msg.push_str(&format!("Authorization: {}\r\n", auth));
        }
        msg.push_str("Content-Length: 0\r\n");
        msg.push_str("\r\n");
        msg
    }

    fn build_invite_busy_response(
        local_port: u16,
        username: &str,
        server: &str,
    ) -> String {
        let tag_id = Uuid::new_v4().to_string();
        let tag = tag_id.split('-').next().unwrap_or("t");
        let call_id = Uuid::new_v4();

        format!(
            "SIP/2.0 486 Busy Here\r\n\
             Via: SIP/2.0/UDP 127.0.0.1:{};received=127.0.0.1\r\n\
             From: <sip:unknown@unknown>\r\n\
             To: <sip:{}@{}>;tag={}\r\n\
             Call-ID: {}\r\n\
             CSeq: 0 INVITE\r\n\
             User-Agent: CallerFlash\r\n\
             Content-Length: 0\r\n\r\n",
            local_port, username, server, tag, call_id
        )
    }

    fn sanitize_caller_id(s: &str) -> String {
        s.chars()
            .filter(|&c| c.is_ascii_graphic() || c == ' ')
            .collect::<String>()
            .chars()
            .take(MAX_CALLER_ID_LENGTH)
            .collect()
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

    fn safe_emit(handle: &AppHandle, event: &str, payload: impl serde::Serialize + Clone) {
        if let Err(e) = handle.emit(event, payload) {
            log::error!("[sip] Failed to emit {}: {}", event, e);
        }
    }

    async fn connect_transport(
        config: &SipConfig,
        server_addr: std::net::SocketAddr,
    ) -> Result<(SipTransport, u16), String> {
        let protocol = config.protocol.as_deref().unwrap_or("UDP");
        match protocol {
            "TCP" => {
                let stream = TcpStream::connect(server_addr)
                    .await
                    .map_err(|e| format!("TCP connect failed: {}", e))?;
                let local_port = stream.local_addr().map(|a| a.port()).unwrap_or(0);
                Ok((SipTransport::Tcp(Arc::new(Mutex::new(stream))), local_port))
            }
            "TLS" => {
                let stream = TcpStream::connect(server_addr)
                    .await
                    .map_err(|e| format!("TLS connect failed: {}", e))?;
                let local_port = stream.local_addr().map(|a| a.port()).unwrap_or(0);

                let cert_result = rustls_native_certs::load_native_certs();
                let mut root_store = rustls::RootCertStore::empty();
                for cert in cert_result.certs {
                    let _ = root_store.add(cert);
                }

                let config = rustls::ClientConfig::builder()
                    .with_root_certificates(root_store)
                    .with_no_client_auth();

                let tls_connector = tokio_rustls::TlsConnector::from(Arc::new(config));
                let domain = rustls_pki_types::ServerName::try_from(server_addr.ip().to_string())
                    .map_err(|e| format!("Invalid TLS server name: {}", e))?;
                let tls_stream = tls_connector
                    .connect(domain, stream)
                    .await
                    .map_err(|e| format!("TLS handshake failed: {}", e))?;

                Ok((SipTransport::Tls(Arc::new(Mutex::new(tokio_rustls::TlsStream::Client(tls_stream)))), local_port))
            }
            _ => {
                let sock = UdpSocket::bind("0.0.0.0:0")
                    .await
                    .map_err(|e| format!("Failed to bind UDP: {}", e))?;
                let local_port = sock.local_addr().map(|a| a.port()).unwrap_or(5060);
                Ok((SipTransport::Udp(Arc::new(sock)), local_port))
            }
        }
    }

    #[allow(clippy::too_many_lines)]
    pub async fn start(&self, config: SipConfig) {
        let handle = self.handle.clone();
        let connected = self.connected.clone();

        let join_handle: tokio::task::JoinHandle<()> = tokio::spawn(async move {
            let future = std::panic::AssertUnwindSafe(async move {
                let server = config.server.clone();
                let port = config.port.unwrap_or(5060);
                let protocol = config.protocol.as_deref().unwrap_or("UDP").to_string();

                let server_addr = match tokio::net::lookup_host(format!("{}:{}", server, port)).await
                {
                    Ok(mut addrs) => match addrs.next() {
                        Some(addr) => addr,
                        None => {
                            Self::safe_emit(
                                &handle,
                                "sip:status",
                                SipStatus {
                                    status: "error".to_string(),
                                    message: Some(Self::user_safe_sip_error(&format!(
                                        "No addresses found for {}:{}",
                                        server, port
                                    ))),
                                },
                            );
                            return;
                        }
                    },
                    Err(e) => {
                        Self::safe_emit(
                            &handle,
                            "sip:status",
                            SipStatus {
                                status: "error".to_string(),
                                message: Some(Self::user_safe_sip_error(&format!(
                                    "DNS resolution failed: {}",
                                    e
                                ))),
                            },
                        );
                        return;
                    }
                };

                let (transport, local_port) = match Self::connect_transport(&config, server_addr).await {
                    Ok(t) => t,
                    Err(e) => {
                        Self::safe_emit(
                            &handle,
                            "sip:status",
                            SipStatus {
                                status: "error".to_string(),
                                message: Some(Self::user_safe_sip_error(&e)),
                            },
                        );
                        return;
                    }
                };

                let transport = Arc::new(transport);

                Self::safe_emit(
                    &handle,
                    "sip:status",
                    SipStatus {
                        status: "connecting".to_string(),
                        message: Some(format!("Bound to {} port {}", protocol, local_port)),
                    },
                );

                let call_id = format!("{}@127.0.0.1", Uuid::new_v4());
                let mut cseq = 1u32;
                let expiry = config.register_expiry.unwrap_or(300);
                let auth_username = config
                    .auth_username
                    .clone()
                    .unwrap_or_else(|| config.username.clone());

                let _ = handle.emit(
                    "sip:log",
                    serde_json::json!({"message": format!("[SIP] Starting registration — server: {}:{}, expiry: {}, protocol: {}", server, port, expiry, protocol)}),
                );

                // Initial REGISTER (no auth)
                let reg_msg = Self::build_register_message(
                    &config.username,
                    &config.server,
                    port,
                    local_port,
                    &call_id,
                    cseq,
                    None,
                    expiry,
                    &protocol,
                );
                if let Err(e) = transport.send(reg_msg.as_bytes(), server_addr).await {
                    Self::safe_emit(
                        &handle,
                        "sip:status",
                        SipStatus {
                            status: "error".to_string(),
                            message: Some(Self::user_safe_sip_error(&format!(
                                "Failed to send REGISTER: {}",
                                e
                            ))),
                        },
                    );
                    return;
                }
                cseq += 1;

                // Receive initial response
                let response_data = match transport.recv_message_timeout(std::time::Duration::from_secs(10)).await {
                    Ok(data) => data,
                    Err(e) => {
                        Self::safe_emit(&handle, "sip:status", SipStatus {
                            status: "error".to_string(),
                            message: Some(Self::user_safe_sip_error(&e)),
                        });
                        return;
                    }
                };

                let (status_code, ref reason, headers) = Self::parse_sip_response(&response_data);
                let _ = handle.emit(
                    "sip:log",
                    serde_json::json!({"message": format!("[SIP] Initial REGISTER response — {} {} ({} headers)", status_code, reason.trim(), headers.len())}),
                );

                if status_code == 401 || status_code == 407 {
                    let auth_type = if status_code == 401 {
                        "WWW-Authenticate"
                    } else {
                        "Proxy-Authenticate"
                    };
                    let auth_header = headers.get(auth_type)
                        .or_else(|| headers.get(&auth_type.to_lowercase()));

                    let _ = handle.emit(
                        "sip:log",
                        serde_json::json!({"message": format!("[SIP] Received {} challenge", status_code)}),
                    );

                    if let Some(www_auth) = auth_header {
                        let params = Self::parse_www_authenticate(www_auth);
                        let realm = params.get("realm").cloned().unwrap_or_default();
                        let nonce = params.get("nonce").cloned().unwrap_or_default();
                        let qop = params.get("qop").cloned();
                        let algorithm = params
                            .get("algorithm")
                            .cloned()
                            .unwrap_or_else(|| "MD5".to_string());

                        let _ = handle.emit(
                            "sip:log",
                            serde_json::json!({"message": format!("[SIP] Digest challenge params — algorithm: {}, qop: {:?}", algorithm, qop)}),
                        );

                        if algorithm.to_uppercase() != "MD5" {
                            Self::safe_emit(
                                &handle,
                                "sip:status",
                                SipStatus {
                                    status: "error".to_string(),
                                    message: Some(format!(
                                        "Unsupported digest algorithm: {}",
                                        algorithm
                                    )),
                                },
                            );
                            return;
                        }

                        let nc = "00000001".to_string();
                        let cnonce: String = rand::thread_rng()
                            .sample_iter(&rand::distributions::Alphanumeric)
                            .take(8)
                            .map(char::from)
                            .collect();

                        let uri = format!("sip:{}:{}", config.server, port);
                        let response = Self::compute_digest_response(
                            &auth_username,
                            &realm,
                            config.password.expose_secret(),
                            "REGISTER",
                            &uri,
                            &nonce,
                            &nc,
                            &cnonce,
                            qop.as_deref(),
                        );

                        let auth_val = match &qop {
                            Some(q) => format!(
                                r#"Digest username="{}", realm="{}", nonce="{}", uri="{}", response="{}", algorithm={}, cnonce="{}", nc={}, qop={}"#,
                                auth_username,
                                realm,
                                nonce,
                                uri,
                                response,
                                algorithm,
                                cnonce,
                                nc,
                                q
                            ),
                            None => format!(
                                r#"Digest username="{}", realm="{}", nonce="{}", uri="{}", response="{}", algorithm={}"#,
                                auth_username, realm, nonce, uri, response, algorithm
                            ),
                        };

                        let _ = handle.emit(
                            "sip:log",
                            serde_json::json!({"message": format!("[SIP] Sending authenticated REGISTER to {}:{}", server, port)}),
                        );

                        let auth_reg = Self::build_register_message(
                            &config.username,
                            &config.server,
                            port,
                            local_port,
                            &call_id,
                            cseq,
                            Some(&auth_val),
                            expiry,
                            &protocol,
                        );
                        if let Err(e) = transport.send(auth_reg.as_bytes(), server_addr).await {
                            Self::safe_emit(
                                &handle,
                                "sip:status",
                                SipStatus {
                                    status: "error".to_string(),
                                    message: Some(Self::user_safe_sip_error(&format!(
                                        "Failed to send authenticated REGISTER: {}",
                                        e
                                    ))),
                                },
                            );
                            return;
                        }
                        cseq += 1;

                        let response_data = match transport.recv_message_timeout(std::time::Duration::from_secs(10)).await {
                            Ok(data) => data,
                            Err(e) => {
                                Self::safe_emit(&handle, "sip:status", SipStatus {
                                    status: "error".to_string(),
                                    message: Some(Self::user_safe_sip_error(&e)),
                                });
                                return;
                            }
                        };

                        let (status_code, ref reason, _headers) = Self::parse_sip_response(&response_data);
                        let _ = handle.emit(
                            "sip:log",
                            serde_json::json!({"message": format!("[SIP] Authenticated REGISTER response — {} {} ({} headers)", status_code, reason.trim(), _headers.len())}),
                        );
                        if (200..300).contains(&status_code) {
                            *connected.lock().await = true;
                            Self::safe_emit(
                                &handle,
                                "sip:status",
                                SipStatus {
                                    status: "registered".to_string(),
                                    message: None,
                                },
                            );
                            log::info!("[sip] Registered successfully");
                        } else {
                            let raw_response = String::from_utf8_lossy(&response_data);
                            let detail = raw_response.lines().take(10).collect::<Vec<_>>().join("\n");
                            log::error!(
                                "[sip] Registration failed: {} {} — full response:\n{}",
                                status_code,
                                reason.trim(),
                                detail
                            );
                            Self::safe_emit(
                                &handle,
                                "sip:status",
                                SipStatus {
                                    status: "error".to_string(),
                                    message: Some(format!(
                                        "Registration failed: {} {}",
                                        status_code,
                                        reason.trim()
                                    )),
                                },
                            );
                            return;
                        }
                    } else {
                        Self::safe_emit(
                            &handle,
                            "sip:status",
                            SipStatus {
                                status: "error".to_string(),
                                message: Some("No authentication header received".to_string()),
                            },
                        );
                        return;
                    }
                } else if (200..300).contains(&status_code) {
                    *connected.lock().await = true;
                    Self::safe_emit(
                        &handle,
                        "sip:status",
                        SipStatus {
                            status: "registered".to_string(),
                            message: None,
                        },
                    );
                    log::info!("[sip] Registered successfully (no auth)");
                } else {
                    let raw = String::from_utf8_lossy(&response_data);
                    let first_line = raw.lines().next().unwrap_or("unknown");
                    let detail = raw.lines().take(10).collect::<Vec<_>>().join("\n");
                    log::error!(
                        "[sip] Initial REGISTER failed: {} — full response:\n{}",
                        first_line,
                        detail
                    );
                    let _ = handle.emit(
                        "sip:log",
                        serde_json::json!({"message": format!("[SIP] Initial REGISTER failed: {} — response:\n{}", first_line, detail)}),
                    );
                    Self::safe_emit(
                        &handle,
                        "sip:status",
                        SipStatus {
                            status: "error".to_string(),
                            message: Some(format!(
                                "Registration failed: {} {}",
                                status_code, first_line
                            )),
                        },
                    );
                    return;
                }

                // Re-registration loop (periodic REGISTER refresh)
                let refresh_ms = std::cmp::max((expiry as u64).saturating_sub(15) * 1000, 30_000);
                let transport_for_reregister = transport.clone();
                let connected_for_reregister = connected.clone();
                let config_clone = config.clone();
                let call_id_clone = call_id.clone();
                let protocol_clone = protocol.clone();

                let _reregister_handle = tokio::spawn(async move {
                    let mut consecutive_failures = 0u32;
                    loop {
                        let base_ms = refresh_ms;
                        let backoff_ms = base_ms * 2u64.pow(consecutive_failures.min(6));
                        let delay_ms = backoff_ms.min(3_600_000);
                        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                        if !*connected_for_reregister.lock().await {
                            break;
                        }

                        let reg_msg = Self::build_register_message(
                            &config_clone.username,
                            &config_clone.server,
                            port,
                            local_port,
                            &call_id_clone,
                            cseq,
                            None,
                            expiry,
                            &protocol_clone,
                        );
                        cseq += 1;

                        if let Err(e) = transport_for_reregister.send(reg_msg.as_bytes(), server_addr).await {
                            consecutive_failures += 1;
                            log::error!(
                                "[sip] Re-register send error: {} (failure #{})",
                                e,
                                consecutive_failures
                            );
                        } else {
                            consecutive_failures = 0;
                        }
                    }
                });

                // INVITE listener loop
                let (invite_tx, mut invite_rx) =
                    tokio::sync::mpsc::channel::<InviteData>(SIP_INVITE_CHANNEL_SIZE);
                let handle_for_dispatch = handle.clone();
                let _dispatch_task = tokio::spawn(async move {
                    while let Some(invite) = invite_rx.recv().await {
                        Self::safe_emit(&handle_for_dispatch, "sip:invite", invite);
                    }
                });

                loop {
                    let response_data = match transport.recv_message_timeout(std::time::Duration::from_secs(30)).await {
                        Ok(data) => data,
                        Err(_) => {
                            if !*connected.lock().await {
                                break;
                            }
                            continue;
                        }
                    };

                    let text = String::from_utf8_lossy(&response_data);
                    if text.starts_with("INVITE ") {
                        let mut caller_number = "Unknown".to_string();
                        let mut caller_name = String::new();

                        for line in text.lines() {
                            if line.starts_with("From:") || line.starts_with("f:") {
                                let from_val = &line[line.find(':').unwrap_or(0) + 1..];
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
                                break;
                            }
                        }

                        caller_number = Self::sanitize_caller_id(&caller_number);
                        caller_name = Self::sanitize_caller_id(&caller_name);

                        if invite_tx
                            .try_send(InviteData {
                                caller_number,
                                caller_name,
                            })
                            .is_err()
                        {
                            log::warn!("[sip] Dropping INVITE — event channel full");
                        }

                        let resp = Self::build_invite_busy_response(local_port, &config.username, &config.server);
                        let _ = transport.send(resp.as_bytes(), server_addr).await;
                    }
                }
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
    config.validate()?;
    let sip_client = app.state::<SipClient>();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_md5_hex() {
        assert_eq!(SipClient::md5_hex(""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(
            SipClient::md5_hex("hello"),
            "5d41402abc4b2a76b9719d911017c592"
        );
    }

    #[test]
    fn test_compute_digest_response() {
        let resp = SipClient::compute_digest_response(
            "Mufasa",
            "testrealm@host.com",
            "Circle Of Life",
            "GET",
            "/dir/index.html",
            "dcd98b7102dd2f0e8b11d0f600bfb0c093",
            "00000001",
            "0a4f113b",
            Some("auth"),
        );
        assert_eq!(resp, "6629fae49393a05397450978507c4ef1");
    }

    #[test]
    fn test_compute_digest_response_no_qop() {
        let resp = SipClient::compute_digest_response(
            "Mufasa",
            "testrealm@host.com",
            "Circle Of Life",
            "GET",
            "/dir/index.html",
            "dcd98b7102dd2f0e8b11d0f600bfb0c093",
            "00000001",
            "0a4f113b",
            None,
        );
        assert_eq!(resp, "670fd8c2df070c60b045671b8b24ff02");
    }

    #[test]
    fn test_parse_sip_response() {
        let data = b"SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n";
        let (code, reason, headers) = SipClient::parse_sip_response(data);
        assert_eq!(code, 200);
        assert_eq!(reason, "OK");
        assert_eq!(headers.get("Content-Length").map(|s| s.as_str()), Some("0"));
    }

    #[test]
    fn test_parse_www_authenticate() {
        let header = r#"Digest realm="sip.example.com", nonce="abc123", algorithm=MD5, qop="auth""#;
        let params = SipClient::parse_www_authenticate(header);
        assert_eq!(
            params.get("realm").map(|s| s.as_str()),
            Some("sip.example.com")
        );
        assert_eq!(params.get("nonce").map(|s| s.as_str()), Some("abc123"));
        assert_eq!(params.get("algorithm").map(|s| s.as_str()), Some("MD5"));
        assert_eq!(params.get("qop").map(|s| s.as_str()), Some("auth"));
    }

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
        let clean = SipClient::sanitize_caller_id(dirty);
        assert!(!clean.contains('\x00'));
        assert!(!clean.contains('\x01'));
        assert_eq!(clean, "helloworldtest");
    }

    #[test]
    fn test_sanitize_caller_id_truncates() {
        let long = "a".repeat(200);
        let clean = SipClient::sanitize_caller_id(&long);
        assert_eq!(clean.len(), 128);
    }

    #[test]
    fn test_build_register_message() {
        let msg = SipClient::build_register_message(
            "alice",
            "sip.example.com",
            5060,
            12345,
            "abc@127.0.0.1",
            1,
            None,
            300,
            "UDP",
        );
        assert!(msg.starts_with("REGISTER sip:sip.example.com:5060 SIP/2.0\r\n"));
        assert!(msg.contains("Via: SIP/2.0/UDP 127.0.0.1:12345;branch="));
        assert!(msg.contains("From: <sip:alice@sip.example.com>;tag="));
        assert!(msg.contains("To: <sip:alice@sip.example.com>"));
        assert!(msg.contains("Call-ID: abc@127.0.0.1"));
        assert!(msg.contains("CSeq: 1 REGISTER"));
        assert!(msg.contains("Contact: <sip:alice@127.0.0.1:12345>"));
        assert!(msg.contains("Expires: 300"));
        assert!(msg.contains("User-Agent: CallerFlash"));
        assert!(msg.contains("Content-Length: 0"));
        assert!(!msg.contains("Authorization:"));
    }

    #[test]
    fn test_build_register_message_with_auth() {
        let msg = SipClient::build_register_message(
            "alice",
            "sip.example.com",
            5060,
            12345,
            "abc@127.0.0.1",
            2,
            Some(r#"Digest username="alice", realm="sip.example.com""#),
            300,
            "UDP",
        );
        assert!(msg.contains("Authorization:"));
        assert!(msg.contains(r#"Digest username="alice""#));
    }

    #[test]
    fn test_build_invite_busy_response() {
        let resp = SipClient::build_invite_busy_response(12345, "alice", "sip.example.com");
        assert!(resp.starts_with("SIP/2.0 486 Busy Here\r\n"));
        assert!(resp.contains("To: <sip:alice@sip.example.com>;tag="));
    }
}
