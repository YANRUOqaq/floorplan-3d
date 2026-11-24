/**
 * 描图底图存在浏览器的 IndexedDB 里（图片可能有几 MB，localStorage 放不下，也不该写进 house.json）。
 * 只存一张：当前方案的底图。
 */
const DB = "floorplan-3d", STORE = "files", KEY = "background";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export interface BgImage { blob: Blob; w: number; h: number; name: string }

export const loadBg = () => tx<BgImage | undefined>("readonly", s => s.get(KEY));
export const saveBg = (img: BgImage) => tx("readwrite", s => s.put(img, KEY));
export const clearBg = () => tx("readwrite", s => s.delete(KEY));

/** 读图片文件的像素尺寸 */
export function imageSize(blob: Blob): Promise<{ w: number; h: number }> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob), im = new Image();
    im.onload = () => { res({ w: im.naturalWidth, h: im.naturalHeight }); URL.revokeObjectURL(url); };
    im.onerror = () => { rej(new Error("图片读不出来，换成 JPG 或 PNG 试试")); URL.revokeObjectURL(url); };
    im.src = url;
  });
}
