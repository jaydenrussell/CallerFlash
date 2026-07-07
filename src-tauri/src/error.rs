use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
    pub message: String,
    #[serde(skip)]
    pub kind: ErrorKind,
}

#[derive(Debug, Clone)]
pub enum ErrorKind {
    NotFound,
    PermissionDenied,
    InvalidInput(String),
    ConfigError(String),
    Io(String),
    Crypto(String),
    Sip(String),
    Startup(String),
    Unknown(String),
}

impl fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ErrorKind::NotFound => write!(f, "Not found"),
            ErrorKind::PermissionDenied => write!(f, "Permission denied"),
            ErrorKind::InvalidInput(detail) => write!(f, "Invalid input: {}", detail),
            ErrorKind::ConfigError(detail) => write!(f, "Configuration error: {}", detail),
            ErrorKind::Io(detail) => write!(f, "IO error: {}", detail),
            ErrorKind::Crypto(detail) => write!(f, "Crypto error: {}", detail),
            ErrorKind::Sip(detail) => write!(f, "SIP error: {}", detail),
            ErrorKind::Startup(detail) => write!(f, "Startup error: {}", detail),
            ErrorKind::Unknown(detail) => write!(f, "{}", detail),
        }
    }
}

impl CommandError {
    pub fn new(message: impl Into<String>, kind: ErrorKind) -> Self {
        Self {
            message: message.into(),
            kind,
        }
    }

    pub fn invalid_input(detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self {
            message: detail.clone(),
            kind: ErrorKind::InvalidInput(detail),
        }
    }

    pub fn config(detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self {
            message: detail.clone(),
            kind: ErrorKind::ConfigError(detail),
        }
    }

    pub fn io(detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self {
            message: "A filesystem error occurred".to_string(),
            kind: ErrorKind::Io(detail),
        }
    }

    pub fn crypto(detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self {
            message: "A secure storage error occurred".to_string(),
            kind: ErrorKind::Crypto(detail),
        }
    }

    pub fn sip(detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self {
            message: detail.clone(),
            kind: ErrorKind::Sip(detail),
        }
    }

    pub fn startup(detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self {
            message: detail.clone(),
            kind: ErrorKind::Startup(detail),
        }
    }

    pub fn unknown(detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self {
            message: "An unexpected error occurred".to_string(),
            kind: ErrorKind::Unknown(detail),
        }
    }

    pub fn user_safe(&self) -> &str {
        match &self.kind {
            ErrorKind::Io(_) => "A filesystem error occurred. Check logs for details.",
            ErrorKind::Crypto(_) => "A secure storage error occurred. Check logs for details.",
            ErrorKind::NotFound => "Requested resource was not found.",
            ErrorKind::PermissionDenied => "Permission denied.",
            ErrorKind::InvalidInput(_) => &self.message,
            ErrorKind::ConfigError(_) => &self.message,
            ErrorKind::Sip(_) => &self.message,
            ErrorKind::Startup(_) => &self.message,
            ErrorKind::Unknown(_) => "An unexpected error occurred.",
        }
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.user_safe())
    }
}

impl std::error::Error for CommandError {}

impl From<std::io::Error> for CommandError {
    fn from(e: std::io::Error) -> Self {
        CommandError::io(e.to_string())
    }
}

impl From<serde_json::Error> for CommandError {
    fn from(e: serde_json::Error) -> Self {
        CommandError::config(format!("JSON error: {}", e))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StartupCheck {
    pub name: String,
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartupReport {
    pub checks: Vec<StartupCheck>,
    pub all_ok: bool,
    pub os_name: String,
    pub os_version: String,
    pub is_windows_11: bool,
    pub edition: String,
}
