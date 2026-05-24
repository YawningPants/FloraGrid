export const themePresets = [
  {
    id: 'morning',
    name: '清晨青蓝',
    color: '#1e303a',
    glow: '#6faeb1',
    warm: '#eebe84',
  },
  {
    id: 'mist',
    name: '雾霭蓝灰',
    color: '#263545',
    glow: '#8ca8c4',
    warm: '#d8c7a3',
  },
  {
    id: 'apricot',
    name: '暖杏薄暮',
    color: '#3c302b',
    glow: '#c49a84',
    warm: '#e7bc82',
  },
  {
    id: 'sage',
    name: '鼠尾草绿',
    color: '#283a34',
    glow: '#94b79c',
    warm: '#d6c390',
  },
  {
    id: 'rose',
    name: '玫瑰烟粉',
    color: '#3b2f39',
    glow: '#c69aaa',
    warm: '#d7b38b',
  },
];

const themeStorageKey = 'desktop-calendar-theme';
const defaultTheme = {
  presetId: 'morning',
  opacity: 0.58,
};

export function loadThemeSettings() {
  try {
    return normalizeThemeSettings(JSON.parse(localStorage.getItem(themeStorageKey) || 'null'));
  } catch {
    return { ...defaultTheme };
  }
}

export function saveThemeSettings(settings) {
  const normalized = normalizeThemeSettings(settings);
  localStorage.setItem(themeStorageKey, JSON.stringify(normalized));
  return normalized;
}

export function applyThemeSettings(settings) {
  const normalized = normalizeThemeSettings(settings);
  const preset = getThemePreset(normalized.presetId);
  const root = document.documentElement;
  root.style.setProperty('--theme-base-rgb', hexToRgbTriplet(preset.color));
  root.style.setProperty('--theme-glow-rgb', hexToRgbTriplet(preset.glow));
  root.style.setProperty('--theme-warm-rgb', hexToRgbTriplet(preset.warm));
  root.style.setProperty('--theme-opacity', String(normalized.opacity));
  root.style.setProperty('--theme-top-opacity', String(Math.min(normalized.opacity + 0.04, 0.86)));
  root.style.setProperty('--theme-bottom-opacity', String(Math.min(normalized.opacity + 0.06, 0.9)));
  return normalized;
}

export function getThemePreset(id) {
  return themePresets.find((preset) => preset.id === id) || themePresets[0];
}

export function normalizeThemeSettings(settings) {
  const presetId = themePresets.some((preset) => preset.id === settings?.presetId)
    ? settings.presetId
    : defaultTheme.presetId;
  const opacity = Number.isFinite(Number(settings?.opacity))
    ? clamp(Number(settings.opacity), 0.34, 0.82)
    : defaultTheme.opacity;
  return {
    presetId,
    opacity: Number(opacity.toFixed(2)),
  };
}

function hexToRgbTriplet(hex) {
  const value = hex.replace('#', '');
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return `${red}, ${green}, ${blue}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
