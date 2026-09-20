// generate-icons.js
// Generates valid PNG icons for Chrome Extension using pure Node.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(size) {
  // Simple PNG generator with gradient and letter 'O'
  const width = size;
  const height = size;

  // Uncompressed RGBA scanlines: 1 filter byte (0) + 4 bytes per pixel
  const stride = 1 + width * 4;
  const rawData = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * stride;
    rawData[rowOffset] = 0; // Filter type None
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      
      // Radius from center
      const cx = width / 2;
      const cy = height / 2;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const r_norm = dist / (size / 2);

      // Icon color: modern violet-blue gradient (#4F46E5 to #06B6D4) with rounded rect
      const cornerR = size * 0.22;
      const inBox = (
        x >= cornerR && x <= width - cornerR && y >= 2 && y <= height - 2
      ) || (
        y >= cornerR && y <= height - cornerR && x >= 2 && x <= width - 2
      ) || (
        Math.hypot(x - cornerR, y - cornerR) <= cornerR && x < cornerR && y < cornerR
      ) || (
        Math.hypot(x - (width - cornerR), y - cornerR) <= cornerR && x > width - cornerR && y < cornerR
      ) || (
        Math.hypot(x - cornerR, y - (height - cornerR)) <= cornerR && x < cornerR && y > height - cornerR
      ) || (
        Math.hypot(x - (width - cornerR), y - (height - cornerR)) <= cornerR && x > width - cornerR && y > height - cornerR
      );

      if (!inBox) {
        // Transparent outside rounded rect
        rawData[pxOffset] = 0;
        rawData[pxOffset + 1] = 0;
        rawData[pxOffset + 2] = 0;
        rawData[pxOffset + 3] = 0;
      } else {
        // Background gradient
        const t = (x + y) / (width + height);
        let r = Math.round(79 * (1 - t) + 6 * t);
        let g = Math.round(70 * (1 - t) + 182 * t);
        let b = Math.round(229 * (1 - t) + 212 * t);

        // Center badge: white play triangle / radar symbol
        // Equilateral triangle pointing right
        const tx = (x - cx) / (size * 0.3);
        const ty = (y - cy) / (size * 0.3);
        if (tx >= -0.5 && tx <= 0.6 && ty >= -0.6 + (tx + 0.5) * 0.5 && ty <= 0.6 - (tx + 0.5) * 0.5) {
          r = 255;
          g = 255;
          b = 255;
        }

        rawData[pxOffset] = r;
        rawData[pxOffset + 1] = g;
        rawData[pxOffset + 2] = b;
        rawData[pxOffset + 3] = 255;
      }
    }
  }

  // Deflate
  const compressed = zlib.deflateSync(rawData);

  // Build PNG chunks
  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    const crc = crc32(Buffer.concat([typeBuf, data]));
    crcBuf.writeInt32BE(crc, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  // CRC32 implementation
  function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
      let byte = buf[i];
      for (let j = 0; j < 8; j++) {
        if ((crc ^ byte) & 1) {
          crc = (crc >>> 1) ^ 0xEDB88320;
        } else {
          crc = crc >>> 1;
        }
        byte >>>= 1;
      }
    }
    return (crc ^ -1) | 0;
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth
  ihdr[9] = 6; // Color type RGBA
  ihdr[10] = 0; // Compression
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // Interlace

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

[16, 48, 128].forEach(size => {
  const png = createPNG(size);
  const outPath = path.join(__dirname, 'extension', 'icons', `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Generated ${outPath} (${png.length} bytes)`);
});
