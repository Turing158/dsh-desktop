const PACKAGE = 'dshmarket'

function failureMessage(result) {
  if (result.pendingBuilds?.length) return '安装依赖需要确认构建脚本，请在 DSH 插件管理中处理后重试。'
  if (result.error?.code === 'incompatible-version') return '当前版本的 dshmarket 与 DSH 不兼容，请更新 DSH 后重试。'
  if (result.application === 'cancelled') return '安装已取消。'
  const detail = result.error?.diagnostic || result.packageResult?.output
  return detail ? `安装失败：${detail.slice(-1500)}` : '插件未能启用，请在 DSH 插件管理中查看详情。'
}

// The native manager owns profile locking, registry selection, compatibility
// checks and rollback. Keep the operation alive across settings/tab remounts.
export function createMarketplaceInstaller(getManager) {
  let pending = null, error = '', restartRequired = false
  async function status() {
    const manager = getManager()
    const base = { available: Boolean(manager?.installBundle), installing: Boolean(pending), error, restartRequired: false }
    if (!manager?.listBundles) return { ...base, installed: null }
    try {
      const bundle = (await manager.listBundles()).find(item => item.name === PACKAGE)
      return { ...base, installed: Boolean(bundle), restartRequired: Boolean(bundle?.enabled && restartRequired) }
    } catch (e) {
      return { ...base, installed: null, error: `无法检查插件市场：${e.message}` }
    }
  }
  function install() {
    if (pending) return pending
    // Set pending before the first async read so two clients cannot start two installs.
    pending = Promise.resolve().then(async () => {
      error = ''
      const current = await status()
      if (current.installed) return
      if (!current.available) throw Error('当前宿主不提供插件安装服务。')
      if (current.installed === null) throw Error(current.error || '无法检查插件市场，请稍后重试。')
      const result = await getManager().installBundle(PACKAGE, { enabled: true })
      restartRequired = result.application === 'restart-required'
      if (!['applied', 'restart-required'].includes(result.application)) error = failureMessage(result)
    }).catch(e => { error = e.message || '安装失败，请稍后重试。' }).finally(() => { pending = null })
    return pending
  }
  return { status, install }
}
