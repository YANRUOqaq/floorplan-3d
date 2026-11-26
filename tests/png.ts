import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import type { Gray } from "../src/model/raster";

/** 解开本地样本所用的非隔行、8 位灰度或真彩色 PNG。 */
export function pngGray(path: string): Gray {
  const png = readFileSync(path);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[png[25]];
  if (png[24] !== 8 || png[28] !== 0 || !channels) throw new Error("PNG 需要非隔行的 8 位灰度或真彩色数据");
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = w * channels;
  let previous = new Uint8Array(stride);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = new Uint8Array(stride);
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      row[i] = raw[y * (stride + 1) + 1 + i] + [0, a, b, (a + b) >> 1, paeth][filter];
    }
    for (let x = 0; x < w; x++) {
      const i = x * channels;
      const gray = channels < 3 ? row[i] : 0.299 * row[i] + 0.587 * row[i + 1] + 0.114 * row[i + 2];
      const alpha = channels % 2 === 0 ? row[i + channels - 1] / 255 : 1;
      data[y * w + x] = Math.round(gray * alpha + 255 * (1 - alpha));
    }
    previous = row;
  }
  return { w, h, data };
}

