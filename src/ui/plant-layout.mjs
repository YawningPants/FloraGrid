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
export function measureTaskPlant(children) {
  if (document.documentElement.dataset.appearance !== 'botanical') return null;
  const nodes = [...children.querySelectorAll(':scope > .task-node')];
  if (!nodes.length) return null;
  const rect = children.getBoundingClientRect();
  const parent = children.parentElement.querySelector(':scope > .task-row .status-button')?.getBoundingClientRect();
  const x = point(parent ? parent.left + parent.width / 2 - rect.left : 28);
  const leaves = nodes.map(node => {
    const button = node.querySelector(':scope > .task-row .status-button');
    const r = button?.getBoundingClientRect();
    return r ? { x: point(r.left - rect.left + 2), y: point(r.top + r.height * .65 - rect.top) } : null;
  }).filter(Boolean);
  const height = Math.max(1, nodes.at(-1).offsetTop + nodes.at(-1).offsetHeight);
  let trunk = `M${x} 0`, lastX = x, lastY = 0;
  const paths = [];
  leaves.forEach((leaf, i) => {
    const forkY = Math.max(lastY, leaf.y - 14);
    const forkX = point(x + [0, 2.5, -2, 1.5][i % 4]);
    const length = forkY - lastY;
    trunk += `C${lastX} ${point(lastY + length * .42)} ${forkX} ${point(forkY - length * .35)} ${forkX} ${forkY}`;
    paths.push(`<path class="plant-fork" d="M${forkX} ${forkY}C${forkX + 2} ${leaf.y - 5} ${leaf.x - 12} ${leaf.y + 4} ${leaf.x} ${leaf.y}"/>`);
    lastX = forkX; lastY = forkY;
  });
  paths.unshift(`<path class="plant-trunk" d="${trunk}"/>`);
  return { children, width: Math.max(1, children.clientWidth), height, markup: paths.join('') };
}

export function paintTaskPlant(layout) {
  if (layout) paint(layout.children, 'task-plant-branches', layout.width, layout.height, layout.markup);
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

function drawMonthPlant(grid) {
  const rect = grid.getBoundingClientRect();
  const cells = [...grid.querySelectorAll(':scope > .month-day-cell')].map(cell => {
    const r = cell.getBoundingClientRect();
    const leaves = [...cell.querySelectorAll('.month-task-chip:not([hidden])')].map(chip => {
      const leaf = chip.querySelector('.month-task-status,.month-task-leaf');
      const c = (leaf || chip).getBoundingClientRect();
      return { x: point(c.left - rect.left + 2), y: point(c.top + c.height * .65 - rect.top) };
    });
    return { left: point(r.left - rect.left), right: point(r.right - rect.left), y: point(r.top - rect.top + 26), leaves };
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
      branch += `C${point(cell.left + (cell.right - cell.left) * .33)} ${y - 1} ${point(cell.left + (cell.right - cell.left) * .7)} ${endY + 1} ${cell.right + 3} ${endY}`;
      if (!cell.leaves.length) return;
      const vine = cell.left + 11;
      let dayBranch = `M${vine - 6} ${y}`, previousX = vine - 6, previousY = y;
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
  paint(grid, 'month-plant-branches', grid.clientWidth, grid.clientHeight, paths.join(''));
  grid.querySelector('.month-plant-branches').dataset.branchDays = String(cells.filter(cell => cell.leaves.length).length);
}
