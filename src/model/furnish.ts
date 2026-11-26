/**
 * 按房间用途给家具排候选位置，先检查房间边界、通道和使用空间，
 * 再交给 checkPlacement 检查。优先尝试常用尺寸，放不下就降级，
 * 最后放弃并说明原因。成组家具试摆失败时撤回整组候选。
 */
import { CATALOG_BY_TYPE } from "./catalog";
import { bbox, convexOverlap, itemAxes, itemFootprint, pointInPolygon, polygonArea, signedArea, wallFrame, wallPoint } from "./geometry";
import { checkPlacement, fitSize, type Op } from "./ops";
import type { House, Item, Opening, Room, Vec2, Wall } from "./schema";

export interface FurnishResult {
  /** 可以直接交给 applyOps 的新增指令。 */
  ops: Op[];
  /** 每个房间一句中文说明，包含新增家具和放不下的原因。 */
  notes: string[];
}

type Size = Item["size"];
type Pose = Pick<Item, "pos" | "rot" | "size">;
type Candidate = Omit<Item, "id" | "room">;
type Add = Extract<Op, { op: "add" }>;
type Edge = { wall: Wall; lo: number; hi: number; side: number; rot: number; openings: Opening[] };
type Aperture = { wall: Wall; opening: Opening; side: number; across?: Room };

const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const distance = (a: Vec2, b: Vec2) => Math.hypot(...sub(a, b));
const sizeOf = (type: string): Size => [...CATALOG_BY_TYPE[type].defaultSize];
const span = (e: Edge) => e.hi - e.lo;
const door = (o: Opening) => o.type !== "window";
const floorItem = (f: Candidate) => !f.elevation && f.type !== "rug" && f.type !== "curtain" && f.type !== "deck_tiles";

function offset(p: Pose, x: number, z: number): Vec2 {
  const { ax, front } = itemAxes(p.rot);
  return [p.pos[0] + ax[0] * x + front[0] * z, p.pos[1] + ax[1] * x + front[1] * z];
}

function item(type: string, pos: Vec2, rot = 0, size = sizeOf(type), name = CATALOG_BY_TYPE[type].nameZh): Candidate {
  return { type, pos, rot, size: fitSize(type, size).size, name };
}

function openingStrip(w: Wall, o: Opening, side: number, depth: number): Vec2[] {
  const t = w.thickness / 2, end = o.offset + o.width;
  return [wallPoint(w, o.offset, side * t), wallPoint(w, end, side * t),
    wallPoint(w, end, side * (t + depth)), wallPoint(w, o.offset, side * (t + depth))];
}

// 沿多边形的实际边找墙，长墙跨多个房间时只取与当前房间相邻的那一段。
function roomEdges(h: House, room: Room): Edge[] {
  const edges: Edge[] = [];
  const winding = Math.sign(signedArea(room.polygon));
  room.polygon.forEach((a, i) => {
    const b = room.polygon[(i + 1) % room.polygon.length];
    const ab = sub(b, a), length = Math.hypot(...ab);
    if (length < 0.001) return;
    const inward: Vec2 = [-ab[1] * winding / length, ab[0] * winding / length];
    for (const wall of h.walls) {
      const { len, d, n } = wallFrame(wall);
      const da = sub(a, wall.a), db = sub(b, wall.a);
      if (Math.abs(dot(da, n)) > 0.02 || Math.abs(dot(db, n)) > 0.02) continue;
      const lo = Math.max(0, Math.min(dot(da, d), dot(db, d)));
      const hi = Math.min(len, Math.max(dot(da, d), dot(db, d)));
      if (hi - lo < 0.05) continue;
      edges.push({ wall, lo, hi, side: Math.sign(dot(inward, n)),
        rot: Math.round(Math.atan2(inward[0], inward[1]) * 180e8 / Math.PI) / 1e8,
        openings: wall.openings.filter(o => o.offset < hi && o.offset + o.width > lo) });
    }
  });
  return edges.sort((a, b) => span(b) - span(a));
}

// 对门窗两侧各探测一次，避免把共用墙上邻居的门窗当成本房间的。
function apertures(h: House): Map<string, Aperture[]> {
  const map = new Map(h.rooms.map(r => [r.id, [] as Aperture[]]));
  for (const wall of h.walls) for (const opening of wall.openings) {
    const u = opening.offset + opening.width / 2;
    const p = wall.thickness / 2 + 0.02;
    const sideRooms = [1, -1].map(s => h.rooms.find(r => pointInPolygon(wallPoint(wall, u, s * p), r.polygon)));
    sideRooms.forEach((r, i) => {
      if (r) map.get(r.id)!.push({ wall, opening, side: i === 0 ? 1 : -1, across: sideRooms[1 - i] });
    });
  }
  return map;
}

function along(lo: number, hi: number, step: number): number[] {
  if (hi < lo - 1e-7) return [];
  const count = Math.ceil(Math.max(0, hi - lo) / step);
  const mid = (lo + hi) / 2;
  if (!count) return [mid];
  return [mid, ...Array.from({ length: count + 1 }, (_, i) => lo + (hi - lo) * i / count)
    .filter(v => Math.abs(v - mid) > 1e-7).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))];
}

function against(e: Edge, u: number, depth: number): Vec2 {
  return wallPoint(e.wall, u, e.side * (e.wall.thickness / 2 + depth / 2));
}

function frontOf(f: Pose, depth: number, width = f.size[0]): Vec2[] {
  return itemFootprint({ pos: offset(f, 0, (f.size[1] + depth) / 2), rot: f.rot, size: [width, depth, 1] });
}

class Layout {
  readonly edges: Edge[];
  readonly bounds;
  readonly area: number;
  readonly openings: Aperture[];
  private readonly reserved: Vec2[][] = [];
  readonly omissions: string[] = [];

  constructor(readonly house: House, readonly room: Room, readonly ops: Add[],
    openings: Aperture[], private readonly doors: Vec2[][], private readonly walls: Vec2[][],
    private readonly existingIds: Set<string>) {
    this.openings = openings;
    this.edges = roomEdges(house, room);
    this.bounds = bbox(room.polygon);
    this.area = polygonArea(room.polygon);
  }

  find(...types: string[]): Item[] {
    return this.house.furniture.filter(f => types.includes(f.type) &&
      (f.room === this.room.id || (!f.room && pointInPolygon(f.pos, this.room.polygon))));
  }

  // 检查凹形房间的凹口，避免矩形四角虽在室内、边却跨出房间。
  contains(polygon: Vec2[]): boolean {
    const center: Vec2 = [(polygon[0][0] + polygon[2][0]) / 2, (polygon[0][1] + polygon[2][1]) / 2];
    return pointInPolygon(center, this.room.polygon) &&
      polygon.every(p => pointInPolygon([p[0] * 0.99999 + center[0] * 0.00001, p[1] * 0.99999 + center[1] * 0.00001], this.room.polygon)) &&
      !this.room.polygon.some(p => polygon.every((a, i) => {
        const edge = sub(polygon[(i + 1) % polygon.length], a), v = sub(p, a);
        return (edge[0] * v[1] - edge[1] * v[0]) / Math.hypot(...edge) > 1e-6;
      }));
  }

  // 活动区允许与别的活动区共用，家具占住活动区才算冲突。
  clear(zone: Vec2[], ignore: Item[] = []): boolean {
    return this.contains(zone) && !this.walls.some(w => convexOverlap(w, zone)) &&
      !this.house.furniture.some(f => floorItem(f) && !ignore.includes(f) && convexOverlap(itemFootprint(f), zone));
  }

  reserve(zone: Vec2[]): void {
    this.reserved.push(zone);
  }

  add(f: Candidate): Item | undefined {
    const fp = itemFootprint(f);
    const bottom = f.elevation ?? 0, top = bottom + f.size[2];
    if (!this.contains(fp) || bottom > 3 || top > this.house.height + 1e-6) return;
    if (floorItem(f) && (this.doors.some(d => convexOverlap(fp, d, 1e-6)) ||
      this.walls.some(w => convexOverlap(fp, w)) ||
      this.reserved.some(r => convexOverlap(fp, r)))) return;
    if (f.type !== "curtain" && this.openings.some(({ wall, opening, side }) =>
      opening.type === "window" && top > opening.bottom + 1e-6 && bottom < opening.top &&
      convexOverlap(fp, openingStrip(wall, opening, side, 0.3), 1e-6))) return;
    if (bottom && f.type !== "curtain" && this.house.furniture.some(other => {
      if (["curtain", "rug", "deck_tiles"].includes(other.type)) return false;
      const low = other.elevation ?? 0;
      return bottom < low + other.size[2] - 1e-6 && top > low + 1e-6 && convexOverlap(fp, itemFootprint(other));
    })) return;
    let n = this.ops.length + 1;
    while (this.existingIds.has("furnish-" + n) || this.ops.some(op => op.ref === "furnish-" + n)) n++;
    const id = "furnish-" + n;
    const placed = { ...f, id, room: this.room.id };
    this.house.furniture.push(placed);
    if (checkPlacement(this.house, [id]).length) {
      this.house.furniture.pop();
      return;
    }
    this.ops.push({ ...f, op: "add", room: this.room.id, ref: id });
    return placed;
  }

  tryGroup(place: () => boolean): boolean {
    const count = this.house.furniture.length, ops = this.ops.length, reserved = this.reserved.length;
    if (place()) return true;
    this.house.furniture.length = count;
    this.ops.length = ops;
    this.reserved.length = reserved;
    return false;
  }

  *wallPositions(type: string, size: Size, edges = this.edges, near?: Vec2): Generator<{ f: Candidate; e: Edge }> {
    for (const e of edges) {
      const half = size[0] / 2, lo = e.lo + half, hi = e.hi - half;
      const candidates = along(lo, hi, 0.09);
      // 门前通道的边缘也作为候选，避免等距取样错过刚好能放下的墙段。
      const { d, n } = wallFrame(e.wall);
      const back = e.wall.thickness / 2;
      for (const strip of this.doors) {
        const points = strip.map(p => sub(p, e.wall.a));
        const depth = points.map(p => e.side * dot(p, n));
        if (Math.max(...depth) <= back || Math.min(...depth) >= back + size[1]) continue;
        const u = points.map(p => dot(p, d));
        for (const candidate of [Math.min(...u) - half, Math.max(...u) + half]) {
          if (candidate >= lo && candidate <= hi && !candidates.some(v => Math.abs(v - candidate) < 1e-6)) candidates.push(candidate);
        }
      }
      const aim = near ? dot(sub(near, e.wall.a), d) : (lo + hi) / 2;
      candidates.sort((a, b) => Math.abs(a - aim) - Math.abs(b - aim));
      for (const u of candidates) yield { f: item(type, against(e, u, size[1]), e.rot, size), e };
    }
  }

  wallItem(type: string, sizes: Size[] = [sizeOf(type)], edges = this.edges, options: {
    near?: Vec2; clearance?: number; name?: string; widthInName?: boolean;
  } = {}): Item | undefined {
    const current = this.find(type)[0];
    for (const size of current ? [] : sizes) for (const { f } of this.wallPositions(type, size, edges, options.near)) {
      const zone = options.clearance ? frontOf(f, options.clearance) : undefined;
      if (zone && !this.clear(zone)) continue;
      const name = options.name ?? f.name;
      const placed = this.add({ ...f, name: options.widthInName ? `${name} ${size[0]} m` : name });
      if (!placed) continue;
      if (zone) this.reserve(zone);
      return placed;
    }
    if (!current) this.miss(options.name ?? CATALOG_BY_TYPE[type].nameZh);
    return current;
  }

  miss(name: string, reason = "避开门窗和已有家具后空间不足"): void {
    this.omissions.push(`${reason}，未放${name}`);
  }
}

function compactSizes(type: string, ...smaller: Size[]): Size[] {
  return [sizeOf(type), ...smaller];
}

function angleOf(a: Aperture): number {
  const { n } = wallFrame(a.wall);
  return Math.atan2(n[0] * a.side, n[1] * a.side) * 180 / Math.PI;
}

function curtains(l: Layout, variant: "double" | "single"): void {
  const existing = l.find("curtain");
  for (const a of l.openings) {
    const { wall, opening: o, side } = a;
    if (o.type !== "window" && !(variant === "double" && o.type === "sliding" && a.across?.type === "balcony")) continue;
    const u = o.offset + o.width / 2;
    const center = wallPoint(wall, u, side * wall.thickness / 2);
    // 每个洞口单独识别已有窗帘，一面墙上的两扇窗各挂一幅。
    if (existing.some(f => distance(f.pos, center) < 0.35 ||
      convexOverlap(itemFootprint(f), openingStrip(wall, o, side, 0.35)))) continue;
    const name = variant === "double" ? "双层窗帘" : "单层窗帘";
    const elevation = variant === "single" ? Math.max(0, o.bottom - 0.1) : 0;
    const height = Math.min(3.2, (wall.height ?? l.house.height) - elevation - 0.04);
    const depth = 0.06;
    const placed = [o.width + 0.16, o.width, o.width * 0.9].some(width =>
      l.add({ ...item("curtain", wallPoint(wall, u, side * (wall.thickness + depth) / 2),
        angleOf(a), [width, depth, height], name), variant, elevation }));
    if (!placed) l.miss(name, "洞口两端余量不足");
  }
}

function onTop(l: Layout, type: string, base: Item, name: string, x = 0, z = 0): Item | undefined {
  const size = sizeOf(type);
  if (Math.abs(x) + size[0] / 2 > base.size[0] / 2 + 1e-6 ||
    Math.abs(z) + size[1] / 2 > base.size[1] / 2 + 1e-6) return;
  return l.add({ ...item(type, offset(base, x, z), base.rot, size, name), elevation: (base.elevation ?? 0) + base.size[2] });
}

function rug(l: Layout, anchor: Pose, z: number, sizes: Size[], name: string): void {
  if (l.find("rug").length) return;
  if (!sizes.some(size => l.add(item("rug", offset(anchor, 0, z), anchor.rot, size, name)))) l.miss(name);
}

function sameWall(e: Edge, f: Pose): boolean {
  const { n } = wallFrame(e.wall);
  return dot(itemAxes(f.rot).front, itemAxes(e.rot).front) > 0.999 &&
    Math.abs(dot(sub(offset(f, 0, -f.size[1] / 2), e.wall.a), n) - e.side * e.wall.thickness / 2) < 0.03;
}

function bedside(l: Layout, bed: Item, side: number): Item | undefined {
  for (const size of compactSizes("nightstand", [0.3, 0.32, 0.45])) {
    const pos = offset(bed, side * ((bed.size[0] + size[0]) / 2 + 0.04), (size[1] - bed.size[1]) / 2);
    const stand = l.add(item("nightstand", pos, bed.rot, size));
    if (stand) return stand;
  }
}

function bedroom(l: Layout): void {
  const { x0, x1, z0, z1 } = l.bounds;
  const large = l.area >= 13 && Math.min(x1 - x0, z1 - z0) >= 3.4;
  const double = l.area >= 7;
  let bed: Item | undefined = l.find("bed", "single_bed", "folding_bed")[0];
  const choices: [string, Size, string][] = [];
  if (large) choices.push(["bed", [1.94, 2.08, 0.98], "双人床 1.8 m"]);
  if (double) choices.push(["bed", [1.64, 2.08, 0.98], "双人床 1.5 m"]);
  choices.push(["single_bed", sizeOf("single_bed"), "单人床"], ["single_bed", [0.8, 1.9, 0.75], "紧凑单人床"]);
  const edges = l.edges.filter(e => !e.openings.some(o => o.type === "window"));
  const existingStands = l.find("nightstand");
  let addedStands: Item[] = [];
  if (!bed) {
    search: for (const [type, size, name] of choices) {
      // 同一床宽下先找能配两侧床头柜的位置，再退到一侧或只放床。
      for (const wanted of existingStands.length ? [0] : [2, 1, 0]) {
        for (const { f } of l.wallPositions(type, size, edges)) {
          const foot = frontOf(f, 0.5);
          if (!l.clear(foot)) continue;
          // 床头柜只占靠床头的一小段，侧边活动区从柜子前缘开始。
          const side = [1, -1].map(s => itemFootprint({ pos: offset(f, s * (size[0] / 2 + 0.25), 0.22),
            rot: f.rot, size: [0.5, size[1] - 0.44, 1] })).find(zone => l.clear(zone));
          if (!side || !l.tryGroup(() => {
            const placed = l.add({ ...f, name });
            if (!placed) return false;
            l.reserve(foot);
            l.reserve(side);
            const stands = wanted ? [-1, 1].map(s => bedside(l, placed, s)).filter(f => f !== undefined) : [];
            if (stands.length < wanted) return false;
            bed = placed;
            addedStands = stands;
            return true;
          })) continue;
          if (name !== choices[0][2]) l.omissions.push(`空间有限，${choices[0][2]}改为${name}`);
          if (!double) l.omissions.push("房间小于 7 ㎡，未放双人床");
          break search;
        }
      }
    }
    if (!bed) l.miss(double ? "床" : "双人床和单人床", "无窗床头墙或床侧、床尾通道不足");
  } else if (bed.type !== "folding_bed") {
    const foot = frontOf(bed, 0.5);
    if (l.clear(foot)) l.reserve(foot);
    for (const s of [1, -1]) {
      const side = itemFootprint({ pos: offset(bed, s * (bed.size[0] / 2 + 0.25), 0.22),
        rot: bed.rot, size: [0.5, Math.max(0.1, bed.size[1] - 0.44), 1] });
      if (l.clear(side)) { l.reserve(side); break; }
    }
  }
  const placedBed = bed;
  const otherEdges = placedBed ? l.edges.filter(e => !sameWall(e, placedBed)) : l.edges;
  if (!l.find("clothes_rack").length) l.wallItem("wardrobe", [2.4, 2, 1.6, 1.2, 1].map(w => [w, 0.58, 2]),
    otherEdges, { clearance: 0.6, widthInName: true });
  if (bed && bed.type !== "folding_bed") {
    if (!existingStands.length && !addedStands.length) {
      for (const s of [-1, 1]) {
        const stand = bedside(l, bed, s);
        if (stand) addedStands.push(stand);
      }
    }
    const stands = [...existingStands, ...addedStands];
    if (stands.length < 2) l.miss(stands.length ? "第二个床头柜" : "床头柜");
    const lamps = l.find("table_lamp");
    if (!lamps.length) for (const stand of stands) {
      if (!onTop(l, "table_lamp", stand, "床头台灯")) l.miss("床头台灯");
    }
    rug(l, bed, bed.size[1] / 2 - 0.32, [[1.6, 1.35, 0.01], [0.8, 0.8, 0.01], [0.55, 0.55, 0.01]], "床尾地毯");
  }
  if (l.area >= 12) l.wallItem("cabinet", [[1.2, 0.45, 0.8], [0.8, 0.4, 0.8]], otherEdges, { name: "斗柜" });
  curtains(l, "double");
}

type Zone = (p: Vec2) => boolean;
const anywhere: Zone = () => true;

function centers(l: Layout, target: Vec2, step = 0.16): Vec2[] {
  const { x0, x1, z0, z1 } = l.bounds;
  return along(x0, x1, step).flatMap(x => along(z0, z1, step).map((z): Vec2 => [x, z]))
    .sort((a, b) => distance(a, target) - distance(b, target));
}

function dining(l: Layout, target: Vec2, zone: Zone = anywhere, rotations = [0, 90]): void {
  let table = l.find("dining_table")[0];
  const chairs = l.find("chair");
  let seatCount = chairs.length;
  const chairSize = sizeOf("chair");

  function placeSeats(f: Item, count: number): boolean {
    // 先给桌边留出拉椅子的深度，再把椅子摆在该活动区内。
    return [1, -1].every(s => {
      const side = { ...f, rot: f.rot + (s < 0 ? 180 : 0) };
      const access = frontOf(side, 0.6);
      if (!l.clear(access, chairs)) return false;
      const positions = count === 4 ? [-1, 1].map(v => v * f.size[0] * 0.235) : [0];
      if (!positions.every(x => {
        const p = offset(side, x, side.size[1] / 2 + chairSize[1] / 2 + 0.02);
        return zone(p) && l.add(item("chair", p, side.rot + 180, chairSize, "餐椅"));
      })) return false;
      l.reserve(access);
      return true;
    });
  }

  if (!table) {
    const points = centers(l, target).filter(zone);
    const sizes: Size[] = l.area >= 12 ? [[1.4, 0.8, 0.75], [1.2, 0.75, 0.75]] : [[1.2, 0.75, 0.75]];
    search: for (const count of chairs.length ? [0] : [4, 2, 0]) {
      for (const size of sizes) for (const p of points) for (const rot of rotations) {
        const candidate = item("dining_table", p, rot, size, "长方形餐桌");
        if (!itemFootprint(candidate).every(zone)) continue;
        if (!l.tryGroup(() => {
          const added = l.add(candidate);
          if (!added || count && !placeSeats(added, count)) return false;
          table = added;
          return true;
        })) continue;
        if (!chairs.length) seatCount = count;
        break search;
      }
    }
  } else if (!chairs.length) {
    for (const count of [4, 2]) {
      if (l.tryGroup(() => placeSeats(table!, count))) { seatCount = count; break; }
    }
  }
  if (!table) { l.miss("餐桌、餐椅和吊灯"); return; }
  if (seatCount < 4) l.miss(seatCount ? "其余餐椅" : "餐椅", "桌边活动空间不足 0.6 m 或椅位有障碍");
  if (!l.find("pendant_lamp").length &&
    !l.add({ ...item("pendant_lamp", table.pos, table.rot, [0.46, 0.46, 0.38], "餐桌吊灯"), elevation: 1.6 })) l.miss("餐桌吊灯");
}

function living(l: Layout): void {
  const { x0, x1, z0, z1 } = l.bounds;
  const longX = x1 - x0 >= z1 - z0;
  const axis = longX ? 0 : 1;
  const low = longX ? x0 : z0, high = longX ? x1 : z1, mid = (low + high) / 2;
  const short = longX ? z1 - z0 : x1 - x0;
  const combined = !l.house.rooms.some(r => r.type === "dining") && high - low >= 5.5 && l.area >= 18;
  const light = l.openings.filter(a => a.opening.type === "window" || a.across?.type === "balcony")
    .sort((a, b) => Number(b.across?.type === "balcony") - Number(a.across?.type === "balcony") || b.opening.width - a.opening.width)[0];
  const sunnyEnd = light ? wallPoint(light.wall, light.opening.offset + light.opening.width / 2)[axis] >= mid : true;
  const lounge: Zone = p => !combined || (sunnyEnd ? p[axis] >= mid : p[axis] <= mid);
  const center: Vec2 = [(x0 + x1) / 2, (z0 + z1) / 2];
  const loungeCenter: Vec2 = [...center];
  const diningCenter: Vec2 = [...center];
  if (combined) {
    loungeCenter[axis] = (mid + (sunnyEnd ? high : low)) / 2;
    diningCenter[axis] = (mid + (sunnyEnd ? low : high)) / 2;
  }
  const edges = [...l.edges].sort((a, b) => Number(Boolean(a.openings.length)) - Number(Boolean(b.openings.length)) || span(b) - span(a));
  let sofa: Item | undefined = l.find("sofa", "sofa_l")[0];
  let stand: Item | undefined = l.find("tv_stand")[0];
  const standSizes = compactSizes("tv_stand", [1.2, 0.36, 0.45], [0.85, 0.3, 0.4]);
  const frontGap = (f: Pose, tv: Pose) => dot(sub(tv.pos, f.pos), itemAxes(f.rot).front) - (f.size[1] + tv.size[1]) / 2;

  function opposite(f: Pose, gap: number): Item | undefined {
    const { front } = itemAxes(f.rot);
    for (const e of l.edges) {
      if (dot(front, itemAxes(e.rot).front) > -0.999) continue;
      const u = dot(sub(f.pos, e.wall.a), wallFrame(e.wall).d);
      for (const size of standSizes) {
        if (u - size[0] / 2 < e.lo || u + size[0] / 2 > e.hi) continue;
        const tv = item("tv_stand", against(e, u, size[1]), e.rot, size);
        if (!lounge(tv.pos) || frontGap(f, tv) < gap) continue;
        const placed = l.add(tv);
        if (placed) return placed;
      }
    }
  }

  if (!sofa) {
    const choices: [string, Size, string][] = [];
    if (short >= 3.3) choices.push(["sofa_l", [2.3, 1.51, 0.7], "转角沙发"], ["sofa_l", [2.2, 1.3, 0.7], "紧凑转角沙发"]);
    choices.push(["sofa", [2.2, 0.9, 0.8], "三人沙发"], ["sofa", [1.8, 0.8, 0.75], "双人沙发"]);
    // 先找能和电视柜相对且有足够间距的整组布局，再降级到不带茶几的布局。
    search: for (const gap of [1.6, 0.6, 0]) for (const [type, size, name] of choices) {
      for (const { f, e } of l.wallPositions(type, size, edges, loungeCenter)) {
        if (!itemFootprint(f).every(lounge)) continue;
        if (type === "sofa_l") {
          const u = dot(sub(f.pos, e.wall.a), wallFrame(e.wall).d);
          const usable = e.openings.reduce(([lo, hi], o) => o.offset + o.width <= u ? [Math.max(lo, o.offset + o.width), hi]
            : o.offset >= u ? [lo, Math.min(hi, o.offset)] : [u, u], [e.lo, e.hi]);
          if (usable[1] - usable[0] < 2.6) continue;
          const ax = itemAxes(f.rot).ax;
          const sideSpace = (s: number) => [0.25, 0.5, 0.75].filter(d => {
            const p = offset(f, s * (size[0] / 2 + d), size[1] / 2);
            return lounge(p) && pointInPolygon(p, l.room.polygon);
          }).length;
          f.variant = sideSpace(1) === sideSpace(-1) ? (ax[axis] * (sunnyEnd ? 1 : -1) >= 0 ? "right" : "left")
            : sideSpace(1) > sideSpace(-1) ? "right" : "left";
        }
        if (l.tryGroup(() => {
          const placed = l.add({ ...f, name });
          if (!placed) return false;
          const tv = stand ?? (gap ? opposite(placed, gap) : undefined);
          if (gap && (!tv || frontGap(placed, tv) < gap)) return false;
          stand = tv;
          sofa = placed;
          return true;
        })) break search;
      }
    }
  }
  if (sofa && !stand) stand = opposite(sofa, 1.6) ?? opposite(sofa, 0.6);
  if (!sofa) l.miss("沙发");
  if (!stand) l.miss("相对沙发的电视柜");
  if (stand && !l.find("tv").length && !onTop(l, "tv", stand, "电视")) {
    const size: Size = [Math.min(stand.size[0], 0.9), 0.16, 0.58];
    if (size[0] < 0.6 || stand.size[1] < size[1] ||
      !l.add({ ...item("tv", stand.pos, stand.rot, size, "小尺寸电视"), elevation: (stand.elevation ?? 0) + stand.size[2] })) l.miss("电视");
  }
  if (combined) dining(l, diningCenter, p => !lounge(p), longX ? [0, 90] : [90, 0]);
  if (sofa) {
    const seat = sofa;
    let table: Item | undefined = l.find("coffee_table")[0];
    if (!table && stand && frontGap(seat, stand) >= 1.6) {
      for (const size of [[0.9, 0.5, 0.42], [0.55, 0.55, 0.42]] as Size[]) {
        table = l.add({ ...item("coffee_table", offset(sofa, 0, (sofa.size[1] + size[1]) / 2 + 0.4),
          sofa.rot, size, size[0] === size[1] ? "小圆茶几" : "长方形茶几"), variant: size[0] === size[1] ? "round" : "rect" });
        if (table) break;
      }
    }
    if (!table) l.miss("茶几", stand && frontGap(sofa, stand) >= 1.6 ? "沙发前的茶几位置有障碍" : "沙发与电视柜间距不足 1.6 m");
    if (table) rug(l, table, -0.06, [[1.6, 1.3, 0.01], [1.2, 0.8, 0.01], [0.6, 0.6, 0.01]], "会客区地毯");
    if (!l.find("floor_lamp").length) {
      const size: Size = [0.3, 0.3, 1.5];
      const placed = [-1, 1].some(s => l.add(item("floor_lamp",
        offset(seat, s * ((seat.size[0] + size[0]) / 2 + 0.05), (size[1] - seat.size[1]) / 2), seat.rot, size)));
      if (!placed) l.miss("落地灯", "沙发两端空间不足");
    }
  }
  cornerPlant(l, lounge);
  curtains(l, "double");
}

function cornerPlant(l: Layout, zone: Zone = anywhere): void {
  if (l.find("plant").length) return;
  for (const size of [[0.38, 0.38, 1.1], [0.24, 0.24, 0.65]] as Size[]) {
    for (const p of l.room.polygon) {
      // 从角点向内试几个位置，让花盆避开两面墙的厚度。
      for (const d of [size[0] / 2 + 0.11, size[0] / 2 + 0.25]) for (const x of [-1, 1]) for (const z of [-1, 1]) {
        const pos: Vec2 = [p[0] + x * d, p[1] + z * d];
        if (zone(pos) && l.add(item("plant", pos, 0, size, "角落绿植"))) return;
      }
    }
  }
  l.miss("绿植", "空角不足");
}

const midpoint = (a: Aperture): Vec2 => wallPoint(a.wall, a.opening.offset + a.opening.width / 2);
const centerOf = (l: Layout): Vec2 => [(l.bounds.x0 + l.bounds.x1) / 2, (l.bounds.z0 + l.bounds.z1) / 2];

function kitchen(l: Layout): void {
  let counter = l.find("kitchen_counter")[0];
  const newCounter = !counter;
  const edges = l.edges.filter(e => !e.openings.some(door));
  if (!counter) {
    const window = l.openings.find(a => a.opening.type === "window");
    // 优先保留长台面，同时给冰箱留一个可以独立使用的位置。
    search: for (const requireFridge of [true, false]) for (const e of edges) {
      const max = Math.min(5, Math.floor((span(e) - 0.12) * 10) / 10);
      const widths = along(1.2, max, 0.2).sort((a, b) => b - a).map(w => +w.toFixed(2));
      for (const w of widths) for (const { f } of l.wallPositions("kitchen_counter", [w, 0.6, 0.82], [e])) {
        f.variant = window && dot(sub(midpoint(window), f.pos), itemAxes(f.rot).ax) > 0 ? "sink-right" : "sink-left";
        if (l.tryGroup(() => {
          const added = l.add(f);
          if (!added) return false;
          if (requireFridge && !l.find("fridge").length && !fridge(l, added, false)) return false;
          counter = added;
          return true;
        })) break search;
      }
    }
    if (!counter) l.miss("橱柜台面");
  }
  if (counter && !l.find("stove").length) {
    const side = counter.variant === "sink-right" ? -1 : 1;
    const x = side * Math.max(0, counter.size[0] / 2 - sizeOf("stove")[0] / 2 - 0.06);
    if (!onTop(l, "stove", counter, "台面灶具", x)) l.miss("灶具", "台面可用宽深或高度不足");
  } else if (!counter && !l.find("stove").length) l.miss("灶具", "缺少台面");
  fridge(l, counter, true);
  if (counter && newCounter) {
    const { front } = itemAxes(counter.rot);
    const adjacent = edges.filter(e => Math.abs(dot(itemAxes(e.rot).front, front)) < 0.01)
      .filter(e => Math.min(...[-1, 1].map(s => {
        const end = offset(counter!, s * counter!.size[0] / 2, -counter!.size[1] / 2);
        return Math.abs(dot(sub(end, e.wall.a), itemAxes(e.rot).front) - e.wall.thickness / 2);
      })) < 0.25);
    // 转角段只在能够接到主台面，且前面还能站人时才加。
    for (const w of [1.6, 1.2]) for (const { f } of l.wallPositions("kitchen_counter", [w, 0.6, 0.82], adjacent, counter.pos)) {
      if (![-1, 1].some(s => [-1, 1].some(t => {
        const a = offset(f, s * w / 2, 0);
        const b = offset(counter!, t * (counter!.size[0] / 2 - f.size[1] / 2), counter!.size[1] / 2);
        return distance(a, b) <= 0.1;
      }))) continue;
      const access = frontOf(f, 0.6);
      if (l.clear(access) && l.add({ ...f, variant: "none", name: "转角橱柜台面" })) return;
    }
  }
}

function fridge(l: Layout, counter: Item | undefined, report: boolean): Item | undefined {
  const current = l.find("fridge")[0];
  if (current) return current;
  const near = counter?.pos;
  const edges = [...l.edges].sort((a, b) => Number(Boolean(counter && sameWall(b, counter))) -
    Number(Boolean(counter && sameWall(a, counter))));
  for (const size of compactSizes("fridge", [0.55, 0.6, 1.65])) {
    for (const { f } of l.wallPositions("fridge", size, edges, near)) {
      const placed = l.add(f);
      if (placed) return placed;
    }
  }
  if (report) l.miss("冰箱");
}

function bath(l: Layout): void {
  if (!l.find("shower").length) {
    const doors = l.openings.filter(a => door(a.opening)).map(midpoint);
    const candidates = l.edges.flatMap(e => {
      const size = sizeOf("shower");
      const margin = size[0] / 2 + 0.1;
      if (span(e) < margin * 2) return [];
      return [e.lo + margin, e.hi - margin].map(u => item("shower", against(e, u, size[1]), e.rot, size));
    });
    const fromDoor = (p: Vec2) => doors.length ? Math.min(...doors.map(d => distance(d, p))) : distance(centerOf(l), p);
    candidates.sort((a, b) => fromDoor(b.pos) - fromDoor(a.pos));
    if (!candidates.some(f => l.add(f))) l.wallItem("shower");
  }
  l.wallItem("toilet", compactSizes("toilet", [0.37, 0.55, 0.75]), l.edges, { clearance: 0.45 });
  l.wallItem("basin", compactSizes("basin", [0.35, 0.35, 0.8]), l.edges, { clearance: 0.45 });
}

function entry(l: Layout): void {
  const opening = l.openings.find(a => a.opening.type === "entry") ?? l.openings.find(a => door(a.opening));
  const near = opening && midpoint(opening);
  const byDistance = (point: Vec2 | undefined) => point ? [...l.edges].sort((a, b) =>
    distance(against(a, (a.lo + a.hi) / 2, 0), point) - distance(against(b, (b.lo + b.hi) / 2, 0), point)) : l.edges;
  const cabinet = l.wallItem("shoe_cabinet", compactSizes("shoe_cabinet", [0.68, 0.24, 1], [0.45, 0.22, 0.9]),
    byDistance(near), { near });
  const benchNear = cabinet?.pos ?? near;
  l.wallItem("bench", compactSizes("bench", [0.6, 0.3, 0.42]), byDistance(benchNear), { near: benchNear, name: "换鞋凳" });
  if (opening) {
    const anchor = { pos: wallPoint(opening.wall, opening.opening.offset + opening.opening.width / 2,
      opening.side * (opening.wall.thickness / 2 + 0.34)), rot: angleOf(opening), size: sizeOf("rug") };
    rug(l, anchor, 0, [[0.73, 0.6, 0.012], [0.5, 0.4, 0.012]], "入户地垫");
  }
}

function study(l: Layout): void {
  const window = l.openings.find(a => a.opening.type === "window");
  const near = window && midpoint(window);
  const edges = near ? [...l.edges].sort((a, b) => distance(against(a, (a.lo + a.hi) / 2, 0), near) -
    distance(against(b, (b.lo + b.hi) / 2, 0), near)) : l.edges;
  let desk = l.find("desk")[0];
  let chair: Item | undefined = l.find("office_chair", "chair")[0];

  function addChair(f: Item): Item | undefined {
    for (const type of ["office_chair", "chair"]) {
      const size = sizeOf(type);
      const p = offset(f, 0, (f.size[1] + size[1]) / 2 + 0.05);
      const added = l.add(item(type, p, f.rot + 180, size, type === "chair" ? "书桌椅" : "办公椅"));
      if (added) return added;
    }
  }

  if (!desk) {
    search: for (const requireChair of chair ? [false] : [true, false]) {
      for (const size of compactSizes("desk", [0.85, 0.48, 0.74])) for (const { f } of l.wallPositions("desk", size, edges, near)) {
        const access = frontOf(f, 0.6);
        if (!l.clear(access, chair ? [chair] : [])) continue;
        if (l.tryGroup(() => {
          const placed = l.add({ ...f, name: "书桌" });
          if (!placed) return false;
          if (requireChair) {
            chair = addChair(placed);
            if (!chair) return false;
          }
          l.reserve(access);
          desk = placed;
          return true;
        })) break search;
      }
    }
  } else {
    const access = frontOf(desk, 0.6);
    if (l.clear(access, chair ? [chair] : [])) {
      if (!chair) chair = addChair(desk);
      l.reserve(access);
    }
  }
  if (!desk) l.miss("书桌");
  if (!chair) l.miss("书桌椅");
  if (desk && !l.find("table_lamp").length &&
    ![desk.size[0] * 0.27, -desk.size[0] * 0.27, 0].some(x => onTop(l, "table_lamp", desk!, "书桌台灯", x, -0.07))) l.miss("书桌台灯");
  l.wallItem("shelf", compactSizes("shelf", [0.5, 0.24, 1.05]), desk ? edges.filter(e => !sameWall(e, desk!)) : edges, { name: "书架" });
}

function balcony(l: Layout): void {
  if (l.area < 3.5 || l.openings.some(a => door(a.opening) && a.across?.type === "kitchen")) {
    l.wallItem("washer", compactSizes("washer", [0.55, 0.48, 0.85]));
    return;
  }
  let table = l.find("coffee_table")[0];
  const hadTable = Boolean(table);
  const stools = l.find("stool");
  const sliding = l.openings.find(a => a.opening.type === "sliding");
  const center = centerOf(l);
  const target = sliding ? offset({ pos: center, rot: angleOf(sliding), size: [1, 1, 1] }, 0, 0.4) : center;
  const size: Size = [0.36, 0.36, 0.45];

  function addStools(f: Item, count: number): boolean {
    for (const rot of [f.rot, f.rot + 90]) {
      const at = { ...f, rot };
      for (const sides of count === 2 ? [[-1, 1]] : [[-1], [1]]) {
        if (l.tryGroup(() => sides.every(s => l.add(item("stool",
          offset(at, s * ((f.size[0] + size[0]) / 2 + 0.06), 0), rot, size))))) return true;
      }
    }
    return false;
  }

  let count = stools.length;
  if (!table) {
    const points = centers(l, target);
    // 窄阳台靠栏杆的可用带很窄，额外试贴栏杆的精确位置。
    search: for (const wanted of count ? [0] : [2, 1, 0]) for (const diameter of [0.56, 0.54, 0.48]) {
      const tableSize: Size = [diameter, diameter, 0.7];
      const positions = [...points, ...Array.from(l.wallPositions("coffee_table", tableSize), ({ f }) => f.pos)]
        .sort((a, b) => distance(a, target) - distance(b, target));
      for (const p of positions) {
        if (!l.tryGroup(() => {
          const added = l.add({ ...item("coffee_table", p, 0, tableSize, "阳台小圆桌"), variant: "round" });
          if (!added || wanted && !addStools(added, wanted)) return false;
          table = added;
          return true;
        })) continue;
        count += wanted;
        break search;
      }
    }
  } else if (!count) {
    for (const wanted of [2, 1]) if (addStools(table, wanted)) { count = wanted; break; }
  }
  if (!table) l.miss("阳台小圆桌");
  else if (!hadTable && table.size[0] < 0.56) {
    l.omissions.push(`为保留门前通道，圆桌直径采用 ${table.size[0]} m`);
  }
  if (count < 2) l.miss(count ? "第二个凳子" : "凳子");
  cornerPlant(l);
}

function arrange(l: Layout): void {
  switch (l.room.type) {
    case "bedroom": bedroom(l); break;
    case "living": living(l); break;
    case "dining": dining(l, centerOf(l)); break;
    case "kitchen": kitchen(l); break;
    case "bath": bath(l); break;
    case "entry": entry(l); break;
    case "study": study(l); break;
    case "balcony": balcony(l); break;
    case "storage": l.wallItem("shelf", compactSizes("shelf", [0.5, 0.24, 1.05]), l.edges, { name: "置物架" }); break;
    case "other": if (l.area < 1.5) curtains(l, "single"); break;
    case "hall": break; // 过道只用于通行。
  }
}

export function furnishRoom(h: House, roomId: string): FurnishResult {
  return furnishHouse(h, [roomId]);
}

export function furnishHouse(h: House, roomIds?: string[]): FurnishResult {
  const working = { ...h, furniture: [...h.furniture] };
  const existingIds = new Set(h.furniture.map(f => f.id));
  const ops: Add[] = [], notes: string[] = [];
  const openings = apertures(h);
  // 两侧都检查，跨房间的同一扇门也要给前后房间留通道。
  const doors = h.walls.flatMap(w => w.openings.filter(door).flatMap(o => {
    const strips = [1, -1].map(s => openingStrip(w, o, s, 0.8));
    if (o.type === "entry" && o.width > 0.8) strips.push(openingStrip(w, o, o.side ?? 1, o.width));
    return strips;
  }));
  const walls = h.walls.map(w => {
    const t = w.thickness / 2, { len } = wallFrame(w);
    return [wallPoint(w, 0, t), wallPoint(w, len, t), wallPoint(w, len, -t), wallPoint(w, 0, -t)];
  });
  for (const id of new Set(roomIds ?? h.rooms.map(r => r.id))) {
    const room = h.rooms.find(r => r.id === id);
    if (!room) { notes.push(`房间 ${id} 不存在，未布置。`); continue; }
    const layout = new Layout(working, room, ops, openings.get(id) ?? [], doors, walls, existingIds);
    const before = ops.length;
    arrange(layout);
    const counts = new Map<string, number>();
    for (const op of ops.slice(before)) counts.set(op.name!, (counts.get(op.name!) ?? 0) + 1);
    const added = [...counts].map(([name, n]) => n === 1 ? name : `${name}×${n}`);
    notes.push(`${room.name}：${added.length ? "新增" + added.join("、") : "没有新增家具"}${layout.omissions.map(s => "；" + s).join("")}。`);
  }
  return { ops, notes };
}



