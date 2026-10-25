import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const manifest = JSON.parse(
  (await readFile(join(root, 'src-tauri/target/native-perf/manifest.json'), 'utf8')).replace(/^\uFEFF/, ''),
);
if (!/^com\.rizhi\.perf[a-f0-9]{12}$/.test(manifest.identifier))
  throw Error('Expected an isolated performance identifier');
const profileDirs = [
  join(process.env.APPDATA, manifest.identifier),
  join(process.env.LOCALAPPDATA, manifest.identifier),
];
for (const path of profileDirs)
  if (await stat(path).catch(() => null)) throw Error('Refusing to reuse an existing profile: ' + path);
await mkdir(manifest.data, { recursive: true });
const port = manifest.port;
const app = spawn(manifest.exe, [], {
  cwd: root,
  windowsHide: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-background-networking`,
  },
});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const connections = [];
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done) => ws.addEventListener('open', done, { once: true }));
  connections.push(ws);
  let next = 0;
  const requests = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && requests.has(message.id)) {
      const p = requests.get(message.id);
      requests.delete(message.id);
      message.error ? p.reject(Error(JSON.stringify(message.error))) : p.done(message.result);
    }
  });
  const call = (method, params = {}) =>
    new Promise((done, reject) => {
      const id = ++next;
      requests.set(id, { done, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const read = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 160; i++) {
      if (await read(expression)) return;
      await sleep(50);
    }
    throw Error('Timeout ' + expression);
  };
  await call('Runtime.enable');
  return { read, wait, call };
}
try {
  let targets = [];
  for (let i = 0; i < 160; i++) {
    try {
      targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(
        (t) => t.webSocketDebuggerUrl && /tauri\.localhost|tauri:\/\//.test(t.url),
      );
      if (targets.length === 3) break;
    } catch {}
    if (app.exitCode !== null) throw Error('Test app exited');
    await sleep(100);
  }
  if (targets.length !== 3)
    throw Error('Build with -DataTransfer to create three hidden test windows: ' + JSON.stringify(targets));
  const day = await connect(targets.find((t) => !t.url.includes('#'))),
    month = await connect(targets.find((t) => t.url.includes('#month'))),
    settings = await connect(targets.find((t) => t.url.includes('#settings')));
  await day.wait('Boolean(window.__TAURI__?.core && document.querySelector(".day-window"))');
  await month.wait('Boolean(document.querySelector(".month-window"))');
  await settings.wait('Boolean(document.querySelector(".data-settings"))');
  for (const client of [day, month, settings]) {
    const actual = await client.read('window.__TAURI__.app.getIdentifier()');
    if (actual !== manifest.identifier) throw Error('Wrong identifier; refusing fixture writes');
    if (await client.read('window.__TAURI__.window.getCurrentWindow().isVisible()'))
      throw Error('QA windows must stay hidden');
  }
  const sandbox = join(root, 'src-tauri/target/native-perf', `transfer-${Date.now()}`),
    source = join(sandbox, 'source'),
    destination = join(sandbox, 'target');
  await mkdir(source, { recursive: true });
  await mkdir(destination, { recursive: true });
  const location = await day.read(
    `window.__TAURI__.core.invoke('set_storage_location',{path:${JSON.stringify(source)}})`,
  );
  const date = await day.read(
    "document.querySelector('.day-date-text').textContent.match(/\\d{4}-\\d{2}-\\d{2}/)[0]",
  );
  const tasks = [
    {
      id: 'native-root',
      title: '隔离备份任务',
      status: 'active',
      color: '#a8be9e',
      tags: [{ id: 'tag', text: '保留标签', color: '#9cbfd0' }],
      children: [
        {
          id: 'native-child',
          title: '保留子任务',
          status: 'completed',
          flower: { variant: 'cosmos', tone: 'rose' },
          tags: [],
          children: [],
        },
      ],
    },
  ];
  await day.read(
    `(async()=>{await window.__TAURI__.core.invoke('save_day',{day:${JSON.stringify({ date, note: 'before', tasks })},baseReminderIds:[],today:${JSON.stringify(date)}});await window.__TAURI__.core.invoke('save_long_tasks',{tasks:{version:1,tasks:[{id:'long',title:'长期任务',status:'active',tags:[],children:[]}]}});await window.__TAURI__.core.invoke('save_tag_templates',{templates:{version:1,groups:[{id:'g',name:'生活',tags:[{id:'tag',text:'保留标签',color:'#9cbfd0'}]}]}});await window.__TAURI__.event.emit('calendar://storage-updated',{location:${JSON.stringify(location)}})})()`,
  );
  await day.wait("Boolean(document.querySelector('[data-task-id=native-child]'))");
  await month.wait("Boolean(document.querySelector('.long-task-item'))");
  await sleep(200);
  const archivePath = join(sandbox, 'export.json');
  await day.read(
    "(()=>{const note=document.querySelector('.note-editor');note.value='尚未到自动保存时间的随笔';note.dispatchEvent(new Event('input',{bubbles:true}))})()",
  );
  const transfer = (request) =>
    settings.read(
      `(async()=>{const {transferData}=await import('./storage/data-transfer.mjs');return transferData(${JSON.stringify(request)},payload=>{window.__lastProgress=payload})})()`,
    );
  await transfer({ kind: 'export', path: archivePath });
  const backup = JSON.parse(await readFile(archivePath, 'utf8'));
  const exportedDay = backup.files.find((file) => file.name.endsWith(`${date}.json`));
  if (
    exportedDay.data.note !== '尚未到自动保存时间的随笔' ||
    exportedDay.data.tasks[0].children[0].flower.variant !== 'cosmos'
  )
    throw Error('Pending input/metadata lost during export');
  if (
    !backup.files.some((f) => f.name === 'tag-templates.json') ||
    !backup.files.some((f) => f.name === 'long-tasks.json')
  )
    throw Error('Missing libraries');
  console.log(
    'PASS native export flushes another hidden day window, preserves nested metadata and both libraries',
  );
  const dayPath = join(source, ...exportedDay.name.split('/'));
  const modified = structuredClone(backup);
  modified.files.find((f) => f.name === exportedDay.name).data.note = '从备份恢复';
  const importPath = join(sandbox, 'import.json');
  await writeFile(importPath, JSON.stringify(modified));
  const summary = await settings.read(
    `window.__TAURI__.core.invoke('preview_backup_file',{path:${JSON.stringify(importPath)}})`,
  );
  const restored = await transfer({ kind: 'import', path: importPath, fingerprint: summary.fingerprint });
  await day.wait("document.querySelector('.note-editor').value==='从备份恢复'");
  if (!restored.backupPath || !(await stat(restored.backupPath))) throw Error('No pre-import safety backup');
  if (JSON.parse(await readFile(dayPath, 'utf8')).note !== '从备份恢复')
    throw Error('Import did not replace persisted data');
  await writeFile(importPath, JSON.stringify({ ...modified, version: 2 }));
  let invalid = false;
  try {
    await settings.read(
      `window.__TAURI__.core.invoke('preview_backup_file',{path:${JSON.stringify(importPath)}})`,
    );
  } catch {
    invalid = true;
  }
  if (!invalid) throw Error('Invalid archive accepted');
  console.log(
    'PASS native import safety copy, replacement, live window refresh and incompatible version rejection',
  );
  // Target collision + unrelated file: source wins same date; other target dates remain.
  const targetDay = join(destination, ...exportedDay.name.split('/'));
  await mkdir(resolve(targetDay, '..'), { recursive: true });
  await writeFile(targetDay, JSON.stringify({ ...exportedDay.data, note: '目标中的旧内容' }));
  await mkdir(join(destination, 'days/2026/01'), { recursive: true });
  await writeFile(
    join(destination, 'days/2026/01/2026-01-02.json'),
    JSON.stringify({ date: '2026-01-02', note: '目标独有日程', tasks: [] }),
  );
  await writeFile(join(destination, 'unrelated.txt'), 'keep');
  const info = await settings.read(
    `window.__TAURI__.core.invoke('inspect_storage_target',{path:${JSON.stringify(destination)}})`,
  );
  if (info.empty || info.files !== 2) throw Error('Nonempty target inspection wrong');
  const moved = await transfer({ kind: 'move', path: destination, targetStamp: info.stamp, migrate: true });
  await day.wait('!window.calendarDataTransferBusy');
  await month.wait('!window.calendarDataTransferBusy');
  if (
    JSON.parse(await readFile(targetDay, 'utf8')).note !== '从备份恢复' ||
    !(await stat(dayPath)) ||
    (await readFile(join(destination, 'unrelated.txt'), 'utf8')) !== 'keep'
  )
    throw Error('Migration collision/preservation failed');
  if (!moved.cleanupToken || !moved.backupPath) throw Error('No verified cleanup receipt/safety backup');
  if (!(await stat(join(destination, 'days/2026/01/2026-01-02.json')))) throw Error('Target-only date lost');
  console.log(
    'PASS native migration into nonempty target, same-date precedence, target backup, original retention and unrelated-file preservation',
  );
  // Changed original invalidates the entire cleanup before any source file is removed.
  const original = JSON.parse(await readFile(dayPath, 'utf8'));
  await writeFile(dayPath, JSON.stringify({ ...original, note: '外部更新' }));
  let refused = false;
  try {
    await transfer({ kind: 'cleanup', token: moved.cleanupToken });
  } catch {
    refused = true;
  }
  if (!refused || !(await stat(join(source, 'long-tasks.json'))))
    throw Error('Changed source was not protected');
  await writeFile(dayPath, JSON.stringify(original));
  const cleaned = await transfer({ kind: 'cleanup', token: moved.cleanupToken });
  if (cleaned.deleted < 3 || (await stat(dayPath).catch(() => null)))
    throw Error('Verified source files were not cleaned');
  if (
    !(await stat(source)) ||
    !(await stat(targetDay)) ||
    (await readFile(join(destination, 'unrelated.txt'), 'utf8')) !== 'keep'
  )
    throw Error('Cleanup boundary failed');
  console.log(
    'PASS changed-source cleanup refused atomically; explicit cleanup removes only verified originals and keeps the folder',
  );
  for (const client of [day, month])
    if (await client.read('document.querySelector("#app > section").inert')) throw Error('Window left inert');
  await writeFile(
    join(root, 'src-tauri/target/data-transfer-native-report.json'),
    JSON.stringify(
      {
        identifier: manifest.identifier,
        windows: 3,
        hidden: true,
        checks: [
          'pending-save export',
          'nested metadata',
          'backup validation',
          'safe import',
          'live refresh',
          'nonempty target',
          'migration conflict',
          'safety backups',
          'source retention',
          'changed-source cleanup rejection',
          'whitelist cleanup',
        ],
        sandbox,
      },
      null,
      2,
    ),
  );
} finally {
  connections.forEach((ws) => ws.close());
  app.kill();
  await sleep(2200);
  for (const path of profileDirs) {
    const target = resolve(path);
    if (basename(target) !== manifest.identifier) throw Error('Cleanup boundary mismatch');
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch((error) =>
      console.log('Profile cleanup pending: ' + error.message),
    );
  }
}
