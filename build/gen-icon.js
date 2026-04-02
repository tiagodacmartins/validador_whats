// Generates a minimal valid 256x256 ICO file (single BMP frame)
// No external dependencies required
const fs = require('fs');
const path = require('path');

function le16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function le32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

// Create a 32x32 RGBA BMP for ICO (green WhatsApp-ish colour #0d8f7a)
const SIZE = 256;
const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    // Draw a rounded-square background
    const cx = SIZE / 2, cy = SIZE / 2, r = SIZE / 2 - 2;
    const dx = x - cx, dy = y - cy;
    const inCircle = Math.sqrt(dx * dx + dy * dy) < r;
    if (inCircle) {
      pixels[i]     = 0x7a; // B
      pixels[i + 1] = 0x8f; // G
      pixels[i + 2] = 0x0d; // R
      pixels[i + 3] = 0xff; // A
    } else {
      pixels[i] = pixels[i+1] = pixels[i+2] = pixels[i+3] = 0;
    }
  }
}

// BMP DIB header (BITMAPINFOHEADER) for ICO = height * 2 (XOR + AND masks)
const dibHeader = Buffer.concat([
  le32(40),          // biSize
  le32(SIZE),        // biWidth
  le32(SIZE * 2),    // biHeight (doubled for ICO)
  le16(1),           // biPlanes
  le16(32),          // biBitCount
  le32(0),           // biCompression = BI_RGB
  le32(0),           // biSizeImage
  le32(0), le32(0),  // X/Y pixels per meter
  le32(0), le32(0),  // clrUsed / clrImportant
]);

// Pixel data (bottom-up)
const xorMask = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const src = (y * SIZE + x) * 4;
    const dst = ((SIZE - 1 - y) * SIZE + x) * 4;
    xorMask[dst]     = pixels[src];
    xorMask[dst + 1] = pixels[src + 1];
    xorMask[dst + 2] = pixels[src + 2];
    xorMask[dst + 3] = pixels[src + 3];
  }
}

// AND mask (1-bit transparency, all 0 = opaque)
const andMask = Buffer.alloc(SIZE * SIZE / 8);

const imageData = Buffer.concat([dibHeader, xorMask, andMask]);
const imageSize = imageData.length;

// ICO header
const icoHeader = Buffer.concat([
  le16(0),        // reserved
  le16(1),        // type = ICO
  le16(1),        // image count
]);

// Image directory entry (16 bytes)
const dirEntry = Buffer.concat([
  Buffer.from([SIZE === 256 ? 0 : SIZE]),  // width (0 = 256)
  Buffer.from([SIZE === 256 ? 0 : SIZE]),  // height
  Buffer.from([0]),    // color count
  Buffer.from([0]),    // reserved
  le16(1),             // planes
  le16(32),            // bit count
  le32(imageSize),     // size of image data
  le32(6 + 16),        // offset of image data
]);

const ico = Buffer.concat([icoHeader, dirEntry, imageData]);
fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico);
console.log('icon.ico created (' + ico.length + ' bytes)');
