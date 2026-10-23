// Shared UI setup for disposable DSH smoke profiles. No real provider calls.
export const offlineModelPatch = `
- id: llm-pi-ai
  config:
    providers:
      desktop-smoke:
        api: openai-completions
        baseURL: http://127.0.0.1:9/v1
        apiKeyEnv: DSH_UI_SMOKE_KEY
        models:
          - id: offline-fixture
`

export async function handleOnboarding(page) {
  for (const name of ['继续', '我知道了', '稍后配置', 'Continue', 'Got it', 'Set up later']) {
    await page.addLocatorHandler(page.getByRole('button', { name, exact: true }).and(page.locator(':enabled')),
      button => button.evaluate(element => element.click()))
  }
}

// Call once for a freshly created profile, before opening settings. The welcome
// acknowledgement finishes asynchronously and can otherwise close that dialog.
export async function dismissInitialWelcome(page) {
  const welcome = page.getByRole('button', { name: /^(继续|我知道了|Continue|Got it)$/, includeHidden: true }).first()
  await welcome.evaluate(button => button.click())
  await welcome.waitFor({ state: 'hidden' })
  await page.locator('#root:not([inert])').waitFor()
}

export async function openDshSettings(page) {
  if (await page.locator('[data-shortcut-modal="settings"]').count()) return
  const desktop = page.locator('.dshSidebarSettings__button, .dshAccount__settings')
  const legacy = page.locator('button[aria-haspopup="dialog"]')
  const account = page.getByRole('button', { name: /^(账号菜单|Account menu)$/, includeHidden: true })
  await desktop.or(legacy).or(account).first().waitFor({ state: 'attached' })
  // Finish blocking onboarding before opening another modal. Locator handlers
  // run during this actionability check; raw DOM clicks alone bypass them.
  await page.locator('#root').click({ trial: true })
  if (await page.locator('[data-shortcut-modal="settings"]').count()) return
  // The collapsed desktop sidebar deliberately hides its original trigger.
  if (await desktop.count()) await desktop.first().evaluate(button => button.click())
  else if (await legacy.count()) await legacy.first().evaluate(button => button.click())
  else {
    await account.evaluate(button => button.click())
    await page.getByRole('menuitem', { name: /^(设置|Settings)(\s|$)/ }).click()
  }
  await page.locator('[data-shortcut-modal="settings"]').waitFor()
}

export async function openDshMaintenance(page, kind) {
  const label = kind === 'diagnostics' ? /^(诊断|Diagnostics)$/ : /^(备份与恢复|Backup and restore)$/
  const dialog = page.locator('.dshMaintenance__dialog')
  if (await dialog.getByRole('heading', { name: label, exact: true }).count()) return
  await page.locator('.dshTb__item').filter({ hasText: /^(更多|More)$/ }).click()
  await page.getByRole('menuitem', { name: label }).click()
  await dialog.getByRole('heading', { name: label, exact: true }).waitFor()
}
