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
const profile = await mkdtemp(join(tmpdir(), 'calendar-feature-test-'));
const chrome = spawn(
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  [
    '--headless=new',
    '--disable-popup-blocking',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
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
      if (match) {
        clearTimeout(timeout);
        done(match[1]);
      }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { done, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
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
  const command = (method, params) => call(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Page.bringToFront');
  await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `const OriginalDate=Date;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-10-24T12:00:00']))}static now(){return OriginalDate.parse('2026-10-24T12:00:00')}}`,
  });
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const waitFor = async (expression, read = evaluate) => {
    for (let i = 0; i < 240; i++) {
      if (await read(expression)) return;
      await sleep(25);
    }
    throw Error('Timed out: ' + expression);
  };
  const click = (selector, read = evaluate) =>
    read(
      `(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled)throw Error('Unavailable: '+${JSON.stringify(selector)});node.click()})()`,
    );
  const fill = (selector, value, event = 'input', read = evaluate) =>
    read(
      `(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('${event}',{bubbles:true}))})()`,
    );
  const pointerClick = async (selector) => {
    const point = await evaluate(
      `(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();return {x:r.left+Math.min(r.width/2,20),y:r.top+r.height/2}})()`,
    );
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await command('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      buttons: 1,
      clickCount: 1,
      ...point,
    });
    await command('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      buttons: 0,
      clickCount: 1,
      ...point,
    });
  };
  const readDay = (date) => evaluate(`JSON.parse(localStorage.getItem('desktop-calendar:day:${date}'))`);
  const attach = async (targetId) => {
    const { sessionId: child } = await call('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => call(method, params, child);
    await send('Runtime.enable');
    await send('Page.enable');
    const read = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    return { send, read };
  };
  const check = (label) => console.log('PASS ' + label);
  const screenshot = async (name) => {
    await mkdir(join(root, 'src-tauri/target'), { recursive: true });
    const data = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(root, `src-tauri/target/${name}.png`), Buffer.from(data.data, 'base64'));
  };
  await command('Page.navigate', { url: `${origin}/docs/brand-preview.html` });
  await waitFor(
    'document.images.length===11&&[...document.images].every(img=>img.complete&&img.naturalWidth>0)',
  );
  await screenshot('brand-icon-preview');
  await command('Page.navigate', { url: `${origin}/src/index.html#month` });
  await waitFor("Boolean(document.querySelector('.month-window'))");
  await waitFor(
    "document.querySelector('.window-brand-icon')?.complete&&document.querySelector('.window-brand-icon').naturalWidth===32",
  );
  assert.equal(await evaluate('document.title'), '日枝 · 月视图');
  const parent = {
    id: 'parent',
    title: '年度工作',
    status: 'active',
    tags: [{ id: 'tag', text: '计划', color: '#8fb6d3' }],
    children: [{ id: 'search-child', title: '季度复盘', status: 'active', tags: [], children: [] }],
    collapsed: true,
  };
  await evaluate(
    `localStorage.clear();localStorage.setItem('desktop-calendar:day:2026-10-24',JSON.stringify(${JSON.stringify({ date: '2026-10-24', note: '', tasks: [parent, { id: 'gone', title: '季度复盘已删除', status: 'deleted', tags: [], children: [] }] })}));localStorage.setItem('desktop-calendar:day:2026-09-30',JSON.stringify({date:'2026-09-30',note:'季度复盘随笔',tasks:[]}));localStorage.setItem('desktop-calendar:long-tasks',JSON.stringify({version:1,tasks:[{id:'long-search',title:'季度复盘长期任务',status:'active',tags:[],children:[]}]}))`,
  );
  await command('Page.reload');
  await waitFor(
    "document.querySelectorAll('.month-day-cell').length===35 && document.querySelector('.month-task-chip')",
  );
  assert.equal(await evaluate("document.querySelector('.month-tools-drawer').hidden"), true);
  assert.equal(
    await evaluate("document.querySelector('.month-calendar-panel').getBoundingClientRect().width>1100"),
    true,
  );
  await screenshot('calendar-full-width');
  await click('.month-search-toggle');
  assert.equal(await evaluate("document.querySelector('.month-calendar-panel').hidden"), true);
  assert.equal(await evaluate("document.querySelector('.search-from').value"), '2026-09-25');
  await fill('.global-search-query input', '季度复盘');
  await waitFor("document.querySelectorAll('.search-result').length===3");
  await screenshot('calendar-global-search');
  assert.equal(await evaluate("Boolean(document.querySelector('.search-result-note'))"), true);
  assert.equal(await evaluate("Boolean(document.querySelector('.search-result-long'))"), true);
  await click('.search-result-task .search-result-main');
  let dayTarget;
  for (let i = 0; i < 100; i++) {
    dayTarget = (await call('Target.getTargets')).targetInfos.find(
      (t) => t.type === 'page' && t.url.includes('view=day'),
    );
    if (dayTarget) break;
    await sleep(25);
  }
  assert.ok(dayTarget);
  const day = await attach(dayTarget.targetId);
  await waitFor('Boolean(document.querySelector(\'.task-row[data-task-id="search-child"]\'))', day.read);
  assert.equal(
    await day.read(
      "document.querySelector('.task-row[data-task-id=\"parent\"]').classList.contains('is-collapsed')",
    ),
    false,
  );
  await click('.search-result-task .search-locate');
  assert.equal(await evaluate("document.querySelector('.month-calendar-panel').hidden"), false);
  assert.equal(await evaluate("document.querySelector('.month-resume-search')===null"), true);
  await click('.month-search-toggle');
  assert.equal(await evaluate("document.querySelector('.global-search-query input').value"), '季度复盘');
  assert.equal(await evaluate("document.querySelectorAll('.search-result').length"), 3);
  await click('.search-result-long .search-result-main');
  assert.equal(
    await evaluate(
      "!document.querySelector('.month-calendar-panel').hidden&&!document.querySelector('.month-tools-drawer').hidden&&document.querySelector('.month-search-workspace').hidden",
    ),
    true,
  );
  assert.equal(await evaluate("document.querySelector('.month-resume-search')===null"), true);
  await click('.month-search-toggle');
  await click('.search-back');
  check(
    'full-width calendar; real cross-month search; nested task reveal; notes/undated tasks; return to results',
  );

  await click('.month-reminder-toggle');
  await waitFor("Boolean(document.querySelector('.add-reminder'))");
  await click('.add-reminder');
  await fill('.reminder-title-input', '每周复盘提醒');
  await fill('.reminder-editor [name="frequency"]', 'weekly', 'change');
  await evaluate("document.querySelector('.reminder-editor [name=pinned]').checked=true");
  await click('.reminder-form-actions [type="submit"]');
  await waitFor("document.querySelectorAll('.reminder-rule-card').length===1");
  await waitFor(
    "JSON.parse(localStorage.getItem('desktop-calendar:day:2026-10-24')).tasks.some(t=>t.reminder)",
  );
  let todayTask = (await readDay('2026-10-24')).tasks.find((task) => task.reminder);
  assert.equal(todayTask.pinned, true);
  await waitFor("document.querySelectorAll('.task-row.is-reminder').length===1", day.read);
  await click(`.task-row[data-task-id="${todayTask.id}"] .status-button`, day.read);
  await waitFor(
    `JSON.parse(localStorage.getItem('desktop-calendar:day:2026-10-24')).tasks.find(t=>t.id===${JSON.stringify(todayTask.id)}).status==='completed'`,
  );
  assert.equal(
    await day.read("document.querySelector('.status-summary').textContent.includes('已完成 1')"),
    true,
  );
  check(
    'reminder creates an actual pinned day task and participates in completion/statistics across windows',
  );

  const ensure =
    "(async()=>{const m=await import('/src/storage/reminder-service.mjs');await m.ensureReminders('2026-10-24','2026-11-14')})()";
  await Promise.all([evaluate(ensure), day.read(ensure)]);
  for (const date of ['2026-10-24', '2026-10-31', '2026-11-07', '2026-11-14'])
    assert.equal((await readDay(date)).tasks.filter((task) => task.reminder).length, 1);
  await evaluate(
    "(async()=>{const {loadDay,saveDayNow}=await import('/src/storage/day-storage.mjs');const edited=await loadDay('2026-10-31');edited.tasks.find(t=>t.reminder).title='用户改过的任务';await saveDayNow(edited);const done=await loadDay('2026-11-07');done.tasks.find(t=>t.reminder).status='completed';await saveDayNow(done);window.__staleFuture=await loadDay('2026-11-14')})()",
  );
  assert.equal(await evaluate("document.querySelector('.reminder-stop').textContent"), '以后不再提醒');
  await click('.reminder-rule-card .reminder-stop');
  await click('.reminder-confirm-overlay .danger');
  await waitFor("JSON.parse(localStorage.getItem('desktop-calendar:reminders')).rules[0].archived===true");
  await waitFor("document.querySelector('.reminder-confirm-overlay')===null");
  assert.equal(
    (await readDay('2026-10-24')).tasks.find((task) => task.id === todayTask.id).status,
    'completed',
  );
  assert.equal((await readDay('2026-10-31')).tasks[0].title, '用户改过的任务');
  assert.equal((await readDay('2026-10-31')).tasks[0].reminder, undefined);
  assert.equal((await readDay('2026-11-07')).tasks[0].status, 'completed');
  assert.equal((await readDay('2026-11-07')).tasks[0].reminder, undefined);
  assert.equal((await readDay('2026-11-14')).tasks.length, 0);
  await evaluate(
    "(async()=>{const {saveDayNow}=await import('/src/storage/day-storage.mjs');await saveDayNow(window.__staleFuture)})()",
  );
  assert.equal((await readDay('2026-11-14')).tasks.length, 0);
  check(
    'multi-window deduplication; stop keeps today/history and customized/completed future work; stale saves cannot resurrect',
  );

  await click('.add-reminder');
  await fill('.reminder-title-input', '农历纪念日');
  await fill('.reminder-editor [name="kind"]', 'anniversary', 'change');
  await fill('.reminder-editor [name="calendar"]', 'lunar', 'change');
  assert.equal(await evaluate("document.querySelector('.reminder-editor [name=month]').value"), '9');
  assert.equal(await evaluate("document.querySelector('.reminder-editor [name=day]').value"), '15');
  await click('.reminder-form-actions [type="submit"]');
  await waitFor(
    "JSON.parse(localStorage.getItem('desktop-calendar:day:2026-10-24')).tasks.some(t=>t.title==='农历纪念日')",
  );
  await waitFor("document.querySelector('.reminder-editor')===null");
  await screenshot('calendar-reminder-center');
  const lunarTask = (await readDay('2026-10-24')).tasks.find((task) => task.title === '农历纪念日');
  assert.ok(lunarTask.reminder.schedule.includes('农历'));
  await waitFor(
    "[...document.querySelectorAll('.task-row')].some(row=>row.dataset.taskId=== '" + lunarTask.id + "')",
    day.read,
  );
  await day.read(
    `document.querySelector('.task-row[data-task-id="${lunarTask.id}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:200}))`,
  );
  await click('.task-context-menu .danger', day.read);
  await waitFor(
    `JSON.parse(localStorage.getItem('desktop-calendar:day:2026-10-24')).tasks.find(t=>t.id===${JSON.stringify(lunarTask.id)}).status==='deleted'`,
  );
  await evaluate(
    "(async()=>{await(await import('/src/storage/reminder-service.mjs')).ensureReminders('2026-10-24')})()",
  );
  assert.equal((await readDay('2026-10-24')).tasks.filter((t) => t.id === lunarTask.id).length, 1);
  assert.equal((await readDay('2026-10-24')).tasks.find((t) => t.id === lunarTask.id).status, 'deleted');
  check('lunar editor converts selected date correctly; deleting one occurrence does not regenerate it');
  await click('.month-search-toggle');
  await fill('.global-search-query input', '农历纪念日');
  await fill('.search-from', '2027-01-01', 'change');
  await fill('.search-through', '2027-12-31', 'change');
  await waitFor("document.querySelectorAll('.search-result-reminder').length===1");
  const futureDate = await evaluate("document.querySelector('.search-date-heading').textContent");
  await click('.search-result-reminder .search-result-main');
  await waitFor(
    `JSON.parse(localStorage.getItem('desktop-calendar:day:${futureDate}'))?.tasks.some(t=>t.title==='农历纪念日')`,
  );
  assert.equal((await readDay(futureDate)).tasks.filter((task) => task.reminder).length, 1);
  check('search can project an unvisited future lunar occurrence and open its actual generated day task');
  await click('.search-back');
  await command('Page.bringToFront');
  await command('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click('.month-reminder-toggle');
  await click('.add-reminder');
  await pointerClick('.reminder-title-input');
  assert.equal(
    await evaluate("getComputedStyle(document.querySelector('.reminder-title-input')).outlineStyle"),
    'none',
  );
  assert.equal(await evaluate("document.querySelector('.reminder-calendar-hint').hidden"), true);
  assert.equal(
    await evaluate(
      "(()=>{const r=document.querySelector('.reminder-save').getBoundingClientRect();const d=document.querySelector('.month-tools-drawer').getBoundingClientRect();return r.bottom<=d.bottom&&r.top>d.top&&r.bottom<=innerHeight})()",
    ),
    true,
  );
  await screenshot('calendar-reminder-editor-polish');
  await pointerClick('.month-drawer-close');
  await click('.month-reminder-toggle');
  assert.equal(
    await evaluate(
      "Boolean(document.querySelector('.add-reminder'))&&!document.querySelector('.reminder-editor')",
    ),
    true,
  );
  await click('.add-reminder');
  await pointerClick('.month-weekdays');
  assert.equal(await evaluate("document.querySelector('.month-tools-drawer').hidden"), true);
  await click('.month-reminder-toggle');
  assert.equal(await evaluate("Boolean(document.querySelector('.add-reminder'))"), true);
  check(
    'theme focus ring; visible fixed save footer; untouched create form resets after close or outside click',
  );

  await click('.add-reminder');
  await fill('.reminder-editor [name="month"]', '2', 'change');
  await fill('.reminder-editor [name="day"]', '29');
  assert.equal(await evaluate("document.querySelector('.reminder-calendar-hint').hidden"), false);
  assert.match(await evaluate("document.querySelector('.reminder-calendar-hint').textContent"), /2 月 28 日/);
  await fill('.reminder-editor [name="day"]', '28');
  assert.equal(await evaluate("document.querySelector('.reminder-calendar-hint').hidden"), true);
  await fill('.reminder-editor [name="frequency"]', 'monthly', 'change');
  await fill('.reminder-editor [name="day"]', '31');
  assert.match(await evaluate("document.querySelector('.reminder-calendar-hint').textContent"), /4 月 30 日/);
  await fill('.reminder-editor [name="calendar"]', 'lunar', 'change');
  assert.equal(await evaluate("document.querySelector('.reminder-calendar-hint').hidden"), true);
  await fill('.reminder-editor [name="day"]', '30');
  assert.match(await evaluate("document.querySelector('.reminder-calendar-hint').textContent"), /当月 29 日/);
  await fill('.reminder-editor [name="frequency"]', 'yearly', 'change');
  await click('.reminder-editor [name="leapMonth"]');
  assert.match(
    await evaluate("document.querySelector('.reminder-calendar-hint').textContent"),
    /同名的普通月/,
  );
  await fill('.reminder-editor [name="frequency"]', 'weekly', 'change');
  assert.equal(await evaluate("document.querySelector('.reminder-date-fields').hidden"), true);
  await fill('.reminder-title-input', '未保存的草稿');
  await pointerClick('.month-weekdays');
  assert.equal(await evaluate("document.querySelector('.month-tools-drawer').hidden"), true);
  await click('.month-reminder-toggle');
  assert.equal(await evaluate("document.querySelector('.reminder-title-input').value"), '未保存的草稿');
  await click('.reminder-edit-cancel');
  await waitFor("Boolean(document.querySelector('.add-reminder'))");
  check('date fallback hints only for exceptional dates; meaningful reminder draft survives drawer close');

  await click('.reminder-center [data-archived="true"]');
  await click('.reminder-delete');
  await pointerClick('.reminder-delete-overlay .cancel');
  assert.equal(await evaluate("document.querySelector('.month-tools-drawer').hidden"), false);
  assert.equal(
    await evaluate("JSON.parse(localStorage.getItem('desktop-calendar:reminders')).rules.length"),
    2,
  );
  await click('.reminder-delete');
  await click('.reminder-delete-overlay .danger');
  await waitFor(
    "JSON.parse(localStorage.getItem('desktop-calendar:reminders')).rules.length===1&&!document.querySelector('.reminder-delete-overlay')",
  );
  assert.equal(
    (await readDay('2026-10-24')).tasks.find((task) => task.id === todayTask.id).status,
    'completed',
  );
  assert.equal((await readDay('2026-10-31')).tasks[0].title, '用户改过的任务');
  const deletedRuleId = todayTask.reminder.ruleId;
  assert.equal(
    await evaluate(
      `(async()=>{try{await(await import('/src/storage/reminder-service.mjs')).saveReminder({id:${JSON.stringify(deletedRuleId)},action:'restore'});return false}catch(e){return String(e).includes('已被删除')}})()`,
    ),
    true,
  );
  assert.equal(
    await evaluate("JSON.parse(localStorage.getItem('desktop-calendar:reminders')).rules.length"),
    1,
  );
  check(
    'stopped rule can be permanently deleted; history and independent future work survive; stale restore cannot recreate it',
  );

  await click('.month-long-toggle');
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 80 });
  await waitFor("getComputedStyle(document.querySelector('.add-long-tag')).opacity==='0'");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.add-long-to-day')).opacity"), '1');
  const idleCardHeight = await evaluate(
    "document.querySelector('.long-task-item').getBoundingClientRect().height",
  );
  const hoverPoint = await evaluate(
    "(()=>{const r=document.querySelector('.long-task-item').getBoundingClientRect();return {x:r.left+40,y:r.top+8}})()",
  );
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPoint });
  await waitFor("getComputedStyle(document.querySelector('.add-long-tag')).opacity==='1'");
  assert.equal(
    await evaluate("document.querySelector('.long-task-item').getBoundingClientRect().height"),
    idleCardHeight,
  );
  assert.equal(await evaluate("document.querySelector('.add-long-to-day').textContent"), '加入今天');
  await click('.add-long-task');
  await fill('.long-task-title-input', '取消的新任务');
  await pointerClick('.long-task-cancel');
  assert.equal(await evaluate("document.querySelectorAll('.long-task-item').length"), 1);
  await click('.add-long-task');
  await fill('.long-task-title-input', '新增长期计划');
  await pointerClick('.long-task-save');
  await waitFor("!document.querySelector('.long-task-title-input')");
  assert.equal(
    await evaluate("JSON.parse(localStorage.getItem('desktop-calendar:long-tasks')).tasks[0].title"),
    '新增长期计划',
  );
  await click('.long-task-title');
  await fill('.long-task-title-input', '不要保留这次编辑');
  await evaluate(
    "document.querySelector('.long-task-title-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  assert.equal(await evaluate("document.querySelector('.long-task-title').textContent"), '新增长期计划');
  await click('.add-long-to-day');
  await waitFor(
    "JSON.parse(localStorage.getItem('desktop-calendar:day:2026-10-24')).tasks.some(t=>t.title==='新增长期计划')",
  );
  await screenshot('calendar-long-tasks-polish');
  await click('.long-task-title');
  await fill('.long-task-title-input', '点击日历后保存');
  await pointerClick('.month-day-cell[data-date="2026-10-06"]');
  assert.equal(await evaluate("document.querySelector('.month-tools-drawer').hidden"), true);
  await waitFor(
    "JSON.parse(localStorage.getItem('desktop-calendar:long-tasks')).tasks[0].title==='点击日历后保存'",
  );
  let clickedDay;
  for (let i = 0; i < 100; i++) {
    clickedDay = (await call('Target.getTargets')).targetInfos.find(
      (t) => t.type === 'page' && t.url.includes('date=2026-10-06'),
    );
    if (clickedDay) break;
    await sleep(25);
  }
  assert.ok(clickedDay, 'Closing drawer must not swallow the clicked date');
  await command('Page.bringToFront');
  await click('.month-long-toggle');
  await click('.add-long-tag');
  await pointerClick('.long-task-tag-popover .tag-create-input');
  assert.equal(await evaluate("document.querySelector('.month-tools-drawer').hidden"), false);
  await waitFor(
    "getComputedStyle(document.querySelector('.long-task-item.has-tag-popover .add-long-tag')).opacity==='1'",
  );
  await pointerClick('.month-weekdays');
  assert.equal(
    await evaluate(
      "document.querySelector('.month-tools-drawer').hidden&&!document.querySelector('.long-task-tag-layer')",
    ),
    true,
  );
  await click('.month-reminder-toggle');
  check(
    'long-task save/cancel, Escape and join-today; calendar click closes drawer and still opens date; tag popover stays interactive',
  );
  assert.equal(
    await evaluate(
      "(()=>{const r=document.querySelector('.month-tools-drawer').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()",
    ),
    true,
  );
  await click('.month-drawer-close');
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 80 });
  const toolsBefore = await evaluate(
    "[...document.querySelectorAll('.month-header-actions .header-tool')].map(b=>({x:b.getBoundingClientRect().x,width:b.getBoundingClientRect().width}))",
  );
  assert.equal(toolsBefore.length, 4);
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('.month-header-actions .header-tool-label')].every(n=>getComputedStyle(n).opacity==='0')",
    ),
    true,
  );
  const searchPoint = await evaluate(
    "(()=>{const r=document.querySelector('.month-search-toggle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
  );
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...searchPoint });
  await waitFor(
    "getComputedStyle(document.querySelector('.month-search-toggle .header-tool-label')).opacity==='1'",
  );
  assert.equal(
    await evaluate(
      "(()=>{const button=document.querySelector('.month-search-toggle').getBoundingClientRect(),label=document.querySelector('.month-search-toggle .header-tool-label').getBoundingClientRect();return Math.abs((button.left+button.width/2)-(label.left+label.width/2))<1})()",
    ),
    true,
  );
  assert.deepEqual(
    await evaluate(
      "[...document.querySelectorAll('.month-header-actions .header-tool')].map(b=>({x:b.getBoundingClientRect().x,width:b.getBoundingClientRect().width}))",
    ),
    toolsBefore,
  );
  await screenshot('calendar-tool-label');
  await day.send('Emulation.setDeviceMetricsOverride', {
    width: 360,
    height: 650,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(await day.read("document.querySelectorAll('.header-actions .header-tool').length"), 3);
  assert.equal(await day.read("document.querySelector('.search-toggle').getAttribute('aria-label')"), '搜索');
  assert.equal(
    await day.read(
      "(()=>{const a=document.querySelector('.header-actions').getBoundingClientRect(),h=document.querySelector('.day-header h1').getBoundingClientRect();return h.right<=a.left&&a.right<=innerWidth})()",
    ),
    true,
  );
  await day.read("document.querySelector('.settings-toggle').focus()");
  await waitFor(
    "getComputedStyle(document.querySelector('.settings-toggle .header-tool-label')).opacity==='1'",
    day.read,
  );
  assert.equal(
    await day.read(
      "(()=>{const button=document.querySelector('.settings-toggle').getBoundingClientRect(),label=document.querySelector('.settings-toggle .header-tool-label').getBoundingClientRect();return Math.abs((button.left+button.width/2)-(label.left+label.width/2))<1&&label.left>=0&&label.right<=innerWidth})()",
    ),
    true,
  );
  check(
    'unified icon-only tools; hover/focus labels keep button targets stable; day search label and minimum-width date layout',
  );

  await evaluate(
    "(async()=>{const {saveDayNow}=await import('/src/storage/day-storage.mjs');await saveDayNow({date:'2026-10-05',note:'',tasks:Array.from({length:12},(_,i)=>({id:'dense-'+i,title:'任务 '+(i+1),status:'active',children:[],tags:[]}))});window.dispatchEvent(new CustomEvent('calendar://day-updated',{detail:{date:'2026-10-05'}}))})()",
  );
  const visibleDense = () =>
    evaluate(
      'document.querySelectorAll(\'.month-day-cell[data-date="2026-10-05"] .month-task-chip:not([hidden])\').length',
    );
  const fitted =
    "(()=>{const cells=[...document.querySelectorAll('.month-day-cell')],panel=document.querySelector('.month-calendar-panel').getBoundingClientRect();return cells.length>0&&cells.every(c=>c.getBoundingClientRect().bottom<=panel.bottom)&&[...document.querySelectorAll('.month-task-list')].every(l=>l.scrollHeight<=l.clientHeight+1)})()";
  await waitFor(
    'document.querySelector(\'.month-day-cell[data-date="2026-10-05"] .month-more-tasks:not([hidden])\')',
  );
  await waitFor(fitted);
  const narrowCount = await visibleDense();
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(
    'document.querySelectorAll(\'.month-day-cell[data-date="2026-10-05"] .month-task-chip:not([hidden])\').length>3',
  );
  assert.ok((await visibleDense()) > narrowCount);
  assert.equal(await evaluate(fitted), true);
  await screenshot('calendar-adaptive-five-weeks');
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(
    'document.querySelectorAll(\'.month-day-cell[data-date="2026-10-05"] .month-task-chip:not([hidden])\').length>=5',
  );
  assert.equal(await evaluate(fitted), true);
  await screenshot('calendar-adaptive-large');
  const jumpMonth = async (month, count) => {
    await click('.month-title-button');
    await fill('.month-title-input', month);
    await evaluate(
      "document.querySelector('.month-title-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
    );
    await waitFor(
      `document.querySelectorAll('.month-day-cell').length===${count}&&!document.querySelector('.month-day-cell.is-loading')`,
    );
    assert.equal(await evaluate(fitted), true);
  };
  await jumpMonth('2021-02', 28);
  await jumpMonth('2026-03', 42);
  await command('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(fitted);
  assert.equal(
    await evaluate('Boolean(document.querySelector(\'.month-day-cell[data-date="2026-03-31"]\'))'),
    true,
  );
  await screenshot('calendar-adaptive-six-weeks');
  await jumpMonth('2026-10', 35);
  check(
    'four/five/six-week month grids use full height; task count grows with available room; overflow count and last week remain visible',
  );

  // Two real frontend windows with an isolated native IPC adapter. The adapter
  // checks the save acknowledgement before retiring an already open today view.
  await evaluate(`window.__nativeDayTest={dates:{main:'2026-10-24',past:'2026-10-06'},listeners:{main:{},past:{}},windows:{},hidden:{},calls:[],pending:new Map(),failSaveFor:null,
    async invoke(label,name,args={}){
      this.calls.push({label,name,args});
      if(name==='load_day')return JSON.parse(localStorage.getItem('desktop-calendar:day:'+args.date));
      if(name==='save_day'){
        if(this.failSaveFor===label){this.failSaveFor=null;throw Error('测试保存失败')}
        if(this.deferSaveFor===label){this.deferSaveFor=null;await new Promise(resolve=>this.deferredSave={label,resolve})}
        const day={...args.day,updatedAt:String(Date.now())};localStorage.setItem('desktop-calendar:day:'+day.date,JSON.stringify(day));return day;
      }
      if(name==='load_tag_templates')return null;
      if(name==='load_storage_location')return {isDefault:true,effectivePath:'isolated-test-data'};
      if(name==='load_reminder_state')return {version:1,revision:0,rules:[],exceptions:{}};
      if(name==='get_calendar_navigation')return {date:this.dates[label]};
      if(name==='claim_day_window_date'){
        const other=Object.keys(this.dates).find(key=>key!==label&&this.dates[key]===args.date);
        if(other&&!args.takeOver)return false;
        if(other){
          const id=crypto.randomUUID();
          const saved=await new Promise(resolve=>{this.pending.set(id,{other,resolve});this.listeners[other]['calendar://day-handoff-requested']({payload:{id}})});
          if(saved){this.listeners[other]['calendar://day-handoff-cancelled']({payload:{id}});throw Error(saved)}
          this.hidden[other]=true;delete this.dates[other];
        }
        this.dates[label]=args.date;return true;
      }
      if(name==='complete_day_window_handoff'){
        const pending=this.pending.get(args.id);if(!pending||pending.other!==label)throw Error('Unexpected acknowledgement');
        this.pending.delete(args.id);pending.resolve(args.error||null);return;
      }
      if(name==='open_day_window')return;
      throw Error('Unexpected day IPC '+name);
    },
    emit(name,payload){for(const listeners of Object.values(this.listeners))listeners[name]?.({payload})}
  };
  localStorage.setItem('desktop-calendar:day:2026-10-24',JSON.stringify({date:'2026-10-24',note:'原今日随笔',tasks:[{id:'native-today',title:'今日窗口任务',status:'active',children:[],tags:[]}]}));
  localStorage.setItem('desktop-calendar:day:2026-10-06',JSON.stringify({date:'2026-10-06',note:'过去随笔',tasks:[{id:'native-past',title:'过去任务',status:'active',children:[],tags:[]}]}));`);
  const nativeDay = async (label, date) => {
    const before = new Set((await call('Target.getTargets')).targetInfos.map((t) => t.targetId));
    await evaluate(
      `window.__nativeDayTest.windows[${JSON.stringify(label)}]=window.open('about:blank',${JSON.stringify('native-day-' + label)});void 0`,
    );
    let target;
    for (let i = 0; i < 100; i++) {
      target = (await call('Target.getTargets')).targetInfos.find(
        (t) => t.type === 'page' && !before.has(t.targetId),
      );
      if (target) break;
      await sleep(25);
    }
    assert.ok(target);
    const page = await attach(target.targetId);
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
      const OriginalDate=Date;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-10-24T12:00:00']))}static now(){return OriginalDate.parse('2026-10-24T12:00:00')}};
      const label=${JSON.stringify(label)},bridge=opener.__nativeDayTest;
      window.__TAURI__={core:{invoke:(name,args)=>bridge.invoke(label,name,args)},event:{listen:async(name,handler)=>{bridge.listeners[label][name]=handler;return()=>delete bridge.listeners[label][name]},emit:async(name,payload)=>bridge.emit(name,payload)}};
    `,
    });
    await page.send('Page.navigate', { url: `${origin}/src/index.html?view=day&date=${date}` });
    await waitFor(
      "Boolean(document.querySelector('.task-title'))&&!document.querySelector('.day-load-error')",
      page.read,
    );
    return page;
  };
  const originalToday = await nativeDay('main', '2026-10-24');
  const fromMonth = await nativeDay('past', '2026-10-06');
  const windowCount = (await call('Target.getTargets')).targetInfos.filter((t) => t.type === 'page').length;
  const sameWindowToken = await fromMonth.read('window.__identity=crypto.randomUUID()');
  await fill('.note-editor', '尚未到防抖时间的今日随笔', 'input', originalToday.read);
  await evaluate("window.__nativeDayTest.failSaveFor='main'");
  await click('.day-current-button', fromMonth.read);
  await waitFor(
    "document.querySelector('.toast')?.textContent.includes('测试保存失败')&&!document.querySelector('.day-window').inert",
    fromMonth.read,
  );
  assert.equal(
    await fromMonth.read("document.querySelector('.day-date-text').textContent.startsWith('2026-10-06')"),
    true,
  );
  assert.equal(await originalToday.read("document.querySelector('.day-window').inert"), false);
  assert.equal(
    await originalToday.read("document.querySelector('.note-editor').value"),
    '尚未到防抖时间的今日随笔',
  );
  await evaluate("window.__nativeDayTest.deferSaveFor='main'");
  await originalToday.read(
    "(async()=>{const storage=await import('/src/storage/day-storage.mjs');window.__deferredFlush=storage.flushDaySave().catch(()=>{})})()",
  );
  await waitFor('Boolean(window.__nativeDayTest.deferredSave)');
  await fill('.note-editor', '保存进行期间继续写入的最新随笔', 'input', originalToday.read);
  await click('.day-current-button', fromMonth.read);
  await waitFor('window.__nativeDayTest.pending.size===1');
  assert.equal(
    await fromMonth.read(
      "document.querySelector('.day-window').inert&&document.querySelector('.day-date-text').textContent.startsWith('2026-10-06')",
    ),
    true,
  );
  assert.equal(await evaluate('Boolean(window.__nativeDayTest.hidden.main)'), false);
  await evaluate('window.__nativeDayTest.deferredSave.resolve()');
  await waitFor(
    "document.querySelector('.day-date-text').textContent.includes('2026-10-24')&&!document.querySelector('.day-window').inert&&!document.querySelector('.day-current-button')",
    fromMonth.read,
  );
  assert.equal(await fromMonth.read('window.__identity'), sameWindowToken);
  assert.equal(
    await fromMonth.read("document.querySelector('.note-editor').value"),
    '保存进行期间继续写入的最新随笔',
  );
  assert.equal(await originalToday.read("document.querySelector('.day-window').inert"), true);
  assert.deepEqual(await evaluate('window.__nativeDayTest.dates'), { past: '2026-10-24' });
  assert.equal(await evaluate('window.__nativeDayTest.hidden.main'), true);
  assert.equal(
    (await call('Target.getTargets')).targetInfos.filter((t) => t.type === 'page').length,
    windowCount,
  );
  assert.equal(await evaluate("window.__nativeDayTest.calls.some(c=>c.name==='open_day_window')"), false);
  assert.equal(await fromMonth.read("new URL(location.href).searchParams.get('date')"), '2026-10-24');
  await click('.previous-day', fromMonth.read);
  await waitFor(
    "document.querySelector('.day-date-text').textContent.includes('2026-10-23')&&!document.querySelector('.day-window').inert",
    fromMonth.read,
  );
  await click('.day-current-button', fromMonth.read);
  await waitFor(
    "document.querySelector('.day-date-text').textContent.includes('2026-10-24')&&!document.querySelector('.day-window').inert",
    fromMonth.read,
  );
  assert.equal(await fromMonth.read('window.__identity'), sameWindowToken);
  await evaluate("window.__nativeDayTest.listeners.main['calendar://show-today-requested']({payload:{}})");
  await waitFor(
    "window.__nativeDayTest.calls.some(c=>c.name==='open_day_window'&&c.args.date==='2026-10-24')",
  );
  check(
    'return-to-today stays in the current native frontend; handoff drains pending/in-flight saves; failures preserve both views; tray routes to today owner',
  );
  assert.deepEqual(exceptions, []);
  console.log('No browser runtime exceptions. Screenshots: src-tauri/target/calendar-*.png');
  await call('Browser.close');
} finally {
  socket?.close();
  chrome.kill();
  server.close();
  // Only remove the fresh profile created by this test, after verifying its absolute temp prefix.
  if (resolve(profile).startsWith(join(resolve(tmpdir()), 'calendar-feature-test-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }).catch(() => {});
  }
}
