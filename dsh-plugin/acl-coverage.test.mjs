/**
 * Guards the app's ACL against the failure mode that broke onboarding twice.
 *
 * ## The trap
 *
 * Tauri only enforces the ACL for an app's own commands **once an app ACL
 * manifest exists** — and that manifest is generated exactly when
 * `src-tauri/permissions/` contains a permission file. Before the title bar added
 * one, `has_app_acl_manifest` was false and the runtime gate short-circuited, so
 * every app command was allowed without appearing anywhere:
 *
 *     if (plugin_command.is_some() || has_app_acl_manifest || !is_local) && ...
 *
 * The moment a permission file appears, that condition becomes true for EVERY app
 * command. Any command missing from the permission files is then refused with
 * `"<command> not allowed. Command not found"` — a message that names the command
 * but not the cause, and which only surfaces when a user reaches that part of the
 * UI. `probe_state` and `list_versions` both failed this way.
 *
 * ## What this asserts
 *
 * Every command in `generate_handler!` is granted by at least one permission, and
 * every granted name corresponds to a real command. It reads the two files as text
 * rather than parsing TOML, so it needs no dependency and no build.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))

test('bundled overlay paths match the runtime resource lookup and contain the state bridge', () => {
  const config = JSON.parse(readFileSync(join(here, '../src-tauri/tauri.conf.json'), 'utf8'))
  const resources = config.bundle.resources
  assert.equal(Array.isArray(resources), false, 'explicit targets prevent ../ resources from being relocated under _up_')
  for (const file of ['desktop-notify.patch.yml', 'ui-state/package.json', 'ui-state/index.js', 'ui-state/client.js', 'ui-state/bridge.js', 'ui-state/adapter.js',
    'plugin-control/prepare-boot.mjs', 'plugin-control/profile-model.mjs', 'plugin-control/profile-host.mjs', 'plugin-control/marketplace.mjs', 'plugin-control/hot-policy.json', 'plugin-control/protected-modules.json']) {
    assert.equal(resources['../dsh-plugin/' + file], 'dsh-plugin/' + file)
    assert.ok(readFileSync(join(here, file)).length > 0)
  }
})

/**
 * The client plugins the patch mounts from the app's install directory.
 *
 * Each row's host half is what makes the browser half discoverable — without the
 * packaged `package.json`, `dsh-client-modules` has no manifest to read and the
 * feature silently never loads in an installed build, which is exactly the failure
 * a development run cannot show.
 */
test('every client plugin the patch mounts is packaged complete', () => {
  const config = JSON.parse(readFileSync(join(here, '../src-tauri/tauri.conf.json'), 'utf8'))
  const resources = config.bundle.resources
  const patch = readFileSync(join(here, 'desktop-notify.patch.yml'), 'utf8')

  for (const plugin of ['i18n', 'title-bar', 'ui-client', 'sidebar-terminal', 'file-editor']) {
    assert.ok(
      patch.includes(`./${plugin}/index.js`),
      `${plugin} is not mounted by the patch, so nothing serves its browser half`,
    )
    for (const file of ['package.json', 'index.js', 'client.js']) {
      assert.equal(
        resources[`../dsh-plugin/${plugin}/${file}`],
        `dsh-plugin/${plugin}/${file}`,
        `${plugin}/${file} is mounted but not packaged`,
      )
    }
  }
})
const root = join(here, '..')
const mainRs = join(root, 'src-tauri', 'src', 'main.rs')
const permissionsDir = join(root, 'src-tauri', 'permissions')
const capabilitiesDir = join(root, 'src-tauri', 'capabilities')

/**
 * Every command registered with Tauri's IPC.
 *
 * `generate_handler!` is the single source of truth: a command missing from it is
 * unreachable regardless of permissions, and one present in it is reachable by the
 * frontend and therefore subject to the ACL.
 *
 * @returns {string[]} the bare command names, without module paths.
 */
function registeredCommands() {
  const source = readFileSync(mainRs, 'utf8')
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(source)
  assert.ok(block !== null, 'generate_handler! not found in main.rs')
  return block[1]
    .split(',')
    // A command may be registered through its module path (`window_controls::…`,
    // `folder_focus::…`); the ACL grants the bare function name, so the module
    // prefix is stripped whatever module the command lives in.
    .map((entry) => entry.trim().replace(/^[a-z_]+::/, ''))
    .filter((entry) => entry.length > 0)
}

/**
 * Every command name mentioned in a string inside the permission files.
 *
 * Over-collects relative to `commands.allow` (it would also catch a command named
 * in a description), which is the safe direction: the assertion that matters is
 * "nothing registered is unmentioned", and a false positive here can only make
 * that check more permissive for a name that is not a command at all.
 *
 * @returns {Set<string>} the mentioned names.
 */
function grantedCommands() {
  const permissions = readdirSync(permissionsDir).filter(f => f.endsWith('.toml')).map(f => readFileSync(join(permissionsDir, f), 'utf8')).join('\n')
  const names = new Set()
  for (const block of permissions.matchAll(/commands\.allow\s*=\s*\[([^\]]*)\]/g)) for (const match of block[1].matchAll(/"([a-z_]+)"/g)) names.add(match[1])
  return names
}

/**
 * The permission sets referenced by the capabilities in `capabilities/`.
 *
 * A permission that exists but is referenced by no capability is inert, which for
 * the onboarding would look identical to the original bug.
 *
 * @returns {Set<string>} every identifier appearing in a `permissions` array.
 */
function activePermissions() {
  const active = new Set()
  const files = ['default.json', 'title-bar.json']
  for (const file of files) {
    const capability = JSON.parse(readFileSync(join(capabilitiesDir, file), 'utf8'))
    for (const permission of capability.permissions) active.add(permission)
  }
  return active
}

test('every registered app command is granted by a permission', () => {
  const granted = grantedCommands()
  const missing = registeredCommands().filter((command) => !granted.has(command))
  assert.deepEqual(
    missing,
    [],
    `these commands are registered but appear in no permission, so the ACL refuses them with ` +
      `"<command> not allowed. Command not found" once an app ACL manifest exists: ${missing.join(', ')}`,
  )
})

test('every granted command name corresponds to a registered command', () => {
  const registered = new Set(registeredCommands())
  // `boot` is a permission-set identifier, not a command, so it is excluded.
  const extras = [...grantedCommands()].filter(
    (name) => !registered.has(name) && name !== 'boot',
  )
  assert.deepEqual(
    extras,
    [],
    `these names are granted but are not registered commands, which hides a typo: ${extras.join(', ')}`,
  )
})

test('the onboarding permission set is actually granted to a capability', () => {
  // Without this the permission exists but nothing references it, and the
  // onboarding fails exactly as it did before the set was added.
  assert.ok(
    activePermissions().has('boot'),
    'the `boot` permission set is not referenced by any capability, so the local onboarding has no access',
  )
})

test('capabilities split the local onboarding from the remote page', () => {
  const local = JSON.parse(readFileSync(join(capabilitiesDir, 'default.json'), 'utf8'))
  const remote = JSON.parse(readFileSync(join(capabilitiesDir, 'title-bar.json'), 'utf8'))

  // The onboarding must stay local-only: it installs software and starts a process.
  assert.equal(local.remote, undefined, 'the default capability must not grant remote origins')
  assert.ok(local.permissions.includes('boot'), 'the default capability must grant `boot`')

  // The page that renders untrusted content must never be able to install or launch.
  const remoteAll = JSON.stringify(remote.permissions)
  for (const forbidden of ['boot', 'allow-boot-install', 'allow-boot-start']) {
    assert.ok(
      !remoteAll.includes(forbidden),
      `the remote capability must not grant ${forbidden}: that command installs software or starts a process`,
    )
  }
  assert.equal(remote.remote, undefined, 'remote host permissions are granted only for the actual backend origin at runtime')
})
