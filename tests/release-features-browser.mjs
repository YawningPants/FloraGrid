import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolated origin, browser profile, and synthetic tasks. Never touches native calendar data.
const root = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const server = createServer(async (request, response) => {
  const path = resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
  if (!path.startsWith(root)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const content = await readFile(path);
    response.setHeader(
      'Content-Type',
      { '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(path)] ||
        'application/octet-stream',
    );
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'rizhi-release-features-'));
const chrome = spawn(
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  [
    '--headless=new',
    '--disable-popup-blocking',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
);
let socket,
  id = 0;
const pending = new Map(),
  exceptions = [];
try {
  const endpoint = await new Promise((done, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => reject(Error(stderr)), 20000);
    chrome.once('error', reject);
    chrome.stderr.on('data', (data) => {
      stderr += data;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        done(match[1]);
      }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((done) => socket.addEventListener('open', done, { once: true }));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { done, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(Error(JSON.stringify(message.error)));
      else done(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((done, reject) => {
      const requestId = ++id;
      pending.set(requestId, { done, reject });
      socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params = {}) => call(method, params, sessionId);
  const read = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 160; i++) {
      if (await read(expression)) return;
      await sleep(25);
    }
    throw Error(`Timed out: ${expression}`);
  };
  const click = (selector) => read(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const pointerClick = async (selector) => {
    await read(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
    const r = await read(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
    );
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, buttons: 0 });
    await command('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: r.x,
      y: r.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await command('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: r.x,
      y: r.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  };
  const key = async (name, code) => {
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: name,
      code: name,
      windowsVirtualKeyCode: code,
      ...(name === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
    });
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: name,
      code: name,
      windowsVirtualKeyCode: code,
    });
  };
  const reload = async (ready) => {
    const previous = await read('performance.timeOrigin');
    await command('Page.reload');
    await wait(`performance.timeOrigin!==${previous} && (${ready})`);
  };
  const button = (id) => `.task-row[data-task-id="${id}"] .status-button`;
  const check = (text) => console.log(`PASS ${text}`);
  const screenshot = async (name) => {
    await mkdir(join(root, 'src-tauri/target'), { recursive: true });
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(root, `src-tauri/target/release-${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  const setTheme = (settings) =>
    read(
      `(()=>{const settings=${JSON.stringify(settings)};localStorage.setItem('desktop-calendar-theme',JSON.stringify(settings));window.dispatchEvent(new CustomEvent('calendar://theme-updated',{detail:{settings}}))})()`,
    );
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Page.bringToFront');
  await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `const OriginalDate=Date;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-10-24T12:00:00']))}static now(){return OriginalDate.parse('2026-10-24T12:00:00')}}`,
  });
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 780,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await command('Page.navigate', { url: `${origin}/src/index.html?view=day&date=2026-10-24` });
  await wait("document.querySelector('.day-window') && !document.querySelector('.search-empty')");

  const tasks = [
    {
      id: 'root',
      title: '把生活整理成喜欢的样子',
      status: 'active',
      color: '#9cbfd0',
      tags: [{ id: 'tag', text: '生活', color: '#a8be9e' }],
      children: [
        {
          id: 'child',
          title: '读一小节书，留下一句喜欢的话',
          status: 'active',
          color: '#d2a9b7',
          tags: [],
          children: [],
        },
        {
          id: 'nested',
          title: '整理窗边的绿植',
          status: 'active',
          tags: [],
          children: [{ id: 'leaf', title: '浇水与修剪', status: 'active', tags: [], children: [] }],
        },
        { id: 'done', title: '给自己泡一杯热茶', status: 'completed', tags: [], children: [] },
      ],
    },
  ];
  await read(
    `localStorage.clear();localStorage.setItem('desktop-calendar:day:2026-10-24',JSON.stringify(${JSON.stringify({ date: '2026-10-24', note: '给每一天留一点空白。', tasks })}))`,
  );
  await reload("document.querySelector('[data-task-id=child]')");
  await setTheme({ presetId: 'morning', appearance: 'minimal', surfaceStyle: 'glass', opacity: 0.84 });
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await read('document.activeElement.blur()');
  await sleep(200);
  assert.equal(
    await read("getComputedStyle(document.querySelector('[data-task-id=child]')).borderTopWidth"),
    '0px',
  );
  assert.equal(
    await read("getComputedStyle(document.querySelector('[data-task-id=leaf]')).borderTopWidth"),
    '0px',
  );
  assert.equal(
    await read("getComputedStyle(document.querySelector('[data-task-id=child] .task-color-button')).opacity"),
    '0',
  );
  await pointerClick('[data-task-id=child] .task-color-button');
  assert.equal(await read("document.querySelector('.task-color-palette')!==null"), true);
  await key('Escape', 27);
  check('minimal children share a quiet hierarchy, retain colors and expose their palette on interaction');
  for (const presetId of ['morning', 'mist', 'apricot', 'sage', 'rose']) {
    await setTheme({ presetId, appearance: 'botanical', surfaceStyle: 'notebook', opacity: 0.34 });
    assert.equal(await read('document.documentElement.dataset.surfaceStyle'), 'notebook');
    assert.equal(
      await read("getComputedStyle(document.querySelector('.day-window')).backdropFilter"),
      'none',
    );
    await screenshot(`notebook-day-${presetId}`);
  }
  await command('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 780,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await setTheme({ presetId: 'morning', appearance: 'minimal', surfaceStyle: 'notebook' });
  assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true);
  await screenshot('notebook-minimal-320');
  await command('Page.navigate', { url: `${origin}/src/index.html#settings?tab=theme` });
  await command('Emulation.setDeviceMetricsOverride', {
    width: 780,
    height: 560,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await wait("document.querySelector('[data-surface=notebook]')");
  assert.equal(
    await read("getComputedStyle(document.querySelector('.theme-opacity-control')).display"),
    'none',
  );
  assert.equal(await read("document.querySelectorAll('.theme-preset').length"), 5);
  assert.equal(
    await read("document.querySelector('[data-appearance=minimal]').textContent.includes('保留原来')"),
    false,
  );
  await click('[data-surface=glass]');
  assert.notEqual(
    await read("getComputedStyle(document.querySelector('.theme-opacity-control')).display"),
    'none',
  );
  await click('[data-surface=notebook]');
  await reload("document.querySelector('[data-surface=notebook][aria-pressed=true]')");
  await screenshot('notebook-settings');
  await click('[data-settings-tab=data]');
  await wait("document.querySelector('.export-data')");
  await screenshot('notebook-data');
  check('five paper palettes, both appearances, 320px layout, opacity behavior and persisted settings');
  await setTheme({ presetId: 'morning', appearance: 'botanical', surfaceStyle: 'notebook' });
  await command('Page.navigate', { url: `${origin}/src/index.html?view=month&date=2026-10-24` });
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 820,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await wait("document.querySelector('.month-task-leaf-root') && document.querySelector('.plant-task-fork')");
  assert.equal(
    await read("[...document.querySelectorAll('.month-day-cell.is-outside')].every(cell=>cell.disabled)"),
    true,
  );
  assert.equal(
    await read(
      "[...document.querySelectorAll('.month-day-cell:not(.is-outside)')].every(cell=>!cell.disabled)",
    ),
    true,
  );
  assert.equal(
    await read(
      `(()=>{const svg=document.querySelector('.month-plant-branches'),m=svg.getScreenCTM();const ends=[...svg.querySelectorAll('.plant-task-fork')].map(path=>{const p=path.getPointAtLength(path.getTotalLength());return {x:p.x*m.a+m.e,y:p.y*m.d+m.f}});return [...document.querySelectorAll('.month-task-leaf-root')].every(root=>{const r=root.getBoundingClientRect();return ends.some(p=>Math.hypot(p.x-r.x,p.y-r.y)<.2)})})()`,
    ),
    true,
  );
  await screenshot('notebook-month');
  check('outside-month dates disabled, all active leaf bases connected to branch endpoints');
  // A controlled IPC bridge exercises confirmation, progress and recovery choices in Settings.
  await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `
    window.__calls=[];window.__listeners={};window.__location={isDefault:true,effectivePath:'D:/isolated/source'};
    window.__TAURI__={event:{listen:async(name,fn)=>{window.__listeners[name]=fn;return()=>{}},emit:async()=>{}},core:{invoke:async(name,args)=>{
      window.__calls.push({name,args});
      if(name==='load_reminder_state')return {rules:[],exceptions:{}};
      if(name==='get_settings_navigation')return {tab:'data',revision:1};
      if(name==='load_storage_location')return window.__location;
      if(name==='pick_data_directory')return 'D:/isolated/target';
      if(name==='inspect_storage_target')return {path:'D:/isolated/target',empty:false,files:4,sameRoot:false,related:false,stamp:'target-stamp'};
      if(name==='pick_backup_path')return args.save?'D:/isolated/export.json':'D:/isolated/import.json';
      if(name==='preview_backup_file')return {files:4,days:2,tasks:5,longTasks:3,groups:1,reminders:2,fingerprint:'archive-stamp'};
      if(name==='perform_data_transfer'){
        window.__listeners['calendar://data-transfer-progress']?.({payload:{id:args.request.id,label:'迁移并核验数据',progress:.5,file:'days/2026/10/2026-10-24.json'}});
        return new Promise(resolve=>window.__finishTransfer=()=>{
          if(args.request.kind==='move'){window.__location={isDefault:false,effectivePath:'D:/isolated/target'};resolve({location:window.__location,cleanupToken:'verified-copy',sourcePath:'D:/isolated/source',backupPath:'D:/isolated/safety.json'});}
          else if(args.request.kind==='import')resolve({files:4,backupPath:'D:/isolated/before-import.json',preferences:{theme:{surfaceStyle:'notebook',presetId:'sage',appearance:'minimal'}}});
          else resolve({path:'D:/isolated/export.json',deleted:4});
        });
      }
      throw Error('Unexpected IPC '+name);
    }}};
  `,
  });
  await command('Page.navigate', { url: `${origin}/src/index.html#settings?tab=data` });
  await command('Emulation.setDeviceMetricsOverride', {
    width: 780,
    height: 560,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await wait("document.querySelector('.choose-storage')");
  await click('.choose-storage');
  await wait("document.querySelector('.migrate-data')");
  assert.equal(await read("document.querySelector('.migrate-data').checked"), true);
  assert.equal(
    await read("document.querySelector('.data-confirm-dialog').textContent.includes('不为空')"),
    true,
  );
  await screenshot('migration-confirmation');
  await click('.confirm-action');
  await wait('Boolean(window.__finishTransfer)');
  assert.equal(await read("document.querySelector('.data-operation-status progress').value"), 0.5);
  assert.equal(await read("document.querySelector('.data-dialog-progress progress').value"), 0.5);
  assert.notEqual(
    await read("getComputedStyle(document.querySelector('.data-dialog-progress')).display"),
    'none',
  );
  await screenshot('migration-progress');
  assert.equal(
    await read("[...document.querySelectorAll('.settings-tab,.close-settings')].every(b=>b.disabled)"),
    true,
  );
  await read('window.__finishTransfer()');
  await wait("document.querySelector('.data-confirm-dialog')?.textContent.includes('迁移完成')");
  assert.equal(
    await read("window.__calls.find(c=>c.name==='perform_data_transfer').args.request.targetStamp"),
    'target-stamp',
  );
  await click('.data-confirm-dialog .cancel');
  assert.equal(await read("window.__calls.some(c=>c.args?.request?.kind==='cleanup')"), false);
  await click('.export-data');
  await wait("window.__calls.some(c=>c.args?.request?.kind==='export')");
  await read('window.__finishTransfer()');
  await wait("!document.querySelector('.export-data').disabled");
  await click('.import-data');
  await wait("document.querySelector('.backup-summary')");
  assert.equal(
    await read("document.querySelector('.backup-summary').textContent.includes('5 个任务')"),
    true,
  );
  await click('.confirm-action');
  await wait("window.__calls.some(c=>c.args?.request?.kind==='import')");
  await read('window.__finishTransfer()');
  await wait("!document.querySelector('.data-confirm-dialog')");
  assert.equal(await read('document.documentElement.dataset.surfaceStyle'), 'notebook');
  assert.equal(await read("JSON.parse(localStorage.getItem('desktop-calendar-theme')).presetId"), 'sage');
  assert.equal(
    await read("window.__calls.find(c=>c.args?.request?.kind==='import').args.request.fingerprint"),
    'archive-stamp',
  );
  check(
    'native IPC UI: nonempty warning, migration default, progress, keep-original default, export/import preview and appearance restore',
  );
  assert.deepEqual(exceptions, []);
  console.log('No runtime exceptions. Screenshots: src-tauri/target/release-*.png');
  await call('Browser.close');
} finally {
  socket?.close();
  chrome.kill();
  server.close();
  if (resolve(profile).startsWith(join(resolve(tmpdir()), 'rizhi-release-features-')))
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => {});
}
