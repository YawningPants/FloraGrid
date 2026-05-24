import { el, escapeHtml } from './dom.mjs';
import { icon } from './icons.mjs';

export function createWindowTitleBar({
  title,
  className = '',
  pin = null,
  onMinimize = null,
  onClose = null,
} = {}) {
  const titleBar = el('header', `window-titlebar${className ? ` ${className}` : ''}`);
  titleBar.setAttribute('data-tauri-drag-region', '');
  titleBar.innerHTML = `
    <div class="window-name">
      <span class="window-dot"></span>
      <span>${escapeHtml(title || '')}</span>
    </div>
    <div class="window-controls">
      ${pin ? `<button class="window-control pin" type="button" title="${escapeHtml(pin.label)}" aria-label="${escapeHtml(pin.label)}" aria-pressed="${pin.active}">${icon('pin')}</button>` : ''}
      <button class="window-control minimize" type="button" title="最小化" aria-label="最小化"></button>
      <button class="window-control close" type="button" title="关闭" aria-label="关闭"></button>
    </div>
  `;

  const pinButton = titleBar.querySelector('.pin');
  pinButton?.classList.toggle('is-active', Boolean(pin?.active));
  pinButton?.addEventListener('click', async (event) => {
    await pin?.onToggle?.(event.currentTarget);
  });

  titleBar.querySelector('.minimize')?.addEventListener('click', () => {
    onMinimize?.();
  });
  titleBar.querySelector('.close')?.addEventListener('click', () => {
    onClose?.();
  });

  return titleBar;
}
