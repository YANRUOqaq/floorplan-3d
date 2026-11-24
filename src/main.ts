/**
 * 入口：把数据（Store）、3D 浏览器、2D 编辑器、右侧面板接起来。
 * 数据只有一份，存在 Store 里；任何地方改了数据都走 store.commit()，
 * 其余部分通过 subscribe() 收到通知后各自重画。
 */
import "./style.css";
import example from "../examples/01-room.json";
import { emptyHouse, parseHouse, type House } from "./model/schema";
import { Store } from "./model/store";
import { Viewer } from "./three/viewer";
import { Editor } from "./editor/editor";
import type { App, SidePanel } from "./ui/app";
import { $, $$, download, esc, toast } from "./ui/dom";
import { renderInfo } from "./ui/info";
import { renderPlanPanel } from "./ui/plan";
import { renderBudget } from "./ui/budget";
import { initChat } from "./ui/chat";

const store = new Store(Store.restore(localStorage) ?? parseHouse(example), localStorage);

function showTab(t: "3d" | "2d") {
  tab = t;
  $$("[data-tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  $("#pane-3d").hidden = t !== "3d";
  $("#pane-2d").hidden = t !== "2d";
  if (t === "3d") app.viewer.refresh(); else editor?.render();
}
function showSide(side: SidePanel) {
  $$("[data-side]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.side === side)));
  for (const s of ["plan", "ai", "list"]) $("#side-" + s).hidden = s !== side;
}

let tab: "3d" | "2d" = "3d";
const app: App = {
  store,
  viewer: null as unknown as Viewer,
  selected: null,
  showSide, showTab,
  /** 选中任何东西（墙、门窗、房间、家具）都走这里，3D、2D、面板一起更新 */
  select(id) {
    app.selected = id;
    app.viewer.highlight(id && store.house.furniture.some(f => f.id === id) ? id : null);
    if (id && tab === "2d") showSide("plan");
    renderInfo(app, $("#info"));
    renderPlanPanel(app, $("#side-plan"));
    editor?.render();
  },
};
let editor: Editor | null = null;

/* ---------- 3D ---------- */
app.viewer = new Viewer($("#viewer"), {
  onSelect: id => app.select(id),
  onViews: (views, current) => {
    const chip = (v: { key: string; name: string }) => `<button type="button" class="chip" data-view="${esc(v.key)}" aria-pressed="${v.key === current}">${esc(v.name)}</button>`;
    $("#views").innerHTML = `<span class="chip-label">站到</span>` + views.filter(v => !v.orbit).map(chip).join("") +
      `<span class="chip-label">看整体</span>` + views.filter(v => v.orbit).map(chip).join("");
  },
});
$("#views").addEventListener("click", e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-view]");
  if (b) app.viewer.setView(b.dataset.view!);
});

/* ---------- 数据变化时 ---------- */
function onChange(h: House) {
  const name = $<HTMLInputElement>("#proj-name");
  if (document.activeElement !== name) name.value = h.name;
  document.title = `${h.name} · 户型 3D`;
  $<HTMLButtonElement>("#btn-undo").disabled = !store.canUndo;
  $<HTMLButtonElement>("#btn-redo").disabled = !store.canRedo;
  $("#empty3d").hidden = h.walls.length > 0;
  if (app.selected && !h.furniture.some(f => f.id === app.selected)) app.selected = null;
  app.viewer.load(h);
  renderPlanPanel(app, $("#side-plan"));
  renderBudget(app, $("#side-list"));
  renderInfo(app, $("#info"));
  editor?.render();
}
editor = new Editor($("#pane-2d"), app);
initChat(app, $("#side-ai"));
store.subscribe(onChange);
onChange(store.house);

$<HTMLInputElement>("#proj-name").addEventListener("change", e => {
  const v = (e.target as HTMLInputElement).value.trim();
  if (v && v !== store.house.name) store.commit("改名", d => { d.name = v; });
});

/* ---------- 撤销、重做 ---------- */
$("#btn-undo").addEventListener("click", () => store.undo());
$("#btn-redo").addEventListener("click", () => store.redo());
document.addEventListener("keydown", e => {
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, select, [contenteditable]")) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); }
  else if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); store.redo(); }
});

/* ---------- 文件：新建、示例、导入、导出 ---------- */
const fileInput = $<HTMLInputElement>("#file-input");
const menu = $("#file-menu") as HTMLDetailsElement;
menu.addEventListener("click", e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-file]"); if (!b) return;
  menu.open = false;
  const act = b.dataset.file;
  if (act === "new") { store.replace(emptyHouse(), "新建"); showTab("2d"); }
  else if (act === "example") { store.replace(parseHouse(example), "打开示例"); toast("已打开示例 01 房。按“撤销”可以回到之前的方案。"); }
  else if (act === "import") fileInput.click();
  else if (act === "export") download(`${store.house.name}.json`, JSON.stringify(store.house, null, 1));
});
fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0]; fileInput.value = ""; if (!f) return;
  try {
    store.replace(parseHouse(JSON.parse(await f.text())), "导入");
    toast(`已导入 ${f.name}`);
  } catch (err) {
    toast(err instanceof SyntaxError ? `${f.name} 不是有效的 JSON：${err.message}` : (err as Error).message, true);
  }
});
document.addEventListener("click", e => { if (menu.open && !menu.contains(e.target as Node)) menu.open = false; });

/* ---------- 视图切换 ---------- */
$$("[data-tab]").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab as "3d" | "2d")));
$$("[data-side]").forEach(b => b.addEventListener("click", () => showSide(b.dataset.side as SidePanel)));

// 开发时在浏览器控制台里调试用
if (import.meta.env.DEV) Object.assign(window, { app, editor });
