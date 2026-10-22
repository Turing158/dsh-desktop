// Recovery navigation is independent of the optional desktop appearance.
export const name = 'desktop-maintenance'
export function apply(ctx) {
  ctx.inject?.(['sessionPersistence','profileContext','settings'], child => {
    const emit = async () => {
      const persistence = child.sessionPersistence, profile = child.profileContext, attachments = child.get('attachments'), settings = child.settings
      let sessionSchema = null
      try { sessionSchema = (await runtimeImport('@deepseek-ai/dsh-session')).SESSION_FORMAT_VERSION } catch {}
      if (!persistence?.root || !profile?.home || !profile?.dir) return
      process.stdout.write('__DSH_STORAGE__ ' + JSON.stringify({schema:1,profileHome:profile.home,profileDirectory:profile.dir,
        sessionRoot:persistence.root,sessionSchema,sessionFlush:typeof persistence.flush==='function',
        attachmentRoot:attachments?.root || null,installAnchor:profile.installAnchor,
        desktopPreferences:settings?.desktop?.file || null,
        pluginIntent:process.env.DSH_DESKTOP_PLUGINS_FILE || join(profile.home,'desktop-plugins.json'),
        profileSwitches:join(profile.dir,PROFILE_SWITCH_FILE),
        upstreamSettings:settings?.documentPath || null,
        credentialClassification:credentialClassification(settings)}) + '\n')
    }
    void emit().catch(() => {})
    const timer = setInterval(() => { void emit().catch(() => {}) },60_000)
    child.effect(() => () => clearInterval(timer))
  })
  ctx.inject?.(['webServer'], child => child.on('webserver/index-inject', table => {
    // Browser-side observations also work in isolated smoke tests. Ordinary
    // browsers retain the bounded cache, but have no native command channel.
    table.push({kind:'script',placement:'head',text:bridge})
  }))
}
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROFILE_SWITCH_FILE } from '../plugin-control/profile-model.mjs'
import { runtimeImport } from '../runtime-import.mjs'
const bridge = readFileSync(new URL('./capability-bridge.js',import.meta.url),'utf8').replace(/<\/script/gi,'<\\/script')
function credentialClassification(settings) {
  try {
    const rows = settings?.describe({redactSecrets:true})
    // Schema-declared secrets are useful classification evidence, never proof
    // that arbitrary plugin configs contain no unmarked credentials.
    return Array.isArray(rows) && rows.some(row => Array.isArray(row.secrets)) ? 'schema-declared-only' : 'unverified'
  } catch { return 'unverified' }
}
