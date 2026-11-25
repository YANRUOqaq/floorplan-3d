// 厨房地柜带门板和踢脚，台面绕开钢水槽。卫浴：连体马桶、浴室柜加台上盆、带混水阀和手持花洒的淋浴立杆。
import { LatheGeometry, Mesh, Vector2 } from "three";
import { cyl, ring } from "../prims";
import { parts } from "./parts";
import type { FurnitureDef } from "./types";

export const kitchenBath: FurnitureDef[] = [
  // 地柜：缩进的踢脚、白色烤漆门板（3 mm 缝、上沿条形拉手）、4 cm 厚石英石台面盖过门板 1 cm；水槽是嵌在台面里的不锈钢盆，鹅颈龙头
  { type: "kitchen_counter", build(c) {
    const { block, x, z } = parts(c);
    const { granite, steel, bay, lacquer, grey } = c.mat;
    const kick = Math.min(0.1 / c.h, 0.14), top = 1 - Math.min(0.04 / c.h, 0.06), door = 0.955;
    block(grey, 0.004, 0.996, 0, kick, 0, door - Math.min(0.05 / c.d, 0.12), 0.002);
    block(lacquer, 0, 1, kick, top, 0, door, 0.003);
    const n = Math.max(1, Math.round(c.w / 0.55)), gx = 0.0015 / c.w, gy = 0.0015 / c.h;
    for (let i = 0; i < n; i++) {
      const a = i / n + gx, b = (i + 1) / n - gx, mid = (a + b) / 2, hw = Math.min(0.09 / c.w, (b - a) * 0.3);
      block(lacquer, a, b, kick + gy, top - gy, door, 0.985, 0.002);
      block(steel, mid - hw, mid + hw, top - 0.065 / c.h, top - 0.052 / c.h, 0.985, 1, 0.003);
    }
    if (c.variant === "none") { block(granite, 0, 1, top, 1, 0, 1, 0.003); return; }
    const u = c.variant === "sink-right" ? 0.808 : 0.192;
    const left = u - 0.104, right = u + 0.104;
    block(granite, 0, left, top, 1, 0, 1, 0.003);
    block(granite, right, 1, top, 1, 0, 1, 0.003);
    block(granite, left, right, top, 1, 0, 0.167, 0.003);
    block(granite, left, right, top, 1, 0.833, 1, 0.003);
    block(steel, left, right, 0.83, 0.852, 0.167, 0.833, 0.012);
    for (const edge of [left, right - 0.012]) block(steel, edge, edge + 0.012, 0.84, top + 0.004, 0.167, 0.833, 0.008);
    for (const edge of [0.167, 0.783]) block(steel, left + 0.012, right - 0.012, 0.84, top + 0.004, edge, edge + 0.05, 0.008);
    block(bay, left + 0.017, right - 0.017, 0.852, 0.857, 0.22, 0.78, 0, { shadow: false });
    // 鹅颈龙头：立管从台面升起，顶上弯向水槽，出水口朝下
    const r = Math.min(0.012, c.w * 0.025, c.d * 0.085, c.h * 0.04), riseTop = 1 - 0.02 / c.h;
    cyl(steel, x(u), z(0.12), r * 1.6, c.h * top, c.h * (top + 0.02), c.g);
    cyl(steel, x(u), z(0.12), r, c.h * top, c.h * riseTop, c.g);
    block(steel, u - r / c.w, u + r / c.w, riseTop - 0.02, riseTop + 0.0001, 0.12, 0.42, 0.01);
    cyl(steel, x(u), z(0.42), r * 0.9, c.h * (riseTop - 0.07), c.h * riseTop, c.g);
  } },
  // 连体马桶：圆角水箱、上宽下窄的椭圆座身、坐圈和盖板、水箱顶上的冲水按钮
  { type: "toilet", build(c) {
    const { soft, disc, x, z } = parts(c);
    const { ceramic, steel } = c.mat;
    soft(ceramic, 0.04, 0.96, 0.46, 1, 0, 0.3, 0.035, 0.08);
    disc(ceramic, 0.5, 0.6, 0.62, 0, 0.47, 0.8);
    disc(ceramic, 0.5, 0.58, 0.86, 0.455, 0.5, 0.86);
    const seat = ring(ceramic, x(0.5), c.h * 0.515, z(0.6), c.w * 0.39, Math.min(0.018, c.h * 0.03), c.g);
    seat.scale.set(1, c.d / c.w * 0.82, 1);
    disc(ceramic, 0.5, 0.6, 0.8, 0.515, 0.54, 0.8);
    cyl(steel, x(0.5), z(0.15), Math.min(0.025, c.w * 0.07), c.h - 0.004, c.h, c.g);
  } },
  // 浴室柜加台上盆：柜体带门板和拉手、石面台板、圆形陶瓷盆坐在台面上，盆后是高龙头
  { type: "basin", build(c) {
    const { block, soft, x, z } = parts(c);
    const { ceramic, steel, granite, grey } = c.mat;
    const top = 1 - Math.min(0.17 / c.h, 0.3);
    block(grey, 0.03, 0.97, 0, 0.08, 0.04, 0.86);
    block(c.style.wood, 0, 1, 0.08, top - 0.04, 0, 0.94, 0.004);
    block(c.style.wood, 0.012, 0.988, 0.095, top - 0.055, 0.94, 0.97, 0.003);
    block(steel, 0.35, 0.65, top - 0.1, top - 0.085, 0.97, 1, 0.003);
    block(granite, 0, 1, top - 0.04, top, 0, 1, 0.003);
    // 盆：车床旋转出的碗形，壁厚 8 mm，开口朝上
    const r = Math.min(c.w, c.d) * 0.42, bowlH = (1 - top) * c.h * 0.78, t = 0.008;
    const pts = [[0, 0], [r * 0.55, 0], [r * 0.9, bowlH * 0.25], [r, bowlH], [r - t, bowlH], [r * 0.9 - t, bowlH * 0.3], [r * 0.55 - t, t], [0, t]]
      .map(([px, py]) => new Vector2(px, py));
    const bowl = new Mesh(new LatheGeometry(pts, 48), ceramic);
    bowl.position.set(x(0.5), top * c.h, z(0.56));
    bowl.castShadow = bowl.receiveShadow = true;
    c.g.add(bowl);
    // 龙头：盆后面的立管，顶上弯向盆
    const fr = Math.min(0.012, c.w * 0.03), fz = z(0.56) - r - 0.035, fTop = c.h - 0.01;
    cyl(steel, x(0.5), fz, fr * 1.5, top * c.h, top * c.h + 0.02, c.g);
    cyl(steel, x(0.5), fz, fr, top * c.h, fTop, c.g);
    block(steel, 0.5 - fr / c.w, 0.5 + fr / c.w, (fTop - 0.018) / c.h, fTop / c.h, (fz + c.d / 2) / c.d, (fz + c.d / 2 + 0.09) / c.d, 0.008);
    soft(steel, 0.5 - 0.02 / c.w, 0.5 + 0.02 / c.w, (fTop - 0.012) / c.h, (fTop + 0.004) / c.h, (fz + c.d / 2 + 0.07) / c.d, (fz + c.d / 2 + 0.1) / c.d, 0.004, 0.2);
  } },
  // 淋浴：贴墙的立杆，中段是混水阀，上段有可上下滑动的手持花洒，顶端一个小顶喷
  { type: "shower", build(c) {
    const { block, x, z } = parts(c);
    const { steel } = c.mat;
    const r = Math.min(0.012, c.w / 7, c.d / 7);
    cyl(steel, x(0.49), z(0.25), r * 0.55, 0, c.h * 0.461, c.g);
    cyl(steel, x(0.49), z(0.25), r, c.h * 0.459, c.h * 0.995, c.g);
    block(steel, 0, 1, 0.98, 1, 0, 1, 0.01);
    // 混水阀：贴墙的扁盒加一个把手
    block(steel, 0.15, 0.85, 0.5, 0.56, 0, 0.45, 0.006);
    block(steel, 0.42, 0.58, 0.515, 0.545, 0.45, 0.9, 0.004);
    // 手持花洒：挂在立杆上的滑座，花洒头朝前下方
    block(steel, 0.3, 0.7, 0.8, 0.83, 0.1, 0.45, 0.004);
    const head = cyl(steel, x(0.49), z(0.7), Math.min(0.045, c.w * 0.32), c.h * 0.78, c.h * 0.8, c.g);
    head.rotation.x = 0.5;
  } },
];
