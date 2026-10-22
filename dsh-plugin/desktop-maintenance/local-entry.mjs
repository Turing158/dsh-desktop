import { checkLabels, reasons, operationLabels, stageLabels, sourceLabels } from './model.mjs'
const t = source => window.__DSH_I18N__?.t(source) ?? source
const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke?.bind(window.__TAURI_INTERNALS__)
const el = id => document.getElementById('diagnostics-' + id)
const check = el('check'), exportButton = el('export'), notice = el('notice')
el('title').textContent = t('故障诊断')
check.textContent = t('重新检测'); exportButton.textContent = t('导出诊断报告')
el('policy').textContent = t('默认报告省略私人路径、凭据、聊天正文和原始子进程输出，包含结构化状态、检查结果及能力清单。')
const statuses = {available:'可用',limited:'受限',unavailable:'不可用',unknown:'未知'}
async function run(command) {
  check.disabled = exportButton.disabled = true
  notice.textContent = t('正在执行诊断操作…')
  try {
    const report = await invoke(command)
    if(command === 'desktop_diagnostics_export') {
      notice.textContent = report ? (window.__DSH_I18N__?.t('报告已保存：{path}',{path:report}) ?? report) : t('已取消导出')
      return
    }
    const rt = report.runtime
    const rows = [['桌面版本',rt.desktopVersion],['实际 dsh 版本',rt.dshVersion],['实际运行入口',rt.dshEntry],['运行时来源',t(sourceLabels[rt.dshSource] || '未知')],['Node 版本',rt.nodeVersion],['npm 版本',rt.npmVersion],['WebView2 版本',rt.webviewVersion]]
    el('facts').replaceChildren(...rows.flatMap(([name,value]) => ['dt','dd'].map((tag,index) => {
      const node = document.createElement(tag); node.textContent = index ? value ?? t('未知') : t(name); return node
    })))
    el('checks').replaceChildren(...report.checks.map(check => {
      const node = document.createElement('p'); node.textContent = t(checkLabels[check.id] || check.id) + ' — ' + t(statuses[check.status] || '未知') + ' · ' + t(reasons[check.reasonCode] || check.reasonCode); return node
    }), ...report.incompleteOperations.map(record => {
      const node = document.createElement('p')
      node.textContent = new Date(record.updatedAt).toLocaleString() + ' · ' + t(operationLabels[record.kind] || record.kind)
        + ' · ' + t(stageLabels[record.stage] || record.stage) + (record.errorCode ? ' · ' + t(reasons[record.errorCode] || record.errorCode) : '')
      return node
    }))
    notice.textContent = report.incompleteOperations.length ? t('发现未完成的维护记录，请保留恢复材料。')
      : report.unreadableJournals ? t('部分维护记录无法读取，请保留文件并查看诊断。') : t('诊断状态已更新')
    const recovery = await invoke('desktop_recovery_list')
    if (recovery.entries.length) notice.textContent += ' · ' + t('发现未保存内容恢复包，请启动匹配的 dsh 后在备份与恢复中处理。')
    if (recovery.unreadable) notice.textContent += ' · ' + t('部分恢复包无法读取，原文件仍保留。')
  } catch(error) { const code = String(error?.message ?? error); notice.textContent = t(reasons[code] || code) }
  finally {check.disabled = exportButton.disabled = false}
}
check.addEventListener('click',() => run('desktop_diagnostics_check'))
exportButton.addEventListener('click',() => run('desktop_diagnostics_export'))
await run('desktop_diagnostics')
