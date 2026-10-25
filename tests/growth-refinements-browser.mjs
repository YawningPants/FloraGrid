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
const profile = await mkdtemp(join(tmpdir(), 'rizhi-growth-refinement-'));
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
    await writeFile(join(root, `src-tauri/target/growth-${name}.png`), Buffer.from(shot.data, 'base64'));
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

  // New install defaults; legacy taskbar brand files are never changed by titlebar switching.
  await read('localStorage.clear()');
  await reload("document.querySelector('.day-window')");
  assert.equal(await read('document.documentElement.dataset.surfaceStyle'), 'notebook');
  assert.equal(await read('document.documentElement.dataset.appearance'), 'botanical');
  assert.ok(await read("document.querySelector('.window-brand-icon').src.endsWith('icon-32.png')"));
  await command('Page.navigate', { url: `${origin}/src/index.html#settings?tab=theme` });
  await command('Emulation.setDeviceMetricsOverride', {
    width: 780,
    height: 600,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await wait("document.querySelector('[data-surface]')");
  assert.equal(await read("document.querySelector('[data-surface]').dataset.surface"), 'notebook');
  await click('[data-surface=glass]');
  await wait(
    "document.querySelector('.window-brand-icon').complete&&document.querySelector('.window-brand-icon').src.endsWith('icon-32.png')",
  );
  assert.ok(await read("document.querySelector('.window-brand-icon').naturalWidth>0"));
  await screenshot('glass-brand');
  await click('[data-surface=notebook]');
  assert.ok(await read("document.querySelector('.window-brand-icon').src.endsWith('icon-32.png')"));
  check('fresh defaults, paper-first settings, and original titlebar logo in both surface styles');
  const t = (id, status = 'active', children = [], collapsed = false) => ({
    id,
    title: id,
    status,
    children,
    collapsed,
    tags: [],
    flower: { variant: 'cosmos', tone: 'rose' },
    completedAt: status === 'completed' ? 1 : undefined,
  });
  let run = 0;
  async function seed(tasks, appearance = 'botanical') {
    await read(
      "(async()=>{const {flushDaySave}=await import('/src/storage/day-storage.mjs');await flushDaySave()})()",
    );
    await read(
      `localStorage.setItem('desktop-calendar:day:2026-10-24',JSON.stringify(${JSON.stringify({ date: '2026-10-24', note: '隔离功能样本', tasks })}));localStorage.setItem('desktop-calendar-theme',JSON.stringify({presetId:'morning',appearance:${JSON.stringify(appearance)},surfaceStyle:'notebook',gardenEnabled:true}))`,
    );
    await command('Page.navigate', {
      url: `${origin}/src/index.html?view=day&date=2026-10-24&test=${++run}`,
    });
    await command('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 850,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await wait(
      `new URLSearchParams(location.search).get('test')==='${run}'&&document.querySelector('[data-task-id="${tasks[0].id}"]')`,
    );
    await command('Page.bringToFront');
    await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
  }
  await seed([t('root', 'completed', [t('mid', 'completed', [t('leaf', 'completed')], true)], true)]);
  assert.equal(await read("document.querySelector('.day-header-garden').dataset.total"), '3');
  await click('[data-task-id=root] .collapse-toggle');
  await wait("!document.querySelector('.children.is-animating')");
  await click('[data-task-id=mid] .collapse-toggle');
  await wait("!document.querySelector('.children.is-animating')");
  await click('[data-task-id=leaf] .status-button');
  assert.equal(
    await read(
      "['root','mid','leaf'].every(id=>document.querySelector('[data-task-id='+id+']').classList.contains('is-active'))",
    ),
    true,
  );
  assert.equal(await read("document.querySelector('.status-summary').dataset.active"), '3');
  assert.equal(await read("document.querySelector('.status-summary').dataset.completed"), '0');
  assert.equal(await read("document.querySelector('.day-header-garden').dataset.total"), '0');
  await sleep(550);
  assert.equal(await read("document.querySelectorAll('.garden-plant').length"), 0);
  await read(
    "(async()=>{const {flushDaySave}=await import('/src/storage/day-storage.mjs');await flushDaySave()})()",
  );
  assert.equal(
    await read(
      "(()=>{const task=JSON.parse(localStorage.getItem('desktop-calendar:day:2026-10-24')).tasks[0];return task.status==='active'&&task.children[0].status==='active'&&task.children[0].children[0].status==='active'})()",
    ),
    true,
  );
  check(
    'undoing a nested completion reopens all completed ancestors, updates counters and removes all corresponding flowers',
  );
  const fixture = () => [
    t('A'),
    t('B'),
    t('P', 'completed', [t('C', 'completed')], true),
    t('Q', 'active', [t('D', 'completed')], true),
  ];
  await seed(fixture(), 'minimal');
  const rect = (id) =>
    read(
      `(()=>{const row=[...document.querySelectorAll('.task-row')].find(row=>row.dataset.taskId==='${id}'&&!row.closest('.task-drag-projection')),r=row.getBoundingClientRect(),h=row.querySelector('.drag-handle')?.getBoundingClientRect();return {left:r.left,top:r.top,bottom:r.bottom,hx:h?.left+h?.width/2,hy:h?.top+h?.height/2}})()`,
    );
  const mouse = (type, x, y, buttons = 1) =>
    command('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      buttons,
      ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
    });
  async function start(id) {
    const r = await rect(id);
    await mouse('mouseMoved', r.hx, r.hy, 0);
    await mouse('mousePressed', r.hx, r.hy);
    await mouse('mouseMoved', r.hx, r.hy + 8);
    await wait("document.querySelector('.task-drag-projection')");
    return r;
  }
  async function into(source, parent, cancel = false) {
    const a = await start(source),
      p = await rect(parent),
      x = a.hx + 32,
      y = p.bottom - 2;
    await mouse('mouseMoved', x, y);
    await sleep(120);
    assert.equal(await read("document.body.classList.contains('is-task-drop-invalid')"), false);
    assert.equal(
      await read("getComputedStyle(document.querySelector('.task-drag-projection')).outlineStyle"),
      'solid',
    );
    assert.equal(
      await read(
        "document.querySelector('.task-drag-projection').parentElement.closest('.task-node').querySelector(':scope > .task-row').dataset.taskId",
      ),
      parent,
    );
    if (cancel) {
      await key('Escape', 27);
      await mouse('mouseReleased', x, y, 0);
      await sleep(200);
      return;
    }
    await mouse('mouseReleased', x, y, 0);
    await sleep(1000);
  }
  await into('A', 'P', true);
  assert.equal(
    await read(
      "document.querySelector('[data-task-id=P]').classList.contains('is-completed')&&document.querySelector('[data-task-id=P]').closest('.task-node').querySelector(':scope>.children').classList.contains('is-collapsed')",
    ),
    true,
  );
  await into('A', 'P');
  assert.equal(
    await read("document.querySelector('[data-task-id=P]').classList.contains('is-active')"),
    true,
  );
  assert.equal(
    await read(
      "document.querySelector('[data-task-id=P]').closest('.task-node').querySelector(':scope>.children>.task-node>.task-row').dataset.taskId",
    ),
    'A',
  );
  await into('B', 'Q');
  assert.equal(
    await read(
      "document.querySelector('[data-task-id=Q]').closest('.task-node').querySelector(':scope>.children>.task-node>.task-row').dataset.taskId",
    ),
    'B',
  );
  await screenshot('minimal-drops');
  check(
    'minimal drag border, cancellation, and active/completed closed families accept a new active task before completed children',
  );
  const old = Array.from({ length: 40 }, (_, i) => ({ ...t(`old-${i}`, 'completed'), completedAt: i + 1 }));
  await seed([t('new'), ...old]);
  await wait('document.querySelector(\'.day-header-garden[data-visible="14"]\')');
  const ids = () =>
    read("[...document.querySelectorAll('.garden-plant:not([data-exit])')].map(n=>n.dataset.gardenTaskId)");
  const initial = await ids();
  assert.equal(await read("document.querySelectorAll('.garden-plant[data-layer=front]').length"), 8);
  assert.equal(await read("document.querySelectorAll('.garden-plant[data-layer=back]').length"), 6);
  await click('[data-task-id=new] .status-button');
  assert.equal(
    await read("document.querySelector('.garden-plant[data-exit=replacement]').dataset.layer"),
    'back',
  );
  assert.equal(await read("document.querySelector('[data-garden-task-id=new]').dataset.layer"), 'front');
  await sleep(1200);
  await screenshot('two-layer-garden');
  const current = await ids();
  await click('[data-task-id=new] .status-button');
  const restored = await ids(),
    appeared = restored.filter((id) => !current.includes(id));
  assert.equal(appeared.length, 1);
  assert.equal(
    await read(`document.querySelector('[data-garden-task-id="${appeared[0]}"]').dataset.layer`),
    'back',
  );
  assert.equal(
    await read(`document.querySelector('[data-garden-task-id="${appeared[0]}"]').dataset.phase`),
    'appearing',
  );
  await sleep(650);
  assert.deepEqual((await ids()).sort(), initial.sort());
  assert.equal(await read("document.querySelector('.day-header-garden').dataset.total"), '40');
  assert.equal(await read("document.querySelectorAll('.garden-sway-group').length"), 6);
  check(
    'two depth layers, silent back-row retirement, and undo backfill appearing only behind the front row',
  );
  assert.deepEqual(exceptions, []);
  console.log('No runtime exceptions. Screenshots: src-tauri/target/growth-*.png');
  await call('Browser.close');
} finally {
  socket?.close();
  chrome.kill();
  server.close();
  if (resolve(profile).startsWith(join(resolve(tmpdir()), 'rizhi-growth-refinement-')))
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => {});
}
