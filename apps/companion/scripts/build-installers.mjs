#!/usr/bin/env node
/**
 * Writes install/install.sh and install/install.ps1: two thin wrappers that each embed the SAME verified-install program (install/installer.mjs), so the
 * checks are written once. They are committed; `--check` (used by a test and CI) fails if they are out of date, and the generator refuses to run if the
 * keys pinned in installer.mjs differ from the component keys the ship agent pins (src/update/keys.ts).
 *
 *   node scripts/build-installers.mjs [--check]
 *
 * install.sh needs only a POSIX shell and Node >= 22.13; install.ps1 needs Windows PowerShell 5.1 or newer and Node >= 22.13. Licence: Apache-2.0.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMPONENT_PUBLIC_KEYS, roleOf } from '../vendor/agent/src/update/keys.ts';
import { PINNED_KEYS } from '../install/installer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const installDir = resolve(here, '..', 'install');

export function renderInstallers(program) {
  if (program.includes('BOTWARREN_INSTALLER_JS')) throw new Error('the program contains the shell heredoc delimiter');
  if (/^'@/m.test(program)) throw new Error("the program has a line that starts with '@ (the PowerShell here-string terminator)");
  if (program.includes('\r')) throw new Error('the program must use LF line endings');

  const sh = `#!/bin/sh
# Botwarren Companion installer for Linux and macOS (per user, no administrator rights). Apache-2.0.
#
#   curl -fsSL https://downloads.botwarren.com/companion/install.sh | sh
#   curl -fsSL https://downloads.botwarren.com/companion/install.sh | sh -s -- --service     (also run it in the background)
#   sh install.sh --dry-run | --uninstall | --help
#
# For a computer WITHOUT a Botwarren ship agent (with one, the agent installs the companion for you after you agree on your account page).
# Read it first if you like: this file is generated from apps/companion/install/installer.mjs in https://github.com/turbokast/botwarren-companion
# and is attached, with a build attestation, to every release. It installs ONLY the companion and ONLY after verifying, before anything runs:
#   1. the Ed25519 signature of the component manifest against the key pinned inside this file (Botwarren component key kms-comp-2026a), then
#   2. the size and SHA-256 of the bundle against that signed manifest, then
#   3. the archive contents (exactly companion.mjs, VERSION, LICENSE, NOTICE; no paths, no links).
# If any check fails it says so and installs nothing. It needs Node.js 22.13 or newer.
set -eu

fail() { printf '%s\\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js was not found. Install Node 22.13 or newer (macOS: 'brew install node'; Linux: your package manager, https://nodejs.org or nvm), then run this again."
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' \\
  || fail "Node $(node -p process.versions.node) is too old: the companion needs Node 22.13 or newer."

TMP=$(mktemp -d "\${TMPDIR:-/tmp}/botwarren-companion-install.XXXXXX") || fail "could not create a temporary directory"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT HUP TERM

cat > "$TMP/installer.mjs" <<'BOTWARREN_INSTALLER_JS'
${program}BOTWARREN_INSTALLER_JS

node --disable-warning=ExperimentalWarning "$TMP/installer.mjs" "$@"
`;

  const ps1 = `<#
.SYNOPSIS
  Botwarren Companion installer for Windows (per user, no administrator rights). Apache-2.0.
.DESCRIPTION
  For a computer WITHOUT a Botwarren ship agent (with one, the agent installs the companion for you after you agree on your account page).
  Download it, read it, then run it in a normal PowerShell window:

    Invoke-WebRequest https://downloads.botwarren.com/companion/install.ps1 -OutFile install.ps1
    .\\install.ps1                 (add --service to also start it at sign-in; --dry-run, --uninstall and --help also work)

  It is generated from apps/companion/install/installer.mjs in https://github.com/turbokast/botwarren-companion and is attached, with a build
  attestation, to every release. It installs ONLY the companion and ONLY after verifying, before anything runs: the Ed25519 signature of the
  component manifest against the key pinned inside this file (Botwarren component key kms-comp-2026a), the size and SHA-256 of the bundle against
  that signed manifest, and the archive contents (exactly companion.mjs, VERSION, LICENSE, NOTICE). If any check fails it installs nothing.
  Needs Node.js 22.13 or newer and Windows PowerShell 5.1 or newer.
#>
$ErrorActionPreference = 'Stop'
if (-not $env:LOCALAPPDATA) { Write-Host 'LOCALAPPDATA is not set - run this from a normal user session.' -ForegroundColor Red; exit 1 }
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Write-Host 'Node.js was not found. Install Node 22.13 or newer from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), then run this again.' -ForegroundColor Red; exit 1 }
$nodePath = $nodeCmd.Source
$nodeVersion = (& $nodePath -p 'process.versions.node').Trim()
$parts = $nodeVersion.Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 13)) { Write-Host "Node $nodeVersion is too old: the companion needs Node 22.13 or newer." -ForegroundColor Red; exit 1 }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('botwarren-companion-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$code = 1
try {
  $js = @'
${program}'@
  $file = Join-Path $tmp 'installer.mjs'
  [IO.File]::WriteAllText($file, $js, (New-Object Text.UTF8Encoding($false)))
  & $nodePath --disable-warning=ExperimentalWarning $file @args
  $code = $LASTEXITCODE
  # a normal install puts the command folder on the user PATH (the same folder the ship agent's installer uses), once
  $skip = $args | Where-Object { $_ -in @('--uninstall', '--dry-run', '--help', '-h', '--bin-dir') }
  if ($code -eq 0 -and -not $skip) {
    $bin = Join-Path (Join-Path $env:LOCALAPPDATA 'Botwarren') 'bin'
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $have = ($userPath -split ';') | Where-Object { $_.TrimEnd('\\') -ieq $bin.TrimEnd('\\') }
    if (-not $have) {
      [Environment]::SetEnvironmentVariable('Path', $(if ($userPath) { $userPath.TrimEnd(';') + ';' } else { '' }) + $bin, 'User')
      Write-Host "Added $bin to your user PATH (open a new terminal to use botwarren-companion)."
    }
  }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
exit $code
`;
  return { sh, ps1 };
}

/** the keys pinned in installer.mjs must be exactly the ship agent's component keys */
export function checkPinnedKeys() {
  const want = COMPONENT_PUBLIC_KEYS.filter((k) => roleOf(k) === 'component').map((k) => ({ id: k.id, spki: k.spki, dev: Boolean(k.dev) }));
  const have = PINNED_KEYS.map((k) => ({ id: k.id, spki: k.spki, dev: Boolean(k.dev) }));
  if (JSON.stringify(want) !== JSON.stringify(have)) throw new Error(`the keys pinned in install/installer.mjs differ from COMPONENT_PUBLIC_KEYS in the ship agent's keys.ts:\n  installer: ${JSON.stringify(have)}\n  agent:     ${JSON.stringify(want)}`);
}

export function buildInstallers() {
  checkPinnedKeys();
  return renderInstallers(readFileSync(resolve(installDir, 'installer.mjs'), 'utf8'));
}

function main(argv) {
  try {
    const { sh, ps1 } = buildInstallers();
    if (argv.includes('--check')) {
      const stale = [['install.sh', sh], ['install.ps1', ps1]].filter(([n, t]) => { try { return readFileSync(resolve(installDir, n), 'utf8') !== t; } catch { return true; } }).map(([n]) => n);
      if (stale.length) { console.error(`out of date: ${stale.join(', ')} (run: node apps/companion/scripts/build-installers.mjs)`); process.exit(1); }
      console.log('install.sh and install.ps1 are up to date');
      return;
    }
    mkdirSync(installDir, { recursive: true });
    writeFileSync(resolve(installDir, 'install.sh'), sh, { mode: 0o755 });
    writeFileSync(resolve(installDir, 'install.ps1'), ps1);
    console.log(`wrote ${resolve(installDir, 'install.sh')} and install.ps1`);
  } catch (e) { console.error(`build-installers: ${e.message}`); process.exit(1); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
