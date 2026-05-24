export function el(tag, className) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}

export function appendHighlightedText(container, text, query) {
  if (!query) {
    container.textContent = text;
    return;
  }

  const lowerText = text.toLowerCase();
  let cursor = 0;
  let matchIndex = lowerText.indexOf(query, cursor);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      container.append(document.createTextNode(text.slice(cursor, matchIndex)));
    }

    const mark = el('mark', 'search-hit');
    mark.textContent = text.slice(matchIndex, matchIndex + query.length);
    container.append(mark);

    cursor = matchIndex + query.length;
    matchIndex = lowerText.indexOf(query, cursor);
  }

  if (cursor < text.length) {
    container.append(document.createTextNode(text.slice(cursor)));
  }
}

export function truncateText(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
