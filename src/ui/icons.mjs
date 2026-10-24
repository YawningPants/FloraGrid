const icons = {
  move: '<svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4M17 8l4 4-4 4"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>',
  'task-list': '<svg viewBox="0 0 24 24"><path d="m3 6 1.5 1.5L7 4.5M11 6h10M3 12h4m4 0h10M3 18h4m4 0h10"/></svg>',
  cake: '<svg viewBox="0 0 24 24"><path d="M4 12h16v9H4zM4 16c3 3 5-3 8 0s5-3 8 0M8 12V8m4 4V8m4 4V8M8 5V3m4 2V3m4 2V3"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21 3 12C-2 5 7-1 12 6c5-7 14-1 9 6Z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><path d="M7 3v4M17 3v4M4 9h16M5 5h14v15H5z"/></svg>',
  'calendar-arrow-down': '<svg viewBox="0 0 24 24"><path d="M7 3v4M17 3v4M4 9h16M5 5h14v15H5z"/><path d="m12 12v5"/><path d="m9 14 3 3 3-3"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M10 2h4l.5 2.2 1.6.7 1.9-1.2 2.8 2.8-1.2 1.9.7 1.6 2.2.5v4l-2.2.5-.7 1.6 1.2 1.9-2.8 2.8-1.9-1.2-1.6.7L14 22h-4l-.5-2.2-1.6-.7-1.9 1.2-2.8-2.8 1.2-1.9-.7-1.6-2.2-.5v-4l2.2-.5.7-1.6-1.2-1.9L6 3.7l1.9 1.2 1.6-.7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="m14 4 6 6-3 1-4 4v4l-2 2-2-6-6-2 2-2h4l4-4z"/></svg>',
  tag: '<svg viewBox="0 0 24 24"><path d="M4 11V5h6l10 10-6 6z"/><circle cx="8" cy="8" r="1"/></svg>',
  drag: '<svg viewBox="0 0 24 24"><path d="M9 5h1M14 5h1M9 12h1M14 12h1M9 19h1M14 19h1"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4l11-11-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2M8 10v8M12 10v8M16 10v8M7 7l1 14h8l1-14"/></svg>',
  fail: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  restore: '<svg viewBox="0 0 24 24"><path d="M9 7H5v4"/><path d="M5 7c2-2 4.2-3 7-3a8 8 0 1 1-7.4 11"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7V5h6l2 2h10v12H3z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
};

export function icon(name) {
  return icons[name] || '';
}
