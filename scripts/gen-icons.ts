// Renders Gerald into the PWA icons (PNG) under public/icons. Run: npm run icons

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { SPRITE_H, SPRITE_W, spritePixels } from '../shared/sprite.ts';

type RGBA = [number, number, number, number];

const hex = (h: string, a = 255): RGBA => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

class Bitmap {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
  }
  rect(x: number, y: number, w: number, h: number, c: RGBA): void {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) this.data.set(c, (j * this.w + i) * 4);
    }
  }
  gerald(x: number, y: number, scale: number, color?: RGBA): void {
    spritePixels('idle').forEach((row, j) =>
      row.forEach((c, i) => {
        if (c) this.rect(x + i * scale, y + j * scale, scale, scale, color ?? hex(c));
      }),
    );
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(bm: Bitmap): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(bm.w, 0);
  ihdr.writeUInt32BE(bm.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((bm.w * 4 + 1) * bm.h);
  for (let y = 0; y < bm.h; y++) Buffer.from(bm.data.buffer, y * bm.w * 4, bm.w * 4).copy(raw, y * (bm.w * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** Gerald on his wood shavings, filling `fill` of the icon's width. */
function appIcon(size: number, fill: number): Bitmap {
  const bm = new Bitmap(size, size);
  bm.rect(0, 0, size, size, hex('#DDF1EE'));
  const scale = Math.floor((size * fill) / SPRITE_W);
  const w = SPRITE_W * scale;
  const h = SPRITE_H * scale;
  const x = Math.round((size - w) / 2);
  const y = Math.round((size - h) / 2 + size * 0.04);
  const floorTop = y + h - scale * 3;
  bm.rect(0, floorTop, size, size - floorTop, hex('#F1D29A'));
  bm.rect(0, floorTop, size, Math.max(2, Math.round(scale * 0.6)), hex('#C98F45'));
  bm.gerald(x, y, scale);
  return bm;
}

function transparentGerald(size: number, color?: RGBA): Bitmap {
  const bm = new Bitmap(size, size);
  const scale = Math.floor(size / SPRITE_W);
  bm.gerald(Math.round((size - SPRITE_W * scale) / 2), Math.round((size - SPRITE_H * scale) / 2), scale, color);
  return bm;
}

const out = new URL('../public/icons/', import.meta.url);
const icons: Record<string, Bitmap> = {
  'icon-192.png': appIcon(192, 0.75),
  'icon-512.png': appIcon(512, 0.75),
  'apple-touch-icon.png': appIcon(180, 0.75),
  // Maskable icons keep everything inside the central 80% circle.
  'maskable-512.png': appIcon(512, 0.56),
  'favicon-32.png': transparentGerald(32),
  // Android status-bar badge: only the alpha channel is used.
  'badge-96.png': transparentGerald(96, [255, 255, 255, 255]),
};
for (const [name, bm] of Object.entries(icons)) {
  writeFileSync(new URL(name, out), png(bm));
  console.log(`public/icons/${name}`);
}
