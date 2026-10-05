import { t, useLocale } from '../i18n/api.mjs'
// Preserve DSH's inventory layout; desktop enablement is an additional control
// shared by preset and global rows, independent from the disclosure button.
export function presetInventoryRow(row, preset, index, plugins) {
  const candidates = plugins.filter(plugin => plugin.moduleName === row.moduleName)
  const exact = candidates.filter(plugin => row.entryId && plugin.entryId === row.entryId)
  const matches = exact.length ? exact : candidates
  const target = matches.length === 1 ? matches[0] : null
  return { ...row, ...(target || {}), source: 'preset', id: `preset:${preset.id}:${index}`,
    presetName: preset.name, switchId: target?.id, presetEnabled: row.enabled,
    enabled: target?.enabled ?? row.enabled === true, conditional: !target && row.enabled === 'conditional',
    readOnlyReason: target ? target.readOnlyReason : 'unaddressable',
    phase: target?.phase ?? (row.enabled === false ? 'disabled' : row.fiberPhase || 'inactive') }
}
// Keep column membership dependent only on the list, never on expanded heights.
export function renderPluginColumns(h, cards) {
  const split = Math.ceil(cards.length / 2)
  return h('div', { className: 'dshInventory__cards' },
    [cards.slice(0, split), cards.slice(split)].map((column, index) =>
      h('ul', { key: index, className: 'dshInventory__column' }, column)))
}

export function createInventoryView({ React, ui, useStatus, RestartCard, ClientSync, displayRow, change, refresh, feedback, isBusy, readOnlyText, phases, presetName }) {
  const h = React.createElement
  const { Switch, Menu, Tag, StateDot, IconSearchOutlineRegular: Search, IconChevronDownOutlineRegular: Chevron } = ui
  const cls = name => 'dshInventory__' + name
  const subtitle = id => id?.replace(/^include:/, '')
  const hasIdentity = row => row.entryId && subtitle(row.entryId) !== row.label

  function Card({ row, open, toggle, providers, onPreset }) {
      useLocale(React)
    const detailId = 'plugin-details-' + encodeURIComponent(row.id), descriptionId = React.useId()
    const description = row.meta?.description ? row.hint : undefined
    const failed = Boolean(row.error) || row.fiberPhase === 'failed'
    const kind = failed ? 'danger' : row.restart || row.application === 'overridden' || row.conditional ? 'warning' : providers?.length ? 'info' : 'neutral'
    const stateText = row.error ? t('切换失败') : failed ? t('启动失败') : row.restart ? t('等待重启') : row.application === 'overridden' ? t('配置未生效')
      : row.conditional ? t('条件启用') : providers?.length ? t('预设中启用') : row.enabled ? t('已启用') : t('已停用')
    const dot = (row.running ?? row.enabled) && ({ pending: 'idle', loading: 'ongoing', unloading: 'ongoing' })[row.fiberPhase]
    const facts = row.source === 'preset'
      ? [[t('来自'), row.presetName], [t('全局开关'), row.enabled ? t('已启用') : t('已停用')],
        [t('预设配置'), row.presetEnabled === 'conditional' ? t('条件启用') : row.presetEnabled ? t('已启用') : t('已停用')],
        [t('生效方式'), row.readOnlyReason ? readOnlyText(row.readOnlyReason) : row.hot ? t('立即生效') : t('重启 DSH 后生效')],
        ...(row.fiberPhase ? [[t('运行状态'), phases[row.fiberPhase]]] : []), ...(row.condition ? [[t('禁用条件'), h('code', null, row.condition)]] : [])]
      : [[t('配置状态'), providers?.length ? t('全局已停用，由 Agent 预设按会话提供') : row.enabled ? t('已启用') : t('已停用')],
        ...(providers?.length ? [[t('启用于'), h('span', { className: cls('enabledIn') },
          h('span', null, providers.map(presetName).join(' · ')), h('button', { type: 'button', className: cls('jumpLink'), onClick: () => onPreset(providers[0].id) }, t('去预设分组查看')))]] : [[t('运行状态'), phases[row.phase] || row.phase]]),
        [t('生效方式'), row.readOnlyReason ? readOnlyText(row.readOnlyReason) : row.hot ? t('立即生效') : t('重启 DSH 后生效')], ...(row.version ? [[t('版本'), row.version]] : [])]
    return h('li', { className: cls('card'), 'data-plugin-id': row.id, 'data-plugin-entry': row.entryId || undefined, 'data-plugin-module': row.moduleName,
      'data-open': open ? 'true' : undefined, 'data-failed': failed ? 'true' : undefined, 'data-switch': 'true' },
      h('div', { className: cls('cardHead') },
        h('button', { type: 'button', className: cls('cardContent'), 'aria-expanded': open, 'aria-controls': detailId,
          'aria-label': `${row.label}${hasIdentity(row) ? ', ' + row.entryId : ''}, ${stateText}`, 'aria-describedby': description ? descriptionId : undefined, onClick: toggle },
          h('span', { className: cls('cardMainRow') },
            h('strong', { className: cls('cardTitle'), title: row.moduleName }, row.label),
            h('span', { className: cls('cardTrailing') },
              dot && h('span', { className: cls('phaseDot'), role: 'img', 'aria-label': phases[row.fiberPhase], title: phases[row.fiberPhase] }, h(StateDot, { state: dot })),
              stateText !== t('已启用') && h(Tag, { tone: kind }, stateText), h(Chevron, { className: cls('chevron'), size: 12, 'aria-hidden': true }))),
          description && h('span', { className: cls('cardDescription'), id: descriptionId }, description),
          hasIdentity(row) && h('span', { className: cls('cardMeta') }, h('code', { className: cls('cardIdentity'), title: row.entryId }, subtitle(row.entryId)))),
        h('div', { className: cls('cardSwitch') }, h(Switch, { checked: row.enabled, label: row.label,
          disabled: isBusy() || Boolean(row.readOnlyReason), onChange: enabled => change(row.switchId || row.id, enabled, 'profile') }))),
      row.meta?.error && h('p', { className: cls('brokenNote'), role: 'status' }, row.meta.error),
      open && h('div', { className: cls('cardDetails'), id: detailId },
        row.entryId && h('code', { className: cls('entryValue'), 'data-loader-entry': true }, row.entryId),
        h('dl', { className: cls('details') }, [[t('完整名称'), row.moduleName], ...facts].map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value)))),
        row.hotReason && !row.readOnlyReason && h('p', { className: cls('detailNote') }, row.hotReason),
        row.restart && h('p', { className: cls('detailNote') }, t('已保存，重启后生效。改回当前运行状态可取消。')),
        row.application === 'overridden' && h('p', { className: cls('brokenNote') }, t('已保存设置与实际状态不一致，请检查父组、配置覆盖或启动诊断。'))),
      row.error && h('p', { className: cls('brokenNote'), role: 'alert' }, row.error, ' ',
          h('button', { type: 'button', disabled: isBusy() || Boolean(row.readOnlyReason), onClick: () => change(row.switchId || row.id, row.enabled, 'profile') }, t('重试切换'))))
  }

  return function Inventory() {
      useLocale(React)
    const state = useStatus(), sectionId = React.useId()
    const [query, setQuery] = React.useState(''), [chosenPreset, setChosenPreset] = React.useState(null), [expanded, setExpanded] = React.useState(null)
    const [switcherOpen, setSwitcherOpen] = React.useState(false), [presetOpen, setPresetOpen] = React.useState(true), [globalOpen, setGlobalOpen] = React.useState(false)
    const presets = state?.agentPresets || [], selected = presets.find(p => p.id === chosenPreset) || presets.find(p => p.isDefault) || presets[0]
    const search = query.trim().toLocaleLowerCase(), searching = Boolean(search)
    const matches = row => !search || [row.label, row.hint, row.moduleName, row.entryId].some(text => text?.toLocaleLowerCase().includes(search))
    const presetRows = p => p.rows.map((row, index) => displayRow(presetInventoryRow(row, { ...p, name: presetName(p) }, index, state?.plugins || [])))
    const selectedRows = selected ? presetRows(selected).filter(matches) : []
    const otherMatches = searching ? presets.filter(p => p !== selected).map(p => ({ preset: p, count: presetRows(p).filter(matches).length })).filter(p => p.count) : []
    const globalRows = (state?.plugins || []).map(displayRow).filter(matches)
    const failedRows = globalRows.filter(row => row.fiberPhase === 'failed' || row.error)
    const sortedRows = [...failedRows, ...globalRows.filter(row => !failedRows.includes(row))]
    const enabledIn = moduleName => presets.filter(p => p.rows.some(row => row.moduleName === moduleName && row.enabled === true))
    const toggleRow = id => setExpanded(current => current === id ? null : id)
    const showPreset = id => { setChosenPreset(id); setPresetOpen(true) }
    const presetLabel = p => presetName(p) + (p.broken ? t('（加载失败）') : p.isDefault ? t('（默认）') : '')
    const error = feedback()
    const cards = rows => renderPluginColumns(h, rows.map(row => h(Card, { key: row.id, row, open: expanded === row.id,
      toggle: () => toggleRow(row.id), providers: row.source === 'profile' && !row.running && !row.restart ? enabledIn(row.moduleName) : [], onPreset: showPreset })))
    const groupToggle = (title, id, open, onToggle) => h('button', { type: 'button', className: cls('groupToggle'), 'aria-expanded': open, 'aria-controls': id, onClick: onToggle },
      h(Chevron, { className: cls('chevron'), size: 12, 'aria-hidden': true }), h('span', { className: cls('groupTitle') }, title))
    const presetEffectiveOpen = searching || presetOpen, globalEffectiveOpen = searching || globalOpen
    return h('div', { className: 'dshPlugins dshInventory', 'data-dsh-plugin-inventory': true, 'aria-busy': !state },
      h('div', { className: 'dshPlugins__summary' },
        h('p', { className: 'dshPlugins__intro' }, t('开关会自动保存。支持热切换的插件立即生效，其余插件在重启 DSH 后生效。')),
        h(RestartCard, { state })),
      h(ClientSync),
      error && h('p', { role: 'alert', className: cls('brokenNote') }, error, ' ', h('button', { type: 'button', onClick: refresh }, t('重试'))),
      (state?.notices || []).map((notice, index) => h('p', { key: index, className: cls('brokenNote') }, notice)),
      !state ? h('p', { role: 'status' }, t('正在读取插件…')) : h('div', { className: cls('catalog') },
        h('label', { className: cls('search') }, h(Search, { 'aria-hidden': true }),
          h('input', { type: 'search', 'aria-label': t('搜索插件'), placeholder: t('搜索插件'), value: query, onChange: event => setQuery(event.target.value) })),
        !state.managementAvailable && h('p', { className: cls('status') }, t('当前宿主不提供插件管理，列表仅供查看。')),
        searching && !globalRows.length && !selectedRows.length && !otherMatches.length && h('p', { className: cls('status') }, t('没有匹配的插件')),
        selected && h('section', { className: cls('group'), 'data-plugin-scope': 'preset', 'data-preset-id': selected.id },
          h('div', { className: cls('groupTitleRow') }, groupToggle(t('会话插件'), sectionId + '-preset', presetEffectiveOpen, () => setPresetOpen(!presetEffectiveOpen)),
            h('div', { className: cls('headerEnd') }, h(Menu, { open: switcherOpen, onClose: () => setSwitcherOpen(false),
              items: presets.map(p => ({ id: p.id, label: presetLabel(p) })), selectedId: selected.id, onSelect: id => { setSwitcherOpen(false); setChosenPreset(id) }, align: 'end', portal: true,
              anchor: h('button', { type: 'button', className: cls('switcher'), 'aria-haspopup': 'menu', 'aria-expanded': switcherOpen,
                'aria-label': t('选择要查看的 Agent 预设'), onClick: () => setSwitcherOpen(open => !open) },
                h('span', { className: cls('switcherLabel') }, presetLabel(selected)), h(Chevron, { className: cls('chevron'), 'aria-hidden': true })) }))),
          h('p', { className: cls('groupSub') }, h('span', null, t('由 Agent 预设按会话组成，开关与全局插件同步')), h('span', { 'data-preset-plugin-count': selectedRows.length }, selectedRows.length + t(' 个'))),
          presetEffectiveOpen && h('div', { id: sectionId + '-preset', className: cls('groupBody') },
            selected.broken && h('p', { className: cls('brokenNote'), role: 'alert' }, selected.broken), selectedRows.length > 0 && cards(selectedRows),
            otherMatches.length > 0 && h('p', { className: cls('hint') }, t("其他预设中还有 {0} 个匹配：", [otherMatches.reduce((n, p) => n + p.count, 0)]),
              otherMatches.map(({ preset }) => h('button', { key: preset.id, type: 'button', className: cls('jumpLink'), onClick: () => showPreset(preset.id) }, presetName(preset)))))),
        state.plugins?.length > 0 && h('section', { className: cls('group'), 'data-plugin-scope': 'global' },
          h('div', { className: cls('groupTitleRow') }, groupToggle(t('全局插件'), sectionId + '-global', globalEffectiveOpen, () => setGlobalOpen(!globalEffectiveOpen))),
          h('p', { className: cls('groupSub') }, h('span', null, t('系统与所有会话共用')), h('span', { 'data-plugin-count': globalRows.length }, globalRows.length + t(' 个')),
            failedRows.length > 0 && h('span', { className: cls('failedCount') }, failedRows.length + t(' 个失败'))),
          globalEffectiveOpen && h('div', { id: sectionId + '-global', className: cls('groupBody') }, cards(sortedRows))),
        !presets.length && !state.plugins?.length && h('p', { className: cls('status') }, t('暂无插件。'))))
  }
}
