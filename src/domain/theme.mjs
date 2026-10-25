import { notebookPresets, notebookFlowerColors, notebookRoles } from './notebook-theme.mjs';
export const themePresets = [
  {
    id: 'morning',
    name: '海雾青',
    color: '#22343a',
    surface: '#2e4548',
    glow: '#83b8b3',
    warm: '#ceb78d',
    text: '#edf3ef',
    border: '#a9c8c2',
    success: '#a1ccad',
    danger: '#df9275',
    shadow: '#111f24',
  },
  {
    id: 'mist',
    name: '暮云蓝',
    color: '#283344',
    surface: '#344157',
    glow: '#a0b7d0',
    warm: '#d1bea2',
    text: '#eef2f6',
    border: '#b8cadd',
    success: '#a3c8b4',
    danger: '#df9579',
    shadow: '#17202d',
  },
  {
    id: 'apricot',
    name: '暖杏棕',
    color: '#3a312e',
    surface: '#4a3e39',
    glow: '#d0a995',
    warm: '#e0c08d',
    text: '#f5eee7',
    border: '#d9c5b5',
    success: '#b6c895',
    danger: '#df9173',
    shadow: '#221b1a',
  },
  {
    id: 'sage',
    name: '松影绿',
    color: '#2a3933',
    surface: '#374b40',
    glow: '#a1bea7',
    warm: '#d7c396',
    text: '#eff3eb',
    border: '#bdd1bd',
    success: '#add19f',
    danger: '#e09b79',
    shadow: '#17231d',
  },
  {
    id: 'rose',
    name: '雾玫灰',
    color: '#3d333c',
    surface: '#4e404b',
    glow: '#c5a9bd',
    warm: '#d9bc9c',
    text: '#f3edf2',
    border: '#d5c2d0',
    success: '#aec9b0',
    danger: '#df9576',
    shadow: '#241b24',
  },
];

// Keep the original palettes intact for the minimal appearance.
const botanicalPresets = [
  {
    id: 'morning',
    name: '枝间雾',
    color: '#293a36',
    surface: '#354740',
    glow: '#adc2ad',
    warm: '#d4bd91',
    text: '#f1f2e7',
    border: '#b8c9b6',
    success: '#b4cba0',
    danger: '#df9678',
    shadow: '#17251f',
    petal: '#e6e4ca',
    center: '#c5a467',
    stem: '#9eb497',
  },
  {
    id: 'mist',
    name: '雨后蓝',
    color: '#2e3942',
    surface: '#3a4851',
    glow: '#a8bdc5',
    warm: '#d6c4a6',
    text: '#edf1ed',
    border: '#bccbd0',
    success: '#b2c7a9',
    danger: '#df9579',
    shadow: '#1d2830',
    petal: '#d8e6dc',
    center: '#c8b578',
    stem: '#a4bba9',
  },
  {
    id: 'apricot',
    name: '杏色光',
    color: '#40372f',
    surface: '#51453a',
    glow: '#ccb9a0',
    warm: '#ddc294',
    text: '#f4eee3',
    border: '#d6c7b1',
    success: '#bec9a0',
    danger: '#e09a7a',
    shadow: '#29231d',
    petal: '#f1dfb6',
    center: '#c8a174',
    stem: '#b5bd98',
  },
  {
    id: 'sage',
    name: '苔庭绿',
    color: '#303b31',
    surface: '#3e4b3c',
    glow: '#b1c19f',
    warm: '#d8c398',
    text: '#f0f1e4',
    border: '#c1ccb4',
    success: '#b8cda1',
    danger: '#dc9275',
    shadow: '#1d281e',
    petal: '#dfe6bf',
    center: '#c8b17c',
    stem: '#a4b98c',
  },
  {
    id: 'rose',
    name: '暮花粉',
    color: '#40373d',
    surface: '#51454b',
    glow: '#c4aeb7',
    warm: '#d8c0a1',
    text: '#f4edf0',
    border: '#d4c3cb',
    success: '#b7c6aa',
    danger: '#df9678',
    shadow: '#2b2227',
    petal: '#e8cbd1',
    center: '#d2b481',
    stem: '#acba9d',
  },
];

const themeStorageKey = 'desktop-calendar-theme';
export const defaultTheme = {
  presetId: 'morning',
  opacity: 0.84,
  appearance: 'botanical',
  completionMotion: true,
  gardenEnabled: true,
  surfaceStyle: 'notebook',
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
  const preset = getThemePreset(normalized.presetId, normalized.appearance, normalized.surfaceStyle);
  const root = document.documentElement;
  root.dataset.appearance = normalized.appearance;
  root.dataset.completionMotion = String(normalized.completionMotion);
  root.dataset.surfaceStyle = normalized.surfaceStyle;
  root.style.colorScheme = normalized.surfaceStyle === 'notebook' ? 'light' : 'dark';
  root.style.setProperty(
    '--flower-petal',
    normalized.surfaceStyle === 'notebook' ? notebookFlowerColors.cream : preset.petal || preset.success,
  );
  root.style.setProperty(
    '--flower-center',
    normalized.surfaceStyle === 'notebook' ? '#b78232' : preset.center || preset.warm,
  );
  if (normalized.surfaceStyle === 'notebook')
    Object.entries(notebookRoles(preset)).forEach(([role, value]) =>
      root.style.setProperty('--paper-' + role, value),
    );
  const flowerColors =
    normalized.surfaceStyle === 'notebook'
      ? notebookFlowerColors
      : {
          cream: '#e7dfba',
          rose: '#d9b1bb',
          blue: '#b2cbd5',
          lilac: '#c7badb',
          apricot: '#e3c2a1',
          sage: '#bacb9e',
        };
  Object.entries(flowerColors).forEach(([tone, color]) => {
    root.style.setProperty(
      `--flower-${tone}`,
      normalized.surfaceStyle === 'notebook'
        ? color
        : `color-mix(in srgb, ${color} 76%, ${preset.petal || preset.success} 24%)`,
    );
  });
  root.style.setProperty('--branch-rgb', hexToRgbTriplet(preset.stem || preset.border));
  root.style.setProperty('--theme-base-rgb', hexToRgbTriplet(preset.color));
  root.style.setProperty('--theme-surface-rgb', hexToRgbTriplet(preset.surface));
  root.style.setProperty('--theme-glow-rgb', hexToRgbTriplet(preset.glow));
  root.style.setProperty('--theme-warm-rgb', hexToRgbTriplet(preset.warm));
  root.style.setProperty('--theme-text-rgb', hexToRgbTriplet(preset.text));
  root.style.setProperty('--theme-border-rgb', hexToRgbTriplet(preset.border));
  root.style.setProperty('--theme-success-rgb', hexToRgbTriplet(preset.success));
  root.style.setProperty('--theme-danger-rgb', hexToRgbTriplet(preset.danger));
  root.style.setProperty('--theme-shadow-rgb', hexToRgbTriplet(preset.shadow));
  root.style.setProperty('--theme-opacity', String(normalized.opacity));
  root.style.setProperty('--theme-top-opacity', String(Math.min(normalized.opacity + 0.04, 1)));
  root.style.setProperty('--theme-bottom-opacity', String(Math.min(normalized.opacity + 0.06, 1)));
  return normalized;
}

export function getThemePresets(appearance = 'botanical', surfaceStyle = 'glass') {
  if (surfaceStyle === 'notebook') return notebookPresets;
  return appearance === 'minimal' ? themePresets : botanicalPresets;
}

export function getThemePreset(id, appearance = 'botanical', surfaceStyle = 'glass') {
  const presets = getThemePresets(appearance, surfaceStyle);
  return presets.find((preset) => preset.id === id) || presets[0];
}

export function normalizeThemeSettings(settings) {
  const presetId = themePresets.some((preset) => preset.id === settings?.presetId)
    ? settings.presetId
    : defaultTheme.presetId;
  const opacity = Number.isFinite(Number(settings?.opacity))
    ? clamp(Number(settings.opacity), 0.34, 1)
    : defaultTheme.opacity;
  return {
    presetId,
    opacity: Number(opacity.toFixed(2)),
    appearance: settings?.appearance === 'minimal' ? 'minimal' : defaultTheme.appearance,
    // Migrate the old switch to the garden; task bloom always follows system motion preferences.
    completionMotion: true,
    gardenEnabled:
      typeof settings?.gardenEnabled === 'boolean'
        ? settings.gardenEnabled
        : settings?.completionMotion !== false,
    // Existing saved themes without this newer field keep their original glass style.
    surfaceStyle:
      settings == null
        ? defaultTheme.surfaceStyle
        : settings?.surfaceStyle === 'notebook'
          ? 'notebook'
          : 'glass',
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
