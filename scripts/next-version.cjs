#!/usr/bin/env node
/**
 * CallerFlash — Auto-increment version resolver.
 *
 * Reads existing `v*` git tags and computes the next available version
 * for the requested channel. Guarantees the returned version does NOT
 * collide with any existing tag.
 *
 * Channels:
 *   - stable  → bump patch of the latest stable tag (or use package.json
 *               version if no stable tags exist yet)
 *   - beta    → bump `-beta.N` for the current X.Y.Z; if X.Y.Z is already
 *               promoted to stable, advance to `X.(Y+1).0-beta.1`
 *   - alpha  → `0.1.0-alpha.N` (auto-incrementing prerelease, testing only)
 *
 * Usage:
 *   node scripts/next-version.cjs stable
 *   node scripts/next-version.cjs beta
 *   node scripts/next-version.cjs alpha
 *   node scripts/next-version.cjs beta 1.5.0-beta.7   # override
 *
 * Output: the bare version string (no leading `v`) on stdout.
 * Exits 0 on success, 1 on error.
 */

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
    const out = execSync("git tag --list --sort=-version:refname", {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    // Not in a git repo or no tags — return empty list.
    return [];
  }
}

function shortSha() {
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

/** Parse `v1.5.0-beta.3` → { base: '1.5.0', pre: 'beta.3', raw: 'v1.5.0-beta.3' } */
function parseTag(tag) {
  const m = tag.match(/^v?(\d+\.\d+\.\d+)(?:-(.+))?$/);
  if (!m) return null;
  return { raw: tag, base: m[1], pre: m[2] || null };
}

/** Compare two semver bases. Returns -1, 0, or 1. */
function compareBase(a, b) {
  const [a1, a2, a3] = a.split('.').map(Number);
  const [b1, b2, b3] = b.split('.').map(Number);
  return (a1 - b1) || (a2 - b2) || (a3 - b3);
}

function highest(stables) {
  return stables.sort(compareBase)[stables.length - 1];
}

function nextStable(tags, baseVer) {
  const stableBases = tags
    .map(parseTag)
    .filter((t) => t && !t.pre)
    .map((t) => t.base);
  if (stableBases.length === 0) return baseVer;
  const latest = highest(stableBases).split('.').map(Number);
  latest[2] += 1; // patch bump
  return latest.join('.');
}

function nextBeta(tags, baseVer) {
  const parsed = tags.map(parseTag).filter(Boolean);
  // Only count betas with a strict numeric suffix (e.g. `-beta.3`).
  // Legacy tags with non-numeric suffixes (e.g. `-beta.c15ab27` from
  // the old short-SHA flow) are ignored — they predate the auto-increment
  // scheme and would otherwise confuse the N calculation.
  const betas = parsed.filter((t) => t.pre && /^beta\.\d+$/.test(t.pre));
  const stables = parsed.filter((t) => !t.pre);

  // Group beta tags by base
  const byBase = new Map();
  for (const t of betas) {
    if (!byBase.has(t.base)) byBase.set(t.base, []);
    byBase.get(t.base).push(parseInt(t.pre.split('.')[1], 10));
  }

  // Find the highest base that has betas
  const basesWithBetas = [...byBase.keys()].sort(compareBase);
  const currentBase = basesWithBetas.length > 0 ? basesWithBetas[basesWithBetas.length - 1] : null;

  // If no betas exist yet, start from package.json version (or fall back to 1.0.0)
  if (!currentBase) {
    return `${baseVer}-beta.1`;
  }

  // If `currentBase` has already been promoted to stable, advance to next minor.
  const stableForCurrent = stables.some((t) => t.base === currentBase);
  if (stableForCurrent) {
    const [maj, min] = currentBase.split('.').map(Number);
    return `${maj}.${min + 1}.0-beta.1`;
  }

  // Otherwise bump beta.N
  const ns = byBase.get(currentBase);
  const maxN = Math.max(...ns);
  return `${currentBase}-beta.${maxN + 1}`;
}

function nextAlpha(tags) {
  // Alpha uses prerelease semver: 0.1.0-alpha.N
  // Find all existing alpha tags and increment N
  const parsed = tags.map(parseTag).filter(Boolean);
  const alphas = parsed.filter((t) => t.pre && /^alpha\.\d+$/.test(t.pre));

  // Find highest alpha.N
  let maxN = 0;
  for (const t of alphas) {
    const n = parseInt(t.pre.split('.')[1], 10);
    if (!isNaN(n) && n > maxN) maxN = n;
  }

  return `0.1.0-alpha.${maxN + 1}`;
}

// ── Main ─────────────────────────────────────────────────────────────────
let result;
try {
  const baseVer = readPackageVersion();

  if (override) {
    // Strip leading `v` if present; trust the caller otherwise.
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
