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
const profile = await mkdtemp(join(tmpdir(), 'rizhi-botanical-test-'));
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
      try {
        if (await read(expression)) return;
      } catch (error) {
        if (!/context|navigated/i.test(error.message)) throw error;
      }
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
    await writeFile(join(root, `src-tauri/target/botanical-${name}.png`), Buffer.from(shot.data, 'base64'));
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
    height: 800,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await command('Page.navigate', { url: origin + '/src/index.html?view=day&date=2026-10-24' });
  await wait("document.querySelector('.day-window') && document.querySelector('.day-header-garden')");
  const variants = [
      'wild',
      'daisy',
      'cosmos',
      'plum',
      'star',
      'camellia',
      'clover',
      'lotus',
      'lily',
      'aster',
    ],
    tones = ['cream', 'rose', 'blue', 'lilac', 'apricot', 'sage'];
  const completed = Array.from({ length: 40 }, (_, i) => ({
    id: 'past-' + i,
    title: '已完成的小事 ' + i,
    status: 'completed',
    completedAt: i + 1,
    flower: { variant: variants[i % 10], tone: tones[i % 6] },
    tags: [],
    children: [],
  }));
  const active = Array.from({ length: 6 }, (_, i) => ({
    id: 'new-' + i,
    title: ['读一小节书', '给窗边的绿植浇水', '整理今天的想法', '收拾桌面', '留一杯热茶', '准备明天的安排'][
      i
    ],
    status: 'active',
    tags: [],
    children: [],
  }));
  const parent = {
    id: 'parent',
    title: '整理读书笔记',
    status: 'active',
    tags: [],
    children: [{ id: 'child', title: '写下一点想法', status: 'active', tags: [], children: [] }],
  };
  await read(
    `localStorage.clear();localStorage.setItem('desktop-calendar:day:2026-10-24',JSON.stringify(${JSON.stringify({ date: '2026-10-24', note: '让每一天，长出一点进展。', tasks: [...active, parent, ...completed] })}));localStorage.setItem('desktop-calendar-theme',JSON.stringify({presetId:'morning',appearance:'botanical',completionMotion:true,opacity:.9}))`,
  );
  await reload('document.querySelector(\'.day-header-garden[data-total="40"]\')');
  const garden = "document.querySelector('.day-header-garden')";
  const map = () =>
    read(
      "Object.fromEntries([...document.querySelectorAll('.garden-plant:not([data-exit])')].map(n=>[n.dataset.gardenTaskId,Number(n.dataset.slot)]))",
    );
  const settled = () =>
    wait("[...document.querySelectorAll('.garden-plant')].every(n=>n.dataset.phase==='settled')");
  const grow = (id) => `.garden-plant[data-garden-task-id="${id}"]`;
  assert.equal(await read(garden + '.dataset.visible'), '14');
  assert.equal(await read(garden + '.dataset.positions'), '22');
  assert.equal(await read("document.querySelectorAll('.garden-plant').length"), 14);
  assert.equal(await read("document.querySelectorAll('.garden-plant:not([data-phase=settled])').length"), 0);
  assert.equal(await read("document.querySelectorAll('.garden-sway-group').length"), 6);
  assert.equal(
    await read(
      "[...document.querySelectorAll('.garden-flower-head')].every(n=>n.getBoundingClientRect().width<=34&&n.getBoundingClientRect().height<=34)",
    ),
    true,
    'flower drawings stay inside their small viewports',
  );
  assert.equal(
    await read("getComputedStyle(document.querySelector('.day-header-garden')).pointerEvents"),
    'none',
  );
  assert.equal(
    await read(
      "[...document.querySelectorAll('.garden-plant')].every(n=>Number(n.dataset.leaves)>=4&&Number(n.dataset.leaves)<=7&&n.querySelector('.garden-leaves').childElementCount<=2)",
    ),
    true,
    'more blades do not create more SVG leaf nodes',
  );
  assert.ok(
    (await read("new Set([...document.querySelectorAll('.garden-plant')].map(n=>n.dataset.foliage)).size")) >=
      3,
    'several foliage families are visible',
  );
  assert.equal(
    await read("Number(getComputedStyle(document.querySelector('.garden-growth')).opacity)"),
    0.34,
  );
  assert.equal(await read("document.querySelectorAll('.garden-plant[data-layer=front]').length"), 8);
  assert.equal(await read("document.querySelectorAll('.garden-plant[data-layer=back]').length"), 6);
  assert.equal(
    await read(
      "document.querySelector('.garden-depth-back').nextElementSibling.classList.contains('garden-depth-front')",
    ),
    true,
  );
  const firstMap = await map();
  await read(
    "window.__oldPlant=document.querySelector('[data-garden-task-id=\"past-26\"]');window.__keptLeaf=document.querySelector('[data-garden-task-id=\"past-39\"] .garden-leaves');window.__keptPath=window.__keptLeaf.innerHTML;window.__keptMask=document.querySelector('.header-garden-art mask g').firstElementChild;",
  );
  await screenshot('garden-eight');
  await click(button('new-0'));
  assert.equal(await read(`document.querySelector('${grow('new-0')}').dataset.phase`), 'growing');
  assert.equal(await read("document.querySelectorAll('.garden-plant[data-phase=dissolving]').length"), 1);
  assert.equal(
    await read("document.querySelector('.garden-plant[data-phase=dissolving]').dataset.layer"),
    'back',
  );
  assert.equal(
    await read(
      "(()=>{const g=window.__oldPlant.querySelector('.garden-growth'),a=g.getAnimations()[0];return window.__oldPlant.dataset.exit==='replacement'&&a.effect.getKeyframes().every(k=>!('transform' in k))&&getComputedStyle(g).transform==='none'})()",
    ),
    true,
    'overflow only fades the old flower without translating or shrinking it',
  );
  assert.equal(
    await read(
      'document.querySelector(\'[data-garden-task-id="new-0"] .garden-growth\').getAnimations()[0].effect.getTiming().delay',
    ),
    0,
    'new flower starts immediately',
  );
  assert.equal(
    await read(
      "window.__keptLeaf===document.querySelector('[data-garden-task-id=\"past-39\"] .garden-leaves')&&window.__keptLeaf.innerHTML===window.__keptPath&&window.__keptMask===document.querySelector('.header-garden-art mask g').firstElementChild",
    ),
    true,
    'unchanged foliage and the shared text mask are reused',
  );
  assert.equal(
    await read(
      '(()=>{const a=document.querySelector(\'[data-garden-task-id="new-0"] .completion-flower\'),b=document.querySelector(\'.task-row[data-task-id="new-0"] .completion-flower\');return a.dataset.flowerVariant===b.dataset.flowerVariant&&a.dataset.flowerTone===b.dataset.flowerTone})()',
    ),
    true,
  );
  const newMap = await map();
  assert.notEqual(newMap['new-0'], firstMap['past-26'], 'new flower uses a different anchor');
  assert.equal(
    await read(
      'Math.abs(document.querySelector(\'[data-garden-task-id="new-0"]\').transform.baseVal.getItem(0).matrix.e-window.__oldPlant.transform.baseVal.getItem(0).matrix.e)>78',
    ),
    true,
    'old and new flowers grow far apart',
  );
  for (const [id, slot] of Object.entries(firstMap)) if (id in newMap) assert.equal(newMap[id], slot);
  await settled();
  await screenshot('garden-replacement');
  await read(
    "(async()=>{const {flushDaySave}=await import('/src/storage/day-storage.mjs');await flushDaySave()})()",
  );
  assert.ok(
    await read(
      "JSON.parse(localStorage.getItem('desktop-calendar:day:2026-10-24')).tasks.find(t=>t.id==='new-0').completedAt>0",
    ),
  );
  const beforeReload = await map();
  await reload('document.querySelector(\'.day-header-garden[data-total="41"]\')');
  assert.deepEqual(await map(), beforeReload);
  assert.equal(await read("document.querySelectorAll('.garden-plant:not([data-phase=settled])').length"), 0);
  await click(button('new-0'));
  assert.equal(
    await read('document.querySelector(\'[data-garden-task-id="new-0"]\').dataset.exit'),
    'removal',
    'undo keeps explicit retreat feedback',
  );
  await settled();
  const afterUndo = await map();
  assert.deepEqual(Object.keys(afterUndo).sort(), Object.keys(firstMap).sort());
  for (const [id, slot] of Object.entries(beforeReload))
    if (id in afterUndo) assert.equal(afterUndo[id], slot);
  check(
    'varied small foliage in two cached paths; stronger opacity; silent overflow fade; immediate growth; stable slots; reload; undo and backfill',
  );
  for (const id of ['new-1', 'new-2', 'new-3', 'new-4']) await click(button(id));
  assert.ok((await read("document.querySelectorAll('.garden-plant:not([data-phase=settled])').length")) <= 2);
  assert.ok((await read("document.querySelectorAll('.garden-plant').length")) <= 16);
  await click(button('new-2'));
  await settled();
  assert.equal(await read(`document.querySelector('${grow('new-2')}')===null`), true);
  await read(
    "document.querySelector('.task-row[data-task-id=\"new-3\"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:250}))",
  );
  await click('.task-context-menu-item.danger');
  await wait("document.querySelector('.day-header-garden').dataset.total==='42'");
  await settled();
  assert.equal(await read(`document.querySelector('${grow('new-3')}')===null`), true);
  check(
    'rapid completions animate at most two plants; rapid undo and deletion retreat without leaking old flowers',
  );
  const beforeSearch = await map();
  await click('.search-toggle');
  await read(
    "(()=>{const input=document.querySelector('.task-search-input');input.value='找不到的任务';input.dispatchEvent(new Event('input',{bubbles:true}))})()",
  );
  await sleep(80);
  assert.deepEqual(await map(), beforeSearch);
  await click('.search-toggle');
  await click('.task-row[data-task-id=parent] .collapse-toggle');
  assert.deepEqual(await map(), beforeSearch);
  await command('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 800,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await wait('document.querySelector(\'.day-header-garden[data-capacity="10"]\')');
  assert.equal(await read(garden + '.dataset.positions'), '18');
  assert.equal(await read("document.querySelectorAll('.garden-plant').length"), 10);
  assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true);
  await screenshot('garden-narrow');
  await command('Emulation.setDeviceMetricsOverride', {
    width: 600,
    height: 800,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await wait('document.querySelector(\'.day-header-garden[data-capacity="18"]\')');
  assert.equal(await read(garden + '.dataset.positions'), '26');
  assert.equal(await read("document.querySelectorAll('.garden-plant').length"), 18);
  for (const presetId of ['mist', 'apricot', 'sage', 'rose']) {
    await setTheme({ presetId, opacity: 0.9, appearance: 'botanical', completionMotion: true });
    assert.equal(await read(garden + '.dataset.visible'), '18');
  }
  await screenshot('garden-wide');
  await setTheme({ presetId: 'morning', opacity: 0.9, appearance: 'minimal', completionMotion: true });
  assert.equal(await read("getComputedStyle(document.querySelector('.day-header-garden')).display"), 'none');
  await setTheme({ presetId: 'morning', opacity: 0.9, appearance: 'botanical', gardenEnabled: false });
  assert.equal(
    await read("document.querySelector('.day-header-garden').getAnimations({subtree:true}).length"),
    0,
  );
  await setTheme({ presetId: 'morning', opacity: 0.9, appearance: 'botanical', completionMotion: true });
  await click(button('new-5'));
  assert.equal(
    await read('document.querySelector(\'[data-garden-task-id="new-5"]\').dataset.phase'),
    'growing',
  );
  await read("window.dispatchEvent(new Event('blur'))");
  assert.equal(
    await read("document.querySelectorAll('.garden-plant:not([data-phase=settled])').length"),
    0,
    'blur settles active garden transitions',
  );
  assert.equal(
    await read("document.querySelectorAll('.task-row.is-blooming').length"),
    0,
    'blur settles local completion feedback',
  );
  assert.equal(
    await read("document.querySelector('.day-window').classList.contains('is-backgrounded')"),
    true,
  );
  assert.equal(
    await read(
      "[...document.querySelectorAll('.garden-sway-group')].flatMap(n=>n.getAnimations()).every(a=>a.playState==='paused')",
    ),
    true,
  );
  await read("window.dispatchEvent(new Event('focus'))");
  assert.equal(
    await read("document.querySelectorAll('.task-row.is-blooming').length"),
    0,
    'returning does not replay old feedback',
  );
  assert.equal(
    await read(
      "[...document.querySelectorAll('.garden-sway-group')].flatMap(n=>n.getAnimations()).every(a=>a.playState==='running')",
    ),
    true,
  );
  await click('.window-control.minimize');
  assert.equal(
    await read("document.querySelector('.day-header-garden').classList.contains('is-paused')"),
    true,
  );
  await read("window.dispatchEvent(new Event('focus'))");
  await command('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  assert.equal(
    await read("document.querySelector('.day-header-garden').getAnimations({subtree:true}).length"),
    0,
  );
  await command('Emulation.setEmulatedMedia', { features: [] });
  check(
    'search/folding preserve the garden; 10/14/18 caps; all themes; minimal; motion toggle; blur/minimize pause; reduced motion',
  );
  const nativeActivity = await read(`(async()=>{
    const previous=window.__TAURI__,handlers={},root=document.createElement('section');root.className='day-window';
    root.innerHTML='<div class="window-titlebar"></div><div class="day-header"></div><div class="day-toolbar"></div>';
    let focused=false,minimized=false,visible=false,unlistens=0;
    const api={isFocused:async()=>focused,isMinimized:async()=>minimized,isVisible:async()=>visible,
      onFocusChanged:handler=>{handlers.focus=handler;return Promise.resolve(()=>unlistens++)},onResized:handler=>{handlers.resize=handler;return Promise.resolve(()=>unlistens++)}};
    window.__TAURI__={window:{getCurrentWindow:()=>api}};
    let controller;
    try{
      const {createHeaderGarden}=await import('/src/ui/header-garden.mjs');
      controller=createHeaderGarden(root,{getItems:()=>[],getDate:()=> '2026-10-24',getSettings:()=>({appearance:'botanical',completionMotion:true}),isLoading:()=>false});
      await new Promise(r=>setTimeout(r,10));const initiallyHidden=root.classList.contains('is-backgrounded');
      visible=true;focused=true;handlers.focus({payload:true});const resumed=!root.classList.contains('is-backgrounded');
      minimized=true;await handlers.resize();const minimizedPaused=root.classList.contains('is-backgrounded');
      minimized=false;focused=false;await handlers.resize();const unfocusedPaused=root.classList.contains('is-backgrounded');
      controller.destroy();controller=null;await Promise.resolve();return {initiallyHidden,resumed,minimizedPaused,unfocusedPaused,unlistens};
    }finally{controller?.destroy();window.__TAURI__=previous;}
  })()`);
  assert.deepEqual(nativeActivity, {
    initiallyHidden: true,
    resumed: true,
    minimizedPaused: true,
    unfocusedPaused: true,
    unlistens: 2,
  });
  check('native focus/visibility/minimize override DOM activity and listeners clean up');
  await read(
    "(async()=>{const {flushDaySave}=await import('/src/storage/day-storage.mjs');await flushDaySave()})()",
  );
  await click('.next-day');
  await wait('document.querySelector(\'.day-header-garden[data-date="2026-10-25"][data-visible="0"]\')');
  assert.equal(await read("document.querySelectorAll('.garden-plant').length"), 0);
  assert.equal(
    await read("document.querySelector('.day-header-garden').getAnimations({subtree:true}).length"),
    0,
    'empty days run no background animations',
  );
  await click('.previous-day');
  await wait('document.querySelector(\'.day-header-garden[data-total="43"]\')');
  assert.equal(await read("document.querySelectorAll('.garden-plant:not([data-phase=settled])').length"), 0);
  const heavy = Array.from({ length: 750 }, (_, i) => ({
    id: 'heavy-' + i,
    title: '大量任务 ' + i,
    status: 'completed',
    completedAt: i + 1,
    tags: [],
    children: [],
  }));
  await read(
    `localStorage.setItem('desktop-calendar:day:2026-10-24',JSON.stringify(${JSON.stringify({ date: '2026-10-24', note: '性能样本', tasks: heavy })}))`,
  );
  await reload('document.querySelector(\'.day-header-garden[data-total="750"]\')');
  assert.equal(await read("document.querySelectorAll('.garden-plant').length"), 18);
  const nodes = await read("document.querySelector('.day-header-garden').querySelectorAll('*').length");
  assert.ok(nodes < 660, 'bounded SVG nodes: ' + nodes);
  const frameTimes = await read(
    'new Promise(done=>{const times=[];let last;function frame(t){if(last)times.push(t-last);last=t;if(times.length<90)requestAnimationFrame(frame);else done(times)}requestAnimationFrame(frame)})',
  );
  const ordered = [...frameTimes].sort((a, b) => a - b),
    p95 = ordered[Math.floor(ordered.length * 0.95)];
  console.log(
    'GARDEN FRAME SAMPLE',
    JSON.stringify({
      tasks: 750,
      plants: 18,
      svgNodes: nodes,
      p95Ms: p95,
      framesOver25ms: frameTimes.filter((t) => t > 25).length,
    }),
  );
  check('date changes reset without replay; 750 completed tasks still draw only 18 plants');
  assert.deepEqual(exceptions, []);
  console.log('No runtime exceptions. Screenshots: src-tauri/target/botanical-garden-*.png');
  await call('Browser.close');
} finally {
  socket?.close();
  chrome.kill();
  server.close();
  if (resolve(profile).startsWith(join(resolve(tmpdir()), 'rizhi-botanical-test-')))
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => {});
}
