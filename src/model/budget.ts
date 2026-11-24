/**
 * 采购清单和预算：把有价格的家具和清单项按房间分组、合计。
 * 没填价格的家具（自备的、原有设施）不进清单，只单独数一下。
 */
import { CATALOG_BY_TYPE } from "./catalog";
import type { House } from "./schema";

export interface BudgetLine {
  id: string;
  kind: "item" | "extra";
  name: string;
  spec?: string;
  price: number;
  basis?: "user" | "llm";
  optional: boolean;
  note?: string;
}
export interface BudgetGroup { room: string | null; name: string; lines: BudgetLine[]; required: number; optional: number }

export function budgetSummary(h: House) {
  const lines = new Map<string | null, BudgetLine[]>();
  const push = (room: string | undefined, l: BudgetLine) => {
    const k = room && h.rooms.some(r => r.id === room) ? room : null;
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k)!.push(l);
  };
  for (const f of h.furniture) {
    if (f.price == null || f.fixed) continue;
    push(f.room, { id: f.id, kind: "item", name: f.name || CATALOG_BY_TYPE[f.type]?.nameZh || f.type, spec: f.spec, price: f.price, basis: f.priceBasis, optional: !!f.optional, note: f.note });
  }
  for (const e of h.extras) push(e.room, { id: e.id, kind: "extra", name: e.name, spec: e.spec, price: e.price, basis: e.priceBasis, optional: !!e.optional, note: e.note });
  const order = [...h.rooms.map(r => r.id), null];
  const groups: BudgetGroup[] = order.filter(k => lines.has(k)).map(k => {
    const ls = lines.get(k)!;
    return {
      room: k, name: k ? h.rooms.find(r => r.id === k)!.name : "全屋和其他", lines: ls,
      required: ls.filter(l => !l.optional).reduce((s, l) => s + l.price, 0),
      optional: ls.filter(l => l.optional).reduce((s, l) => s + l.price, 0),
    };
  });
  const required = groups.reduce((s, g) => s + g.required, 0);
  const optional = groups.reduce((s, g) => s + g.optional, 0);
  const llm = groups.flatMap(g => g.lines).filter(l => l.basis === "llm").reduce((s, l) => s + l.price, 0);
  const unpriced = h.furniture.filter(f => f.price == null && !f.fixed && !/含在/.test(f.note ?? "")).length;
  return { groups, required, optional, total: required + optional, llm, unpriced };
}
