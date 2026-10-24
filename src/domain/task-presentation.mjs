// Product decision: keep child-tag rendering/editing available, but dormant.
// Change this to true to restore child and inherited tags in the day view.
// Stored child tags, inheritance/search logic, and clipboard data are untouched.
// 子任务标签暂时停用，数据不删除；改为 true 即恢复原来的展示和编辑入口。
export const childTaskTagsEnabled = false;

export function canPresentTaskTags(depth, enabled = childTaskTagsEnabled) {
  return depth === 0 || enabled;
}
