export const REPORT_TTL_MS = 5 * 60 * 1000
export function isCurrent(report, identity, now = Date.now()) {
  return report?.schema === 1 && report.runtime?.backendInstance === identity?.backendInstance
    && Number.isFinite(report.observedAt) && now >= report.observedAt && now - report.observedAt <= REPORT_TTL_MS
}
export function statusLabel(status) {
  return ({ checking: '检测中', available: '可用', limited: '受限', unavailable: '不可用', unknown: '未知' })[status] || '未知'
}
export const featureLabels = {
  diagnostics: '故障诊断', 'window-notifications': '窗口与通知', 'terminal-dock': '终端与停靠',
  'session-changes-git': '会话更改与 Git', 'file-editor': '文件编辑', 'appearance-settings': '外观与设置',
  'plugin-management': '插件管理', 'ui-recovery': '草稿与界面恢复', 'lan-mobile': '局域网与手机',
  'session-links-export': '会话引用与导出', 'backup-restore': '备份与恢复', 'runtime-rollback': '运行时回退',
}
export const checkLabels = {node:'Node.js',npm:'npm','dsh-entry':'dsh 安装','data-roots':'数据目录',webview:'WebView2'}
export const verificationLabels = {
  'settings-zh-en':'中英文设置', 'vanilla-navigation':'原版外观入口', 'local-error-page':'本地故障页', 'light-dark':'明暗主题', 'mobile-host-restrictions':'手机宿主权限限制',
  'native-diagnostics-acl':'原生诊断权限', 'feature-contract-reporting':'实际功能接口报告', 'stale-page-rejection':'旧页面身份拒绝',
  'dual-configuration-restore':'双组件配置恢复', 'preview-revision-rejection':'预览后修改拒绝', 'required-ui-ack-rollback':'必要界面确认失败回滚',
  'cold-interruption-rollback':'冷启动中断回滚', 'external-edit-quarantine':'外部编辑冲突隔离', 'cold-draft-attachment-recovery':'跨重启草稿与附件恢复',
  'newer-draft-conflict':'新草稿冲突', 'maintenance-exclusion':'维护互斥', 'acknowledged-cleanup':'确认后清理',
  'workspace-git-selection':'Git 与非仓库工作区切换', 'empty-session-selection':'空页面会话选择',
  'disabled-enhancement-intent':'可选增强关闭意图', 'session-controller-selection':'会话引用与导出接口选择',
  'notification-service-initialization':'原生通知服务初始化',
  'cold-terminal-explicit-skip':'冷恢复明确跳过终端状态', 'cold-terminal-package-retention':'跳过终端后保留原恢复包',
  'background-draft-attachment-checkpoint':'后台草稿与附件检查点', 'same-page-checkpoint-replacement':'同页面检查点替换',
  'native-checkpoint-throttle':'原生检查点频率限制', 'draft-only-cold-recovery':'保留页面选择的草稿冷恢复',
  'older-checkpoint-preservation':'保留旧页面未处理检查点', 'draft-checkpoint-acl':'草稿检查点权限限制',
  'profile-three-component-restore':'Profile 三组件配置恢复', 'profile-target-protection':'Profile 唯一目标与管理保护',
  'profile-runtime-state-verification':'Profile 恢复实际运行状态确认',
}
export const sourceLabels = {configured:'固定入口',managed:'受管安装',private:'私有安装',global:'全局安装'}
export const operationLabels = {restart:'重新启动',update:'更新',restore:'恢复',backup:'备份',rollback:'回退',install:'安装'}
export const stageLabels = {preparing:'准备中','waiting-idle':'等待空闲',capturing:'保存界面状态',checkpointing:'保存检查点',
  'starting-candidate':'启动中',restoring:'恢复界面状态',committing:'提交中','rolling-back':'回退中','recovery-required':'需要恢复'}
export const componentLabels = {sessions:'会话与工作区引用',attachments:'附件','upstream-settings':'上游业务设置',
  'desktop-preferences':'桌面偏好','plugin-intent':'内置增强开关','profile-plugins':'Profile 插件开关',
  changes:'更改快照','remote-preferences':'远程访问配置',drafts:'草稿与未保存编辑',credentials:'认证凭据'}
export const reasons = {
  'snapshot-terminal-cold-unavailable':'原终端进程无法跨应用退出恢复。请保留稍后处理，或在恢复记录中明确选择跳过终端状态。',
  'partial-config-backup-available':'支持部分配置备份、归档校验与同版本偏好恢复；完整数据恢复仍在实施。',
  'backup-restore-transaction-pending':'归档已校验；写入当前数据的恢复事务仍在实施。',
  'backup-restore-preview':'将先保存当前配置与界面状态，再恢复所选配置；失败时尝试回退，冲突时保留双方材料。',
  'backup-restore-unavailable':'当前只能校验此备份，请启动匹配的 DSH 后重新选择文件。',
  'backup-restore-version':'备份与当前 DSH 版本不同，暂不支持跨版本配置恢复。',
  'backup-restore-binding':'当前配置位置与运行时解析结果不一致，未修改配置。',
  'backup-component-unsupported':'此组件尚未支持安全恢复，仍可校验和导出。',
  'backup-profile-unavailable':'当前 Profile 组成无法完整读取，未写入插件开关。',
  'backup-profile-schema':'Profile 插件开关配置无效，未写入当前配置。',
  'backup-profile-version':'Profile 插件开关记录与当前 DSH 版本不匹配。',
  'backup-profile-target':'Profile 开关包含已变更、无法唯一定位或受保护的插件，未写入当前配置。',
  'backup-profile-changed':'Profile 插件组成或开关在预览后变化，请重新校验备份。',
  'backup-profile-locked':'其他操作正持有 Profile 写锁，请稍后重新校验备份。',
  'backup-profile-lock-lost':'Profile 写锁已丢失，恢复材料仍保留，请查看诊断。',
  'backup-profile-verify':'Profile 插件未达到恢复后的运行状态，将尝试回退配置。',
  'backup-preview-expired':'恢复预览已过期或页面已变化，请重新选择备份文件。',
  'backup-target-changed':'配置在预览后发生变化，请重新校验备份文件。',
  'backup-rollback-conflict':'回退遇到外部编辑冲突，当前文件、检查点与恢复包均已保留。',
  'backup-restore-failed':'配置恢复未完成，请查看诊断与恢复记录。',
  'backup-checkpoint-capacity':'配置检查点空间已满，未修改当前配置。',
  'backup-component-selection':'请选择受支持的配置组件。',
  'backup-password-invalid':'请输入有效的备份密码。',
  'backup-password-required':'此备份已加密，请输入密码后重新选择。',
  'backup-authentication':'密码不正确或备份已损坏，未修改当前数据。',
  'backup-kdf-parameters':'备份的密码参数不受支持，未修改当前数据。',
  'backup-provider-empty':'所选范围没有可导出的配置文件。',
  'backup-provider-unavailable':'配置位置尚未确认，请稍后刷新重试。',
  'backup-provider-failed':'配置快照失败，请检查文件后重试。',
  'backup-provider-changed':'配置在快照期间发生变化，请重试。',
  'backup-invalid':'备份格式或完整性校验失败，未修改当前数据。',
  'backup-export-failed':'备份导出失败，原配置仍保留。',
  'backup-archive-entry':'备份包含不支持的路径或超额条目，未修改当前数据。',
  'backup-entry-integrity':'备份条目校验失败，未修改当前数据。',
  'backup-manifest-schema':'备份清单版本或格式不受支持，未修改当前数据。',
  'recovery-binding': '恢复包属于其他数据根或 Profile，未写入当前会话。',
  'recovery-version': '当前 dsh 版本与恢复包不匹配，请使用匹配版本。',
  'recovery-backend-unavailable': '后台未就绪，请先启动匹配的 dsh 再恢复。',
  'recovery-storage-unavailable': '存储服务尚未确认数据根，请稍后重试。',
  'recovery-read-failed': '恢复包校验失败，原文件仍保留。',
  'recovery-save-failed': '恢复包保存失败，原页面和服务已保留。',
  'maintenance-journal-save-failed': '维护记录保存失败，恢复材料仍保留。',
  'maintenance-interrupted': '维护操作被中断，请处理未保存内容恢复包。',
  'ui-restore-failed': '界面恢复失败，恢复包仍保留。',
  'recovery-deferred': '已保留恢复包供稍后处理。',
  'application-exited': '应用退出时维护尚未完成，恢复包仍保留。',
  'legacy-update-failed': '更新失败，请重新检测并处理恢复包。',
  'backend-restart-failed': '后台重新启动失败，请查看诊断并处理恢复包。',
  'provider-root-confirmed': '活动存储服务已确认该数据目录；一致性快照仍待验证。',
  'structured-provider-confirmed': '已确认结构化偏好或插件意图位置；完整备份仍待一致性验证。',
  'schema-secret-classification-partial': '可识别 Schema 标注的凭据；未标注的第三方配置仍需适配。',
  'feature-provider-unreported': '尚未收到该功能的能力报告。',
  'storage-adapter-unverified': '存储映射尚未验证，完整备份暂不可用。',
  'storage-consistency-unverified': '数据一致性接口尚未验证。',
  'runtime-snapshot-unverified': '旧运行时的离线快照尚未验证。',
  'runtime-migration-scope-unverified': '数据迁移范围尚未验证，可靠回退暂不可用。',
  'runtime-explicitly-pinned': '当前入口由 DSH_DESKTOP_DSH 固定。',
  'node-supported': 'Node 版本符合要求。', 'node-missing': '未找到 Node.js。',
  'node-version-unsupported': 'Node 版本不符合要求或检查超时。',
  'npm-probed': 'npm 检查通过。', 'npm-unavailable': 'npm 不可用或检查超时。',
  'runtime-entry-found': '已找到实际运行入口。', 'runtime-entry-missing': '未找到 dsh 入口。',
  'roots-resolved-consistency-unverified': '已解析数据根；一致性与备份范围待验证。',
  'inventory-resolver-unavailable': '该运行时没有可验证的只读目录解析接口。',
  'webview-version-reported': '已读取 WebView2 版本。', 'webview-version-unavailable': '未能读取 WebView2 版本。',
  'terminal-processes-not-restored': '终端标签可恢复；终端进程和命令不会恢复。',
  'profile-management-unavailable': '当前版本的 profile 插件管理不可用。',
  'optional-plugin-load-failed': '可选插件加载失败，请查看插件状态。',
  'capability-report-expired': '该功能的能力报告已过期，请重新检测。',
  'capability-document-changed': '页面已变化，请等待当前页面重新报告能力。',
  'remote-configuration-applying': '正在应用远程配置。',
  'remote-backend-unavailable': '后台未就绪，暂不能使用局域网访问。',
  'remote-local-fallback': '远程配置遇到问题；请查看远程控制设置，现有配置意图仍保留。',
  'remote-access-user-disabled': '远程访问已由用户关闭；检查不会启用监听。',
  'remote-client-reachability-unverified': '监听已启动；手机可达性和网络环境需在对应设备验证。',
  'remote-listener-unconfirmed': '尚未确认当前远程监听，请查看远程控制状态。',
  'capability-selector-failed': '功能接口检查失败，请刷新并查看插件状态。',
  'file-editor-contract-unavailable': '当前版本缺少安全文件编辑所需的服务或关闭确认接口。',
  'file-editor-text-resource-limits': '支持会话工作区的文本文件；大文件、二进制及符号链接受限制。',
  'changes-contract-unavailable': '当前版本缺少更改与 Git 所需的执行服务接口。',
  'changes-no-current-session': '请先打开会话；Git 检测只适用于当前会话工作区。',
  'changes-session-ambiguous': '无法唯一确定当前会话，未沿用其他工作区的结果。',
  'changes-query-interrupted': '工作区检查被中断，请重新检测。',
  'changes-query-failed': '当前工作区查询失败，请重新检测。',
  'changes-response-unrecognized': '当前版本的工作区能力响应尚未适配。',
  'changes-recording-coverage-limited': '支持当前工作区的更改与 Git；采集预算和未受管进程可能造成记录缺口。',
  'changes-workspace-not-git': '当前工作区不在 Git 仓库中；会话更改记录仍可使用。',
  'changes-git-missing': '执行端未找到 Git；会话更改记录仍可使用。',
  'changes-git-unavailable': '当前 Git 仓库读取失败；会话更改记录仍可使用。',
  'session-link-target-preflight': '支持本地会话引用；打开时仍检查目标会话是否存在。',
  'session-links-contract-unavailable': '当前页面缺少会话引用所需的导航或消息接口。',
  'session-export-completion-preflight': '支持会话导出并等待文件保存完成；实际导出仍检查权限与下载结果。',
  'session-export-contract-unavailable': '当前页面缺少桌面会话导出所需的下载或原生接口。',
  'notification-transport-unreported': '尚未收到原生通知服务的初始化结果。',
  'notification-service-unavailable': '原生通知服务初始化失败，请查看诊断记录。',
  'notification-registration-unavailable': '通知身份注册失败；原生服务已启动，通知激活仍受限制。',
  'notification-delivery-failed': '最近一次通知提交或送达失败；请检查 Windows 通知设置。',
  'notification-display-preflight-required': '原生通知服务已初始化；实际显示仍取决于 Windows 通知设置与勿扰模式。',
  'recovery-background-checkpoints-pending': '维护重启时保存草稿和附件；日常后台检查点尚未实现。',
  'recovery-background-checkpoint-limits':'后台保存稳定的语义草稿和附件；不包含文件编辑缓冲与终端，最后一个检查点后的输入可能无法恢复。',
  'ui-recovery-state-preflight-required': '此项检查服务接口；实际恢复仍会检查输入、附件和面板状态。',
  'snapshot-adapter-unsupported': '当前版本缺少安全界面恢复所需的服务接口。',
  'snapshot-layout-unsupported': '当前布局接口不支持安全保存和恢复。',
  'snapshot-navigation-unsupported': '当前版本只能在已打开会话时保存界面。',
  'maintenance-busy': '另一项维护操作正在执行，请稍后重试。',
  'diagnostics-check-busy': '诊断检查正在执行，请稍后重试。',
}

// One in-flight request survives closing or switching dialogs. Stale results must not
// overwrite a newer backend's state; reads never imply a behavior check.
export function createReportStore(invoke, identity, now = Date.now) {
  let snapshot = { report: null, busy: false, error: null, exported: null }, pending, disposed = false
  const listeners = new Set()
  const publish = next => { if (disposed) return; snapshot = { ...snapshot, ...next }; listeners.forEach(fn => fn()) }
  const run = command => {
    if (pending) return pending
    const claimed = identity()
    publish({ busy: true, error: null, exported: null })
    pending = Promise.resolve().then(() => invoke(command, { identity: claimed })).then(result => {
      if (claimed?.backendInstance !== identity()?.backendInstance) return
      if (command === 'desktop_diagnostics_export') publish({ exported: result })
      else if (isCurrent(result, identity(), now())) publish({ report: result })
      else publish({ report: null, error: '诊断报告已过期，请重新检测。' })
    }).catch(error => {
      if (claimed?.backendInstance === identity()?.backendInstance) publish({ error: typeof error === 'string' ? error : error?.message || '诊断操作失败，请重试。' })
    }).finally(() => { pending = null; publish({ busy: false }) })
    return pending
  }
  return { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => snapshot,
    refresh: () => run('desktop_diagnostics'), check: () => run('desktop_diagnostics_check'), export: () => run('desktop_diagnostics_export'),
    dispose() { disposed = true; listeners.clear() } }
}
