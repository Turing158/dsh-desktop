
  const t = (source, values) => window.__DSH_I18N__?.t(source, values) ?? (typeof source === 'string' ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source)
/* Boot UI for the DeepseekHarness desktop shell.
 *
 * This page runs only until the window navigates to the DSH server, so it stays
 * deliberately small and dependency-free.
 *
 * There is no onboarding step any more: when no `dsh` is found the app installs
 * one itself and starts it, so this page only ever *reports* — probing, install
 * progress, starting the child — except in the one case the app cannot resolve
 * on its own, a failed install. That failure is handed to the user as a command
 * to run by hand.
 */

/* The Tauri bridge. `withGlobalTauri` exposes `window.__TAURI__`; the internal
 * object is used as a fallback so the page still works if the global is absent.
 * Note this page is only reachable while the window shows the app's own UI:
 * once it navigates to the DSH server, the backend rejects commands from that
 * origin, so these helpers stop being usable by design. */
const bridge = window.__TAURI__ ?? {};
const invoke = bridge.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke?.bind(window.__TAURI_INTERNALS__);
const listen = bridge.event?.listen;

/** Call a Tauri command, surfacing a readable error when the bridge is absent. */
async function call(command, args) {
  if (typeof invoke !== 'function') {
    throw new Error(t('Tauri 桥接不可用'));
  }
  return await invoke(command, args);
}

/** Subscribe to a backend event; a missing bridge is not fatal for rendering. */
async function on(event, handler) {
  if (typeof listen !== 'function') return () => {};
  try {
    return await listen(event, handler);
  } catch {
    return () => {};
  }
}

const el = {
  app: document.getElementById('app'),
  body: document.getElementById('body'),
};

/** The command shown on the failure screen, as reported by the backend.
 *
 * Served from Rust rather than written here so the instruction cannot drift
 * away from the command the app actually runs. The fallback is only for the
 * case where the status call itself failed. */
let installCommand = 'npm install -g @deepseek-ai/dsh@latest';

/** Keep the animated mark mounted while only the status content changes. */
function render(node, state = 'loading') {
  el.app.setAttribute('data-state', state);
  el.body.replaceChildren(node);
}

/** Build an element with attributes and children. */
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function paragraph(text, className = 'muted') {
  return h('p', { class: className, text });
}

function statusLine(text) {
  return h('p', { class: 'status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', text });
}

function button(label, onClick, variant = 'primary') {
  return h('button', { class: `btn ${variant}`, type: 'button', onclick: onClick }, label);
}

/** A numbered step in the manual-install instructions. */
function step(number, ...content) {
  return h(
    'li',
    { class: 'step' },
    h('span', { class: 'step-n', text: String(number) }),
    h('span', { class: 'step-body' }, ...content),
  );
}

/** Ask the backend for the current status and render it. */
async function refresh() {
  try {
    const status = await call('probe_state');
    if (status?.install_command) installCommand = status.install_command;
    renderPhase(status);
  } catch (error) {
    showFailure(String(error?.message ?? error));
  }
}

function renderPhase(status) {
  const phase = status?.phase ?? { kind: 'probing' };
  switch (phase.kind) {
    case 'probing':
      render(statusLine(t('正在检查运行环境…')));
      break;
    case 'needs-node':
      renderNeedsNode(phase);
      break;
    case 'installing':
      renderInstalling(phase);
      break;
    case 'starting':
      render(statusLine(t('正在启动工作空间…')));
      break;
    case 'running':
      render(statusLine(t('界面已就绪，正在载入…')), 'ready');
      break;
    case 'failed':
      renderFailed(phase);
      break;
    default:
      render(statusLine(t('正在启动…')));
  }
}

/** Node is missing or too old to run DSH. */
function renderNeedsNode(phase) {
  const found = phase.found
    ? t("检测到 Node {0}，但 dsh 需要 Node {1} 或更高版本。", [phase.found, phase.required_major])
    : t("未检测到 Node.js。dsh 需要 Node {0} 或更高版本。", [phase.required_major]);

  render(
    h(
      'div',
      { class: 'stack' },
      h('h2', { get text() { return t('需要 Node.js') } }),
      paragraph(found, 'warn'),
      paragraph(t('安装 Node.js 后点击「重新检测」。安装会改动系统环境，请自行选择安装方式。')),
      h(
        'div',
        { class: 'actions' },
        button(t('使用 winget 安装 Node.js'), () => installNode()),
        button(t('打开 Node.js 下载页'), () => openExternal('https://nodejs.org/en/download'), 'secondary'),
        button(t('重新检测'), () => retry(), 'secondary'),
      ),
      paragraph(t('winget 安装会打开一个命令行窗口并可能请求管理员权限，安装完成后回到本窗口点击「重新检测」。')),
    ),
    'attention',
  );
}

/** The automatic install is running: report progress, offer a way out. */
function renderInstalling(phase) {
  const log = h('pre', { class: 'log', role: 'log', get 'aria-label'() { return t('安装日志') }, 'aria-live': 'off' });
  const heading = phase.version ? t("正在安装 dsh {0}", [phase.version]) : t('正在安装 DeepSeek Harness');

  render(
    h(
      'div',
      { class: 'stack' },
      h('h2', { text: heading }),
      statusLine(t('首次启动需要下载并安装，请稍候…')),
      h('details', { class: 'more' }, h('summary', { get text() { return t('查看安装进度') } }), log),
      h('div', { class: 'actions' }, button(t('取消'), () => cancelInstall(), 'secondary')),
    ),
    'installing',
  );

  const unsubscribe = on('install-progress', (event) => {
    const progress = event.payload ?? {};
    log.textContent += `${progress.line}\n`;
    log.scrollTop = log.scrollHeight;
    if (progress.done) unsubscribe.then((off) => typeof off === 'function' && off());
  });
}

/**
 * The install failed: show why, then hand the user the exact command.
 *
 * This is the only page that asks the user to do something, so it is the only
 * one that carries instructions. The command is put on the clipboard by a button
 * rather than selected by hand: it is long, easy to mistype, and the whole point
 * of the screen is that typing it correctly matters.
 */
function renderFailed(phase) {
  const children = [
    h('h2', { text: phase.manual_install ? t('自动安装失败') : t('启动失败') }),
    paragraph(phase.message, 'error'),
    phase.hint ? paragraph(phase.hint) : null,
  ];

  if (phase.manual_install) {
    children.push(
      h(
        'ol',
        { class: 'steps' },
        step(1, t('按 '), h('kbd', { text: 'Win' }), ' + ', h('kbd', { text: 'R' }), t(' 打开「运行」')),
        step(2, t('输入 '), h('kbd', { text: 'powershell' }), t('，按回车')),
        step(3, t('在命令行中输入下面的命令，按回车')),
      ),
      h(
        'div',
        { class: 'command' },
        h('code', { class: 'command-text', text: installCommand }),
        button(t('复制命令'), (event) => copyCommand(event.currentTarget), 'secondary small'),
      ),
      paragraph(t('安装完成后回到本窗口，点击「重新检测」。'), 'hint'),
    );
  }

  children.push(
    h(
      'div',
      { class: 'actions' },
      button(t('重新检测'), () => retry()),
      phase.manual_install
        ? button(t('打开 npm 文档'), () => openExternal('https://docs.npmjs.com/cli/v10/commands/npm-install'), 'secondary')
        : null,
    ),
  );

  if ((phase.details ?? []).length > 0) {
    const details = h('details', { class: 'more' });
    const pre = h('pre', { class: 'log' });
    pre.textContent = phase.details.join('\n');
    details.append(h('summary', { get text() { return t('查看详细输出') } }), pre);
    children.push(details);
  }

  render(h('div', { class: 'stack' }, ...children), 'failed');
}

/**
 * Replace the status with an error message and stop the loading animation.
 *
 * `stale-origin` is the one rejection that is not a failure: the boot guard in
 * main.rs refuses any command whose IPC lands after the window has already
 * navigated away to the DSH server, and the last `status-changed` refresh
 * lands exactly there. The real interface replaces this document moments
 * later, so a card would only flash between the two pages.
 */
function showFailure(message) {
  if (message === 'stale-origin') return;
  render(h('div', { class: 'stack' }, h('h2', { get text() { return t('出错了') } }), paragraph(message, 'error')), 'failed');
}

/** Copy the install command, confirming on the button itself. */
async function copyCommand(target) {
  const original = target.textContent;
  try {
    await call('clipboard_write_text', { text: installCommand });
    target.textContent = t('已复制');
  } catch {
    target.textContent = t('复制失败');
  }
  setTimeout(() => {
    target.textContent = original;
  }, 1600);
}

async function cancelInstall() {
  try {
    await call('cancel_install');
  } catch {
    /* Cancellation is best-effort. */
  }
  await refresh();
}

/** Re-run the whole boot sequence: probe, install if needed, start. */
async function retry() {
  try {
    await call('retry_boot');
    // The backend re-probes and pushes phase changes; render the wait now.
    render(statusLine(t('正在重新检测…')));
  } catch (error) {
    const message = String(error?.message ?? error);
    showFailure(message);
  }
}

async function openExternal(url) {
  try {
    await call('open_external', { url });
  } catch {
    /* The link is informational. */
  }
}

async function installNode() {
  try {
    await call('install_node');
  } catch (error) {
    const node = el.body.querySelector('.stack');
    if (node) node.append(paragraph(String(error?.message ?? error), 'error'));
  }
}

// The backend pushes a status event whenever the phase changes, which is what
// moves the window from installing to "starting" once an install completes.
on('status-changed', () => {
  refresh();
});

// The markup already animates before JavaScript or IPC is ready. Keep that mark
// mounted across phase changes, including the stale-origin handoff, so a slow
// probe stays visibly alive without restarting the animation or delaying boot.
render(statusLine(t('正在检查运行环境…')));
refresh();
