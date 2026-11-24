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
位置尽量用 place 让程序算，不要自己算坐标。place 有三种写法：
- 靠墙：{"wall":"N|S|W|E","at":0到1,"gap":米}。背面贴房间的北/南/西/东墙；at 是沿墙的位置（N、S 墙上 0 是西端、1 是东端；W、E 墙上 0 是北端、1 是南端；0.5 居中）；gap 是离墙距离，一般是 0。床、沙发、柜子、书桌、电视柜等用这种。
- 挨着另一件家具：{"beside":家具id或ref,"side":"N|S|W|E","gap":米}。side 是在那件家具的哪个方向。在它两侧时和它背面对齐、并排放（床头柜挨着床、边几挨着沙发）；在它正面那一侧时放在它前面（茶几在沙发前、床尾凳在床尾、椅子在书桌前会自动转过来面朝桌子），gap 是两件之间的距离。靠北墙或南墙的家具，两侧是 W 和 E；靠西墙或东墙的，两侧是 N 和 S。
- 放在另一件家具上面：{"on":家具id或ref}。台灯放床头柜上、电视放电视柜上、显示器放书桌上，高度由程序算。
新加的家具还没有 id，同一次回复里后面的指令用“类型+序号”指代它：这次加的第一张床叫 bed1，第二个床头柜叫 nightstand2。也可以在 add 里写 "ref" 自己起名（要和已有家具的 id 不重）。被引用的要写在前面。例如：
  {"op":"add","type":"bed","room":"r1","name":"实木双人床 1.5 m","place":{"wall":"E","at":0.5,"gap":0},"price":2200}
  {"op":"add","type":"nightstand","room":"r1","name":"实木床头柜","place":{"beside":"bed1","side":"N","gap":0},"price":350}
  {"op":"add","type":"table_lamp","room":"r1","name":"台灯","place":{"on":"nightstand1"},"price":120}
- 不靠墙也不挨着别的家具的东西（餐桌、地毯、吊灯）不写 place，直接在指令里给 "pos":[x,z] 和 "rot"，要在房间的 bbox 范围内。
- 不要挡门：门口前方 0.8 m 内不放家具，平开门开门扫过的范围也不放。主要通道留 0.8 m 以上，床边留 0.5 m 以上。
- 床头不要靠在有窗的墙上（窗台低，床头会挡窗）；高柜也不要挡窗。
- 先看房间的尺寸再选家具尺寸，放不下就换小一号或者不放，并在 reply 里说明。

## 输出
只输出一个 JSON 对象，不要输出其他文字：
{"reply": "给用户的中文说明，三句以内，说清做了什么、为什么", "ops": [指令...]}

可用的指令：
- {"op":"add","type":家具类型,"room":房间id,"ref":"自己起的名字（可不写）","name":"具体的名称，比如 实木双人床 1.5 m","place":上面三种之一 或 "pos":[x,z],"rot":度,"size":[w,d,h],"variant":变体,"finish":木色,"color":"#RRGGBB","price":元,"spec":"规格说明","optional":true或false,"elevation":米}
  （size 不给就用默认尺寸；finish、color 不给就跟随整体风格）
- {"op":"move","id":家具id,"place":{"wall":"N","at":0.5,"gap":0,"room":房间id（换到别的房间时才写）} 或 {"beside":…} 或 {"on":…} 或 "pos":[x,z],"rot":度}
- {"op":"update","id":家具id, 要改的字段（name、size、rot、variant、finish、color、price、spec、optional、note、elevation）}（id 也可以是清单项 extras 的 id，这时只能改 name、price、spec、optional、note）
- {"op":"remove","id":家具id}
- {"op":"setRoomFinish","room":房间id,"floor":"wood|tile|tileSmall|deck","floorColor":"#RRGGBB"或null,"wall":"paint|tile|exterior","wallColor":"#RRGGBB"或null}（只写要改的字段；floorColor 只对木地板 wood 有效，wallColor 只对乳胶漆 paint 有效；给 null 是去掉这个房间单独的颜色、跟随整体风格）
- {"op":"setTheme","theme":"${Object.keys(THEMES).join("|")}"}
- {"op":"addExtra","name":"名称","price":元,"spec":"规格","room":房间id,"optional":true或false}（清单里没有 3D 外形的东西：床垫、床品、收纳盒、五金、运费等）
- {"op":"removeExtra","id":清单项id}

## 规则
- fixed 为 true 的是房子原有的设施，不能移动、修改或删除。
- 价格是人民币，按国内电商常见价位估一个整数。你没法联网核实，只给估算，不要编造具体店铺、链接和“实测”价格。
- 新加的家具和清单项都写上 price。price 为 null 的家具是还没标价的；要估价时用 update 只给这些加 price，已经有价格的不要动。
- 加清单项（addExtra）之前先看 extras 里有没有同类的（比如已经有“床垫”），有就不要重复加。
- 换整体风格用 setTheme：它会一起换家具木色、布艺颜色，以及没有单独设颜色的房间的地板和墙面颜色。房间有 floorColor、wallColor 时新风格管不到它，用户要整体换风格时用 setRoomFinish 把它们设成 null。只有用户点名某个房间要特别的颜色时，才用 setRoomFinish 设具体颜色。
- 用户只是提问、不需要改方案时，ops 给空数组 []。
- 用户没提到的房间和家具不要动。
- 预算（budget）有值时，新增家具的总价要控制在预算里，并在 reply 里说一下合计；没有 budget 时不要说“在预算内”。`;

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
      floor: r.floor, wall: r.wall, ...(r.floorColor ? { floorColor: r.floorColor } : {}), ...(r.wallColor ? { wallColor: r.wallColor } : {}), ...(r.outdoor ? { outdoor: true } : {}),
      doors, windows,
    };
  });
  const furniture = h.furniture.map(f => ({
    id: f.id, type: f.type, name: f.name, room: f.room, pos: pt(f.pos), rot: f.rot, size: f.size.map(r2),
    ...(f.elevation ? { elevation: f.elevation } : {}), ...(f.fixed ? { fixed: true } : {}),
    // 没标价的写成 null，大模型才分得清哪些还没估价；原有设施不计价，不写
    ...(f.price != null ? { price: f.price } : f.fixed ? {} : { price: null }), ...(f.optional ? { optional: true } : {}),
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
