import type { Edge } from "./federation.js";

export interface Point {
  x: number;
  y: number;
}
export interface NodeBox extends Point {
  name: string;
  layer: number;
  width: number;
  height: number;
}
const nodeWidth = 220,
  nodeHeight = 122,
  layerGap = 144,
  rowGap = 48;

/** Collapse build cycles before layering so their dependents still follow them. */
function buildLayers(names: string[], edges: Edge[]) {
  const adjacent = new Map(names.map((name) => [name, new Set<string>()]));
  for (const e of edges)
    if (e.type === "build") adjacent.get(e.from)!.add(e.to);
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    onStack = new Set<string>(),
    components: string[][] = [];
  function visit(name: string) {
    index.set(name, index.size);
    low.set(name, index.get(name)!);
    stack.push(name);
    onStack.add(name);
    for (const next of [...adjacent.get(name)!].sort()) {
      if (!index.has(next)) {
        visit(next);
        low.set(name, Math.min(low.get(name)!, low.get(next)!));
      } else if (onStack.has(next))
        low.set(name, Math.min(low.get(name)!, index.get(next)!));
    }
    if (low.get(name) === index.get(name)) {
      const component: string[] = [];
      let next: string;
      do {
        next = stack.pop()!;
        onStack.delete(next);
        component.push(next);
      } while (next !== name);
      components.push(component);
    }
  }
  for (const name of names) if (!index.has(name)) visit(name);
  const owner = new Map<string, number>();
  components.forEach((c, i) => c.forEach((n) => owner.set(n, i)));
  const children = components.map(() => new Set<number>()),
    incoming = components.map(() => 0),
    levels = components.map(() => 0);
  for (const e of edges) {
    const a = owner.get(e.from)!,
      b = owner.get(e.to)!;
    if (e.type === "build" && a !== b && !children[a].has(b)) {
      children[a].add(b);
      incoming[b]++;
    }
  }
  const queue = incoming.flatMap((count, i) => (count ? [] : [i]));
  for (let i = 0; i < queue.length; i++)
    for (const next of children[queue[i]]) {
      levels[next] = Math.max(levels[next], levels[queue[i]] + 1);
      if (--incoming[next] === 0) queue.push(next);
    }
  return new Map(names.map((name) => [name, levels[owner.get(name)!]]));
}

/** Round only channel corners; the curve stays inside their empty gutters. */
export function roundedRoute(points: Point[]) {
  const p = points.filter(
    (v, i) => !i || v.x !== points[i - 1].x || v.y !== points[i - 1].y,
  );
  let path = `M ${p[0].x} ${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1],
      b = p[i],
      c = p[i + 1];
    const ab = Math.hypot(b.x - a.x, b.y - a.y),
      bc = Math.hypot(c.x - b.x, c.y - b.y);
    const radius = Math.min(12, ab / 2, bc / 2);
    const before = {
      x: b.x - ((b.x - a.x) / ab) * radius,
      y: b.y - ((b.y - a.y) / ab) * radius,
    };
    const after = {
      x: b.x + ((c.x - b.x) / bc) * radius,
      y: b.y + ((c.y - b.y) / bc) * radius,
    };
    path += ` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`;
  }
  return path + ` L ${p.at(-1)!.x} ${p.at(-1)!.y}`;
}

export function layoutFederation(nodeNames: string[], inputEdges: Edge[]) {
  const names = [...new Set(nodeNames)].sort(),
    known = new Set(names);
  const edges = inputEdges
    .filter((e) => known.has(e.from) && known.has(e.to))
    .slice()
    .sort((a, b) => {
      const x = JSON.stringify([a.from, a.to, a.type, a.via ?? ""]),
        y = JSON.stringify([b.from, b.to, b.type, b.via ?? ""]);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  const levels = buildLayers(names, edges),
    layers: string[][] = [];
  for (const name of names) (layers[levels.get(name)!] ??= []).push(name);
  const rows = Math.max(1, ...layers.map((l) => l.length));
  const contentHeight = rows * nodeHeight + (rows - 1) * rowGap;
  const width = Math.max(
    380,
    layers.length * nodeWidth + Math.max(0, layers.length - 1) * layerGap + 160,
  );
  const height = Math.max(340, contentHeight + 148);
  const nodes: NodeBox[] = layers.flatMap((layer, column) =>
    layer.map((name, row) => ({
      name,
      layer: column,
      x: 80 + column * (nodeWidth + layerGap),
      y:
        84 +
        (contentHeight -
          (layer.length * nodeHeight + (layer.length - 1) * rowGap)) /
          2 +
        row * (nodeHeight + rowGap),
      width: nodeWidth,
      height: nodeHeight,
    })),
  );
  const boxes = new Map(nodes.map((n) => [n.name, n]));
  const routes = edges.map((edge, index) => {
    const a = boxes.get(edge.from)!,
      b = boxes.get(edge.to)!;
    // Bounded lanes keep dense graphs finite; selecting a node isolates its links.
    const lane = index % 7,
      port = 32 + lane * 8;
    const direction = Math.sign(b.layer - a.layer);
    const from = { x: a.x + (direction >= 0 ? nodeWidth : 0), y: a.y + port };
    const to = {
      x: b.x + (direction <= 0 ? nodeWidth : 0),
      y: b.y + (a === b ? 98 : port),
    };
    let points: Point[];
    if (direction === 0) {
      const x = a.x + nodeWidth + 26 + lane * 6;
      points = [from, { x, y: from.y }, { x, y: to.y }, to];
    } else if (Math.abs(b.layer - a.layer) === 1) {
      const x = (from.x + to.x) / 2 + (lane - 3) * 8;
      points = [from, { x, y: from.y }, { x, y: to.y }, to];
    } else {
      const x1 = from.x + direction * (26 + lane * 6),
        x2 = to.x - direction * (26 + lane * 6),
        y = 20 + lane * 7;
      points = [
        from,
        { x: x1, y: from.y },
        { x: x1, y },
        { x: x2, y },
        { x: x2, y: to.y },
        to,
      ];
    }
    return { edge, points, path: roundedRoute(points) };
  });
  return { nodes, routes, width, height };
}
