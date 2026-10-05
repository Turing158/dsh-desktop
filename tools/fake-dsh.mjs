/**
 * A stand-in for `dsh` used to test the desktop app's pipelines.
 *
 * The app's stdout protocol is small and fully specified: one `dsh web:` line
 * announcing the GUI URL, then any number of `__DSH_NOTIFY__` / `__DSH_THEME__`
 * lines. Driving the real app with this script exercises the whole Rust path —
 * spawn, line parsing, notification delivery, title-bar coloring — without
 * needing a live agent or touching the user's settings file.
 *
 * Point the app at it with `DSH_DESKTOP_DSH=<this file>`.
 */

const port = Number(process.env.FAKE_DSH_PORT ?? 45999)

/** Which appearance preference to report; set FAKE_DSH_THEME=light|dark|system. */
const theme = process.env.FAKE_DSH_THEME ?? 'system'

// A real `dsh` answers `--version` before doing anything else, and the app probes
// it that way. Answering keeps this stand-in faithful (and keeps the app's
// version display populated).
if (process.argv.includes('--version')) {
  console.log('0.0.0-fake')
  process.exit(0)
}

console.log('2026-01-01T00:00:00.000Z [loader] info apply plugin fake-base')
console.log(`dsh web: http://127.0.0.1:${port}/?token=FAKE_TOKEN_FOR_TESTING`)

// Report the appearance immediately, before readiness, exactly as the real
// plugin does: the window colors itself as soon as the value arrives.
console.log(`__DSH_THEME__ ${JSON.stringify({ preference: theme })}`)

/** Delay before each notification, so toasts do not stack instantly. */
const sequence = [
  {
    after: 1500,
    payload: {
      kind: 'question',
      title: 'DSH 需要你的选择',
      body: '选择工作区：这个正文用来验证通知管线',
      sessionId: 'fake-session-1',
    },
  },
  {
    after: 4000,
    payload: {
      kind: 'task-end',
      title: 'DSH 任务完成',
      body: '任务已完成 · 测试用正文',
      reason: 'completed',
      sessionId: 'fake-session-1',
    },
  },
]

for (const { after, payload } of sequence) {
  setTimeout(() => {
    console.log(`__DSH_NOTIFY__ ${JSON.stringify(payload)}`)
  }, after)
}

// Stay alive like the real server does, so the app does not treat this as a crash.
setInterval(() => {}, 1000)
