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
const profile = await mkdtemp(join(tmpdir(), 'calendar-tags-test-'));
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
  await command('Emulation.setDeviceMetricsOverride', { width: 760, height: 520, deviceScaleFactor: 1, mobile: false });
  const waitFor = async (expression) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await evaluate(expression)) return;
      await sleep(25);
    }
    throw new Error(`Timed out: ${expression}`);
  };
  let run = 0;
  const navigate = async (view) => {
    const nonce = ++run;
    const route = view === 'tag-manager' ? 'settings&tab=tags' : view;
    await command('Page.navigate', { url: `${origin}/src/index.html?view=${route}&date=2026-10-24&testRun=${nonce}` });
    await waitFor(`new URLSearchParams(location.search).get('testRun') === '${nonce}' && document.readyState === 'complete'`);
    await command('Page.bringToFront');
    await evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
    if (view === 'month') await evaluate("document.querySelector('.month-long-toggle').click()");
  };
  const click = async (selector) => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled)throw Error('Unavailable: '+${JSON.stringify(selector)});node.click()})()`);
  const rect = (selector) => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()`);
  const mouse = (type, x, y, buttons = 1) => command('Input.dispatchMouseEvent', { type, x, y, buttons, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
  const pointerClick = async (selector) => {
    const r = await rect(selector);
    await mouse('mouseMoved', r.x, r.y, 0);
    await mouse('mousePressed', r.x, r.y);
    await mouse('mouseReleased', r.x, r.y, 0);
  };
  const fill = (text) => evaluate(`(()=>{const input=document.querySelector('.tag-manager-draft-input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const key = async (name) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: name === 'Escape' ? 27 : 13, ...(name === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name });
  };
  const save = async () => {
    await click('.tag-manager-draft-save');
    await waitFor("!document.querySelector('.tag-manager-page').hasAttribute('aria-busy') && !document.querySelector('.tag-manager-draft-input')");
  };
  const saved = () => evaluate("JSON.parse(localStorage.getItem('desktop-calendar:tag-templates'))");
  const check = (label) => console.log(`PASS ${label}`);
  const screenshot = async (name) => {
    await mkdir(join(root, 'src-tauri/target'), { recursive: true });
    const result = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(root, `src-tauri/target/${name}.png`), Buffer.from(result.data, 'base64'));
  };
  const fits = (selector) => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`);
  await navigate('tag-manager');
  await waitFor("document.querySelectorAll('.tag-group-card').length===3");
  assert.equal(await evaluate("document.querySelectorAll('.tag-manager-page input').length"), 0);
  assert.equal(await evaluate("document.querySelectorAll('.tag-group-card .tag-manager-chip').length"), 9);
  assert.equal(await evaluate("document.querySelectorAll('.tag-manager-chip .tag-manager-sort-handle').length"), 0);
  assert.ok(await evaluate("parseFloat(getComputedStyle(document.querySelector('.tag-group-card-content')).paddingLeft)") <= 12);
  await screenshot('tags-manager-default');
  const defaults = await evaluate("(async () => (await import('/src/domain/tags.mjs')).normalizeTagTemplates(null))()");
  const snapshot = { id: 'snapshot', text: '会议', color: '#8fb6d3', source: 'preset' };
  const task = { id: 'task', title: '标签测试任务', status: 'active', tags: [snapshot], children: [] };
  await evaluate(`localStorage.setItem('desktop-calendar:tag-templates', JSON.stringify(${JSON.stringify(defaults)}));localStorage.setItem('desktop-calendar:day:2026-10-24',JSON.stringify(${JSON.stringify({ date: '2026-10-24', note: '', tasks: [task] })}));localStorage.setItem('desktop-calendar:long-tasks',JSON.stringify(${JSON.stringify({ version: 1, tasks: [task] })}));`);
  check('initial manager has grouped cards and no visible or hidden text inputs');

  await click('[data-group-id="group-work"] .tag-manager-add-tag');
  assert.equal(await evaluate("document.querySelectorAll('.tag-manager-draft-input').length"), 1);
  assert.equal(await evaluate("document.activeElement.matches('.tag-manager-draft-input')"), true);
  await click('.tag-manager-draft-save');
  assert.equal(await evaluate("document.querySelector('.tag-manager-draft-input').getAttribute('aria-invalid')"), 'true');
  await fill('周计划');
  const beforeColor = await evaluate("getComputedStyle(document.querySelector('.tag-manager-editor')).backgroundColor");
  await click('.tag-manager-color-dot');
  assert.equal(await fits('.tag-manager-palette'), true);
  await key('Escape');
  assert.equal(await evaluate("Boolean(document.querySelector('.tag-manager-draft-input')) && !document.querySelector('.tag-manager-palette')"), true);
  await click('.tag-manager-color-dot');
  await click('.tag-manager-palette [aria-label="草绿"]');
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.tag-manager-editor')).backgroundColor"), beforeColor);
  await screenshot('tags-manager-draft');
  assert.deepEqual(await saved(), defaults);
  await save();
  assert.deepEqual((await saved()).groups[0].tags.at(-1).text, '周计划');
  assert.equal((await saved()).groups[0].tags.at(-1).color, '#99b888');
  assert.equal(await evaluate("document.querySelectorAll('.tag-manager-page input').length"), 0);
  check('add is scoped to its group; blank rejected; color changes draft; only confirm saves');

  await pointerClick('[data-sort-id="preset-meeting"] .tag-manager-chip-edit');
  await waitFor("Boolean(document.querySelector('.tag-manager-draft-input'))");
  assert.equal(await evaluate("document.querySelector('.tag-sort-ghost')===null"), true);
  await fill('不要保存');
  await key('Escape');
  assert.equal((await saved()).groups[0].tags[0].text, '会议');
  await click('[data-sort-id="preset-meeting"] .tag-manager-chip-edit');
  await fill('例会');
  await save();
  assert.equal((await saved()).groups[0].tags[0].text, '例会');
  assert.deepEqual(await evaluate("JSON.parse(localStorage.getItem('desktop-calendar:day:2026-10-24')).tasks[0].tags"), [snapshot]);
  await click('[data-sort-id="preset-meeting"] .tag-manager-chip-edit');
  await click('.tag-manager-draft-delete');
  await key('Escape');
  assert.equal(await evaluate("Boolean(document.querySelector('.tag-manager-draft-input')) && !document.querySelector('.confirm-overlay')"), true);
  await click('.tag-manager-draft-delete');
  await click('.confirm-overlay .danger');
  await waitFor("!document.querySelector('.confirm-overlay') && !document.querySelector('.tag-manager-draft-input')");
  assert.equal((await saved()).groups[0].tags.some(tag => tag.id === 'preset-meeting'), false);
  assert.deepEqual(await evaluate("JSON.parse(localStorage.getItem('desktop-calendar:long-tasks')).tasks[0].tags"), [snapshot]);
  check('edit/cancel/delete work without changing existing day or long-task tag snapshots');

  await click('.tag-manager-new-button');
  await fill('新的分组');
  await save();
  const newGroupId = (await saved()).groups.at(-1).id;
  await click(`[data-group-id="${newGroupId}"] .tag-group-toggle`);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-group-id="${newGroupId}"] .tag-group-card-content'))`), false);
  await click(`[data-group-id="${newGroupId}"] .tag-group-toggle`);
  await click(`[data-group-id="${newGroupId}"] .tag-group-more`);
  await click('.tag-group-rename');
  await fill('重命名分组');
  await save();
  assert.equal((await saved()).groups.at(-1).name, '重命名分组');
  await click(`[data-group-id="${newGroupId}"] .tag-group-more`);
  await click('.tag-group-delete');
  await click('.confirm-overlay .danger');
  await waitFor("document.querySelectorAll('.tag-group-card').length===3 && !document.querySelector('.confirm-overlay')");
  check('create/rename/collapse/delete groups with an initially hidden group composer');

  // Test an actual pointer drag, including cancellation and no save before release.
  const start = async (selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
    await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    const r = await rect(selector);
    await mouse('mouseMoved', r.x, r.y, 0);
    await mouse('mousePressed', r.x, r.y);
    if (await evaluate(`document.querySelector(${JSON.stringify(selector)}).hasAttribute('data-sort-press')`)) {
      await sleep(150);
      assert.equal(await evaluate("Boolean(document.querySelector('.tag-sort-ghost'))"), false);
      await sleep(240);
    } else await mouse('mouseMoved', r.x + 7, r.y + 7);
    await waitFor("Boolean(document.querySelector('.tag-sort-ghost'))");
    assert.equal(await evaluate("document.querySelector('.tag-manager-draft-input')===null"), true);
    return r;
  };
  const groupsBefore = await saved();
  const groupStart = await start('[data-group-id="group-work"] > .tag-group-card-header > .tag-manager-sort-handle');
  const groupTarget = await rect('.tag-group-card[data-group-id="group-life"]');
  await mouse('mouseMoved', groupStart.x, groupTarget.bottom - 2);
  await waitFor("[...document.querySelector('.tag-manager-group-list').children].filter(item=>item.style.display!=='none')[0].dataset.groupId==='group-life'");
  assert.deepEqual(await saved(), groupsBefore);
  await key('Escape');
  await mouse('mouseReleased', groupStart.x, groupTarget.bottom - 2, 0);
  assert.equal(await evaluate("document.querySelector('.tag-manager-group-list').firstElementChild.dataset.groupId"), 'group-work');
  const secondStart = await start('[data-group-id="group-work"] > .tag-group-card-header > .tag-manager-sort-handle');
  await mouse('mouseMoved', secondStart.x, groupTarget.bottom - 2);
  await mouse('mouseReleased', secondStart.x, groupTarget.bottom - 2, 0);
  await waitFor("!document.querySelector('.tag-manager-page').hasAttribute('aria-busy')");
  assert.deepEqual((await saved()).groups.slice(0, 2).map(group => group.id), ['group-life', 'group-work']);
  const tagsBefore = (await saved()).groups.find(group => group.id === 'group-work').tags;
  const premature = await rect(`[data-sort-id="${tagsBefore[0].id}"] > .tag-manager-chip-edit`);
  await mouse('mouseMoved', premature.x, premature.y, 0);
  await mouse('mousePressed', premature.x, premature.y);
  await mouse('mouseMoved', premature.x + 8, premature.y);
  await sleep(390);
  await mouse('mouseReleased', premature.x + 8, premature.y, 0);
  assert.equal(await evaluate("document.querySelectorAll('.tag-sort-ghost,.tag-manager-draft-input').length"), 0);
  assert.deepEqual((await saved()).groups.find(group => group.id === 'group-work').tags, tagsBefore);
  const tagStart = await start(`[data-sort-id="${tagsBefore[0].id}"] > .tag-manager-chip-edit`);
  const tagTarget = await rect(`[data-sort-id="${tagsBefore[1].id}"]`);
  await mouse('mouseMoved', tagTarget.right - 2, tagTarget.y);
  await mouse('mouseReleased', tagTarget.right - 2, tagTarget.y, 0);
  await waitFor("!document.querySelector('.tag-manager-page').hasAttribute('aria-busy')");
  assert.equal(await evaluate("document.querySelector('.tag-manager-draft-input')===null"), true);
  assert.deepEqual((await saved()).groups.find(group => group.id === 'group-work').tags.slice(0, 2).map(tag => tag.id), [tagsBefore[1].id, tagsBefore[0].id]);
  check('short click edits; long hold sorts without editing; premature movement cancels; group sorting is preserved');

  const beforeCancel = await saved();
  await start(`[data-sort-id="${tagsBefore[0].id}"] > .tag-manager-chip-edit`);
  await key('Escape');
  const canceled = await rect(`[data-sort-id="${tagsBefore[0].id}"] > .tag-manager-chip-edit`);
  await mouse('mouseReleased', canceled.x, canceled.y, 0);
  assert.deepEqual(await saved(), beforeCancel);
  assert.equal(await evaluate("document.querySelectorAll('.tag-sort-ghost,.tag-manager-draft-input').length"), 0);
  const pendingPress = await rect(`[data-sort-id="${tagsBefore[0].id}"] > .tag-manager-chip-edit`);
  await mouse('mouseMoved', pendingPress.x, pendingPress.y, 0);
  await mouse('mousePressed', pendingPress.x, pendingPress.y);
  await evaluate("window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1}))");
  await sleep(390);
  await mouse('mouseReleased', pendingPress.x, pendingPress.y, 0);
  assert.equal(await evaluate("document.querySelectorAll('.tag-sort-ghost,.tag-manager-draft-input').length"), 0);
  assert.deepEqual(await saved(), beforeCancel);
  check('Escape during a hold and device cancellation before activation clear timers and never edit');

  for (const width of [560, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 420, deviceScaleFactor: 1, mobile: false });
    await evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
    assert.equal(await evaluate("document.querySelector('.tag-manager-body').scrollWidth<=document.querySelector('.tag-manager-body').clientWidth"), true);
    await click('[data-group-id="group-work"] .tag-manager-add-tag');
    assert.equal(await fits('.tag-manager-editor'), true);
    await click('.tag-manager-color-dot');
    assert.equal(await fits('.tag-manager-palette'), true);
    await key('Escape'); await key('Escape');
  }
  await screenshot('tags-manager-narrow');
  check('560px and 320px layouts keep inputs and palette inside the viewport');

  // Inject one failed write: keep the draft so the user can retry it.
  await evaluate("window.__originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='desktop-calendar:tag-templates')throw Error('Injected save failure');return window.__originalSetItem.call(this,k,v)}");
  await click('[data-group-id="group-work"] .tag-manager-add-tag');
  await fill('失败后重试');
  await click('.tag-manager-draft-save');
  await waitFor("document.querySelector('.tag-manager-save-status').classList.contains('is-error')");
  assert.equal(await evaluate("document.querySelector('.tag-manager-draft-input').value"), '失败后重试');
  await evaluate('Storage.prototype.setItem=window.__originalSetItem');
  await save();
  check('failed save preserves the unsaved draft for retry');

  const updated = await saved();
  for (const view of ['day', 'month']) {
    await command('Emulation.setDeviceMetricsOverride', { width: view === 'day' ? 390 : 1180, height: view === 'day' ? 650 : 820, deviceScaleFactor: 1, mobile: false });
    await navigate(view);
    const add = view === 'day' ? '.tag-add-button' : '.add-long-tag';
    await waitFor(`Boolean(document.querySelector('${add}'))`);
    await click(add);
    await waitFor("Boolean(document.querySelector('.tag-popover .tag-create-input'))");
    assert.equal(await fits('.tag-popover'), true);
    assert.equal(await evaluate("document.querySelector('.tag-template-picker')===null"), true);
    assert.equal(await evaluate("document.querySelectorAll('.tag-color-row .tag-color-swatch').length"), 8);
    assert.equal(await evaluate("document.querySelector('.tag-create-input').getBoundingClientRect().bottom <= document.querySelector('.tag-color-row').getBoundingClientRect().top"), true);
    assert.equal(await evaluate("document.querySelectorAll('.tag-group-tab').length"), updated.groups.length);
    await evaluate("(()=>{const input=document.querySelector('.tag-create-input');input.value='切换分组前的草稿';input.dispatchEvent(new Event('input',{bubbles:true}))})()");
    await click('.tag-color-row .tag-color-swatch:nth-child(3)');
    for (const group of updated.groups) {
      await click(`.tag-group-tab[title="${group.name}"]`);
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.tag-template-button')].map(button=>button.textContent)"), group.tags.map(tag => tag.text));
      assert.equal(await fits('.tag-popover'), true);
      assert.equal(await evaluate("document.querySelector('.tag-create-input').value"), '切换分组前的草稿');
      assert.equal(await evaluate("document.querySelector('.tag-color-swatch.is-selected').style.getPropertyValue('--swatch')"), '#d09aac');
    }
    await evaluate("(()=>{const input=document.querySelector('.tag-create-input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}))})()");
    await click('.tag-color-row .tag-color-swatch:first-child');
    await screenshot(`tags-picker-${view}`);
    await evaluate("window.__opened=[];window.__settingsTarget={location:{href:'about:blank',replace(url){this.href=url}},focus(){}};window.open=(...args)=>{window.__opened.push(args);return window.__settingsTarget}");
    await click('.tag-manage-link');
    assert.deepEqual(await evaluate('window.__opened[0]'), ['', 'settings', 'width=780,height=560']);
    assert.equal(await evaluate("new URL(window.__settingsTarget.location.href).hash"), '#settings?tab=tags');
    await click(add);
    const expectedText = await evaluate("document.querySelector('.tag-template-button').textContent");
    await click('.tag-template-button');
    await waitFor("!document.querySelector('.tag-popover')");
    await waitFor(`JSON.parse(localStorage.getItem('${view === 'day' ? 'desktop-calendar:day:2026-10-24' : 'desktop-calendar:long-tasks'}')).tasks[0].tags.at(-1).text===${JSON.stringify(expectedText)}`);
    const tags = await evaluate(`JSON.parse(localStorage.getItem('${view === 'day' ? 'desktop-calendar:day:2026-10-24' : 'desktop-calendar:long-tasks'}')).tasks[0].tags`);
    assert.equal(tags.at(-1).text, expectedText);
    assert.notEqual(tags.at(-1).id, updated.groups.flatMap(group => group.tags).find(tag => tag.text === expectedText).id);
    await click(add);
    await evaluate(`(()=>{const input=document.querySelector('.tag-create-input');input.value='临时标签 ${view}';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await click('.tag-color-row .tag-color-swatch:nth-child(4)');
    await click('.tag-create-submit');
    const storageKey = view === 'day' ? 'desktop-calendar:day:2026-10-24' : 'desktop-calendar:long-tasks';
    await waitFor(`JSON.parse(localStorage.getItem('${storageKey}')).tasks[0].tags.at(-1).text==='临时标签 ${view}'`);
    const temporary = await evaluate(`JSON.parse(localStorage.getItem('${storageKey}')).tasks[0].tags.at(-1)`);
    assert.equal(temporary.source, 'custom');
    assert.equal(temporary.color, '#d0aa7e');
  }
  check('day/month both select tags by group; temporary tag input, color row, and creation work');

  const pagedGroups = {
    version: 1,
    groups: Array.from({ length: 8 }, (_, index) => ({
      id: `page-group-${index}`, name: `标签分组${index}长名称`,
      tags: index === 0 ? [] : [{ id: `page-tag-${index}`, text: `分组${index}专属标签`, color: '#8fb6d3' }],
    })),
  };
  await evaluate(`localStorage.setItem('desktop-calendar:tag-templates',JSON.stringify(${JSON.stringify(pagedGroups)}))`);
  await command('Emulation.setDeviceMetricsOverride', { width: 980, height: 520, deviceScaleFactor: 1, mobile: false });
  await navigate('month');
  await waitFor("Boolean(document.querySelector('.add-long-tag'))");
  await click('.add-long-tag');
  assert.equal(await evaluate("document.querySelector('.tag-template-empty').textContent"), '该分组暂无长期标签');
  assert.equal(await evaluate("document.querySelector('.tag-page-button[aria-label=\"上一页标签分组\"]').disabled"), true);
  const visitedGroups = new Set();
  for (let page = 0; page < pagedGroups.groups.length; page++) {
    const names = await evaluate("[...document.querySelectorAll('.tag-group-tab')].map(button=>button.title)");
    for (const name of names) {
      visitedGroups.add(name);
      await click(`.tag-group-tab[title="${name}"]`);
      const group = pagedGroups.groups.find(item => item.name === name);
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.tag-template-button')].map(button=>button.textContent)"), group.tags.map(tag => tag.text));
      assert.equal(await fits('.tag-popover'), true);
      assert.equal(await evaluate("document.querySelector('.tag-group-pager').scrollWidth <= document.querySelector('.tag-group-pager').clientWidth"), true);
    }
    if (await evaluate("document.querySelector('.tag-page-button[aria-label=\"下一页标签分组\"]').disabled")) break;
    await click('.tag-page-button[aria-label="下一页标签分组"]');
  }
  assert.equal(visitedGroups.size, pagedGroups.groups.length);
  assert.notEqual(await evaluate("document.querySelector('.tag-page-counter').textContent"), '1/1');
  // Deleting the selected group in the manager must fall back to an existing group.
  const deletedGroupName = await evaluate("document.querySelector('.tag-group-tab.is-active').title");
  pagedGroups.groups = pagedGroups.groups.filter(group => group.name !== deletedGroupName);
  await evaluate(`localStorage.setItem('desktop-calendar:tag-templates',JSON.stringify(${JSON.stringify(pagedGroups)}));window.dispatchEvent(new CustomEvent('calendar://tag-templates-updated'))`);
  await waitFor(`document.querySelector('.tag-group-tab.is-active')?.title===${JSON.stringify(pagedGroups.groups[0].name)}`);
  assert.equal(await evaluate("document.querySelectorAll('.tag-template-button').length"), 0);
  assert.equal(await evaluate("document.querySelector('.tag-template-empty').textContent"), '该分组暂无长期标签');
  await evaluate(`localStorage.setItem('desktop-calendar:tag-templates',JSON.stringify(${JSON.stringify(updated)}))`);
  check('month group pagination, empty groups, popup bounds, and deletion fallback');

  // A second window writes templates; an open selector must refresh immediately.
  await navigate('day'); await click('.tag-add-button');
  const visibleGroupName = await evaluate("document.querySelector('.tag-group-tab.is-active').title");
  const { targetId: writerId } = await call('Target.createTarget', { url: `${origin}/src/index.html?view=settings&tab=tags` });
  const { sessionId: writerSession } = await call('Target.attachToTarget', { targetId: writerId, flatten: true });
  await call('Runtime.enable', {}, writerSession);
  for (let attempt = 0; attempt < 160; attempt++) {
    const ready = await call('Runtime.evaluate', { expression: `location.origin===${JSON.stringify(origin)} && document.readyState==='complete'`, returnByValue: true }, writerSession);
    if (ready.result.value) break;
    await sleep(25);
  }
  const crossWindowTemplates = structuredClone(updated);
  crossWindowTemplates.groups.find(group => group.name === visibleGroupName).tags[0].text = '跨窗口同步';
  const writeResult = await call('Runtime.evaluate', { expression: `localStorage.setItem('desktop-calendar:tag-templates',JSON.stringify(${JSON.stringify(crossWindowTemplates)}))` }, writerSession);
  assert.equal(writeResult.exceptionDetails, undefined);
  await waitFor("document.querySelector('.tag-template-button').textContent==='跨窗口同步'");
  await call('Target.closeTarget', { targetId: writerId });
  check('cross-window storage notification refreshes an already open picker');

  await evaluate(`localStorage.setItem('desktop-calendar:tag-templates',JSON.stringify(${JSON.stringify({ version: 1, groups: [defaults.groups[0]] })}))`);
  await navigate('tag-manager');
  await waitFor("document.querySelectorAll('.tag-group-card').length===1");
  await click('.tag-group-more');
  assert.equal(await evaluate("document.querySelector('.tag-group-delete').disabled"), true);
  check('the last remaining group cannot be deleted');
  await key('Escape');

  const wrapped = { version: 1, groups: [{ id: 'wrapped', name: '长分组名称与换行标签', tags: Array.from({ length: 12 }, (_, index) => ({ id: `wrap-${index}`, text: `标签 ${index} 长名称`, color: '#8fb6d3' })) }] };
  await evaluate(`localStorage.setItem('desktop-calendar:tag-templates',JSON.stringify(${JSON.stringify(wrapped)}))`);
  await command('Emulation.setDeviceMetricsOverride', { width: 560, height: 420, deviceScaleFactor: 1, mobile: false });
  await navigate('tag-manager');
  await waitFor("document.querySelectorAll('.tag-manager-chip').length===12");
  const wrappedStart = await start('[data-sort-id="wrap-0"] .tag-manager-chip-edit');
  const wrappedTarget = await rect('[data-sort-id="wrap-8"]');
  assert.ok(wrappedTarget.y > wrappedStart.y + 25);
  await mouse('mouseMoved', wrappedTarget.right - 2, wrappedTarget.y);
  await mouse('mouseReleased', wrappedTarget.right - 2, wrappedTarget.y, 0);
  await waitFor("!document.querySelector('.tag-manager-page').hasAttribute('aria-busy')");
  assert.deepEqual((await saved()).groups[0].tags.slice(7, 10).map(tag => tag.id), ['wrap-8', 'wrap-0', 'wrap-9']);
  const invalidStart = await start('[data-sort-id="wrap-0"] .tag-manager-chip-edit');
  const beforeInvalid = await saved();
  await mouse('mouseMoved', 2, invalidStart.y);
  await mouse('mouseReleased', 2, invalidStart.y, 0);
  assert.deepEqual(await saved(), beforeInvalid);
  assert.equal(await evaluate("document.querySelectorAll('.tag-sort-ghost').length"), 0);
  check('wrapped chip rows use horizontal/vertical position; release outside cancels');

  await click('.tag-manager-add-tag');
  await fill('回车确认');
  await key('Enter');
  await waitFor("!document.querySelector('.tag-manager-draft-input')");
  assert.equal((await saved()).groups[0].tags.at(-1).text, '回车确认');
  check('Enter confirms a draft and hides its input again');
  assert.deepEqual(exceptions, []);
  console.log('No browser runtime exceptions. Screenshots: src-tauri/target/tags-*.png');
  await call('Browser.close');
} finally {
  socket?.close();
  chrome.kill();
  server.close();
  // Only remove the fresh profile created by this test, after verifying its absolute temp prefix.
  if (resolve(profile).startsWith(join(resolve(tmpdir()), 'calendar-tags-test-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }).catch(() => {});
  }
}
