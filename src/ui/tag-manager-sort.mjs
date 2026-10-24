// Small flat sortable lists: group cards are vertical; tags wrap into rows.
// An inert, dimmed preview occupies the result position; persistence happens only on release.
export function createTagManagerSort({ root, scroller, onCommit, canStart = () => true }) {
  let drag = null;
  let frame = 0;
  let pressTimer = 0;
  let suppressPointerClick = false;
  const captureTarget = document.documentElement;
  const abort = new AbortController();
  const options = { signal: abort.signal };

  function layoutRect(item) {
    const rect = item.getBoundingClientRect();
    const transform = getComputedStyle(item).transform;
    const matrix = transform === 'none' ? null : new DOMMatrixReadOnly(transform);
    return new DOMRect(rect.left - (matrix?.m41 || 0), rect.top - (matrix?.m42 || 0), rect.width, rect.height);
  }

  function cancel() {
    if (!drag) return false;
    const state = drag;
    if (state.longPress) suppressPointerClick = true;
    cleanup();
    if (state.ghost) {
      state.order.forEach((item) => item.getAnimations().forEach((animation) => animation.cancel()));
    }
    return true;
  }

  function cleanup() {
    const state = drag;
    drag = null;
    clearTimeout(pressTimer);
    cancelAnimationFrame(frame);
    if (state.preview) state.item.style.display = state.originalDisplay;
    state.preview?.remove();
    state.ghost?.remove();
    document.body.classList.remove('is-tag-sorting');
    if (captureTarget.hasPointerCapture(state.pointerId)) captureTarget.releasePointerCapture(state.pointerId);
  }

  function activate() {
    if (!drag || !drag.item.isConnected || !canStart()) { cancel(); return; }
    // Keep the pressed node in place; only the inert result preview is reordered.
    captureTarget.setPointerCapture(drag.pointerId);
    suppressPointerClick = true;
    const rect = drag.item.getBoundingClientRect();
    drag.ghost = drag.item.cloneNode(true);
    drag.ghost.classList.add('tag-sort-ghost');
    drag.ghost.setAttribute('aria-hidden', 'true');
    drag.ghost.inert = true;
    drag.ghost.style.width = `${rect.width}px`;
    drag.ghost.style.maxHeight = '160px';
    drag.offsetX = drag.startX - rect.left;
    drag.offsetY = drag.startY - rect.top;
    document.body.append(drag.ghost);
    drag.preview = drag.item.cloneNode(true);
    drag.preview.classList.add('is-sorting');
    drag.preview.setAttribute('aria-hidden', 'true');
    drag.preview.inert = true;
    drag.originalDisplay = drag.item.style.display;
    drag.item.before(drag.preview);
    drag.item.style.display = 'none';
    document.body.classList.add('is-tag-sorting');
    frame = requestAnimationFrame(tick);
    project();
  }

  function move(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!(event.buttons & 1)) { cancel(); return; }
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.ghost) {
      const distance = Math.hypot(drag.x - drag.startX, drag.y - drag.startY);
      if (drag.longPress) {
        // Moving before the hold completes cancels the gesture, rather than editing on release.
        if (distance > 6) { suppressPointerClick = true; cancel(); }
        return;
      }
      if (distance < 5) return;
      activate();
      return;
    }
    if (!captureTarget.hasPointerCapture(drag.pointerId)) captureTarget.setPointerCapture(drag.pointerId);
    event.preventDefault();
    project();
  }

  function project() {
    const state = drag;
    state.ghost.style.left = `${state.x - state.offsetX}px`;
    state.ghost.style.top = `${state.y - state.offsetY}px`;
    const bounds = state.list.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    state.valid = state.x >= bounds.left && state.x <= bounds.right && state.y >= Math.max(view.top, bounds.top) - 8 && state.y <= Math.min(view.bottom, bounds.bottom) + 8;
    if (!state.valid) return;
    const source = layoutRect(state.preview);
    if (state.x >= source.left && state.x <= source.right && state.y >= source.top && state.y <= source.bottom) return;
    const others = state.order.filter((item) => item !== state.item);
    const distance = (rect) => Math.hypot(Math.max(rect.left - state.x, 0, state.x - rect.right), Math.max(rect.top - state.y, 0, state.y - rect.bottom));
    const target = others.map((item) => ({ item, rect: layoutRect(item) }))
      .sort((a, b) => distance(a.rect) - distance(b.rect))[0];
    if (!target) return;
    const { item, rect } = target;
    const after = state.type === 'group' || state.y < rect.top || state.y > rect.bottom
      ? state.y > rect.top + rect.height / 2
      : state.x > rect.left + rect.width / 2;
    const next = after ? item.nextElementSibling : item;
    const nextVisible = next === state.item ? state.item.nextElementSibling : next;
    if (nextVisible === state.preview || state.preview.nextElementSibling === nextVisible) return;
    const positions = new Map(others.map((node) => [node, node.getBoundingClientRect()]));
    state.list.insertBefore(state.preview, nextVisible);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      others.forEach((node) => {
        const before = positions.get(node);
        node.getAnimations().forEach((animation) => animation.cancel());
        const now = node.getBoundingClientRect();
        node.animate([{ transform: `translate(${before.left - now.left}px, ${before.top - now.top}px)` }, { transform: 'none' }], { duration: 150, easing: 'ease-out' });
      });
    }
  }

  function tick() {
    if (!drag?.ghost) return;
    const rect = scroller.getBoundingClientRect();
    const delta = drag.y < rect.top + 30 ? -7 : drag.y > rect.bottom - 30 ? 7 : 0;
    if (delta) { scroller.scrollTop += delta; project(); }
    frame = requestAnimationFrame(tick);
  }

  root.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || drag) return;
    suppressPointerClick = false;
    const handle = event.target.closest('[data-sort-handle], [data-sort-press]');
    if (!handle || event.button !== 0 || !canStart()) return;
    const item = handle.closest('[data-sort-id]');
    const list = item.parentElement;
    const longPress = handle.hasAttribute('data-sort-press');
    if (!longPress) {
      event.preventDefault();
      captureTarget.setPointerCapture(event.pointerId);
    }
    drag = { handle, item, list, longPress, startScrollTop: scroller.scrollTop, type: list.dataset.sortType, order: [...list.children], pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
    if (longPress) pressTimer = setTimeout(activate, 350);
  }, options);
  // Listen on window before capture so releasing outside also clears a pending hold.
  window.addEventListener('pointermove', move, { ...options, capture: true, passive: false });
  window.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.ghost) { cleanup(); return; }
    if (drag.ghost) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      project();
    }
    const state = drag;
    const ids = [...state.list.children].filter((item) => item !== state.item).map((item) => item.dataset.sortId);
    const changed = state.ghost && state.valid && ids.some((id, index) => id !== state.order[index].dataset.sortId);
    if (!changed) { cancel(); return; }
    state.order.forEach((item) => item.getAnimations().forEach((animation) => animation.cancel()));
    cleanup();
    const byId = new Map(state.order.map((item) => [item.dataset.sortId, item]));
    ids.forEach((id) => state.list.append(byId.get(id)));
    onCommit(state.type, state.list.dataset.groupId, ids);
  }, options);
  window.addEventListener('lostpointercapture', (event) => {
    // Capture may end while the button is still down; keep window tracking until release.
    if (drag?.ghost && event.pointerId === drag.pointerId && !(event.buttons & 1)) cancel();
  }, options);
  window.addEventListener('pointercancel', cancel, options);
  window.addEventListener('blur', cancel, options);
  scroller.addEventListener('scroll', () => {
    if (drag?.longPress && !drag.ghost && scroller.scrollTop !== drag.startScrollTop) cancel();
  }, options);
  root.addEventListener('click', (event) => {
    if (!suppressPointerClick || event.detail === 0) return;
    suppressPointerClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { ...options, capture: true });
  root.addEventListener('contextmenu', (event) => {
    if (drag?.longPress) event.preventDefault();
  }, options);
  root.addEventListener('dragstart', (event) => {
    if (event.target.closest('[data-sort-press]')) event.preventDefault();
  }, options);
  root.addEventListener('keydown', (event) => {
    const handle = event.target.closest('[data-sort-handle], [data-sort-press]');
    if (!handle || !event.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) || !canStart()) return;
    event.preventDefault();
    const item = handle.closest('[data-sort-id]');
    const list = item.parentElement;
    const items = [...list.children];
    const from = items.indexOf(item);
    const to = from + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1);
    if (!items[to]) return;
    [items[from], items[to]] = [items[to], items[from]];
    onCommit(list.dataset.sortType, list.dataset.groupId, items.map((node) => node.dataset.sortId));
  }, options);
  return { cancel, destroy() { cancel(); abort.abort(); } };
}
