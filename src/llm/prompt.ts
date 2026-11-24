/**
 * 发给大模型的提示词：系统提示（规则和输出格式）+ 当前方案的精简描述。
 * 方案描述每次提问都重新生成，所以用户手动改过、撤销过，大模型看到的都是最新的。
 */
import { CATALOG } from "../model/catalog";
import { bbox, openingCenter, pointInPolygon, polygonArea, roomDoors } from "../model/geometry";
import { WOOD_FINISHES, WOOD_LABEL, type House, type Room, type Vec2 } from "../model/schema";
import { THEMES } from "../model/themes";

const r2 = (v: number) => Math.round(v * 100) / 100;
const pt = (p: Vec2) => [r2(p[0]), r2(p[1])];

export const SYSTEM_PROMPT = `你是室内软装设计助手，帮用户在已经建好的户型里布置家具、换材质和配色、列采购清单。
你只能通过 JSON 指令修改方案，不能改墙、门窗和房间形状。

## 坐标
单位米。x 向东（右），z 向南（下）。家具的 pos 是占地中心 [x, z]；size 是 [宽, 深, 高]，宽是正面的宽度，深是从背面到正面的距离；rot 是正面朝向：0 朝南（+z），90 朝东（+x），180 朝北（-z），-90 朝西（-x）。

## 摆放
- 靠墙的家具（床、沙发、柜子、书桌、电视柜等）用 place 让程序算坐标：{"wall":"N|S|W|E","at":0到1,"gap":米}。意思是背面贴房间的北/南/西/东墙；at 是沿墙的位置（N、S 墙上 0 是西端、1 是东端；W、E 墙上 0 是北端、1 是南端；0.5 居中）；gap 是离墙距离，一般是 0。
- 不靠墙的东西（茶几、餐桌、地毯、餐椅）直接给 pos 和 rot，要在房间的 bbox 范围内。
- 不要挡门：门口前方 0.8 m 内不放家具，平开门开门扫过的范围也不放。主要通道留 0.8 m 以上，床边留 0.5 m 以上。
- 先看房间的尺寸再选家具尺寸，放不下就换小一号或者不放，并在 reply 里说明。
- 放在别的家具上面的东西（台灯、电视、显示器）要设 elevation 为下面那件家具的高度，pos 和下面那件对齐。

## 输出
只输出一个 JSON 对象，不要输出其他文字：
{"reply": "给用户的中文说明，三句以内，说清做了什么、为什么", "ops": [指令...]}

可用的指令：
- {"op":"add","type":家具类型,"room":房间id,"name":"具体的名称，比如 实木双人床 1.5 m","place":{"wall":"N","at":0.5,"gap":0} 或 "pos":[x,z],"rot":度,"size":[w,d,h],"variant":变体,"finish":木色,"color":"#RRGGBB","price":元,"spec":"规格说明","optional":true或false,"elevation":米}
  （size 不给就用默认尺寸；finish、color 不给就跟随整体风格）
- {"op":"move","id":家具id,"place":{"room":房间id,"wall":"N","at":0.5,"gap":0} 或 "pos":[x,z],"rot":度}
- {"op":"update","id":家具id, 要改的字段（name、size、rot、variant、finish、color、price、spec、optional、note、elevation）}
- {"op":"remove","id":家具id}
- {"op":"setRoomFinish","room":房间id,"floor":"wood|tile|tileSmall|deck","floorColor":"#RRGGBB","wall":"paint|tile|exterior","wallColor":"#RRGGBB"}（只写要改的字段）
- {"op":"setTheme","theme":"${Object.keys(THEMES).join("|")}"}
- {"op":"addExtra","name":"名称","price":元,"spec":"规格","room":房间id,"optional":true或false}（清单里没有 3D 外形的东西：床垫、床品、收纳盒、五金、运费等）
- {"op":"removeExtra","id":清单项id}

## 规则
- fixed 为 true 的是房子原有的设施，不能移动、修改或删除。
- 价格是人民币，按国内电商常见价位估一个整数。你没法联网核实，只给估算，不要编造具体店铺、链接和“实测”价格。
- 用户只是提问、不需要改方案时，ops 给空数组 []。
- 用户没提到的房间和家具不要动。
- 预算（budget）有值时，新增家具的总价要控制在预算里，并在 reply 里说一下合计。`;

function sideOf(room: Room, p: Vec2): "N" | "S" | "W" | "E" {
  const b = bbox(room.polygon);
  const d = { N: Math.abs(p[1] - b.z0), S: Math.abs(p[1] - b.z1), W: Math.abs(p[0] - b.x0), E: Math.abs(p[0] - b.x1) };
  return (Object.entries(d).sort((a, c) => a[1] - c[1])[0][0]) as "N" | "S" | "W" | "E";
}

/** 当前方案的精简描述：房间（外框、门窗在哪面墙）、家具、清单项 */
export function describeHouse(h: House) {
  const rooms = h.rooms.map(r => {
    const b = bbox(r.polygon);
    const rect = r.polygon.length === 4 && polygonArea(r.polygon) > (b.x1 - b.x0) * (b.z1 - b.z0) - 1e-6;
    const doors = roomDoors(h, r).map(({ w, o }) => {
      const c = openingCenter(w, o);
      return { type: o.type, side: sideOf(r, c), center: pt(c), width: r2(o.width) };
    });
    const windows: { side: string; center: number[]; width: number; sill: number }[] = [];
    for (const w of h.walls) for (const o of w.openings) {
      if (o.type !== "window") continue;
      const c = openingCenter(w, o);
      const inside = [1, -1].some(sg => { const p = openingCenter(w, o, sg * (w.thickness / 2 + 0.3)); return pointInPolygon(p, r.polygon); });
      if (inside) windows.push({ side: sideOf(r, c), center: pt(c), width: r2(o.width), sill: r2(o.bottom) });
    }
    return {
      id: r.id, name: r.name, type: r.type, area: r2(polygonArea(r.polygon)),
      bbox: [r2(b.x0), r2(b.z0), r2(b.x1), r2(b.z1)],
      ...(rect ? {} : { polygon: r.polygon.map(pt) }),
      floor: r.floor, wall: r.wall, ...(r.outdoor ? { outdoor: true } : {}),
      doors, windows,
    };
  });
  const furniture = h.furniture.map(f => ({
    id: f.id, type: f.type, name: f.name, room: f.room, pos: pt(f.pos), rot: f.rot, size: f.size.map(r2),
    ...(f.elevation ? { elevation: f.elevation } : {}), ...(f.fixed ? { fixed: true } : {}),
    ...(f.price != null ? { price: f.price } : {}), ...(f.optional ? { optional: true } : {}),
  }));
  const extras = h.extras.map(e => ({ id: e.id, name: e.name, price: e.price, room: e.room, ...(e.optional ? { optional: true } : {}) }));
  return { name: h.name, height: h.height, theme: h.theme, ...(h.budget ? { budget: h.budget } : {}), rooms, furniture, extras };
}
export function catalogText() {
  const lines = CATALOG.map(c => `- ${c.type}：${c.nameZh}，默认 ${c.defaultSize.map(v => Math.round(v * 100)).join("×")} cm${c.variants ? `，变体 ${c.variants.join("/")}` : ""}${c.hint ? `。${c.hint}` : ""}`);
  const themes = Object.entries(THEMES).map(([k, t]) => `- ${k}：${t.nameZh}（${t.desc}）`);
  return `## 家具类型（type）\n${lines.join("\n")}\n\n## 木色（finish）\n${WOOD_FINISHES.map(w => `${w}=${WOOD_LABEL[w]}`).join("，")}\n\n## 整体风格（theme）\n${themes.join("\n")}`;
}

/** 本轮发给大模型的用户消息：最新方案 + 用户的话 */
export function userMessage(h: House, text: string) {
  return `当前方案（已包含之前所有修改）：\n${JSON.stringify(describeHouse(h))}\n\n用户的要求：${text}`;
}
