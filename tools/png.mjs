// A minimal PNG decoder/encoder built on Node's built-in zlib.
//
// Only what chrome-headless-shell's Page.captureScreenshot actually emits and
// what this harness needs to write back: 8-bit non-interlaced images, and
// 8-bit RGBA output. Anything outside that throws rather than guessing.
import { inflateSync, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Channels per pixel by PNG color type.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Decode a PNG buffer to { width, height, data } where data is RGBA bytes. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG (bad signature)');

  let head = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      head = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], color: data[9], interlace: data[12],
      };
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') transparency = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!head) throw new Error('PNG has no IHDR');
  if (head.depth !== 8) throw new Error(`unsupported PNG bit depth ${head.depth}`);
  if (head.interlace !== 0) throw new Error('interlaced PNGs are not supported');
  const channels = CHANNELS[head.color];
  if (!channels) throw new Error(`unsupported PNG color type ${head.color}`);
  if (head.color === 3 && !palette) throw new Error('indexed PNG without a PLTE chunk');

  const { width, height } = head;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) {
    throw new Error(`PNG pixel data is short: ${raw.length} < ${height * (stride + 1)}`);
  }

  // Undo the per-scanline filters in place, into a contiguous unfiltered buffer.
  const flat = Buffer.allocUnsafe(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? flat[dst + x - channels] : 0;
      const b = y > 0 ? flat[up + x] : 0;
      const c = x >= channels && y > 0 ? flat[up + x - channels] : 0;
      let out;
      switch (filter) {
        case 0: out = v; break;
        case 1: out = v + a; break;
        case 2: out = v + b; break;
        case 3: out = v + ((a + b) >> 1); break;
        case 4: out = v + paeth(a, b, c); break;
        default: throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
      }
      flat[dst + x] = out & 0xff;
    }
  }

  // Expand to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels, d = i * 4;
    switch (head.color) {
      case 0: rgba[d] = rgba[d + 1] = rgba[d + 2] = flat[s]; rgba[d + 3] = 255; break;
      case 2: rgba[d] = flat[s]; rgba[d + 1] = flat[s + 1]; rgba[d + 2] = flat[s + 2]; rgba[d + 3] = 255; break;
      case 3: {
        const p = flat[s] * 3;
        rgba[d] = palette[p]; rgba[d + 1] = palette[p + 1]; rgba[d + 2] = palette[p + 2];
        rgba[d + 3] = transparency && flat[s] < transparency.length ? transparency[flat[s]] : 255;
        break;
      }
      case 4: rgba[d] = rgba[d + 1] = rgba[d + 2] = flat[s]; rgba[d + 3] = flat[s + 1]; break;
      default: rgba[d] = flat[s]; rgba[d + 1] = flat[s + 1]; rgba[d + 2] = flat[s + 2]; rgba[d + 3] = flat[s + 3];
    }
  }
  return { width, height, data: rgba };
}

function chunk(type, data) {
  const out = Buffer.allocUnsafe(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode RGBA bytes to a PNG buffer. Filter type 0 throughout; zlib does the work. */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.allocUnsafe(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
