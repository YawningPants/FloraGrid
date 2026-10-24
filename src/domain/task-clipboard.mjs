const clipboardKey = 'desktop-calendar:task-clipboard';
const clipboardVersion = 1;

export function copyTask({ sourceDate, task }) {
  if (!sourceDate || !task || task.status === 'deleted') {
    return null;
  }

  const payload = {
    version: clipboardVersion,
    sourceDate,
    task: structuredClone(task),
    copiedAt: Date.now(),
  };
  window.localStorage.setItem(clipboardKey, JSON.stringify(payload));
  return payload;
}

export function readTaskClipboard() {
  try {
    const payload = JSON.parse(window.localStorage.getItem(clipboardKey) || 'null');
    if (payload?.version !== clipboardVersion || !payload.sourceDate || !payload.task) {
      return null;
    }
    return payload;
  } catch {
    window.localStorage.removeItem(clipboardKey);
    return null;
  }
}

export function canPasteToDate(targetDate) {
  const payload = readTaskClipboard();
  return Boolean(payload && targetDate && payload.sourceDate !== targetDate);
}

export function createPastedTaskFromClipboard() {
  const payload = readTaskClipboard();
  if (!payload) {
    return null;
  }
  return cloneTaskWithNewIds(payload.task);
}

function cloneTaskWithNewIds(task) {
  const copy = structuredClone(task);
  delete copy.reminder;
  return {
    ...copy,
    id: `task-${crypto.randomUUID()}`,
    children: (task.children || []).map(cloneTaskWithNewIds),
  };
}
