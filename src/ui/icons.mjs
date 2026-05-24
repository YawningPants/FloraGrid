const icons = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><path d="M7 3v4M17 3v4M4 9h16M5 5h14v15H5z"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0 4.9 4.9l-8.7 8.7a2.1 2.1 0 0 1-3-3z"/><path d="m8.7 15.3 2 2"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="m14 4 6 6-3 1-4 4v4l-2 2-2-6-6-2 2-2h4l4-4z"/></svg>',
  tag: '<svg viewBox="0 0 24 24"><path d="M4 11V5h6l10 10-6 6z"/><circle cx="8" cy="8" r="1"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4l11-11-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2M8 10v8M12 10v8M16 10v8M7 7l1 14h8l1-14"/></svg>',
  fail: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  restore: '<svg viewBox="0 0 24 24"><path d="M9 7H5v4"/><path d="M5 7c2-2 4.2-3 7-3a8 8 0 1 1-7.4 11"/></svg>',
};

export function icon(name) {
  return icons[name] || '';
}
