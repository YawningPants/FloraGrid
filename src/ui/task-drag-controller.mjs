import { applyTaskDrop, flattenDragTree, getOriginDropTarget, locateDragSlot, projectTaskDrop } from '../domain/task-drag.mjs';
import { canMoveTask, findTask } from '../domain/tasks.mjs';
import { icon } from './icons.mjs';

const INTENT_DISTANCE = 6;
const INDENT_DISTANCE = 24;
const DURATION = 180;

// The views supply card rendering and persistence; this controller owns the entire pointer lifecycle.
export function createTaskDragController(config) {
  let session = null;
  const animations = new Map();
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const elements = () => [...(config.getTree()?.querySelectorAll(config.rowSelector) || [])]
    .filter((row) => !row.closest('.task-drag-projection'));
  const rowFor = (id) => elements().find((row) => row.dataset.taskId === id);
  const nodeFor = (row) => config.flat ? row : row.closest('.task-node');

  function cancelAnimations() {
    animations.forEach((animation) => animation.cancel());
    animations.clear();
  }

  function visualRects(includePreview = false) {
    const rows = elements();
    if (includePreview && session?.preview) rows.push(...session.preview.querySelectorAll(config.rowSelector));
    if (includePreview && config.flat && session?.preview) rows.push(session.preview);
    return new Map(rows.map((row) => [row.dataset.taskId, row.getBoundingClientRect()]));
  }

  function animateFrom(before) {
    if (reducedMotion()) return;
    elements().forEach((row) => {
      const first = before.get(row.dataset.taskId);
      if (!first) return;
      const last = row.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      const animation = row.animate([
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: 'translate(0, 0)' },
      ], { duration: DURATION, easing: 'cubic-bezier(.2,.8,.2,1)' });
      animations.set(row, animation);
      animation.finished.then(() => {
        if (animations.get(row) === animation) animations.delete(row);
      }).catch(() => {});
    });
  }

  function viewport() {
    const list = config.getList();
    const rect = list.getBoundingClientRect();
    const summary = list.querySelector(':scope > .status-summary');
    return { left: rect.left, right: rect.right, top: rect.top + (summary?.offsetHeight || 0), bottom: rect.bottom };
  }

  function measure() {
    const list = config.getList();
    const listRect = list.getBoundingClientRect();
    const toContent = (rect) => ({ top: rect.top - listRect.top + list.scrollTop, bottom: rect.bottom - listRect.top + list.scrollTop });
    const nodes = new Map(elements().map((row) => [row.dataset.taskId, row]));
    session.rows = flattenDragTree(session.items, { ...session.options, excludedId: session.taskId, expandedIds: session.expandedIds })
      .filter((entry) => nodes.has(entry.id))
      .map((entry) => ({ ...entry, ...toContent(nodes.get(entry.id).getBoundingClientRect()) }));
    session.previewRect = toContent(session.preview.getBoundingClientRect());
  }

  function containerFor(parentId) {
    if (parentId === null || config.flat) return config.getTree();
    const row = rowFor(parentId);
    const wrapper = row?.closest('.task-node');
    if (!wrapper) throw new Error('Drag parent is no longer rendered');
    let children = wrapper.querySelector(':scope > .children');
    if (!children) {
      children = document.createElement('div');
      children.className = 'children';
      wrapper.append(children);
      session.createdContainers.add(children);
    }
    if (children.classList.contains('is-collapsed')) {
      session.expandedContainers.push({ children, row, wrapper });
      children.classList.remove('is-collapsed');
      row.classList.remove('is-collapsed');
      wrapper.classList.remove('is-collapsed');
      session.expandedIds.add(parentId);
    }
    return children;
  }

  function renderProjection(target, animate = true) {
    const before = visualRects();
    cancelAnimations();
    const container = containerFor(target.parentId);
    const beforeNode = target.beforeId === null ? null : nodeFor(rowFor(target.beforeId));
    const preview = config.createPreview(findTask(session.items, session.taskId), target, session.items);
    preview.classList.add('task-drag-projection');
    preview.setAttribute('aria-hidden', 'true');
    preview.inert = true;
    session.preview?.remove();
    container.insertBefore(preview, beforeNode);
    session.preview = preview;
    session.target = target;
    elements().forEach((row) => row.classList.toggle('is-drag-parent', row.dataset.taskId === target.parentId));
    config.afterLayout?.();
    measure(); // Measure before applying transforms. Animations are never used for hit testing.
    if (animate) animateFrom(before);
  }

  function begin() {
    config.onPrepare?.();
    const sourceRect = session.sourceRow.getBoundingClientRect();
    const sourceNode = nodeFor(session.sourceRow);
    session.originalParent = sourceNode.parentNode;
    session.originalNext = sourceNode.nextSibling;
    session.sourceNode = sourceNode;

    const origin = session.sourceRow.cloneNode(true);
    origin.classList.add('task-drag-origin');
    origin.inert = true;
    origin.setAttribute('aria-hidden', 'true');
    Object.assign(origin.style, { left: `${sourceRect.left}px`, top: `${sourceRect.top}px`, width: `${sourceRect.width}px`, height: `${sourceRect.height}px` });
    document.body.append(origin);
    session.origin = origin;

    const indicator = document.createElement('span');
    indicator.className = 'task-drag-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.innerHTML = icon('move');
    const count = countDescendants(findTask(session.items, session.taskId));
    if (count) {
      const badge = document.createElement('span');
      badge.textContent = `${count + 1} 项`; indicator.append(badge);
    }
    document.body.append(indicator);
    session.indicator = indicator;
    session.indicatorWidth = indicator.offsetWidth;
    sourceNode.remove();
    session.dragging = true;
    document.body.classList.add('is-task-dragging');
    renderProjection(session.target, false);
    session.valid = true;
  }

  function evaluate() {
    if (!session?.dragging) return;
    const bounds = viewport();
    const point = session.point;
    const badgeX = Math.max(6, Math.min(point.x + 14, innerWidth - session.indicatorWidth - 6));
    const badgeY = point.y + 38 < innerHeight ? point.y + 15 : point.y - 30;
    session.indicator.style.transform = `translate3d(${badgeX}px, ${badgeY}px, 0)`;
    const inside = point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
    let target = null;
    if (inside) {
      const list = config.getList();
      const y = point.y - list.getBoundingClientRect().top + list.scrollTop;
      const slot = locateDragSlot(session.rows, y, session.previewRect, session.target);
      const depth = config.flat ? 0 : Math.max(0, session.originDepth + Math.trunc((point.x - session.startX) / INDENT_DISTANCE));
      target = projectTaskDrop(session.items, session.taskId, session.rows, slot, depth, session.options);
      if (target && targetKey(target) !== targetKey(session.target)) renderProjection(target);
    }
    session.valid = Boolean(target);
    session.indicator.classList.toggle('is-drop-invalid', !session.valid);
    session.preview.classList.toggle('is-drop-invalid', !session.valid);
    document.body.classList.toggle('is-task-drop-invalid', !session.valid);
  }

  function frame(time) {
    if (!session?.dragging) return;
    const delta = Math.min(32, time - (session.lastFrame || time));
    session.lastFrame = time;
    const bounds = viewport();
    const edge = Math.min(40, (bounds.bottom - bounds.top) / 4);
    const { x, y } = session.point;
    let speed = 0;
    if (x >= bounds.left && x <= bounds.right && y >= bounds.top - edge && y <= bounds.bottom + edge) {
      if (y < bounds.top + edge) speed = -Math.min(1, (bounds.top + edge - y) / edge);
      else if (y > bounds.bottom - edge) speed = Math.min(1, (y - bounds.bottom + edge) / edge);
    }
    if (speed) config.getList().scrollTop += speed * delta * 0.65;
    evaluate();
    session.frame = window.requestAnimationFrame(frame);
  }

  function move(event) {
    if (!session || event.pointerId !== session.pointerId) return;
    session.point = { x: event.clientX, y: event.clientY };
    if (!session.dragging && Math.hypot(event.clientX - session.startX, event.clientY - session.startY) >= INTENT_DISTANCE) {
      begin();
      session.frame = window.requestAnimationFrame(frame);
    }
    if (session.dragging) event.preventDefault();
  }

  function restore() {
    session.preview?.remove();
    if (session.sourceNode) {
      const next = session.originalNext?.parentNode === session.originalParent ? session.originalNext : null;
      session.originalParent.insertBefore(session.sourceNode, next);
    }
    session.expandedContainers.forEach(({ children, row, wrapper }) => {
      children.classList.add('is-collapsed');
      row.classList.add('is-collapsed');
      wrapper.classList.add('is-collapsed');
    });
    session.createdContainers.forEach((container) => container.remove());
    elements().forEach((row) => row.classList.remove('is-drag-parent'));
    config.afterLayout?.();
  }

  function finish(event, commit) {
    if (!session || (event && event.pointerId !== session.pointerId)) return;
    if (session.dragging && event && commit) {
      session.point = { x: event.clientX, y: event.clientY };
      evaluate();
    }
    const current = session;
    const before = current.dragging ? visualRects(true) : new Map();
    window.cancelAnimationFrame(current.frame);
    cancelAnimations();
    if (current.dragging) restore();
    current.origin?.remove();
    current.indicator?.remove();
    session = null;
    unbind();
    document.body.classList.remove('is-task-dragging', 'is-task-drop-invalid');
    if (config.root.hasPointerCapture?.(current.pointerId)) config.root.releasePointerCapture(current.pointerId);

    if (commit && current.dragging && current.valid) {
      const result = applyTaskDrop(config.getItems(), current.taskId, current.target, current.options);
      if (result) {
        if (result.changed) config.onCommit(result.items);
      }
    }
    if (current.dragging) {
      animateFrom(before);
      const swallow = (click) => { click.preventDefault(); click.stopPropagation(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 50);
    }
  }

  const up = (event) => finish(event, true);
  const abort = (event) => finish(event?.type === 'pointercancel' ? event : null, false);
  const keydown = (event) => {
    if (event.key !== 'Escape' || !session) return;
    event.preventDefault();
    event.stopPropagation();
    finish(null, false);
  };
  const contextmenu = (event) => {
    if (!session?.dragging) return;
    event.preventDefault();
    finish(null, false);
  };
  function unbind() {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', abort, true);
    window.removeEventListener('keydown', keydown, true);
    window.removeEventListener('contextmenu', contextmenu, true);
    window.removeEventListener('blur', abort);
    window.removeEventListener('resize', abort);
    config.root.removeEventListener('lostpointercapture', abort);
  }

  return {
    get active() { return Boolean(session); },
    start(event, taskId, row) {
      if (event.button !== 0 || session || config.canStart?.() === false) return;
      const options = { ...config.getOptions?.(), flat: Boolean(config.flat) };
      const items = structuredClone(config.getItems());
      const task = findTask(items, taskId);
      const target = getOriginDropTarget(items, taskId, options);
      if (!task || !target || !canMoveTask(task, options.searchQuery || '')) return;
      event.preventDefault();
      session = {
        taskId, items, options, target, originDepth: target.depth, sourceRow: row,
        pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        point: { x: event.clientX, y: event.clientY }, dragging: false,
        expandedIds: new Set(), expandedContainers: [], createdContainers: new Set(),
      };
      window.addEventListener('pointermove', move, { capture: true, passive: false });
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', abort, true);
      window.addEventListener('keydown', keydown, true);
      window.addEventListener('contextmenu', contextmenu, true);
      window.addEventListener('blur', abort);
      window.addEventListener('resize', abort);
      config.root.addEventListener('lostpointercapture', abort);
      config.root.setPointerCapture?.(event.pointerId);
    },
    cancel() { finish(null, false); },
  };
}

function targetKey(target) {
  return JSON.stringify([target.parentId, target.beforeId, target.depth]);
}

function countDescendants(task) {
  return (task?.children || []).reduce((count, child) => count + 1 + countDescendants(child), 0);
}
