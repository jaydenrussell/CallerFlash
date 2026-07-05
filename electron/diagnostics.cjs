const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_LINES = 10000;
const LOAD_LIMIT = 1000;

function logFilePath() {
  return path.join(app.getPath('userData'), 'diagnostics.log');
}

function append(entry) {
  try {
    const line = JSON.stringify({
      id: entry.id,
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : entry.timestamp.toISOString(),
      level: entry.level,
      category: entry.category,
      message: entry.message,
      details: entry.details || null,
    }) + '\n';
    fs.appendFileSync(logFilePath(), line, 'utf8');
    trim();
  } catch (e) {
    console.error('[diagnostics] append error:', e.message);
  }
}

function trim() {
  try {
    const p = logFilePath();
    if (!fs.existsSync(p)) return;
    const stat = fs.statSync(p);
    if (stat.size < 5 * 1024 * 1024) return;
    const content = fs.readFileSync(p, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(p, lines.slice(-MAX_LINES).join('\n') + '\n', 'utf8');
    }
  } catch {}
}

function load(limit) {
  try {
    const p = logFilePath();
    if (!fs.existsSync(p)) return [];
    const content = fs.readFileSync(p, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const entries = lines.slice(-(limit || LOAD_LIMIT)).map(line => {
      const parsed = JSON.parse(line);
      parsed.timestamp = new Date(parsed.timestamp);
      return parsed;
    });
    return entries.reverse();
  } catch {
    return [];
  }
}

module.exports = { append, load };
