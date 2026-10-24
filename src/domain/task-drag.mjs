import { canAcceptChildTask, canMoveTask, findTask, getTaskLocation, getRenderableTasks, hasDescendant, taskStatusMeta } from './tasks.mjs';

export function flattenDragTree(items, { showDeletedTasks = false, excludedId = null, expandedIds = new Set(), flat = false } = {}) {
  const rows = [];
  const visit = (tasks, parentId, depth) => {
    getRenderableTasks(tasks, showDeletedTasks).forEach((task) => {
      if (task.id === excludedId) return;
      rows.push({ id: task.id, task, parentId, depth });
      if (!flat && (!task.collapsed || expandedIds.has(task.id))) {
        visit(task.children || [], task.id, depth + 1);
      }
    });
  };
  visit(items, null, 0);
  return rows;
}

export function getOriginDropTarget(items, taskId, options = {}) {
  const all = flattenDragTree(items, options);
  const origin = all.find((row) => row.id === taskId);
  if (!origin) return null;
  const siblings = getRenderableTasks(childrenOf(items, origin.parentId) || [], options.showDeletedTasks);
  const index = siblings.findIndex((task) => task.id === taskId);
  const afterSubtree = all.slice(all.indexOf(origin) + 1).find((row) => row.depth <= origin.depth);
  return {
    parentId: origin.parentId,
    beforeId: siblings[index + 1]?.id || null,
    depth: origin.depth,
    slotBeforeId: afterSubtree?.id || null,
  };
}

// Only the measured, untransformed layout is passed here. The preview is not a candidate row.
export function locateDragSlot(rows, pointerY, preview, currentTarget) {
  if (preview && currentTarget && pointerY >= preview.top && pointerY <= preview.bottom) {
    const index = currentTarget.slotBeforeId === null
      ? rows.length
      : rows.findIndex((row) => row.id === currentTarget.slotBeforeId);
    if (index !== -1) return index;
  }
  const index = rows.findIndex((row) => pointerY < (row.top + row.bottom) / 2);
  return index === -1 ? rows.length : index;
}

export function projectTaskDrop(items, taskId, rows, slot, depth, options = {}) {
  if (!Number.isInteger(slot) || slot < 0 || slot > rows.length || !Number.isInteger(depth) || depth < 0) return null;
  const previous = rows[slot - 1];
  const next = rows[slot];
  const minDepth = next?.depth || 0;
  const maxDepth = previous ? previous.depth + 1 : 0;
  if (depth < minDepth || depth > maxDepth || (options.flat && depth !== 0)) return null;

  let parentId = null;
  if (depth > 0) {
    const parent = rows.slice(0, slot).reverse().find((row) => row.depth === depth - 1);
    if (!parent) return null;
    parentId = parent.id;
  }
  const target = {
    parentId,
    beforeId: next?.depth === depth ? next.id : null,
    depth,
    slotBeforeId: next?.id || null,
  };
  return isValidTaskDrop(items, taskId, target, options) ? target : null;
}

export function isValidTaskDrop(items, taskId, target, { showDeletedTasks = false, searchQuery = '', flat = false } = {}) {
  const origin = getTaskLocation(items, taskId);
  if (!origin || !target || !canMoveTask(origin.task, searchQuery)) return false;
  if (target.parentId === taskId || hasDescendant(origin.task, target.parentId)) return false;
  if (flat && target.parentId !== null) return false;
  const parent = target.parentId === null ? null : findTask(items, target.parentId);
  if (target.parentId !== null && !parent) return false;
  if (parent && origin.parentId !== parent.id && !canAcceptChildTask(parent)) return false;
  // Existing children may still be reordered under a completed parent, but cannot be added to it.
  const siblings = getRenderableTasks(childrenOf(items, target.parentId) || [], showDeletedTasks)
    .filter((task) => task.id !== taskId);
  const index = target.beforeId === null ? siblings.length : siblings.findIndex((task) => task.id === target.beforeId);
  if (index < 0) return false;
  const order = taskStatusMeta[origin.task.status]?.order;
  const previousOrder = taskStatusMeta[siblings[index - 1]?.status]?.order ?? -Infinity;
  const nextOrder = taskStatusMeta[siblings[index]?.status]?.order ?? Infinity;
  return order >= previousOrder && order <= nextOrder;
}

// Validate every reference before detaching anything. Invalid moves never change the input tree.
export function applyTaskDrop(items, taskId, target, options = {}) {
  if (!isValidTaskDrop(items, taskId, target, options)) return null;
  const origin = getTaskLocation(items, taskId);
  const siblings = getRenderableTasks(childrenOf(items, origin.parentId), options.showDeletedTasks);
  const index = siblings.findIndex((task) => task.id === taskId);
  if (origin.parentId === target.parentId && (siblings[index + 1]?.id || null) === target.beforeId) {
    return { items, changed: false };
  }

  const nextItems = structuredClone(items);
  const source = getTaskLocation(nextItems, taskId);
  const sourceSiblings = childrenOf(nextItems, source.parentId);
  const [moved] = sourceSiblings.splice(source.index, 1);
  const parent = target.parentId === null ? null : findTask(nextItems, target.parentId);
  if (parent) parent.children ||= [];
  const destination = parent ? parent.children : nextItems;
  const insertAt = target.beforeId === null ? destination.length : destination.findIndex((task) => task.id === target.beforeId);
  destination.splice(insertAt, 0, moved);
  if (target.parentId !== null) findTask(nextItems, target.parentId).collapsed = false;
  return { items: nextItems, changed: true };
}

function childrenOf(items, parentId) {
  if (parentId === null) return items;
  const parent = findTask(items, parentId);
  return parent ? parent.children || [] : null;
}
