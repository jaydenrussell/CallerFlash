use crate::pjsip::types::{InviteData, SipStatus};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

const MAX_CALLER_ID_LENGTH: usize = 128;

fn safe_emit(handle: &AppHandle, event: &str, payload: impl serde::Serialize + Clone) {
    if let Err(e) = handle.emit(event, payload) {
        log::error!("[pjsip] Failed to emit {}: {}", event, e);
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

fn extract_caller_number(uri: &str) -> String {
    uri.strip_prefix("sip:")
        .unwrap_or(uri)
        .split('@')
        .next()
        .unwrap_or(uri)
        .to_string()
}

pub fn parse_invite_from_uri(uri: &str) -> (String, String) {
    let display_name;
    let uri_part;

    if let Some(start) = uri.find('<') {
        if let Some(end) = uri.find('>') {
            display_name = uri[..start].trim().trim_matches('"').to_string();
            uri_part = &uri[start + 1..end];
        } else {
            display_name = String::new();
            uri_part = uri;
        }
    } else {
        display_name = String::new();
        uri_part = uri;
    }

    let number = uri_part
        .strip_prefix("sip:")
        .unwrap_or(uri_part)
        .split('@')
        .next()
        .unwrap_or(uri_part)
        .to_string();

    (display_name, number)
}

pub fn extract_invite_data(
    from_display: &str,
    from_uri: &str,
    call_id: &str,
) -> InviteData {
    let (caller_name, caller_number) = parse_invite_from_uri(from_uri);
    let display_name = if from_display.is_empty() {
        caller_name.clone()
    } else {
        from_display.to_string()
    };

    InviteData {
        caller_number: sanitize_caller_id(&caller_number),
        caller_name: sanitize_caller_id(&display_name),
        call_id: call_id.to_string(),
    }
}

pub fn emit_registration_event(
    handle: &AppHandle,
    event: &str,
    status: &str,
    message: Option<String>,
) {
    safe_emit(
        handle,
        event,
        SipStatus {
            status: status.to_string(),
            message,
        },
    );
}

pub fn emit_incoming_call_event(
    handle: &AppHandle,
    invite_data: &InviteData,
) {
    safe_emit(handle, "sip:invite", invite_data.clone());
}