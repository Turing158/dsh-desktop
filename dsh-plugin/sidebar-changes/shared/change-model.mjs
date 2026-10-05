import { t } from '../../i18n/api.mjs'
export const SOURCES = ['session', 'working', 'staged']
export const VIEWS = [...SOURCES, 'history']
export const LABELS = { get session() { return t('当前会话') }, get working() { return t('未提交') }, get staged() { return t('暂存区') }, get history() { return t('提交记录') } }
export const BASES = { get session() { return [t('首次修改前'), t('本会话最后修改后')] }, get working() { return ['HEAD', t('工作区')] }, get staged() { return ['HEAD', t('暂存区')] } }
export const LIMITS = { bytes: 1024 * 1024, lines: 40000, cells: 4000000, files: 2000, operations: 10000, disk: 256 * 1024 * 1024, scanBytes: 32 * 1024 * 1024 }
export const REASONS = {
  get binary() { return t('二进制文件不能逐行展示') }, get encoding() { return t('文件不是有效的 UTF-8 文本') }, get large() { return t('文件超过文本比较限制') },
  get complexity() { return t('差异计算超过复杂度限制') }, get baseline() { return t('缺少首次修改前的完整内容') }, get interleaved() { return t('存在外部或其他会话的交错修改，累计记录不完整') },
  get observed() { return t('执行期间观察到的变化，无法确认修改作者') }, get quota() { return t('快照存储已达到配额，记录不完整') },
  get interrupted() { return t('调用未完成或进程中断，可能存在未记录的修改') }, get storage() { return t('快照读写失败，记录不完整') },
  get legacy() { return t('此调用没有提供完整前后内容，仅能保留观察记录') }, get scan() { return t('部分路径未被扫描覆盖') },
  get conflict() { return t('文件存在合并冲突') }, get submodule() { return t('Git 子模块变化') }, get symlink() { return t('符号链接或文件类型变化') },
  get stale() { return t('内容版本已过期，请重试') }, get missing() { return t('工作目录不存在或不可访问') }, get unsupported() { return t('执行端文件系统不支持本地采集') },
  get 'history-stale'() { return t('提交记录已过期，请重试') }, get 'history-large'() { return t('提交消息或历史数据超过读取限制') },
  get concurrent() { return t('存在重叠执行，按已记录片段展示') }, get 'legacy-scan'() { return t('历史记录的采集范围不完整') },
  get 'scan-content'() { return t('扫描内容预算不足，部分文件只记录状态') }, get excluded() { return t('部分路径按配置排除，覆盖范围有限') },
}
export const unknownDiff = reason => ({ rows: [], stats: { added: null, removed: null }, reason, beforeNewline: null, afterNewline: null })
const lines = text => { const value = text.replace(/\r\n/g, '\n'); return value === '' ? [] : value.replace(/\n$/, '').split('\n') }

/** Exact line LCS within an explicit work bound. No approximate replacement counts. */
export function diffText(before, after, limits = LIMITS) {
  if (typeof before !== 'string' || typeof after !== 'string') return unknownDiff('baseline')
  if (before.length + after.length > limits.bytes * 2) return unknownDiff('large')
  const a = lines(before), b = lines(after)
  if (a.length + b.length > limits.lines) return unknownDiff('large')
  let start = 0, end = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++
  const n = a.length - start - end, m = b.length - start - end
  if ((n + 1) * (m + 1) > limits.cells) return unknownDiff('complexity')
  const width = m + 1, dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * width + j] = a[start + i] === b[start + j] ? 1 + dp[(i + 1) * width + j + 1] : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
  }
  const rows = [], stats = { added: 0, removed: 0 }
  let old = 1, next = 1
  const push = (kind, text) => {
    rows.push({ kind, text, old: kind === '+' ? null : old++, next: kind === '-' ? null : next++ })
    if (kind === '+') stats.added++
    if (kind === '-') stats.removed++
  }
  for (let i = 0; i < start; i++) push(' ', a[i])
  let i = 0, j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { push(' ', a[start + i++]); j++ }
    else if (i < n && (j === m || dp[(i + 1) * width + j] >= dp[i * width + j + 1])) push('-', a[start + i++])
    else push('+', b[start + j++])
  }
  for (let k = a.length - end; k < a.length; k++) push(' ', a[k])
  return { rows, stats, reason: null, beforeNewline: before.endsWith('\n'), afterNewline: after.endsWith('\n') }
}

export function contextBlocks(rows, context = 3) {
  const keep = new Set()
  rows.forEach((row, i) => { if (row.kind !== ' ') for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep.add(j) })
  const blocks = []
  rows.forEach((row, i) => {
    const hidden = !keep.has(i), last = blocks.at(-1)
    if (last?.hidden === hidden) last.rows.push(row)
    else blocks.push({ id: i, hidden, rows: [row] })
  })
  return blocks
}

// Explicit Remote descriptors are shared by Host and Client; all file access
// starts with a session lookup. No caller-supplied workspace root crosses the wire.
const codec = name => ({ mode: 'strict', typeSymbol: '@dsh-desktop/sidebar-changes#' + name, create: () => ({ parse(value) {
  const valid = name === 'offset' ? Number.isSafeInteger(value) && value >= 0
    : typeof value === 'string' && value.length <= 512 && (name !== 'source' || SOURCES.includes(value)) && (name !== 'commitId' || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))
  if (!valid) throw Error('Invalid changes query parameter: ' + name)
  return value
} }) })
export const contribution = { package: '@dsh-desktop/sidebar-changes', descriptors: [
  ['getCapabilities', []], ['listChanges', ['source']], ['getFileDiff', ['source', 'fileId', 'revision', 'offset']],
  ['getFileContext', ['source', 'fileId', 'revision', 'offset']], ['subscribeChanges', ['sinceRevision']],
  ['listCommits', ['revision', 'offset']], ['getCommitDetails', ['revision', 'commitId']],
  ['listFileOperations', ['fileId', 'revision', 'recordKind', 'offset']],
  ['getOperationDiff', ['fileId', 'revision', 'operationId', 'offset']],
].map(([method, args]) => ({
  id: 'desktopChanges/' + method, service: 'desktopChanges', namespace: 'desktopChanges', method,
  invocation: { kind: 'direct' }, ...(method === 'subscribeChanges' ? { mode: 'stream' } : {}),
  parameters: [{ name: 'scope', wire: 'sessionId', source: 'lookup', lookup: 'desktopChangesScope', codec: codec('sessionId') },
    ...args.map(name => ({ name, wire: name, source: 'json', codec: codec(name) }))],
  cancellation: { parameter: 'signal' }, result: { mode: 'src-json' },
})) }
