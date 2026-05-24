export const tagColors = ['#8fb6d3', '#aaa0c8', '#d09aac', '#d0aa7e', '#c5b985', '#99b888', '#8fc2b9', '#abb9c2'];

const legacyTagColorMap = {
  '#58a6ff': '#8fb6d3',
  '#9b8cff': '#aaa0c8',
  '#ff7aa2': '#d09aac',
  '#f1a65a': '#d0aa7e',
  '#ffd166': '#c5b985',
  '#74c476': '#99b888',
  '#4cc9a7': '#8fc2b9',
  '#7fa6c9': '#8fb6d3',
  '#9f95bf': '#aaa0c8',
  '#c4879a': '#d09aac',
  '#c59b6d': '#d0aa7e',
  '#b7aa78': '#c5b985',
  '#89a879': '#99b888',
  '#7db0a7': '#8fc2b9',
  '#9aa8b5': '#abb9c2',
};

export function createTagSnapshot(text, color = tagColors[0], source = 'custom') {
  return {
    id: `tag-${crypto.randomUUID()}`,
    text: text.trim(),
    color,
    source,
  };
}

export function createTagTemplate(text, color = tagColors[0]) {
  return {
    id: `preset-${crypto.randomUUID()}`,
    text: text.trim(),
    color,
  };
}

export function createTagGroup(name) {
  return {
    id: `group-${crypto.randomUUID()}`,
    name: name.trim(),
    tags: [],
  };
}

export function normalizeTaskTags(tasks, fallbackPalette = {}) {
  tasks.forEach((task) => {
    task.tags = normalizeTags(task.tags || [], fallbackPalette);
    normalizeTaskTags(task.children || [], fallbackPalette);
  });
  return tasks;
}

export function normalizeTags(tags, fallbackPalette = {}) {
  return tags
    .map((tag) => {
      if (typeof tag === 'string') {
        return createTagSnapshot(tag, fallbackPalette[tag] || pickUnusedColor([]), 'legacy');
      }
      return {
        id: tag.id || `tag-${crypto.randomUUID()}`,
        text: (tag.text || tag.name || '').trim(),
        color: normalizeTagColor(tag.color || fallbackPalette[tag.text] || pickUnusedColor([])),
        source: tag.source || 'custom',
      };
    })
    .filter((tag) => tag.text);
}

export function normalizeTagTemplates(data) {
  const groups = Array.isArray(data?.groups) && data.groups.length > 0
    ? data.groups
    : createDefaultTagGroups();

  return {
    version: data?.version || 1,
    groups: groups.map((group) => ({
      id: group.id || `group-${crypto.randomUUID()}`,
      name: (group.name || '未命名分组').trim(),
      tags: Array.isArray(group.tags)
        ? group.tags.map((tag) => ({
            id: tag.id || `preset-${crypto.randomUUID()}`,
            text: (tag.text || tag.name || '').trim(),
            color: normalizeTagColor(tag.color || pickUnusedColor([])),
          })).filter((tag) => tag.text)
        : [],
    })),
  };
}

export function createDefaultTagGroups() {
  return [
    {
      id: 'group-work',
      name: '工作',
      tags: [
        { id: 'preset-meeting', text: '会议', color: '#8fb6d3' },
        { id: 'preset-code', text: '代码', color: '#aaa0c8' },
        { id: 'preset-review', text: '复盘', color: '#8fc2b9' },
        { id: 'preset-requirement', text: '需求', color: '#d0aa7e' },
      ],
    },
    {
      id: 'group-life',
      name: '生活',
      tags: [
        { id: 'preset-health', text: '健康', color: '#99b888' },
        { id: 'preset-family', text: '家庭', color: '#d09aac' },
        { id: 'preset-shopping', text: '购物', color: '#c5b985' },
      ],
    },
    {
      id: 'group-study',
      name: '学习',
      tags: [
        { id: 'preset-reading', text: '阅读', color: '#aaa0c8' },
        { id: 'preset-course', text: '课程', color: '#8fb6d3' },
      ],
    },
  ];
}

export function cloneTemplateAsSnapshot(template) {
  return createTagSnapshot(template.text, template.color, 'preset');
}

export function pickUnusedColor(existingTags = []) {
  const used = new Set(existingTags.map((tag) => tag.color));
  return tagColors.find((color) => !used.has(color)) || tagColors[existingTags.length % tagColors.length];
}

export function normalizeTagColor(color) {
  return legacyTagColorMap[color?.toLowerCase?.()] || color || tagColors[0];
}

export function getTagText(tag) {
  return typeof tag === 'string' ? tag : tag?.text || '';
}

export function getTagColor(tag, fallback = '#8da2b8') {
  if (typeof tag === 'string') {
    return fallback;
  }
  return tag?.color || fallback;
}
