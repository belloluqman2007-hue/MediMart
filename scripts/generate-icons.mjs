/**
 * Generate the MediMart application icons without external tooling.
 *
 * A tiny PNG encoder writes the same rounded green mark with a white medical cross that the web
 * favicon and the Android adaptive icon use, so the desktop window, taskbar, installer and phone
 * launcher all show one identity. Rerun with `node scripts/generate-icons.mjs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const GREEN = [25, 116, 94];
const MINT = [179, 226, 207];
const WHITE = [255, 255, 255];

/** Rounded square background, white medical cross, mint highlight — the same mark as favicon.svg. */
function pixel(x, y, size) {
  const u = (x + 0.5) / size;
  const v = (y + 0.5) / size;
  const radius = 0.22;
  const inside = (() => {
    if (u < radius && v < radius) return (u - radius) ** 2 + (v - radius) ** 2 <= radius ** 2;
    if (u > 1 - radius && v < radius)
      return (u - (1 - radius)) ** 2 + (v - radius) ** 2 <= radius ** 2;
    if (u < radius && v > 1 - radius)
      return (u - radius) ** 2 + (v - (1 - radius)) ** 2 <= radius ** 2;
    if (u > 1 - radius && v > 1 - radius)
      return (u - (1 - radius)) ** 2 + (v - (1 - radius)) ** 2 <= radius ** 2;
    return true;
  })();
  if (!inside) return [0, 0, 0, 0];
  const crossH = u > 0.22 && u < 0.78 && v > 0.38 && v < 0.62;
  const crossV = u > 0.38 && u < 0.62 && v > 0.22 && v < 0.78;
  if (crossH || crossV) {
    if (u > 0.5 && u < 0.62 && v > 0.22 && v < 0.38) return [...MINT, 255];
    return [...WHITE, 255];
  }
  return [...GREEN, 255];
}

// apps/desktop/assets is committed (not a `build/` folder, which is git-ignored).
mkdirSync(join('apps/desktop/assets'), { recursive: true });
const targets = [
  ['icon.svg', null],
  ...['16', '24', '32', '48', '64', '128', '256', '512'].map((s) => [`icon-${s}.png`, Number(s)]),
  ['icon.png', 256],
];
for (const [name, size] of targets) {
  if (size === null) continue;
  writeFileSync(join('apps/desktop/assets', name), png(size, pixel));
}
console.log('wrote', targets.length, 'icons to apps/desktop/assets');
