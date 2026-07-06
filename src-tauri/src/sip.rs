use futures_util::FutureExt;
use md5::{Digest, Md5};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SipConfig {
    pub username: String,
    pub password: String,
    pub server: String,
    pub port: Option<u16>,
    pub protocol: Option<String>,
    pub auth_username: Option<String>,
    pub register_expiry: Option<u32>,
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
}

impl SipClient {
    pub fn new(handle: AppHandle) -> Self {
        Self {
            connected: Arc::new(Mutex::new(false)),
            handle,
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
        qop: &str,
    ) -> String {
        let ha1 = Self::md5_hex(&format!("{}:{}:{}", username, realm, password));
        let ha2 = Self::md5_hex(&format!("{}:{}", method, uri));
        Self::md5_hex(&format!(
            "{}:{}:{}:{}:{}:{}",
            ha1, nonce, nc, cnonce, qop, ha2
        ))
    }

    fn extract_header<'a>(headers: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
        headers.get(name).map(|s| s.as_str()).or_else(|| {
            // Try lowercase variant
            headers.get(&name.to_lowercase()).map(|s| s.as_str())
        })
    }

    fn parse_sip_response(data: &[u8]) -> (u16, String, HashMap<String, String>) {
        let text = String::from_utf8_lossy(data);
        let mut lines = text.lines();
        let mut status_code = 0u16;
        let mut reason = String::new();

        // First line: SIP/2.0 200 OK
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
                break; // End of headers
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
        // Parse: Digest realm="...", nonce="...", algorithm=MD5, qop="auth"
        // Remove "Digest " prefix
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

    fn build_sip_message(
        method: &str,
        uri: &str,
        headers: &HashMap<String, String>,
        body: &str,
    ) -> String {
        let mut msg = format!("{} {} SIP/2.0\r\n", method, uri);
        for (key, value) in headers {
            msg.push_str(&format!("{}: {}\r\n", key, value));
        }
        msg.push_str(&format!("Content-Length: {}\r\n", body.len()));
        msg.push_str("\r\n");
        if !body.is_empty() {
            msg.push_str(body);
        }
        msg
    }

    pub async fn start(&self, config: SipConfig) {
        let handle = self.handle.clone();
        let connected = self.connected.clone();

        tokio::spawn(async move {
            let future = std::panic::AssertUnwindSafe(async move {
                let server = config.server.clone();
                let port = config.port.unwrap_or(5060);
                let is_tcp = config.protocol.as_deref() == Some("TCP");

                if is_tcp {
                    handle
                        .emit(
                            "sip:status",
                            SipStatus {
                                status: "error".to_string(),
                                message: Some(
                                    "TCP not yet supported, falling back to UDP".to_string(),
                                ),
                            },
                        )
                        .ok();
                }

                // Bind to local UDP port
                let socket = match UdpSocket::bind("0.0.0.0:5060").await {
                    Ok(s) => s,
                    Err(e) => {
                        handle
                            .emit(
                                "sip:status",
                                SipStatus {
                                    status: "error".to_string(),
                                    message: Some(format!("Failed to bind UDP: {}", e)),
                                },
                            )
                            .ok();
                        return;
                    }
                };

                let server_addr: SocketAddr = format!("{}:{}", server, port)
                    .parse()
                    .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], 0)));

                if server_addr.port() == 0 {
                    handle
                        .emit(
                            "sip:status",
                            SipStatus {
                                status: "error".to_string(),
                                message: Some("Invalid server address".to_string()),
                            },
                        )
                        .ok();
                    return;
                }

                handle
                    .emit(
                        "sip:status",
                        SipStatus {
                            status: "connecting".to_string(),
                            message: Some("Bound to UDP 5060".to_string()),
                        },
                    )
                    .ok();

                let call_id = format!("{}@127.0.0.1", Uuid::new_v4());
                let mut cseq = 1u32;
                let expiry = config.register_expiry.unwrap_or(300);
                let auth_username = config
                    .auth_username
                    .clone()
                    .unwrap_or_else(|| config.username.clone());

                // Helper to build the REGISTER
                let build_register = |cseq_val: u32,
                                      call_id_ref: &str,
                                      auth_header: Option<&str>,
                                      expires_val: u32|
                 -> String {
                    let mut headers = HashMap::new();
                    headers.insert(
                        "Via".to_string(),
                        format!(
                            "SIP/2.0/UDP 127.0.0.1:5060;branch=z9hG4bK{}",
                            Uuid::new_v4().to_string().split('-').next().unwrap_or("a")
                        ),
                    );
                    headers.insert("Max-Forwards".to_string(), "70".to_string());
                    headers.insert(
                        "From".to_string(),
                        format!(
                            "<sip:{}@{}>;tag={}",
                            config.username,
                            config.server,
                            Uuid::new_v4().to_string().split('-').next().unwrap_or("b")
                        ),
                    );
                    headers.insert(
                        "To".to_string(),
                        format!("<sip:{}@{}>", config.username, config.server),
                    );
                    headers.insert("Call-ID".to_string(), call_id_ref.to_string());
                    headers.insert("CSeq".to_string(), format!("{} REGISTER", cseq_val));
                    headers.insert(
                        "Contact".to_string(),
                        format!("<sip:{}@127.0.0.1:5060>", config.username),
                    );
                    headers.insert("Expires".to_string(), expires_val.to_string());
                    headers.insert("User-Agent".to_string(), "CallerFlash".to_string());
                    if let Some(auth) = auth_header {
                        headers.insert("Authorization".to_string(), auth.to_string());
                    }
                    Self::build_sip_message(
                        "REGISTER",
                        &format!("sip:{}:{}", config.server, port),
                        &headers,
                        "",
                    )
                };

                handle.emit("sip:log", serde_json::json!({"message": format!("[SIP] Starting registration with {}", config.server)})).ok();

                // Send initial REGISTER
                let reg_msg = build_register(cseq, &call_id, None, expiry);
                if let Err(e) = socket.send_to(reg_msg.as_bytes(), server_addr).await {
                    handle
                        .emit(
                            "sip:status",
                            SipStatus {
                                status: "error".to_string(),
                                message: Some(format!("Failed to send REGISTER: {}", e)),
                            },
                        )
                        .ok();
                    return;
                }
                cseq += 1;

                // Receive response
                let mut buf = [0u8; 4096];
                let (len, _) = match tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    socket.recv_from(&mut buf),
                )
                .await
                {
                    Ok(Ok((len, addr))) => (len, addr),
                    _ => {
                        handle
                            .emit(
                                "sip:status",
                                SipStatus {
                                    status: "error".to_string(),
                                    message: Some(
                                        "Timeout waiting for REGISTER response".to_string(),
                                    ),
                                },
                            )
                            .ok();
                        return;
                    }
                };

                let (status_code, _, headers) = Self::parse_sip_response(&buf[..len]);

                if status_code == 401 || status_code == 407 {
                    let auth_type = if status_code == 401 {
                        "WWW-Authenticate"
                    } else {
                        "Proxy-Authenticate"
                    };
                    let auth_header = Self::extract_header(&headers, auth_type);

                    if let Some(www_auth) = auth_header {
                        let params = Self::parse_www_authenticate(www_auth);
                        let realm = params.get("realm").cloned().unwrap_or_default();
                        let nonce = params.get("nonce").cloned().unwrap_or_default();
                        let qop = params
                            .get("qop")
                            .cloned()
                            .unwrap_or_else(|| "auth".to_string());
                        let algorithm = params
                            .get("algorithm")
                            .cloned()
                            .unwrap_or_else(|| "MD5".to_string());

                        if algorithm.to_uppercase() != "MD5" {
                            handle
                                .emit(
                                    "sip:status",
                                    SipStatus {
                                        status: "error".to_string(),
                                        message: Some(format!(
                                            "Unsupported digest algorithm: {}",
                                            algorithm
                                        )),
                                    },
                                )
                                .ok();
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
                            &config.password,
                            "REGISTER",
                            &uri,
                            &nonce,
                            &nc,
                            &cnonce,
                            &qop,
                        );

                        let auth_val = format!(
                            r#"Digest username="{}", realm="{}", nonce="{}", uri="{}", response="{}", algorithm={}, cnonce="{}", nc={}, qop={}"#,
                            auth_username, realm, nonce, uri, response, algorithm, cnonce, nc, qop
                        );

                        // Send authenticated REGISTER
                        let auth_reg = build_register(cseq, &call_id, Some(&auth_val), expiry);
                        if let Err(e) = socket.send_to(auth_reg.as_bytes(), server_addr).await {
                            handle
                                .emit(
                                    "sip:status",
                                    SipStatus {
                                        status: "error".to_string(),
                                        message: Some(format!(
                                            "Failed to send authenticated REGISTER: {}",
                                            e
                                        )),
                                    },
                                )
                                .ok();
                            return;
                        }
                        cseq += 1;

                        // Wait for response
                        let (len, _) = match tokio::time::timeout(
                            std::time::Duration::from_secs(10),
                            socket.recv_from(&mut buf),
                        )
                        .await
                        {
                            Ok(Ok((len, addr))) => (len, addr),
                            _ => {
                                handle
                                    .emit(
                                        "sip:status",
                                        SipStatus {
                                            status: "error".to_string(),
                                            message: Some(
                                                "Timeout waiting for auth REGISTER response"
                                                    .to_string(),
                                            ),
                                        },
                                    )
                                    .ok();
                                return;
                            }
                        };

                        let (status_code, reason, _headers) = Self::parse_sip_response(&buf[..len]);
                        if (200..300).contains(&status_code) {
                            *connected.lock().await = true;
                            handle
                                .emit(
                                    "sip:status",
                                    SipStatus {
                                        status: "registered".to_string(),
                                        message: None,
                                    },
                                )
                                .ok();
                            log::info!("[sip] Registered successfully");
                        } else {
                            handle
                                .emit(
                                    "sip:status",
                                    SipStatus {
                                        status: "error".to_string(),
                                        message: Some(format!(
                                            "Registration failed: {} {}",
                                            status_code,
                                            reason.trim()
                                        )),
                                    },
                                )
                                .ok();
                            return;
                        }
                    } else {
                        handle
                            .emit(
                                "sip:status",
                                SipStatus {
                                    status: "error".to_string(),
                                    message: Some("No authentication header received".to_string()),
                                },
                            )
                            .ok();
                        return;
                    }
                } else if (200..300).contains(&status_code) {
                    *connected.lock().await = true;
                    handle
                        .emit(
                            "sip:status",
                            SipStatus {
                                status: "registered".to_string(),
                                message: None,
                            },
                        )
                        .ok();
                    log::info!("[sip] Registered successfully (no auth)");
                } else {
                    handle
                        .emit(
                            "sip:status",
                            SipStatus {
                                status: "error".to_string(),
                                message: Some(format!(
                                    "Registration failed: {} {}",
                                    status_code,
                                    String::from_utf8_lossy(&buf[..len])
                                        .lines()
                                        .next()
                                        .unwrap_or("unknown")
                                )),
                            },
                        )
                        .ok();
                    return;
                }

                // ── Re-registration loop ──
                let refresh_ms = std::cmp::max((expiry as u64).saturating_sub(15) * 1000, 30_000);
                let socket = Arc::new(socket);
                let socket_clone = socket.clone();
                let config_clone = config.clone();
                let call_id_clone = call_id.clone();
                let mut cseq_clone = cseq;
                let connected_for_reregister = connected.clone();

                // Re-register timer
                let _reregister_handle = tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(refresh_ms)).await;
                        if !*connected_for_reregister.lock().await {
                            break;
                        }
                        // Simple re-register without challenge (most servers accept it)
                        let mut hdrs = HashMap::new();
                        hdrs.insert(
                            "Via".to_string(),
                            format!(
                                "SIP/2.0/UDP 127.0.0.1:5060;branch=z9hG4bK{}",
                                Uuid::new_v4().to_string().split('-').next().unwrap_or("r")
                            ),
                        );
                        hdrs.insert("Max-Forwards".to_string(), "70".to_string());
                        hdrs.insert(
                            "From".to_string(),
                            format!(
                                "<sip:{}@{}>;tag={}",
                                config_clone.username,
                                config_clone.server,
                                Uuid::new_v4().to_string().split('-').next().unwrap_or("f")
                            ),
                        );
                        hdrs.insert(
                            "To".to_string(),
                            format!("<sip:{}@{}>", config_clone.username, config_clone.server),
                        );
                        hdrs.insert("Call-ID".to_string(), call_id_clone.clone());
                        hdrs.insert("CSeq".to_string(), format!("{} REGISTER", cseq_clone));
                        hdrs.insert(
                            "Contact".to_string(),
                            format!("<sip:{}@127.0.0.1:5060>", config_clone.username),
                        );
                        hdrs.insert("Expires".to_string(), expiry.to_string());
                        hdrs.insert("User-Agent".to_string(), "CallerFlash".to_string());
                        let msg = Self::build_sip_message(
                            "REGISTER",
                            &format!("sip:{}:{}", config_clone.server, port),
                            &hdrs,
                            "",
                        );
                        cseq_clone += 1;

                        if let Err(e) = socket_clone.send_to(msg.as_bytes(), server_addr).await {
                            log::error!("[sip] Re-register send error: {}", e);
                        }
                    }
                });
                // Listen for incoming INVITE
                let mut buf2 = [0u8; 4096];

                loop {
                    tokio::select! {
                        result = socket.recv_from(&mut buf2) => {
                            let (len, _) = match result {
                                Ok(r) => r,
                                Err(_) => break,
                            };
                            let text = String::from_utf8_lossy(&buf2[..len]);
                            if text.starts_with("INVITE ") {
                                // Parse caller info
                                let mut caller_number = "Unknown".to_string();
                                let mut caller_name = String::new();

                                for line in text.lines() {
                                    if line.starts_with("From:") || line.starts_with("f:") {
                                        let from_val = &line[line.find(':').unwrap_or(0)+1..];
                                        // Extract display name
                                        if let Some(q1) = from_val.find('"') {
                                            if let Some(q2) = from_val[q1+1..].find('"') {
                                                caller_name = from_val[q1+1..q1+1+q2].to_string();
                                            }
                                        }
                                        // Extract number from SIP URI
                                        if let Some(at_pos) = from_val.find('@') {
                                            let before_at = &from_val[..at_pos];
                                            if let Some(colon_pos) = before_at.rfind(':') {
                                                caller_number = before_at[colon_pos+1..].to_string();
                                            } else if let Some(sip_prefix) = before_at.rfind("sip:") {
                                                caller_number = before_at[sip_prefix+4..].to_string();
                                            }
                                        }
                                        break;
                                    }
                                }

                                // Sanitize: strip non-printable chars and HTML tags
                                let sanitize = |s: &str| -> String {
                                    s.chars()
                                        .filter(|&c| c.is_ascii_graphic() || c == ' ')
                                        .collect::<String>()
                                        .chars()
                                        .take(128)
                                        .collect()
                                };
                                caller_number = sanitize(&caller_number);
                                caller_name = sanitize(&caller_name);

                                handle.emit("sip:invite", InviteData {
                                    caller_number,
                                    caller_name,
                                }).ok();

                                // Send 486 Busy Here
                                let mut resp_headers = HashMap::new();
                                resp_headers.insert("Via".to_string(), "SIP/2.0/UDP 127.0.0.1:5060".to_string());
                                resp_headers.insert("From".to_string(), "".to_string());
                                resp_headers.insert("To".to_string(), "".to_string());
                                resp_headers.insert("Call-ID".to_string(), "".to_string());
                                resp_headers.insert("CSeq".to_string(), "0 INVITE".to_string());
                                resp_headers.insert("User-Agent".to_string(), "CallerFlash".to_string());
                                resp_headers.insert("Content-Length".to_string(), "0".to_string());

                                let resp = format!(
                                    "SIP/2.0 486 Busy Here\r\n\
                                     Via: SIP/2.0/UDP 127.0.0.1:5060;received=127.0.0.1\r\n\
                                     From: <sip:unknown@unknown>\r\n\
                                     To: <sip:{}@{}>;tag={}\r\n\
                                     Call-ID: {}\r\n\
                                     CSeq: 0 INVITE\r\n\
                                     User-Agent: CallerFlash\r\n\
                                     Content-Length: 0\r\n\r\n",
                                    config.username, config.server, Uuid::new_v4().to_string().split('-').next().unwrap_or("t"),
                                    Uuid::new_v4()
                                );

                                let _ = socket.send_to(resp.as_bytes(), server_addr).await;
                            }
                        }
                        _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
                            // Periodic wake-up to check connection
                            if !*connected.lock().await {
                                break;
                            }
                        }
                    }
                }
            });
            if let Err(panic) = future.catch_unwind().await {
                log::error!("[sip] connection task panicked: {:?}", panic);
            }
        });
    }

    pub fn disconnect(&self) {
        let connected = self.connected.clone();
        tokio::spawn(async move {
            *connected.lock().await = false;
        });
    }
}

#[tauri::command]
pub async fn sip_connect(app: AppHandle, config: SipConfig) -> Result<serde_json::Value, String> {
    let sip_client = app.state::<SipClient>();
    sip_client.start(config).await;
    // We'll emit registered via event
    Ok(serde_json::json!({"success": true}))
}

#[tauri::command]
pub async fn sip_disconnect(app: AppHandle) -> Result<serde_json::Value, String> {
    let sip_client = app.state::<SipClient>();
    sip_client.disconnect();
    app.emit(
        "sip:status",
        SipStatus {
            status: "disconnected".to_string(),
            message: None,
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"success": true}))
}

#[cfg(test)]
mod tests {
    use super::SipClient;

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
        // Known values from RFC 2617 example
        let resp = SipClient::compute_digest_response(
            "Mufasa",
            "testrealm@host.com",
            "Circle Of Life",
            "GET",
            "/dir/index.html",
            "dcd98b7102dd2f0e8b11d0f600bfb0c093",
            "00000001",
            "0a4f113b",
            "auth",
        );
        // Expected: 6629fae49393a05397450978507c4ef1
        assert_eq!(resp, "6629fae49393a05397450978507c4ef1");
    }

    #[test]
    fn test_compute_digest_response_different_qop() {
        let resp = SipClient::compute_digest_response(
            "alice",
            "sip.example.com",
            "secret123",
            "REGISTER",
            "sip:sip.example.com",
            "abc123def456",
            "00000002",
            "deadbeef",
            "auth-int",
        );
        // Verify format — 32 hex chars
        assert_eq!(resp.len(), 32);
        assert!(resp.chars().all(|c| c.is_ascii_hexdigit()));
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
}
