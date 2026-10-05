// Throwaway render check for the redesigned remote-control section.
// Seeds the useState cells externally, renders the loaded desktop form, and
// asserts the DOM hooks the integration driver relies on.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync('D:/EducationalData/rust/DeepseekHarness-desktop/dsh-plugin/ui-remote/client.js', 'utf8')

function load(menuAvailable) {
  const cells = []
  let cursor = 0
  const React = {
    createElement: (tag, props, ...children) => typeof tag === 'function' ? tag(props) : { tag, props, children },
    Fragment: 'fragment',
    useState: initial => {
      const key = cursor++
      if (cells[key] === undefined) cells[key] = initial
      return [cells[key], () => {}]
    },
    useEffect() {}, useRef: value => ({ current: value }),
    reset: () => { cursor = 0 },
  }
  let captured = null
  const window = {
    top: null, __TAURI__: { core: { invoke: async () => { throw new Error('no rpc') } } },
    __ModuleLoader__: { load({ factory }) {
      captured = factory(name => {
        if (name === 'react') return React
        if (name === '@deepseek-ai/dsh-client-ui-primitives') {
          if (!menuAvailable) throw new Error('missing primitives')
          // createElement calls function tags, so the stub returns a node that
          // keeps props.anchor (the pill) visible to the flattener.
          return { Menu: props => ({ tag: 'menu', props, children: [] }) }
        }
        throw new Error('unexpected require ' + name)
      })
    } },
  }
  window.top = window
  vm.runInNewContext(source, { window, URL, console })
  return { plugin: captured, cells, React }
}

function flatten(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.tag) out.push(node)
  const kids = [...(node.children ?? []), ...(Array.isArray(node.props?.children) ? node.props.children : (node.props?.children ? [node.props.children] : []))]
  if (node.props?.anchor) kids.push(node.props.anchor)
  for (const kid of kids) flatten(kid, out)
  return out
}

const status = {
  instance: 'i1', operationId: 'op1', state: 'lan', address: 'http://192.168.1.10:13080/?token=x', error: null, frontendVersion: 1,
  saved: { version: 1, enabled: true, bindAddress: '192.168.1.10', port: 13080, trustedHosts: ['desktop.local:13080'] },
  active: { enabled: true, bindAddress: '192.168.1.10', port: 13080 },
  applying: false,
}
const draft = { enabled: true, bindAddress: '192.168.1.10', port: '13080', trustedHosts: ['desktop.local:13080'] }
const addresses = [{ address: '192.168.1.10', name: '以太网' }, { address: '192.168.56.1', name: 'VirtualBox Host-Only' }]

for (const menuAvailable of [true, false]) {
  const { plugin, cells, React } = load(menuAvailable)
  let rendered = null
  plugin.apply({ slots: { inject(_, fn) { fn() }, register(o, render) { rendered = render } } })
  rendered()                   // prime the useState cells in hook order
  cells[0] = status            // status
  cells[1] = { ...draft }      // draft
  cells[2] = addresses         // addresses
  cells[7] = true              // confirm dialog open
  React.reset()
  const tree = rendered()
  const nodes = flatten(tree)
  const byTag = tag => nodes.filter(n => n.tag === tag)
  const byId = id => nodes.find(n => n.props?.id === id)
  const byClass = cls => nodes.filter(n => String(n.props?.className || '').includes(cls))
  const hasText = text => nodes.some(n => (n.children ?? []).includes(text) || n.props?.children === text)
  const problems = []
  if (!byId('dsh-remote-port')) problems.push('missing #dsh-remote-port')
  if (byTag('input').some(n => n.props.type === 'checkbox')) problems.push('checkbox should be gone: the enable toggle is a selector now')
  const enabled = byId('dsh-remote-enabled')
  if (!enabled) problems.push('missing #dsh-remote-enabled')
  else if (menuAvailable && enabled.tag !== 'button') problems.push('enable toggle should be a button under Menu')
  else if (!menuAvailable && enabled.tag !== 'select') problems.push('enable toggle should degrade to select without Menu')
  const pill = byId('dsh-remote-address')
  if (!pill) problems.push('missing #dsh-remote-address')
  else if (menuAvailable && pill.tag !== 'button') problems.push('pill should be a button under Menu')
  else if (!menuAvailable && pill.tag !== 'select') problems.push('pill should degrade to select without Menu')
  if (menuAvailable && byTag('select').length) problems.push('no native select expected under Menu')
  const enabledMenu = nodes.find(n => n.tag === 'menu' && (n.props.items || []).some(i => i.id === 'on'))
  if (menuAvailable && !enabledMenu) problems.push('enable menu must offer the 开启/关闭 entries')
  if (!menuAvailable) {
    const enabledSelect = byId('dsh-remote-enabled')
    const values = ((enabledSelect?.children ?? []) || []).flat().map(o => o.props?.value)
    if (!(values.includes('on') && values.includes('off'))) problems.push('degraded enable select must offer on/off')
  }
  if (!hasText('应用并重启 DSH')) problems.push('missing apply button')
  if (!byTag('div').some(n => n.props?.role === 'alertdialog')) problems.push('missing confirm alertdialog')
  if (!hasText('确认启用并重启')) problems.push('missing confirm apply button')
  if (!byClass('dshRemote__hostRow').length) problems.push('missing host rows')
  if (!nodes.some(n => String(n.props?.['aria-label'] || '') === '额外 Host 1')) problems.push('missing host input aria-label')
  if (!byClass('dshRemote__row').length) problems.push('missing Setting-Cell rows')
  console.log(`menu=${menuAvailable ? 'yes' : 'no '} -> ${problems.length ? 'FAIL: ' + problems.join('; ') : 'OK  (rows: ' + byClass('dshRemote__row').length + ', buttons: ' + byTag('button').length + ', state: ' + (byClass('dshRemote__state').length ? 'tagged' : 'MISSING') + ')'}`)
}
