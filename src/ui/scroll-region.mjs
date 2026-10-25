import { el } from './dom.mjs';
import { icon } from './icons.mjs';

const disposers = new WeakMap();

// Edge controls overlay the viewport without changing scroll height or card positions.
export function createScrollRegion(content, { className = '', label = '内容', topInset = () => 0 } = {}) {
  const region = el('div', `scroll-region ${className}`.trim());
  content.classList.add('scroll-region-content');
  content.tabIndex = 0;
  content.setAttribute('aria-label', `${label}列表`);
  const controls = [-1, 1].map((direction) => {
    const edge = direction < 0 ? '上' : '下';
    const button = el('button', `scroll-edge-hint is-${direction < 0 ? 'above' : 'below'}`);
    button.type = 'button';
    button.hidden = true;
    button.setAttribute('aria-label', `向${edge}滚动，查看${edge}方${label}`);
    button.innerHTML = icon('chevron');
    button.addEventListener('click', () => {
      content.scrollBy({
        top: direction * Math.max(80, content.clientHeight * 0.7),
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
    });
    return button;
  });
  region.append(content, ...controls);
  let frame = 0,
    disposed = false;
  function update() {
    frame = 0;
    if (disposed || !region.isConnected || !content.clientHeight) return;
    const above = content.scrollTop > 2;
    const below = content.scrollHeight - content.clientHeight - content.scrollTop > 2;
    region.style.setProperty('--scroll-hint-top-inset', `${topInset(content)}px`);
    region.classList.toggle('has-more-above', above);
    region.classList.toggle('has-more-below', below);
    controls.forEach((button, i) => {
      const visible = i === 0 ? above : below;
      // Keep keyboard focus in the scroll area when its edge control disappears.
      if (!visible && document.activeElement === button) content.focus({ preventScroll: true });
      button.hidden = !visible;
    });
  }
  function schedule() {
    if (!disposed && !frame) frame = requestAnimationFrame(update);
  }
  const resize = new ResizeObserver(schedule);
  const watched = new Set();
  function watchChildren() {
    const next = new Set(content.children);
    for (const child of watched)
      if (!next.has(child)) {
        resize.unobserve(child);
        watched.delete(child);
      }
    for (const child of next)
      if (!watched.has(child)) {
        resize.observe(child);
        watched.add(child);
      }
    schedule();
  }
  const mutation = new MutationObserver(watchChildren);
  mutation.observe(content, { childList: true });
  resize.observe(content);
  watchChildren();
  content.addEventListener('scroll', schedule, { passive: true });
  disposers.set(region, () => {
    disposed = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutation.disconnect();
    content.removeEventListener('scroll', schedule);
  });
  return region;
}

export function disposeScrollRegion(region) {
  disposers.get(region)?.();
  disposers.delete(region);
}
