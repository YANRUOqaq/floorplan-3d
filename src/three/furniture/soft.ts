// 窗帘、地毯和木铺面沿用原页材质分工。盆栽叶冠随占地缩放，穿衣镜向背墙倾斜。
import { Group } from "three";
import { curtain, ring, sphere } from "../prims";
import { parts } from "./parts";
import type { FurnitureDef } from "./types";

export const soft: FurnitureDef[] = [
  { type: "rug", build(c) {
    parts(c).block(c.style.fabric, 0, 1, 0.18, 1, 0, 1, 0.003, { noBlob: true, shadow: false });
  } },
  { type: "deck_tiles", build(c) {
    parts(c).block(c.mat.deck, 0, 1, 0, 1, 0, 1, 0, { noBlob: true, shadow: false });
  } },
  { type: "curtain", build(c) {
    const { block, x, z } = parts(c);
    const { h, d, g } = c;
    const barHeight = Math.min(0.03 / h, 0.1);
    block(c.style.woodDark, 0, 1, 1 - barHeight, 1, 0, 1, 0.008, { noBlob: true });
    const panel = (start: number, end: number, sheer = false) => {
      const center = sheer ? 0.32 : 0.59;
      const amp = Math.min(sheer ? 0.03 : 0.045, d * Math.min(center, 1 - center) / 1.35);
      curtain(sheer ? c.mat.sheer : c.style.curtain, x(start), x(end), z(center),
        h * 0.008, h * (1 - barHeight), g, sheer ? 0.08 : c.variant === "single" ? 0.06 : 0.11, amp);
    };
    if (c.variant === "single") panel(0.6, 1);
    else {
      const span = Math.min(0.22, 0.51 / c.w);
      panel(0, span);
      panel(1 - span, 1);
      if (c.variant === "double") panel(span - 0.025, 1 - span + 0.025, true);
    }
  } },
  { type: "plant", build(c) {
    const { disc } = parts(c);
    const { g, w, d, h, mat, rand } = c;
    disc(mat.pot, 0.5, 0.5, 0.56, 0, 0.227, 0.72);
    disc(mat.soil, 0.5, 0.5, 0.7, 0.207, 0.217);
    const rim = ring(mat.pot, 0, h * 0.227, 0, 0.36, 0.024, g);
    rim.scale.set(w, d, Math.min(w, d));
    disc(mat.trunk, 0.5, 0.5, 0.08, 0.213, 0.9, 0.048);
    const crown = new Group();
    crown.scale.set(w, h, d);
    g.add(crown);
    for (let k = 0; k < 30; k++) {
      const y = k < 4 ? 0.88 + rand() * 0.04 : 0.37 + rand() * 0.55;
      const a = k * 2.39996 + rand() * 0.3;
      const length = 0.21 + rand() * 0.045;
      const out = 0.16 + rand() * 0.067;
      const leaf = sphere(k % 3 ? mat.leaf : mat.leaf2, Math.cos(a) * out, y, Math.sin(a) * out, 1, crown, 12);
      leaf.scale.set(0.12, 0.007, length);
      leaf.rotation.set(-(0.07 + rand() * 0.18), Math.PI / 2 - a, (rand() - 0.5) * 0.13, "YXZ");
      leaf.userData.noBlob = true;
    }
  } },
  { type: "mirror", build(c) {
    const { w, d, h, g } = c;
    const thickness = Math.min(0.035, d * 0.31);
    const mirror = new Group();
    mirror.position.y = h / 2;
    mirror.rotation.x = -Math.atan2(d - thickness, h);
    g.add(mirror);
    const { block } = parts({ ...c, g: mirror, d: thickness });
    const frame = block(c.style.woodDark, 0, 1, 0, 1, 0, 0.78, Math.min(w * 0.015, 0.008));
    frame.position.y -= h / 2;
    const glass = block(c.mat.mirror, 0.056, 0.944, 0.018, 0.982, 0.78, 1, 0, { shadow: false });
    glass.position.y -= h / 2;
  } },
];
