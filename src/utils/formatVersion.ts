/**
 * Format a version string for display and comparison.
 *
 * Normalises all nightly tag formats to the canonical "nightly-YYYYMMDD-N" form:
 *   - "nightly-20260629-6"           → "nightly-20260629-6"
 *   - "nightly.20260629.6"           → "nightly-20260629-6"
 *   - "0.0.0-nightly.20260629-6"    → "nightly-20260629-6"
 *   - "0.0.0-nightly-20260629-6"    → "nightly-20260629-6"
 *   - "v1.5.0-beta.28"               → "1.5.0-beta.28"
 *   - "v1.4.2"                       → "1.4.2"
 *
 * Stable / Beta versions are returned as-is (minus the optional "v" prefix).
 */
export function formatVersion(version: string): string {
  if (!version) return version;

  // Strip the 'v' prefix if it exists
  let cleaned = version.replace(/^v/, '');

  // Strip the semver prefix that electron-builder / CI may inject for nightly.
  // Matches "0.0.0-nightly." or "0.0.0-nightly-" (dot or dash before the date).
  cleaned = cleaned.replace(/^0\.0\.0-nightly[.-]/i, 'nightly-');

  // Normalise "nightly.YYYYMMDD.N" (dots as separators) to "nightly-YYYYMMDD-N"
  const dotNightly = cleaned.match(/^nightly\.(\d{8})(?:\.(\d+))?$/i);
  if (dotNightly) {
    return `nightly-${dotNightly[1]}${dotNightly[2] ? `-${dotNightly[2]}` : ''}`;
  }

  return cleaned;
}
