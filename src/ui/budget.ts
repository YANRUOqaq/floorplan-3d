/** 右侧“清单”面板：预算条、按房间分组的采购清单、价格就地修改、加清单项 */
import { budgetSummary } from "../model/budget";
import type { App } from "./app";
import { esc, fmt, fmtExact, toast, uid } from "./dom";

export function renderBudget(app: App, box: HTMLElement) {
  const h = app.store.house, b = budgetSummary(h);
  const max = Math.max(b.total, h.budget?.max ?? 0, 1) * 1.15;
  const pct = (v: number) => (v / max * 100).toFixed(2) + "%";
  const band = h.budget?.min != null && h.budget?.max != null ? `<div class="band" style="left:${pct(h.budget.min)};width:${pct(h.budget.max - h.budget.min)}"></div>` : "";
  const over = h.budget?.max != null ? b.required - h.budget.max : null;
  box.innerHTML = `
    <section class="field">
      <h3>预算</h3>
      <div class="facts">
        <div class="fact"><b>${fmt(b.required)}</b><span>必买合计</span></div>
        <div class="fact"><b>${fmt(b.total)}</b><span>加上可选项</span></div>
      </div>
      <div class="track" role="img" aria-label="必买 ${fmt(b.required)}，加可选 ${fmt(b.total)}">${band}<div class="fill optbar" style="width:${pct(b.total)}"></div><div class="fill" style="width:${pct(b.required)}"></div></div>
      <div class="row">
        <label class="field"><span>预算下限（元）</span><input type="number" id="bd-min" min="0" step="500" value="${h.budget?.min ?? ""}"></label>
        <label class="field"><span>预算上限（元）</span><input type="number" id="bd-max" min="0" step="500" value="${h.budget?.max ?? ""}"></label>
      </div>
      ${over != null ? `<p class="note">${over > 0 ? `必买超出上限 ${fmt(over)}。` : `必买离上限还有 ${fmt(-over)}。`}</p>` : '<p class="note">填上预算，大模型布置时会按预算控制总价。</p>'}
      ${b.llm ? `<p class="note"><span class="tag warn">大模型估算</span> 的部分合计 ${fmt(b.llm)}，是按常见价位估的，没有联网核实，买之前以实际价格为准。</p>` : ""}
      ${b.unpriced ? `<p class="note">还有 ${b.unpriced} 件家具没填价格，不计入合计（自备的东西可以不填）。</p>` : ""}
    </section>
    ${b.groups.map(g => `
      <section class="bd-group">
        <div class="bd-head"><h3>${esc(g.name)}</h3><span class="mono">${fmt(g.required)}${g.optional ? `<small> + 可选 ${fmt(g.optional)}</small>` : ""}</span></div>
        <ul class="bd-list">${g.lines.map(l => `
          <li>
            <div class="bd-name">${l.kind === "item" ? `<button type="button" class="link" data-item="${esc(l.id)}">${esc(l.name)}</button>` : esc(l.name)}
              ${l.optional ? '<span class="tag opt">可选</span>' : ""}${l.basis === "llm" ? '<span class="tag warn">估算</span>' : ""}
              ${l.spec ? `<div class="note">${esc(l.spec)}</div>` : ""}</div>
            <label class="bd-price"><span class="sr">价格</span><input type="number" min="0" step="1" value="${l.price}" data-price="${esc(l.id)}" data-kind="${l.kind}" aria-label="${esc(l.name)} 的价格"></label>
            ${l.kind === "extra" ? `<button type="button" class="btn small danger" data-del="${esc(l.id)}" aria-label="删除 ${esc(l.name)}">×</button>` : '<span></span>'}
          </li>`).join("")}</ul>
      </section>`).join("") || '<p class="note">清单是空的。在家具的属性里填价格，或者让大模型估价。</p>'}
    <form class="card" id="bd-add">
      <h3>加一项（没有 3D 外形的东西，比如床垫、运费）</h3>
      <div class="row"><label class="field"><span>名称</span><input type="text" id="bd-name" required></label><label class="field"><span>价格（元）</span><input type="number" id="bd-price" min="0" step="1" required></label></div>
      <label class="check"><input type="checkbox" id="bd-opt"> 可选</label>
      <button type="submit" class="btn small">添加</button>
    </form>
    <p class="note">合计 ${fmtExact(b.total)}，共 ${b.groups.reduce((s, g) => s + g.lines.length, 0)} 项。</p>`;

  box.onchange = e => {
    const el = e.target as HTMLInputElement;
    if (el.id === "bd-min" || el.id === "bd-max") {
      const min = (box.querySelector("#bd-min") as HTMLInputElement).value, mx = (box.querySelector("#bd-max") as HTMLInputElement).value;
      app.store.commit("改预算", d => { if (min === "" && mx === "") delete d.budget; else d.budget = { ...(min !== "" ? { min: +min } : {}), ...(mx !== "" ? { max: +mx } : {}) }; });
    }
    const id = el.dataset.price;
    if (id) {
      const v = Math.max(0, Number(el.value));
      app.store.commit("改价格", d => {
        const t = el.dataset.kind === "item" ? d.furniture.find(f => f.id === id) : d.extras.find(x => x.id === id);
        if (t) { t.price = v; t.priceBasis = "user"; }
      });
    }
  };
  box.onclick = e => {
    const t = e.target as HTMLElement;
    const item = t.closest<HTMLElement>("[data-item]")?.dataset.item;
    if (item) { app.select(item); app.showTab("3d"); app.viewer.locate(item); }
    const del = t.closest<HTMLElement>("[data-del]")?.dataset.del;
    if (del) app.store.commit("删清单项", d => { d.extras = d.extras.filter(x => x.id !== del); });
  };
  (box.querySelector("#bd-add") as HTMLFormElement).onsubmit = e => {
    e.preventDefault();
    const name = (box.querySelector("#bd-name") as HTMLInputElement).value.trim(), price = Number((box.querySelector("#bd-price") as HTMLInputElement).value);
    if (!name || !(price >= 0)) { toast("名称和价格都要填。", true); return; }
    const optional = (box.querySelector("#bd-opt") as HTMLInputElement).checked;
    app.store.commit("加清单项", d => {
      const taken = [...d.walls.flatMap(w => [w.id, ...w.openings.map(o => o.id)]), ...d.rooms.map(r => r.id), ...d.furniture.map(f => f.id), ...d.extras.map(x => x.id)];
      d.extras.push({ id: uid("x", taken), name, price, priceBasis: "user", ...(optional ? { optional: true } : {}) });
    });
  };
}
