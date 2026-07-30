<#
.SYNOPSIS
    Bumps the app version in all three source files (Cargo.toml, package.json, tauri.conf.json),
    commits the change, tags the commit, and pushes to origin.

.PARAMETER Version
    The new version string (e.g., "1.5.3"). Must be a valid semver.

.PARAMETER DryRun
    If set, prints what would change without modifying any files.

.PARAMETER NoPush
    If set, commits and tags locally but does not push.

.EXAMPLE
    .\bump-version.ps1 1.5.3
    .\bump-version.ps1 1.5.3 -DryRun
    .\bump-version.ps1 1.5.3 -NoPush
#>

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version,

    [switch]$DryRun,

    [switch]$NoPush
)

$ErrorActionPreference = "Stop"

# --- Validate version format (semver-ish) ---
if ($Version -notmatch '^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$') {
    Write-Error "Version must be a valid semver (e.g. 1.5.3). Got: $Version"
    exit 1
}

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- Files to update ---
# Pattern uses \r? before $ to handle CRLF line endings on Windows.
$files = @(
    @{
        Path       = "$RepoRoot\src-tauri\Cargo.toml"
        Pattern    = '(?m)^version = "\d+\.\d+\.\d+[\w\.\-+]*"\r?$'
        LinePrefix = 'version = "'
    }
    @{
        Path       = "$RepoRoot\package.json"
        Pattern    = '(?m)^  "version": "\d+\.\d+\.\d+[\w\.\-+]*",?\r?$'
        LinePrefix = '  "version": "'
    }
    @{
        Path       = "$RepoRoot\src-tauri\tauri.conf.json"
        Pattern    = '(?m)^  "version": "\d+\.\d+\.\d+[\w\.\-+]*",?\r?$'
        LinePrefix = '  "version": "'
    }
)

$changed = @()

foreach ($f in $files) {
    $content = Get-Content -Path $f.Path -Raw

    $match = [regex]::Match($content, $f.Pattern)
    if (-not $match.Success) {
        Write-Warning "Could not find version line matching pattern in $($f.Path). Skipping."
        continue
    }

    $oldLine = $match.Value
    $trailingComma = if ($oldLine -replace '[\r\n]', '' -match ',') { ',' } else { '' }
    $newLine = $f.LinePrefix + $Version + '"' + $trailingComma
    $newContent = $content -replace [regex]::Escape($oldLine.TrimEnd("`r", "`n")), $newLine

    if (-not $DryRun) {
        Set-Content -Path $f.Path -Value $newContent -NoNewline
        # Ensure exactly one trailing CRLF
        $final = Get-Content -Path $f.Path -Raw
        $final = $final.TrimEnd("`r", "`n") + "`r`n"
        Set-Content -Path $f.Path -Value $final -NoNewline
    }

    Write-Host "$($f.Path): $($oldLine.Trim()) -> $newLine" -ForegroundColor $(if ($DryRun) { 'Yellow' } else { 'Green' })
    $changed += $f.Path
}

if ($DryRun) {
    Write-Host "`nDry run complete. Run without -DryRun to apply." -ForegroundColor Yellow
    exit 0
}

# --- Commit & Tag ---
$branch = git -C $RepoRoot rev-parse --abbrev-ref HEAD
$tag = "v$Version"
$commitMsg = "chore: bump version to $Version"

Write-Host "`nCreating commit: $commitMsg" -ForegroundColor Cyan
git -C $RepoRoot add $changed
git -C $RepoRoot commit -m $commitMsg

Write-Host "Creating tag: $tag" -ForegroundColor Cyan
git -C $RepoRoot tag $tag

if (-not $NoPush) {
    Write-Host "Pushing commit and tag to origin..." -ForegroundColor Cyan
    git -C $RepoRoot push origin $branch
    git -C $RepoRoot push origin $tag
    Write-Host "`nDone. GitHub Actions should now build and release $tag." -ForegroundColor Green
} else {
    Write-Host "`nLocal commit and tag created. Push when ready:" -ForegroundColor Yellow
    Write-Host "  git push origin $branch && git push origin $tag"
}
