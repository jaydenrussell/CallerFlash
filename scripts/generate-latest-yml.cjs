#!/usr/bin/env node
/**
 * CallerFlash — Update-manifest generator.
 *
 * electron-builder's auto-generated `latest.yml` is unreliable across
 * versions (it's suppressed when `publish: null`, and on Windows the
 * path/casing can vary). This script generates the manifest deterministically
 * from the actual build artifacts in the release directory.
 *
 * Supported installer extensions:
 *   - Windows: .exe / .msi
 *   - macOS:   .dmg / .zip
 *
 * Usage:
 *   node scripts/generate-latest-yml.cjs <release-dir> <version> [output-name] [channel]
 *
 * Example:
 *   node scripts/generate-latest-yml.cjs release 1.4.2-nightly.abc1234 latest.yml nightly
 *   node scripts/generate-latest-yml.cjs release 1.4.2-beta.1 beta.yml beta
 *   node scripts/generate-latest-yml.cjs release 1.5.0 latest.yml latest
 *
 * Output: JSON manifest in the same shape electron-updater reads.
 * Exit: 0 on success or graceful skip, 1 only on real errors.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const releaseDir = process.argv[2] || 'release';
const version = process.argv[3];
const outputName = process.argv[4] || 'latest.yml';
const channel = process.argv[5] || 'latest';

if (!version) {
  console.error('Usage: node generate-latest-yml.cjs <release-dir> <version> [output-name] [channel]');
  process.exit(1);
}

if (!fs.existsSync(releaseDir) || !fs.statSync(releaseDir).isDirectory()) {
  console.error(`Release directory not found: ${releaseDir}`);
  process.exit(1);
}

function sha512Base64(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha512').update(buf).digest('base64');
}

// Recognize installers for every supported platform. The manifest's
// `path` is the file electron-updater will fetch, so it has to be one
// of these.
const INSTALLER_RE = /\.(exe|msi|dmg|zip)$/i;

const files = [];
let mainExe = null;

for (const name of fs.readdirSync(releaseDir).sort()) {
  // Only consider installers + their blockmaps. Ignore SHA256SUMS, .sig,
  // and any pre-existing manifest files.
  if (!INSTALLER_RE.test(name) && !/\.blockmap$/i.test(name)) continue;
  const full = path.join(releaseDir, name);
  const stat = fs.statSync(full);
  const entry = {
    url: name,
    sha512: sha512Base64(full),
    size: stat.size,
  };
  files.push(entry);
  if (INSTALLER_RE.test(name)) {
    mainExe = entry;
  }
}

if (!mainExe) {
  // No installer in the directory at all. Skip silently rather than
  // Windows-only app - always has an .exe, but guard against missing installer
  console.error(
    `[generate-latest-yml] No installer (.exe/.msi) found in ${releaseDir}; skipping manifest.`
  );
  process.exit(0);
}

const manifest = {
  version,
  files,
  path: mainExe.url,
  sha512: mainExe.sha512,
  releaseDate: new Date().toISOString(),
};

if (channel && channel !== 'latest') {
  manifest.channel = channel;
}

const outPath = path.join(releaseDir, outputName);
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log(`Generated ${outPath} (${files.length} files, version=${version}, channel=${channel})`);
