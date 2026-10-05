/** Integration runner for an ISOLATED debug instance with DSH_DESKTOP_SMOKE_DIR.
 * Usage: node tools/test-webview-restore.mjs <smokeDir> <CDP port> [cycles=20]
 * Requires two disposable empty sessions in that instance. Never submits a prompt.
 * CDP is disconnected before every destroy, and never keeps the browser alive.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const dir = resolve(process.argv[2]), port = Number(process.argv[3]), cycles = Number(process.argv[4] || 20)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rustPid = Number(process.argv[6])
async function memory() {
  if (!Number.isSafeInteger(rustPid) || rustPid <= 0) return undefined
  const script = `$tree=Get-CimInstance Win32_Process; $owned=@(${rustPid}); do {$more=@($tree | Where-Object {$_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned} | Select-Object -ExpandProperty ProcessId); $owned+=$more} while($more.Count); $nodeId=($tree | Where-Object {$_.ParentProcessId -eq ${rustPid} -and $_.Name -eq 'node.exe'} | Select-Object -First 1).ProcessId; $web=@($tree | Where-Object {$_.ProcessId -in $owned -and $_.Name -eq 'msedgewebview2.exe'} | Select-Object -ExpandProperty ProcessId); $webBytes=0; if($web.Count){$webBytes=(Get-Process -Id $web | Measure-Object WorkingSet64 -Sum).Sum}; @{rustPid=${rustPid};nodePid=$nodeId;rustBytes=(Get-Process -Id ${rustPid}).WorkingSet64;nodeBytes=(Get-Process -Id $nodeId).WorkingSet64;webviewCount=$web.Count;webviewBytes=$webBytes} | ConvertTo-Json -Compress`
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true })
  return JSON.parse(stdout)
}
async function state() { try { return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) } catch { return {} } }
let sequence = (await state()).command || 0
async function command(action) { await writeFile(join(dir, 'command.json'), JSON.stringify({ sequence: ++sequence, action })) }
async function until(predicate, timeout = 22000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await state(); if (predicate(value)) return value; await sleep(100) }
  throw new Error('State deadline: ' + JSON.stringify(await state()))
}
async function evaluate(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('No test page')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { socket.addEventListener('open', res, { once: true }); socket.addEventListener('error', rej, { once: true }) })
  try {
    const result = new Promise((res, rej) => socket.addEventListener('message', event => {
      const reply = JSON.parse(event.data); if (reply.id !== 1) return
      if (reply.error || reply.result.exceptionDetails) rej(new Error(reply.result?.exceptionDetails?.exception?.description || 'CDP error'))
      else res(reply.result.result.value)
    }))
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    return await result
  } finally {
    socket.close()
    await new Promise(res => socket.addEventListener('close', res, { once: true }))
  }
}
const png = (await readFile(new URL('../src-tauri/icons/32x32.png', import.meta.url))).toString('base64')
await until(s => s.backend === 'running' && s.loaded && s.phase === 'active')
for (let attempt = 0; attempt < 100; attempt++) {
  try { if (await evaluate('Boolean(window.__DSH_UI_BOOT__?.smoke && window.__DSH_SMOKE_CONTEXT__)')) break } catch {}
  await sleep(100)
}
const expected = await evaluate(`(async()=>{
 if(!window.__DSH_UI_BOOT__?.smoke) throw Error('Requires isolated debug smoke instance');
 const c=window.__DSH_SMOKE_CONTEXT__, ids=c.sessions.list.getSnapshot().ids.slice(0,2);
 if(ids.length!==2 || ids.some(id=>!c.sessions.list.getSnapshot().byId[id].blank)) throw Error('Prepare two empty disposable sessions');
 const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 const later=[...document.querySelectorAll('button')].find(b=>b.textContent==='稍后配置');later?.click();await frame();
 const owned=document.querySelector('.dshTb__dialogField')?.closest('[role=dialog]');[...(owned?.querySelectorAll('button')||[])].find(b=>b.textContent==='取消')?.click();await frame();
 for(let index=0;index<2;index++){c.sessions.open(ids[index]);await frame();c.conversation.input.for(c.sessions.scope(ids[index])).setDraft('恢复测试 '+index+'\\n第二行');}
 c.uiWorkspace.openSession(ids[0]);await frame();
 const input=c.conversation.input.for(c.sessions.scope(ids[0]));
 for(const id of input.state.getSnapshot().attachmentIds)input.removeAttachment(id);
 const files=[new File(['附件内容'],'restore.txt',{type:'text/plain'}),new File([Uint8Array.from(atob('${png}'),c=>c.charCodeAt(0))],'pixel.png',{type:'image/png'})];
 const assets=c.conversation.createDrafts(ids[0],files);input.addAttachments(assets.map(a=>a.id));
 for(let i=0;i<150 && c.conversation.fileUploads.getSnapshot()[assets[0].id]?.status!=='ready';i++)await new Promise(r=>setTimeout(r,50));
 const root=input.editor.getRootElement();root.focus();
 const range=document.createRange();range.setStart(root.children[1].firstChild.firstChild,1);range.setEnd(root.children[1].firstChild.firstChild,2);const sel=document.getSelection();sel.removeAllRanges();sel.addRange(range);document.dispatchEvent(new Event('selectionchange'));await frame();
 return {ids,caret:input.caretSpan(),layout:c.slots.entriesOfSlot('root')[0].store.create().getSnapshot().layoutInfo.sidebar};
})()`)
assert.deepEqual(expected.caret, { start: 8, end: 9 })
await sleep(500)
const initial = await state(), results = []
for (let cycle = 1; cycle <= cycles; cycle++) {
  // Empty isolated profiles have no API credential; dismiss their onboarding.
  await evaluate(`(async()=>{
    [...document.querySelectorAll('button')].find(b=>b.textContent==='稍后配置')?.click();await new Promise(r=>setTimeout(r,200));
    const c=window.__DSH_SMOKE_CONTEXT__, root=c.conversation.input.for(c.sessions.scope(${JSON.stringify(expected.ids[0])})).editor.getRootElement();root.focus();
    const range=document.createRange();range.setStart(root.children[1].firstChild.firstChild,1);range.setEnd(root.children[1].firstChild.firstChild,2);const sel=document.getSelection();sel.removeAllRanges();sel.addRange(range);document.dispatchEvent(new Event('selectionchange'));
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;
  })()`)
  const beforeMemory = await memory()
  const started = Date.now(); await command('enter')
  const minimal = await until(s => s.command === sequence && s.phase === 'minimal')
  assert.equal(minimal.windowCount, 0); assert.equal(minimal.hasSnapshot, true)
  assert.equal(minimal.identity.backendInstance, initial.identity.backendInstance)
  const entered = Date.now(), minimalMemory = await memory()
  if (minimalMemory) { assert.equal(minimalMemory.webviewCount, 0); assert.equal(minimalMemory.nodePid, beforeMemory.nodePid) }
  const restoreStarted = Date.now(); await command('show')
  const active = await until(s => s.command === sequence && s.phase === 'active' && !s.hasSnapshot && s.loaded)
  assert.equal(active.windowCount, 1); assert.equal(active.visible, true)
  assert.equal(active.identity.backendInstance, initial.identity.backendInstance)
  const restored = Date.now()
  const check = await evaluate(`(async()=>{
    const c=window.__DSH_SMOKE_CONTEXT__, ids=${JSON.stringify(expected.ids)}, list=c.sessions.list.getSnapshot(), input=c.conversation.input.for(c.sessions.scope(ids[0]));
    const a=c.conversation.resolveDraftAttachments(input.state.getSnapshot().attachmentIds);
    return {current:list.current,texts:ids.map(id=>c.conversation.input.for(c.sessions.scope(id)).state.getSnapshot().draft),caret:input.caretSpan(),files:a.length,text:await a[0]?.file.text(),image:a[1]&&btoa(String.fromCharCode(...new Uint8Array(await a[1].file.arrayBuffer()))),sidebar:c.slots.entriesOfSlot('root')[0].store.create().getSnapshot().layoutInfo.sidebar};
  })()`)
  assert.equal(check.current, expected.ids[0]); assert.deepEqual(check.texts, ['恢复测试 0\n第二行','恢复测试 1\n第二行'])
  assert.deepEqual(check.caret, expected.caret); assert.equal(check.files, 2); assert.equal(check.text, '附件内容'); assert.equal(check.image, png); assert.equal(check.sidebar, expected.layout)
  results.push({ cycle, enterMs: entered-started, restoreMs: restored-restoreStarted, windowGeneration: active.identity.windowGeneration, beforeMemory, minimalMemory })
  console.log(JSON.stringify({cycle, enterMs:entered-started, restoreMs:restored-restoreStarted, webviews:minimalMemory?.webviewCount}))
  await writeFile(join(dir, 'cycles-report.json'), JSON.stringify({ backendInstance: initial.identity.backendInstance, results }, null, 2))
}
await command('close'); await until(s => s.command === sequence && !s.visible && s.windowCount === 1 && s.phase === 'active')
await command('show'); await until(s => s.command === sequence && s.visible && s.phase === 'active')
console.log('PASS: repeated state/content restoration and ordinary close-to-tray')

if (process.argv[5] === 'edges') {
  const checks = []
  const dismiss = () => evaluate(`(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='稍后配置')?.click();await new Promise(r=>setTimeout(r,100));return true})()`)
  await dismiss()
  await evaluate(`(()=>{const f=document.createElement('input');f.id='smoke-unsupported';f.value='unsaved-form';document.body.append(f);return true})()`)
  const original = await state(); await command('enter')
  await until(s => s.command === sequence && s.phase === 'active' && s.error === 'snapshot-form-unsupported')
  assert.equal((await state()).identity.windowGeneration, original.identity.windowGeneration)
  assert.equal(await evaluate(`document.getElementById('smoke-unsupported').value`), 'unsaved-form')
  await evaluate(`document.getElementById('smoke-unsupported').remove()`)
  checks.push('unsupported form cancels capture without destroying the page')

  await evaluate(`(()=>{const a=window.__DSH_CREATE_UI_ADAPTER__(window.__DSH_SMOKE_CONTEXT__);window.__DSH_UI_STATE__.registerAdapter({...a,capture:()=>new Promise(r=>window.__lateCapture=r)});return true})()`)
  await command('enter'); await until(s => s.command === sequence && s.phase === 'capturing')
  await command('show'); await until(s => s.command === sequence && s.phase === 'active')
  await evaluate(`window.__lateCapture({schemaVersion:1})`); await sleep(100)
  assert.equal((await state()).hasSnapshot, false)
  await command('enter'); await until(s => s.command === sequence && s.phase === 'active' && s.error === 'snapshot-capture-timeout')
  assert.equal((await state()).identity.windowGeneration, original.identity.windowGeneration)
  checks.push('show cancels capture; late responses and capture timeout preserve the page')

  await evaluate(`(()=>{const a=window.__DSH_CREATE_UI_ADAPTER__(window.__DSH_SMOKE_CONTEXT__);window.__DSH_UI_STATE__.registerAdapter({...a,capture:async o=>{const p=await a.capture(o);p.scrolls=[{sessionId:p.page.sessionId,anchor:'smoke-missing',offset:0,scrollTop:0,following:false}];return p}});return true})()`)
  await command('enter'); await until(s => s.command === sequence && s.phase === 'minimal')
  await command('show'); await until(s => s.command === sequence && s.phase === 'restore-failed')
  assert.equal((await state()).hasSnapshot, true)
  const failedGeneration = (await state()).identity.windowGeneration
  await evaluate(`(()=>{const a=window.__DSH_CREATE_UI_ADAPTER__(window.__DSH_SMOKE_CONTEXT__);window.__DSH_UI_STATE__.registerAdapter({...a,restore:(s,o)=>a.restore({...s,payload:{...s.payload,scrolls:[]}},o)});return true})()`)
  await command('show'); await until(s => s.command === sequence && s.phase === 'active' && !s.hasSnapshot)
  assert.equal((await state()).identity.windowGeneration, failedGeneration)
  assert.equal(await evaluate(`(()=>{const c=window.__DSH_SMOKE_CONTEXT__;return c.conversation.input.for(c.sessions.scope(c.sessions.list.getSnapshot().current)).state.getSnapshot().attachmentIds.length})()`), 2)
  checks.push('failed restore retains snapshot; retry reuses window and does not duplicate attachments')

  async function openMenu(label, item) {
    await dismiss()
    await evaluate(`(async()=>{const b=[...document.querySelectorAll('.dshTb__item')].find(b=>b.textContent===${JSON.stringify(label)});if(b.getAttribute('aria-expanded')!=='true')b.click();await new Promise(r=>setTimeout(r,100));[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.trim()===${JSON.stringify(item)}).click();await new Promise(r=>setTimeout(r,100));return true})()`)
  }
  async function roundtrip() {
    await command('enter'); await until(s => s.command === sequence && s.phase === 'minimal')
    await command('show'); await until(s => s.command === sequence && s.phase === 'active' && !s.hasSnapshot)
  }
  await openMenu('会话', '重命名')
  const beforeTitle = await evaluate(`(()=>{const c=window.__DSH_SMOKE_CONTEXT__,l=c.sessions.list.getSnapshot();return l.byId[l.current].displayTitle})()`)
  await evaluate(`(()=>{const f=document.querySelector('.dshTb__dialogField input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(f,'未提交的恢复标题');f.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  await sleep(100); await roundtrip()
  assert.equal(await evaluate(`document.querySelector('.dshTb__dialogField input')?.value`), '未提交的恢复标题')
  assert.equal(await evaluate(`(()=>{const c=window.__DSH_SMOKE_CONTEXT__,l=c.sessions.list.getSnapshot();return l.byId[l.current].displayTitle})()`), beforeTitle)
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='取消').click()`)
  checks.push('rename dialog restores controlled text without submitting the rename')
  await openMenu('更多', '关于'); await roundtrip()
  assert.equal(await evaluate(`Boolean(document.querySelector('.dshTb__about'))`), true)
  await evaluate(`document.querySelector('.dshTb__about').closest('[role=dialog]').querySelector('button').click()`)
  checks.push('about dialog restores')
  await openMenu('项目', '删除项目'); await roundtrip()
  assert.equal(await evaluate(`Boolean(document.querySelector('.dshTb__dialogField')?.textContent.includes('确定要删除项目'))`), true)
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='取消').click()`)
  checks.push('delete confirmation restores display only')
  await writeFile(join(dir, 'edges-report.json'), JSON.stringify(checks, null, 2))
  console.log('PASS: ' + checks.join('; '))
}

if (process.argv[5] === 'backend') {
  await evaluate(`(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='稍后配置')?.click();await new Promise(r=>setTimeout(r,100));return true})()`)
  await command('enter'); await until(s => s.command === sequence && s.phase === 'minimal')
  await command('backend-stop'); await until(s => s.command === sequence && s.backend === 'failed' && s.windowCount === 0)
  await command('show'); const failed = await until(s => s.command === sequence && s.phase === 'restore-failed' && s.loaded)
  assert.equal(failed.hasSnapshot, true); assert.equal(failed.visible, true)
  assert.equal(await evaluate(`location.hostname`), 'tauri.localhost')
  assert.equal(await evaluate(`document.body.textContent.includes('DSH 后台已停止响应')`), true)
  await writeFile(join(dir, 'backend-report.json'), JSON.stringify(failed, null, 2))
  console.log('PASS: backend failure with zero windows shows current boot error and retains snapshot')
}
