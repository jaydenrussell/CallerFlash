use crate::pjsip::config::PjsipSipConfig;
use crate::pjsip::types::SipStatus;

const MAX_PORT: u16 = 65535;

pub enum TransportType {
    Udp,
    Tcp,
    Tls,
}

impl TransportType {
    pub fn from_protocol(protocol: &str) -> Self {
        match protocol.to_uppercase().as_str() {
            "TCP" => TransportType::Tcp,
            "TLS" => TransportType::Tls,
            _ => TransportType::Udp,
        }
    }

    pub fn pjsip_scheme(&self) -> &'static str {
        match self {
            TransportType::Udp => "udp",
            TransportType::Tcp => "tcp",
            TransportType::Tls => "tls",
        }
    }

    pub fn default_port(&self) -> u16 {
        match self {
            TransportType::Udp => 5060,
            TransportType::Tcp => 5060,
            TransportType::Tls => 5061,
        }
    }
}

fn safe_emit(handle: &tauri::AppHandle, event: &str, payload: impl serde::Serialize + Clone) {
    if let Err(e) = handle.emit(event, payload) {
        log::error!("[pjsip] Failed to emit {}: {}", event, e);
    }
}

pub fn validate_config(config: &PjsipSipConfig) -> Result<(), String> {
    if config.username.is_empty() {
        return Err("SIP username is required".to_string());
    }
    if config.username.len() > 128 {
        return Err("SIP username exceeds maximum length".to_string());
    }
    if config.server.is_empty() {
        return Err("SIP server is required".to_string());
    }
    if config.server.len() > 256 {
        return Err("SIP server address exceeds maximum length".to_string());
    }
    if let Some(port) = config.port {
        if port == 0 || port > MAX_PORT {
            return Err(format!(
                "SIP port must be between 1 and {}",
                MAX_PORT
            ));
        }
    }
    if let Some(ref protocol) = config.protocol {
        let upper = protocol.to_uppercase();
        if upper != "UDP" && upper != "TCP" && upper != "TLS" {
            return Err(format!(
                "Unsupported protocol: {}. Use UDP, TCP, or TLS",
                protocol
            ));
        }
    }
    if let Some(expiry) = config.register_expiry {
        if expiry < 30 || expiry > 86400 {
            return Err("Registration expiry must be between 30 and 86400 seconds".to_string());
        }
    }
    let pw = config.password.expose_secret();
    if pw.is_empty() {
        return Err("SIP password is required".to_string());
    }
    if pw.len() > 512 {
        return Err("SIP password exceeds maximum length".to_string());
    }
    Ok(())
}