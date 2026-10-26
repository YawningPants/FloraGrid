export const taskStatusMeta = {
  active: { label: '进行中', symbol: '', order: 0 },
  completed: { label: '已完成', symbol: '✓', order: 1 },
  failed: { label: '已失败', symbol: '!', order: 2 },
  deleted: { label: '已删除', symbol: '×', order: 3 },
};

export function createBlankTask(parent = null) {
  return {
    id: `task-${crypto.randomUUID()}`,
    title: '',
    status: 'active',
    tags: [],
    collapsed: false,
    children: [],
    // A creation-time snapshot: later recoloring or moving either task stays independent.
    ...(parent?.color ? { color: parent.color } : {}),
  };
}

export function findTask(items, taskId) {
  for (const task of items) {
    if (task.id === taskId) {
      return task;
    }
    const child = findTask(task.children || [], taskId);
    if (child) {
      return child;
    }
  }
  return null;
}

export function removeTask(items, taskId) {
  const index = items.findIndex((task) => task.id === taskId);
  if (index !== -1) {
    items.splice(index, 1);
    return true;
  }

  return items.some((task) => removeTask(task.children || [], taskId));
}

export function getTaskLocation(items, taskId, parentId = null) {
  for (let index = 0; index < items.length; index += 1) {
    const task = items[index];
    if (task.id === taskId) {
      return { task, parentId, index };
    }
    const child = getTaskLocation(task.children || [], taskId, task.id);
    if (child) {
      return child;
    }
  }
  return null;
}

export function flattenTasks(items) {
  return items.flatMap((task) => [task, ...flattenTasks(task.children || [])]);
}

export function normalizeTaskTree(items) {
  return items.map((task) => ({
    ...task,
    color: typeof task.color === 'string' && task.color.trim() ? task.color : undefined,
    collapsed: Boolean(task.collapsed),
    children: normalizeTaskTree(task.children || []),
  }));
}

export function sortByStatus(items) {
  return [...items].sort(
    (a, b) =>
      taskStatusMeta[a.status].order - taskStatusMeta[b.status].order ||
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)),
  );
}

export function getRenderableTasks(items, showDeletedTasks) {
  return sortByStatus(items).filter((task) => showDeletedTasks || task.status !== 'deleted');
}

export function getVisibleTaskTree(items, { showDeletedTasks, searchQuery }) {
  const query = normalizeSearchQuery(searchQuery);
  const visibleItems = getRenderableTasks(items, showDeletedTasks);

  if (!query) {
    return visibleItems;
  }

  return visibleItems
    .map((task) => {
      const matchedChildren = getVisibleTaskTree(task.children || [], { showDeletedTasks, searchQuery });
      const matchesSelf = task.title.toLowerCase().includes(query);
      if (!matchesSelf && matchedChildren.length === 0) {
        return null;
      }
      return {
        ...task,
        children: matchedChildren,
      };
    })
    .filter(Boolean);
}

export function normalizeSearchQuery(searchQuery) {
  return searchQuery.trim().toLowerCase();
}

export function hasDescendant(task, descendantId) {
  if (!task?.children?.length) {
    return false;
  }
  return task.children.some((child) => child.id === descendantId || hasDescendant(child, descendantId));
}

export function hasActiveDescendant(task) {
  return (task.children || []).some((child) => child.status === 'active' || hasActiveDescendant(child));
}

// Reopening one descendant invalidates completion all the way to the root.
// Failed/deleted ancestors keep their explicit result; only completion is inherited here.
export function reopenCompletedAncestors(items, taskId) {
  const ancestors = [];
  function visit(tasks) {
    for (const task of tasks) {
      if (task.id === taskId) return true;
      ancestors.push(task);
      if (visit(task.children || [])) return true;
      ancestors.pop();
    }
    return false;
  }
  if (!visit(items)) return [];
  const reopened = [];
  for (let i = ancestors.length - 1; i >= 0; i--)
    if (ancestors[i].status === 'completed') {
      ancestors[i].status = 'active';
      reopened.push(ancestors[i]);
    }
  return reopened;
}

export function failActiveDescendants(task) {
  (task.children || []).forEach((child) => {
    if (child.status === 'active') {
      child.status = 'failed';
    }
    failActiveDescendants(child);
  });
}

export function canAcceptChildTask(task) {
  return task.status === 'active';
}

export function canEditTask(task) {
  return task.status === 'active';
}

export function canMoveTask(task, searchQuery) {
  return !normalizeSearchQuery(searchQuery) && task.status !== 'failed' && task.status !== 'deleted';
}
