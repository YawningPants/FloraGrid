import test from 'node:test';
import assert from 'node:assert/strict';
import { canPresentTaskTags, childTaskTagsEnabled } from '../src/domain/task-presentation.mjs';
import { flowerMarkup } from '../src/ui/botanical.mjs';
import { flowerVariants } from '../src/domain/flowers.mjs';

test('only root tags are presented by default; the retained child feature can be enabled', () => {
  assert.equal(childTaskTagsEnabled, false);
  assert.equal(canPresentTaskTags(0), true);
  for (const depth of [1,2,3,10]) {
    assert.equal(canPresentTaskTags(depth), false);
    assert.equal(canPresentTaskTags(depth, true), true);
  }
});

test('new flowers stay within the existing eleven-petal rendering ceiling', () => {
  for (const variant of flowerVariants) {
    const markup = flowerMarkup({flower:{variant,tone:'cream'}});
    assert.ok((markup.match(/class="flower-petal/g) || []).length <= 12); // includes the group name
    assert.equal(flowerMarkup({flower:{variant,tone:'cream'}}), markup);
  }
});
