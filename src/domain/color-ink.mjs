import { notebookTaskInks } from './notebook-theme.mjs';
// Task data keeps its chosen pastel. Paper surfaces use a separate ink shade
// with the same hue, rather than mixing every color into the theme's green.
const cache = new Map();
function rgb(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return null;
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}
function luminance(channels) {
  return channels
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}
export function contrastRatio(a, b) {
  const x = luminance(rgb(a)),
    y = luminance(rgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function taskColorInk(color) {
  const key = typeof color === 'string' ? color.toLowerCase() : '';
  if (notebookTaskInks[key]) return notebookTaskInks[key];
  if (cache.has(color)) return cache.get(color);
  const channels = rgb(color);
  if (!channels) return '#304239';
  const max = Math.max(...channels),
    min = Math.min(...channels),
    delta = max - min;
  const light = (max + min) / 2;
  let hue = 0;
  if (delta) {
    const [r, g, b] = channels;
    hue =
      (max === r
        ? (g - b) / delta + (g < b ? 6 : 0)
        : max === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4) / 6;
  }
  const saturation = delta ? Math.min(0.7, Math.max(0.32, delta / (1 - Math.abs(2 * light - 1)))) : 0;
  const shade = (l) => {
    const a = saturation * Math.min(l, 1 - l);
    return [0, 8, 4].map((n) => {
      const k = (n + hue * 12) % 12;
      return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
    });
  };
  let ink;
  for (let l = Math.min(light, 0.38); ; l -= 0.01) {
    ink =
      '#' +
      shade(Math.max(0, l))
        .map((c) => c.toString(16).padStart(2, '0'))
        .join('');
    if (contrastRatio(ink, '#ded8c8') >= 4.5 || l <= 0) break;
  }
  if (cache.size > 256) cache.clear();
  cache.set(color, ink);
  return ink;
}
