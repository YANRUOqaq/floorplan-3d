/** 界面小工具：取元素、转义、提示条、下载文件、价格格式 */
export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export const fmt = (n: number) => "¥" + Math.round(n).toLocaleString("en-US");
export const fmtExact = (n: number) => "¥" + n.toLocaleString("en-US", { maximumFractionDigits: 1 });

let toastTimer = 0;
export function toast(msg: string, err = false, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.classList.toggle("err", err); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, err ? Math.max(ms, 6000) : ms);
}

export function download(name: string, text: string, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** 生成不和已有 id 重复的新 id，比如 uid("w", ids) → "w7" */
export function uid(prefix: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  for (let i = 1; ; i++) if (!set.has(prefix + i)) return prefix + i;
}
