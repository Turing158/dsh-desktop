import { t, useLocale } from '../i18n/api.mjs'
import { createReportStore, featureLabels, checkLabels, sourceLabels, componentLabels, reasons, statusLabel, isCurrent, operationLabels, stageLabels, verificationLabels } from './model.mjs'
import styleText from './style.css'

window.__ModuleLoader__.load({ id: '@dsh-desktop/maintenance', factory(require) {
  const React = require('react'), h = React.createElement
  const { Button, Modal } = require('@deepseek-ai/dsh-client-ui-primitives')
  function apply(ctx) {
    const desktop = window.top === window && typeof window.__TAURI__?.core?.invoke === 'function'
    const store = desktop ? createReportStore((cmd, args) => window.__TAURI__.core.invoke(cmd, args), () => window.__DSH_REMOTE_IDENTITY__) : null
    const style = document.createElement('style'); style.textContent = styleText; document.head.appendChild(style)
    const row = (label, value) => h('div', { className: 'dshMaintenance__row', key: label }, h('dt', null, t(label)), h('dd', null, value ?? t('未知')))
    const reason = code => t(reasons[code] || code)
    function BackupTools() {
      const [selected, setSelected] = React.useState(['desktop-preferences','plugin-intent','profile-plugins'])
      const [encrypted, setEncrypted] = React.useState(false), [password, setPassword] = React.useState('')
      const [state, setState] = React.useState({busy:false,error:null,path:null,preview:null,cancelled:false})
      const [restoreSelected,setRestoreSelected] = React.useState([]), [confirmed,setConfirmed] = React.useState(false)
      const run = async command => {
        setConfirmed(false);setRestoreSelected([])
        setState({busy:true,error:null,path:null,preview:null,cancelled:false})
        try {
          const result = await window.__TAURI__.core.invoke(command, {identity:window.__DSH_REMOTE_IDENTITY__,
            ...(command === 'desktop_backup_export' ? {components:selected} : {}),password:encrypted ? password : null})
          setState({busy:false,error:null,path:command === 'desktop_backup_export' ? result : null,
            preview:command === 'desktop_backup_inspect' ? result : null,cancelled:result === null})
          if (command === 'desktop_backup_inspect') setRestoreSelected(result?.supportedComponents ?? [])
        } catch(error) {setState({busy:false,error:String(error?.message ?? error),path:null,preview:null,cancelled:false})}
        finally {setPassword('')}
      }
      const restore = async () => {
        const bridge=window.__DSH_UI_STATE__,identity=window.__DSH_REMOTE_IDENTITY__
        setState(value=>({...value,busy:true,error:null}))
        try {
          if (!bridge?.prepareRemoteApply) throw Error(t('页面保存服务尚未准备好，请稍后重试'))
          const payload=await bridge.prepareRemoteApply(state.preview.manifest.dshVersion,t('正在保存当前界面并恢复配置…'),{configurationRestore:true})
          await window.__TAURI__.core.invoke('desktop_backup_restore',{identity,restoreHandle:state.preview.restoreHandle,components:restoreSelected,payload})
        } catch(error) {
          bridge?.finishRemoteApply()
          setState(value=>({...value,busy:false,error:String(error?.message ?? error)}))
        }
      }
      const preview = state.preview?.manifest
      return h('div',{className:'dshMaintenance__card dshMaintenance__tools','aria-busy':state.busy,'data-dsh-configuration-restore':state.preview?.canRestore ? '' : undefined},
        h('h3',null,t('配置备份与恢复')),
        h('p',{className:'dshMaintenance__note'},t('备份桌面偏好和插件开关，可恢复到相同版本的 dsh。')),
        h('p',{className:'dshMaintenance__note'},t('此备份不包含会话、附件、草稿、业务配置或凭据。')),
        h('fieldset',{disabled:state.busy,className:'dshMaintenance__choices'},h('legend',null,t('导出范围')),
          ['desktop-preferences','plugin-intent','profile-plugins'].map(id => h('label',{key:id},
            h('input',{type:'checkbox',checked:selected.includes(id),onChange:event => setSelected(value => event.target.checked ? [...value,id] : value.filter(item => item !== id))}),t(componentLabels[id])))),
        h('label',{className:'dshMaintenance__choice'},h('input',{type:'checkbox',checked:encrypted,disabled:state.busy,onChange:event => {setEncrypted(event.target.checked);setPassword('')}}),t('使用密码加密或打开加密备份')),
        encrypted && h('label',{className:'dshMaintenance__password'},t('备份密码'),h('input',{type:'password',autoComplete:'new-password',value:password,maxLength:256,disabled:state.busy,onChange:event => setPassword(event.target.value)})),
        h('div',{className:'dshMaintenance__actions'},
          h(Button,{disabled:state.busy || !selected.length || encrypted && !password,onClick:() => run('desktop_backup_export')},t('导出部分备份')),
          h(Button,{disabled:state.busy || encrypted && !password,onClick:() => run('desktop_backup_inspect')},t('校验备份文件'))),
        state.busy && h('p',{role:'status'},t('正在处理备份…')),
        state.cancelled && h('p',{role:'status'},t('已取消')),
        state.error && h('p',{role:'alert'},reason(state.error)),
        state.path && h('p',{role:'status'},t('备份已保存：{path}',{path:state.path})),
        preview && h('div',null,
          h('p',{role:'status'},t('备份校验通过')),
          h('p',null,new Date(preview.createdAt).toLocaleString() + ' · dsh ' + preview.dshVersion + ' · ' + t(preview.scope === 'partial' ? '部分备份' : '完整备份')),
          h('p',null,t('包含：{items}',{items:preview.components.map(item => t(componentLabels[item.id] || item.id)).join('、')})),
          h('p',{className:'dshMaintenance__note'},t('排除：{items}',{items:preview.excluded.map(item => t(componentLabels[item] || item)).join('、')})),
          h('p',null,reason(state.preview.reasonCode)),
          state.preview.unsupportedComponents.length>0 && h('p',{className:'dshMaintenance__note'},t('暂不恢复：{items}',{items:state.preview.unsupportedComponents.map(id=>t(componentLabels[id] || id)).join('、')})),
          state.preview.canRestore && h(React.Fragment,null,
            h('fieldset',{disabled:state.busy,className:'dshMaintenance__choices'},h('legend',null,t('恢复范围')),
              state.preview.supportedComponents.map(id=>h('label',{key:id},h('input',{type:'checkbox',checked:restoreSelected.includes(id),onChange:event=>{setConfirmed(false);setRestoreSelected(value=>event.target.checked ? [...value,id] : value.filter(item=>item!==id))}}),t(componentLabels[id])))),
            h('label',{className:'dshMaintenance__choice'},h('input',{type:'checkbox',checked:confirmed,disabled:state.busy,onChange:event=>setConfirmed(event.target.checked)}),t('我已核对范围，恢复将替换所选偏好或开关并重启 DSH。')),
            h(Button,{disabled:state.busy || !confirmed || !restoreSelected.length,onClick:restore},t('恢复所选配置')))),
        h('details',{className:'dshMaintenance__disclosure'},h('summary',null,t('恢复说明')),
          h('p',{className:'dshMaintenance__note'},t('可导出并恢复同版本的桌面偏好和插件开关。Profile 开关恢复须匹配当前唯一插件及保护规则；不会安装插件。会话、附件、草稿及业务配置不在此备份中。'))))
    }
    function RecoveryPackages() {
      const [state, setState] = React.useState({ entries: [], unreadable: 0, busy: false, error: null })
      const refresh = async () => {
        setState(value => ({ ...value, busy: true, error: null }))
        try {
          const identity = window.__DSH_REMOTE_IDENTITY__
          const result = await window.__TAURI__.core.invoke('desktop_recovery_list', { identity })
          if (identity?.backendInstance !== window.__DSH_REMOTE_IDENTITY__?.backendInstance) return
          setState({ ...result, busy: false, error: null })
        } catch (error) { setState(value => ({ ...value, busy: false, error: String(error?.message ?? error) })) }
      }
      React.useEffect(() => { void refresh() }, [])
      const restore = async (recoveryId,skipTerminalState=false) => {
        setState(value => ({ ...value, busy: true, error: null }))
        try { await window.__TAURI__.core.invoke('desktop_recovery_restore', { identity: window.__DSH_REMOTE_IDENTITY__, recoveryId,skipTerminalState }) }
        catch (error) { setState(value => ({ ...value, error: String(error?.message ?? error) })) }
        finally { setState(value => ({ ...value, busy: false })) }
      }
      return h('div', { className: 'dshMaintenance__card dshMaintenance__tools', 'aria-busy': state.busy },
        h('h3', null, t('未保存内容恢复')),
        h('p', { className: 'dshMaintenance__note' }, t('找回意外退出或重启前保存的草稿、附件及支持的未保存文件编辑。')),
        h('div',{className:'dshMaintenance__actions'},h(Button, { onClick: refresh, disabled: state.busy }, t('刷新恢复记录'))),
        state.busy && h('p',{role:'status'},t('正在处理恢复记录…')),
        state.error && h('p', { role: 'alert' }, reason(state.error)),
        state.unreadable > 0 && h('p', { role: 'alert' }, t('部分恢复包无法读取，原文件仍保留。')),
        !state.busy && state.entries.length === 0 && h('p', null, t('没有待处理的恢复包。')),
        state.entries.map(entry => h('div', { key: entry.recoveryId, className: 'dshMaintenance__card dshMaintenance__tools','data-dsh-recovery-id':entry.recoveryId },
          h('p', null, new Date(entry.createdAt).toLocaleString()),
          h('p', null, t('草稿：{count}', { count: entry.draftCount })),
          entry.draftsOnly && h('p',{className:'dshMaintenance__note'},t('日常草稿检查点；恢复保留当前页面选择与布局。')),
          entry.hasTerminalState && h('p',{className:'dshMaintenance__note'},t('原终端进程无法跨应用退出恢复。可跳过终端状态恢复其余内容；不会新建 Shell 或重放命令，原包继续保留。')),
          entry.reasonCode && h('p', null, reason(entry.reasonCode)),
          entry.hasTerminalState ? h(Button, {disabled:state.busy || !entry.canRestore,onClick:()=>restore(entry.recoveryId,true)},t('跳过终端状态，恢复其余内容'))
            : h(Button, { disabled: state.busy || !entry.canRestore, onClick: () => restore(entry.recoveryId) }, t('恢复未保存内容')),
          h('details',{className:'dshMaintenance__disclosure'},h('summary',null,t('恢复记录详情')),
            h('p',null,'dsh ' + entry.runtimeVersion),h('p',{className:'dshMaintenance__note'},t('状态提供器：{count}',{count:entry.providerCount}))))),
        h('details',{className:'dshMaintenance__disclosure'},h('summary',null,t('保存与恢复说明')),
          h('div',{className:'dshMaintenance__stack'},
            h('p',{className:'dshMaintenance__note'},t('恢复包保留草稿、附件和支持的编辑缓冲；恢复前检查当前会话和文件，失败时保留副本。')),
            h('p',{className:'dshMaintenance__note'},t('日常检查点保存稳定的草稿和附件，每次写入至少间隔 30 秒；文件编辑与终端仅按维护恢复策略处理。')),
            h('p',{className:'dshMaintenance__note'},t('后台保存稳定的语义草稿和附件；不包含文件编辑缓冲与终端，最后一个检查点后的输入可能无法恢复。')))))
    }
    function FeatureStatus({ report }) {
      return h('details',{className:'dshMaintenance__card dshMaintenance__disclosure','data-dsh-feature-status':''},
        h('summary',null,t('功能状态')),
        h('div',{className:'dshMaintenance__stack'},
          h('p',{className:'dshMaintenance__note'},t('检测结果与实机验证分别显示。未知状态表示尚无可靠证据。')),
          report.capabilities.map(feature => h('div', { key: feature.featureId, className: 'dshMaintenance__card','data-dsh-feature-id':feature.featureId },
            h('div', { className: 'dshMaintenance__head' }, h('h3', null, t(featureLabels[feature.featureId] || feature.featureId)), h('span', null, t(statusLabel(feature.availability)))),
            feature.reasonCodes.map(code => h('p', { key: code, className: 'dshMaintenance__note' }, reason(code))),
            h('details', null, h('summary', null, t('查看详情')), h('dl', null,
              row('当前实现', feature.implementation ? t(({desktop:'桌面补充',upstream:'上游原生',hybrid:'混合实现'})[feature.implementation]) : t('未知')),
              row('插件状态', t(({enabled:'已启用','user-disabled':'用户已关闭','pending-restart':'待重启','load-failed':'加载失败',unknown:'未知'})[feature.pluginState] || '未知')),
              row('适用范围', t(feature.scope === 'current-interface' ? '当前界面' : feature.scope === 'current-workspace' ? '当前工作区' : '全局')),
              row('验证信息', t(feature.verification?.length ? '已验证列出的隔离环境场景；不代表整版或其他环境全部兼容。' : '尚无匹配版本和架构的验证记录'))),
              feature.verification?.map((record,index)=>h('div',{key:index,className:'dshMaintenance__note'},
                h('p',null,record.date+' · DSH '+record.version+' · '+record.platform+' '+record.architecture+' · '+t(record.nativeHostMocked ? '宿主接口模拟' : '真实桌面宿主')),
                h('p',null,record.checks.map(check=>t(verificationLabels[check] || check)).join(' · ')),h('code',null,record.evidence))),
              feature.evidence.map(evidence => h('code', { key: evidence }, evidence)))))))
    }
    function Section({ kind }) {
      useLocale(React)
      const state = React.useSyncExternalStore(store?.subscribe || (() => () => {}), store?.getSnapshot || (() => null))
      React.useEffect(() => { if (store && kind === 'diagnostics') void store.refresh() }, [kind])
      if (!desktop) return h('div', { className: 'dshMaintenance' }, h('p', null, t('诊断和维护操作请在电脑桌面应用中执行。')))
      if (kind === 'backup') return h('div',{className:'dshMaintenance'},h(BackupTools),h(RecoveryPackages))
      const report = state.report && isCurrent(state.report, window.__DSH_REMOTE_IDENTITY__) ? state.report : null
      const controls = h('div', { className: 'dshMaintenance__actions' },
        h(Button, { onClick: async () => { await window.__DSH_CAPABILITIES__?.refresh(); return store.check() }, disabled: state.busy }, t('重新检测')),
        kind === 'diagnostics' && h(Button, { onClick: () => store.export(), disabled: state.busy || !report }, t('导出诊断报告')))
      let content
      if (report && kind === 'diagnostics') {
        const rt = report.runtime
        content = h(React.Fragment, null,
          h('div', { className: 'dshMaintenance__card' }, h('dl', null,
            row('桌面版本', rt.desktopVersion), row('架构', rt.architecture), row('实际 dsh 版本', rt.dshVersion),
            row('实际运行入口', rt.dshEntry), row('运行时来源', t(sourceLabels[rt.dshSource] || '未知')), row('Node 版本', rt.nodeVersion),
            row('npm 版本', rt.npmVersion), row('WebView2 版本', rt.webviewVersion), row('后端状态', t(rt.backendLoaded ? '界面已加载' : '等待界面加载')),
            row('最近检查', report.checkedAt ? new Date(report.checkedAt).toLocaleString() : t('尚未执行检查')))),
          report.checks.map(check => h('div', { key: check.id, className: 'dshMaintenance__card' }, h('div', { className: 'dshMaintenance__head' }, h('strong', null, t(checkLabels[check.id] || check.id)), h('span', null, t(statusLabel(check.status)))), h('p', { className: 'dshMaintenance__note' }, reason(check.reasonCode)))),
          h(FeatureStatus,{report}),
          h('p', { className: 'dshMaintenance__note' }, t('默认报告省略私人路径、凭据、聊天正文和原始子进程输出，包含结构化状态、检查结果及能力清单。')),
          report.incompleteOperations.length > 0 && h('p', { role: 'alert' }, t('发现未完成的维护记录，请保留恢复材料。')),
          report.incompleteOperations.map(record => h('div', { key: record.operationId, className: 'dshMaintenance__card' },
            h('p', null, new Date(record.updatedAt).toLocaleString() + ' · ' + t(operationLabels[record.kind] || record.kind) + ' · ' + t(stageLabels[record.stage] || record.stage)),
            record.errorCode && h('p', { className: 'dshMaintenance__note' }, reason(record.errorCode)))),
          report.unreadableJournals > 0 && h('p', { role: 'alert' }, t('部分维护记录无法读取，请保留文件并查看诊断。')))
      }
      return h('div', { className: 'dshMaintenance', 'aria-busy': state.busy }, controls,
        state.busy && h('p', { role: 'status' }, t('正在执行诊断操作…')),
        state.error && h('p', { role: 'alert', className: 'dshMaintenance__error' }, reason(state.error)),
        state.exported && h('p', { role: 'status' }, t('报告已保存：{path}', { path: state.exported })),
        report ? content : h('p', { role: 'status' }, t('等待读取当前运行时状态…')))
    }
    function MaintenanceDialogs() {
      useLocale(React)
      const [kind, setKind] = React.useState(null)
      React.useEffect(() => {
        const open = event => {
          const next = event.detail?.kind
          if (next === null || desktop && ['diagnostics', 'backup'].includes(next)) setKind(next)
        }
        document.addEventListener('dsh-desktop:maintenance-dialog', open)
        return () => document.removeEventListener('dsh-desktop:maintenance-dialog', open)
      }, [])
      if (!kind) return null
      return h(Modal, {
        open: true,
        onClose: () => setKind(null),
        title: t(kind === 'diagnostics' ? '诊断' : '备份与恢复'),
        closeLabel: t('关闭弹窗'),
        className: 'dshMaintenance__dialog',
        contentClassName: 'dshMaintenance__content',
      }, h(Section, { key: kind, kind }))
    }
    const off = ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'desktop-maintenance-dialogs', order: 10 }, MaintenanceDialogs))
    return () => { off?.(); store?.dispose(); style.remove() }
  }
  return { inject: ['slots', 'locale'], apply }
} })
