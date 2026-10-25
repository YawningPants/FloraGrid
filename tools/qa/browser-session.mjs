import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// An isolated origin and Chrome profile, used only for project screenshots/QA.
export async function browserSession({ width = 420, height = 1000, date = '2026-10-26' } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'floragrid-preview-'));
  const server = createServer(async (request, response) => {
    const path = resolve(
      projectRoot,
      `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`,
    );
    const child = relative(projectRoot, path);
    if (child.startsWith('..') || isAbsolute(child)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response.setHeader(
        'Content-Type',
        { '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' }[
          extname(path)
        ] || 'application/octet-stream',
      );
      response.end(await readFile(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = spawn(
    process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    [
      '--headless=new',
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
    sequence = 0;
  const pending = new Map(),
    exceptions = [];
  const close = async () => {
    socket?.close();
    chrome.kill();
    server.close();
    // Only the new profile allocated above is removed, never a user browser profile.
    if (resolve(profile).startsWith(join(resolve(tmpdir()), 'floragrid-preview-')))
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => {});
  };
  try {
    const endpoint = await new Promise((done, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(Error('Chrome startup timed out')), 20000);
      chrome.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      chrome.stderr.on('data', (data) => {
        output += data;
        const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
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
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && pending.has(message.id)) {
        const promise = pending.get(message.id);
        pending.delete(message.id);
        message.error ? promise.reject(Error(JSON.stringify(message.error))) : promise.done(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    });
    const call = (method, params = {}, sessionId) =>
      new Promise((done, reject) => {
        const id = ++sequence;
        pending.set(id, { done, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    const command = (method, params = {}) => call(method, params, sessionId);
    const read = async (expression) => {
      const result = await command('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async (expression) => {
      for (let i = 0; i < 200; i++) {
        try {
          if (await read(expression)) return;
        } catch (error) {
          if (!/context|navigat/i.test(String(error))) throw error;
        }
        await sleep(40);
      }
      throw Error('Timed out: ' + expression);
    };
    const resize = (nextWidth, nextHeight) =>
      command('Emulation.setDeviceMetricsOverride', {
        width: nextWidth,
        height: nextHeight,
        deviceScaleFactor: 2,
        mobile: false,
      });
    const navigate = async (route, ready) => {
      await command('Page.navigate', { url: origin + '/src/index.html' + route });
      await wait(ready);
      await read('document.fonts.ready');
    };
    const screenshot = async (path) => {
      const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(path, Buffer.from(result.data, 'base64'));
    };
    await command('Runtime.enable');
    await command('Page.enable');
    await command('Page.bringToFront');
    await command('Page.addScriptToEvaluateOnNewDocument', {
      source: `const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[${JSON.stringify(date + 'T10:30:00+08:00')}]))}static now(){return NativeDate.parse(${JSON.stringify(date + 'T10:30:00+08:00')})}};`,
    });
    await resize(width, height);
    return { origin, command, read, wait, resize, navigate, screenshot, exceptions, close };
  } catch (error) {
    await close();
    throw error;
  }
}
