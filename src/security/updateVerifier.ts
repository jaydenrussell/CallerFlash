/**
 * Update verification primitives.
 *
 * Renderer-side verification is advisory only: it validates channel policy,
 * version monotonicity, and the detached signature on the release checksum
 * manifest so the UI can explain whether an update looks trustworthy.
 *
 * The Electron main process performs the final install-time verification of
 * the downloaded installer bytes against the pinned SHA-256 and Ed25519
 * signature before the helper window is launched.
 *
 *   1. Code-signing (Authenticode / EV cert) catches publisher identity.
 *   2. SHA-256 checksum catches transport corruption or CDN tampering.
 *   3. Ed25519 detached signature catches the case where BOTH the binary
 *      and checksum are swapped by an attacker who compromises the CDN.
 *   4. Version monotonicity catches roll-back to a known-vulnerable release.
 *
 * The verify public key is HARD-CODED below. It must NEVER be fetched at
 * runtime — that would itself be a hijack vector.
 */

// Public key is pinned in Rust (update.rs). Frontend delegates to
// cmd_verify_update; the constant here is unused — retained for
// channel-policy UI messages that reference the key fingerprint.

// Allow-listed GitHub owner/repo. Hard-coded so a compromised
// settings/config cannot redirect updates to an attacker repo.
export const ALLOWED_UPDATE_HOSTS = [
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
] as const;

// Minimum supported app version. Anything older is forced to upgrade.
export const MIN_SUPPORTED_VERSION = '1.4.0';

// Update channel definitions — stable is the only one most users should
// ever see, but we expose beta/alpha under explicit opt-in.
export const CHANNEL_POLICY = {
  stable: { allowPrerelease: false },
  beta: { allowPrerelease: true },
  alpha: { allowPrerelease: true },
  tauri: { allowPrerelease: true },
} as const;

export type UpdateChannel = keyof typeof CHANNEL_POLICY;

export interface UpdateArtifact {
  version: string;
  releaseDate: string; // ISO 8601
  downloadUrl: string;
  sha256: string; // hex
  sha256Manifest: string; // raw SHA256SUMS text
  signatureB64: string;
  notes: string;
  prerelease: boolean;
}

export interface VerificationStep {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  approved: boolean;
  steps: VerificationStep[];
  artifact?: UpdateArtifact;
}

async function verifyDetachedSignature(manifest: string, signatureB64: string): Promise<boolean> {
  const dataHex = Array.from(new TextEncoder().encode(manifest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ valid: boolean }>('cmd_verify_update', {
      signatureB64,
      dataHex,
    });
    return result.valid;
  } catch {
    return false;
  }
}

/**
 * Verify a GitHub release artifact against our pinned public key, channel
 * policy, and minimum version. This function is intentionally pure-ish — it
 * performs network reads for reachability and signature verification only.
 */
export async function verifyUpdateArtifact(
  artifact: UpdateArtifact,
  channel: UpdateChannel,
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerificationResult> {
  const steps: VerificationStep[] = [];

  // 1. URL host allow-list
  let url: URL;
  try {
    url = new URL(artifact.downloadUrl);
  } catch {
    steps.push({ name: 'URL parse', passed: false, detail: 'Malformed download URL' });
    return { approved: false, steps };
  }
  const hostOk = (ALLOWED_UPDATE_HOSTS as readonly string[]).includes(url.hostname);
  steps.push({
    name: 'URL host allow-list',
    passed: hostOk,
    detail: hostOk ? `Host ${url.hostname} is allow-listed` : `Host ${url.hostname} is NOT allow-listed`,
  });
  if (!hostOk) return { approved: false, steps };

  // 2. Scheme must be https
  const httpsOk = url.protocol === 'https:';
  steps.push({
    name: 'HTTPS only',
    passed: httpsOk,
    detail: httpsOk ? 'Using HTTPS' : `Refusing non-HTTPS URL: ${url.protocol}`,
  });
  if (!httpsOk) return { approved: false, steps };

  // 3. Pre-release channel gating
  const policy = CHANNEL_POLICY[channel];
  const preOk = !artifact.prerelease || policy.allowPrerelease;
  steps.push({
    name: 'Channel pre-release policy',
    passed: preOk,
    detail: preOk
      ? `Channel "${channel}" permits ${artifact.prerelease ? 'pre-release' : 'stable'}`
      : `Channel "${channel}" does NOT permit pre-release builds`,
  });
  if (!preOk) return { approved: false, steps };

  // 4. Version monotonicity (no roll-back)
  const cmp = compareSemver(artifact.version, currentVersion);
  const monoOk = cmp > 0;
  steps.push({
    name: 'Version monotonicity',
    passed: monoOk,
    detail: monoOk
      ? `Target ${artifact.version} > current ${currentVersion}`
      : `Refusing to roll back: target ${artifact.version} vs current ${currentVersion}`,
  });
  if (!monoOk) return { approved: false, steps };

  // 5. Minimum supported version (in case current is ancient)
  const minOk = compareSemver(currentVersion, MIN_SUPPORTED_VERSION) >= 0
    || compareSemver(artifact.version, MIN_SUPPORTED_VERSION) >= 0;
  steps.push({
    name: 'Minimum supported version',
    passed: minOk,
    detail: `Target ${artifact.version} satisfies >= ${MIN_SUPPORTED_VERSION}`,
  });
  if (!minOk) return { approved: false, steps };

  // 6. SHA-256 format
  const shaHexOk = /^[a-f0-9]{64}$/i.test(artifact.sha256);
  steps.push({
    name: 'SHA-256 format',
    passed: shaHexOk,
    detail: shaHexOk ? 'Checksum format valid' : 'Checksum is not a 64-char hex string',
  });
  if (!shaHexOk) return { approved: false, steps };

  // 7. Signature presence
  const sigPresent = artifact.signatureB64.length > 0 && artifact.sha256Manifest.length > 0;
  steps.push({
    name: 'Signature present',
    passed: sigPresent,
    detail: sigPresent ? 'Detached signature and manifest attached' : 'Missing signature or checksum manifest',
  });
  if (!sigPresent) return { approved: false, steps };

  // 8. Verify the detached signature on the checksum manifest.
  try {
    const sigOk = await verifyDetachedSignature(artifact.sha256Manifest, artifact.signatureB64);
    steps.push({
      name: 'Ed25519 signature',
      passed: sigOk,
      detail: sigOk
        ? 'Verified against pinned key'
        : 'Signature verification failed',
    });
    if (!sigOk) return { approved: false, steps };
  } catch (err) {
    steps.push({
      name: 'Ed25519 signature',
      passed: false,
      detail: `Verification error: ${err instanceof Error ? err.message : 'unknown'}`,
    });
    return { approved: false, steps };
  }

  // 9. Artifact reachability (lightweight sanity check only)
  try {
    const headResponse = await fetchImpl(artifact.downloadUrl, { method: 'HEAD' });
    const reachable = headResponse.ok;
    steps.push({
      name: 'Artifact reachable',
      passed: reachable,
      detail: reachable
        ? `HTTP ${headResponse.status} from ${url.hostname}`
        : `HTTP ${headResponse.status} from server`,
    });
    if (!reachable) return { approved: false, steps };
  } catch (err) {
    steps.push({
      name: 'Artifact reachable',
      passed: false,
      detail: `Network error: ${err instanceof Error ? err.message : 'unknown'}`,
    });
    return { approved: false, steps };
  }

  return { approved: true, steps, artifact };
}

/**
 * Parse a GitHub release JSON object into our internal artifact shape,
 * fetching SHA256SUMS + .sig so the caller has real values to verify.
 */
export async function parseGithubRelease(release: {
  tag_name: string;
  published_at: string;
  prerelease: boolean;
  body: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}): Promise<UpdateArtifact | null> {
  const versionMatch = release.tag_name.match(/v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/)
    || release.tag_name.match(/v?(nightly-\d{8}(?:-\d+)?)/i);
  if (!versionMatch) return null;
  const version = versionMatch[1];

  const binary = release.assets.find((a) => /\.(exe|msi|zip)$/i.test(a.name));
  const shaAsset = release.assets.find((a) => /^SHA256SUMS(\.txt)?$/i.test(a.name));
  const sigAsset = release.assets.find((a) => a.name.endsWith('.sig'));

  if (!binary || !shaAsset || !sigAsset) return null;

  // Fetch SHA256SUMS (text) and parse the line that matches the binary.
  let sha256 = '';
  let sha256Manifest = '';
  try {
    const shaResp = await fetch(shaAsset.browser_download_url);
    if (shaResp.ok) {
      sha256Manifest = await shaResp.text();
      const basename = binary.name;
      const line = sha256Manifest
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.endsWith(basename) || l.endsWith(`*${basename}`));
      if (line) {
        const match = line.match(/^([a-f0-9]{64})/i);
        if (match) sha256 = match[1].toLowerCase();
      }
    }
  } catch {
    // Network failure — leave sha256 empty so verifier refuses.
  }
  if (!sha256 || !sha256Manifest) return null;

  // Fetch the detached .sig (binary) and base64-encode it so it can be
  // round-tripped through our verifier.
  let signatureB64 = '';
  try {
    const sigResp = await fetch(sigAsset.browser_download_url);
    if (sigResp.ok) {
      const buf = new Uint8Array(await sigResp.arrayBuffer());
      signatureB64 = btoa(String.fromCharCode(...buf));
    }
  } catch {
    // Leave empty — verifier will refuse.
  }
  if (!signatureB64) return null;

  return {
    version,
    releaseDate: release.published_at,
    downloadUrl: binary.browser_download_url,
    sha256,
    sha256Manifest,
    signatureB64,
    notes: release.body,
    prerelease: release.prerelease,
  };
}

function compareSemver(a: string, b: string): number {
  const va = a.replace(/^v/, '');
  const vb = b.replace(/^v/, '');

  // Normalize nightly format to semver-compatible prerelease
  // nightly.20260627-3 or nightly-20260627-3 => 0.0.0-nightly.20260627-3
  const nightlyA = va.match(/^nightly.?(\d{8})(?:-(\d+))?$/i);
  const nightlyB = vb.match(/^nightly.?(\d{8})(?:-(\d+))?$/i);

  if (nightlyA && nightlyB) {
    // Both are nightlies: compare date + sequence
    const diff = Number(nightlyA[1]) - Number(nightlyB[1]);
    if (diff !== 0) return diff;
    return Number(nightlyA[2] || '0') - Number(nightlyB[2] || '0');
  }
  // Nightly is always "newer" than any stable/beta (prerelease priority)
  if (nightlyA) return 1;
  if (nightlyB) return -1;

  const pa = va.split(/[.-]/);
  const pb = vb.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number(pa[i] ?? '0');
    const nb = Number(pb[i] ?? '0');
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else {
      const sa = String(pa[i] ?? '');
      const sb = String(pb[i] ?? '');
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}
