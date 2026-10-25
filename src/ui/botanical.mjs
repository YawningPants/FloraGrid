import { el } from './dom.mjs';
import { getTaskFlower } from '../domain/flowers.mjs';

// Shared vector marks with cached shapes; no images or additional WebViews.
const petals = {
  wild: [5, 'M0-1.6C-2.7-2.7-5-6.6-2.8-9.2C-.5-11.5 3.8-10.2 3.5-7.5C3.2-4.9 1.8-2.6 0-1.6Z'],
  daisy: [8, 'M0-2C-1.9-4-2.3-8-1.3-10.2C-.6-11.5 1-11.6 1.7-10.2C2.5-8 1.8-4 0-2Z'],
  cosmos: [6, 'M0-1.7C-1.7-3-4.1-6.4-3.1-8C-2.5-9.3-1.2-9.7-.3-8.7C.8-9.7 2.4-9.3 2.9-8C3.7-6 1.7-3 0-1.7Z'],
  plum: [5, 'M0-1C-2.8-2.1-5-5.7-3.1-8.1C-1.2-10.4 2.6-10.3 4-7.8C5.3-5.2 2.7-2.2 0-1Z'],
  star: [6, 'M0-1.5C-2.1-3-3-5.7-2.2-7.8L0-11L2.2-7.8C3-5.7 2.1-3 0-1.5Z'],
  camellia: [6, 'M0-.8C-3-1.5-5.2-5.1-3.7-8C-2.2-10.8 2.5-11 4.1-8.1C5.8-5.2 3-1.6 0-.8Z'],
  clover: [4, 'M0-1.5C-1.7-3-6-5-5-8C-4.4-10-1.3-10.2 0-8.3C1.4-10.2 4.4-10 5-8C6-5 1.7-3 0-1.5Z'],
  lotus: [7, 'M0-1.5C-2.7-3-3.3-7 0-11C3.3-7 2.7-3 0-1.5Z'],
  lily: [3, 'M0-1C-2.5-2-5-5-4-7C-2.5-6.7-1-8 0-11C1-8 2.5-6.7 4-7C5-5 2.5-2 0-1Z'],
  aster: [10, 'M0-2C-1.2-5-1.5-8 0-11C1.5-8 1.2-5 0-2Z'],
};
const flowerHeads = new Map();

// Keep the original 420 ms bloom, hold it briefly, then settle to a quiet 14 px mark.
// Only local flower feedback uses this timer; sorting and folding start immediately.
export const completionFeedbackDurationMs = 900;

export function flowerMarkup(task) {
  const { variant, tone } = getTaskFlower(task);
  const [count, petal] = petals[variant];
  const ring = (n, size = 1, offset = 0, inner = false) =>
    Array.from(
      { length: n },
      (_, i) =>
        `<g transform="rotate(${(i * 360) / n + offset}) scale(${size})"><path class="flower-petal${inner ? ' flower-inner-petal' : ''}" d="${petal}"/></g>`,
    ).join('');
  if (!flowerHeads.has(variant))
    flowerHeads.set(
      variant,
      `<g class="flower-petals">${ring(count)}${variant === 'camellia' ? ring(5, 0.58, 30, true) : variant === 'lily' ? ring(3, 0.7, 60, true) : ''}</g><circle class="flower-center" r="${variant === 'daisy' ? 2.7 : variant === 'camellia' ? 1.8 : 2.1}"/>`,
    );
  return `<svg class="completion-flower" data-flower-variant="${variant}" data-flower-tone="${tone}" viewBox="-12 -12 24 24" aria-hidden="true" focusable="false">${flowerHeads.get(variant)}</svg>`;
}

export function completionMarkup(task, appearance = document.documentElement.dataset.appearance) {
  return appearance === 'minimal'
    ? '<span class="completion-check" aria-hidden="true">✓</span>'
    : flowerMarkup(task);
}

export function sproutMarkup(className = '') {
  return `<svg class="botanical-sprout ${className}" viewBox="0 0 40 40" fill="none" aria-hidden="true" focusable="false">
    <path class="sprout-stem" d="M20 33C20 25 19 19 22 11"/>
    <path class="sprout-leaf" d="M20 24C10 25 7 19 8 14C15 13 20 17 20 24Z"/>
    <path class="sprout-leaf" d="M21 18C21 10 26 6 32 7C32 14 28 18 21 18Z"/>
    <path class="sprout-ground" d="M12 34Q20 32 28 34"/>
  </svg>`;
}

export function createBotanicalEmpty(text, detail = '') {
  const empty = el('div', 'botanical-empty');
  empty.innerHTML = sproutMarkup();
  const title = el('p');
  title.textContent = text;
  empty.append(title);
  if (detail) {
    const hint = el('span');
    hint.textContent = detail;
    empty.append(hint);
  }
  return empty;
}

export function botanicalMotionEnabled(settings) {
  return (
    settings.appearance === 'botanical' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function markNewShoot(row, settings) {
  if (!row || !botanicalMotionEnabled(settings)) return;
  row.classList.add('is-new-shoot');
  row.addEventListener('animationend', () => row.classList.remove('is-new-shoot'), { once: true });
}
