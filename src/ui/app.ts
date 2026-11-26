/** 各个界面模块共用的上下文，由 main.ts 创建后传进来（避免模块之间互相 import 形成循环） */
import type { Store } from "../model/store";
import type { Viewer } from "../three/viewer";

export type SidePanel = "plan" | "ai" | "list";
export interface App {
  store: Store;
  viewer: Viewer;
  /** 当前选中的家具 id（3D 里点的、2D 里点的、清单里点的都是这一个） */
  selected: string | null;
  showSide(s: SidePanel): void;
  showTab(t: "3d" | "2d"): void;
  /** 选中一件家具，3D、2D、面板一起更新 */
  select(id: string | null): void;
  /** 打开“布置家具”对话框（选风格、自动布置、可选让大模型按想法改） */
  furnish(): void;
}
