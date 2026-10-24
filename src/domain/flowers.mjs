export const flowerVariants = ['wild', 'daisy', 'cosmos', 'plum', 'star', 'camellia', 'clover', 'lotus', 'lily', 'aster'];
// Keep older ID-derived appearances stable when the random pool grows.
const historicalFlowerVariants = flowerVariants.slice(0, 6);
export const flowerTones = ['cream', 'rose', 'blue', 'lilac', 'apricot', 'sage'];

export function isTaskFlower(value) {
  return flowerVariants.includes(value?.variant) && flowerTones.includes(value?.tone);
}

// Older completed tasks get a stable appearance without rewriting their history.
export function getTaskFlower(task = {}) {
  if (isTaskFlower(task.flower)) return task.flower;
  const id = task.id || 'rizhi';
  return {
    variant: historicalFlowerVariants[hash(`${id}:flower`) % historicalFlowerVariants.length],
    tone: flowerTones[hash(`${id}:tone`) % flowerTones.length],
  };
}

// Choose once, then retain it through undo, reloads, and day/month views.
export function ensureTaskFlower(task, random = Math.random) {
  if (!isTaskFlower(task.flower)) {
    task.flower = {
      variant: flowerVariants[Math.min(flowerVariants.length - 1, Math.floor(random() * flowerVariants.length))],
      tone: flowerTones[Math.min(flowerTones.length - 1, Math.floor(random() * flowerTones.length))],
    };
  }
  return task.flower;
}

function hash(text) {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.codePointAt(0), 16777619);
  return value >>> 0;
}
