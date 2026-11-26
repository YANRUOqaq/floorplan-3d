/**
 * 分别沿横、竖两个方向统计深色像素的横截面。连续重复出现的截面能估计墙厚，
 * 也能在交接处截面突然变宽时保留原来的墙轴。沿轴恢复每一段实心墙，再从断点和
 * 邻近的细线识别洞口。房间用墙轴、封上的洞口和两端接墙的双线围出，沿有向边
 * 追踪闭合轮廓，因此顶点直接落在墙中线上，也不会把无界的外部当成房间。
 */

/** 灰度图按行存储，0 为黑，255 为白。 */
export interface Gray { w: number; h: number; data: Uint8Array }
type Point = [number, number];
/** 以像素表示墙中线和厚度。a 在左或上，b 在右或下。 */
export interface PxWall { a: Point; b: Point; t: number }
/** 沿墙中线的洞口，t 为洞口两侧墙厚的平均值。 */
export interface PxGap extends PxWall { kind: "window" | "door" | "open" }
/** 房间沿墙中线的正交轮廓，面积单位为平方像素。 */
export interface PxRoom { polygon: Point[]; area: number }
export interface Detection {
  walls: PxWall[];
  gaps: PxGap[];
  rooms: PxRoom[];
  /** 典型墙厚为像素值，0 表示图中缺乏可用于估计的墙截面。 */
  wallThickness: number;
}

interface Segment { h: boolean; c: number; lo: number; hi: number; t: number }
type Opening = Segment & { kind: PxGap["kind"] };
interface Scan { h: boolean; length: number; breadth: number; sums: Uint32Array; strips: Segment[] }

function scan(img: Gray, h: boolean, cutoff = 145): Scan {
  const length = h ? img.w : img.h;
  const breadth = h ? img.h : img.w;
  const stride = breadth + 1;
  const sums = new Uint32Array((length + 1) * stride);
  const strips: Segment[] = [];
  const active = new Map<number, Segment>();
  for (let u = 0; u <= length; u++) {
    let start = -1;
    for (let v = 0; v <= breadth; v++) {
      const dark = u < length && v < breadth && img.data[h ? v * img.w + u : u * img.w + v] <= cutoff;
      if (v < breadth) sums[u * stride + v + 1] = sums[u * stride + v] + Number(dark);
      if (dark) {
        if (start < 0) start = v;
      } else if (start >= 0) {
        const key = start * stride + v;
        const previous = active.get(key);
        if (previous?.hi === u) previous.hi++;
        else {
          if (previous && previous.hi - previous.lo >= 3) strips.push(previous);
          active.set(key, { h, c: (start + v) / 2, lo: u, hi: u + 1, t: v - start });
        }
        start = -1;
      }
    }
  }
  for (const run of active.values()) if (run.hi - run.lo >= 3) strips.push(run);
  return { h, length, breadth, sums, strips };
}

function typicalThickness(scans: Scan[]): number {
  const votes = new Map<number, number>();
  for (const { strips } of scans) for (const s of strips) {
    const length = s.hi - s.lo;
    // 一个墙截面会沿轴重复出现，字体笔画和尺寸线很少同时满足这两个条件。
    if (s.t <= 3 || length < 3 * s.t) continue;
    votes.set(s.t, (votes.get(s.t) ?? 0) + length * s.t ** 1.6);
  }
  let best = 0;
  let score = 0;
  for (const t of votes.keys()) {
    const weight = (votes.get(t) ?? 0) + 0.5 * ((votes.get(t - 1) ?? 0) + (votes.get(t + 1) ?? 0));
    if (weight > score) {
      best = t;
      score = weight;
    }
  }
  return best;
}

function solidSegments(scan: Scan, thickness: number): Segment[] {
  const { length, breadth, sums } = scan;
  const stride = breadth + 1;
  const result: Segment[] = [];
  const seeds = scan.strips.filter(s =>
    s.t >= Math.max(4, thickness * 0.4) && s.t <= thickness * 1.9 &&
    s.hi - s.lo >= Math.max(3, 0.5 * s.t),
  ).sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo));
  for (const seed of seeds) {
    const low = seed.c - seed.t / 2;
    const high = low + seed.t;
    const filled = (u: number) => sums[u * stride + high] - sums[u * stride + low] === seed.t;
    if (result.some(s => s.lo < seed.hi && s.hi > seed.lo &&
      Math.abs(s.c - seed.c) <= 1 && Math.abs(s.t - seed.t) <= 1)) continue;
    const s = { ...seed };
    while (s.lo > 0 && filled(s.lo - 1)) s.lo--;
    while (s.hi < length && filled(s.hi)) s.hi++;
    result.push(s);
  }
  // 薄墙截面可能穿过同轴的厚墙，按厚墙实测边界截断重复部分。
  return result.flatMap(s => {
    let pieces = [s];
    for (const thick of result) {
      if (thick.t <= s.t + 1 || Math.abs(thick.c - s.c) > 1) continue;
      pieces = pieces.flatMap(p => {
        if (p.hi <= thick.lo || p.lo >= thick.hi) return [p];
        const outside: Segment[] = [];
        if (p.lo < thick.lo) outside.push({ ...p, hi: thick.lo });
        if (p.hi > thick.hi) outside.push({ ...p, lo: thick.hi });
        return outside;
      });
    }
    return pieces.filter(p => p.hi - p.lo >= Math.max(3, 0.5 * p.t));
  });
}

function ink(img: Gray, h: boolean, u: number, v: number): boolean {
  const x = Math.floor(h ? u : v);
  const y = Math.floor(h ? v : u);
  return x >= 0 && x < img.w && y >= 0 && y < img.h && img.data[y * img.w + x] <= 145;
}

function gapKind(img: Gray, s: Segment): PxGap["kind"] {
  const width = s.hi - s.lo;
  for (let v = Math.floor(s.c - s.t / 2); v < s.c + s.t / 2; v++) {
    let hits = 0;
    for (let i = 0; i < 24; i++) {
      if (ink(img, s.h, s.lo + width * (0.1 + i * 0.8 / 24), v)) hits++;
    }
    if (hits >= 21) return "window";
  }
  for (const end of [s.lo, s.hi]) for (const side of [-1, 1]) {
    const margin = Math.ceil(s.t * 0.3);
    const edge = s.c + side * s.t / 2;
    for (let u = Math.floor(end) - margin; u <= Math.floor(end) + margin; u++) {
      let hits = 0;
      for (let i = 0; i < 20; i++) {
        const v = edge + side * width * (0.1 + i * 0.8 / 20);
        const probe = Math.max(3, s.t * 0.3);
        if (ink(img, s.h, u, v) && !(ink(img, s.h, u - probe, v) && ink(img, s.h, u + probe, v))) hits++;
      }
      if (hits >= 17) return "door";
    }
    // 采样门扇扫过的四分之一圆，允许抗锯齿和端点量化带来的偏移。
    const inward = end === s.lo ? 1 : -1;
    for (const center of [s.c, edge]) {
      let hits = 0;
      for (let i = 2; i <= 10; i++) {
        const angle = i * Math.PI / 24;
        const du = inward * Math.cos(angle);
        const dv = side * Math.sin(angle);
        const tolerance = Math.min(width * 0.08, 1 + s.t * 0.18);
        for (let r = -tolerance; r <= tolerance; r++) {
          if (!ink(img, s.h, end + du * (width + r), center + dv * (width + r))) continue;
          hits++;
          break;
        }
      }
      if (hits >= 7) return "door";
    }
  }
  return "open";
}

function connects(s: Segment, cross: Segment, end: number, tolerance: number): boolean {
  return cross.h !== s.h && Math.abs(cross.c - end) <= tolerance &&
    cross.lo - s.t / 2 - 1 <= s.c && cross.hi + s.t / 2 + 1 >= s.c;
}

function thinBoundaries(img: Gray, scans: Scan[], walls: Segment[], thickness: number) {
  const rails: Segment[] = [];
  const hollow: Segment[] = [];
  const windows: Segment[] = [];
  const singles: Segment[] = [];
  for (const { strips, sums, breadth, length } of scans) {
    const stride = breadth + 1;
    const unique = new Map<string, Segment>();
    for (const seed of strips) {
      if (seed.t > Math.max(3, Math.round(thickness * 0.23)) || seed.hi - seed.lo < thickness * 0.65) continue;
      const low = seed.c - seed.t / 2;
      const filled = (u: number) => sums[u * stride + low + seed.t] - sums[u * stride + low] === seed.t;
      const s = { ...seed };
      while (s.lo > 0 && filled(s.lo - 1)) s.lo--;
      while (s.hi < length && filled(s.hi)) s.hi++;
      if (s.hi - s.lo >= 1.2 * thickness) unique.set([s.c, s.lo, s.hi].join(","), s);
    }
    // 箭头和水印会在同一条窗线中切出缺口，按横截面合并短断点。
    const lines: Segment[] = [];
    for (const line of [...unique.values()].sort((a, b) => a.c - b.c || a.lo - b.lo)) {
      const last = lines.at(-1);
      if (last && last.c === line.c && last.t === line.t && line.lo - last.hi <= thickness * 0.48) {
        last.hi = Math.max(last.hi, line.hi);
      } else lines.push(line);
    }
    singles.push(...lines);
    for (let i = 0; i < lines.length; i++) {
      const a = lines[i];
      for (let j = i + 1; j < lines.length; j++) {
        const b = lines[j];
        const separation = b.c - a.c;
        if (separation > thickness * 1.32) break;
        if (separation < Math.max(a.t, b.t) + 1) continue;
        const lo = Math.max(a.lo, b.lo), hi = Math.min(a.hi, b.hi);
        if (hi - lo < 1.2 * thickness) continue;
        let strong = 0;
        for (let k = 1; k <= 7; k++) {
          const u = lo + (hi - lo) * k / 8;
          if ([a, b].some(line => {
            for (let v = line.c - line.t / 2; v < line.c + line.t / 2; v++) {
              if (ink(img, a.h, u, v)) return true;
            }
            return false;
          })) strong++;
        }
        if (strong < 5) continue;
        const s = { ...a, lo, hi, c: (a.c + b.c) / 2, t: separation };
        const inner = lines.slice(i + 1, j).some(q => q.lo <= lo + thickness && q.hi >= hi - thickness && q.c - a.c >= a.t / 2 + q.t / 2 + 1 && b.c - q.c >= b.t / 2 + q.t / 2 + 1);
        if (!inner && separation < thickness * 0.39 &&
          (Math.abs(a.lo - b.lo) > thickness || Math.abs(a.hi - b.hi) > thickness)) continue;
        const left = walls.find(w => connects(s, w, lo, w.t / 2 + thickness * 0.55));
        const right = walls.find(w => connects(s, w, hi, w.t / 2 + thickness * 0.55));
        if (walls.some(w => w.h === s.h && Math.abs(w.c - s.c) <= w.t / 2 &&
          Math.min(hi, w.hi) - Math.max(lo, w.lo) > 0.5 * (hi - lo))) continue;
        if (inner && separation >= thickness * 0.35) {
          windows.push(s);
        } else if (separation < thickness * 0.82 && left && right && left.c < right.c) {
          rails.push({ ...s, lo: left.c, hi: right.c });
        } else if (separation >= thickness * 0.39) {
          let clear = 0;
          for (let k = 1; k <= 9; k++) {
            const u = lo + (hi - lo) * k / 10;
            if ([0.28, 0.5, 0.72].every(f => !ink(img, a.h, u, a.c + f * separation))) clear++;
          }
          if (clear >= 6) hollow.push(s);
        }
      }
    }
  }
  const distinct = (segments: Segment[]) => {
    const result: Segment[] = [];
    for (const s of segments.sort((a, b) => b.hi - b.lo - (a.hi - a.lo) || b.t - a.t)) {
      if (!result.some(q => q.h === s.h && Math.abs(q.c - s.c) <= thickness * 0.48 &&
        Math.min(q.hi, s.hi) - Math.max(q.lo, s.lo) >= 0.65 * (s.hi - s.lo))) result.push(s);
    }
    return result;
  };
  return { rails: distinct(rails), hollow: distinct(hollow), windows: distinct(windows), singles };
}

function endpoints(s: Segment): PxWall {
  return { a: s.h ? [s.lo, s.c] : [s.c, s.lo], b: s.h ? [s.hi, s.c] : [s.c, s.hi], t: s.t };
}

function traceRooms(edges: Segment[], minimumArea: number): PxRoom[] {
  const vertices = new Map<string, Point>();
  const neighbors = new Map<Point, Point[]>();
  const vertex = (x: number, y: number): Point => {
    const key = x + "," + y;
    const existing = vertices.get(key);
    if (existing) return existing;
    const point: Point = [x, y];
    vertices.set(key, point);
    neighbors.set(point, []);
    return point;
  };
  // 在交叉点和重叠线的端点切开，得到无交叉的平面图。
  for (const s of edges) {
    const cuts = new Set([s.lo, s.hi]);
    for (const q of edges) {
      if (q.h !== s.h) {
        if (s.c >= q.lo && s.c <= q.hi && q.c > s.lo && q.c < s.hi) cuts.add(q.c);
      } else if (s.c === q.c) {
        for (const u of [q.lo, q.hi]) if (u > s.lo && u < s.hi) cuts.add(u);
      }
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const a = s.h ? vertex(sorted[i - 1], s.c) : vertex(s.c, sorted[i - 1]);
      const b = s.h ? vertex(sorted[i], s.c) : vertex(s.c, sorted[i]);
      if (!neighbors.get(a)!.includes(b)) {
        neighbors.get(a)!.push(b);
        neighbors.get(b)!.push(a);
      }
    }
  }
  const direction = (a: Point, b: Point) => b[0] > a[0] ? 0 : b[1] > a[1] ? 1 : b[0] < a[0] ? 2 : 3;
  for (const [a, next] of neighbors) next.sort((p, q) => direction(a, p) - direction(a, q));
  const visited = new Map<Point, Set<Point>>();
  const rooms: PxRoom[] = [];
  for (const [start, next] of neighbors) for (const first of next) {
    let a = start;
    let b = first;
    let twiceArea = 0;
    const loop: Point[] = [];
    while (!visited.get(a)?.has(b)) {
      if (!visited.has(a)) visited.set(a, new Set());
      visited.get(a)!.add(b);
      loop.push(a);
      twiceArea += a[0] * b[1] - b[0] * a[1];
      const turns = neighbors.get(b)!;
      const c = turns[(turns.indexOf(a) + turns.length - 1) % turns.length];
      a = b;
      b = c;
    }
    const area = twiceArea / 2;
    if (area < minimumArea) continue;
    // 悬空墙在轮廓上会原路折返，去掉这类零面积的折线。
    const outline: Point[] = [];
    for (const p of loop) {
      if (outline.at(-2) === p) outline.pop();
      else outline.push(p);
    }
    while (outline.length >= 3 && outline[1] === outline.at(-1)) {
      outline.shift();
      outline.pop();
    }
    const polygon = outline.filter((p, i) => {
      const prev = outline[(i + outline.length - 1) % outline.length];
      const next = outline[(i + 1) % outline.length];
      return prev[0] !== next[0] && prev[1] !== next[1] && p !== prev;
    });
    if (polygon.length >= 4) rooms.push({ polygon, area });
  }
  return rooms;
}

/** 两个已闭合空间共用一个凹角时，短边沿墙轴延伸可分出无实体隔断的过渡区。 */
function openPartitions(rooms: PxRoom[], thickness: number): Segment[] {
  const partitions: Segment[] = [];
  for (const { polygon } of rooms) {
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i];
      const before = polygon[(i + polygon.length - 1) % polygon.length];
      const after = polygon[(i + 1) % polygon.length];
      const turn = (p[0] - before[0]) * (after[1] - p[1]) - (p[1] - before[1]) * (after[0] - p[0]);
      if (turn >= 0 || !rooms.some(r => r.polygon !== polygon && r.polygon.includes(p))) continue;
      let shortest = 8.5 * thickness;
      let divider: Segment | undefined;
      for (const neighbor of [before, after]) {
        const axis = p[0] === neighbor[0] ? 1 : 0;
        const across = 1 - axis;
        const sign = Math.sign(p[axis] - neighbor[axis]);
        for (let j = 0; j < polygon.length; j++) {
          const a = polygon[j], b = polygon[(j + 1) % polygon.length];
          if (a[axis] !== b[axis] || p[across] <= Math.min(a[across], b[across]) ||
            p[across] >= Math.max(a[across], b[across])) continue;
          const distance = sign * (a[axis] - p[axis]);
          if (distance < 2.2 * thickness || distance > shortest) continue;
          shortest = distance;
          divider = { h: axis === 0, c: p[across], lo: Math.min(p[axis], a[axis]), hi: Math.max(p[axis], a[axis]), t: 0 };
        }
      }
      if (divider) partitions.push(divider);
    }
  }
  return partitions;
}

function isOpeningWidth(width: number, thickness: number): boolean {
  return width >= 1.7 * thickness && width <= 20.5 * thickness;
}

function overlapLength(s: Segment, q: Segment): number {
  return Math.min(s.hi, q.hi) - Math.max(s.lo, q.lo);
}

function visibleOpenings(gaps: Opening[], solid: Segment[], thickness: number): Opening[] {
  const result: Opening[] = [];
  for (const g of gaps) {
    const width = g.hi - g.lo;
    if (width <= 0) continue;
    const aligned = (q: Segment) => q.h === g.h && Math.abs(q.c - g.c) <= thickness * 0.45;
    if (result.some(q => aligned(q) && overlapLength(q, g) >= 0.84 * Math.max(q.hi - q.lo, width))) continue;
    let inkSamples = 0;
    for (let i = 0; i < 16; i++) {
      const u = g.lo + (i + 0.5) * width / 16;
      if (solid.some(q => aligned(q) && q.lo <= u && q.hi >= u)) inkSamples++;
    }
    if (inkSamples < 11) result.push(g);
  }
  return result;
}

function crossesInside(s: Segment, q: Segment, margin: number): boolean {
  return s.h !== q.h && q.c > s.lo + margin && q.c < s.hi - margin &&
    s.c > q.lo + margin && s.c < q.hi - margin;
}

function connectedWalls(walls: Segment[], thickness: number): Set<Segment> {
  const remaining = new Set(walls);
  const components: Segment[][] = [];
  while (remaining.size) {
    const root = remaining.values().next().value!;
    const group = [root];
    remaining.delete(root);
    for (const s of group) for (const q of remaining) {
      const related = s.h === q.h
        ? Math.abs(s.c - q.c) <= thickness * 0.25 &&
          Math.max(s.lo, q.lo) - Math.min(s.hi, q.hi) <= thickness * 20.5
        : [s.lo, s.hi].some(u => connects(s, q, u, q.t / 2 + thickness * 0.35)) ||
          [q.lo, q.hi].some(u => connects(q, s, u, s.t / 2 + thickness * 0.35));
      if (!related) continue;
      remaining.delete(q);
      group.push(q);
    }
    components.push(group);
  }
  const weight = (group: Segment[]) => group.reduce((sum, s) => sum + (s.hi - s.lo), 0);
  const largest = Math.max(0, ...components.map(weight));
  return new Set(components.filter(g => weight(g) >= largest * 0.12).flat());
}

function closeSupportedLines(img: Gray, edges: Segment[], supports: Segment[], singles: Segment[], thickness: number) {
  const repairs: Opening[] = [];
  const sameAxis = (s: Segment, q: Segment) => s.h === q.h && Math.abs(s.c - q.c) <= thickness * 0.6;
  const along = (s: Segment, lo: number, hi: number) =>
    Math.max(0, Math.min(s.hi, hi) - Math.max(s.lo, lo));
  for (const s of supports) for (const end of ["lo", "hi"] as const) {
    const u = s[end];
    const sign = end === "hi" ? 1 : -1;
    for (const q of supports) {
      const distance = sign * (q.c - u);
      if (q.h === s.h || distance < thickness * 0.6 || distance > thickness * 42 ||
        s.c < q.lo - thickness * 0.48 || s.c > q.hi + thickness * 0.48) continue;
      const lo = Math.min(u, q.c), hi = Math.max(u, q.c);
      if (edges.some(w => w.h !== s.h && w.c > lo + thickness && w.c < hi - thickness &&
        w.lo < s.c - thickness && w.hi > s.c + thickness)) continue;
      if (edges.some(w => sameAxis(s, w) && along(w, lo, hi) > distance * 0.78)) continue;
      const tracks = singles.filter(w => sameAxis(s, w) && along(w, lo, hi) > distance * 0.78);
      if (!tracks.length || edges.some(w => w !== s && sameAxis(s, w) &&
        (sign > 0 ? w.lo <= u && w.hi > u + thickness : w.hi >= u && w.lo < u - thickness))) continue;
      const gap = { ...s, lo, hi };
      const multi = tracks.some(w => tracks.some(v => Math.abs(w.c - v.c) >= Math.max(w.t, v.t) + 1));
      const atCorner = Math.min(Math.abs(q.lo - s.c), Math.abs(q.hi - s.c)) <= thickness * 0.75;
      if (!multi && (!atCorner || distance > thickness * 15 || gapKind(img, gap) === "open")) continue;
      repairs.push({ ...gap, kind: multi ? "window" : gapKind(img, gap) });
    }
  }
  // 两段平行墙的墙头可以作为横向开口的端点，入户门常这样画。
  for (let i = 0; i < supports.length; i++) for (const q of supports.slice(i + 1)) {
    const s = supports[i];
    const width = Math.abs(s.c - q.c);
    if (s.h !== q.h || width < thickness * 1.7 || width > thickness * 9) continue;
    for (const u of [s.lo, s.hi]) for (const v of [q.lo, q.hi]) {
      if (Math.abs(u - v) > thickness * 1.15) continue;
      const gap = { h: !s.h, c: (u + v) / 2, lo: Math.min(s.c, q.c), hi: Math.max(s.c, q.c), t: thickness };
      if (edges.some(w => sameAxis(gap, w) && along(w, gap.lo, gap.hi) >= width * 0.55)) continue;
      const tracks = singles.filter(w => sameAxis(gap, w) && along(w, gap.lo, gap.hi) >= width * 0.55);
      const continuous = tracks.filter(w => along(w, gap.lo, gap.hi) >= width * 0.78);
      const window = (u === s.lo) === (v === q.lo) &&
        continuous.some(w => continuous.some(p => Math.abs(w.c - p.c) >= Math.max(w.t, p.t) + 1));
      if (window) repairs.push({ ...gap, kind: "window" });
      else if (tracks.length && gapKind(img, gap) !== "open") repairs.push({ ...gap, kind: "door" });
    }
  }
  return repairs.sort((a, b) => a.hi - a.lo - (b.hi - b.lo));
}

function addThinPartitions(
  img: Gray, singles: Segment[], walls: Segment[], gaps: Opening[],
  boundaries: Segment[], structural: Segment[], thickness: number,
) {
  const nearAxis = (s: Segment, q: Segment) => q.h === s.h && Math.abs(q.c - s.c) <= thickness * 0.5;
  // 玻璃隔断可以只有一条细线，要求两头都落在结构上。
  for (const line of singles) {
    const span = line.hi - line.lo;
    if (span < 2.2 * thickness || boundaries.some(q => nearAxis(line, q) && overlapLength(line, q) > span * 0.35)) continue;
    const anchors = [line.lo, line.hi].map(u => structural.filter(q =>
      connects(line, q, u, q.t / 2 + thickness * 0.3))
      .sort((a, b) => Math.abs(a.c - u) - Math.abs(b.c - u))[0]);
    const [a, b] = anchors;
    if (!a || !b || a.c >= b.c || !anchors.some(q =>
      Math.min(Math.abs(q.lo - line.c), Math.abs(q.hi - line.c)) < thickness * 0.6)) continue;
    const partition = { ...line, lo: a.c, hi: b.c };
    if (boundaries.some(q => crossesInside(q, partition, thickness))) continue;
    const dark = [0.2, 0.35, 0.5, 0.65, 0.8].filter(f =>
      ink(img, line.h, line.lo + span * f, line.c)).length;
    if (dark < 4) continue;
    boundaries.push(partition);
    walls.push(partition);
    for (const q of [a, b]) {
      q.lo = Math.min(q.lo, line.c);
      q.hi = Math.max(q.hi, line.c);
    }
  }
  // 单线隔断在墙头转角时，两条线各自只接到一面实墙。
  for (const line of singles) {
    const length = line.hi - line.lo;
    if (length < 3 * thickness || length > 11 * thickness ||
      boundaries.some(q => nearAxis(line, q) && overlapLength(line, q) > length * 0.55)) continue;
    for (const end of ["lo", "hi"] as const) {
      const far = end === "lo" ? "hi" : "lo";
      const anchor = [...walls, ...gaps].find(q => q.h !== line.h &&
        Math.abs(q.c - line[end]) <= q.t / 2 + thickness * 0.28 &&
        line.c >= q.lo - thickness * 0.66 && line.c <= q.hi + thickness * 0.66);
      if (!anchor) continue;
      const corner = singles.filter(q => q.h !== line.h && Math.abs(q.c - line[far]) <= thickness * 0.48 &&
        Math.min(Math.abs(q.lo - line.c), Math.abs(q.hi - line.c)) <= thickness * 0.43 &&
        q.hi - q.lo >= 3 * thickness && q.hi - q.lo <= 16 * thickness).sort((a, b) => b.hi - b.lo - (a.hi - a.lo))[0];
      if (!corner) continue;
      const base = walls.find(q => q.h === corner.h && Math.abs(q.c - corner.c) <= thickness * 0.35 &&
        q.lo < corner.hi && q.hi > corner.lo && Math.min(Math.abs(q.lo - line.c), Math.abs(q.hi - line.c)) >= 2 * thickness &&
        (line.c < q.lo || line.c > q.hi));
      if (!base || Math.abs(base.c - anchor.c) < 2.5 * thickness) continue;
      const tip = line.c < base.lo ? base.lo : base.hi;
      if (tip < corner.lo - thickness || tip > corner.hi + thickness) continue;
      const leg = { ...corner, c: base.c, lo: Math.min(tip, line.c), hi: Math.max(tip, line.c) };
      const cap = { ...line, lo: Math.min(base.c, anchor.c), hi: Math.max(base.c, anchor.c) };
      if (boundaries.some(q => crossesInside(leg, q, thickness) || crossesInside(cap, q, thickness))) continue;
      walls.push(cap);
      boundaries.push(leg, cap);
      anchor.lo = Math.min(anchor.lo, line.c);
      anchor.hi = Math.max(anchor.hi, line.c);
      break;
    }
  }
}

export function detectPlan(img: Gray): Detection {
  if (img.w <= 0 || img.h <= 0) return { walls: [], gaps: [], rooms: [], wallThickness: 0 };
  const scans = [scan(img, true), scan(img, false)];
  const wallThickness = typicalThickness(scans);
  if (!wallThickness) return { walls: [], gaps: [], rooms: [], wallThickness };
  const candidates = scans.flatMap(s => solidSegments(s, wallThickness));
  // 越接近细线厚度，越需要足够长的实心截面来排除粗字体笔画。
  const longWalls = new Set(candidates.filter(s =>
    s.hi - s.lo >= (s.t < 0.55 * wallThickness ? 2 * wallThickness : 2 * s.t)
  ));
  const supports = [...longWalls];
  // 短截面只有在墙角与同轴洞口之间才参与洞口检测。
  const solid = candidates.filter(s => {
    if (longWalls.has(s)) return true;
    const nextToCorner = (end: number) => supports.some(w => connects(s, w, end, w.t / 2 + 1));
    if (s.t >= wallThickness * 0.55 && s.hi - s.lo >= s.t * 1.4 &&
      (nextToCorner(s.lo) || nextToCorner(s.hi))) return true;
    return supports.some(w => {
      if (w.h !== s.h || Math.abs(w.c - s.c) > 1) return false;
      const before = w.lo - s.hi;
      const after = s.lo - w.hi;
      return (isOpeningWidth(before, wallThickness) && nextToCorner(s.lo)) ||
        (isOpeningWidth(after, wallThickness) && nextToCorner(s.hi));
    });
  });
  const { rails, hollow, windows, singles } = thinBoundaries(img, [scan(img, true, 200), scan(img, false, 200)], solid, wallThickness);
  const structure = [...solid, ...hollow, ...rails, ...windows];
  const connected = connectedWalls(structure, wallThickness);
  const walls = solid.filter(s => connected.has(s));
  const axes: Segment[][] = [];
  for (const wall of [...walls].sort((a, b) => b.hi - b.lo - (a.hi - a.lo))) {
    const axis = axes.find(([ref]) => ref.h === wall.h && Math.abs(ref.c - wall.c) <= wallThickness *
      (Math.min(ref.hi, wall.hi) > Math.max(ref.lo, wall.lo) ? 0.25 : 0.16));
    if (axis) {
      wall.c = axis[0].c;
      axis.push(wall);
    } else axes.push([wall]);
  }

  const gaps: Opening[] = [];
  const joins: Segment[] = [];
  for (const axis of axes) {
    axis.sort((a, b) => a.lo - b.lo);
    let previous = axis[0];
    for (const next of axis.slice(1)) {
      const width = next.lo - previous.hi;
      const gap = { ...previous, lo: previous.hi, hi: next.lo, t: (previous.t + next.t) / 2 };
      if (isOpeningWidth(width, wallThickness) &&
        !walls.some(q => crossesInside(gap, q, wallThickness * 1.45))) {
        gaps.push({ ...gap, kind: gapKind(img, gap) });
      } else if (width > 0 && width < 1.7 * wallThickness) joins.push(gap);
      if (next.hi > previous.hi) previous = next;
    }
  }

  const nearAxis = (s: Segment, q: Segment) => q.h === s.h && Math.abs(q.c - s.c) <= wallThickness * 0.5;
  for (const s of hollow.filter(s => connected.has(s))) {
    if ([...walls, ...gaps, ...windows, ...rails].some(q => nearAxis(s, q) && overlapLength(s, q) >= 0.6 * (s.hi - s.lo))) continue;
    walls.push(s);
  }
  for (const window of windows.filter(w => connected.has(w))) {
    const gap = gaps.find(g => g.h === window.h && Math.abs(g.c - window.c) <= wallThickness * 0.65 &&
      Math.min(g.hi, window.hi) - Math.max(g.lo, window.lo) >= 0.65 * (window.hi - window.lo));
    if (gap) gap.kind = "window";
    else {
      const aligned = walls.filter(w => nearAxis(window, w) && overlapLength(w, window) >= -wallThickness * 0.65)
        .sort((a, b) => Math.abs(a.c - window.c) - Math.abs(b.c - window.c))[0];
      gaps.push({ ...window, c: aligned?.c ?? window.c, kind: "window" });
    }
  }
  const boundaries = [...walls, ...gaps, ...joins, ...rails.filter(w => connected.has(w))];
  // 双线和两条短支墙形成凸出的窗台。主墙一端与支墙重合时，
  // 用靠近另一条支墙的垂直转角补出窗台内侧的断口。
  for (const rail of rails) {
    const sides = [rail.lo, rail.hi].map(c => walls.filter(w => w.h !== rail.h && w.c === c));
    for (const side of sides.flat()) {
      const far = Math.abs(side.lo - rail.c) < Math.abs(side.hi - rail.c) ? side.hi : side.lo;
      const anchor = walls.find(w => w.h === rail.h && Math.abs(w.c - far) <= w.t / 2 + 1 &&
        Math.min(Math.abs(w.lo - side.c), Math.abs(w.hi - side.c)) <= side.t / 2 + 1 &&
        Math.abs(w.c - rail.c) >= 2 * wallThickness && Math.abs(w.c - rail.c) <= 4 * wallThickness);
      if (!anchor) continue;
      const opposite = sides[side.c === rail.lo ? 1 : 0];
      const corner = walls.find(w => w.h !== rail.h && opposite.some(q => Math.abs(w.c - q.c) <= 1.5 * wallThickness) &&
        Math.min(Math.abs(w.lo - anchor.c), Math.abs(w.hi - anchor.c)) <= anchor.t / 2 + 1 &&
        opposite.some(q => q.lo <= w.hi + wallThickness && q.hi >= w.lo - wallThickness &&
          Math.min(Math.abs(q.lo - anchor.c), Math.abs(q.hi - anchor.c)) <= 1.5 * wallThickness));
      if (!corner) continue;
      const opening = { ...anchor, lo: Math.min(corner.c, side.c), hi: Math.max(corner.c, side.c) };
      const width = opening.hi - opening.lo;
      if (width < 2.2 * wallThickness || width > 6 * wallThickness ||
        gaps.some(g => g.h === opening.h && g.c === opening.c && g.lo < opening.hi && g.hi > opening.lo)) continue;
      const gap = { ...opening, kind: gapKind(img, opening) };
      gaps.push(gap);
      boundaries.push(gap);
    }
  }
  for (const wall of boundaries) {
    for (const end of ["lo", "hi"] as const) {
      if (gaps.some(g => g.h === wall.h && g.c === wall.c && (g.lo === wall[end] || g.hi === wall[end]))) continue;
      let closest = Infinity;
      let coordinate = wall[end];
      for (const cross of boundaries) {
        const distance = Math.abs(cross.c - wall[end]);
        if (distance >= closest || !connects(wall, cross, wall[end], cross.t / 2 + wallThickness * 0.38)) continue;
        closest = distance;
        coordinate = cross.c;
      }
      wall[end] = coordinate;
    }
  }
  const structural = [...walls, ...gaps.filter(g => g.kind === "window")];
  for (const gap of closeSupportedLines(img, boundaries, structural, singles, wallThickness)) {
    const width = gap.hi - gap.lo;
    if (boundaries.some(q => nearAxis(gap, q) && overlapLength(gap, q) > width * 0.75)) continue;
    for (const q of structural) {
      if (q.h === gap.h || (q.c !== gap.lo && q.c !== gap.hi)) continue;
      if (Math.abs(q.lo - gap.c) <= wallThickness * 0.85) q.lo = Math.min(q.lo, gap.c);
      if (Math.abs(q.hi - gap.c) <= wallThickness * 0.85) q.hi = Math.max(q.hi, gap.c);
    }
    boundaries.push(gap);
    gaps.push(gap);
  }
  addThinPartitions(img, singles, walls, gaps, boundaries, structural, wallThickness);
  // 墙在开口的一侧直接终止于垂直墙时，沿中线延伸到最近的支撑。
  for (const wall of walls) for (const end of ["lo", "hi"] as const) {
    const u = wall[end];
    const direction = end === "lo" ? -1 : 1;
    if (boundaries.some(q => q !== wall && (q.h === wall.h ? q.c === wall.c && q.lo <= u && q.hi >= u &&
      (direction < 0 ? u - q.lo : q.hi - u) > wallThickness * 0.35 :
      q.c === u && q.lo <= wall.c && q.hi >= wall.c))) continue;
    let nearest: Segment | undefined;
    for (const q of boundaries) {
      const distance = direction * (q.c - u);
      if (q.h === wall.h || q.lo - wallThickness * 0.4 > wall.c || q.hi + wallThickness * 0.4 < wall.c ||
        distance <= 0 || distance > wallThickness * 10 ||
        (nearest && distance >= direction * (nearest.c - u))) continue;
      nearest = q;
    }
    if (!nearest) continue;
    const opening = { ...wall, lo: Math.min(u, nearest.c), hi: Math.max(u, nearest.c) };
    const width = opening.hi - opening.lo;
    const kind = gapKind(img, opening);
    const corner = Math.min(Math.abs(nearest.lo - wall.c), Math.abs(nearest.hi - wall.c)) <= wallThickness;
    const short = width < wallThickness * 1.7;
    if (!short && kind === "open" && !corner && width > wallThickness * 5.6) continue;
    const gap = { ...opening, kind };
    boundaries.push(gap);
    if (!short) gaps.push(gap);
    nearest.lo = Math.min(nearest.lo, wall.c);
    nearest.hi = Math.max(nearest.hi, wall.c);
  }
  // 台阶形墙角的两段中线错开，用两块实心墨迹间的短横边连接。
  for (const [i, s] of walls.entries()) for (const q of walls.slice(i + 1)) {
    const offset = q.c - s.c;
    if (s.h !== q.h || Math.abs(offset) <= wallThickness * 0.3 || Math.abs(offset) > wallThickness * 1.85 ||
      s.t < wallThickness * 0.42 || q.t < wallThickness * 0.42 ||
      s.hi - s.lo < wallThickness * 2 || q.hi - q.lo < wallThickness * 2) continue;
    for (const a of [s.lo, s.hi]) for (const b of [q.lo, q.hi]) {
      if (Math.abs(a - b) > wallThickness * 1.4) continue;
      const center = (a + b) / 2;
      const u = [center, a, b].find(u =>
        [0.15, 0.33, 0.5, 0.67, 0.85].every(f => ink(img, s.h, u, s.c + offset * f)));
      if (u === undefined) continue;
      boundaries.push({ h: !s.h, c: u, lo: Math.min(s.c, q.c), hi: Math.max(s.c, q.c), t: 0 });
      for (const edge of [s, q]) {
        edge.lo = Math.min(u, edge.lo);
        edge.hi = Math.max(u, edge.hi);
      }
    }
  }
  // 门边短墙的一端接洞口，另一端要落在垂直墙上。
  const shortJamb = (s: Segment) => gaps.some(g => g.h === s.h && g.c === s.c &&
    ((g.lo === s.hi && walls.some(w => connects(s, w, s.lo, 1))) ||
     (g.hi === s.lo && walls.some(w => connects(s, w, s.hi, 1)))));
  const edges = boundaries.filter(s => s.hi > s.lo);
  const minimumArea = 0.5 * (wallThickness / 0.2) ** 2;
  let rooms = traceRooms(edges, minimumArea);
  const partitions = openPartitions(rooms, wallThickness);
  if (partitions.length) rooms = traceRooms([...edges, ...partitions], minimumArea);
  return {
    walls: walls.filter(s => s.hi > s.lo && (s.hi - s.lo >= 2 * s.t || shortJamb(s) ||
      (s.hi - s.lo >= wallThickness && [s.lo, s.hi].every(u => edges.some(q => connects(s, q, u, 0)))))).map(endpoints),
    gaps: visibleOpenings(gaps, solid, wallThickness).flatMap(g => {
      const cuts = g.kind === "window" ? [] : walls.filter(q => q.h !== g.h &&
        q.c - g.lo >= 1.7 * wallThickness && g.hi - q.c >= 1.7 * wallThickness &&
        q.lo <= g.c && q.hi >= g.c && q.hi - q.lo >= 2 * wallThickness).map(q => q.c);
      const split = [...new Set([g.lo, ...cuts, g.hi])].sort((a, b) => a - b);
      return split.slice(1).map((hi, i) => {
        const part = { ...g, lo: split[i], hi };
        return { ...endpoints(part), kind: cuts.length ? gapKind(img, part) : g.kind };
      });
    }),
    rooms,
    wallThickness,
  };
}





