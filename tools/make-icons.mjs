#!/usr/bin/env node
/**
 * make-icons.mjs — generates every PWA app icon PNG by hand.
 *
 * No image libraries, no npm, no build step: this is a from-scratch PNG
 * encoder (zlib for the DEFLATE/IDAT stream + a hand-rolled CRC32) and a
 * tiny procedural 2D rasterizer (filled circles/rings/diamonds via
 * supersampled coverage) used to draw a chunky gold/red casino chip on a
 * deep violet ground — the game's thick-dark-outline / flat-fill art style.
 *
 * Run with:  node tools/make-icons.mjs
 *
 * Emits into ../icons/ (relative to this file):
 *   icon-192.png            192x192  — full-canvas, small margin, "any" purpose
 *   icon-512.png             512x512  — full-canvas, small margin, "any" purpose
 *   icon-512-maskable.png    512x512  — full-bleed bg, artwork kept inside the
 *                                       40%-radius Android maskable safe zone
 *   apple-touch-icon-180.png 180x180  — full-canvas, small margin, no alpha
 *   favicon-32.png            32x32   — simplified (no rim ticks) for legibility
 *
 * NOTE ON FILENAMES: the task brief that spawned this script asked for
 * "icons/icon-maskable-512.png". The manifest already committed to disk by
 * a sibling agent (manifest.webmanifest) instead references
 * "./icons/icon-512-maskable.png". Since the manifest is the live contract
 * Chrome actually reads to decide installability, this script matches the
 * manifest's filename so the maskable icon is not orphaned. See the final
 * report for details.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'icons');
mkdirSync(outDir, { recursive: true });

/* ------------------------------------------------------------------ *
 *  CRC32 — hand-rolled table + accumulator (PNG spec Annex D)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ------------------------------------------------------------------ *
 *  PNG chunk / container writer
 * ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** Encode an RGBA8 pixel buffer (row-major, width*height*4 bytes) as a PNG. */
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type 6 = truecolor + alpha (RGBA)
  ihdr[10] = 0; // compression method (only valid value)
  ihdr[11] = 0; // filter method (only valid value)
  ihdr[12] = 0; // interlace method: none

  // Raw scanlines, each prefixed with filter-type byte 0 (None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: None
    rgba.copy(raw, rowStart + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ *
 *  Tiny procedural rasterizer — coverage-antialiased shape fills
 * ------------------------------------------------------------------ */

function makeCanvas(w, h) {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) }; // transparent black
}

/** Fill the entire canvas with an opaque solid color (fast path, no blending). */
function fillSolid(canvas, r, g, b) {
  const d = canvas.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  }
}

/** Standard "over" alpha compositing of one src pixel onto the canvas. */
function blendPixel(canvas, x, y, r, g, b, srcA) {
  if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h || srcA <= 0) return;
  const i = (y * canvas.w + x) * 4;
  const d = canvas.data;
  const dstA = d[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; return; }
  d[i]     = (r * srcA + d[i]     * dstA * (1 - srcA)) / outA;
  d[i + 1] = (g * srcA + d[i + 1] * dstA * (1 - srcA)) / outA;
  d[i + 2] = (b * srcA + d[i + 2] * dstA * (1 - srcA)) / outA;
  d[i + 3] = outA * 255;
}

/**
 * Fill every pixel where `testFn(x, y)` is true with `color` ([r,g,b,a0..255]),
 * antialiasing the boundary via an SSxSS supersample grid per pixel.
 */
function fillShape(canvas, testFn, color, ss = 4) {
  const [r, g, b, a255] = color;
  const baseA = a255 / 255;
  for (let y = 0; y < canvas.h; y++) {
    for (let x = 0; x < canvas.w; x++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        const py = y + (sy + 0.5) / ss;
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          if (testFn(px, py)) hits++;
        }
      }
      if (hits === 0) continue;
      const coverage = hits / (ss * ss);
      blendPixel(canvas, x, y, r, g, b, coverage * baseA);
    }
  }
}

// --- shape predicates -------------------------------------------------

const circleTest = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/** Axis-aligned diamond (rhombus): |dx|/rx + |dy|/ry <= 1. */
const diamondTest = (cx, cy, rx, ry) => (x, y) =>
  Math.abs(x - cx) / rx + Math.abs(y - cy) / ry <= 1;

/** `count` equal-width radial ticks (poker-chip rim spots), centered on 360/count multiples. */
const ringTicksTest = (cx, cy, rInner, rOuter, count, halfWidthDeg) => {
  const step = 360 / count;
  return (x, y) => {
    const dx = x - cx, dy = y - cy;
    const d = Math.hypot(dx, dy);
    if (d < rInner || d > rOuter) return false;
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (ang < 0) ang += 360;
    const rel = ang % step;
    const distToTick = Math.min(rel, step - rel);
    return distToTick <= halfWidthDeg;
  };
};

/* ------------------------------------------------------------------ *
 *  The icon artwork — a chunky gold/red casino chip on a deep-violet
 *  ground, thick dark outlines throughout. Colors are pulled from / kept
 *  in the same family as the game's own luxury-tier palette
 *  (src/core/config.js TIERS[2]) for visual continuity.
 * ------------------------------------------------------------------ */

const BG            = [0x2b, 0x0f, 0x38]; // deep violet ground
const OUTLINE       = [0x1a, 0x06, 0x20]; // near-black violet — thick outline
const CHIP_RED      = [0xd1, 0x26, 0x2f];
const GOLD          = [0xff, 0xcf, 0x3f]; // matches WORLDS.downtown accent
const INNER_VIOLET  = [0x5c, 0x2a, 0x66]; // matches TIERS[2] (luxury) floor

/**
 * @param {number} size square canvas size in px
 * @param {object} opts
 * @param {number} opts.chipRadiusFrac  outer chip radius as a fraction of `size`
 * @param {boolean} [opts.simple] skip the rim ticks (too fine to read very small)
 * @param {number} [opts.ss] supersample grid per axis
 */
function drawChipIcon(size, { chipRadiusFrac, simple = false, ss = 4 }) {
  const canvas = makeCanvas(size, size);
  const cx = size / 2;
  const cy = size / 2;

  // Full-bleed opaque background — no transparency anywhere in the icon.
  fillSolid(canvas, ...BG);

  const R = size * chipRadiusFrac;
  const outlineW = Math.max(1, R * 0.07);

  // Chip silhouette: dark outline circle, then the red body inset by outlineW.
  fillShape(canvas, circleTest(cx, cy, R), [...OUTLINE, 255], ss);
  fillShape(canvas, circleTest(cx, cy, R - outlineW), [...CHIP_RED, 255], ss);

  if (!simple) {
    // Poker-chip rim ticks: dark outline pass (wider) then gold pass (inset).
    const tickOuter = R - outlineW * 0.5;
    const tickInner = (R - outlineW) * 0.72;
    fillShape(
      canvas,
      ringTicksTest(cx, cy, tickInner - outlineW * 0.5, tickOuter, 8, 16),
      [...OUTLINE, 255],
      ss
    );
    fillShape(
      canvas,
      ringTicksTest(cx, cy, tickInner, tickOuter - outlineW * 0.5, 8, 12),
      [...GOLD, 255],
      ss
    );
  }

  // Inner disc: dark outline ring, then the violet face inset by outlineW.
  const innerR = (R - outlineW) * 0.58;
  fillShape(canvas, circleTest(cx, cy, innerR), [...OUTLINE, 255], ss);
  fillShape(canvas, circleTest(cx, cy, innerR - outlineW * 0.7), [...INNER_VIOLET, 255], ss);

  // Center emblem: gold diamond with a dark outline, sat inside the inner disc.
  const dOuterX = innerR * 0.62;
  const dOuterY = innerR * 0.8;
  fillShape(canvas, diamondTest(cx, cy, dOuterX, dOuterY), [...OUTLINE, 255], ss);
  fillShape(
    canvas,
    diamondTest(cx, cy, dOuterX - outlineW * 0.9, dOuterY - outlineW * 0.9),
    [...GOLD, 255],
    ss
  );

  return canvas;
}

/* ------------------------------------------------------------------ *
 *  Emit every required icon
 * ------------------------------------------------------------------ */

const targets = [
  // Non-maskable, "any" purpose: full canvas, small opaque margin around the chip.
  { file: 'icon-192.png', size: 192, chipRadiusFrac: 0.44, ss: 4 },
  { file: 'icon-512.png', size: 512, chipRadiusFrac: 0.44, ss: 4 },
  // Maskable: background bleeds to all 4 edges (already does — fillSolid covers
  // the whole canvas); artwork kept inside the 40%-of-width safe-zone radius.
  { file: 'icon-512-maskable.png', size: 512, chipRadiusFrac: 0.36, ss: 4 },
  // Apple touch icon: no alpha (guaranteed by our opaque fillSolid base), full
  // canvas with a small margin, same treatment as the "any" icons.
  { file: 'apple-touch-icon-180.png', size: 180, chipRadiusFrac: 0.44, ss: 4 },
  // Favicon: tiny canvas — drop the rim ticks (they alias into mush at 32px)
  // and use a denser supersample grid so the remaining edges stay crisp.
  { file: 'favicon-32.png', size: 32, chipRadiusFrac: 0.46, simple: true, ss: 8 }
];

const report = [];

for (const t of targets) {
  const canvas = drawChipIcon(t.size, t);
  const png = encodePNG(t.size, t.size, Buffer.from(canvas.data.buffer, canvas.data.byteOffset, canvas.data.byteLength));
  const outPath = join(outDir, t.file);
  writeFileSync(outPath, png);
  report.push({ file: t.file, path: outPath, expectedSize: t.size });
}

/* ------------------------------------------------------------------ *
 *  Self-verification: re-read each PNG from disk, confirm the 8-byte
 *  signature, parse IHDR, and check declared width/height + byte size.
 * ------------------------------------------------------------------ */

console.log('\nVerification:');
let allOk = true;
for (const r of report) {
  const buf = readFileSync(r.path);
  const sigOk = buf.subarray(0, 8).equals(PNG_SIGNATURE);
  // IHDR chunk starts right after the 8-byte signature: 4-byte length,
  // 4-byte type "IHDR", then the 13 bytes of IHDR data.
  const ihdrType = buf.subarray(12, 16).toString('ascii');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const sizeOk = width === r.expectedSize && height === r.expectedSize;
  const nonTrivial = buf.length > 200; // a flat-fill 32x32 still compresses to well over this
  const ok = sigOk && ihdrType === 'IHDR' && sizeOk && bitDepth === 8 && colorType === 6 && nonTrivial;
  allOk = allOk && ok;
  console.log(
    `  ${r.file.padEnd(26)} ${String(buf.length).padStart(6)} bytes  ` +
    `sig=${sigOk} ihdr=${ihdrType} ${width}x${height} depth=${bitDepth} colorType=${colorType}  ` +
    `${ok ? 'OK' : 'FAIL'}`
  );
}

if (!allOk) {
  console.error('\nOne or more icons failed verification.');
  process.exit(1);
}
console.log('\nAll icons generated and verified.');
