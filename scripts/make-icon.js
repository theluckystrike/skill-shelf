// Generates media/icon.png (128x128) with no dependencies: signed-distance shapes,
// 4x4 supersampling, PNG written with zlib.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 128, H = 128, SS = 4;

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r, qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// Layers drawn in order: [sdf(x,y) -> distance, rgb]
const layers = [
  [(x, y) => sdRoundRect(x, y, 64, 64, 60, 60, 26), hex('#1F2A44')],
  // three stacked skill cards
  [(x, y) => sdRoundRect(x, y, 58, 40, 34, 11, 6), hex('#5B8DEF')],
  [(x, y) => sdRoundRect(x, y, 58, 64, 34, 11, 6), hex('#7C6CF0')],
  [(x, y) => sdRoundRect(x, y, 58, 88, 34, 11, 6), hex('#36B37E')],
  // text lines on the cards
  [(x, y) => Math.min(sdRoundRect(x, y, 50, 40, 18, 2.5, 2.5), sdRoundRect(x, y, 50, 64, 18, 2.5, 2.5), sdRoundRect(x, y, 50, 88, 18, 2.5, 2.5)), hex('#F4F6FB')],
  // check badge
  [(x, y) => Math.hypot(x - 96, y - 92) - 20, hex('#F4F6FB')],
  [(x, y) => Math.min(sdSegment(x, y, 86, 92, 93, 99, 3.6), sdSegment(x, y, 93, 99, 106, 85, 3.6)), hex('#1F2A44')],
];

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      let cr = 0, cg = 0, cb = 0, ca = 0;
      for (const [f, c] of layers) {
        if (f(px, py) <= 0) { cr = c[0]; cg = c[1]; cb = c[2]; ca = 255; }
      }
      r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
    }
    const o = y * (W * 4 + 1) + 1 + x * 4;
    const n = SS * SS;
    raw[o] = a ? Math.round(r / a) : 0;
    raw[o + 1] = a ? Math.round(g / a) : 0;
    raw[o + 2] = a ? Math.round(b / a) : 0;
    raw[o + 3] = Math.round(a / n);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
