import { el } from './dom.mjs';

let disposeCurrent = null;

export function showNotice(message, { duration = 3200 } = {}) {
  disposeCurrent?.();
  const toast = el('div', 'toast task-notice');
  toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite'); toast.setAttribute('aria-atomic', 'true');
  const mark = el('span', 'notice-mark'); mark.setAttribute('aria-hidden', 'true'); mark.textContent = '!';
  const text = el('span', 'notice-text'); text.textContent = message;
  toast.append(mark, text); document.body.append(toast);
  const position = () => {
    const notes = document.querySelector('.daily-notes');
    const bottom = notes ? Math.max(20, innerHeight - notes.getBoundingClientRect().top + 12) : 24;
    toast.style.bottom = `${Math.min(bottom, Math.max(24, innerHeight * .5))}px`;
  };
  position(); window.addEventListener('resize', position);
  let removal = 0;
  const timer = setTimeout(() => {
    toast.classList.add('is-hiding'); removal = setTimeout(dispose, 180);
  }, duration);
  function dispose() {
    clearTimeout(timer); clearTimeout(removal); toast.remove();
    window.removeEventListener('resize', position);
    if (disposeCurrent === dispose) disposeCurrent = null;
  }
  disposeCurrent = dispose;
}
