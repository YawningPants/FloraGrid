import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolated browser profile and localStorage: this never opens or changes the user's calendar data.
const root = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const server = createServer(async (request, response) => {
  const path = resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
  if (!path.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    const content = await readFile(path);
    response.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(path)] || 'application/octet-stream');
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'calendar-drag-test-'));
const chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-extensions', '--disable-sync', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
let id = 0;
const pending = new Map();
const exceptions = [];
try {
  const endpoint = await new Promise((done, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`Chrome did not start: ${stderr}`)), 20000);
    chrome.once('error', reject);
    chrome.stderr.on('data', (data) => {
      stderr += data;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); done(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { done, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error))); else done(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  });
  const call = (method, params = {}, sessionId) => new Promise((done, reject) => {
    const requestId = ++id;
    pending.set(requestId, { done, reject });
    socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => call(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Page.bringToFront');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `${origin}/src/index.html?view=day&date=2026-10-24` });
  const waitFor = async (expression) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await evaluate(expression)) return;
      await sleep(25);
    }
    throw new Error(`Timed out: ${expression}`);
  };
  await waitFor('Boolean(document.querySelector(".day-window"))');
  const t = (taskId, status = 'active', children = [], collapsed = false) => ({ id: taskId, title: taskId === 'B' ? 'B — A tall card with enough text to wrap onto several lines and test midpoint-based insertion without depending on tiny gaps.' : taskId, status, children, tags: [], collapsed });
  const fixture = () => [t('A'), t('B'), t('C'), t('P', 'active', [t('X'), t('Y')]), t('done', 'completed'), t('failed', 'failed'), t('deleted', 'deleted')];
  let run = 0;
  const seed = async (tasks = fixture(), view = 'day') => {
    await evaluate(`localStorage.clear(); localStorage.setItem('desktop-calendar:day:2026-10-24', JSON.stringify(${JSON.stringify({ date: '2026-10-24', note: '', tasks })})); localStorage.setItem('desktop-calendar:long-tasks', JSON.stringify(${JSON.stringify({ version: 1, tasks })}));`);
    const runId = String(++run);
    await command('Page.navigate', { url: `${origin}/src/index.html?view=${view}&date=2026-10-24&testRun=${runId}` });
    await waitFor(`new URLSearchParams(location.search).get('testRun') === '${runId}' && document.readyState === 'complete' && document.querySelectorAll('${view === 'day' ? '.task-row' : '.long-task-item'}').length >= ${tasks.length - 1}`);
    await command('Page.bringToFront');
    if (view === 'month') await evaluate("document.querySelector('.month-long-toggle').click()");
    await evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
    await evaluate("window.__dragTestEvents=[]; for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture','blur'])window.addEventListener(type,e=>window.__dragTestEvents.push({type,target:e.target?.className,x:e.clientX,y:e.clientY,id:e.pointerId}),true)");
  };
  const rect = (taskId, selector = '.task-row') => evaluate(`(()=>{const row=[...document.querySelectorAll('${selector}')].find(e=>e.dataset.taskId===${JSON.stringify(taskId)}&&!e.closest('.task-drag-projection')); const r=row.getBoundingClientRect(); const h=row.querySelector('.drag-handle,.long-task-drag-handle')?.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,height:r.height,hx:h?.left+h?.width/2,hy:h?.top+h?.height/2}})()`);
  const mouse = (type, x, y, buttons = 1) => command('Input.dispatchMouseEvent', { type, x, y, buttons, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
  const start = async (taskId, selector = '.task-row') => {
    const r = await rect(taskId, selector);
    await mouse('mouseMoved', r.hx, r.hy, 0);
    await mouse('mousePressed', r.hx, r.hy);
    await mouse('mouseMoved', r.hx, r.hy + 8);
    try { await waitFor("Boolean(document.querySelector('.task-drag-projection'))"); }
    catch (error) { console.log('Start diagnostic', taskId, r, await evaluate("({events:window.__dragTestEvents,animations:document.querySelectorAll('.children.is-animating').length,body:document.body.className})"), exceptions); throw error; }
    return r;
  };
  const moveTo = async (x, y) => { await mouse('mouseMoved', x, y); await sleep(100); };
  const release = async (x, y) => { await mouse('mouseReleased', x, y, 0); await sleep(1100); };
  const saved = () => evaluate("JSON.parse(localStorage.getItem('desktop-calendar:day:2026-10-24')).tasks");
  const rootOrder = () => evaluate("[...document.querySelectorAll('.task-tree > .task-node > .task-row')].map(e=>e.dataset.taskId)");
  const check = (label) => console.log(`PASS ${label}`);

  await seed();
  const beforeDown = await saved();
  const a = await start('A');
  const b = await rect('B');
  await moveTo(a.hx, b.bottom - 4);
  assert.deepEqual((await rootOrder()).slice(0, 3), ['B', 'A', 'C']);
  assert.deepEqual(await saved(), beforeDown);
  assert.equal(await evaluate("[...document.querySelectorAll('.task-tree .task-row')].some(e=>e.getAnimations().some(a=>a.playState==='running'))"), true);
  assert.equal(await evaluate("document.querySelector('.drop-preview') === null && Boolean(document.querySelector('.task-drag-projection'))"), true);
  assert.equal(await evaluate("document.querySelector('.task-drag-float')===null && document.querySelector('.task-drag-title').textContent==='A' && !document.querySelector('.is-drag-parent')"), true);
  await mkdir(join(root, 'src-tauri/target'), { recursive: true });
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(root, 'src-tauri/target/drag-ui-preview.png'), Buffer.from(screenshot.data, 'base64'));
  await release(a.hx, b.bottom - 4);
  assert.deepEqual((await saved()).slice(0, 3).map(x => x.id), ['B', 'A', 'C']);
  check('live downward preview and commit; no save before release');

  await seed();
  const c = await start('C');
  const first = await rect('A');
  await moveTo(c.hx, first.top + 2);
  await release(c.hx, first.top + 2);
  assert.deepEqual((await saved()).slice(0, 3).map(x => x.id), ['C', 'A', 'B']);
  check('upward reorder with unequal card heights');

  await seed();
  const escapeStart = await start('A');
  const escapeB = await rect('B');
  await moveTo(escapeStart.hx, escapeB.bottom - 2);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(250);
  assert.deepEqual((await rootOrder()).slice(0, 3), ['A', 'B', 'C']);
  assert.equal(await evaluate("document.querySelectorAll('.task-drag-projection,.task-drag-float').length"), 0);
  await mouse('mouseReleased', escapeStart.hx, escapeB.bottom - 2, 0);
  check('Escape restores the original DOM without changing data');

  await seed();
  const invalid = await start('A');
  const failed = await rect('failed');
  await moveTo(invalid.hx, failed.top + 2);
  assert.equal(await evaluate("document.body.classList.contains('is-task-drop-invalid')"), true);
  assert.equal(await evaluate("getComputedStyle(document.body).cursor"), 'grabbing');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.task-drag-indicator.is-drop-invalid'), '::after').content !== 'none'"), true);
  const invalidScreenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(root, 'src-tauri/target/drag-invalid-preview.png'), Buffer.from(invalidScreenshot.data, 'base64'));
  await release(invalid.hx, failed.top + 2);
  assert.equal((await saved())[0].id, 'A');
  assert.equal(await evaluate("[...document.querySelectorAll('.task-row')].filter(e=>['failed','deleted'].includes(e.dataset.taskId)).every(e=>!e.querySelector('.drag-handle'))"), true);
  check('cross-status rejection and failed/deleted drag restrictions');

  await seed();
  const nesting = await start('A');
  const parent = await rect('P');
  await moveTo(nesting.hx + 30, parent.bottom - 3);
  assert.equal(await evaluate("document.querySelector('.task-drag-projection').parentElement.closest('.task-node').querySelector(':scope > .task-row').dataset.taskId"), 'P');
  await release(nesting.hx + 30, parent.bottom - 3);
  assert.equal((await saved()).find(x => x.id === 'P').children[0].id, 'A');
  check('deliberate horizontal indent creates a child at the previewed position');

  await seed();
  const parentStart = await start('P');
  const anchor = await rect('B');
  await moveTo(parentStart.hx, anchor.top + 2);
  assert.equal(await evaluate("document.querySelectorAll('.task-drag-projection .task-row').length"), 3);
  await release(parentStart.hx, anchor.top + 2);
  assert.deepEqual((await saved()).slice(0, 3).map(x => x.id), ['A', 'P', 'B']);
  assert.deepEqual((await saved()).find(x => x.id === 'P').children.map(x => x.id), ['X', 'Y']);
  check('moving a whole expanded subtree preserves every descendant');

  const inheritedTag = { id: 'parent-tag', text: 'Inherited', color: '#99b888', source: 'custom' };
  const folded = fixture();
  folded[3].collapsed = true;
  folded[3].tags = [inheritedTag];
  await seed(folded);
  const collapsedStart = await start('A');
  const collapsedParent = await rect('P');
  await moveTo(collapsedStart.hx + 30, collapsedParent.bottom - 3);
  assert.equal(await evaluate("document.querySelector('.task-drag-projection .tag-chip')===null"), true);
  assert.equal(await evaluate("document.querySelector('.task-drag-projection').parentElement.classList.contains('is-collapsed')"), false);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await mouse('mouseReleased', collapsedStart.hx + 30, collapsedParent.bottom - 3, 0);
  assert.equal(await evaluate("[...document.querySelectorAll('.task-row')].find(e=>e.dataset.taskId==='P').classList.contains('is-collapsed')"), true);
  assert.equal((await saved()).find(x => x.id === 'P').collapsed, true);
  check('collapsed parent preview keeps child tags hidden and cancellation restores folding');

  await seed();
  const outdent = await start('X');
  const lastChild = await rect('Y');
  await moveTo(outdent.hx - 30, lastChild.bottom + 3);
  await release(outdent.hx - 30, lastChild.bottom + 3);
  assert.deepEqual((await saved()).slice(0, 6).map(x => x.id), ['A', 'B', 'C', 'P', 'X', 'done']);
  assert.deepEqual((await saved()).find(x => x.id === 'P').children.map(x => x.id), ['Y']);
  check('horizontal outdent uses the visible ancestor boundary');

  await seed(Array.from({ length: 25 }, (_, i) => t(`Scroll-${i}`)));
  await waitFor("!document.querySelector('.scroll-edge-hint.is-below').hidden&&document.querySelector('.scroll-edge-hint.is-above').hidden");
  await evaluate("document.querySelector('.task-list').focus()");
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
  await waitFor("document.querySelector('.task-list').scrollTop>20&&!document.querySelector('.scroll-edge-hint.is-above').hidden");
  assert.equal(await evaluate("(()=>{const h=document.querySelector('.scroll-edge-hint.is-above').getBoundingClientRect(),s=document.querySelector('.status-summary').getBoundingClientRect();return h.top>=s.bottom})()"), true);
  const middleScreenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(root, 'src-tauri/target/day-scroll-middle.png'), Buffer.from(middleScreenshot.data, 'base64'));
  const beforeHintClick = await evaluate("document.querySelector('.task-list').scrollTop");
  await evaluate("document.querySelector('.scroll-edge-hint.is-below').click()");
  await waitFor(`document.querySelector('.task-list').scrollTop>${beforeHintClick + 30}`);
  await evaluate("(()=>{const list=document.querySelector('.task-list');list.scrollTo({top:list.scrollHeight,behavior:'instant'})})()");
  await waitFor("document.querySelector('.scroll-edge-hint.is-below').hidden&&!document.querySelector('.scroll-edge-hint.is-above').hidden");
  assert.equal(await evaluate("(()=>{const list=document.querySelector('.task-list');return document.querySelector('.task-tree').getBoundingClientRect().bottom<=list.getBoundingClientRect().bottom})()"), true);
  await evaluate("document.querySelector('.search-toggle').click();const input=document.querySelector('.task-search-input');input.value='No matching task';input.dispatchEvent(new Event('input',{bubbles:true}))");
  await waitFor("document.querySelectorAll('.task-row').length===0&&[...document.querySelectorAll('.scroll-edge-hint')].every(h=>h.hidden)");
  check('scroll hints follow top/middle/bottom; keyboard and hint scrolling work; statistics and last task stay visible; empty search clears hints');

  await seed([t('Only-task')]);
  await waitFor("[...document.querySelectorAll('.scroll-edge-hint')].every(h=>h.hidden)");
  check('short task lists show no unnecessary scroll hints');

  await seed(Array.from({ length: 25 }, (_, i) => t(`Scroll-${i}`)));
  const scrolling = await start('Scroll-0');
  const listBottom = await evaluate("document.querySelector('.task-list').getBoundingClientRect().bottom");
  await moveTo(scrolling.hx, listBottom - 8);
  await sleep(350);
  assert.ok(await evaluate("document.querySelector('.task-list').scrollTop") > 60);
  await release(420, listBottom - 8);
  assert.equal((await saved())[0].id, 'Scroll-0');
  assert.equal(await evaluate("document.querySelectorAll('.task-drag-projection,.task-drag-float').length"), 0);
  check('edge autoscroll works and release outside cancels without saving');

  await seed([t('L1'), t('L2'), t('L3'), t('LD', 'deleted')], 'month');
  await command('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(80);
  const long = await start('L1', '.long-task-item');
  const longB = await rect('L2', '.long-task-item');
  await moveTo(long.hx, longB.bottom - 2);
  await release(long.hx, longB.bottom - 2);
  assert.deepEqual((await evaluate("JSON.parse(localStorage.getItem('desktop-calendar:long-tasks')).tasks")).slice(0, 3).map(x => x.id), ['L2', 'L1', 'L3']);
  check('long tasks share the live-preview interaction');

  await seed([t('L1'), t('L2'), t('L3'), t('LD', 'deleted')], 'month');
  const canceledLong = await start('L1', '.long-task-item');
  const cancelAnchor = await rect('L2', '.long-task-item');
  await moveTo(canceledLong.hx, cancelAnchor.bottom - 2);
  await evaluate("window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }))");
  await sleep(250);
  await mouse('mouseReleased', canceledLong.hx, cancelAnchor.bottom - 2, 0);
  assert.deepEqual((await evaluate("JSON.parse(localStorage.getItem('desktop-calendar:long-tasks')).tasks")).slice(0, 3).map(x => x.id), ['L1', 'L2', 'L3']);
  assert.equal(await evaluate("document.querySelectorAll('.task-drag-projection,.task-drag-float').length"), 0);
  check('device pointer cancellation never commits a long-task move');

  assert.deepEqual(exceptions, []);
  console.log('No browser runtime exceptions. Screenshot: src-tauri/target/drag-ui-preview.png');
  await call('Browser.close');
} finally {
  socket?.close();
  chrome.kill();
  server.close();
  // Only remove the fresh profile created by this test, after verifying its absolute temp prefix.
  if (resolve(profile).startsWith(join(resolve(tmpdir()), 'calendar-drag-test-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }).catch(() => {});
  }
}
