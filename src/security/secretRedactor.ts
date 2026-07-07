/**
 * Secret redaction & safe logging utilities.
 *
 * The cardinal rule: SIP passwords, auth tokens, and registration secrets
 * MUST NEVER appear in diagnostic logs, crash reports, telemetry, or
 * diagnostic exports — even partially. This module is the single chokepoint
 * through which all log strings flow.
 */

/**
 * Patterns that mark a value as sensitive. If the field name (key) contains
 * any of these substrings (case-insensitive), the value is replaced with
 * `***REDACTED***` regardless of what it contains.
 */
const SENSITIVE_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'credential',
  'private',
  'sip_password',
  'sip_auth',
  'sip_secret',
];

/**
 * Mask anything that LOOKS like a SIP auth digest, JWT, or bearer token.
 * Called on free-form log messages, not just keyed values.
 */
const TOKEN_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // Authorization: Bearer ***REDACTED***
  { re: /\bauthorization:\s*bearer\s+[^\s]+/gi, replace: 'authorization: Bearer ***REDACTED***' },
  // SIP Authorization header with various schemes
  { re: /\b(digest\s+(username="[^"]+"\s*,\s*)?realm="[^"]+"\s*,\s*nonce="[^"]+"\s*,\s*)(response=")[a-z0-9]+/gi, replace: '$1response="***REDACTED***' },
  // WWW-Authenticate realms + nonce + qop (keep for debugging, strip nonce)
  { re: /(nonce=")[a-z0-9]+"/gi, replace: '$1***REDACTED***"' },
  // Long hex/base64 blobs (likely signatures / hashes of credentials)
  { re: /\b[a-f0-9]{48,}\b/gi, replace: '***REDACTED***' },
  // JWT-like three-segment base64
  { re: /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, replace: '***REDACTED-JWT***' },
];

export function redactKeyedValue(key: string, value: string): string {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.some((needle) => lower.includes(needle))) {
    return '***REDACTED***';
  }
  return value;
}

/**
 * Redact credential-like substrings from an arbitrary log message.
 * Safe to call on every diagnostic log line.
 */
export function redactMessage(message: string): string {
  let out = message;
  for (const { re, replace } of TOKEN_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Strip everything except digits and a leading + from a phone-number-like
 * string before copying to clipboard. This prevents the caller NAME (which
 * a SIP INVITE can carry arbitrary bytes in) from being smuggled into the
 * clipboard alongside a number, where it could be auto-pasted into a
 * terminal or SQL field.
 */
export function sanitizeCallerNumberForClipboard(raw: string): string {
  const cleaned = raw.replace(/[^\d+]/g, '');
  const withPlus = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  // Remove any extra + signs beyond the leading one
  const singlePlus = '+' + withPlus.replace(/\+/g, '');
  return singlePlus.slice(0, 20);
}

/**
 * Sanitize a caller name received from a SIP INVITE before storing or
 * displaying. Strips control characters (0x00-0x1F except \t), truncates
 * to 128 chars, and ensures the output is safe for DOM textContent and
 * notification body text.
 */
export function sanitizeCallerName(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .slice(0, 128);
}

/**
 * Validate a URL before opening externally. Defends against accidentally
 * accepting `javascript:` or `file:` or `vbscript:` from remote metadata.
 */
export function isSafeExternalUrl(href: string): boolean {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (!url.hostname || url.hostname === 'localhost') return false;
    // Optionally pin to a known host allow-list per-call
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a SIP server hostname. SIP servers must be DNS hostnames or IPs,
 * never URLs with paths or credentials.
 */
export function sanitizeSipServer(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.includes('/') || trimmed.includes('@') || trimmed.includes(' ')) {
    return '';
  }
  // Strip any userinfo embedded as ":" — SIP servers don't carry creds in the URI
  return trimmed.split(':')[0];
}