import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.some(arg => arg !== '--dry-run')) throw Error('Usage: node tools/clean-target.mjs [--dry-run]')
const dryRun = args.includes('--dry-run')
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Include the misplaced tree left by checks launched from src-tauri.
const targets = ['target', 'src-tauri/target', 'src-tauri/src-tauri/target'].map(path => resolve(project, path))
const keepDirectories = new Set(['debug', 'release', 'offline-runtime'])
// Only known disposable checks are eligible. New build profiles, packaging
// caches and files with an unknown purpose stay untouched by default.
const temporaryDirectoryNames = new Set([
  'automation-background-check', 'boot-smoke', 'bottom-terminal-live',
  'browser-hover-check', 'checkbox-redesign', 'collapse-icon-check', 'deep-link-live',
  'dock-region-live', 'dsh-update-style-check', 'editor-inspect', 'file-menu-icon-check',
  'fullscreen-sidebar-preview', 'git-actions-preview', 'header-toggle-check',
  'i18n-tools', 'lan-settings-ownership', 'loading-motion-preview', 'menu-redesign',
  'mobile-chrome-check', 'mobile-input-check', 'mobile-web-check', 'offline-pack-baseline',
  'pack-smoke', 'path-shadows', 'perf-baseline', 'perf-investigation',
  'phone-probe-AbortSignalprototypethrowIfAborted', 'phone-workspace-probe', 'preview',
  'remote-control-cold', 'remote-control-failures', 'remote-control-live',
  'remote-control-package', 'remote-control-release', 'remote-terminal-package',
  'terminal-live', 'terminal-preferences-check', 'text-menu', 'text-selection',
  'toast-position-check', 'trigger-theme-verification', 'ui-smoke', 'workspace-terminal-check',
])
const temporaryDirectoryPrefixes = [
  'account-button', 'account-feedback', 'account-login', 'attachment-menu', 'background-settings',
  'changes-file-menu', 'changes-smoke', 'clean-target-test', 'cleanup-verification',
  'color-schemes', 'commit-dialog-smoke', 'composer-material', 'conversation-perf',
  'custom-reasoning', 'diagnostics', 'directory-picker-smoke', 'draft-attachments',
  'dsh-update', 'dshmarket', 'file-editor-smoke', 'header-menu', 'i18n-smoke',
  'image-preview-smoke', 'installer-change', 'installer-ui-test', 'jobs-button', 'jobs-header',
  'lan-terminal', 'long-task-perf', 'menu-fixes', 'mobile-viewport', 'model-provider-motion',
  'native-backup', 'native-candidate', 'native-diagnostics', 'native-draft-checkpoints',
  'native-profile-restore', 'native-recovery', 'native-restore', 'native-runtime-store',
  'native-upgrade', 'navigation-colors', 'notification-package', 'pack-script-smoke',
  'plugin-control', 'plugin-dialog-desktop', 'plugin-settings-motion', 'profile-lock',
  'profile-plugin-control', 'remote-changes', 'remote-compat', 'remote-listeners',
  'remote-settings-dialog', 'remote-terminal', 'remote-theme', 'runtime-profile', 'runtime-snapshot',
  'session-changes-before', 'session-changes-smoke', 'session-jobs', 'session-link-smoke',
  'settings-desktop', 'settings-rc2', 'sidebar-archive', 'sidebar-export', 'sidebar-fade',
  'sidebar-motion', 'storage-contract', 'ui-motion', 'ui-state-form', 'update-animation',
  'update-badge', 'update-dialog', 'update-speed', 'upgrade-compat', 'upstream-preferences',
]
const temporaryDirectory = new RegExp(`^(?:${temporaryDirectoryPrefixes.join('|')})-(?:[a-zA-Z0-9]{6}|[a-fA-F0-9]{32}|[0-9]{8,13})$`)
const temporaryFile = /^(?:(?:startup-speed|update-(?:cleanup|fix|speed)|session-jobs-plugin-tests)(?:-[a-z0-9-]+)?\.log|(?:ui-smoke|titlebar-startup-smoke|attachment-lightbox-check|sidebar-fade-check|workspace-scroll-fade-check|workspace-scroll-fade)\.(?:mjs|cjs|js|png))$/i
const isolatedBinary = /^deepseek-harness-desktop-diagnostics-(?:isolated|smoke)(?:\.exe|\.pdb|\.d)$/

function statIfPresent(path) {
  try { return lstatSync(path) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function assertInside(path, boundary) {
  const part = relative(boundary, path)
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw Error(`Refusing path outside ${boundary}: ${path}`)
  }
}

function assertNoLinkedAncestors(path) {
  let current = path
  while (true) {
    if (statIfPresent(current)?.isSymbolicLink()) throw Error(`Refusing linked directory: ${current}`)
    if (current === project) break
    assertInside(current, project)
    current = dirname(current)
  }
}

function assertIdle() {
  if (process.platform !== 'win32') return
  // Pass the path through the environment, never interpolate it into shell code.
  const query = `
    $ErrorActionPreference = 'Stop'
    $taskRoot = $env:DSH_CLEAN_TARGET_PROJECT
    Get-CimInstance Win32_Process | Where-Object {
      $_.Name -match '^(cargo|rustc|clippy-driver)\\.exe$' -or
      ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($taskRoot + '\\', [StringComparison]::OrdinalIgnoreCase) -and
        $_.ExecutablePath -match '[\\\\/]target[\\\\/]') -or
      ($_.Name -match '^node\\.exe$' -and $_.CommandLine -and
        $_.CommandLine.IndexOf($taskRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine -match '(?:tauri(?:\\.js)?[" ]+(?:dev|build)|(?:smoke|repro|integration|probe|inspect)[^" ]*\\.mjs)')
    } | ForEach-Object { '{0} (PID {1})' -f $_.Name, $_.ProcessId }
  `
  const active = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, DSH_CLEAN_TARGET_PROJECT: project },
  }).trim()
  if (active) throw Error(`Builds or checks are still running; retry after they finish:\n${active}`)
}

function collectCandidates(target) {
  assertInside(target, project)
  assertNoLinkedAncestors(target)
  if (!statIfPresent(target)) return []
  const candidates = []
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    // Preserve complete development and packaging trees, even if linked. Never
    // descend into them to delete incremental caches or generated resources.
    if (keepDirectories.has(entry.name)) continue
    const knownDirectory = temporaryDirectoryNames.has(entry.name) || temporaryDirectory.test(entry.name)
    if (((entry.isDirectory() || entry.isSymbolicLink()) && knownDirectory) ||
        ((entry.isFile() || entry.isSymbolicLink()) && (temporaryFile.test(entry.name) || isolatedBinary.test(entry.name)))) {
      candidates.push(join(target, entry.name))
    }
  }
  return candidates
}

// lstat and Dirent inspect links themselves; never read or count external targets.
function sizeWithoutFollowingLinks(path) {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) return 0
  if (!info.isDirectory()) return info.size
  let bytes = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) bytes += sizeWithoutFollowingLinks(join(path, entry.name))
  }
  return bytes
}

function gib(bytes) { return `${(bytes / 1024 ** 3).toFixed(2)} GiB` }

assertIdle()
// Validate every target before the first deletion, including dry runs.
const plans = targets.map(target => ({ target, candidates: collectCandidates(target) }))
let removed = 0
let bytes = 0
const failures = []
for (const { target, candidates } of plans) {
  if (!candidates.length) continue
  let targetBytes = 0
  let targetRemoved = 0
  for (const path of candidates) {
    try {
      assertInside(path, target)
      assertNoLinkedAncestors(dirname(path))
      const size = sizeWithoutFollowingLinks(path)
      if (dryRun) console.log(`Would remove: ${relative(project, path)}`)
      else {
        // Node removes a junction/symlink itself and does not traverse its target.
        rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        if (statIfPresent(path)) throw Error(`Entry still exists: ${path}`)
      }
      targetBytes += size
      targetRemoved++
    } catch (error) {
      failures.push(`${relative(project, path)}: ${error.message}`)
    }
  }
  console.log(`${dryRun ? 'Planned' : 'Cleaned'} ${relative(project, target)}: ${targetRemoved} entries, ${gib(targetBytes)}`)
  removed += targetRemoved
  bytes += targetBytes
}
console.log(`${dryRun ? 'Would remove' : 'Removed'} ${removed} entries (${gib(bytes)} of file data). Build outputs and reusable caches preserved.`)
if (failures.length) {
  console.error(`Cleanup incomplete:\n${failures.join('\n')}`)
  process.exitCode = 1
}
