import { el } from './dom.mjs';

// Small vector marks; no images, background loops, or additional WebViews.
export function flowerMarkup() {
  const petal = 'M0-1.6C-2.7-2.7-5-6.6-2.8-9.2C-.5-11.5 3.8-10.2 3.5-7.5C3.2-4.9 1.8-2.6 0-1.6Z';
  return `<svg class="completion-flower" viewBox="-12 -12 24 24" aria-hidden="true" focusable="false">
    <g class="flower-petals">${Array.from({ length: 5 }, (_, i) => `<g transform="rotate(${i * 72})"><path class="flower-petal" d="${petal}"/></g>`).join('')}</g>
    <circle class="flower-center" r="2.2"/>
  </svg>`;
}

export function completionMarkup(appearance = document.documentElement.dataset.appearance) {
  return appearance === 'minimal' ? '<span class="completion-check" aria-hidden="true">✓</span>' : flowerMarkup();
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
