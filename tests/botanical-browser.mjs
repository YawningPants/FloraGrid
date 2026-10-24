import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolated origin, browser profile, and synthetic tasks. Never touches native calendar data.
const root = fileURLToPath(new URL('..', import.meta.url));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const server = createServer(async (request, response) => {
  const path = resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
  if (!path.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    const content = await readFile(path);
    response.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(path)] || 'application/octet-stream');
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'rizhi-botanical-test-'));
const chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-popup-blocking', '--no-first-run', '--disable-background-networking', '--disable-extensions', '--disable-sync',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket, id = 0;
const pending = new Map(), exceptions = [];
try {
  const endpoint = await new Promise((done, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => reject(Error(stderr)), 20000);
    chrome.once('error', reject);
    chrome.stderr.on('data', data => {
      stderr += data; const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); done(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise(done => socket.addEventListener('open', done, { once: true }));
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { done, reject } = pending.get(message.id); pending.delete(message.id);
      if (message.error) reject(Error(JSON.stringify(message.error))); else done(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  });
  const call = (method, params = {}, sessionId) => new Promise((done, reject) => {
    const requestId = ++id; pending.set(requestId, { done, reject });
    socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params = {}) => call(method, params, sessionId);
  const read = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 160; i++) { if (await read(expression)) return; await sleep(25); }
    throw Error(`Timed out: ${expression}`);
  };
  const click = selector => read(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const pointerClick = async selector => {
    await read(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
    const r = await read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await command('Input.dispatchMouseEvent', {type:'mouseMoved',x:r.x,y:r.y,buttons:0});
    await command('Input.dispatchMouseEvent', {type:'mousePressed',x:r.x,y:r.y,button:'left',buttons:1,clickCount:1});
    await command('Input.dispatchMouseEvent', {type:'mouseReleased',x:r.x,y:r.y,button:'left',buttons:0,clickCount:1});
  };
  const key = async (name, code) => {
    await command('Input.dispatchKeyEvent', {type:'keyDown',key:name,code:name,windowsVirtualKeyCode:code,...(name==='Enter'?{text:'\r',unmodifiedText:'\r'}:{})});
    await command('Input.dispatchKeyEvent', {type:'keyUp',key:name,code:name,windowsVirtualKeyCode:code});
  };
  const reload = async ready => {
    const previous = await read('performance.timeOrigin');
    await command('Page.reload');
    await wait(`performance.timeOrigin!==${previous} && (${ready})`);
  };
  const button = id => `.task-row[data-task-id="${id}"] .status-button`;
  const check = text => console.log(`PASS ${text}`);
  const screenshot = async name => {
    await mkdir(join(root, 'src-tauri/target'), { recursive: true });
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(root, `src-tauri/target/botanical-${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  const setTheme = settings => read(`(()=>{const settings=${JSON.stringify(settings)};localStorage.setItem('desktop-calendar-theme',JSON.stringify(settings));window.dispatchEvent(new CustomEvent('calendar://theme-updated',{detail:{settings}}))})()`);
  await command('Runtime.enable'); await command('Page.enable');
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `const OriginalDate=Date;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-10-24T12:00:00']))}static now(){return OriginalDate.parse('2026-10-24T12:00:00')}}` });
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: false });
  await command('Page.navigate', { url: `${origin}/src/index.html?view=day&date=2026-10-24` });
  await wait("document.querySelector('.day-window') && !document.querySelector('.search-empty')");
  const task = (id, title, status = 'active', children = []) => ({ id, title, status, children, tags: [] });
  const tasks = [task('a', '准备一杯热茶'), task('b', '读一小节书'), task('parent', '整理书桌', 'active', [task('child', '把读过的书归位')]), task('done', '给绿植浇水', 'completed'), task('fail', '未能完成的安排', 'failed')];
  await read(`localStorage.clear();localStorage.setItem('desktop-calendar:day:2026-10-24',JSON.stringify(${JSON.stringify({ date: '2026-10-24', note: '今天从一件小事开始。', tasks })}));localStorage.setItem('desktop-calendar-theme',JSON.stringify({presetId:'morning',opacity:.84}))`);
  await reload("document.querySelector('[data-task-id=\"a\"]')");
  assert.equal(await read('document.documentElement.dataset.appearance'), 'botanical');
  await click(button('parent'));
  assert.equal(await read("document.querySelector('[data-task-id=\"parent\"]').classList.contains('is-active')"), true);
  await read("window.__untouched=document.querySelector('[data-task-id=\"b\"]');window.__wrapper=document.querySelector('[data-task-id=\"a\"]').closest('.task-node');window.__oldTop=window.__wrapper.getBoundingClientRect().top");
  await click(button('a'));
  assert.equal(await read("window.__untouched===document.querySelector('[data-task-id=\"b\"]')"), true);
  assert.equal(await read("document.querySelector('[data-task-id=\"a\"]').classList.contains('is-blooming')"), true);
  assert.equal(await read("window.__wrapper===document.querySelector('.task-tree').firstElementChild"), true);
  assert.equal(await read("Math.abs(window.__wrapper.getBoundingClientRect().top-window.__oldTop)<1"), true);
  await read("(async()=>{const {flushDaySave}=await import('/src/storage/day-storage.mjs');await flushDaySave()})()");
  assert.equal(await read("JSON.parse(localStorage.getItem('desktop-calendar:day:2026-10-24')).tasks[0].status"), 'completed');
  const flowerA = await read("JSON.parse(localStorage.getItem('desktop-calendar:day:2026-10-24')).tasks[0].flower");
  assert.ok(flowerA.variant && flowerA.tone);
  await wait("!document.querySelector('.is-blooming')"); await sleep(240);
  assert.equal(await read("document.querySelector('.task-tree > .task-node > .task-row').dataset.taskId"), 'b');
  assert.equal(await read("document.querySelector('.status-summary').textContent.includes('已完成 2')"), true);
  check('parent guard; immediate save/count; flower stays in place; only changed row updates before smooth status ordering');
  await click(button('child')); await click(button('parent'));
  await wait("!document.querySelector('.is-blooming')");
  const foldStart = await read("document.querySelector('[data-task-id=\"parent\"]').closest('.task-node').querySelector(':scope > .children').getBoundingClientRect().height");
  assert.ok(foldStart > 0, 'automatic collapse starts from expanded height');
  await sleep(75);
  const foldMiddle = await read("document.querySelector('[data-task-id=\"parent\"]').closest('.task-node').querySelector(':scope > .children').getBoundingClientRect().height");
  assert.ok(foldMiddle > 0 && foldMiddle < foldStart, 'height interpolates during automatic collapse');
  await wait("!document.querySelector('.children.is-animating')"); await sleep(240);
  assert.equal(await read("document.querySelector('[data-task-id=\"parent\"]').closest('.task-node').querySelector(':scope > .children').getBoundingClientRect().height"), 0);
  assert.equal(await read("document.querySelector('[data-task-id=\"parent\"]').closest('.task-node').classList.contains('is-completed-branch')"), true);
  assert.equal(await read("document.querySelector('[data-task-id=\"parent\"]').closest('.task-node').querySelector(':scope > .children').classList.contains('is-collapsed')"), true);
  await click(button('b')); await click(button('b')); await sleep(720);
  assert.equal(await read("document.querySelector('[data-task-id=\"b\"]').classList.contains('is-active')"), true);
  assert.equal(await read("document.querySelector('.task-tree > .task-node > .task-row').dataset.taskId"), 'b');
  await read("(async()=>{const {flushDaySave}=await import('/src/storage/day-storage.mjs');await flushDaySave()})()");
  await reload("document.querySelector('[data-task-id=\"a\"]')");
  assert.equal(await read("document.querySelectorAll('.is-blooming').length"), 0);
  assert.equal(await read("getComputedStyle(document.querySelector('[data-task-id=\"a\"] .completion-flower')).display"), 'block');
  assert.deepEqual(await read("(()=>{const f=document.querySelector('[data-task-id=\"a\"] .completion-flower');return {variant:f.dataset.flowerVariant,tone:f.dataset.flowerTone}})()"), flowerA);
  const oldFlower = await read("(()=>{const f=document.querySelector('[data-task-id=\"done\"] .completion-flower');return {variant:f.dataset.flowerVariant,tone:f.dataset.flowerTone}})()");
  await click(button('done')); await click(button('done'));
  assert.deepEqual(await read("(()=>{const f=document.querySelector('[data-task-id=\"done\"] .completion-flower');return {variant:f.dataset.flowerVariant,tone:f.dataset.flowerTone}})()"), oldFlower);
  await wait("!document.querySelector('.is-blooming')"); await sleep(240);
  await screenshot('day');
  check('whole-branch completion collapses; rapid undo stays active; loading completed tasks never replays bloom');
  await setTheme({ presetId: 'morning', opacity: .84, appearance: 'minimal' });
  assert.equal(await read("document.documentElement.style.getPropertyValue('--theme-base-rgb')"), '34, 52, 58');
  assert.equal(await read("document.querySelector('[data-task-id=\"a\"] .completion-flower')===null"), true);
  assert.notEqual(await read("getComputedStyle(document.querySelector('[data-task-id=\"a\"] .completion-check')).display"), 'none');
  assert.equal(await read("getComputedStyle(document.querySelector('.note-sprout')).display"), 'none');
  await screenshot('minimal');
  await click(button('b'));
  assert.equal(await read("document.querySelector('.is-blooming')===null"), true);
  await setTheme({ presetId: 'rose', opacity: .84, appearance: 'botanical', completionMotion: false });
  await click(button('b')); await click(button('b'));
  assert.equal(await read("document.querySelector('.is-blooming')===null"), true);
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await setTheme({ presetId: 'sage', opacity: .84, appearance: 'botanical', completionMotion: true });
  await click(button('b')); await click(button('b'));
  assert.equal(await read("document.querySelector('.is-blooming')===null"), true);
  await command('Emulation.setEmulatedMedia', { features: [] });
  await click(button('b')); await click(button('b'));
  await click('.next-day'); await wait("document.querySelector('.day-header').textContent.includes('25')");
  await sleep(700);
  assert.equal(await read("document.querySelectorAll('.task-row').length"), 0);
  assert.equal(await read("getComputedStyle(document.querySelector('.botanical-empty')).display"), 'flex');
  check('minimal retains original palette/check; motion toggle and system reduced motion; navigating during bloom cannot leak old cards');
  // Expanded, colored and tagged branches plus all six flower shapes for visual QA.
  const variants = ['wild','daisy','cosmos','plum','star','camellia'];
  const tones = ['cream','rose','blue','lilac','apricot','sage'];
  const project = task('visual-parent', '给周末留一点生长的空间', 'active', [
    { ...task('visual-a', '读完一小节，记下喜欢的句子'), color: '#9cbfd0', tags: [{ id: 'reading', text: '阅读', color: '#9cbfd0' }] },
    { ...task('visual-b', '整理窗边的绿植', 'active', [task('visual-deep', '修剪枝叶与换水')]), color: '#c8bb94' },
    { ...task('visual-c', '散步时拍到一束光', 'completed'), color: '#d2a9b7', flower: { variant: 'cosmos', tone: 'rose' } },
  ]);
  project.tags = [{ id: 'life', text: '生活', color: '#a8be9e' }];
  const gallery = task('visual-gallery', '一点点进展，都开成花', 'completed', variants.map((variant, i) => ({ ...task(`visual-flower-${i}`, ['一杯热茶','读完一页','浇一盆花','收好灵感','留一点空白','写下今天'][i], 'completed'), flower: { variant, tone: tones[i] } })));
  await read(`localStorage.setItem('desktop-calendar:day:2026-10-25',JSON.stringify(${JSON.stringify({ date:'2026-10-25', note:'记录那些很小，却让一天变好的事。', tasks:[project,gallery] })}))`);
  await reload("document.querySelector('[data-task-id=\"visual-parent\"]')");
  await setTheme({ presetId:'morning', opacity:.9, appearance:'botanical', completionMotion:true });
  await command('Emulation.setDeviceMetricsOverride', { width:390, height:1000, deviceScaleFactor:2, mobile:false });
  await wait("document.querySelector('.task-plant-branches .plant-fork')");
  assert.equal(await read("Boolean(document.querySelector('[data-task-id=\"visual-parent\"] .task-root-symbol'))&&!document.querySelector('[data-task-id=\"visual-a\"] .task-root-symbol')"), true);
  assert.equal(await read("getComputedStyle(document.querySelector('[data-task-id=\"visual-a\"]')).borderTopWidth"), '0px');
  assert.equal(await read("document.querySelectorAll('[data-task-id=\"visual-a\"] .tag-chip').length"), 2);
  assert.equal(await read("document.querySelectorAll('.task-plant-branches .plant-fork').length>=6"), true);
  assert.equal(await read("new Set([...document.querySelectorAll('[data-task-id^=\"visual-flower-\"] .completion-flower')].map(f=>f.dataset.flowerVariant)).size"), 6);
  // Animated screen rectangles must not contaminate branch geometry.
  assert.equal(await read(`(async()=>{const {applyTreeBranchLayout}=await import('/src/ui/task-tree-layout.mjs');const root=document.querySelector('.day-window');applyTreeBranchLayout(root);const svg=document.querySelector('[data-task-id="visual-parent"]').closest('.task-node').querySelector(':scope > .task-plant-branches');const before=[...svg.children].map(p=>p.getAttribute('d'));const row=document.querySelector('[data-task-id="visual-a"]');const animation=row.animate([{transform:'translateY(0)'},{transform:'translateY(30px)'}],{duration:300,fill:'both'});await new Promise(r=>setTimeout(r,80));applyTreeBranchLayout(root);const same=JSON.stringify(before)===JSON.stringify([...svg.children].map(p=>p.getAttribute('d')));animation.cancel();return same})()`), true);
  // Actual mouse selection releases task focus; keyboard Escape restores it.
  await pointerClick('[data-task-id="visual-a"] .task-color-button');
  await wait("document.querySelector('.task-color-palette')");
  await pointerClick('.task-color-choice:nth-child(2)');
  await command('Input.dispatchMouseEvent', {type:'mouseMoved',x:2,y:2,buttons:0}); await sleep(170);
  assert.equal(await read("Boolean(document.activeElement.closest('.task-row'))"), false);
  assert.equal(await read("getComputedStyle(document.querySelector('[data-task-id=\"visual-a\"]')).backgroundColor"), 'rgba(0, 0, 0, 0)');
  await read("document.querySelector('[data-task-id=\"visual-a\"] .task-color-button').focus()");
  await key('Enter',13); await wait("document.querySelector('.task-color-palette')");
  await key('Escape',27);
  assert.equal(await read("document.activeElement.matches('.task-color-button:focus-visible')"), true);
  await read('document.activeElement.blur()');
  // Only active tasks edit; notices appear by the task area, above notes.
  await pointerClick('[data-task-id="visual-c"] .task-title'); await sleep(180);
  assert.equal(await read("document.querySelector('.task-notice').textContent.includes('已完成的任务暂不能编辑')"), true);
  assert.equal(await read("(()=>{const n=document.querySelector('.task-notice').getBoundingClientRect(),h=document.querySelector('.day-toolbar').getBoundingClientRect(),notes=document.querySelector('.daily-notes').getBoundingClientRect();return n.top>h.bottom&&n.bottom<notes.top&&document.querySelector('.task-notice').getAttribute('role')==='status'})()"), true);
  await screenshot('interaction-feedback');
  await pointerClick('[data-task-id="visual-parent"] .status-button');
  assert.equal(await read("document.querySelector('.task-notice').textContent.includes('请先处理所有进行中的子任务')"), true);
  await pointerClick('.window-control.pin'); await wait("document.querySelector('.pin[aria-pressed=\"true\"]')");
  assert.equal(await read("getComputedStyle(document.querySelector('.pin-state')).display!=='none'&&document.querySelector('.pin-state').textContent==='已置顶'"), true);
  await screenshot('pinned-day');
  await pointerClick('.window-control.pin'); await wait("document.querySelector('.pin[aria-pressed=\"false\"]')");
  assert.equal(await read("getComputedStyle(document.querySelector('.pin-state')).display"), 'none');
  check('branches ignore in-flight transforms; mouse palette focus clears; keyboard focus survives; root symbol, pin state and task-area notices');
  await sleep(3300);
  await screenshot('branches-day');
  for (const width of [390,320]) {
    await command('Emulation.setDeviceMetricsOverride', { width,height:780,deviceScaleFactor:2,mobile:false });
    await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await read(`(()=>{const overlaps=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5;return [...document.querySelectorAll('.task-row')].every(row=>{const tools=[...row.querySelectorAll('.task-row-controls button')].map(b=>b.getBoundingClientRect()).filter(r=>r.width&&r.height),tags=row.querySelector('.tag-list')?.getBoundingClientRect(),drag=row.querySelector('.drag-handle')?.getBoundingClientRect(),fold=row.querySelector('.collapse-toggle')?.getBoundingClientRect();return !tools.some((r,i)=>tools.slice(i+1).some(s=>overlaps(r,s)))&&(!tags||!tools.some(r=>overlaps(r,tags)))&&(!drag||!fold||!overlaps(drag,fold))})})()`), true, `controls must not overlap at ${width}px`);
  }
  // Adding a child updates the shared graph, rather than joining a separate CSS stem.
  const forksBefore = await read("document.querySelector('[data-task-id=\"visual-parent\"]').closest('.task-node').querySelector(':scope > .task-plant-branches').querySelectorAll('.plant-fork').length");
  await pointerClick('[data-task-id="visual-parent"] .child'); await wait("document.querySelector('.task-title-input')");
  await read("(()=>{const i=document.querySelector('.task-title-input');i.value='新增的一片叶';i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))})()");
  await wait(`document.querySelector('[data-task-id="visual-parent"]').closest('.task-node').querySelector(':scope > .task-plant-branches')?.querySelectorAll('.plant-fork').length===${forksBefore+1}`);
  assert.equal(await read("getComputedStyle(document.querySelector('[data-task-id=\"visual-parent\"]'),'::after').content"), 'none');
  await setTheme({ presetId:'morning', opacity:.9, appearance:'minimal' });
  assert.equal(await read("getComputedStyle(document.querySelector('[data-task-id=\"visual-a\"]')).borderTopWidth"), '1px');
  await setTheme({ presetId:'sage', opacity:.84, appearance:'botanical', completionMotion:true });
  check('six stable flower variants; shared curved branches; borderless child leaves preserve custom colors and inherited tags; narrow and minimal layouts');
  await command('Page.navigate', { url: `${origin}/src/index.html#settings?tab=theme` });
  await wait("document.querySelector('.appearance-option')");
  await command('Emulation.setDeviceMetricsOverride', { width: 780, height: 560, deviceScaleFactor: 2, mobile: false });
  assert.equal(await read("document.querySelector('.appearance-option[data-appearance=\"botanical\"]').getAttribute('aria-pressed')"), 'true');
  await click('.appearance-option[data-appearance="minimal"]');
  assert.equal(await read("document.querySelector('.completion-motion-control').hidden"), true);
  assert.equal(await read("document.querySelector('.theme-preset').textContent.trim()"), '海雾青');
  await click('.appearance-option[data-appearance="botanical"]');
  assert.equal(await read("document.querySelector('.theme-preset').textContent.trim()"), '枝间雾');
  for (let i = 0; i < 5; i++) {
    await click(`.theme-preset:nth-child(${i + 1})`);
    await screenshot(`theme-${i}`);
    assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true);
  }
  await click('.completion-motion-input');
  assert.equal(await read("JSON.parse(localStorage.getItem('desktop-calendar-theme')).completionMotion"), false);
  await screenshot('settings');
  await reload("document.querySelector('.completion-motion-input')");
  assert.equal(await read("document.querySelector('.completion-motion-input').checked"), false);
  check('settings switches both palette families; all five new themes fit; preferences persist');
  await command('Page.navigate', { url: `${origin}/src/index.html?view=month&date=2026-10-24` });
  await command('Emulation.setDeviceMetricsOverride', { width:1180, height:820, deviceScaleFactor:2, mobile:false });
  await wait("document.querySelector('.month-task-chip.is-completed')");
  assert.deepEqual(await read("(()=>{const f=document.querySelector('.month-task-chip[data-task-id=\"a\"] .completion-flower');return {variant:f.dataset.flowerVariant,tone:f.dataset.flowerTone}})()"), flowerA);
  assert.equal(await read("getComputedStyle(document.querySelector('.month-task-chip.is-completed .completion-flower')).display"), 'block');
  await wait("document.querySelector('.month-plant-branches .plant-week-branch')");
  assert.equal(await read("document.querySelectorAll('.month-plant-branches .plant-week-branch').length"), 5);
  assert.equal(await read("getComputedStyle(document.querySelector('.month-task-chip')).borderTopWidth"), '0px');
  const dates = [3,6,8,11,13,16,18,20,21,27,29,30];
  const labels = ['读一小节','整理灵感','散步半小时','记下今天','留一杯热茶','给绿植浇水'];
  const colors = ['#a8be9e','#9cbfd0','#d2a9b7','#d2bf98','#b6aed0','#c8c2a3'];
  await read(`(()=>{const dates=${JSON.stringify(dates)},labels=${JSON.stringify(labels)},colors=${JSON.stringify(colors)},variants=${JSON.stringify(variants)},tones=${JSON.stringify(tones)};dates.forEach((day,i)=>{const date='2026-10-'+String(day).padStart(2,'0');localStorage.setItem('desktop-calendar:day:'+date,JSON.stringify({date,note:'',tasks:Array.from({length:i%4+1},(_,j)=>({id:'calendar-leaf-'+i+'-'+j,title:labels[(i+j)%6],status:j%3===0?'completed':'active',color:colors[(i+j)%6],flower:{variant:variants[(i+j)%6],tone:tones[(i+j)%6]},tags:[],children:[]}))}))})})()`);
  await reload("document.querySelector('.month-task-chip[data-task-id=\"calendar-leaf-0-0\"]')");
  await wait("Number(document.querySelector('.month-plant-branches')?.dataset.branchDays)>10");
  assert.equal(await read("document.querySelectorAll('.month-plant-frame .plant-frame-vines path').length>=3&&document.querySelectorAll('.plant-empty-leaves .plant-decor-leaf').length>0&&document.querySelector('.plant-tail-leaves')!==null"), true);
  assert.equal(await read("getComputedStyle(document.querySelector('.month-plant-frame')).pointerEvents"), 'none');
  await pointerClick('.window-control.pin'); await wait("document.querySelector('.pin[aria-pressed=\"true\"]')");
  assert.equal(await read("getComputedStyle(document.querySelector('.pin-state')).display!=='none'"), true);
  await pointerClick('.window-control.pin');
  await screenshot('branches-month');
  await click('.month-long-toggle');
  assert.equal(await read("getComputedStyle(document.querySelector('.long-task-empty .botanical-empty')).display"), 'flex');
  await screenshot('month');
  check('month completed marks match day flowers; long-task drawer uses the shared sprout empty state');
  assert.deepEqual(exceptions, []);
  console.log('No runtime exceptions. Screenshots: src-tauri/target/botanical-*.png');
  await call('Browser.close');
} finally {
  socket?.close(); chrome.kill(); server.close();
  if (resolve(profile).startsWith(join(resolve(tmpdir()), 'rizhi-botanical-test-'))) await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => {});
}
