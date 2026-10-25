// One continuous stem, with forks whose first tangent follows that same stem.
// Layout positions (not animated screen rectangles) are supplied by the view.
export function taskBranchGeometry(anchor, leaves) {
  if (!leaves.length) return null;
  const start = { x: anchor.x, y: anchor.y };
  const end = { x: anchor.x, y: Math.max(start.y + 12, leaves.at(-1).y - 14) };
  const length = end.y - start.y;
  const curve = [
    start,
    { x: start.x - 5, y: start.y + length / 3 },
    { x: start.x + 5, y: start.y + (length * 2) / 3 },
    end,
  ];
  const forks = leaves.map((leaf) => {
    const t = Math.max(0, Math.min(1, (leaf.y - 14 - start.y) / length));
    const root = cubicPoint(curve, t);
    const tangent = cubicTangent(curve, t);
    const scale = Math.hypot(tangent.x, tangent.y) || 1;
    return {
      id: leaf.id,
      t,
      curve: [
        root,
        { x: root.x + (tangent.x / scale) * 8, y: root.y + (tangent.y / scale) * 8 },
        { x: leaf.x - 10, y: leaf.y + 2 },
        { x: leaf.x, y: leaf.y },
      ],
    };
  });
  return { curve, forks };
}

export function cubicPoint([a, b, c, d], t) {
  const s = 1 - t;
  return {
    x: s ** 3 * a.x + 3 * s * s * t * b.x + 3 * s * t * t * c.x + t ** 3 * d.x,
    y: s ** 3 * a.y + 3 * s * s * t * b.y + 3 * s * t * t * c.y + t ** 3 * d.y,
  };
}

export function cubicTangent([a, b, c, d], t) {
  const s = 1 - t;
  return {
    x: 3 * s * s * (b.x - a.x) + 6 * s * t * (c.x - b.x) + 3 * t * t * (d.x - c.x),
    y: 3 * s * s * (b.y - a.y) + 6 * s * t * (c.y - b.y) + 3 * t * t * (d.y - c.y),
  };
}
