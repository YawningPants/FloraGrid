import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { browserSession, projectRoot } from '../tools/qa/browser-session.mjs';
import { engineerScenario, scenarioDate } from '../tools/screenshots/scenario.mjs';

// All writes use a fresh browser origin/profile and fictional calendar data.
const browser = await browserSession({ width: 390, height: 800 });
const { read, wait, command, navigate, resize, screenshot } = browser;
const output = join(projectRoot, 'src-tauri/target/daily-polish');
const click = (selector) => read(`document.querySelector(${JSON.stringify(selector)}).click()`);
const row = (id) => `[data-task-id="${id}"]`;
const settle = () => read('new Promise(done=>setTimeout(done,220))');
const flush = () => read("import('/src/storage/day-storage.mjs').then(m=>m.flushDaySave())");
const setTheme = (surfaceStyle, appearance = 'botanical', presetId = 'morning') =>
  read(
    `(()=>{const settings=${JSON.stringify({ surfaceStyle, appearance, presetId, gardenEnabled: true, opacity: 0.94 })};localStorage.setItem('desktop-calendar-theme',JSON.stringify(settings));window.dispatchEvent(new CustomEvent('calendar://theme-updated',{detail:{settings}}))})()`,
  );
const style = (selector, property) =>
  read(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(property)}]`);
const pointer = async (selector, press = false) => {
  await read(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
  const point = await read(
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  if (!press) return;
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
const context = (selector) =>
  read(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)}),r=node.getBoundingClientRect();return !node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.x+20,clientY:r.y+10,button:2}))})()`,
  );
const stored = () => read(`JSON.parse(localStorage.getItem('desktop-calendar:day:${scenarioDate}'))`);
const saveTitle = async (title) => {
  await read(
    `(()=>{const input=document.querySelector('.task-title-input');input.value=${JSON.stringify(title)};input.dispatchEvent(new Event('input',{bubbles:true}));input.blur()})()`,
  );
  await wait("!document.querySelector('.task-title-input')");
  await flush();
};
const check = (text) => console.log('PASS ' + text);

try {
  await mkdir(output, { recursive: true });
  await navigate('?view=day&date=' + scenarioDate, "document.querySelector('.day-window')");
  const fixture = engineerScenario();
  await read(
    `(()=>{localStorage.clear();const f=${JSON.stringify(fixture)};for(const day of f.days)localStorage.setItem('desktop-calendar:day:'+day.date,JSON.stringify(day));localStorage.setItem('desktop-calendar:long-tasks',JSON.stringify(f.longTasks));localStorage.setItem('desktop-calendar:tag-templates',JSON.stringify(f.templates))})()`,
  );
  await navigate('?view=day&date=' + scenarioDate, "document.querySelector('[data-task-id=refund-design]')");
  assert.equal(await read("document.querySelector('.note-toggle').getAttribute('aria-expanded')"), 'false');
  assert.ok(await read("document.querySelector('.daily-notes').offsetHeight<=42"));
  assert.ok(
    await read("document.querySelector('.note-content').inert && !document.querySelector('.note-presence')"),
  );
  await screenshot(join(output, 'paper-collapsed.png'));
  await pointer('.note-toggle', true);
  await settle();
  assert.ok(
    await read(
      "document.querySelector('.daily-notes').offsetHeight>150 && !document.querySelector('.note-content').inert",
    ),
  );
  await read(
    "(()=>{const e=document.querySelector('.note-editor');e.focus();e.value='折叠也要保留未保存的想法';e.dispatchEvent(new Event('input',{bubbles:true}))})()",
  );
  await pointer('.note-toggle', true);
  await settle();
  await flush();
  assert.equal((await stored()).note, '折叠也要保留未保存的想法');
  await navigate('?view=day&date=' + scenarioDate, "document.querySelector('[data-task-id=refund-design]')");
  assert.equal(await read("document.querySelector('.note-toggle').getAttribute('aria-expanded')"), 'false');
  assert.equal(await read("document.querySelector('.note-editor').value"), '折叠也要保留未保存的想法');
  // Global search uses this navigation protocol when reusing an open day window.
  await read("location.hash='day?note=1'");
  await wait("document.querySelector('.note-toggle[aria-expanded=true]')");
  await navigate(
    '?view=day&date=' + scenarioDate + '&note=1',
    "document.querySelector('.note-toggle[aria-expanded=true]')",
  );
  await settle();
  await screenshot(join(output, 'paper-expanded.png'));
  check('notes collapse to one row by default; draft saves survive collapse/reload; search opens the note');

  for (const selector of ['.window-titlebar', '.day-toolbar', '.note-editor', '.task-list'])
    assert.ok(await context(selector), selector);
  assert.ok(await context(row('refund-design')));
  assert.ok(
    await read(
      "[...document.querySelectorAll('.task-context-menu-item')].some(e=>e.textContent.includes('复制'))",
    ),
  );
  await read("document.querySelector('.task-context-menu').remove()");
  check('fallback context menus cancelled in chrome, empty space and editors; custom task menu still opens');

  await pointer(row('refund-design') + ' .child', true);
  await saveTitle('自动继承父任务的蓝色');
  let day = await stored();
  const parent = day.tasks.find((t) => t.id === 'refund-design');
  const child = parent.children.find((t) => t.title === '自动继承父任务的蓝色');
  assert.equal(child.color, parent.color);
  await pointer(row(child.id) + ' .task-color-button', true);
  await click('.task-color-choice[aria-label="设为柔粉"]');
  await pointer(row(child.id) + ' .child', true);
  await saveTitle('孙任务继承当前粉色');
  day = await stored();
  const changed = day.tasks.find((t) => t.id === 'refund-design');
  const changedChild = changed.children.find((t) => t.id === child.id);
  assert.equal(changed.color, '#8fb6d3');
  assert.equal(changedChild.color, '#d09aac');
  assert.equal(changedChild.children[0].color, '#d09aac');
  check(
    'child creation snapshots parent color, child override stays independent, nested creation inherits the new color',
  );

  for (const appearance of ['botanical', 'minimal']) {
    await setTheme('glass', appearance);
    await command('Emulation.setDefaultBackgroundColorOverride', { color: { r: 23, g: 36, b: 32, a: 1 } });
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    await read('document.activeElement?.blur()');
    await settle();
    assert.notEqual(await style(row('refund-design') + ' .task-color-button', 'display'), 'none');
    assert.equal(await style(row('refund-design') + ' .task-color-button', 'opacity'), '0');
    await pointer(row('refund-design'));
    await settle();
    assert.equal(await style(row('refund-design') + ' .task-color-button', 'opacity'), '1');
    await pointer(row('refund-design') + ' .task-color-button', true);
    await wait("document.querySelector('.task-color-palette')");
    await click('.task-color-choice[aria-label="设为浅蓝"]');
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    await settle();
    assert.equal(await style(row('refund-design') + ' .task-color-button', 'opacity'), '0');
    const textColor = await style(row('refund-design') + ' .task-title', 'color');
    assert.notEqual(textColor, await style('.day-window', 'color'));
    assert.ok(await context(row('refund-design')));
    await read(
      "[...document.querySelectorAll('.task-context-menu-item')].find(e=>e.textContent.includes('任务颜色')).click()",
    );
    await click('.task-color-choice[aria-label="设为草绿"]');
    await flush();
    assert.equal((await stored()).tasks.find((t) => t.id === 'refund-design').color, '#99b888');
    await context(row('refund-design'));
    await read(
      "[...document.querySelectorAll('.task-context-menu-item')].find(e=>e.textContent.includes('任务颜色')).click()",
    );
    await click('.task-color-choice[aria-label="设为浅蓝"]');
    await screenshot(join(output, `glass-${appearance}.png`));
  }
  check(
    'both glass appearances show the root color button on hover, hide it on leave, and keep context-menu colors',
  );

  for (const appearance of ['botanical', 'minimal']) {
    for (const preset of ['morning', 'mist', 'apricot', 'sage', 'rose']) {
      await setTheme('notebook', appearance, preset);
      await pointer('.add-root');
      await settle();
      assert.equal(await style('.add-root', 'backgroundImage'), 'none');
      assert.ok(!(await style('.add-root', 'backgroundColor')).includes(' / '));
      assert.equal(await style(row('refund-design') + ' .status-button', 'boxShadow'), 'none');
      assert.equal(await style(row('refund-design') + ' .task-row-controls', 'backgroundImage'), 'none');
      await pointer(row('refund-design') + ' .status-button');
      await settle();
      assert.equal(await style(row('refund-design') + ' .status-button', 'boxShadow'), 'none');
    }
    await setTheme('notebook', appearance);
    await command('Emulation.setDefaultBackgroundColorOverride', { color: { r: 255, g: 255, b: 255, a: 1 } });
    await screenshot(join(output, `paper-${appearance}.png`));
  }
  check('five paper palettes in both task appearances: flat new-task button, no status-circle glow');

  await flush();
  await resize(1120, 780);
  await navigate('?view=month&date=' + scenarioDate, "document.querySelector('.month-day-cell.is-today')");
  for (const appearance of ['botanical', 'minimal']) {
    await setTheme('notebook', appearance);
    await pointer('.month-day-cell.is-today');
    await settle();
    assert.equal(await style('.month-day-cell.is-today', 'boxShadow'), 'none');
    assert.equal(await style('.month-day-cell.is-today', 'backgroundImage'), 'none');
    await pointer('.month-day-cell:not(.is-today):not(.is-outside)');
    await settle();
    assert.equal(await style('.month-day-cell:not(.is-today):not(.is-outside):hover', 'boxShadow'), 'none');
    await screenshot(join(output, `month-${appearance}.png`));
  }
  await click('.month-long-toggle');
  await wait("document.querySelector('.month-tools-drawer:not([hidden])')");
  await pointer('.month-tools-drawer .workspace-primary');
  await settle();
  assert.equal(await style('.month-tools-drawer .workspace-primary', 'backgroundImage'), 'none');
  await screenshot(join(output, 'long-tasks.png'));
  await click('.month-tools-drawer .workspace-primary');
  await wait("document.querySelector('.long-task-title-input')");
  assert.equal(await style('.long-task-title-input', 'boxShadow'), 'none');
  assert.equal(await style('.long-task-title-input', 'backgroundImage'), 'none');
  check('paper calendar today/hover and long-task add/editor use paper controls');

  await resize(780, 650);
  await navigate('?view=settings&tab=theme', "document.querySelector('.appearance-option')");
  await pointer('.theme-preset');
  await settle();
  assert.equal(await style('.theme-preset', 'boxShadow'), 'none');
  assert.equal(await style('.theme-preset', 'backgroundImage'), 'none');
  await screenshot(join(output, 'settings.png'));
  await click('[data-settings-tab=tags]');
  await wait("document.querySelector('.tag-manager-new-button')");
  await pointer('.tag-manager-new-button');
  await settle();
  assert.equal(await style('.tag-manager-new-button', 'backgroundImage'), 'none');
  assert.ok(await context('.settings-header'));
  await screenshot(join(output, 'settings-tags.png'));
  assert.deepEqual(browser.exceptions, []);
  check('settings palette hover, long-tag buttons and context menu guard; no renderer exceptions');
  console.log('Screenshots: ' + output);
} finally {
  await browser.close();
}
