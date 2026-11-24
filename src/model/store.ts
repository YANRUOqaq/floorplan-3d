/**
 * 当前方案的唯一来源。所有修改都走 commit()：
 * - 先校验，不合格的改动不会生效；
 * - 每次修改存一份整份快照，撤销和重做就是在快照之间切换（户型数据只有几十 KB，存整份最简单可靠）；
 * - 自动保存到 localStorage，刷新页面不丢。
 * 界面各部分用 subscribe() 监听变化后重画。
 */
import { parseHouse, type House } from "./schema";

const KEY = "floorplan-3d:house";
const LIMIT = 100;

type Listener = (h: House, why: string) => void;

export class Store {
  private past: House[] = [];
  private future: House[] = [];
  private listeners = new Set<Listener>();
  constructor(private cur: House, private storage: Pick<Storage, "getItem" | "setItem"> | null = null) {}

  get house(): House { return this.cur; }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  subscribe(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** 用一个修改函数改出新方案。函数拿到的是深拷贝，可以直接改 */
  commit(why: string, edit: (draft: House) => void) {
    const draft = structuredClone(this.cur);
    edit(draft);
    this.set(parseHouse(draft), why);
  }
  /** 整份替换（导入、打开示例、大模型改完） */
  replace(next: House, why: string) { this.set(parseHouse(next), why); }

  private set(next: House, why: string) {
    this.past.push(this.cur);
    if (this.past.length > LIMIT) this.past.shift();
    this.future = [];
    this.cur = next;
    this.emit(why);
  }
  undo() { const p = this.past.pop(); if (!p) return; this.future.push(this.cur); this.cur = p; this.emit("撤销"); }
  redo() { const f = this.future.pop(); if (!f) return; this.past.push(this.cur); this.cur = f; this.emit("重做"); }

  private emit(why: string) {
    try { this.storage?.setItem(KEY, JSON.stringify(this.cur)); } catch { /* 存储满了或被禁用：不影响使用，只是刷新后不保留 */ }
    for (const fn of this.listeners) fn(this.cur, why);
  }

  /** 读上次自动保存的方案；没有或已损坏时返回 null */
  static restore(storage: Pick<Storage, "getItem">): House | null {
    const s = storage.getItem(KEY);
    if (!s) return null;
    try { return parseHouse(JSON.parse(s)); } catch { return null; }
  }
}
