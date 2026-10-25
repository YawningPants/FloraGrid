import {
  gardenCapacity,
  gardenFrontCapacity,
  gardenTaskLayers,
  gardenFoliageGeometry,
  gardenPlantGeometry,
  gardenPlantProfile,
  gardenSlotCount,
  reconcileGardenSlots,
  selectGardenTasks,
} from '../domain/header-garden.mjs';
import { findTask } from '../domain/tasks.mjs';
import { botanicalMotionEnabled, flowerMarkup } from './botanical.mjs';

const NS = 'http://www.w3.org/2000/svg';
const layoutKey = 'desktop-calendar:header-garden-layout';
const defaultPlantOpacity = 0.34;
const leafOpacity = 0.82;

function svg(tag, attributes = {}) {
  const node = document.createElementNS(NS, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  return node;
}

// Cosmetic cache only: at most 32 day/width combinations, containing task IDs and slot numbers.
// Completion order remains in the normal day data; losing this cache never loses a flower/task.
function readLayouts() {
  try {
    const data = JSON.parse(localStorage.getItem(layoutKey) || 'null');
    return data?.version === 1 && Array.isArray(data.entries) ? data.entries.slice(0, 32) : [];
  } catch {
    return [];
  }
}

function savedSlots(date, capacity) {
  const entry = readLayouts().find((item) => item?.date === date && item.capacity === capacity);
  return new Map(
    (Array.isArray(entry?.slots) ? entry.slots : [])
      .filter((pair) => Array.isArray(pair) && typeof pair[0] === 'string' && Number.isInteger(pair[1]))
      .slice(0, 18),
  );
}

function saveSlots(date, capacity, slots) {
  try {
    const entries = readLayouts().filter((item) => item?.date !== date || item.capacity !== capacity);
    entries.unshift({ date, capacity, slots: [...slots] });
    localStorage.setItem(layoutKey, JSON.stringify({ version: 1, entries: entries.slice(0, 32) }));
  } catch {
    /* A disabled/full cache must never interfere with task completion. */
  }
}

export function createHeaderGarden(
  root,
  { getItems, getDate, getSettings, isLoading, onActivityChange = () => {} },
) {
  const layer = document.createElement('div');
  layer.className = 'day-header-garden';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.setProperty('--garden-rest-opacity', defaultPlantOpacity);
  layer.style.setProperty('--garden-leaf-opacity', leafOpacity);
  const art = svg('svg', { class: 'header-garden-art', focusable: 'false' });
  const maskId = `garden-mask-${crypto.randomUUID()}`;
  const defs = svg('defs'),
    mask = svg('mask', { id: maskId, maskUnits: 'userSpaceOnUse', x: 0, y: 0 });
  // Feather the shared text mask once, so a flower never gets a hard rectangular cut through it.
  const feather = svg('filter', {
    id: `${maskId}-feather`,
    x: '-10%',
    y: '-20%',
    width: '120%',
    height: '140%',
  });
  feather.append(svg('feGaussianBlur', { stdDeviation: 3 }));
  const maskBase = svg('rect', { fill: 'white' }),
    exclusions = svg('g', { fill: 'black', opacity: '.5', filter: `url(#${maskId}-feather)` });
  mask.append(maskBase, exclusions);
  defs.append(feather, mask);
  art.append(defs);
  const masked = svg('g', { mask: `url(#${maskId})` });
  const groups = [];
  // SVG paint order is depth order. Only six groups sway, never one animation per flower.
  for (const depth of ['back', 'front']) {
    const bucket = svg('g', { class: `garden-depth-layer garden-depth-${depth}` });
    for (let i = 0; i < 3; i++) {
      const group = svg('g', { class: `garden-sway-group garden-sway-${i}` });
      bucket.append(group);
      groups.push(group);
    }
    masked.append(bucket);
  }
  art.append(masked);
  layer.append(art);
  root.prepend(layer);
  const records = new Map(),
    transitions = new Set(),
    observed = new Set();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let date = null,
    capacity = 0,
    slots = new Map(),
    width = 0,
    height = 0,
    frame = 0;
  let destroyed = false,
    minimized = false,
    focused = document.hasFocus(),
    nativeVisible = true,
    activityRevision = 0,
    previousMotion = null;
  let pendingOptions = {},
    lastCache = '',
    lastMask = '';
  let active = null,
    plantOpacity = defaultPlantOpacity;
  let geometryDirty = true,
    layoutRevision = 0,
    rectangles = [],
    selectionCache = null;
  let header = null,
    toolbar = null,
    summary = null,
    titlebarNode = null;
  const cleanups = [];

  function cancelAnimations(record) {
    record.ticket++;
    record.animations.forEach((animation) => animation.cancel());
    record.animations = [];
    transitions.delete(record);
  }
  function remove(record) {
    cancelAnimations(record);
    record.node.remove();
    if (records.get(record.id) === record) records.delete(record.id);
    if (!records.size) layer.classList.remove('has-motion');
  }
  function finish(record) {
    if (record.retiring) {
      remove(record);
      return;
    }
    cancelAnimations(record);
    record.growth.style.transform = 'none';
    record.growth.style.removeProperty('opacity');
    record.head.style.transform = 'none';
    record.leaves.style.removeProperty('opacity');
    record.node.dataset.phase = 'settled';
  }
  function finishAll() {
    [...transitions].forEach(finish);
  }
  function reserveTransition(record) {
    cancelAnimations(record);
    while (transitions.size >= 2) finish(transitions.values().next().value);
    transitions.add(record);
  }
  function animate(record, element, frames, options) {
    const animation = element.animate(frames, { fill: 'both', ...options });
    record.animations.push(animation);
    return animation;
  }
  function grow(record, delay) {
    reserveTransition(record);
    const ticket = record.ticket;
    record.node.dataset.phase = 'growing';
    const rise = animate(
      record,
      record.growth,
      [
        { transform: `translateY(${record.geometry.height + 36}px) scale(.82)`, opacity: 0 },
        { transform: 'translateY(0) scale(1)', opacity: plantOpacity + 0.12, offset: 0.74 },
        { transform: 'translateY(0) scale(1)', opacity: plantOpacity },
      ],
      { duration: 1050, delay, easing: 'cubic-bezier(.2,.72,.24,1)' },
    );
    animate(
      record,
      record.head,
      [
        { transform: 'scale(.12) rotate(-12deg)' },
        { transform: 'scale(1.04) rotate(1deg)', offset: 0.78 },
        { transform: 'scale(1) rotate(0deg)' },
      ],
      { duration: 600, delay: delay + 400, easing: 'cubic-bezier(.2,.72,.24,1)' },
    );
    animate(record, record.leaves, [{ opacity: 0 }, { opacity: leafOpacity }], {
      duration: 400,
      delay: delay + 270,
    });
    rise.finished
      .then(() => {
        if (record.ticket === ticket) finish(record);
      })
      .catch(() => {});
  }
  function fadeIn(record) {
    reserveTransition(record);
    const ticket = record.ticket;
    record.node.dataset.phase = 'appearing';
    const animation = animate(record, record.growth, [{ opacity: 0 }, { opacity: plantOpacity }], {
      duration: 240,
    });
    animation.finished
      .then(() => {
        if (record.ticket === ticket) finish(record);
      })
      .catch(() => {});
  }
  function retreat(record) {
    const style = getComputedStyle(record.growth),
      from = { transform: style.transform, opacity: style.opacity };
    reserveTransition(record);
    const ticket = record.ticket;
    record.retiring = true;
    record.node.dataset.phase = 'retreating';
    record.node.dataset.exit = 'removal';
    const animation = animate(
      record,
      record.growth,
      [from, { transform: `translateY(${record.geometry.height + 36}px) scale(.82)`, opacity: 0 }],
      { duration: 480, easing: 'cubic-bezier(.55,.06,.8,.45)' },
    );
    animation.finished
      .then(() => {
        if (record.ticket === ticket) remove(record);
      })
      .catch(() => {});
  }
  function dissolve(record) {
    // Replaced flowers stay exactly where they are and quietly lose opacity while the
    // new flower grows. Freeze an unfinished arrival too, instead of snapping it upright.
    const style = getComputedStyle(record.growth),
      from = Number(style.opacity);
    const transform = style.transform,
      headTransform = getComputedStyle(record.head).transform;
    const leavesOpacity = getComputedStyle(record.leaves).opacity;
    reserveTransition(record);
    const ticket = record.ticket;
    record.growth.style.transform = transform;
    record.head.style.transform = headTransform;
    record.leaves.style.opacity = leavesOpacity;
    record.retiring = true;
    record.node.dataset.phase = 'dissolving';
    record.node.dataset.exit = 'replacement';
    const animation = animate(record, record.growth, [{ opacity: from }, { opacity: 0 }], {
      duration: 760,
      easing: 'ease-in-out',
    });
    animation.finished
      .then(() => {
        if (record.ticket === ticket) remove(record);
      })
      .catch(() => {});
  }
  function createPlant(task) {
    const node = svg('g', { class: 'garden-plant', 'data-garden-task-id': task.id, 'data-phase': 'settled' });
    const growth = svg('g', { class: 'garden-growth' }),
      stem = svg('path', { class: 'garden-stem' });
    const leaves = svg('g', { class: 'garden-leaves' }),
      headPosition = svg('g'),
      headDepth = svg('g', { class: 'garden-flower-depth' }),
      head = svg('g', { class: 'garden-flower-head' });
    const backLeaves = svg('path', { class: 'garden-leaf-back' }),
      frontLeaves = svg('path', { class: 'garden-leaf-front' });
    leaves.append(backLeaves, frontLeaves);
    head.innerHTML = flowerMarkup(task);
    headDepth.append(head);
    headPosition.append(headDepth);
    growth.append(stem, leaves, headPosition);
    node.append(growth);
    const profile = gardenPlantProfile(task.id);
    node.dataset.foliage = profile.family;
    const record = {
      id: task.id,
      node,
      growth,
      stem,
      leaves,
      frontLeaves,
      backLeaves,
      profile,
      headPosition,
      headDepth,
      head,
      signature: head.innerHTML,
      ticket: 0,
      animations: [],
      retiring: false,
    };
    records.set(task.id, record);
    return record;
  }
  function plantHeight(geometry, rectangles) {
    const base = height - 2,
      half = geometry.size / 2;
    const candidates = [0, -15, 15, -30, 30, -45].map((offset) =>
      Math.max(34, Math.min(height - 18, geometry.height + offset)),
    );
    const score = (h) => {
      const box = {
        left: geometry.x + geometry.bend - half,
        right: geometry.x + geometry.bend + half,
        top: base - h - half,
        bottom: base - h + half,
      };
      return (
        rectangles.reduce(
          (sum, r) =>
            sum +
            Math.max(0, Math.min(box.right, r.right) - Math.max(box.left, r.left)) *
              Math.max(0, Math.min(box.bottom, r.bottom) - Math.max(box.top, r.top)),
          0,
        ) +
        Math.abs(h - geometry.height) * 0.5
      );
    };
    return candidates.reduce((best, h) => (score(h) < score(best) ? h : best), candidates[0]);
  }
  function position(record, task, slot, rectangles) {
    const metadata = `${task.flower?.variant || ''}:${task.flower?.tone || ''}`;
    if (record.positionRevision === layoutRevision && record.slot === slot && record.metadata === metadata)
      return;
    record.positionRevision = layoutRevision;
    record.slot = slot;
    record.metadata = metadata;
    const geometry = gardenPlantGeometry(task.id, slot, capacity, width, height);
    geometry.height = plantHeight(geometry, rectangles);
    record.geometry = geometry;
    const { x, height: h, bend, size, group } = geometry;
    const markup = flowerMarkup(task),
      layout = JSON.stringify([geometry, height, markup]);
    if (record.layout === layout) return;
    record.layout = layout;
    record.node.dataset.slot = String(slot);
    record.node.setAttribute('transform', `translate(${x} ${height - 2})`);
    const foliage = gardenFoliageGeometry(record.profile, h, bend);
    record.stem.setAttribute('d', foliage.stem);
    record.stem.style.strokeWidth = record.profile.stroke;
    record.frontLeaves.setAttribute('d', foliage.front);
    record.backLeaves.setAttribute('d', foliage.back);
    record.node.dataset.leaves = foliage.leafCount;
    record.headPosition.setAttribute('transform', `translate(${bend} ${-h}) rotate(${bend * 1.1})`);
    if (record.signature !== markup) {
      record.head.innerHTML = markup;
      record.signature = markup;
    }
    const flower = record.head.firstElementChild;
    flower.setAttribute('x', -size / 2);
    flower.setAttribute('y', -size / 2);
    // Nested SVG needs explicit viewport attributes; CSS sizing alone can leave a 100% viewBox.
    flower.setAttribute('width', size);
    flower.setAttribute('height', size);
    flower.style.width = `${size}px`;
    flower.style.height = `${size}px`;
    if (record.node.parentElement !== groups[group + (record.depth === 'back' ? 0 : 3)])
      groups[group + (record.depth === 'back' ? 0 : 3)].append(record.node);
  }
  function updateMotion() {
    if (destroyed) return;
    const nextActive = !document.hidden && nativeVisible && !minimized && focused;
    root.classList.toggle('is-backgrounded', !nextActive);
    const enabled = botanicalMotionEnabled(getSettings()) && records.size > 0 && !layer.hidden;
    layer.classList.toggle('has-motion', enabled);
    layer.classList.toggle('is-paused', !nextActive);
    if (!enabled || !nextActive || layer.hidden) finishAll();
    if (active !== nextActive) {
      active = nextActive;
      onActivityChange(active);
    }
  }
  function sync(options = {}) {
    if (destroyed || !root.isConnected) return;
    observeMeasurements();
    const settings = getSettings(),
      nextDate = getDate(),
      nextWidth = geometryDirty ? root.clientWidth : width;
    if (!nextWidth) return;
    const origin = geometryDirty ? root.getBoundingClientRect() : null;
    const titlebar = geometryDirty ? titlebarNode.getBoundingClientRect() : null;
    const bottom = geometryDirty ? (summary || toolbar).getBoundingClientRect().bottom : null;
    const nextHeight = geometryDirty ? Math.max(80, Math.round(bottom - titlebar.bottom)) : height;
    const nextCapacity = gardenCapacity(nextWidth),
      changedDate = date !== nextDate;
    const resized = width !== nextWidth || height !== nextHeight || capacity !== nextCapacity;
    if (changedDate || resized) finishAll();
    if (changedDate) {
      records.forEach(remove);
      date = nextDate;
    }
    if (changedDate || capacity !== nextCapacity) {
      capacity = nextCapacity;
      slots = savedSlots(date, capacity);
    }
    width = nextWidth;
    height = nextHeight;
    layer.hidden = settings.appearance !== 'botanical' || settings.gardenEnabled === false || isLoading();
    const nextOpacity = settings.surfaceStyle === 'notebook' ? 0.68 : defaultPlantOpacity;
    if (plantOpacity !== nextOpacity) {
      finishAll();
      plantOpacity = nextOpacity;
      layer.style.setProperty('--garden-rest-opacity', plantOpacity);
    }
    if (settings.appearance !== 'botanical' || settings.gardenEnabled === false) {
      records.forEach(remove);
      selectionCache = null;
      layer.dataset.visible = '0';
      updateMotion();
      return;
    }
    if (geometryDirty) {
      layer.style.top = `${titlebar.bottom - origin.top}px`;
      layer.style.height = `${height}px`;
      art.setAttribute('viewBox', `0 0 ${width} ${height}`);
      mask.setAttribute('width', width);
      mask.setAttribute('height', height);
      maskBase.setAttribute('width', width);
      maskBase.setAttribute('height', height);
      groups.forEach((group, i) => {
        group.style.transformOrigin = `${width * [0.25, 0.55, 0.8][i % 3]}px ${height}px`;
      });
      rectangles = [
        ...header.querySelectorAll('h1,.day-date-nav,.header-actions,.task-search-input'),
        ...toolbar.children,
      ].map((node) => {
        const r = node.getBoundingClientRect();
        return {
          left: r.left - origin.left - 3,
          right: r.right - origin.left + 3,
          top: r.top - titlebar.bottom - 3,
          bottom: r.bottom - titlebar.bottom + 3,
        };
      });
      const nextMask = JSON.stringify(rectangles);
      if (nextMask !== lastMask || resized) {
        exclusions.replaceChildren(
          ...rectangles.map((r) =>
            svg('rect', { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, rx: 5 }),
          ),
        );
        lastMask = nextMask;
        layoutRevision++;
      }
      geometryDirty = false;
    }
    const items = isLoading() ? [] : getItems();
    const selected =
      options.layoutOnly && selectionCache?.items === items && !changedDate && !resized
        ? selectionCache.result
        : selectGardenTasks(items, capacity);
    selectionCache = { items, result: selected };
    const reserved = [...records.values()]
      .filter((record) => record.retiring)
      .map((record) => Number(record.node.dataset.slot));
    const nextSlots = reconcileGardenSlots(selected.tasks, slots, capacity, { reserved }),
      selectedIds = new Set(nextSlots.keys());
    const canAnimate =
      options.animate &&
      !changedDate &&
      !resized &&
      !document.hidden &&
      nativeVisible &&
      !minimized &&
      focused &&
      botanicalMotionEnabled(settings);
    const departures = [...records.values()].filter(
      (record) => !selectedIds.has(record.id) && !record.retiring,
    );
    departures.forEach((record) => {
      if (!canAnimate) remove(record);
      else if (findTask(items, record.id)?.status === 'completed') dissolve(record);
      else retreat(record);
    });
    const depths = gardenTaskLayers(selected.tasks, capacity);
    selected.tasks.forEach((task) => {
      let record = records.get(task.id),
        fresh = !record || record.retiring;
      if (record?.retiring) {
        remove(record);
        record = null;
      }
      if (!record) record = createPlant(task);
      const depth = depths.get(task.id);
      if (record.depth !== depth) {
        record.depth = depth;
        record.node.dataset.layer = depth;
        const slot = nextSlots.get(task.id),
          group = (slot % 3) + (depth === 'back' ? 0 : 3);
        groups[group].append(record.node);
      }
      position(record, task, nextSlots.get(task.id), rectangles);
      if (canAnimate && task.id === options.growTaskId) grow(record, 0);
      else if (fresh && canAnimate) fadeIn(record);
    });
    if (!isLoading()) slots = nextSlots;
    // Loading must not erase the remembered layout before the actual day arrives.
    const cache = JSON.stringify([date, capacity, [...slots]]);
    if (!isLoading() && cache !== lastCache) {
      saveSlots(date, capacity, slots);
      lastCache = cache;
    }
    layer.dataset.date = date;
    layer.dataset.capacity = capacity;
    layer.dataset.positions = gardenSlotCount(capacity);
    layer.dataset.total = selected.total;
    layer.dataset.visible = nextSlots.size;
    layer.dataset.front = String(Math.min(selected.tasks.length, gardenFrontCapacity(capacity)));
    layer.dataset.back = String(Math.max(0, selected.tasks.length - gardenFrontCapacity(capacity)));
    const motion = botanicalMotionEnabled(settings);
    if (previousMotion !== motion) {
      finishAll();
      previousMotion = motion;
    }
    updateMotion();
  }
  function schedule(options = {}) {
    pendingOptions = { ...pendingOptions, ...options };
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = pendingOptions;
        pendingOptions = {};
        sync(next);
      });
  }
  function update(options = {}) {
    if (root.isConnected) sync(options);
    else schedule(options);
  }
  const resize = new ResizeObserver(() => {
    geometryDirty = true;
    schedule({ layoutOnly: true });
  });
  function observeMeasurements() {
    const nextHeader = root.querySelector(':scope > .day-header'),
      nextToolbar = root.querySelector(':scope > .day-toolbar');
    const nextSummary = root.querySelector(':scope > .task-scroll-region > .status-summary');
    const nextTitlebar = root.querySelector(':scope > .window-titlebar');
    if (
      header !== nextHeader ||
      toolbar !== nextToolbar ||
      summary !== nextSummary ||
      titlebarNode !== nextTitlebar
    )
      geometryDirty = true;
    header = nextHeader;
    toolbar = nextToolbar;
    summary = nextSummary;
    titlebarNode = nextTitlebar;
    const next = new Set([root, header, toolbar, summary].filter(Boolean));
    for (const node of observed)
      if (!next.has(node)) {
        resize.unobserve(node);
        observed.delete(node);
      }
    for (const node of next)
      if (!observed.has(node)) {
        resize.observe(node);
        observed.add(node);
      }
  }
  const mutation = new MutationObserver(() => {
    observeMeasurements();
    schedule({ layoutOnly: true });
  });
  mutation.observe(root, { childList: true });
  function onVisibility() {
    activityRevision++;
    updateMotion();
    if (!document.hidden) refreshNativeActivity();
  }
  function onBlur() {
    activityRevision++;
    focused = false;
    updateMotion();
  }
  function onFocus() {
    activityRevision++;
    focused = true;
    minimized = false;
    nativeVisible = true;
    updateMotion();
    refreshNativeActivity();
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  reduced.addEventListener('change', onVisibility);
  const nativeWindow = window.__TAURI__?.window?.getCurrentWindow?.();
  async function refreshNativeActivity() {
    if (!nativeWindow || destroyed) return;
    const revision = ++activityRevision;
    try {
      const [isFocused, isMinimized, isVisible] = await Promise.all([
        nativeWindow.isFocused?.() ?? focused,
        nativeWindow.isMinimized?.() ?? minimized,
        nativeWindow.isVisible?.() ?? nativeVisible,
      ]);
      if (destroyed || revision !== activityRevision) return;
      focused = isFocused;
      minimized = isMinimized;
      nativeVisible = isVisible;
      updateMotion();
    } catch {
      /* The window may be closing; keep the latest event-derived state. */
    }
  }
  nativeWindow
    ?.onFocusChanged?.(({ payload }) => {
      activityRevision++;
      focused = payload;
      if (payload) {
        minimized = false;
        nativeVisible = true;
      }
      updateMotion();
    })
    .then((unlisten) => {
      if (destroyed) unlisten();
      else cleanups.push(unlisten);
    })
    .catch(() => {});
  nativeWindow
    ?.onResized?.(refreshNativeActivity)
    .then((unlisten) => {
      if (destroyed) unlisten();
      else cleanups.push(unlisten);
    })
    .catch(() => {});
  refreshNativeActivity();
  observeMeasurements();
  schedule();
  return {
    update,
    pause() {
      activityRevision++;
      minimized = true;
      updateMotion();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      finishAll();
      records.forEach(remove);
      resize.disconnect();
      mutation.disconnect();
      cleanups.forEach((unlisten) => unlisten());
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      reduced.removeEventListener('change', onVisibility);
      layer.remove();
    },
  };
}
