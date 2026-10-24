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
  await wait("!document.querySelector('.is-blooming')"); await sleep(240);
  assert.equal(await read("document.querySelector('.task-tree > .task-node > .task-row').dataset.taskId"), 'b');
  assert.equal(await read("document.querySelector('.status-summary').textContent.includes('已完成 2')"), true);
  check('parent guard; immediate save/count; flower stays in place; only changed row updates before smooth status ordering');
  await click(button('child')); await click(button('parent'));
  await wait("!document.querySelector('.is-blooming')"); await sleep(240);
  assert.equal(await read("document.querySelector('[data-task-id=\"parent\"]').closest('.task-node').classList.contains('is-completed-branch')"), true);
  assert.equal(await read("document.querySelector('[data-task-id=\"parent\"]').closest('.task-node').querySelector(':scope > .children').classList.contains('is-collapsed')"), true);
  await click(button('b')); await click(button('b')); await sleep(720);
  assert.equal(await read("document.querySelector('[data-task-id=\"b\"]').classList.contains('is-active')"), true);
  assert.equal(await read("document.querySelector('.task-tree > .task-node > .task-row').dataset.taskId"), 'b');
  await read("(async()=>{const {flushDaySave}=await import('/src/storage/day-storage.mjs');await flushDaySave()})()");
  await reload("document.querySelector('[data-task-id=\"a\"]')");
  assert.equal(await read("document.querySelectorAll('.is-blooming').length"), 0);
  assert.equal(await read("getComputedStyle(document.querySelector('[data-task-id=\"a\"] .completion-flower')).display"), 'block');
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
  await wait("document.querySelector('.month-task-chip.is-completed')");
  assert.equal(await read("getComputedStyle(document.querySelector('.month-task-chip.is-completed .completion-flower')).display"), 'block');
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
