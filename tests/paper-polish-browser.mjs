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
const profile = await mkdtemp(join(tmpdir(), 'rizhi-paper-polish-'));
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
    await writeFile(join(root, `src-tauri/target/polish-${name}.png`), Buffer.from(shot.data, 'base64'));
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

  const colors = ['#8fb6d3', '#aaa0c8', '#d09aac', '#d0aa7e', '#c5b985', '#99b888', '#8fc2b9', '#abb9c2'];
  const names = [
    '蓝色任务',
    '紫色任务',
    '粉色任务：这是一段会随窗口宽度折行的说明文字',
    '杏色任务',
    '金色任务',
    '绿色任务',
    '青色任务',
    '灰蓝任务',
  ];
  const completed = ['cream', 'rose', 'blue', 'lilac', 'apricot', 'sage'].map((tone, i) => ({
    id: `done-${i}`,
    title: `完成的小事 ${i + 1}`,
    status: 'completed',
    completedAt: i + 1,
    flower: { variant: ['wild', 'daisy', 'cosmos', 'plum', 'star', 'camellia'][i], tone },
    tags: [],
    children: [],
  }));
  const tasks = [
    {
      id: 'reminder',
      title: '生日提醒 · 留一份心意',
      status: 'active',
      pinned: true,
      kind: 'birthday',
      reminder: { ruleId: 'preview', schedule: '每年这一天', edited: true },
      tags: [],
      children: [],
    },
    {
      id: 'parent',
      title: '把不同的事情，记成不同的颜色',
      status: 'active',
      color: colors[0],
      tags: [],
      children: [
        ...colors.map((color, i) => ({
          id: `color-${i}`,
          title: names[i],
          color,
          status: 'active',
          tags: [],
          children:
            i === 5
              ? [{ id: 'nested', title: '整理绿植的子任务', status: 'active', tags: [], children: [] }]
              : [],
        })),
        ...completed,
      ],
    },
  ];
  tasks[1].tags = [
    { id: 'tag-blue', text: '阅读', color: colors[0] },
    { id: 'tag-rose', text: '灵感', color: colors[2] },
  ];
  tasks.push({
    id: 'failed',
    title: '未能完成的安排',
    status: 'failed',
    color: colors[2],
    tags: [],
    children: [],
  });
  await read(
    `localStorage.clear();localStorage.setItem('desktop-calendar:day:2026-10-24',JSON.stringify(${JSON.stringify({ date: '2026-10-24', note: '记下今天的小事。\n文字落在横线上方，留出呼吸的空隙。\nA quiet page for today.', tasks })}))`,
  );
  await reload("document.querySelector('[data-task-id=color-7]')");
  await read(
    `localStorage.setItem('desktop-calendar:tag-templates',JSON.stringify({version:1,groups:[{id:'g',name:'日常',tags:${JSON.stringify(tasks[1].tags)}}]}))`,
  );
  const row = (id) => `document.querySelector('[data-task-id="${id}"]')`;
  await read(
    `window.__hex=color=>{const c=document.createElement('canvas').getContext('2d');c.fillStyle=color;c.fillRect(0,0,1,1);return '#'+[...c.getImageData(0,0,1,1).data].slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join('')}`,
  );
  for (const presetId of ['morning', 'mist', 'apricot', 'sage', 'rose']) {
    await setTheme({ presetId, surfaceStyle: 'notebook', appearance: 'botanical', gardenEnabled: true });
    await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    const contrasts = await read(
      `(async()=>{const {contrastRatio}=await import('/src/domain/color-ink.mjs');return ${JSON.stringify(colors)}.map((_,i)=>{const row=document.querySelector('[data-task-id="color-'+i+'"]');return contrastRatio(window.__hex(getComputedStyle(row.querySelector('.task-title')).color),window.__hex(getComputedStyle(row.closest('.task-tree > .task-node')).backgroundColor))})})()`,
    );
    assert.ok(
      contrasts.every((value) => value >= 4.5),
      JSON.stringify({ presetId, contrasts }),
    );
    assert.equal(
      await read(
        "getComputedStyle(document.querySelector('.day-window')).backgroundImage.includes('repeating-linear-gradient')",
      ),
      false,
    );
    assert.equal(
      await read("Number(getComputedStyle(document.querySelector('.garden-growth')).opacity)"),
      0.68,
    );
    assert.equal(await read("document.querySelectorAll('.garden-plant').length"), 6);
    assert.equal(
      await read(
        "getComputedStyle(document.querySelector('[data-task-id=reminder]').closest('.task-node')).backgroundColor!==getComputedStyle(document.querySelector('[data-task-id=parent]').closest('.task-node')).backgroundColor",
      ),
      true,
    );
    const roles = await read(
      `(()=>{const c=document.createElement('canvas').getContext('2d'),rgba=color=>{c.clearRect(0,0,1,1);c.fillStyle=color;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data]};const button=getComputedStyle(document.querySelector('.add-root')),sage=rgba(getComputedStyle(document.querySelector('[data-task-id="done-5"] .flower-petal')).fill),pink=rgba(getComputedStyle(document.querySelector('[data-task-id="color-2"] .task-title')).color),failure=rgba(getComputedStyle(document.querySelector('[data-task-id="failed"] .task-title')).color);return {buttonAlpha:rgba(button.backgroundColor)[3],buttonImage:button.backgroundImage,sage,pink,failure,tag:rgba(getComputedStyle(document.querySelector('.tag-chip')).backgroundColor)[3],leafVein:getComputedStyle(document.querySelector('[data-task-id="color-0"] .status-button'),'::after').borderTopWidth}})()`,
    );
    assert.equal(roles.buttonAlpha, 255);
    assert.equal(roles.buttonImage, 'none');
    assert.equal(roles.tag, 255);
    assert.equal(roles.leafVein, '1px');
    assert.ok(
      roles.sage[0] > roles.sage[1] && roles.sage[0] > roles.sage[2],
      'stored green tone renders coral petals on paper',
    );
    assert.ok(
      roles.failure[0] > roles.failure[2] * 2 && roles.pink[2] > roles.pink[1] * 1.5,
      'rust failure and magenta task ink remain distinct',
    );
    await screenshot(`paper-${presetId}`);
  }
  await pointerClick('.window-control.pin');
  assert.equal(await read("document.querySelector('.pin').getAttribute('aria-pressed')"), 'true');
  assert.equal(await read("getComputedStyle(document.querySelector('.pin')).color"), 'rgb(255, 250, 240)');
  await pointerClick('.window-control.pin');
  const toolBox = await read(
    "(()=>{const r=document.querySelector('.settings-toggle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
  );
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...toolBox });
  await sleep(180);
  assert.equal(
    await read("getComputedStyle(document.querySelector('.settings-toggle')).backgroundImage"),
    'none',
  );
  await screenshot('paper-toolbar-hover');
  check(
    'all five paper palettes: eight distinct inks meet contrast floor; no task rules; stronger garden; reminder wash',
  );
  // Validate measured straight connectors on nested and wrapped rows, at both window widths.
  const endpoints = `(()=>{let errors=[];document.querySelectorAll('.task-plant-branches').forEach(svg=>{const m=svg.getScreenCTM(),parent=svg.parentElement.querySelector(':scope > .task-row .status-button').getBoundingClientRect();const trunk=svg.querySelector('.plant-trunk');const start=trunk.getPointAtLength(0);errors.push(Math.hypot(start.x*m.a+m.e-(parent.x+parent.width/2),start.y*m.d+m.f-parent.bottom));svg.querySelectorAll('.plant-fork').forEach(path=>{const id=path.dataset.branchKey.slice(5),circle=[...svg.parentElement.querySelectorAll(':scope > .children > .task-node > .task-row')].find(row=>row.dataset.taskId===id).querySelector('.status-button').getBoundingClientRect(),p=path.getPointAtLength(path.getTotalLength()),a=path.getPointAtLength(0);errors.push(Math.hypot(p.x*m.a+m.e-circle.left,p.y*m.d+m.f-(circle.top+circle.height/2)),Math.abs(a.x-start.x));});});return errors})()`;
  for (const width of [390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', {
      width,
      height: 800,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await setTheme({ presetId: 'morning', surfaceStyle: 'notebook', appearance: 'minimal' });
    await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    const errors = await read(endpoints);
    assert.ok(errors.length > 10 && errors.every((n) => n < 1.2), JSON.stringify(errors));
    assert.equal(
      await read(
        "getComputedStyle(document.querySelector('[data-task-id=parent]').closest('.task-node')).boxShadow.includes('inset')",
      ),
      true,
    );
    assert.equal(
      await read("getComputedStyle(document.querySelector('[data-task-id=parent]')).boxShadow"),
      'none',
    );
    await screenshot(`minimal-${width}`);
  }
  check(
    'nested minimal stems join parent bottoms and child-circle edges, including wrapped text and resized rows',
  );
  // A change of root color updates the whole frame immediately; a child's change does not.
  await pointerClick('[data-task-id=parent] .task-color-button');
  await click('.task-color-choice[aria-label="设为柔粉"]');
  const pinkFrame = await read(
    "getComputedStyle(document.querySelector('[data-task-id=parent]').closest('.task-node')).boxShadow",
  );
  await pointerClick('[data-task-id=color-1] .task-color-button');
  await click('.task-color-choice[aria-label="设为草绿"]');
  assert.equal(
    await read(
      "getComputedStyle(document.querySelector('[data-task-id=parent]').closest('.task-node')).boxShadow",
    ),
    pinkFrame,
  );
  await pointerClick('[data-task-id=parent] .task-color-button');
  await click('.task-color-none');
  assert.equal(
    await read(
      "getComputedStyle(document.querySelector('[data-task-id=parent]').closest('.task-node')).boxShadow.includes('inset')",
    ),
    false,
  );
  for (const appearance of ['minimal', 'botanical']) {
    await setTheme({ presetId: 'morning', surfaceStyle: 'glass', appearance });
    await pointerClick('[data-task-id=parent] .task-color-button');
    await click('.task-color-choice[aria-label="设为浅蓝"]');
    assert.equal(
      await read(
        "getComputedStyle(document.querySelector('[data-task-id=parent]').closest('.task-node')).boxShadow.includes('inset')",
      ),
      true,
    );
    assert.equal(
      await read("getComputedStyle(document.querySelector('[data-task-id=parent]')).boxShadow"),
      'none',
    );
  }
  check(
    'root family stripe updates through the palette, clears to neutral, and remains independent of child colors in all appearances',
  );
  await setTheme({
    presetId: 'morning',
    surfaceStyle: 'notebook',
    appearance: 'botanical',
    gardenEnabled: false,
  });
  assert.equal(await read("document.querySelector('.day-header-garden').hidden"), true);
  assert.equal(await read("document.querySelectorAll('.garden-plant').length"), 0);
  await click('[data-task-id=color-0] .status-button');
  assert.equal(await read(`${row('color-0')}.classList.contains('is-blooming')`), true);
  assert.equal(
    await read(
      "document.querySelector('[data-task-id=parent]').closest('.task-node').querySelector(':scope > .children > .task-node > .task-row').dataset.taskId",
    ),
    'color-1',
  );
  assert.equal(await read("document.querySelectorAll('.garden-plant').length"), 0);
  await click('[data-task-id=color-0] .status-button');
  await setTheme({
    presetId: 'morning',
    surfaceStyle: 'notebook',
    appearance: 'botanical',
    gardenEnabled: true,
  });
  await read("document.querySelector('.task-list').scrollTop=0");
  await click('[data-task-id=color-0] .status-button');
  const together = await read(
    `(()=>{const row=${row('color-0')},node=row.closest('.task-node'),plant=document.querySelector('[data-garden-task-id="color-0"]');return {bloom:row.classList.contains('is-blooming'),growing:plant.dataset.phase==='growing',moving:node.getAnimations().some(a=>a.playState==='running'),first:node.parentElement.querySelector(':scope > .task-node > .task-row').dataset.taskId}})()`,
  );
  assert.deepEqual(together, { bloom: true, growing: true, moving: true, first: 'color-1' });
  const finalFlowerOpacity = await read(
    `(()=>{const flower=${row('color-0')}.querySelector('.completion-flower'),animation=flower.getAnimations().find(a=>a.animationName==='flower-settle');animation.pause();animation.currentTime=900;return Number(getComputedStyle(flower).opacity)})()`,
  );
  assert.equal(finalFlowerOpacity, 1);
  await wait("!document.querySelector('.is-blooming')");
  assert.equal(
    await read(`Number(getComputedStyle(${row('color-0')}.querySelector('.completion-flower')).opacity)`),
    finalFlowerOpacity,
    'finishing bloom does not flash to a different opacity',
  );
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 800,
    deviceScaleFactor: 2,
    mobile: false,
  });
  const note = await read(
    `(()=>{const node=document.querySelector('.note-editor'),style=getComputedStyle(node),c=document.createElement('canvas').getContext('2d');c.font=style.fontSize+' '+style.fontFamily;const m=c.measureText('记下今天的小事。'),line=parseFloat(style.lineHeight),baseline=(line-m.fontBoundingBoxAscent-m.fontBoundingBoxDescent)/2+m.fontBoundingBoxAscent;return {origin:style.backgroundOrigin,attachment:style.backgroundAttachment,gap:line-1-baseline-m.actualBoundingBoxDescent}})()`,
  );
  assert.equal(note.origin, 'content-box');
  assert.equal(note.attachment, 'local');
  assert.ok(note.gap >= 3, JSON.stringify(note));
  await screenshot('simultaneous-and-notes');
  check(
    'garden off still blooms locally; garden growth, task bloom and task movement start together; note rules clear glyphs',
  );
  await command('Page.navigate', { url: `${origin}/src/index.html#settings?tab=theme` });
  await command('Emulation.setDeviceMetricsOverride', {
    width: 780,
    height: 560,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await wait("document.querySelector('.garden-enabled-input')");
  assert.ok(
    await read("document.querySelector('.completion-motion-control').textContent.includes('开启花丛')"),
  );
  await click('.garden-enabled-input');
  assert.equal(await read("JSON.parse(localStorage.getItem('desktop-calendar-theme')).gardenEnabled"), false);
  await reload("document.querySelector('.garden-enabled-input')");
  assert.equal(await read("document.querySelector('.garden-enabled-input').checked"), false);
  assert.equal(
    await read("getComputedStyle(document.querySelector('.completion-motion-control small')).color"),
    await read("getComputedStyle(document.querySelector('.settings-section-title')).color"),
    'paper help copy uses readable secondary ink',
  );
  assert.equal(
    await read("getComputedStyle(document.querySelector('.settings-window')).backgroundImage"),
    'none',
    'no binding line behind settings navigation',
  );
  assert.equal(
    await read("getComputedStyle(document.querySelector('.theme-preset-swatch')).backgroundImage"),
    'none',
    'paper swatches replace radial glass glows',
  );
  assert.equal(
    await read(
      "[...document.querySelectorAll('.window-control')].every(n=>getComputedStyle(n).borderRadius==='4px'&&n.offsetWidth===20)",
    ),
    true,
  );
  for (const width of [780, 560, 320]) {
    await command('Emulation.setDeviceMetricsOverride', {
      width,
      height: 560,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(
      await read(
        "(()=>{const r=document.querySelector('.settings-panel').getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight})()",
      ),
      true,
    );
    assert.equal(
      await read("getComputedStyle(document.querySelector('.settings-window')).backgroundImage"),
      'none',
    );
    if (width === 320) await screenshot('settings-paper-320');
  }
  await command('Emulation.setDeviceMetricsOverride', {
    width: 780,
    height: 560,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await screenshot('settings-garden-toggle');
  await click('[data-settings-tab=tags]');
  await wait("document.querySelector('.tag-manager-chip')");
  await screenshot('settings-paper-tags');
  await click('[data-settings-tab=data]');
  await wait("document.querySelector('.data-settings')");
  await screenshot('settings-paper-data');
  check('garden setting and user-facing description persist through reload');
  await command('Page.navigate', { url: `${origin}/src/index.html?view=month&date=2026-10-24` });
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 820,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await wait("document.querySelector('.month-task-chip.is-reminder')");
  for (const appearance of ['minimal', 'botanical'])
    for (const presetId of ['morning', 'mist', 'apricot', 'sage', 'rose']) {
      await setTheme({ presetId, surfaceStyle: 'notebook', appearance, gardenEnabled: true });
      await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
      const calendar = await read(
        `(async()=>{const {contrastRatio}=await import('/src/domain/color-ink.mjs'),c=document.createElement('canvas').getContext('2d'),hex=color=>{c.fillStyle=color;c.fillRect(0,0,1,1);return '#'+[...c.getImageData(0,0,1,1).data].slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join('')};const today=getComputedStyle(document.querySelector('.month-day-cell.is-today .month-day-number')),cell=getComputedStyle(document.querySelector('.month-day-cell.is-today')),reminder=getComputedStyle(document.querySelector('.month-task-chip.is-reminder'));return {contrast:contrastRatio(hex(today.color),hex(today.backgroundColor)),stamp:today.borderRadius,todayImage:cell.backgroundImage,todayShadow:cell.boxShadow,reminderBorder:reminder.borderLeftWidth,branchLayer:document.querySelector('.month-plant-branches')?getComputedStyle(document.querySelector('.month-plant-branches')).zIndex:null}})()`,
      );
      assert.ok(calendar.contrast >= 4.5, JSON.stringify(calendar));
      assert.equal(calendar.stamp, '3px');
      assert.equal(calendar.todayImage, 'none');
      assert.equal(calendar.todayShadow, 'none');
      if (appearance === 'botanical') {
        assert.equal(calendar.reminderBorder, '0px');
        assert.equal(calendar.branchLayer, '1');
      }
      if (presetId === 'morning') await screenshot(`month-paper-${appearance}`);
    }
  await setTheme({ presetId: 'morning', surfaceStyle: 'glass', appearance: 'botanical' });
  assert.equal(
    await read("getComputedStyle(document.querySelector('.month-task-chip.is-reminder')).borderLeftWidth"),
    '0px',
    'glass botanical reminders also have no stray stripe',
  );
  check(
    'both month appearances: all five today stamps have strong contrast, flat highlights and borderless botanical reminders',
  );
  assert.deepEqual(exceptions, []);
  console.log('No runtime exceptions. Screenshots: src-tauri/target/polish-*.png');
  await call('Browser.close');
} finally {
  socket?.close();
  chrome.kill();
  server.close();
  if (resolve(profile).startsWith(join(resolve(tmpdir()), 'rizhi-paper-polish-')))
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => {});
}
