import { el } from './dom.mjs';
import { getTaskFlower } from '../domain/flowers.mjs';

// Small vector marks; no images, background loops, or additional WebViews.
const petals = {
  wild: [5, 'M0-1.6C-2.7-2.7-5-6.6-2.8-9.2C-.5-11.5 3.8-10.2 3.5-7.5C3.2-4.9 1.8-2.6 0-1.6Z'],
  daisy: [8, 'M0-2C-1.9-4-2.3-8-1.3-10.2C-.6-11.5 1-11.6 1.7-10.2C2.5-8 1.8-4 0-2Z'],
  cosmos: [6, 'M0-1.7C-1.7-3-4.1-6.4-3.1-8C-2.5-9.3-1.2-9.7-.3-8.7C.8-9.7 2.4-9.3 2.9-8C3.7-6 1.7-3 0-1.7Z'],
  plum: [5, 'M0-1C-2.8-2.1-5-5.7-3.1-8.1C-1.2-10.4 2.6-10.3 4-7.8C5.3-5.2 2.7-2.2 0-1Z'],
  star: [6, 'M0-1.5C-2.1-3-3-5.7-2.2-7.8L0-11L2.2-7.8C3-5.7 2.1-3 0-1.5Z'],
  camellia: [6, 'M0-.8C-3-1.5-5.2-5.1-3.7-8C-2.2-10.8 2.5-11 4.1-8.1C5.8-5.2 3-1.6 0-.8Z'],
};

export function flowerMarkup(task) {
  const { variant, tone } = getTaskFlower(task);
  const [count, petal] = petals[variant];
  const ring = (n, size = 1, offset = 0, inner = false) => Array.from({ length: n }, (_, i) => `<g transform="rotate(${i * 360 / n + offset}) scale(${size})"><path class="flower-petal${inner ? ' flower-inner-petal' : ''}" d="${petal}"/></g>`).join('');
  return `<svg class="completion-flower" data-flower-variant="${variant}" data-flower-tone="${tone}" viewBox="-12 -12 24 24" aria-hidden="true" focusable="false">
    <g class="flower-petals">${ring(count)}${variant === 'camellia' ? ring(5, .58, 30, true) : ''}</g>
    <circle class="flower-center" r="${variant === 'daisy' ? 2.7 : variant === 'camellia' ? 1.8 : 2.1}"/>
  </svg>`;
}

export function completionMarkup(task, appearance = document.documentElement.dataset.appearance) {
  return appearance === 'minimal' ? '<span class="completion-check" aria-hidden="true">✓</span>' : flowerMarkup(task);
}

export function rootTaskMarkup() {
  return `<svg class="task-root-symbol" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 15V4M12 10C9 5 6 9 4 4M12 12C15 7 18 10 20 6M12 15C11 19 7 17 6 21M12 15C12 18 14 19 13 22M12 15C15 18 17 16 19 20"/>
    <circle class="root-heart" cx="12" cy="14" r="2"/>
  </svg>`;
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
  const title = el('p'); title.textContent = text; empty.append(title);
  if (detail) { const hint = el('span'); hint.textContent = detail; empty.append(hint); }
  return empty;
}

export function botanicalMotionEnabled(settings) {
  return settings.appearance === 'botanical' && settings.completionMotion
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function markNewShoot(row, settings) {
  if (!row || !botanicalMotionEnabled(settings)) return;
  row.classList.add('is-new-shoot');
  row.addEventListener('animationend', () => row.classList.remove('is-new-shoot'), { once: true });
}
