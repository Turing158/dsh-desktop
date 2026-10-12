window.__ModuleLoader__.load({
  id: '@dsh-desktop/remote-control',
  factory: require => {
    
  const t = (source, values) => window.__DSH_I18N__?.t(source, values) ?? (typeof source === 'string' ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source)
  const useLocale = React => window.__DSH_I18N__?.use(React)
const React = require('react'), h = React.createElement
    // The app's own Menu primitive — the dropdown surface every selector pill in
    // the settings window opens. Resolved guarded (see ui-client/client.js): a
    // page whose module table lacks it still gets the whole section, with the
    // controls degraded to native <select>s wearing the same pill.
    let Menu = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (primitives && typeof primitives.Menu === 'function') Menu = primitives.Menu
    } catch (error) { console.warn('remote-control: UI primitives unavailable: ' + String(error)) }
    const hostHelp = () => t('本机 IP 或 localhost 加入后会监听，删除后关闭，均需应用。域名仅加入白名单；网卡 IP 不可编辑。')
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
    const lanAuthority = config => config.bindAddress + ':' + Number(config.port)
    function localListener(config, host, addresses) {
      if (!config || validateHost(host)) return null
      const [name, explicitPort] = host.toLowerCase().split(':')
      const address = name === 'localhost' ? '127.0.0.1' : name
      const port = explicitPort ? Number(explicitPort) : Number(config.port)
      if (port < 0 || port > 65535 || !Number.isInteger(port)) return null
      return /^127\.\d+\.\d+\.\d+$/.test(address) || address === config.bindAddress || addresses.some(item => item.address === address)
        ? { address, port } : null
    }
    function hostScheme(config, host, addresses = [], index = config?.trustedHosts.findIndex(value => value.toLowerCase() === host.toLowerCase())) {
      if (!config) return 'http'
      if (localListener(config, host, addresses)) return 'http'
      return config.hostProtocols?.[index] || config.hostSchemes?.[host.toLowerCase()]
        || (config.preferredHost?.host === host.toLowerCase() ? config.preferredHost.scheme : null) || 'https'
    }
    const normalized = (draft, addresses = []) => {
      const trustedHosts = [...new Set(draft.trustedHosts.map(v => v.toLowerCase()))].filter(host => host !== lanAuthority(draft))
      return { version: 1, enabled: draft.enabled, bindAddress: draft.bindAddress, port: Number(draft.port), trustedHosts,
        hostSchemes: Object.fromEntries(trustedHosts.map(host => [host, hostScheme(draft, host, addresses)])) }
    }
    const draftFromConfig = config => {
      const draft = normalized(config)
      return { ...draft, port: String(config.port), hostProtocols: draft.trustedHosts.map(host => draft.hostSchemes[host]) }
    }
    const equal = (a, b, addresses = []) => a && b ? JSON.stringify(normalized(a, addresses)) === JSON.stringify(normalized(b, addresses)) : a === b
    // Match the general settings selectors, including the shared Menu surface.
    function Selector({ id, label, value, items, onChange, disabled = false, invalid, display, className = '' }) {
      const [open, setOpen] = React.useState(false), trigger = React.useRef(null)
      React.useEffect(() => { if (disabled) setOpen(false) }, [disabled])
      const dismiss = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
      const wrapperClass = 'dshRemote__selector ' + className
      const props = { id, className: 'dshRemote__pill', value, disabled, 'aria-label': label, 'aria-invalid': invalid }
      if (!Menu) return h('span', { className: wrapperClass },
        h('select', { ...props, onChange: e => onChange(e.target.value) },
          !items.some(item => item.id === value) && h('option', { value }, display ?? value),
          ...items.map(item => h('option', { key: item.id, value: item.id, disabled: item.disabled }, item.label))))
      return h(Menu, {
        open: open && !disabled, onClose: dismiss, items, selectedId: value, portal: true, align: 'start', autoFocus: true,
        className: wrapperClass, listClassName: 'dshRemote__menu',
        onSelect: value => { dismiss(); onChange(value) },
        anchor: h('button', { ...props, ref: trigger, type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': open && !disabled,
          onClick: () => setOpen(!open), onKeyDown: e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true) }
          } }, display ?? items.find(item => item.id === value)?.label ?? value),
      })
    }
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
    function Outside() {
      return h(Section, { title: t('在外面使用'), collapsible: true, tag: h('span', { className: 'dshRemote__tag' }, 'Cloudflare Tunnel') },
        h('ol', { className: 'dshRemote__text dshRemote__steps' },
          h('li', null, t('开启局域网远程控制并应用。')),
          h('li', null, t('登录 Cloudflare，接入域名并创建 Tunnel；按 Windows 指引安装并启动 cloudflared。')),
          h('li', null, t('绑定隧道子域名：服务选 HTTP，地址填本页 IP:端口；可选配置 Access（仅本人邮箱）。')),
          h('li', null, t('将子域名加入 Host 白名单，协议选 HTTPS，应用并重启。')),
          h('li', null, t('在“手机连接”选择域名，扫码或打开完整链接。'))),
        h('p', { className: 'dshRemote__text' }, t('电脑和 cloudflared 需保持运行；IP 变化后更新隧道地址。')))
    }
    function RemoteSection() {
      useLocale(React)
      const [status, setStatus] = React.useState(null), [draft, setDraft] = React.useState(null)
      const [addresses, setAddresses] = React.useState([]), [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null), [qr, setQr] = React.useState(null), [notice, setNotice] = React.useState('')
      const [selectedConnection, setSelectedConnection] = React.useState(null)
      const [confirm, setConfirm] = React.useState(false), [firewall, setFirewall] = React.useState(null)
      const live = React.useRef(true), connectionEpoch = React.useRef(0), previousKey = React.useRef('')
      const selectionEpoch = React.useRef(0), selectionWrites = React.useRef(Promise.resolve(null))
      const selectionPending = React.useRef(false), statusRef = React.useRef(null)
      const clearConnection = () => { connectionEpoch.current++; setQr(null) }
      const receiveStatus = next => { statusRef.current = next; setStatus(next) }
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
          if (loading || selectionPending.current || !window.__DSH_REMOTE_IDENTITY__) return
          const epoch = selectionEpoch.current
          loading = true
          try {
            const next = await invoke('remote_status')
            if (!live.current || epoch !== selectionEpoch.current) return
            const key = [next.instance, next.operationId, next.state].join('|')
            if (key !== previousKey.current) {
              previousKey.current = key; clearConnection(); setFirewall(null)
              if (next.active?.enabled) setSelectedConnection(old => old && ![lanAuthority(next.active), ...next.active.trustedHosts].includes(old.host) ? null : old)
            }
            receiveStatus(next)
            setDraft(old => old || draftFromConfig(next.saved))
            if (!initialized) { initialized = true; await refreshAddresses() }
          } catch (e) { if (live.current && epoch === selectionEpoch.current) { clearConnection(); receiveStatus(null); setError(e) } }
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
      function edit(patch) { setDraft(old => ({ ...old, ...(typeof patch === 'function' ? patch(old) : patch) })); setError(null); setNotice(''); clearConnection() }
      function editHost(index, host) {
        edit(old => ({ trustedHosts: old.trustedHosts.map((value, i) => i === index ? host : value) }))
      }
      function removeHost(index) {
        edit(old => ({ trustedHosts: old.trustedHosts.filter((_, i) => i !== index), hostProtocols: old.hostProtocols.filter((_, i) => i !== index) }))
      }
      function selectConnection(target, rollback) {
        clearConnection(); setSelectedConnection(target); setError(null); setNotice('')
        const epoch = ++selectionEpoch.current
        selectionPending.current = true
        // Serialize immediate saves so fast Host changes finish in order.
        const write = selectionWrites.current.catch(() => null).then(() => invoke('remote_select_connection', { target }))
        selectionWrites.current = write
        write.then(next => {
          if (epoch !== selectionEpoch.current) return
          selectionPending.current = false
          if (live.current && [next.instance, next.operationId, next.state].join('|') === previousKey.current) receiveStatus(next)
        }, error => {
          if (epoch !== selectionEpoch.current) return
          selectionPending.current = false
          rollback?.()
          if (live.current) setError(error)
        })
      }
      async function apply() {
        setConfirm(false); setBusy(true); setError(null); clearConnection()
        try {
          await selectionWrites.current
          const config = normalized(draft, addresses)
          // Access selection is saved separately from applying the whitelist.
          // Preserve it when still allowed, and fall back to LAN after deletion.
          const remembered = (statusRef.current || status).saved.preferredHost
          if (remembered && config.trustedHosts.includes(remembered.host)) config.preferredHost = { host: remembered.host, scheme: config.hostSchemes[remembered.host] }
          // Let React close the confirmation; the snapshot audit ignores its exit-animation clone.
          await new Promise(resolve => requestAnimationFrame(resolve))
          const bridge = window.__DSH_UI_STATE__
          if (!bridge?.prepareRemoteApply) throw new Error(t('页面保存服务尚未准备好，请稍后重试'))
          const payload = await bridge.prepareRemoteApply(status.frontendVersion)
          const result = await invoke('remote_apply', { config, payload })
          if (!result.changed) bridge.finishRemoteApply()
          if (live.current) setNotice(result.changed ? t('配置已保存，正在重启 DSH…') : t('配置与运行状态一致'))
        } catch (e) { window.__DSH_UI_STATE__?.finishRemoteApply(); if (live.current) setError(e) }
        finally { if (live.current) setBusy(false) }
      }
      async function connection(copy) {
        const epoch = ++connectionEpoch.current; setError(null); setNotice('')
        try {
          const info = await invoke('remote_connection_info', { target: accessTarget })
          if (!live.current || epoch !== connectionEpoch.current || info.instance !== status.instance) return
          if (copy) { await window.__TAURI__.core.invoke('clipboard_write_text', { text: info.url }); if (live.current && epoch === connectionEpoch.current) setNotice(t('登录链接已复制，请勿转发给他人')) }
          else setQr(info.qrSvg)
        } catch (e) { if (live.current && epoch === connectionEpoch.current) { setQr(null); setError(e) } }
      }
      async function copy(text) { try { await window.__TAURI__.core.invoke('clipboard_write_text', { text }); setNotice(t('命令已复制')) } catch (e) { setError(e) } }
      const runtimeError = error || status?.error
      const alert = runtimeError && h('p', { role: 'alert', className: 'dshRemote__error dshRemote__pageError' }, errorText(runtimeError))
      if (!draft || !status) return h('div', { className: 'dshRemote' }, h('h2', null, t('远程控制')), alert || h('p', { role: 'status', className: 'dshRemote__intro' }, t('正在连接桌面服务…')), h(Outside))
      const hostErrors = draft.trustedHosts.map(host => validateHost(host) || (localListener(draft, host, addresses)?.port === 0 ? t('本机监听端口须为 1–65535') : ''))
      const portError = !/^[1-9]\d{0,4}$/.test(String(draft.port)) || Number(draft.port) > 65535
      const addressError = draft.enabled && !addresses.some(a => a.address === draft.bindAddress)
      const automaticHost = draft.bindAddress && !portError ? lanAuthority(draft) : ''
      const unchanged = equal(draft, status.saved, addresses) && equal(status.saved, status.active, addresses) && !status.error
      const applying = busy || status.applying
      const ready = draft.enabled && status.active?.enabled && status.state === 'lan' && !applying
      const activeListeners = status.listeners || (status.active?.enabled ? [{ address: status.active.bindAddress, port: status.active.port }] : [])
      const activeListener = host => {
        const binding = localListener(status.active, host, activeListeners)
        return binding && activeListeners.some(item => item.address === binding.address && item.port === binding.port) ? binding : null
      }
      // Connection choices come from the running whitelist, independently of
      // unsaved edits. Choosing one saves only the access selection, without a restart.
      const accessHosts = status.active?.enabled ? [lanAuthority(status.active), ...status.active.trustedHosts] : []
      const remembered = status.active?.preferredHost
      const defaultConnection = remembered && accessHosts.includes(remembered.host) ? remembered : { host: accessHosts[0] || '', scheme: 'http' }
      const choice = selectedConnection && accessHosts.includes(selectedConnection.host) ? selectedConnection : defaultConnection
      const connectionListener = activeListener(choice.host)
      const accessTarget = { host: choice.host, scheme: connectionListener ? 'http' : hostScheme(status.active, choice.host, activeListeners) }
      const accessAddress = ready ? accessTarget.scheme + '://' + (connectionListener ? choice.host.split(':')[0] + ':' + connectionListener.port : choice.host) + '/' : null
      const invalid = portError || addressError || hostErrors.some(Boolean) || draft.trustedHosts.length > 32
      const addressItems = [...addresses.map(a => ({ id: a.address, label: a.address + ' · ' + a.name }))]
      if (draft.bindAddress && !addresses.some(a => a.address === draft.bindAddress)) addressItems.push({ id: draft.bindAddress, label: draft.bindAddress + t('（当前不可用）') })
      const addressPill = h(Selector, {
        id: 'dsh-remote-address', label: t('监听地址'), value: draft.bindAddress, items: addressItems,
        display: draft.bindAddress || t('请选择局域网 IPv4'), invalid: Boolean(addressError), disabled: applying,
        onChange: bindAddress => edit({ bindAddress }),
      })
      const enabledItems = [{ id: 'on', label: t('开启') }, { id: 'off', label: t('关闭') }]
      const enabledValue = draft.enabled ? 'on' : 'off'
      const enabledPill = h(Selector, {
        id: 'dsh-remote-enabled', label: t('启用局域网远程控制'), value: enabledValue, items: enabledItems,
        disabled: applying, onChange: value => edit({ enabled: value === 'on' }),
      })
      return h('div', { className: 'dshRemote' },
        h('p', { className: 'dshRemote__intro' }, t('用手机浏览器连接电脑，共享会话与实时输出。')),
        h('fieldset', { disabled: applying },
          Row({
            title: t('启用局域网远程控制'), hint: t('开启并应用后，同一局域网内的设备可连接。'),
            control: enabledPill,
            children: ready && h('div', { className: 'dshRemote__runtime', role: 'status', 'aria-label': t('运行状态') },
              h('span', { className: 'dshRemote__state', 'data-dsh-remote-tone': tones[status.state] },
                h('span', { className: 'dshRemote__dot', 'aria-hidden': 'true' }), labels[status.state]),
              ...activeListeners.map(listener => h('code', { key: listener.address + ':' + listener.port, className: 'dshRemote__code' }, listener.address + ':' + listener.port))),
          }),
          ready && h(Section, { title: t('手机连接') },
            h('div', { className: 'dshRemote__connectionTarget' },
              h('label', { htmlFor: 'dsh-remote-connection-host' }, t('访问 Host')),
              h('div', { className: 'dshRemote__connectionControls' },
                h(Selector, { id: 'dsh-remote-connection-host', label: t('访问 Host'), className: 'dshRemote__connectionHost', value: accessTarget.host,
                  items: accessHosts.map(host => ({ id: host, label: host + (host === lanAuthority(status.active) ? t('（局域网）') : '') })),
                  onChange: host => {
                    selectConnection({ host, scheme: activeListener(host) ? 'http' : hostScheme(status.active, host, activeListeners) })
                  } }))),
            accessAddress && h('div', { className: 'dshRemote__kv' },
              h('span', { className: 'dshRemote__kvKey' }, t('访问地址')),
              h('code', { className: 'dshRemote__code dshRemote__kvValue' }, accessAddress)),
            h('div', { className: 'dshRemote__actions' },
              h('button', { type: 'button', className: 'dshRemote__secondary', onClick: () => qr ? clearConnection() : connection(false) }, qr ? t('隐藏二维码') : t('显示二维码')),
              h('button', { type: 'button', className: 'dshRemote__secondary', onClick: () => connection(true) }, t('复制完整链接'))),
            qr && h('div', { role: 'img', 'aria-label': t('手机登录二维码，包含访问凭据'), className: 'dshRemote__qr', dangerouslySetInnerHTML: { __html: qr } }),
            connectionListener?.address.startsWith('127.') && h('p', { className: 'dshRemote__text' }, t('回环地址仅供这台电脑或本机隧道使用，手机请选局域网 IP 或域名。')),
            h('p', { className: 'dshRemote__text' }, accessHosts.length > 1
              ? t('各 Host 可同时访问。选择地址后扫码或打开完整链接，每个域名需分别登录。自动记住选择，切换无需重启，请勿分享登录链接。')
              : t('手机连接同一局域网后，扫码或打开完整链接登录。请勿分享给他人。'))),
          Row({
            title: t('监听地址'), hint: t('应用启动时自动检测网卡；所选地址不可用时，自动选择可用的局域网 IPv4。'),
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
            h('p', { className: 'dshRemote__text' }, t('最多 32 项，每项 253 字符。本机地址未写端口时使用本页端口和 HTTP；域名需正确解析或通过隧道转发。')),
            h('div', null,
              h('div', { className: 'dshRemote__hostRow', 'data-dsh-remote-host': 'lan' },
                h(Selector, { className: 'dshRemote__hostScheme', value: 'http', disabled: true, label: t('局域网 Host 协议'), items: [{ id: 'http', label: 'HTTP' }] }),
                h('input', { className: 'dshRemote__input', value: automaticHost, readOnly: true, placeholder: t('未选择网卡'), 'aria-label': t('局域网 Host（只读）'), title: t('随监听地址自动更新，不可编辑或删除') }),
                h('span', { className: 'dshRemote__tag' }, t('自动加入'))),
              ...draft.trustedHosts.map((host, index) => h('div', { key: index },
                h('div', { className: 'dshRemote__hostRow' },
                  h(Selector, { className: 'dshRemote__hostScheme', value: hostScheme(draft, host, addresses, index), label: t('Host {index} 协议', { index: index + 1 }),
                    items: [{ id: 'https', label: 'HTTPS' }, { id: 'http', label: 'HTTP' }],
                    disabled: applying || Boolean(localListener(draft, host, addresses)),
                    onChange: protocol => {
                      const previous = hostScheme(draft, host, addresses, index)
                      edit(old => ({ hostProtocols: old.hostProtocols.map((value, i) => i === index ? protocol : value) }))
                      const activeHost = status.active?.trustedHosts?.some(value => value.toLowerCase() === host.toLowerCase())
                      if (ready && activeHost && !validateHost(host)) {
                        selectConnection({ host, scheme: protocol }, () => edit(old => ({ hostProtocols: old.hostProtocols.map((value, i) => i === index ? previous : value) })))
                      }
                    } }),
                  h('input', { className: 'dshRemote__input', value: host, maxLength: 253, placeholder: 'desktop.local:3080', 'aria-label': t('额外 Host ') + (index + 1), 'aria-invalid': Boolean(hostErrors[index]), onChange: e => editHost(index, e.target.value) }),
                  h('button', { type: 'button', className: 'dshRemote__ghost dshRemote__ghostDanger', 'aria-label': t('删除 Host ') + (index + 1), onClick: () => removeHost(index), disabled: applying }, t('删除'))),
                hostErrors[index] && h('p', { className: 'dshRemote__error dshRemote__hostError' }, hostErrors[index])))),
            h('div', { className: 'dshRemote__actions' },
              h('button', { type: 'button', className: 'dshRemote__ghost', onClick: () => edit({ trustedHosts: [...draft.trustedHosts, ''], hostProtocols: [...draft.hostProtocols, 'https'] }), disabled: applying || draft.trustedHosts.length >= 32 }, t('添加 Host')))),
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
    }, validateHost, localListener }
  },
})
