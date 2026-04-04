// Generates a 256x256 ICO (PNG embedded) — Windows 98 four-pane flag icon.
// No external dependencies — uses only Node.js built-ins.
'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── CRC32 ─────────────────────────────────────────────────────────────────────
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[i] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const input = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(input));
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  return Buffer.concat([len, t, data, crc]);
}

// ── RGBA pixel buffer (white background) ─────────────────────────────────────
const SIZE = 256;
const rgba = Buffer.alloc(SIZE * SIZE * 4, 0xff);

function setPixel(x, y, r, g, b) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  rgba[i] = r; rgba[i+1] = g; rgba[i+2] = b; rgba[i+3] = 0xff;
}

// Fill a convex quadrilateral (p0=TL, p1=TR, p2=BR, p3=BL, clockwise)
function fillQuad(p0, p1, p2, p3, r, g, b) {
  const minY = Math.floor(Math.min(p0[1], p1[1], p2[1], p3[1]));
  const maxY = Math.ceil(Math.max(p0[1], p1[1], p2[1], p3[1]));
  const edges = [[p0,p1],[p1,p2],[p2,p3],[p3,p0]];
  for (let y = minY; y <= maxY; y++) {
    const xs = [];
    for (const [a, bv] of edges) {
      if ((a[1] <= y && bv[1] > y) || (bv[1] <= y && a[1] > y))
        xs.push(a[0] + (y - a[1]) / (bv[1] - a[1]) * (bv[0] - a[0]));
    }
    if (xs.length < 2) continue;
    xs.sort((a, bv) => a - bv);
    for (let x = Math.floor(xs[0]); x <= Math.ceil(xs[xs.length-1]); x++)
      setPixel(x, y, r, g, b);
  }
}

// ── Windows 98 four-pane flag ─────────────────────────────────────────────────
// Layout: 4 skewed panels with a small gap. Left side raised = "flying" effect.
const margin = 22;
const gap    = 14;
const skew   = 18;

const L = margin, R = SIZE - margin, T = margin, B = SIZE - margin;
const midX = Math.round((L + R) / 2);

const TL = [L,    T + skew];
const TR = [R,    T       ];
const BR = [R,    B       ];
const BL = [L,    B - skew];

const TM = [midX, Math.round((TL[1] + TR[1]) / 2)];
const BM = [midX, Math.round((BL[1] + BR[1]) / 2)];
const ML = [L,    Math.round((TL[1] + BL[1]) / 2)];
const MR = [R,    Math.round((TR[1] + BR[1]) / 2)];
const MM = [midX, Math.round((TM[1] + BM[1]) / 2)];

const hg = gap / 2;

// Top-left: Red
fillQuad([TL[0],TL[1]], [TM[0]-hg,TM[1]], [MM[0]-hg,MM[1]-hg], [ML[0],ML[1]-hg], 0xFF,0x33,0x33);
// Top-right: Green
fillQuad([TM[0]+hg,TM[1]], [TR[0],TR[1]], [MR[0],MR[1]-hg], [MM[0]+hg,MM[1]-hg], 0x33,0xCC,0x33);
// Bottom-left: Blue
fillQuad([ML[0],ML[1]+hg], [MM[0]-hg,MM[1]+hg], [BM[0]-hg,BM[1]], [BL[0],BL[1]], 0x33,0x66,0xFF);
// Bottom-right: Yellow
fillQuad([MM[0]+hg,MM[1]+hg], [MR[0],MR[1]+hg], [BR[0],BR[1]], [BM[0]+hg,BM[1]], 0xFF,0xCC,0x00);

// ── Encode PNG ────────────────────────────────────────────────────────────────
const rawRows = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  rawRows[y * (1 + SIZE * 4)] = 0;
  rgba.copy(rawRows, y * (1 + SIZE * 4) + 1, y * SIZE * 4, (y+1) * SIZE * 4);
}
const compressed = zlib.deflateSync(rawRows, { level: 9 });
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]),
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', compressed),
  pngChunk('IEND', Buffer.alloc(0)),
]);

// ── Wrap in ICO (modern PNG-in-ICO format) ────────────────────────────────────
function le16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function le32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
const ico = Buffer.concat([
  le16(0), le16(1), le16(1),
  Buffer.from([0,0,0,0]), le16(1), le16(32), le32(png.length), le32(6+16),
  png,
]);
fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico);
console.log('icon.ico written (' + ico.length + ' bytes)');