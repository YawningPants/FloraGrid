import test from 'node:test';
import assert from 'node:assert/strict';
import { taskColorInk, contrastRatio } from '../src/domain/color-ink.mjs';
import { tagColors } from '../src/domain/tags.mjs';
import { notebookPresets, notebookFlowerColors, notebookTaskInks } from '../src/domain/notebook-theme.mjs';
import { normalizeThemeSettings } from '../src/domain/theme.mjs';

test('paper task inks retain distinct hues and remain readable on the darkest paper base', () => {
  for (const invalid of [null, 123, {}, 'not-a-color']) assert.match(taskColorInk(invalid), /^#[0-9a-f]{6}$/);
  const shades = tagColors.map(taskColorInk);
  assert.equal(new Set(shades).size, tagColors.length);
  for (const color of [...tagColors, '#ffffff', '#000000', '#ffdd00', '#18eedd', '#ff00ee', '#112233']) {
    const ink = taskColorInk(color);
    assert.match(ink, /^#[0-9a-f]{6}$/);
    assert.ok(contrastRatio(ink, '#ded8c8') >= 4.5, `${color} → ${ink}`);
    assert.equal(taskColorInk(color), ink);
  }
});
test('legacy motion setting migrates to the garden toggle without disabling task bloom', () => {
  assert.equal(normalizeThemeSettings({ completionMotion: false }).gardenEnabled, false);
  assert.equal(normalizeThemeSettings({ completionMotion: false }).completionMotion, true);
  assert.equal(normalizeThemeSettings({ gardenEnabled: true, completionMotion: false }).gardenEnabled, true);
  assert.equal(normalizeThemeSettings({ gardenEnabled: false }).completionMotion, true);
  assert.equal(normalizeThemeSettings({}).gardenEnabled, true);
});

test('paper today stamp ink has strong contrast in every palette and flowers have no green hue', () => {
  for (const preset of notebookPresets) {
    assert.ok(contrastRatio(preset.accent, '#fffaf0') >= 4.5, preset.id);
    assert.notEqual(preset.danger, notebookTaskInks['#d09aac']);
  }
  for (const [tone, color] of Object.entries(notebookFlowerColors)) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    assert.ok(!(g > r && g > b), `${tone} must not be a green petal`);
  }
  assert.equal(Object.keys(notebookFlowerColors).length, 6, 'legacy flower tone slots remain compatible');
});

test('new installations default to botanical paper; saved legacy glass preferences are retained', () => {
  const fresh = normalizeThemeSettings(null);
  assert.equal(fresh.appearance, 'botanical');
  assert.equal(fresh.surfaceStyle, 'notebook');
  assert.equal(normalizeThemeSettings({ presetId: 'mist', opacity: 0.8 }).surfaceStyle, 'glass');
  assert.equal(normalizeThemeSettings({ surfaceStyle: 'glass' }).surfaceStyle, 'glass');
});
