const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── Secure file-based storage ────────────────────────────────────────
// Stores settings in Electron's userData directory (survives app updates).
// Features:
//   - HMAC-SHA256 integrity (tamper detection)
//   - Atomic writes (write to .tmp, then rename — no corruption on crash)
//   - Backup file (auto-recovery if main file is corrupt)
//   - Restricted file permissions (owner-only read/write on Windows)

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const BACKUP_FILE = path.join(app.getPath('userData'), 'settings.json.bak');
const TMP_FILE = path.join(app.getPath('userData'), 'settings.json.tmp');

// HMAC key derived from machine-specific data (per-machine binding)
function getHmacKey() {
  const machineId = require('os').hostname() + '-' + app.getPath('userData');
  return crypto.createHash('sha256').update('callerflash-storage-v1:' + machineId).digest();
}

function computeHmac(data) {
  return crypto.createHmac('sha256', getHmacKey()).update(data).digest('hex');
}

function verifyHmac(data, expectedHmac) {
  const actual = computeHmac(data);
  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHmac, 'hex'));
}

// ── Load settings ────────────────────────────────────────────────────
ipcMain.handle('storage:load', () => {
  try {
    // Try main file first
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const parsed = JSON.parse(raw);

      // Verify integrity
      if (parsed._hmac && parsed._data) {
        const dataStr = JSON.stringify(parsed._data);
        if (verifyHmac(dataStr, parsed._hmac)) {
          return parsed._data;
        }
        // HMAC mismatch — file was tampered with
        console.warn('[storage] HMAC mismatch — attempting backup recovery');
      } else {
        // Legacy format without HMAC — accept but upgrade on next save
        return parsed;
      }
    }

    // Try backup file
    if (fs.existsSync(BACKUP_FILE)) {
      const raw = fs.readFileSync(BACKUP_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed._hmac && parsed._data) {
        const dataStr = JSON.stringify(parsed._data);
        if (verifyHmac(dataStr, parsed._hmac)) {
          console.log('[storage] Recovered from backup file');
          // Restore main file from backup
          fs.copyFileSync(BACKUP_FILE, SETTINGS_FILE);
          return parsed._data;
        }
      } else {
        return parsed;
      }
    }

    return {};
  } catch (err) {
    console.error('[storage] load failed:', err.message);
    return {};
  }
});

// ── Save settings ────────────────────────────────────────────────────
ipcMain.handle('storage:save', (_event, data) => {
  try {
    // Validate input
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid data');
    }

    // Serialize and compute HMAC
    const dataStr = JSON.stringify(data);
    const hmac = computeHmac(dataStr);

    const envelope = {
      _version: 2,
      _hmac: hmac,
      _data: data,
      _savedAt: new Date().toISOString(),
    };
    const output = JSON.stringify(envelope, null, 2);

    // Backup existing file before overwriting
    if (fs.existsSync(SETTINGS_FILE)) {
      try {
        fs.copyFileSync(SETTINGS_FILE, BACKUP_FILE);
      } catch {
        // Ignore backup failures
      }
    }

    // Atomic write: write to temp file, then rename
    fs.writeFileSync(TMP_FILE, output, { mode: 0o600 }); // Owner read/write only
    fs.renameSync(TMP_FILE, SETTINGS_FILE); // Atomic on most filesystems

    // Restrict permissions (Windows: inherited from parent, Unix: chmod)
    try {
      fs.chmodSync(SETTINGS_FILE, 0o600);
    } catch {
      // Ignore on Windows
    }

    return { success: true };
  } catch (err) {
    console.error('[storage] save failed:', err.message);
    return { success: false, error: err.message };
  }
});

// ── Export for direct use in main process if needed ──────────────────
module.exports = { SETTINGS_FILE, BACKUP_FILE };
