import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { browserSession, projectRoot } from '../qa/browser-session.mjs';
import { engineerScenario, scenarioDate } from './scenario.mjs';

const directory = join(projectRoot, 'docs/images');
await mkdir(directory, { recursive: true });
const browser = await browserSession({ date: scenarioDate, width: 420, height: 900 });
const { read, wait, navigate, screenshot, resize, command } = browser;
try {
  await navigate('?view=day&date=' + scenarioDate, "document.querySelector('.day-window')");
  const fixture = engineerScenario();
  await read(
    `(()=>{localStorage.clear();const fixture=${JSON.stringify(fixture)};for(const day of fixture.days)localStorage.setItem('desktop-calendar:day:'+day.date,JSON.stringify(day));localStorage.setItem('desktop-calendar:long-tasks',JSON.stringify(fixture.longTasks));localStorage.setItem('desktop-calendar:tag-templates',JSON.stringify(fixture.templates));localStorage.setItem('desktop-calendar:reminders',JSON.stringify(fixture.reminders));localStorage.setItem('desktop-calendar-theme',JSON.stringify({appearance:'botanical',surfaceStyle:'notebook',presetId:'morning',gardenEnabled:true}));})()`,
  );
  await navigate('?view=day&date=' + scenarioDate, "document.querySelector('[data-task-id=onboarding]')");
  await read("window.dispatchEvent(new Event('blur'));document.activeElement?.blur?.()");
  await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
  await screenshot(join(directory, 'day-notebook.png'));
  await read(
    "(()=>{const settings={appearance:'botanical',surfaceStyle:'glass',presetId:'morning',opacity:.94,gardenEnabled:true};localStorage.setItem('desktop-calendar-theme',JSON.stringify(settings));window.dispatchEvent(new CustomEvent('calendar://theme-updated',{detail:{settings}}))})()",
  );
  await command('Emulation.setDefaultBackgroundColorOverride', { color: { r: 23, g: 36, b: 32, a: 1 } });
  await read(
    "window.dispatchEvent(new Event('blur'));new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))",
  );
  await screenshot(join(directory, 'day-glass.png'));
  await read(
    "localStorage.setItem('desktop-calendar-theme',JSON.stringify({appearance:'botanical',surfaceStyle:'notebook',presetId:'morning',gardenEnabled:true}))",
  );
  await command('Emulation.setDefaultBackgroundColorOverride', { color: { r: 255, g: 255, b: 255, a: 1 } });
  await resize(1120, 780);
  await navigate(
    '?view=month&date=' + scenarioDate,
    "document.querySelector('.month-task-chip[data-task-id=onboarding]')",
  );
  await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
  await screenshot(join(directory, 'month.png'));
  await read("document.querySelector('.month-long-toggle').click()");
  await wait(
    "document.querySelector('.month-tools-drawer')&&!document.querySelector('.month-tools-drawer').hidden",
  );
  await screenshot(join(directory, 'long-tasks.png'));
  if (browser.exceptions.length) throw Error(JSON.stringify(browser.exceptions));
  console.log('Captured four real project views in docs/images (fictional, isolated demonstration data).');
} finally {
  await browser.close();
}
