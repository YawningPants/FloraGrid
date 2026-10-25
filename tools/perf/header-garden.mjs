import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same app and fixtures, with an HTTP-only stub for the off baseline. No production
// flag, real calendar data, user Chrome profile, or application settings are changed.
const root = fileURLToPath(new URL('../..', import.meta.url));
const optimized = process.argv.includes('--optimized');
const layered = process.argv.includes('--layers');
const output = join(
  root,
  `src-tauri/target/perf-header-garden${layered ? '-layered' : optimized ? '-optimized' : ''}.json`,
);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const p95 = (values) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * 0.95))];
let mode = 'sway';
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const path = resolve(root, `.${pathname}`);
  if (!path.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  if (pathname === '/src/domain/header-garden.mjs' && mode === 'bounded') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(
      (await readFile(path, 'utf8')).replace(
        'return width < 360 ? 10 : width < 520 ? 14 : 18;',
        'return width < 360 ? 6 : width < 520 ? 8 : 12;',
      ),
    );
    return;
  }
  if (pathname === '/src/ui/header-garden.mjs' && mode === 'off') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end('export function createHeaderGarden(){return {update(){},pause(){},destroy(){}}}');
    return;
  }
  try {
    const source = await readFile(path);
    res.setHeader(
      'Content-Type',
      { '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' }[
        extname(path)
      ] || 'application/octet-stream',
    );
    res.end(source);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'rizhi-garden-perf-'));
const chrome = spawn(
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  [
    '--headless=new',
    '--no-first-run',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=BackForwardCache',
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
const report = {
  timestamp: new Date().toISOString(),
  conditions: {
    logicalCpus: cpus().length,
    deviceScaleFactor: 2,
    viewports: [
      [390, 900],
      [600, 900],
    ],
    warmupMs: 8000,
    backForwardCache: false,
    idleSamples: 2,
    idleSampleMs: 3000,
    completionSamples: 4,
    completionWindowMs: 1600,
    description:
      'Isolated Chrome executing the real app. Off stubs only the garden controller; static disables only its sway in test CSS. Process CPU includes browser/renderer/GPU-process CPU, not GPU engine utilization. JS heap is not native app RAM. Idle samples do not use RAF probes; RAF is sampled separately. Order alternates to reduce warm-up bias. No native app is running.',
  },
  scenarios: [],
};

try {
  const endpoint = await new Promise((done, reject) => {
    let text = '';
    const timeout = setTimeout(() => reject(Error(text)), 20000);
    chrome.once('error', reject);
    chrome.stderr.on('data', (data) => {
      text += data;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
      if (match) {
        clearTimeout(timeout);
        done(match[1]);
      }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((done) => socket.addEventListener('open', done, { once: true }));
  socket.addEventListener('message', (event) => {
    const result = JSON.parse(event.data);
    if (result.id && pending.has(result.id)) {
      const item = pending.get(result.id);
      pending.delete(result.id);
      result.error ? item.reject(Error(JSON.stringify(result.error))) : item.done(result.result);
    }
    if (result.method === 'Runtime.exceptionThrown') exceptions.push(result.params.exceptionDetails);
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((done, reject) => {
      const request = ++id;
      pending.set(request, { done, reject });
      socket.send(JSON.stringify({ id: request, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  report.browser = await call('Browser.getVersion');
  const info = await call('SystemInfo.getInfo');
  report.gpu = info.gpu.devices;
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' }),
    { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params = {}) => call(method, params, sessionId);
  const read = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 240; i++) {
      try {
        if (await read(expression)) return;
      } catch (error) {
        if (!/context|navigated/i.test(error.message)) throw error;
      }
      await sleep(25);
    }
    throw Error('Timeout ' + expression);
  };
  const metrics = async () =>
    Object.fromEntries(
      (await command('Performance.getMetrics')).metrics.map((item) => [item.name, item.value]),
    );
  const processes = async () =>
    new Map(
      (await call('SystemInfo.getProcessInfo')).processInfo.map((item) => [
        item.id,
        { time: item.cpuTime, type: item.type },
      ]),
    );
  const idle = async () => {
    const before = await metrics(),
      cpuBefore = await processes(),
      start = performance.now();
    await sleep(3000);
    const after = await metrics(),
      cpuAfter = await processes(),
      wall = performance.now() - start;
    const byProcessType = {};
    for (const [pid, item] of cpuAfter) {
      const delta = Math.max(0, item.time - (cpuBefore.get(pid)?.time ?? item.time)) * 1000;
      byProcessType[item.type] = (byProcessType[item.type] || 0) + delta;
    }
    const cpuMs = Object.values(byProcessType).reduce((sum, time) => sum + time, 0);
    return {
      wallMs: wall,
      mainThreadTaskMs: (after.TaskDuration - before.TaskDuration) * 1000,
      scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
      styleLayoutMs:
        (after.LayoutDuration -
          before.LayoutDuration +
          (after.RecalcStyleDuration - before.RecalcStyleDuration)) *
        1000,
      processCpuMs: cpuMs,
      cpuMsByProcessType: byProcessType,
      processCpuOneCorePercent: (cpuMs / wall) * 100,
      processCpuMachinePercent: ((cpuMs / wall) * 100) / cpus().length,
    };
  };
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Performance.enable');
  await command('Network.enable');
  await command('Network.setCacheDisabled', { cacheDisabled: true });
  await command('Page.bringToFront');
  await command('Page.navigate', { url: origin + '/src/index.html?view=day&date=2026-10-25' });
  await wait("document.querySelector('.day-window')");
  await sleep(8000); // Exclude browser startup, font and shader warm-up from the first baseline.

  function fixture(count) {
    const make = (i, status = 'active') => ({
      id: `perf-${i}`,
      title: `样本任务 ${i}：读书、整理和日常安排`,
      status,
      tags: i % 5 === 0 ? [{ id: `tag-${i}`, text: '日常', color: '#a8be9e' }] : [],
      completedAt: status === 'completed' ? i + 1 : undefined,
      children: [],
    });
    const tasks = Array.from({ length: 12 }, (_, i) => make(i));
    let i = 12;
    while (i < count) {
      const completed = i % 10 < 6,
        task = make(i++, completed ? 'completed' : i % 10 === 8 ? 'failed' : 'active');
      if (i + 2 <= count && i % 4 === 0) {
        task.status = completed ? 'completed' : 'active';
        task.children = [
          make(i++, completed ? 'completed' : 'active'),
          make(i++, completed ? 'completed' : 'completed'),
        ];
      }
      tasks.push(task);
    }
    return { date: '2026-10-25', note: '隔离性能样本', tasks };
  }
  async function load(count, nextMode, width = 390) {
    await read(
      "(async()=>{const {flushDaySave}=await import('/src/storage/day-storage.mjs');await flushDaySave()})()",
    );
    await read(
      `localStorage.clear();localStorage.setItem('desktop-calendar-theme',JSON.stringify({presetId:'morning',appearance:'botanical',completionMotion:true,gardenEnabled:true,surfaceStyle:'glass',opacity:.9}));localStorage.setItem('desktop-calendar:day:2026-10-25',JSON.stringify(${JSON.stringify(fixture(count))}))`,
    );
    mode = nextMode;
    await command('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const previous = await read('performance.timeOrigin');
    await command('Page.reload', { ignoreCache: true });
    await wait(
      `performance.timeOrigin!==${previous} && document.querySelectorAll('.task-row').length===${count} && ${nextMode === 'off' ? '!document.querySelector(".day-header-garden")' : 'Number(document.querySelector(".day-header-garden")?.dataset.visible)>0'}`,
    );
    if (nextMode === 'static')
      await read(
        "(()=>{const s=document.createElement('style');s.textContent='.garden-sway-group{animation:none!important}';document.head.append(s)})()",
      );
    await read("window.dispatchEvent(new Event('focus'))");
    await sleep(1300);
  }
  const frameSample = async (trigger = '') =>
    read(
      `new Promise(done=>{const values=[];let last;const start=performance.now();function frame(time){if(last)values.push(time-last);last=time;if(time-start<1600)requestAnimationFrame(frame);else done(values)}requestAnimationFrame(frame);${trigger}})`,
    );
  const click =
    "(()=>{const button=document.querySelector('.task-row.is-active:not(.has-children) .status-button.active');if(!button)throw Error('No eligible task');const before=document.querySelectorAll('.task-row.is-completed').length;const start=performance.now();button.click();document.body.getBoundingClientRect();window.__clickMs=performance.now()-start;if(document.querySelectorAll('.task-row.is-completed').length!==before+1)throw Error('Completion guard hit')})();";
  for (const count of layered ? [50, 750] : [50, 300, 750])
    for (const nextMode of layered
      ? count === 50
        ? ['sway']
        : ['bounded', 'static', 'sway']
      : optimized
        ? ['sway']
        : count === 300
          ? ['sway', 'static', 'off']
          : ['off', 'static', 'sway']) {
      await load(count, nextMode);
      const row = { tasks: count, mode: nextMode, width: 390 };
      row.idle = [];
      for (let i = 0; i < 2; i++) row.idle.push(await idle());
      await command('HeapProfiler.collectGarbage');
      const heap = await metrics();
      Object.assign(
        row,
        await read(
          "({domElements:document.querySelectorAll('*').length,gardenElements:document.querySelector('.day-header-garden')?.querySelectorAll('*').length||0,plants:document.querySelectorAll('.garden-plant').length,animations:document.querySelector('.day-header-garden')?.getAnimations({subtree:true}).length||0})",
        ),
      );
      row.jsHeapMiB = heap.JSHeapUsedSize / 1048576;
      row.domCounters = await command('Memory.getDOMCounters');
      const frames = await frameSample();
      row.idleFrames = {
        p95Ms: p95(frames),
        over25ms: frames.filter((t) => t > 25).length,
        count: frames.length,
      };
      row.completions = [];
      if (nextMode !== 'static') {
        await frameSample(click); // Warm one actual complete/bloom/reorder cycle.
        for (let i = 0; i < 4; i++) {
          const before = await metrics(),
            intervals = await frameSample(click),
            after = await metrics();
          row.completions.push({
            syncMs: await read('window.__clickMs'),
            taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
            scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
            styleLayoutMs:
              (after.LayoutDuration -
                before.LayoutDuration +
                (after.RecalcStyleDuration - before.RecalcStyleDuration)) *
              1000,
            p95FrameMs: p95(intervals),
            framesOver25ms: intervals.filter((t) => t > 25).length,
          });
        }
        const before = await metrics();
        row.burstFrames = await frameSample(
          `let clicks=0;const burst=setInterval(()=>{${click}if(++clicks===6)clearInterval(burst)},70);`,
        );
        const after = await metrics();
        row.burst = {
          taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
          p95FrameMs: p95(row.burstFrames),
          framesOver25ms: row.burstFrames.filter((t) => t > 25).length,
          plants: await read("document.querySelectorAll('.garden-plant').length"),
        };
        if (count === 750 && nextMode === 'sway') {
          await read("window.dispatchEvent(new Event('blur'))");
          await sleep(100);
          row.pausedIdle = await idle();
          await read("window.dispatchEvent(new Event('focus'))");
        }
      }
      row.summary = {
        idleTaskMsPerSecond: median(row.idle.map((s) => (s.mainThreadTaskMs / s.wallMs) * 1000)),
        processCpuOneCorePercent: median(row.idle.map((s) => s.processCpuOneCorePercent)),
        processCpuMachinePercent: median(row.idle.map((s) => s.processCpuMachinePercent)),
        renderGpuCpuOneCorePercent: median(
          row.idle.map(
            (s) =>
              (((s.cpuMsByProcessType.renderer || 0) + (s.cpuMsByProcessType.GPU || 0)) / s.wallMs) * 100,
          ),
        ),
        clickMedianMs: row.completions.length ? median(row.completions.map((s) => s.syncMs)) : null,
        completionTaskMedianMs: row.completions.length ? median(row.completions.map((s) => s.taskMs)) : null,
      };
      report.scenarios.push(row);
      console.log(
        JSON.stringify({
          tasks: count,
          mode: nextMode,
          ...row.summary,
          heapMiB: row.jsHeapMiB,
          gardenElements: row.gardenElements,
        }),
      );
      await mkdir(join(root, 'src-tauri/target'), { recursive: true });
      await writeFile(output, JSON.stringify(report, null, 2));
    }
  await load(750, 'sway', 600);
  report.wide = {
    tasks: 750,
    width: 600,
    idle: await idle(),
    gardenElements: await read("document.querySelector('.day-header-garden').querySelectorAll('*').length"),
    plants: await read("document.querySelectorAll('.garden-plant').length"),
  };
  report.layeredComparison = layered
    ? 'Bounded uses the same two-layer renderer at the old 6/8/12 limits, to isolate the extra flowers; not a historical build. New sway uses 10/14/18.'
    : null;
  report.exceptions = exceptions;
  await writeFile(output, JSON.stringify(report, null, 2));
  if (exceptions.length) throw Error('Runtime errors: ' + JSON.stringify(exceptions));
  console.log('REPORT ' + output);
  await call('Browser.close');
} finally {
  socket?.close();
  chrome.kill();
  server.close();
  if (resolve(profile).startsWith(join(resolve(tmpdir()), 'rizhi-garden-perf-')))
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => {});
}
