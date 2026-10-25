import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { cpus } from 'node:os';
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
const listener = createServer();
await new Promise((done) => listener.listen(0, '127.0.0.1', done));
const port = manifest.port || listener.address().port;
await new Promise((done) => listener.close(done));
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
const run = promisify(execFile),
  pending = new Map();
let socket,
  requestId = 0;
const report = {
  timestamp: new Date().toISOString(),
  conditions: {
    build: 'release',
    window: 'one hidden 390×900 window',
    logicalCpus: cpus().length,
    identifier: manifest.identifier,
    description:
      'New application identifier and isolated data. Native + child WebView2 processes only. Private working set is physical private pages; private commit is not resident RAM; summed working set double-counts shared pages. No foreground/GPU engine/power test.',
  },
  samples: [],
};

async function resources() {
  const script = `$ErrorActionPreference='Stop'
$entries=Get-CimInstance Win32_Process
$ownedProcessIds=@(${Number(app.pid)})
do {
  $count=$ownedProcessIds.Count
  foreach($entry in $entries){if($ownedProcessIds -contains [int]$entry.ParentProcessId -and $ownedProcessIds -notcontains [int]$entry.ProcessId){$ownedProcessIds += [int]$entry.ProcessId}}
} while($ownedProcessIds.Count -ne $count)
$running=@(Get-Process -Id $ownedProcessIds -ErrorAction SilentlyContinue)
$private=@(Get-CimInstance Win32_PerfRawData_PerfProc_Process | Where-Object { $ownedProcessIds -contains [int]$_.IDProcess })
[pscustomobject]@{cpuSeconds=($running | Measure-Object CPU -Sum).Sum;workingSet=($running | Measure-Object WorkingSet64 -Sum).Sum;privateCommit=($running | Measure-Object PrivateMemorySize64 -Sum).Sum;privateWorkingSet=($private | Measure-Object WorkingSetPrivate -Sum).Sum;processes=@($running | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64)} | ConvertTo-Json -Compress -Depth 4`;
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}

try {
  let target, lastTargets, lastError;
  for (let i = 0; i < 160; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      lastTargets = targets;
      target = targets.find((t) => t.webSocketDebuggerUrl && /tauri\.localhost|tauri:\/\//.test(t.url));
      if (target) break;
    } catch (error) {
      lastError = error.message;
    }
    if (app.exitCode !== null) throw Error('Performance app exited: ' + app.exitCode);
    await sleep(250);
  }
  if (!target) {
    console.log(JSON.stringify({ lastTargets, lastError, resources: await resources() }));
    throw Error('No isolated WebView debugging target');
  }
  report.webview = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done) => socket.addEventListener('open', done, { once: true }));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      message.error ? p.reject(Error(JSON.stringify(message.error))) : p.done(message.result);
    }
  });
  const call = (method, params = {}) =>
    new Promise((done, reject) => {
      const id = ++requestId;
      pending.set(id, { done, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const read = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 160; i++) {
      if (await read(expression)) return;
      await sleep(100);
    }
    throw Error('Timeout ' + expression);
  };
  await call('Runtime.enable');
  await wait('Boolean(window.__TAURI__?.core && document.querySelector(".day-window"))');
  const identifier = await read('window.__TAURI__.app.getIdentifier()');
  if (identifier !== manifest.identifier) throw Error('App identifier mismatch; refusing to write fixtures');
  const location = await read(
    `window.__TAURI__.core.invoke('set_storage_location',{path:${JSON.stringify(manifest.data)}})`,
  );
  const date = await read(
    "document.querySelector('.day-date-text').textContent.match(/\\d{4}-\\d{2}-\\d{2}/)[0]",
  );
  for (const count of [50, 750]) {
    const tasks = Array.from({ length: count }, (_, i) => ({
      id: `native-perf-${i}`,
      title: `隔离样本任务 ${i}`,
      status: i % 4 === 0 ? 'active' : 'completed',
      completedAt: i + 1,
      tags: [],
      children: [],
    }));
    await read(
      `(async()=>{await window.__TAURI__.core.invoke('save_day',{day:${JSON.stringify({ date, note: '隔离性能样本', tasks })},baseReminderIds:[],today:${JSON.stringify(date)}});window.dispatchEvent(new CustomEvent('calendar://storage-updated',{detail:{location:${JSON.stringify(location)}}}))})()`,
    );
    await wait(`document.querySelectorAll('.task-row').length===${count}`);
    await sleep(8000);
    await call('HeapProfiler.collectGarbage');
    const ui = await read(
      "(async()=>{const native=window.__TAURI__.window.getCurrentWindow();return {visibility:document.visibilityState,nativeVisible:await native.isVisible(),nativeFocused:await native.isFocused(),nativeMinimized:await native.isMinimized(),backgrounded:document.querySelector('.day-window').classList.contains('is-backgrounded'),tasks:document.querySelectorAll('.task-row').length,plants:document.querySelectorAll('.garden-plant').length,animations:document.querySelector('.day-header-garden').getAnimations({subtree:true}).map(a=>a.playState)}})()",
    );
    if (ui.nativeVisible || !ui.backgrounded || ui.animations.some((state) => state === 'running'))
      throw Error('Hidden native window did not suspend its background animation: ' + JSON.stringify(ui));
    const before = await resources(),
      start = performance.now();
    await sleep(3000);
    const after = await resources(),
      wall = performance.now() - start;
    const cpuCore = (((after.cpuSeconds - before.cpuSeconds) * 1000) / wall) * 100;
    const row = {
      tasks: count,
      ui,
      privateWorkingSetMiB: after.privateWorkingSet / 1048576,
      privateCommitMiB: after.privateCommit / 1048576,
      summedWorkingSetMiB: after.workingSet / 1048576,
      cpuOneCorePercent: cpuCore,
      cpuMachinePercent: cpuCore / cpus().length,
      sampleWallMs: wall,
      processes: after.processes,
    };
    report.samples.push(row);
    console.log(JSON.stringify(row));
  }
  await writeFile(
    join(root, 'src-tauri/target/perf-native-background.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log('REPORT src-tauri/target/perf-native-background.json');
} finally {
  socket?.close();
  app.kill();
  await sleep(2200);
  // Only remove the brand-new, explicitly named performance profiles; real app data is untouched.
  for (const path of profileDirs) {
    const target = resolve(path);
    if (basename(target) !== manifest.identifier) throw Error('Profile cleanup boundary mismatch');
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch((error) =>
      console.log('Profile cleanup pending: ' + error.message),
    );
  }
}
