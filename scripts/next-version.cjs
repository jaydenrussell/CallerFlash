#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const channel = (process.argv[2] || 'alpha').toLowerCase();
const override = process.argv[3];

function readPackageVersion() {
  const pkgPath = path.join(process.cwd(), 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  return JSON.parse(raw).version;
}

function gitTags() {
  try {
    const out = execSync('git tag --list --sort=-version:refname', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function parseTag(tag) {
  const m = tag.match(/^v?(\d+\.\d+\.\d+)(?:-(.+))?$/);
  if (!m) return null;
  return { raw: tag, base: m[1], pre: m[2] || null };
}

function compareBase(a, b) {
  const [a1, a2, a3] = a.split('.').map(Number);
  const [b1, b2, b3] = b.split('.').map(Number);
  return (a1 - b1) || (a2 - b2) || (a3 - b3);
}

function highest(stables) {
  return stables.sort(compareBase)[stables.length - 1];
}

function nextStable(tags, baseVer) {
  const stableBases = tags.map(parseTag).filter((t) => t && !t.pre).map((t) => t.base);
  if (stableBases.length === 0) return baseVer;
  const latest = highest(stableBases).split('.').map(Number);
  latest[2] += 1;
  return latest.join('.');
}

function nextBeta(tags, baseVer) {
  const parsed = tags.map(parseTag).filter(Boolean);
  const betas = parsed.filter((t) => t.pre === 'beta');
  const stables = parsed.filter((t) => !t.pre);
  const basesWithBetas = [...new Set(betas.map((t) => t.base))].sort(compareBase);
  const currentBase = basesWithBetas.length > 0 ? basesWithBetas[basesWithBetas.length - 1] : null;
  if (!currentBase) return `${baseVer}-beta`;
  const stableForCurrent = stables.some((t) => t.base === currentBase);
  if (stableForCurrent) {
    const [maj, min] = currentBase.split('.').map(Number);
    return `${maj}.${min + 1}.0-beta`;
  }
  return `${currentBase}-beta`;
}

function nextAlpha(tags) {
  const parsed = tags.map(parseTag).filter(Boolean);
  const newStyle = parsed.filter((t) => t.pre === 'alpha');
  let maxMinor = 0;
  for (const t of newStyle) {
    const parts = t.base.split('.').map(Number);
    if (parts.length >= 2 && parts[1] > maxMinor) {
      maxMinor = parts[1];
    }
  }
  if (newStyle.length > 0) {
    return `0.1.${maxMinor + 1}-alpha`;
  }
  return '0.1.1-alpha';
}

let result;
try {
  const baseVer = readPackageVersion();
  if (override) {
    result = override.replace(/^v/, '').trim();
    if (!/^[\w.-]+$/.test(result)) {
      console.error(`Invalid version override: ${override}`);
      process.exit(1);
    }
  } else if (channel === 'stable') {
    result = nextStable(gitTags(), baseVer);
  } else if (channel === 'beta') {
    result = nextBeta(gitTags(), baseVer);
  } else if (channel === 'alpha') {
    result = nextAlpha(gitTags());
  } else {
    console.error(`Unknown channel: ${channel} (expected: stable | beta | alpha)`);
    process.exit(1);
  }
  process.stdout.write(result + '\n');
} catch (err) {
  console.error(`next-version failed: ${err.message}`);
  process.exit(1);
}
