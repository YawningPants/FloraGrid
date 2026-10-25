// Prune unfinished blank drafts without copying unchanged task objects and metadata.
// The storage queue takes one deep snapshot synchronously before any async work.
export function getPersistableTasks(items = []) {
  let result = null;
  items.forEach((task, index) => {
    const children = getPersistableTasks(task.children || []);
    const keep =
      Boolean(typeof task.title === 'string' && task.title.trim()) ||
      Boolean(task.tags?.length) ||
      Boolean(children.length) ||
      task.status !== 'active';
    const changed = children !== task.children;
    if ((!keep || changed) && !result) result = items.slice(0, index);
    if (keep && result) result.push(changed ? { ...task, children } : task);
  });
  return result || items;
}
