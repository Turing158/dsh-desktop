window.__ModuleLoader__.load({
  id: '@dsh-desktop/remote-control',
  factory: require => {
    
  const t = (source, values) => window.__DSH_I18N__?.t(source, values) ?? (typeof source === 'string' ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source)
  const useLocale = React => window.__DSH_I18N__?.use(React)
const React = require('react'), h = React.createElement
    // The app's own Menu primitive — the dropdown surface every selector pill in
    // the settings window opens. Resolved guarded (see ui-client/client.js): a
    // page whose module table lacks it still gets the whole section, with the
    // address control degraded to a native <select> wearing the same pill.
    let Menu = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (primitives && typeof primitives.Menu === 'function') Menu = primitives.Menu
    } catch (error) { console.warn('remote-control: UI primitives unavailable: ' + String(error)) }
    const outside = () => t('暂不支持外网访问。请让手机与电脑连接同一局域网，移动数据无法直连。')
    const hostHelp = () => t('填写访问电脑时使用的主机名或 IP，不是手机 IP。所选监听地址会自动加入。')
    const labels = { get disabled() { return t('已关闭') }, get applying() { return t('正在应用') }, get lan() { return t('局域网可用') }, get failed() { return t('启动失败') }, get 'local-fallback'() { return t('仅本机回退') } }
    // The terminal header's tone vocabulary: lan and failure are facts, not
    // alarms, so only flight-in-progress and failure get colour.
    const tones = { applying: 'busy', lan: 'ok', failed: 'bad' }
    const desktop = () => window.top === window && Boolean(window.__TAURI__?.core?.invoke)
    const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, { ...args, identity: window.__DSH_REMOTE_IDENTITY__ })
    const errorText = error => error?.message || (typeof error === 'string' ? error : t('操作失败，请稍后重试'))
    function validateHost(entry) {
      if (entry.includes('[') || (entry.match(/:/g) || []).length > 1) return t('暂不支持 IPv6 Host')
      if (!entry || entry.length > 253 || /[^\x21-\x7e]|[/*\\?#@%]/.test(entry)) return t('请输入 host 或 host:port，不含空白、URL、路径或通配符（最多 253 字符）')
      try {
        const http = new URL('http://' + entry), https = new URL('https://' + entry)
        const port = http.port || https.port
        if (http.hostname === '0.0.0.0') return t('不允许 0.0.0.0')
        if (http.hostname + (port ? ':' + port : '') !== entry.toLowerCase()) return t('Host 或端口不是规范格式，请检查 IP、悬空冒号及零填充端口')
      } catch { return t('Host 格式无效') }
      return ''
    }
    const normalized = draft => ({ version: 1, enabled: draft.enabled, bindAddress: draft.bindAddress, port: Number(draft.port), trustedHosts: [...new Set(draft.trustedHosts.map(v => v.toLowerCase()))] })
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    // Setting-Cell (the app's figma 501:30011): title and hint in a left text
    // column, the control on the right, a hairline under the row. Errors and
    // notes render inside the text column so the row keeps one baseline.
    function Row({ title, hint, htmlFor, control, children }) {
      return h('div', { className: 'dshRemote__row' },
        h('div', { className: 'dshRemote__rowText' },
          (htmlFor ? h('label', { className: 'dshRemote__label', htmlFor }, title) : h('div', { className: 'dshRemote__label' }, title)),
          hint && h('div', { className: 'dshRemote__hint' }, hint),
          children),
        control)
    }
    function Section({ title, tag, children, collapsible = false }) {
      return h(collapsible ? 'details' : 'section', { className: 'dshRemote__section' + (collapsible ? ' dshRemote__disclosure' : '') },
        h(collapsible ? 'summary' : 'h3', { className: 'dshRemote__sectionHead' }, title, tag),
        h('div', { className: 'dshRemote__sectionBody' }, children))
    }
    function Outside() { return h(Section, { title: t('在外面使用'), collapsible: true, tag: h('span', { className: 'dshRemote__tag' }, t('待实现')) }, h('p', { className: 'dshRemote__text' }, outside())) }
    function RemoteSection() {
      useLocale(React)
      const [status, setStatus] = React.useState(null), [draft, setDraft] = React.useState(null)
      const [addresses, setAddresses] = React.useState([]), [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null), [qr, setQr] = React.useState(null), [notice, setNotice] = React.useState('')
      const [confirm, setConfirm] = React.useState(false), [firewall, setFirewall] = React.useState(null)
      const [addressOpen, setAddressOpen] = React.useState(false), addressTrigger = React.useRef(null)
      const [enabledOpen, setEnabledOpen] = React.useState(false), enabledTrigger = React.useRef(null)
      const live = React.useRef(true), connectionEpoch = React.useRef(0), previousKey = React.useRef('')
      const clearConnection = () => { connectionEpoch.current++; setQr(null) }
      async function refreshAddresses() {
        try {
          const values = await invoke('remote_lan_addresses')
          if (!live.current) return
          setAddresses(values)
          if (values.length === 1) setDraft(old => old && !old.bindAddress ? { ...old, bindAddress: values[0].address } : old)
        } catch (e) { if (live.current) setError(e) }
      }
      React.useEffect(() => {
        live.current = true
        if (!desktop()) return () => { live.current = false }
        let loading = false, initialized = false
        async function refresh() {
          if (loading || !window.__DSH_REMOTE_IDENTITY__) return
          loading = true
          try {
            const next = await invoke('remote_status')
            if (!live.current) return
            const key = [next.instance, next.operationId, next.state, next.address].join('|')
            if (key !== previousKey.current) { previousKey.current = key; clearConnection(); setFirewall(null) }
            setStatus(next)
            setDraft(old => old || { ...next.saved, port: String(next.saved.port) })
            if (!initialized) { initialized = true; await refreshAddresses() }
          } catch (e) { if (live.current) { clearConnection(); setStatus(null); setError(e) } }
          finally { loading = false }
        }
        refresh()
        const timer = setInterval(refresh, 1500)
        const hide = () => clearConnection()
        window.addEventListener('dsh-remote-ready', refresh)
        window.addEventListener('pagehide', hide)
        document.addEventListener('visibilitychange', hide)
        return () => { live.current = false; connectionEpoch.current++; clearInterval(timer); window.removeEventListener('dsh-remote-ready', refresh); window.removeEventListener('pagehide', hide); document.removeEventListener('visibilitychange', hide) }
      }, [])
      if (!desktop()) return h('div', { className: 'dshRemote' }, h('h2', null, t('远程控制')), h('p', null, t('请在电脑桌面应用中修改远程控制设置')), h(Outside))
      function edit(patch) { setDraft(old => ({ ...old, ...patch })); setError(null); setNotice(''); clearConnection() }
      const dismissAddress = () => { setAddressOpen(false); addressTrigger.current?.focus() }
      const dismissEnabled = () => { setEnabledOpen(false); enabledTrigger.current?.focus() }
      async function apply() {
        setConfirm(false); setBusy(true); setError(null); clearConnection()
        try {
          // Let React close the confirmation; the snapshot audit ignores its exit-animation clone.
          await new Promise(resolve => requestAnimationFrame(resolve))
          const bridge = window.__DSH_UI_STATE__
          if (!bridge?.prepareRemoteApply) throw new Error(t('页面保存服务尚未准备好，请稍后重试'))
          const payload = await bridge.prepareRemoteApply(status.frontendVersion)
          const result = await invoke('remote_apply', { config: normalized(draft), payload })
          if (!result.changed) bridge.finishRemoteApply()
          if (live.current) setNotice(result.changed ? t('配置已保存，正在重启 DSH…') : t('配置与运行状态一致'))
        } catch (e) { window.__DSH_UI_STATE__?.finishRemoteApply(); if (live.current) setError(e) }
        finally { if (live.current) setBusy(false) }
      }
      async function connection(copy) {
        const epoch = ++connectionEpoch.current; setError(null); setNotice('')
        try {
          const info = await invoke('remote_connection_info')
          if (!live.current || epoch !== connectionEpoch.current || info.instance !== status.instance) return
          if (copy) { await window.__TAURI__.core.invoke('clipboard_write_text', { text: info.url }); if (live.current) setNotice(t('登录链接已复制，请勿转发给他人')) }
          else setQr(info.qrSvg)
        } catch (e) { if (live.current) { setQr(null); setError(e) } }
      }
      async function copy(text) { try { await window.__TAURI__.core.invoke('clipboard_write_text', { text }); setNotice(t('命令已复制')) } catch (e) { setError(e) } }
      const runtimeError = error || status?.error
      const alert = runtimeError && h('p', { role: 'alert', className: 'dshRemote__error dshRemote__pageError' }, errorText(runtimeError))
      if (!draft || !status) return h('div', { className: 'dshRemote' }, h('h2', null, t('远程控制')), alert || h('p', { role: 'status', className: 'dshRemote__intro' }, t('正在连接桌面服务…')), h(Outside))
      const hostErrors = draft.trustedHosts.map(validateHost)
      const portError = !/^[1-9]\d{0,4}$/.test(String(draft.port)) || Number(draft.port) > 65535
      const addressError = draft.enabled && !addresses.some(a => a.address === draft.bindAddress)
      const unchanged = equal(normalized(draft), status.saved) && equal(status.saved, status.active) && !status.error
      const applying = busy || status.applying
      const ready = draft.enabled && status.active?.enabled && status.state === 'lan' && !applying
      const invalid = portError || addressError || hostErrors.some(Boolean) || draft.trustedHosts.length > 32
      // The address selector wears the app's own selector pill and opens the
      // app's Menu, exactly like 通用设置's rows (the Menu does not close on
      // selection, so `dismissAddress` leads in `onSelect` too). The pill keeps
      // its id for the label association and the form drivers.
      const addressItems = [...addresses.map(a => ({ id: a.address, label: a.address + ' · ' + a.name }))]
      if (draft.bindAddress && !addresses.some(a => a.address === draft.bindAddress)) addressItems.push({ id: draft.bindAddress, label: draft.bindAddress + t('（当前不可用）') })
      const addressPill = Menu
        ? h(Menu, {
            open: addressOpen, onClose: dismissAddress, items: addressItems, selectedId: draft.bindAddress || null,
            onSelect: id => { dismissAddress(); edit({ bindAddress: id }) }, align: 'end', portal: true,
            anchor: h('button', { ref: addressTrigger, type: 'button', id: 'dsh-remote-address', className: 'dshRemote__pill', 'aria-label': t('监听地址'), 'aria-haspopup': 'menu', 'aria-expanded': addressOpen, 'aria-invalid': Boolean(addressError), onClick: () => setAddressOpen(!addressOpen), onKeyDown: e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setAddressOpen(true) } } },
              draft.bindAddress || t('请选择局域网 IPv4')),
          })
        : h('select', { id: 'dsh-remote-address', className: 'dshRemote__pill', 'aria-label': t('监听地址'), value: draft.bindAddress, 'aria-invalid': Boolean(addressError), onChange: e => edit({ bindAddress: e.target.value }) },
            h('option', { value: '' }, t('请选择局域网 IPv4')),
            ...addressItems.map(a => h('option', { key: a.id, value: a.id }, a.label)))
      // The enable toggle is the same selector as the address row — the row
      // vocabulary is 通用设置's, where a toggle is a two-entry selector, not a
      // checkbox. 关闭 is listed last because it is the default: the backend
      // starts disabled, and the pill shows the saved value until edited. Like
      // the address selector it keeps its id for the form drivers, and the
      // native select degrades to the same two entries.
      const enabledItems = [{ id: 'on', label: t('开启') }, { id: 'off', label: t('关闭') }]
      const enabledValue = draft.enabled ? 'on' : 'off'
      const enabledPill = Menu
        ? h(Menu, {
            open: enabledOpen, onClose: dismissEnabled, items: enabledItems, selectedId: enabledValue,
            onSelect: id => { dismissEnabled(); edit({ enabled: id === 'on' }) }, align: 'end', portal: true,
            anchor: h('button', { ref: enabledTrigger, type: 'button', id: 'dsh-remote-enabled', className: 'dshRemote__pill', 'aria-label': t('启用局域网远程控制'), 'aria-haspopup': 'menu', 'aria-expanded': enabledOpen, onClick: () => setEnabledOpen(!enabledOpen), onKeyDown: e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setEnabledOpen(true) } } },
              draft.enabled ? t('开启') : t('关闭')),
          })
        : h('select', { id: 'dsh-remote-enabled', className: 'dshRemote__pill', 'aria-label': t('启用局域网远程控制'), value: enabledValue, onChange: e => edit({ enabled: e.target.value === 'on' }) },
            ...enabledItems.map(item => h('option', { key: item.id, value: item.id }, item.label)))
      return h('div', { className: 'dshRemote' },
        h('p', { className: 'dshRemote__intro' }, t('用手机浏览器连接电脑，共享会话与实时输出。')),
        h('fieldset', { disabled: applying },
          Row({
            title: t('启用局域网远程控制'), hint: t('开启并应用后，同一局域网内的设备可连接。'),
            control: enabledPill,
            children: ready && h('div', { className: 'dshRemote__runtime', role: 'status', 'aria-label': t('运行状态') },
              h('span', { className: 'dshRemote__state', 'data-dsh-remote-tone': tones[status.state] },
                h('span', { className: 'dshRemote__dot', 'aria-hidden': 'true' }), labels[status.state]),
              h('code', { className: 'dshRemote__code' }, status.active.bindAddress + ':' + status.active.port)),
          }),
          ready && h(Section, { title: t('手机连接') },
            h('div', { className: 'dshRemote__actions' },
              h('button', { type: 'button', className: 'dshRemote__secondary', onClick: () => qr ? clearConnection() : connection(false) }, qr ? t('隐藏二维码') : t('显示二维码')),
              h('button', { type: 'button', className: 'dshRemote__secondary', onClick: () => connection(true) }, t('复制完整链接'))),
            qr && h('div', { role: 'img', 'aria-label': t('手机登录二维码，包含访问凭据'), className: 'dshRemote__qr', dangerouslySetInnerHTML: { __html: qr } }),
            h('p', { className: 'dshRemote__text' }, t('手机连接同一局域网后，扫码或打开完整链接登录。请勿分享给他人。'))),
          Row({
            title: t('监听地址'), hint: t('选择电脑当前使用的局域网 IPv4。'),
            control: h('span', { className: 'dshRemote__controls' }, addressPill,
              h('button', { type: 'button', className: 'dshRemote__ghost', title: t('重新枚举网卡'), onClick: refreshAddresses, disabled: applying }, t('刷新'))),
            children: addressError && h('p', { className: 'dshRemote__error' }, t('请选择当前可用的局域网 IPv4。')),
          }),
          Row({
            title: t('端口'), htmlFor: 'dsh-remote-port', hint: t('可用范围：1–65535。'),
            control: h('input', { id: 'dsh-remote-port', className: 'dshRemote__input dshRemote__inputPort', inputMode: 'numeric', value: draft.port, onChange: e => edit({ port: e.target.value }), 'aria-invalid': portError, maxLength: 5 }),
            children: portError && h('p', { className: 'dshRemote__error' }, t('端口须为 1–65535 的整数。')),
          }),
          h(Section, { title: t('Host 白名单'), collapsible: true,
            tag: (hostErrors.some(Boolean) || draft.trustedHosts.length > 32) && h('span', { className: 'dshRemote__error' }, t('请检查 Host')) },
            h('p', { className: 'dshRemote__text' }, hostHelp()),
            h('p', { className: 'dshRemote__text' }, t('最多 32 项，每项 253 字符。省略端口表示允许任意端口；主机名需能在手机上解析。')),
            draft.enabled && draft.bindAddress && !portError && h('p', { className: 'dshRemote__autojoin' }, t('自动加入：'), h('code', { className: 'dshRemote__code' }, draft.bindAddress + ':' + draft.port)),
            ...draft.trustedHosts.map((host, index) => h('div', { key: index },
              h('div', { className: 'dshRemote__hostRow' },
                h('input', { className: 'dshRemote__input', value: host, maxLength: 253, placeholder: 'desktop.local:3080', 'aria-label': t('额外 Host ') + (index + 1), 'aria-invalid': Boolean(hostErrors[index]), onChange: e => edit({ trustedHosts: draft.trustedHosts.map((v, i) => i === index ? e.target.value : v) }) }),
                h('button', { type: 'button', className: 'dshRemote__ghost dshRemote__ghostDanger', 'aria-label': t('删除 Host ') + (index + 1), onClick: () => edit({ trustedHosts: draft.trustedHosts.filter((_, i) => i !== index) }), disabled: applying }, t('删除'))),
              hostErrors[index] && h('p', { className: 'dshRemote__error dshRemote__hostError' }, hostErrors[index]))),
            h('div', { className: 'dshRemote__actions' },
              h('button', { type: 'button', className: 'dshRemote__ghost', onClick: () => edit({ trustedHosts: [...draft.trustedHosts, ''] }), disabled: applying || draft.trustedHosts.length >= 32 }, t('添加 Host')))),
          h('div', { className: 'dshRemote__apply' },
            h('p', { className: 'dshRemote__applyHint' }, t('应用会重启 DSH 并中断任务与连接。终端命令保留；草稿和附件保存失败时将取消应用。')),
            h('button', { type: 'button', className: 'dshRemote__primary', onClick: () => draft.enabled && !status.active?.enabled ? setConfirm(true) : apply(), disabled: applying || invalid || unchanged }, applying ? t('正在应用…') : t('应用并重启 DSH'))),
          confirm && h('div', { role: 'alertdialog', 'aria-label': t('启用远程控制'), className: 'dshRemote__confirm' },
            h('p', { className: 'dshRemote__confirmText' }, t('持有登录链接或二维码的设备可在此电脑上执行任务。请仅在受信任的局域网中启用。')),
            h('div', { className: 'dshRemote__confirmActions' },
              h('button', { type: 'button', className: 'dshRemote__secondary', onClick: () => setConfirm(false) }, t('取消')),
              h('button', { type: 'button', className: 'dshRemote__primary', onClick: apply }, t('确认启用并重启'))))),
        alert,
        notice && h('p', { role: 'status', className: 'dshRemote__notice' }, notice),
        h(Section, { title: t('连接帮助'), collapsible: true },
          h('p', { className: 'dshRemote__text' }, t('电脑需保持运行、不休眠；可收起到托盘，退出后无法连接。')),
          h('p', { className: 'dshRemote__text' }, t('打不开页面：检查监听地址、防火墙及路由器的访客网络或设备隔离。')),
          h('p', { className: 'dshRemote__text' }, t('403：将访问的主机名加入白名单。401：重新获取登录链接。断网后等待重连，避免重复提交。')),
          h('p', { className: 'dshRemote__text' }, t('重启不会撤销设备已有的登录状态。')),
          h('p', { className: 'dshRemote__text' }, t('防火墙指令仅限 Windows 专用网络和本地子网，需在管理员 PowerShell 执行。更换地址后请删除旧规则。')),
          h('div', { className: 'dshRemote__actions' },
            h('button', { type: 'button', className: 'dshRemote__secondary', onClick: async () => { try { setFirewall(await invoke('remote_firewall_help')) } catch (e) { setError(e) } }, disabled: status.state !== 'lan' || applying }, t('生成防火墙指令'))),
          firewall && h(React.Fragment, null,
            h('p', { className: 'dshRemote__text dshRemote__codeLabel' }, t('新增规则')),
            h('pre', { className: 'dshRemote__pre' }, firewall.add),
            h('div', { className: 'dshRemote__actions' }, h('button', { type: 'button', className: 'dshRemote__ghost', onClick: () => copy(firewall.add) }, t('复制新增指令'))),
            h('p', { className: 'dshRemote__text dshRemote__codeLabel' }, t('删除规则')),
            h('pre', { className: 'dshRemote__pre' }, firewall.remove),
            h('div', { className: 'dshRemote__actions' }, h('button', { type: 'button', className: 'dshRemote__ghost', onClick: () => copy(firewall.remove) }, t('复制删除指令'))))),
        h(Outside))
    }
    return { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'remote-control', order: 6, label: () => t('远程控制'), children: {} }, RemoteSection))
    }, validateHost }
  },
})
