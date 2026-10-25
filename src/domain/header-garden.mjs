import { cubicPoint, cubicTangent } from './plant-geometry.mjs';

export function gardenCapacity(width) {
  return width < 360 ? 10 : width < 520 ? 14 : 18;
}

// Extra anchors cost no SVG nodes. The first anchors retain existing layouts;
// the final 3/4/4 let an arrival grow elsewhere while its predecessor fades out.
const gardenAnchors = {
  6: [0.79, 0.15, 0.51, 0.94, 0.34, 0.65, 0.07, 0.25, 0.87],
  8: [0.8, 0.13, 0.47, 0.94, 0.3, 0.64, 0.06, 0.57, 0.22, 0.38, 0.72, 0.87],
  12: [0.82, 0.13, 0.49, 0.95, 0.31, 0.66, 0.06, 0.57, 0.23, 0.73, 0.4, 0.89, 0.17, 0.35, 0.46, 0.61],
};
// Two depth layers share a generous anchor pool, so arrivals do not replace a
// departing flower in the same place. Legacy capacities remain valid for cached layouts.
const layeredAnchors = [
  0.8, 0.13, 0.47, 0.94, 0.3, 0.64, 0.06, 0.57, 0.22, 0.38, 0.72, 0.87, 0.17, 0.35, 0.52, 0.91, 0.25, 0.68,
  0.1, 0.43, 0.6, 0.97, 0.04, 0.83, 0.2, 0.55, 0.75, 0.33,
];
for (const capacity of [10, 14, 18]) gardenAnchors[capacity] = layeredAnchors.slice(0, capacity + 8);
export function gardenFrontCapacity(capacity) {
  return capacity === 10 ? 6 : capacity === 14 ? 8 : capacity === 18 ? 10 : Math.ceil(capacity * 0.6);
}
export function gardenTaskLayers(tasks, capacity) {
  return new Map(
    tasks.map((task, index) => [task.id, index < gardenFrontCapacity(capacity) ? 'front' : 'back']),
  );
}
export function gardenSlotCount(capacity) {
  return gardenAnchors[capacity].length;
}

export function gardenSeed(value) {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function completionTime(task) {
  return Number.isSafeInteger(task.completedAt) &&
    task.completedAt > 0 &&
    task.completedAt < Number.MAX_SAFE_INTEGER
    ? task.completedAt
    : 0;
}

function visitTasks(items, visit) {
  for (const task of items) {
    visit(task);
    visitTasks(task.children || [], visit);
  }
}

// A monotonic stamp preserves completion order even after rapid clicks or a clock adjustment.
// Old tasks need no migration; their ID provides a deterministic fallback order.
export function recordTaskCompletion(task, items, now = Date.now()) {
  let latest = 0;
  visitTasks(items, (item) => {
    latest = Math.max(latest, completionTime(item));
  });
  task.completedAt = Math.max(now, latest + 1);
}

export function selectGardenTasks(items, capacity) {
  const tasks = [];
  let total = 0;
  const compare = (a, b) =>
    b.time - a.time || b.seed - a.seed || (a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0);
  // Keep only the small visible set instead of sorting or drawing every completed task.
  visitTasks(items, (task) => {
    if (task.status !== 'completed') return;
    total++;
    const candidate = { task, time: completionTime(task), seed: gardenSeed(task.id) };
    const at = tasks.findIndex((other) => compare(candidate, other) < 0);
    if (at >= 0) tasks.splice(at, 0, candidate);
    else if (tasks.length < capacity) tasks.push(candidate);
    if (tasks.length > capacity) tasks.pop();
  });
  return { tasks: tasks.map((entry) => entry.task), total };
}

export function reconcileGardenSlots(tasks, previous, capacity, { reserved = [] } = {}) {
  const positions = gardenAnchors[capacity],
    count = positions.length;
  const slots = new Map(),
    used = new Set();
  const selected = new Set(tasks.map((task) => task.id));
  const departing = [...previous].filter(([id]) => !selected.has(id)).map(([, slot]) => slot);
  const blocked = new Set(
    [...departing, ...reserved].filter((slot) => Number.isInteger(slot) && slot >= 0 && slot < count),
  );
  for (const task of tasks) {
    const slot = previous.get(task.id);
    if (Number.isInteger(slot) && slot >= 0 && slot < count && !used.has(slot)) {
      slots.set(task.id, slot);
      used.add(slot);
    }
  }
  for (const task of tasks) {
    if (slots.has(task.id)) continue;
    const free = positions.map((_, i) => i).filter((i) => !used.has(i) && !blocked.has(i));
    const candidates = free.length ? free : positions.map((_, i) => i).filter((i) => !used.has(i));
    const score = (slot) => {
      const separation = Math.min(
        ...[...blocked].map((other) => Math.abs(positions[slot] - positions[other])),
      );
      const clearance = used.size
        ? Math.min(...[...used].map((other) => Math.abs(positions[slot] - positions[other])))
        : 0.2;
      return separation + clearance;
    };
    // Fresh days fill the balanced anchor order. Replacements favour a distant free
    // point; existing flowers keep their exact slots, including anchors from the reserve.
    const slot = blocked.size
      ? candidates.reduce((best, i) => (best === undefined || score(i) > score(best) ? i : best), undefined)
      : candidates[0];
    if (slot === undefined) break;
    slots.set(task.id, slot);
    used.add(slot);
  }
  return slots;
}

export function gardenPlantGeometry(id, slot, capacity, width, height) {
  const positions = gardenAnchors[capacity];
  const seed = gardenSeed(id);
  return {
    x: Math.round(positions[slot] * (width - 24) + 12),
    height: Math.round(Math.min(height - 16, 62 + (seed % 53))),
    bend: (seed % 19) - 9,
    size: 21 + (seed % 9),
    group: slot % 3,
  };
}

// One stable morphology per task. Separate random samples avoid the correlated modulo
// variations of sequential task IDs. The UI caches this profile for the plant's lifetime.
export function gardenPlantProfile(id) {
  let seed = gardenSeed(`${id}:foliage`);
  const random = () => {
    seed += 0x6d2b79f5;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const families = ['lance', 'oval', 'willow', 'spray'];
  const family = families[Math.floor(random() * families.length)];
  const count =
    family === 'oval'
      ? random() < 0.5
        ? 4
        : 6
      : (family === 'spray' ? 6 : family === 'lance' ? 5 : 4) + Math.floor(random() * 2);
  const firstSide = random() < 0.5 ? -1 : 1;
  const leaves = Array.from({ length: count }, (_, i) => {
    const upper = i / Math.max(1, count - 1);
    const length =
      (family === 'willow' ? 12 : family === 'spray' ? 7 : 9) + random() * (family === 'spray' ? 3 : 4);
    const level = family === 'oval' ? Math.floor(i / 2) / Math.max(1, count / 2 - 1) : upper;
    return {
      t: 0.18 + level * 0.59 + (random() - 0.5) * (family === 'spray' ? 0.09 : 0.025),
      side: firstSide * (family === 'spray' ? [1, -1, -1, 1, 1, -1, -1][i] : i % 2 ? -1 : 1),
      length: length * (1 - upper * 0.22),
      width:
        family === 'willow'
          ? 1.4 + random() * 0.8
          : family === 'oval'
            ? 2.8 + random() * 1.1
            : 1.9 + random() * 0.8,
      lift: (family === 'lance' ? 0.65 : 0.25) + random() * (family === 'willow' ? 0.3 : 0.45),
      petiole: (family === 'spray' ? 3 : 1.2) + random() * 1.7,
      curl: (random() - 0.5) * (family === 'willow' ? 3 : 1.6),
      back: random() < 0.38,
    };
  });
  return {
    family,
    leaves,
    lowerBend: (random() - 0.5) * 13,
    upperBend: (random() - 0.5) * 11,
    stroke: 1.05 + random() * 0.3,
  };
}

export function gardenFoliageGeometry(profile, height, bend) {
  const curve = [
    { x: 0, y: 8 },
    { x: profile.lowerBend - bend * 0.35, y: -height * 0.3 },
    { x: profile.upperBend + bend * 0.55, y: -height * 0.73 },
    { x: bend, y: -height },
  ];
  const point = (p) => `${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100}`;
  const offset = (p, direction, along, normal, across = 0) => ({
    x: p.x + direction.x * along + normal.x * across,
    y: p.y + direction.y * along + normal.y * across,
  });
  let stem = `M${point(curve[0])}C${curve.slice(1).map(point).join(' ')}`,
    front = '',
    back = '';
  // Short stems keep a few leaves rather than compressing seven blades into a small gap.
  const count = Math.min(profile.leaves.length, Math.max(4, Math.floor(height / 11)));
  profile.leaves.slice(0, count).forEach((leaf, index) => {
    const t = leaf.t + index * 0.59 * (1 / (count - 1) - 1 / (profile.leaves.length - 1));
    const root = cubicPoint(curve, t),
      tangent = cubicTangent(curve, t);
    const magnitude = Math.hypot(tangent.x, tangent.y) || 1;
    const up = { x: tangent.x / magnitude, y: tangent.y / magnitude },
      outward = { x: -up.y * leaf.side, y: up.x * leaf.side };
    const direction = {
      x: outward.x * Math.cos(leaf.lift) + up.x * Math.sin(leaf.lift),
      y: outward.y * Math.cos(leaf.lift) + up.y * Math.sin(leaf.lift),
    };
    const normal = { x: -direction.y, y: direction.x },
      base = offset(root, direction, leaf.petiole, normal);
    const tip = offset(base, direction, leaf.length, normal, leaf.curl);
    stem += `M${point(root)}Q${point(offset(root, direction, leaf.petiole * 0.45, normal, 0.35))} ${point(base)}`;
    const blade =
      profile.family === 'oval'
        ? `M${point(base)}C${point(offset(base, direction, leaf.length * 0.18, normal, leaf.width))} ${point(offset(base, direction, leaf.length * 0.6, normal, leaf.width * 1.2))} ${point(offset(base, direction, leaf.length * 0.85, normal, leaf.width * 0.75))}C${point(offset(base, direction, leaf.length * 1.12, normal, leaf.width * 0.45))} ${point(offset(base, direction, leaf.length * 1.12, normal, -leaf.width * 0.45))} ${point(offset(base, direction, leaf.length * 0.85, normal, -leaf.width * 0.75))}C${point(offset(base, direction, leaf.length * 0.5, normal, -leaf.width * 1.1))} ${point(offset(base, direction, leaf.length * 0.12, normal, -leaf.width * 0.85))} ${point(base)}Z`
        : `M${point(base)}C${point(offset(base, direction, leaf.length * 0.24, normal, leaf.width))} ${point(offset(base, direction, leaf.length * 0.73, normal, leaf.width + leaf.curl * 0.4))} ${point(tip)}C${point(offset(base, direction, leaf.length * 0.76, normal, -leaf.width * 0.72 + leaf.curl * 0.4))} ${point(offset(base, direction, leaf.length * 0.2, normal, -leaf.width * 0.8))} ${point(base)}Z`;
    if (leaf.back) back += blade;
    else front += blade;
  });
  // Every blade joins the exact stem curve through a short petiole. Two compound paths
  // provide depth without one DOM element, gradient, or animation per leaf.
  return { stem, front, back, leafCount: count };
}
