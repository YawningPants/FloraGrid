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
const profile = await mkdtemp(join(tmpdir(), 'calendar-settings-test-'));
const chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-popup-blocking', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
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
  const waitFor = async (expression, evaluateIn = evaluate) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await evaluateIn(expression)) return;
      await sleep(25);
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const attach = async (id) => {
    const { sessionId: attachedSession } = await call('Target.attachToTarget', { targetId: id, flatten: true });
    const send = (method, params) => call(method, params, attachedSession);
    await send('Runtime.enable');
    await send('Page.enable');
    const read = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    return { send, read };
  };
  const click = (read, selector) => read(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled)throw Error('Unavailable: '+${JSON.stringify(selector)});button.click()})()`);
  const active = "document.querySelector('.settings-tab.is-active')?.dataset.settingsTab";
  const check = (label) => console.log(`PASS ${label}`);
  const settingsTargets = async () => (await call('Target.getTargets')).targetInfos.filter(target => target.type === 'page' && target.url.includes('#settings'));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `${origin}/src/index.html?view=day&date=2026-10-24` });
  await waitFor("Boolean(document.querySelector('.day-window'))");
  const task = { id: 'settings-test', title: '设置入口测试', status: 'active', tags: [], children: [] };
  await evaluate(`localStorage.clear();localStorage.setItem('desktop-calendar:day:2026-10-24',JSON.stringify(${JSON.stringify({ date: '2026-10-24', note: '', tasks: [task] })}));localStorage.setItem('desktop-calendar:long-tasks',JSON.stringify(${JSON.stringify({ version: 1, tasks: [task] })}))`);
  await command('Page.reload');
  await waitFor("Boolean(document.querySelector('.tag-add-button'))");
  await click(evaluate, '.tag-add-button');
  await click(evaluate, '.tag-manage-link');
  for (let attempt = 0; attempt < 100 && !(await settingsTargets()).length; attempt++) await sleep(25);
  assert.equal((await settingsTargets()).length, 1);
  const settingsId = (await settingsTargets())[0].targetId;
  const settings = await attach(settingsId);
  await settings.send('Emulation.setDeviceMetricsOverride', { width: 780, height: 560, deviceScaleFactor: 1, mobile: false });
  await waitFor(`${active}==='tags' && document.querySelectorAll('.tag-group-card').length===3`, settings.read);
  await settings.read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
  assert.equal(await settings.read("document.querySelectorAll('.window-titlebar').length"), 1);
  assert.equal(await settings.read("document.querySelectorAll('.tag-manager-page').length"), 1);
  await settings.read("window.__tagPage=document.querySelector('.tag-manager-page');window.__settingsBoot=crypto.randomUUID();window.__closes=0;window.calendarShell.close=()=>window.__closes++");
  const boot = await settings.read('window.__settingsBoot');
  await click(settings.read, '[data-group-id="group-life"] .tag-group-toggle');
  await click(settings.read, '[data-group-id="group-work"] .tag-manager-add-tag');
  await settings.read("(()=>{const input=document.querySelector('.tag-manager-draft-input');input.value='保留的标签草稿';input.dispatchEvent(new Event('input',{bubbles:true}))})()");
  await click(settings.read, '.tag-manager-color-dot');
  await click(settings.read, '.tag-manager-palette [aria-label="草绿"]');
  const draftColor = await settings.read("document.querySelector('.tag-manager-editor').style.getPropertyValue('--tag-color')");
  await settings.send('Emulation.setDeviceMetricsOverride', { width: 780, height: 420, deviceScaleFactor: 1, mobile: false });
  await settings.read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
  const scrollTop = await settings.read("(()=>{const body=document.querySelector('.tag-manager-body');body.scrollTop=body.scrollHeight;return body.scrollTop})()");
  assert.ok(scrollTop > 0);
  await mkdir(join(root, 'src-tauri/target'), { recursive: true });
  const scrollPreview = await settings.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(root, 'src-tauri/target/settings-tags-scroll.png'), Buffer.from(scrollPreview.data, 'base64'));
  await click(settings.read, '[data-settings-tab="theme"]');
  assert.equal(await settings.read(`${active}`), 'theme');
  assert.equal(await settings.read("document.querySelector('.tag-manager-page').hidden"), true);
  await settings.read("document.querySelector('.settings-tab.is-active').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
  assert.equal(await settings.read('window.__closes'), 1);
  assert.equal(await settings.read("document.querySelector('.tag-manager-draft-input').value"), '保留的标签草稿');
  await click(settings.read, '[data-settings-tab="data"]');
  await waitFor("Boolean(document.querySelector('.storage-path-value'))", settings.read);
  await click(settings.read, '[data-settings-tab="tags"]');
  assert.equal(await settings.read("window.__tagPage===document.querySelector('.tag-manager-page')"), true);
  assert.equal(await settings.read("document.querySelector('.tag-manager-editor').style.getPropertyValue('--tag-color')"), draftColor);
  assert.equal(await settings.read("document.querySelector('[data-group-id=\"group-life\"] .tag-group-toggle').getAttribute('aria-expanded')"), 'false');
  assert.equal(await settings.read("document.querySelector('.tag-manager-body').scrollTop"), scrollTop);
  await click(settings.read, '[data-settings-tab="data"]');
  await waitFor("Boolean(document.querySelector('.choose-storage'))", settings.read);
  await click(settings.read, '.choose-storage');
  assert.equal(await settings.read(`${active}`), 'tags');
  assert.equal(await settings.read("document.querySelector('.tag-manager-draft-input').value"), '保留的标签草稿');
  await settings.send('Emulation.setDeviceMetricsOverride', { width: 780, height: 560, deviceScaleFactor: 1, mobile: false });
  check('settings embeds one tag editor; tab changes preserve drafts, color and folding; hidden editor ignores Escape');

  await click(settings.read, '[data-settings-tab="theme"]');
  await click(evaluate, '.settings-toggle');
  assert.equal((await settingsTargets()).length, 1);
  assert.equal(await settings.read('window.__settingsBoot'), boot);
  assert.equal(await settings.read(`${active}`), 'theme');
  await evaluate("void window.open('index.html#month','month-view','width=1180,height=820')");
  let monthTarget;
  for (let attempt = 0; attempt < 100; attempt++) {
    monthTarget = (await call('Target.getTargets')).targetInfos.find(target => target.type === 'page' && target.url.endsWith('#month'));
    if (monthTarget) break;
    await sleep(25);
  }
  assert.ok(monthTarget);
  const month = await attach(monthTarget.targetId);
  await waitFor("Boolean(document.querySelector('.add-long-tag'))", month.read);
  await click(month.read, '.month-long-toggle');
  await click(month.read, '.add-long-tag');
  await click(month.read, '.tag-manage-link');
  await waitFor(`${active}==='tags'`, settings.read);
  assert.equal((await settingsTargets()).length, 1);
  assert.equal(await settings.read('window.__settingsBoot'), boot);
  assert.equal(await settings.read("document.querySelector('.tag-manager-draft-input').value"), '保留的标签草稿');
  await click(evaluate, '.tag-add-button');
  await click(evaluate, '.tag-manage-link');
  await click(month.read, '.month-settings-toggle');
  assert.equal((await settingsTargets()).length, 1);
  assert.equal(await settings.read('window.__settingsBoot'), boot);
  await evaluate("void window.open('index.html#tag-manager','legacy-tag-manager')");
  await sleep(250);
  assert.equal((await settingsTargets()).length, 1);
  assert.equal(await settings.read('window.__settingsBoot'), boot);
  await Promise.all([
    evaluate("(async()=>{const {openSettingsWindow}=await import('./ui/settings-window.mjs');await Promise.all(Array.from({length:5},()=>openSettingsWindow('tags')))})()"),
    month.read("(async()=>{const {openSettingsWindow}=await import('./ui/settings-window.mjs');await Promise.all(Array.from({length:5},()=>openSettingsWindow('tags')))})()"),
  ]);
  assert.equal((await settingsTargets()).length, 1);
  assert.equal(await settings.read('window.__settingsBoot'), boot);
  check('day/month settings and manage links reuse one named window without reload; legacy route redirects');

  await settings.send('Page.bringToFront');
  await click(settings.read, '.tag-manager-draft-cancel');
  for (const width of [780, 560, 320]) {
    await settings.send('Emulation.setDeviceMetricsOverride', { width, height: 560, deviceScaleFactor: 1, mobile: false });
    await settings.read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    await click(settings.read, '.tag-manager-add-tag');
    await click(settings.read, '.tag-manager-color-dot');
    assert.equal(await settings.read("(()=>{const r=document.querySelector('.tag-manager-palette').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"), true);
    await click(settings.read, '[data-settings-tab="theme"]');
    assert.equal(await settings.read("document.querySelector('.tag-manager-palette')===null"), true);
    await click(settings.read, '[data-settings-tab="tags"]');
    await click(settings.read, '.tag-manager-draft-cancel');
    assert.equal(await settings.read("document.documentElement.scrollWidth<=innerWidth"), true);
  }
  await settings.send('Emulation.setDeviceMetricsOverride', { width: 780, height: 560, deviceScaleFactor: 1, mobile: false });
  await mkdir(join(root, 'src-tauri/target'), { recursive: true });
  const screenshot = await settings.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(root, 'src-tauri/target/settings-tags-preview.png'), Buffer.from(screenshot.data, 'base64'));
  check('embedded tag editor and palette fit normal, minimum, and narrow browser sizes');

  // Simulate the Tauri bridge to exercise ready/event ordering and saves in flight.
  // Rust window code is compiled separately with cargo check.
  const { targetId: nativeId } = await call('Target.createTarget', { url: 'about:blank' });
  const native = await attach(nativeId);
  await native.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__nativeListeners={};window.__nativeCalls=[];
    window.__TAURI__={
      event:{listen:async(name,handler)=>{window.__nativeListeners[name]=handler;return()=>delete window.__nativeListeners[name]},emit:async()=>{}},
      core:{invoke:async(name,args)=>{
        window.__nativeCalls.push({name,args});
        if(name==='load_reminder_state')return {version:1,revision:0,rules:[],exceptions:{}};
        if(name==='get_settings_navigation')return new Promise(resolve=>window.__resolveNavigation=resolve);
        if(name==='load_tag_templates')return JSON.parse(localStorage.getItem('desktop-calendar:tag-templates')||'null');
        if(name==='save_tag_templates')return new Promise((resolve,reject)=>{window.__resolveSave=()=>{localStorage.setItem('desktop-calendar:tag-templates',JSON.stringify(args.templates));resolve()};window.__rejectSave=()=>reject(Error('Injected settings save error'))});
        if(name==='load_storage_location')return {isDefault:true,effectivePath:'isolated-test-data'};
        if(name==='open_settings_window')return;
        throw Error('Unexpected test IPC '+name);
      }}
    };
  ` });
  await native.send('Page.navigate', { url: `${origin}/src/index.html#settings?tab=theme` });
  await waitFor("Boolean(window.__resolveNavigation)", native.read);
  await native.read("window.__nativeListeners['calendar://settings-navigate']({payload:{tab:'tags',revision:3}});window.__resolveNavigation({tab:'data',revision:2})");
  await waitFor(`${active}==='tags' && document.querySelectorAll('.tag-group-card').length>0`, native.read);
  await click(native.read, '.tag-manager-add-tag');
  await native.read("(()=>{const input=document.querySelector('.tag-manager-draft-input');input.value='保存中的草稿';input.dispatchEvent(new Event('input',{bubbles:true}))})()");
  await click(native.read, '.tag-manager-draft-save');
  await waitFor("Boolean(window.__rejectSave)", native.read);
  assert.equal(await native.read("[...document.querySelectorAll('.settings-tab')].every(button=>button.disabled)"), true);
  await native.read("window.__nativeListeners['calendar://settings-navigate']({payload:{tab:'theme',revision:4}})");
  assert.equal(await native.read(`${active}`), 'tags');
  await native.read('window.__rejectSave()');
  await waitFor("document.querySelector('.tag-manager-save-status').classList.contains('is-error')", native.read);
  assert.equal(await native.read(`${active}`), 'tags');
  assert.equal(await native.read("document.querySelector('.tag-manager-draft-input').value"), '保存中的草稿');
  await click(native.read, '.tag-manager-draft-save');
  await native.read("window.__nativeListeners['calendar://settings-navigate']({payload:{tab:'theme',revision:5}});window.__resolveSave()");
  await waitFor(`${active}==='theme' && !document.querySelector('.tag-manager-draft-input')`, native.read);
  await native.read("window.__nativeListeners['calendar://settings-navigate']({payload:{tab:'tags',revision:6}})");
  await waitFor(`${active}==='tags'`, native.read);
  assert.equal(await native.read("document.querySelectorAll('.tag-manager-page').length"), 1);
  await native.read("(async()=>{const {openSettingsWindow}=await import('./ui/settings-window.mjs');await openSettingsWindow('tags')})()");
  assert.deepEqual(await native.read("window.__nativeCalls.filter(call=>call.name==='open_settings_window').at(-1).args"), { tab: 'tags' });
  check('Tauri ready handshake ignores stale replies; failed saves retain editor; successful saves release queued navigation');

  assert.deepEqual(exceptions, []);
  console.log('No browser runtime exceptions. Screenshot: src-tauri/target/settings-tags-preview.png');
  await call('Browser.close');
} finally {
  socket?.close();
  chrome.kill();
  server.close();
  // Only remove the fresh profile created by this test, after verifying its absolute temp prefix.
  if (resolve(profile).startsWith(join(resolve(tmpdir()), 'calendar-settings-test-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }).catch(() => {});
  }
}
