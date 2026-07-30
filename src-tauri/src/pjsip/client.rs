use pjsua_rust::{PjsuaApp, SipEvent, AccountId, CallId, TransportType, PjsuaConfig, AccountConfig, SrtpMode, CallState};
use crate::pjsip::config::{PjsipSipConfig, RegistrationConfig};
use crate::pjsip::account::{emit_incoming_call_event, emit_registration_event};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

const DEFAULT_REG_EXPIRY: u32 = 300;

pub struct PjsipClient {
    pub handle: AppHandle,
    pub config: Arc<Mutex<Option<PjsipSipConfig>>>,
    pub connected: Arc<AtomicBool>,
    pub account_id: Arc<Mutex<Option<AccountId>>>,
    pub app: Arc<Mutex<Option<PjsuaApp>>>,
    pub should_stop: Arc<AtomicBool>,
    pub consecutive_failures: Arc<AtomicU32>,
    pub reg_config: RegistrationConfig,
    pub task_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

pub type PjsipResult<T> = Result<T, String>;

impl PjsipClient {
    pub fn new(handle: AppHandle) -> Self {
        Self {
            handle,
            config: Arc::new(Mutex::new(None)),
            connected: Arc::new(AtomicBool::new(false)),
            account_id: Arc::new(Mutex::new(None)),
            app: Arc::new(Mutex::new(None)),
            should_stop: Arc::new(AtomicBool::new(false)),
            consecutive_failures: Arc::new(AtomicU32::new(0)),
            reg_config: RegistrationConfig::default(),
            task_handle: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn connect(&self, sip_config: PjsipSipConfig) -> PjsipResult<()> {
        if let Err(e) = crate::pjsip::transport::validate_config(&sip_config) {
            return Err(e);
        }

        let server = sip_config.server.clone();
        let protocol = sip_config.protocol.as_deref().unwrap_or("UDP");
        let port = sip_config.port.unwrap_or(
            if protocol.eq_ignore_ascii_case("TLS") { 5061 } else { 5060 }
        );

        {
            let mut cfg = self.config.lock().await;
            *cfg = Some(sip_config.clone());
        }

        self.disconnect().await?;

        self.should_stop.store(false, Ordering::SeqCst);

        let handle = self.handle.clone();
        let connected = self.connected.clone();
        let account_id = self.account_id.clone();
        let consecutive_failures = self.consecutive_failures.clone();
        let reg_config = self.reg_config.clone();
        let app_ref = self.app.clone();
        let should_stop = self.should_stop.clone();

        let join_handle = tokio::spawn(async move {
            let result = Self::run_registration_loop(
                handle,
                sip_config,
                server,
                protocol.to_string(),
                port,
                connected,
                account_id,
                consecutive_failures,
                reg_config,
                app_ref,
                should_stop,
            ).await;

            if let Err(e) = result {
                log::error!("[pjsip] Registration loop error: {}", e);
            }
        });

        {
            let mut th = self.task_handle.lock().await;
            *th = Some(join_handle);
        }

        Ok(())
    }

    async fn run_registration_loop(
        handle: AppHandle,
        sip_config: PjsipSipConfig,
        server: String,
        protocol: String,
        port: u16,
        connected: Arc<AtomicBool>,
        account_id: Arc<Mutex<Option<AccountId>>>,
        consecutive_failures: Arc<AtomicU32>,
        reg_config: RegistrationConfig,
        app_ref: Arc<Mutex<Option<PjsuaApp>>>,
        should_stop: Arc<AtomicBool>,
    ) -> PjsipResult<()> {
        let pjsua_config = PjsuaConfig {
            log_level: 3,
            clock_rate: 16000,
            null_audio: true,
            user_agent: Some("CallerFlash/1.0".to_string()),
            nameservers: vec![],
        };

        let (app, rx) = PjsuaApp::new(pjsua_config)
            .map_err(|e| format!("PjsuaApp init failed: {}", e))?;

        {
            let mut app_guard = app_ref.lock().await;
            *app_guard = Some(app);
        }

        let transport_type = match protocol.to_uppercase().as_str() {
            "TCP" => TransportType::Tcp,
            "TLS" => TransportType::Tls,
            _ => TransportType::Udp,
        };

        let _transport_id = {
            let app_guard = app_ref.lock().await;
            let app = app_guard.as_ref().ok_or("PjsuaApp not initialized")?;
            app.create_transport(
                transport_type,
                None,
                port,
                None,
                None,
            ).map_err(|e| format!("Transport creation failed: {}", e))?
        };

        log::info!("[pjsip] Transport created (type={}, port={})", protocol, port);

        let username = sip_config.username.clone();
        let auth_username = sip_config.auth_username.clone().unwrap_or(username.clone());
        let password = sip_config.password.expose_secret().to_string();

        let mut account_config = AccountConfig::default();
        account_config.name = username.clone();
        account_config.username = auth_username;
        account_config.password = password;
        account_config.server = server.clone();
        account_config.port = port;
        account_config.transport = transport_type;
        account_config.srtp = SrtpMode::Disabled;
        account_config.reg_timeout = Some(reg_config.expires);
        account_config.use_sips = protocol.eq_ignore_ascii_case("TLS");

        let acc_id = {
            let app_guard = app_ref.lock().await;
            let app = app_guard.as_ref().ok_or("PjsuaApp not initialized")?;
            app.add_account(&account_config)
                .map_err(|e| format!("Account creation failed: {}", e))?
        };

        {
            let mut aid = account_id.lock().await;
            *aid = Some(acc_id);
        }

        connected.store(true, Ordering::SeqCst);

        emit_registration_event(
            &handle,
            "sip:status",
            "registered",
            None,
        );

        log::info!("[pjsip] Registered successfully (account_id={})", acc_id.0);

        let mut event_rx = rx;

        loop {
            if should_stop.load(Ordering::SeqCst) {
                log::info!("[pjsip] Registration loop stopping (should_stop=true)");
                break;
            }

            tokio::select! {
                Some(event) = event_rx.recv() => {
                    Self::handle_sip_event(
                        &handle,
                        &event,
                        &connected,
                        &account_id,
                        &consecutive_failures,
                    ).await;
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(
                    (reg_config.expires as u64) * 1000 / 2
                )) => {
                    let failures = consecutive_failures.load(Ordering::SeqCst);
                    if failures > 0 {
                        log::warn!("[pjsip] Keepalive check: {} consecutive failures", failures);
                    }
                }
            }
        }

        Ok(())
    }

    async fn handle_sip_event(
        handle: &AppHandle,
        event: &SipEvent,
        connected: &Arc<AtomicBool>,
        account_id: &Arc<Mutex<Option<AccountId>>>,
        consecutive_failures: &Arc<AtomicU32>,
    ) {
        match event {
            SipEvent::RegistrationState { account_id: aid, is_registered, code, reason, .. } => {
                log::info!("[pjsip] Registration state for account {}: registered={}, code={}, reason={}", aid.0, is_registered, code, reason);

                if *is_registered {
                    connected.store(true, Ordering::SeqCst);
                    consecutive_failures.store(0, Ordering::SeqCst);
                    emit_registration_event(handle, "sip:status", "registered", None);
                } else if code >= 400 {
                    connected.store(false, Ordering::SeqCst);
                    consecutive_failures.fetch_add(1, Ordering::SeqCst);
                    emit_registration_event(
                        handle,
                        "sip:status",
                        "error",
                        Some(format!("Registration failed ({}): {}", code, reason)),
                    );
                } else {
                    emit_registration_event(
                        handle,
                        "sip:status",
                        "connecting",
                        Some(format!("Registration in progress ({}): {}", code, reason)),
                    );
                }
            }
            SipEvent::IncomingCall { account_id: _, call_id, remote_uri, .. } => {
                let invite_data = crate::pjsip::account::InviteData {
                    caller_number: extract_caller_number(remote_uri),
                    caller_name: String::new(),
                    call_id: call_id.0.to_string(),
                };
                log::info!("[pjsip] Incoming call from {} (call_id={})", invite_data.caller_number, call_id.0);
                emit_incoming_call_event(handle, &invite_data);
            }
            SipEvent::CallState { call_id, state, last_code, last_reason, .. } => {
                log::info!("[pjsip] Call {} state: {:?} (last_code={}, last_reason={})", call_id.0, state, last_code, last_reason);
                match state {
                    CallState::Confirmed => {
                        log::info!("[pjsip] Call {} confirmed", call_id.0);
                    }
                    CallState::Disconnected => {
                        log::info!("[pjsip] Call {} disconnected ({}): {}", call_id.0, last_code, last_reason);
                    }
                    _ => {}
                }
            }
            SipEvent::CallMediaState { call_id, media_status, .. } => {
                log::info!("[pjsip] Call {} media state: {:?}", call_id.0, media_status);
            }
            SipEvent::DtmfDigit { call_id, digit } => {
                log::info!("[pjsip] Call {} DTMF: {}", call_id.0, digit);
            }
            SipEvent::TransferStatus { call_id, status_code, status_text, is_final } => {
                log::info!("[pjsip] Call {} transfer status: {} {} final={}", call_id.0, status_code, status_text, is_final);
            }
            SipEvent::SipMessageTrace { call_id, info, .. } => {
                log::debug!("[pjsip] SIP trace call_id={}: {:?} {}", call_id.0, info.direction, info.method_or_status);
            }
        }
    }

    pub async fn disconnect(&self) -> PjsipResult<()> {
        log::info!("[pjsip] Disconnecting...");

        self.should_stop.store(true, Ordering::SeqCst);
        self.connected.store(false, Ordering::SeqCst);

        {
            let mut app_guard = self.app.lock().await;
            if let Some(app) = app_guard.take() {
                drop(app);
            }
        }

        {
            let mut th = self.task_handle.lock().await;
            if let Some(handle) = th.take() {
                let _ = handle.await;
            }
        }

        emit_registration_event(
            &self.handle,
            "sip:status",
            "disconnected",
            None,
        );

        log::info!("[pjsip] Disconnected");
        Ok(())
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    pub async fn make_call(&self, target: &str) -> PjsipResult<()> {
        if !self.is_connected() {
            return Err("Not registered".to_string());
        }

        let cfg = self.config.lock().await;
        let config = cfg.as_ref().ok_or("SIP config not set")?;

        let target_uri = format!("sip:{}@{}", target, config.server);

        let aid = {
            let aid = self.account_id.lock().await;
            *aid
        }.ok_or("No account configured")?;

        let app_guard = self.app.lock().await;
        let app = app_guard.as_ref().ok_or("PjsuaApp not initialized")?;

        let call_id = app.make_call(aid, &target_uri)
            .map_err(|e| format!("Call failed: {}", e))?;

        log::info!("[pjsip] Call initiated (call_id={})", call_id.0);
        Ok(())
    }

    pub async fn answer_call(&self, call_id: u32) -> PjsipResult<()> {
        let call = CallId(call_id as i32);
        let app_guard = self.app.lock().await;
        let app = app_guard.as_ref().ok_or("PjsuaApp not initialized")?;
        app.answer_call(call, 200)
            .map_err(|e| format!("Answer failed: {}", e))?;

        log::info!("[pjsip] Call {} answered with 200 OK", call_id);
        Ok(())
    }

    pub async fn hangup_call(&self, call_id: u32) -> PjsipResult<()> {
        let call = CallId(call_id as i32);
        let app_guard = self.app.lock().await;
        let app = app_guard.as_ref().ok_or("PjsuaApp not initialized")?;
        app.hangup_call(call, 600)
            .map_err(|e| format!("Hangup failed: {}", e))?;

        log::info!("[pjsip] Call {} hung up", call_id);
        Ok(())
    }
}

fn extract_caller_number(uri: &str) -> String {
    uri.strip_prefix("sip:")
        .unwrap_or(uri)
        .split('@')
        .next()
        .unwrap_or(uri)
        .to_string()
}