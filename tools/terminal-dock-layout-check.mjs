import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Exercise the title-bar control against real CSS grid transitions in WebView2. */
export async function checkDockSidebarLayout(cdp, directory, pass) {
  const result = await cdp.evaluate(`(async () => {
    const html = document.documentElement;
    const frame = document.querySelector('[data-shell-overlay]').parentElement;
    const animation = html.getAttribute('data-dsh-desktop-animation');
    const collapsed = frame.hasAttribute('data-sidebar-collapsed');
    const toggle = () => document.querySelector('.dshTb__mark').click();
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const samples = [];
    const measure = () => {
      const sidebar = document.querySelector('[class*="_sidebarCol"]').getBoundingClientRect();
      const dock = document.querySelector('[data-dsh-terminal-dock]').getBoundingClientRect();
      return { sidebar: sidebar.right, dock: dock.left, error: Math.abs(sidebar.right - dock.left) };
    };
    // Observe after the dock's observer so geometry is sampled in the same
    // rendering update, before paint. Timer/rAF reads can force the next layout
    // before ResizeObserver delivery and report a non-painted stale offset.
    const sampling = new ResizeObserver(() => samples.push(measure()));
    try {
      html.setAttribute('data-dsh-desktop-animation', 'on');
      await sleep(450);
      sampling.observe(document.querySelector('[class*="_sidebarCol"]'));
      for (let i = 0; i < 60; i++) { toggle(); await sleep([24, 41, 67][i % 3]); }
      const settled = [];
      for (const closed of [true, false]) {
        if (frame.hasAttribute('data-sidebar-collapsed') !== closed) toggle();
        await sleep(450);
        settled.push({ collapsed: closed, ...measure() });
      }
      html.setAttribute('data-dsh-desktop-animation', 'off');
      for (let i = 0; i < 20; i++) { toggle(); await sleep(20); }
      await sleep(100);
      return { samples: samples.length, widths: new Set(samples.map(s => Math.round(s.sidebar))).size,
        maxError: Math.max(...samples.map(s => s.error)), settled, withoutAnimation: measure() };
    } finally {
      sampling.disconnect();
      if (frame.hasAttribute('data-sidebar-collapsed') !== collapsed) toggle();
      if (animation === null) html.removeAttribute('data-dsh-desktop-animation');
      else html.setAttribute('data-dsh-desktop-animation', animation);
      await sleep(450);
    }
  })()`)
  await writeFile(join(directory, 'sidebar-toggle-layout.json'), JSON.stringify(result, null, 2))
  assert.ok(result.samples > 30 && result.widths > 5, 'sample actual intermediate animation widths')
  assert.ok(result.maxError <= 1, 'dock stays aligned throughout rapid reversals: ' + JSON.stringify(result))
  assert.ok(result.settled.every(box => box.error <= 1), 'both final sidebar states align')
  assert.ok(result.withoutAnimation.error <= 1, 'animation-disabled toggles align')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(directory, 'sidebar-toggle-layout.png'), Buffer.from(shot.data, 'base64'))
  pass('80 rapid left-sidebar toggles keep the bottom dock aligned during animation and at rest')
}
