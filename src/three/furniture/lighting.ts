// 三种灯保留原页的灯罩和点光源。吊灯的吊线单独标记，长度由天花板高度决定。
import { cyl, pointLight, ring, sphere } from "../prims";
import { parts } from "./parts";
import type { FurnitureDef } from "./types";

export const lighting: FurnitureDef[] = [
  { type: "floor_lamp", build(c) {
    const { disc } = parts(c);
    const { wood, woodDark } = c.style;
    disc(woodDark, 0.5, 0.5, 0.62, 0, 0.0155, 0.57);
    cyl(wood, 0, 0, Math.min(0.011, c.w / 6, c.d / 6), c.h * 0.0155, c.h * 0.84, c.g);
    disc(c.mat.glow, 0.5, 0.5, 1, 0.802, 1, 0.81, true);
    pointLight(0xffd9a8, 0.55, 4, 0, c.h * 0.895, 0, c.g);
  } },
  { type: "table_lamp", build(c) {
    const { disc } = parts(c);
    const { w, d, h, g } = c;
    const base = sphere(c.mat.pot, 0, h * 0.208, 0, 1, g, 24);
    base.scale.set(w * 0.288, h * 0.208, d * 0.288);
    cyl(c.style.wood, 0, 0, Math.min(0.008, w / 6, d / 6), h * 0.39, h * 0.611, g);
    disc(c.mat.glow, 0.5, 0.5, 1, 0.556, 1, 0.69, true);
    pointLight(0xffd9a8, 0.18, 2.2, 0, h * 0.833, 0, g);
  } },
  { type: "pendant_lamp", build(c) {
    const { w, d, h, g } = c;
    const shade = sphere(c.mat.glow, 0, h / 2, 0, 1, g, 40);
    shade.scale.set(w * 0.49, h / 2, d * 0.49);
    shade.castShadow = false;
    for (let k = -3; k <= 3; k++) {
      const y = k * 0.145;
      const hoop = ring(c.style.wood, 0, h * (0.5 + y), 0, Math.sqrt(1 - (2 * y) ** 2) * 0.49 + 0.004, 0.005, g);
      hoop.scale.set(w, d, Math.min(w, d, h));
    }
    const cord = cyl(c.mat.black, 0, 0, Math.min(0.004, w / 8, d / 8), h, Math.max(h, c.ceil), g, null, 6);
    cord.userData.cord = true;
    pointLight(0xffdcb0, 0.6, 4.5, 0, h * 0.29, 0, g);
  } },
];
