# house.json 数据格式（v1）

一套方案是一个 JSON 文件。格式的权威定义在 [`src/model/schema.ts`](../src/model/schema.ts)（zod），这里是说明。完整例子见 [`examples/01-room.json`](../examples/01-room.json)。

## 坐标

- 单位米。俯视看：**x 向右（东），z 向下（南）**，y 向上。原点随便定，一般取户型左上角的墙角。
- 墙和房间都按**墙中线**描。

## 顶层

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | `1` | 格式版本 |
| `name` | 字符串 | 方案名称 |
| `height` | 数字，默认 2.75 | 层高 |
| `theme` | `natural` `nordic` `cream` `walnut` `industrial`，默认 `natural` | 整体风格：原木日式、北欧白、奶油风、胡桃木中古、工业风 |
| `budget` | `{ min?, max? }`，可选 | 预算（元），大模型布置时按它控制总价 |
| `walls` | 数组 | 墙，见下 |
| `rooms` | 数组 | 房间 |
| `furniture` | 数组，默认空 | 家具 |
| `extras` | 数组，默认空 | 清单里没有 3D 外形的东西（床垫、运费等） |
| `background` | 可选 | 描图底图的标定参数。图片本身存在浏览器里，不在 JSON 里 |

所有 `id`（墙、门窗、房间、家具、清单项）在整个文件里不能重复。

## 墙 `walls[]`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | 字符串 | |
| `a`、`b` | `[x, z]` | 墙中线的两个端点。可以是斜墙 |
| `thickness` | 数字 | 墙厚 |
| `height` | 可选 | 墙高，不填就是层高 |
| `kind` | `wall` `parapet` `railing`，默认 `wall` | 普通墙；矮墙（实心）；栏板（下半实心、上半栏杆，阳台用） |
| `openings` | 数组 | 墙上的门窗洞口 |

### 门窗 `walls[].openings[]`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | 字符串 | |
| `type` | `door` `entry` `sliding` `window` `opening` | 平开门、入户门（画成关着）、推拉门、窗、没有门扇的门洞 |
| `offset` | 数字 | 洞口起点到墙 `a` 端的距离 |
| `width` | 数字 | 洞口宽 |
| `bottom`、`top` | 数字 | 洞口下沿、上沿离地高度。门的 `bottom` 是 0 |
| `hinge` | `a` `b`，平开门用 | 门轴在洞口靠 `a` 端还是靠 `b` 端 |
| `side` | `1` `-1`，平开门用 | 门往哪边开：`1` 是沿 a→b 方向看的左手边 |
| `panels` | 1~6，推拉门用 | 扇数 |
| `rail` | 布尔，窗用 | 室内一侧加护栏 |

洞口不能超出墙（`offset + width ≤ 墙长`），上沿不能高过墙。

## 房间 `rooms[]`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id`、`name` | 字符串 | |
| `type` | `living` `dining` `bedroom` `study` `kitchen` `bath` `entry` `hall` `storage` `balcony` `other` | 房间类型 |
| `polygon` | `[[x, z], …]`，至少 3 个点 | 按墙中线围成的多边形，顺时针逆时针都行 |
| `floor` | `wood` `tile` `tileSmall` `deck` | 木地板、大瓷砖、小瓷砖、防腐木 |
| `floorColor` | `#RRGGBB`，可选 | 木地板颜色，不填跟随风格 |
| `wall` | `paint` `tile` `exterior` | 乳胶漆、墙砖、外墙涂料 |
| `wallColor` | `#RRGGBB`，可选 | 乳胶漆颜色，不填跟随风格 |
| `outdoor` | 布尔，可选 | 室外（阳台）：没有墙根暗角 |

面积按多边形算（墙中线面积），会比户型图上标的套内面积大一些。

## 家具 `furniture[]`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | 字符串 | |
| `type` | 家具类型 | 见 [`src/model/catalog.ts`](../src/model/catalog.ts)，或者打开“家具库”页面看 |
| `name`、`spec`、`note` | 字符串，可选 | 名称、规格说明、备注 |
| `room` | 房间 id，可选 | 所在房间 |
| `pos` | `[x, z]` | 占地中心 |
| `rot` | 度，默认 0 | 正面朝向：0 朝南，90 朝东，180 朝北，-90 朝西 |
| `size` | `[宽, 深, 高]` | 宽是正面的宽度，深是从背面到正面 |
| `elevation` | 可选 | 底面离地高度。放在别的家具上的台灯、电视，吊灯的灯罩底部 |
| `variant` | 可选 | 变体，比如转角沙发的 `left` / `right`、圆桌 `round` |
| `finish` | `oak` `oakLight` `oakDark` `walnut` `white` `black` `grey`，可选 | 木色或柜体颜色，不填跟随风格 |
| `color` | `#RRGGBB`，可选 | 布艺颜色，不填跟随风格 |
| `fixed` | 布尔，可选 | 房子原有的设施（马桶、橱柜等）：不计预算，大模型不能动 |
| `price` | 数字，可选 | 价格（元）。不填就不计入清单 |
| `priceBasis` | `user` `llm`，可选 | 价格是自己填的，还是大模型估的（未核实） |
| `optional` | 布尔，可选 | 可选项，不算进必买合计 |

## 清单项 `extras[]`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id`、`name` | 字符串 | |
| `price` | 数字 | 价格（元） |
| `spec`、`note` | 字符串，可选 | |
| `room` | 房间 id，可选 | 归到哪个房间，不填归到“全屋和其他” |
| `priceBasis`、`optional` | 同家具 | |

## 底图标定 `background`

| 字段 | 说明 |
|---|---|
| `pxPerM` | 图上横向 1 米对应的像素数 |
| `pxPerMz` | 纵向 1 米对应的像素数，可选。照片被拉伸时横竖不同 |
| `origin` | 坐标原点在图上的像素位置 `[x, y]` |
| `opacity` | 底图透明度，0~1 |

## 最小的例子

```json
{
  "version": 1,
  "name": "一个房间",
  "walls": [
    { "id": "w1", "a": [0, 0], "b": [4, 0], "thickness": 0.2,
      "openings": [{ "id": "win1", "type": "window", "offset": 1, "width": 1.5, "bottom": 0.9, "top": 2.3 }] },
    { "id": "w2", "a": [4, 0], "b": [4, 3], "thickness": 0.2 },
    { "id": "w3", "a": [4, 3], "b": [0, 3], "thickness": 0.2,
      "openings": [{ "id": "d1", "type": "door", "offset": 0.3, "width": 0.9, "bottom": 0, "top": 2.05, "hinge": "a", "side": -1 }] },
    { "id": "w4", "a": [0, 3], "b": [0, 0], "thickness": 0.2 }
  ],
  "rooms": [
    { "id": "r1", "name": "卧室", "type": "bedroom", "polygon": [[0, 0], [4, 0], [4, 3], [0, 3]], "floor": "wood", "wall": "paint" }
  ],
  "furniture": [
    { "id": "bed1", "type": "bed", "name": "双人床", "room": "r1", "pos": [2, 1.15], "rot": 0, "size": [1.64, 2.08, 0.98], "price": 1600, "priceBasis": "user" }
  ]
}
```
