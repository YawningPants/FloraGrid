import { el } from './dom.mjs';

export function queueTaskTreeLayout(root) {
  window.requestAnimationFrame(() => {
    applyTagLineReserve(root);
    applyTreeBranchLayout(root);
    window.requestAnimationFrame(() => {
      applyTagLineReserve(root);
      applyTreeBranchLayout(root);
    });
  });
}

export function applyTagLineReserve(root) {
  root?.querySelectorAll('.tag-list').forEach((list) => {
    list.querySelectorAll('.tag-line-break').forEach((breakNode) => breakNode.remove());
    const chips = [...list.querySelectorAll(':scope > .tag-chip')];
    if (!chips.some((chip) => chip.querySelector('.tag-inherited-mark'))) {
      return;
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const chipRows = getTagChipRows(list);
      const crowdedRow = chipRows.find((row) => shouldReserveInheritedExpansion(list, row));
      if (!crowdedRow) {
        return;
      }
      const chipToMove = crowdedRow[crowdedRow.length - 1];
      if (!chipToMove) {
        return;
      }
      const breakNode = el('span', 'tag-line-break');
      breakNode.setAttribute('aria-hidden', 'true');
      list.insertBefore(breakNode, chipToMove);
    }
  });
}

export function applyTreeBranchLayout(root) {
  const layouts = [...(root?.querySelectorAll('.children') || [])].map((children) => {
    const lastNode = children.querySelector(':scope > .task-node:last-child');
    const lastBranch = lastNode?.querySelector(':scope > .tree-branch');
    if (!lastBranch) {
      return { children, offset: null };
    }
    const childrenRect = children.getBoundingClientRect();
    const branchRect = lastBranch.getBoundingClientRect();
    const offset = Math.max(0, Math.round(branchRect.top - childrenRect.top + 20));
    return { children, offset };
  });
  layouts.forEach(({ children, offset }) => {
    if (offset === null) children.style.removeProperty('--last-branch-y');
    else if (children.style.getPropertyValue('--last-branch-y') !== `${offset}px`) children.style.setProperty('--last-branch-y', `${offset}px`);
  });
}

function getTagChipRows(list) {
  const rows = [];
  [...list.querySelectorAll(':scope > .tag-chip')].forEach((chip) => {
    const top = Math.round(chip.offsetTop);
    let row = rows.find((item) => Math.abs(item.top - top) <= 2);
    if (!row) {
      row = { top, chips: [] };
      rows.push(row);
    }
    row.chips.push(chip);
  });
  return rows.map((row) => row.chips);
}

function shouldReserveInheritedExpansion(list, row) {
  if (row.length < 2 || !row.some((chip) => chip.querySelector('.tag-inherited-mark'))) {
    return false;
  }
  const style = getComputedStyle(list);
  const inlinePadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  const availableWidth = list.clientWidth - inlinePadding;
  const rowRight = Math.max(...row.map((chip) => chip.offsetLeft + chip.offsetWidth));
  return row.some((chip, index) => {
    if (index === row.length - 1 || !chip.querySelector('.tag-inherited-mark')) {
      return false;
    }
    return rowRight + getInheritedMarkerExpansionWidth(chip) > availableWidth;
  });
}

function getInheritedMarkerExpansionWidth(chip) {
  const marker = chip.querySelector('.tag-inherited-mark');
  if (!marker) {
    return 0;
  }
  const style = getComputedStyle(marker);
  return (
    Number.parseFloat(style.width)
    + Number.parseFloat(style.paddingLeft)
    + Number.parseFloat(style.paddingRight)
    + 2
  );
}
