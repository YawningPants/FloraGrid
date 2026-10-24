import { cubicPoint, taskBranchGeometry } from '../domain/plant-geometry.mjs';

const svgNamespace = 'http://www.w3.org/2000/svg';
const point = n => Math.round(n * 10) / 10;
const painted = new WeakMap();

function paint(host, className, width, height, markup) {
  let svg = host.querySelector(`:scope > .${className}`);
  if (!svg) {
    svg = document.createElementNS(svgNamespace, 'svg');
    svg.classList.add(className);
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    host.prepend(svg);
  }
  const box = `0 0 ${point(width)} ${point(height)}`;
  if (svg.getAttribute('viewBox') !== box) svg.setAttribute('viewBox', box);
  if (svg.style.height !== `${point(height)}px`) svg.style.height = `${point(height)}px`;
  if (painted.get(svg) !== markup) { svg.innerHTML = markup; painted.set(svg, markup); }
}

// Measure before writing SVG, so curves never cause a read/write loop per task.
function layoutOffset(element, host) {
  let x = 0, y = 0, current = element;
  while (current && current !== host) {
    x += current.offsetLeft; y += current.offsetTop; current = current.offsetParent;
  }
  return { x, y };
}

function curvePath([a, b, c, d]) {
  return `M${point(a.x)} ${point(a.y)}C${point(b.x)} ${point(b.y)} ${point(c.x)} ${point(c.y)} ${point(d.x)} ${point(d.y)}`;
}

export function measureTaskPlant(children) {
  if (document.documentElement.dataset.appearance !== 'botanical') return null;
  const host = children.parentElement;
  const nodes = [...children.querySelectorAll(':scope > .task-node')];
  if (!nodes.length || children.matches('.is-collapsed:not(.is-animating)')) return { host, empty: true };
  const parent = host.querySelector(':scope > .task-row .status-button');
  if (!parent) return { host, empty: true };
  const origin = layoutOffset(parent, host);
  const anchor = { x: origin.x + parent.offsetWidth / 2, y: origin.y + parent.offsetHeight - 2 };
  const leaves = nodes.map(node => {
    const button = node.querySelector(':scope > .task-row .status-button');
    if (!button) return null;
    const offset = layoutOffset(button, host);
    return { id: button.closest('.task-row').dataset.taskId, x: offset.x + 1, y: offset.y + button.offsetHeight * .65 };
  }).filter(Boolean);
  const geometry = taskBranchGeometry(anchor, leaves);
  if (!geometry) return { host, empty: true };
  const bottom = layoutOffset(children, host).y + nodes.at(-1).offsetTop + nodes.at(-1).offsetHeight;
  return { host, width: Math.max(1, host.clientWidth), height: Math.max(host.clientHeight, bottom, 1),
    paths: [{ key: 'trunk', className: 'plant-trunk', d: curvePath(geometry.curve) },
      ...geometry.forks.map(fork => ({ key: `fork:${fork.id}`, className: 'plant-fork', d: curvePath(fork.curve) }))] };
}

export function paintTaskPlant(layout) {
  if (!layout) return;
  const { host } = layout;
  let svg = host.querySelector(':scope > .task-plant-branches');
  if (layout.empty) { svg?.remove(); return; }
  if (!svg) {
    svg = document.createElementNS(svgNamespace, 'svg'); svg.classList.add('task-plant-branches');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    svg.setAttribute('preserveAspectRatio', 'xMinYMin slice'); host.prepend(svg);
  }
  const box = `0 0 ${layout.width} ${layout.height}`;
  if (svg.getAttribute('viewBox') !== box) svg.setAttribute('viewBox', box);
  const existing = new Map([...svg.children].map(path => [path.dataset.branchKey, path]));
  const wanted = new Set(layout.paths.map(path => path.key));
  existing.forEach((path, key) => { if (!wanted.has(key)) path.remove(); });
  let cursor = svg.firstElementChild;
  layout.paths.forEach(item => {
    let path = existing.get(item.key);
    if (!path) { path = document.createElementNS(svgNamespace, 'path'); path.dataset.branchKey = item.key; path.setAttribute('class', item.className); }
    if (path.getAttribute('d') !== item.d) {
      path.setAttribute('d', item.d); path.style.d = `path("${item.d}")`;
    }
    if (path !== cursor) svg.insertBefore(path, cursor);
    cursor = path.nextElementSibling;
  });
}

let monthFrame = 0;
export function queueMonthPlant(grid) {
  cancelAnimationFrame(monthFrame);
  monthFrame = requestAnimationFrame(() => {
    monthFrame = 0;
    if (!grid?.isConnected || !grid.clientWidth || document.documentElement.dataset.appearance !== 'botanical') return;
    drawMonthPlant(grid);
  });
}

function decorativeLeaf(x, y, side = 1, size = 1) {
  const p = (dx, dy) => `${point(x + dx * size * side)} ${point(y + dy * size)}`;
  return `<path class="plant-decor-leaf" d="M${p(0, 0)}C${p(1, -4)} ${p(6, -7)} ${p(9, -4)}C${p(9, 0)} ${p(4, 1)} ${p(0, 0)}Z"/>`;
}

function drawMonthFrame(calendar) {
  const w = calendar.clientWidth, h = calendar.clientHeight;
  const markup = `<g class="plant-frame-vines">
    <path d="M14 43Q10 12 43 12M43 12C${point(w * .32)} 8 ${point(w * .7)} 16 ${w - 43} 12Q${w - 12} 10 ${w - 12} 43"/>
    <path d="M${w - 12} 43C${w - 7} ${point(h * .32)} ${w - 16} ${point(h * .7)} ${w - 12} ${h - 43}Q${w - 10} ${h - 12} ${w - 43} ${h - 12}"/>
    <path d="M${w - 43} ${h - 12}C${point(w * .65)} ${h - 8} ${point(w * .3)} ${h - 16} 43 ${h - 12}Q12 ${h - 10} 12 ${h - 43}"/>
  </g><g class="plant-frame-leaves">${decorativeLeaf(18, 22, 1, .85)}${decorativeLeaf(34, 12, 1, .7)}
    ${decorativeLeaf(w - 22, 16, -1, .9)}${decorativeLeaf(w - 12, 35, -1, .7)}
    ${decorativeLeaf(w - 12, h * .42, -1, .8)}${decorativeLeaf(w - 12, h - 27, -1, .85)}
    ${decorativeLeaf(w - 34, h - 12, -1, .7)}${decorativeLeaf(24, h - 14, 1, .8)}</g>`;
  paint(calendar, 'month-plant-frame', w, h, markup);
}

function drawMonthPlant(grid) {
  const rect = grid.getBoundingClientRect();
  const cells = [...grid.querySelectorAll(':scope > .month-day-cell')].map(cell => {
    const r = cell.getBoundingClientRect();
    const leaves = [...cell.querySelectorAll('.month-task-chip:not([hidden])')].map(chip => {
      const leaf = chip.querySelector('.month-task-status,.month-task-leaf');
      const c = (leaf || chip).getBoundingClientRect();
      return { x: point(c.left - rect.left + 2), y: point(c.top + c.height * .65 - rect.top) };
    });
    return { left: point(r.left - rect.left), right: point(r.right - rect.left), y: point(r.top - rect.top + 26), leaves,
      empty: !cell.classList.contains('is-outside') && !Number(cell.querySelector('.month-task-list')?.dataset.total),
      seed: Number(cell.dataset.date.slice(-2)) };
  });
  if (!cells.length) return;
  const paths = [];
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
  const firstY = weeks[0][0].y - 13, lastY = weeks.at(-1)[0].y + 12;
  const roots = weeks.map((_, i) => [3, 5, 2, 4, 3, 5][i]);
  let trunk = `M3 ${firstY}`, trunkX = 3, trunkY = firstY;
  weeks.forEach((week, row) => {
    const x = roots[row], y = week[0].y - 7, length = y - trunkY;
    trunk += `C${trunkX} ${point(trunkY + length * .45)} ${x} ${point(y - length * .35)} ${x} ${y}`;
    trunkX = x; trunkY = y;
  });
  trunk += `Q${trunkX - 2} ${lastY - 7} 3 ${lastY}`;
  paths.push(`<path class="plant-trunk" d="${trunk}"/>`);
  weeks.forEach((week, row) => {
    const baseY = week[0].y, root = roots[row];
    const sway = [0, -1, 0, 2.5, 3.5, 2, -.5, -1.5].map(n => n * (row % 2 ? -.55 : 1));
    let branch = `M${root} ${baseY - 7}Q${root} ${baseY} ${week[0].left + 9} ${baseY}`;
    week.forEach((cell, column) => {
      const y = point(baseY + sway[column]), endY = point(baseY + sway[column + 1]);
      const weekCurve = [{ x: column ? week[column - 1].right + 3 : week[0].left + 9, y },
        { x: cell.left + (cell.right - cell.left) * .33, y: y - 1 },
        { x: cell.left + (cell.right - cell.left) * .7, y: endY + 1 }, { x: cell.right + 3, y: endY }];
      branch += `C${point(weekCurve[1].x)} ${y - 1} ${point(weekCurve[2].x)} ${endY + 1} ${cell.right + 3} ${endY}`;
      if (cell.empty) {
        const at = cubicPoint(weekCurve, .4 + cell.seed % 3 * .1);
        paths.push(`<g class="plant-empty-leaves">${decorativeLeaf(at.x, at.y, cell.seed % 2 ? 1 : -1, .75)}
          ${cell.seed % 3 === 0 ? decorativeLeaf(at.x + 8, at.y, 1, .5) : ''}</g>`);
      }
      if (!cell.leaves.length) return;
      const vine = cell.left + 11;
      const at = cubicPoint(weekCurve, Math.max(0, Math.min(1, (vine - 6 - weekCurve[0].x) / (weekCurve[3].x - weekCurve[0].x))));
      let dayBranch = `M${point(at.x)} ${point(at.y)}`, previousX = at.x, previousY = at.y;
      cell.leaves.forEach((leaf, i) => {
        const forkX = point(vine + (i % 2 ? -.8 : .8)), forkY = Math.max(y, leaf.y - 8);
        dayBranch += `C${previousX} ${point(previousY + (forkY - previousY) * .6)} ${forkX} ${point(forkY - 2)} ${forkX} ${forkY}`;
        paths.push(`<path class="plant-task-fork" d="M${forkX} ${forkY}Q${forkX + 1} ${leaf.y + 3} ${leaf.x} ${leaf.y}"/>`);
        previousX = forkX; previousY = forkY;
      });
      paths.push(`<path class="plant-day-fork" d="${dayBranch}"/>`);
    });
    paths.push(`<path class="plant-week-branch" d="${branch}"/>`);
  });
  paths.push(`<g class="plant-tail-leaves">${decorativeLeaf(3, lastY - 2, 1, .8)}</g>`);
  paint(grid, 'month-plant-branches', grid.clientWidth, grid.clientHeight, paths.join(''));
  grid.querySelector('.month-plant-branches').dataset.branchDays = String(cells.filter(cell => cell.leaves.length).length);
  drawMonthFrame(grid.closest('.month-calendar'));
}
