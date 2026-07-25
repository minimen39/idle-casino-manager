/**
 * renderer.js — 2:1 dimetric ISOMETRIC Canvas 2D renderer for Idle Casino Manager.
 *
 * Art direction: Idle Miner Tycoon / Idle Bank Tycoon / Idle Lumber Empire.
 *   * Bright, saturated, cheerful flat fills. High chroma, no muddy greys.
 *   * Thick dark outlines on every object and character (a darker shade of the fill).
 *   * Chunky, rounded, over-simplified iso boxes: lit top face, mid-tone left face,
 *     darker right face — cheap fake 3D.
 *   * Big-headed chibi characters with a soft contact shadow and a walk bob.
 *   * The whole casino is a floating diorama: a raised slab with a skirt, low walls
 *     on the two back edges, sitting on a colored backdrop.
 *
 * Coordinate spaces (the camera contract):
 *   1. WORLD px — what layout.js / guests.js / liveEvents.js use. UNCHANGED.
 *   2. ISO px   — world projected onto the dimetric plane (worldToIso).
 *   3. CSS px   — iso * camera.zoom + camera.pan, then scaled by dpr for the backing store.
 *
 * Performance strategy:
 *   * The ground plane (slab, skirt, floor tiles, walls, queue pads, doors, light
 *     pools, wall neon) is baked once into an offscreen canvas *in iso space* and
 *     blitted each frame. It is re-baked only when the layout/tier/world changes or
 *     the zoom crosses a half-step resolution bucket.
 *   * Every venue sprite is baked once per (key, footprint) into a small offscreen
 *     canvas and blitted in the depth-sorted pass, so venues can be occluded by and
 *     occlude characters correctly.
 *   * A reusable z-buffer depth-sorts venues + guests + staff + actors by (wx + wy).
 *   * No allocations in the hot loops, no shadowBlur inside per-character work.
 */

import { CONFIG, VENUES, STATIONS, tierDef } from '../core/config.js';
import { t, dir } from '../core/i18n.js';

/* ------------------------------------------------------------------ *
 *  Small math helpers
 * ------------------------------------------------------------------ */

const TAU = Math.PI * 2;
const RCFG = CONFIG.render;
const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Arial, "Helvetica Neue", sans-serif';

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Deterministic hash -> 0..1. Used for every "random" decoration so bakes are stable. */
function rnd(i, seed) {
  let t = (i + Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  t ^= t >>> 15;
  t = Math.imul(t, 0x85ebca6b) >>> 0;
  t ^= t >>> 13;
  t = Math.imul(t, 0xc2b2ae35) >>> 0;
  t ^= t >>> 16;
  return (t >>> 0) / 4294967296;
}

/**
 * Numeric animation seed from an entity id. GuestSim/LiveEventSim hand out
 * numeric ids, StaffSim hands out strings like 'dealer_3' — both must produce a
 * finite number or every downstream Math.sin() becomes NaN.
 */
function idSeed(id) {
  const n = Number(id);
  if (Number.isFinite(n)) return n;
  const s = String(id == null ? '' : id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
  return h;
}

/* ------------------------------------------------------------------ *
 *  Color helpers
 * ------------------------------------------------------------------ */

const _rgbCache = new Map();

/** '#rrggbb' | '#rgb' | 'rgb(a)(...)' -> {r,g,b,a}. Cached; never throws. */
function rgbOf(color) {
  if (typeof color !== 'string' || color.length === 0) return { r: 128, g: 128, b: 128, a: 1 };
  const hit = _rgbCache.get(color);
  if (hit) return hit;

  let out = { r: 128, g: 128, b: 128, a: 1 };
  const c = color.trim();
  if (c.charCodeAt(0) === 35 /* # */) {
    if (c.length === 4) {
      out = {
        r: parseInt(c[1] + c[1], 16),
        g: parseInt(c[2] + c[2], 16),
        b: parseInt(c[3] + c[3], 16),
        a: 1
      };
    } else if (c.length >= 7) {
      out = {
        r: parseInt(c.slice(1, 3), 16),
        g: parseInt(c.slice(3, 5), 16),
        b: parseInt(c.slice(5, 7), 16),
        a: c.length >= 9 ? parseInt(c.slice(7, 9), 16) / 255 : 1
      };
    }
  } else if (c.indexOf('rgb') === 0) {
    const open = c.indexOf('(');
    const close = c.indexOf(')');
    if (open > -1 && close > open) {
      const parts = c.slice(open + 1, close).split(',');
      out = {
        r: parseFloat(parts[0]) || 0,
        g: parseFloat(parts[1]) || 0,
        b: parseFloat(parts[2]) || 0,
        a: parts.length > 3 ? (parseFloat(parts[3]) || 0) : 1
      };
    }
  }
  if (!Number.isFinite(out.r)) out.r = 128;
  if (!Number.isFinite(out.g)) out.g = 128;
  if (!Number.isFinite(out.b)) out.b = 128;
  if (!Number.isFinite(out.a)) out.a = 1;
  if (_rgbCache.size < 512) _rgbCache.set(color, out);
  return out;
}

function hex2(n) {
  const v = clamp(Math.round(n), 0, 255).toString(16);
  return v.length === 1 ? '0' + v : v;
}

const _mixCache = new Map();

/** Linear blend a->b by t (0..1) returning '#rrggbb'. Cached. */
function mix(a, b, t) {
  const k = a + '|' + b + '|' + t.toFixed(3);
  const hit = _mixCache.get(k);
  if (hit) return hit;
  const A = rgbOf(a);
  const B = rgbOf(b);
  const out =
    '#' + hex2(A.r + (B.r - A.r) * t) + hex2(A.g + (B.g - A.g) * t) + hex2(A.b + (B.b - A.b) * t);
  if (_mixCache.size < 4096) _mixCache.set(k, out);
  return out;
}

/** amt > 0 lightens, amt < 0 darkens. */
function shade(color, amt) {
  return amt >= 0 ? mix(color, '#ffffff', clamp(amt, 0, 1)) : mix(color, '#000000', clamp(-amt, 0, 1));
}

const _rgbaCache = new Map();

function rgba(color, alpha) {
  const k = color + '|' + alpha.toFixed(3);
  const hit = _rgbaCache.get(k);
  if (hit) return hit;
  const c = rgbOf(color);
  const out =
    'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + clamp(alpha, 0, 1) + ')';
  if (_rgbaCache.size < 4096) _rgbaCache.set(k, out);
  return out;
}

/* --- HSL, used to force the (deliberately muted) config palettes into the
       bright saturated cartoon range without touching config.js. --- */

function hue2rgb(p, q, t) {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 0.5) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

function toHsl(color) {
  const c = rgbOf(color);
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0;
  let s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hslHex(h, s, l) {
  const hh = ((h % 1) + 1) % 1;
  const ss = clamp(s, 0, 1);
  const ll = clamp(l, 0, 1);
  if (ss <= 1e-6) return '#' + hex2(ll * 255) + hex2(ll * 255) + hex2(ll * 255);
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  return (
    '#' +
    hex2(hue2rgb(p, q, hh + 1 / 3) * 255) +
    hex2(hue2rgb(p, q, hh) * 255) +
    hex2(hue2rgb(p, q, hh - 1 / 3) * 255)
  );
}

const _vividCache = new Map();

/** Keep the hue, force high chroma and a target lightness. This is what turns the
 *  dark WORLDS[i].palette entries into candy colors while preserving world identity. */
function vivid(color, minSat, targetLight) {
  const k = color + '|' + minSat + '|' + targetLight;
  const hit = _vividCache.get(k);
  if (hit) return hit;
  const c = toHsl(color);
  const out = hslHex(c.h, Math.max(c.s, minSat), c.l + (targetLight - c.l) * 0.82);
  if (_vividCache.size < 1024) _vividCache.set(k, out);
  return out;
}

/**
 * Take a color's HUE outright and force an exact saturation/lightness,
 * discarding its original chroma/value entirely. Unlike vivid()/mix(), this
 * never blends two different hues together — RGB-mixing across hues (e.g. a
 * mint tier neon with a hot-pink world neon) cancels chroma and produces a
 * grey/beige "mud" color. Used for saturated accents (neon signs, accent
 * trim) where the WORLD hue must win outright and the tier only contributes
 * a saturation/lightness target.
 */
function hueForce(color, sat, light) {
  const h = toHsl(color).h;
  return hslHex(h, sat, light);
}

/** Shortest-arc hue interpolation (0..1 hue wheel). */
function hueLerp(h1, h2, t) {
  let d = h2 - h1;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return ((h1 + d * t) % 1 + 1) % 1;
}

/**
 * Blend a base material's HUE toward another color's hue (in HSL hue-space,
 * not RGB), then force a saturation/lightness target. This is how world
 * identity is threaded into materials (wood/chair/cabinet/felt/metal/gold/
 * cloth) without the chroma-cancelling mud that a plain RGB mix() produces
 * when the two inputs sit on opposite sides of the color wheel.
 */
function hueTint(base, towardColor, t, sat, light) {
  const h = hueLerp(toHsl(base).h, toHsl(towardColor).h, t);
  return hslHex(h, sat, light);
}

/** Thick-outline color for a fill: a much darker shade of the fill itself. */
const _inkCache = new Map();
function ink(color) {
  const hit = _inkCache.get(color);
  if (hit) return hit;
  const c = toHsl(color);
  const out = hslHex(c.h, Math.min(1, c.s * 0.95 + 0.1), Math.max(0.07, c.l * 0.36));
  if (_inkCache.size < 1024) _inkCache.set(color, out);
  return out;
}

/**
 * The three-face + outline pack every iso box uses. Cached per (base, outline).
 * `ol` should almost always be P.outline — the single per-world/tier structural
 * ink — so every prism/cyl/disc in the scene shares one heavy ink contour
 * instead of a hue-tinted soft edge derived from its own fill (ink(base) is
 * kept only as the safety fallback when no outline is supplied).
 */
const _faceCache = new Map();
function faces(base, ol) {
  const key = base + '|' + (ol || '');
  let f = _faceCache.get(key);
  if (!f) {
    f = {
      t: shade(base, 0.22),
      l: base,
      r: shade(base, -0.2),
      d: shade(base, -0.36),
      o: ol || ink(base)
    };
    if (_faceCache.size < 512) _faceCache.set(key, f);
  }
  return f;
}

/* ------------------------------------------------------------------ *
 *  Canvas path helpers
 * ------------------------------------------------------------------ */

/** Rounded rect path (no fill/stroke). Guards tiny sizes. */
function rr(g, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, Math.min(Math.abs(w), Math.abs(h)) / 2));
  g.beginPath();
  if (rad <= 0.01) {
    g.rect(x, y, w, h);
    return;
  }
  g.moveTo(x + rad, y);
  g.lineTo(x + w - rad, y);
  g.arcTo(x + w, y, x + w, y + rad, rad);
  g.lineTo(x + w, y + h - rad);
  g.arcTo(x + w, y + h, x + w - rad, y + h, rad);
  g.lineTo(x + rad, y + h);
  g.arcTo(x, y + h, x, y + h - rad, rad);
  g.lineTo(x, y + rad);
  g.arcTo(x, y, x + rad, y, rad);
  g.closePath();
}

function ellipse(g, cx, cy, rx, ry) {
  g.beginPath();
  g.ellipse(cx, cy, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, TAU);
}

/* ------------------------------------------------------------------ *
 *  ISO PROJECTION  (the contract)
 * ------------------------------------------------------------------ */

/**
 * 2:1 dimetric constants.  ISO.ky === ISO.kx / 2 is what makes it 2:1 —
 * a square world tile projects to a diamond exactly twice as wide as it is tall.
 * ISO.kz is how much screen-y one unit of world-z (height) lifts an object.
 */
export const ISO = { kx: 0.5, ky: 0.25, kz: 0.62 };

/** World radius -> iso ellipse rx. A world circle projects to an axis-aligned
 *  ellipse with rx = r*sqrt(2)*kx and ry = rx/2. */
const ISO_R = Math.SQRT2 * ISO.kx;

/* Non-allocating internals used by every hot loop. */
function LX(wx, wy) {
  return (wx - wy) * ISO.kx;
}
function LY(wx, wy, wz) {
  return (wx + wy) * ISO.ky - (wz || 0) * ISO.kz;
}

/**
 * WORLD px -> ISO px.
 * @param {number} wx @param {number} wy @param {number} [wz] height above the floor
 * @returns {{x:number,y:number}}
 */
export function worldToIso(wx, wy, wz = 0) {
  const x = Number(wx) || 0;
  const y = Number(wy) || 0;
  const z = Number(wz) || 0;
  return { x: (x - y) * ISO.kx, y: (x + y) * ISO.ky - z * ISO.kz };
}

/**
 * ISO px -> WORLD px, inverting the wz === 0 case.
 *   ix = (wx - wy) * kx      ->  a = ix / kx = wx - wy
 *   iy = (wx + wy) * ky      ->  b = iy / ky = wx + wy
 * @param {number} ix @param {number} iy
 * @returns {{x:number,y:number}}
 */
export function isoToWorld(ix, iy) {
  const a = (Number(ix) || 0) / ISO.kx;
  const b = (Number(iy) || 0) / ISO.ky;
  return { x: (b + a) / 2, y: (b - a) / 2 };
}

/**
 * ISO px -> WORLD px, inverting worldToIso at an arbitrary height `wz` instead
 * of assuming the ground plane (wz === 0). isoToWorld(ix, iy) === this with
 * wz = 0.
 *
 * Why this exists: characters are drawn with a visual iso-space offset above
 * their ground anchor (see chibiFigure — the body/head sit well above the
 * contact shadow), so a click on the visible body does not invert to the
 * character's actual (x, y) via the plain wz=0 inversion; it lands many px
 * away on the floor. Callers that know the on-screen height of what was
 * clicked (or want to test against a specific figure's silhouette) can invert
 * at that height instead.
 *   iy = (wx + wy) * ky - wz * kz   ->   b = (iy + wz * kz) / ky = wx + wy
 * @param {number} ix @param {number} iy @param {number} [wz]
 * @returns {{x:number,y:number}}
 */
export function isoToWorldAtHeight(ix, iy, wz = 0) {
  const a = (Number(ix) || 0) / ISO.kx;
  const b = ((Number(iy) || 0) + (Number(wz) || 0) * ISO.kz) / ISO.ky;
  return { x: (b + a) / 2, y: (b - a) / 2 };
}

/**
 * Self-test: isoToWorld(worldToIso(x, y)) must round-trip to within 0.001 for
 * any x, y. Exported so it can be unit-checked; also run once at module load
 * (guarded) so a bad edit to ISO surfaces immediately instead of silently
 * breaking every click in the game.
 * @returns {boolean} true when every sample round-trips inside 1e-3
 */
export function isoSelfTest() {
  if (Math.abs(ISO.ky - ISO.kx / 2) > 1e-12) return false;
  const samples = [
    0, 1, -1, 0.5, -0.5, 31.7, -31.7, 640, -640, 2304, -1920, 12345.678, -98765.432
  ];
  for (let i = 0; i < samples.length; i++) {
    for (let k = 0; k < samples.length; k++) {
      const x = samples[i];
      const y = samples[k];
      const p = worldToIso(x, y, 0);
      const q = isoToWorld(p.x, p.y);
      if (Math.abs(q.x - x) > 0.001 || Math.abs(q.y - y) > 0.001) return false;
    }
  }
  return true;
}

try {
  if (!isoSelfTest() && typeof console !== 'undefined' && console.error) {
    console.error('[renderer] iso projection self-test FAILED — clicks will be wrong.');
  }
} catch (err) {
  /* never let a self-test take the game down */
}

/* ------------------------------------------------------------------ *
 *  Iso drawing primitives
 * ------------------------------------------------------------------ */

const LW = 2.0;        // default thick outline, iso px (scales with zoom)
const LW_THIN = 1.2;
const LW_CHAR = 1.8;

const SHADOW_STRONG = 'rgba(24,16,40,0.28)';

/** Flat iso diamond path (a footprint top face at z = 0), centred on cx,cy. */
function isoDiamond(g, cx, cy, hw, hh) {
  const A = (hw + hh) * ISO.kx;
  const B = (hw - hh) * ISO.kx;
  g.beginPath();
  g.moveTo(cx - B, cy - A * 0.5);
  g.lineTo(cx + A, cy + B * 0.5);
  g.lineTo(cx + B, cy + A * 0.5);
  g.lineTo(cx - A, cy - B * 0.5);
  g.closePath();
}

/**
 * Extruded iso box. cx,cy = iso coords of the footprint centre at the base plane.
 * hw,hh = half extents in WORLD px along +wx / +wy. hgt = height in world px.
 * Draws left (+wy) face, right (+wx) face, then the lit top — each filled and
 * stroked with the same dark outline, lineJoin round for the chunky silhouette.
 */
function prism(g, cx, cy, hw, hh, hgt, cTop, cLeft, cRight, ol, lw) {
  const A = (hw + hh) * ISO.kx;
  const B = (hw - hh) * ISO.kx;
  const hz = hgt * ISO.kz;
  const nx = cx - B;
  const ny = cy - A * 0.5;
  const ex = cx + A;
  const ey = cy + B * 0.5;
  const sx = cx + B;
  const sy = cy + A * 0.5;
  const wx = cx - A;
  const wy = cy - B * 0.5;

  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.lineWidth = lw || LW;
  g.strokeStyle = ol;

  if (hz > 0.2) {
    g.beginPath();
    g.moveTo(wx, wy - hz);
    g.lineTo(sx, sy - hz);
    g.lineTo(sx, sy);
    g.lineTo(wx, wy);
    g.closePath();
    g.fillStyle = cLeft;
    g.fill();
    g.stroke();

    g.beginPath();
    g.moveTo(sx, sy - hz);
    g.lineTo(ex, ey - hz);
    g.lineTo(ex, ey);
    g.lineTo(sx, sy);
    g.closePath();
    g.fillStyle = cRight;
    g.fill();
    g.stroke();
  }

  g.beginPath();
  g.moveTo(nx, ny - hz);
  g.lineTo(ex, ey - hz);
  g.lineTo(sx, sy - hz);
  g.lineTo(wx, wy - hz);
  g.closePath();
  g.fillStyle = cTop;
  g.fill();
  g.stroke();
}

/** prism placed at a world offset (dx,dy) from the sprite origin, raised to z0. */
function prismAt(g, dx, dy, z0, hw, hh, hgt, cTop, cLeft, cRight, ol, lw) {
  prism(g, LX(dx, dy), LY(dx, dy, z0), hw, hh, hgt, cTop, cLeft, cRight, ol, lw);
}

/** Iso disc (a world circle lying flat on the plane). */
function isoDisc(g, cx, cy, r) {
  ellipse(g, cx, cy, r * ISO_R, r * ISO_R * 0.5);
}

function discAt(g, dx, dy, z0, r, fill, ol, lw) {
  isoDisc(g, LX(dx, dy), LY(dx, dy, z0), r);
  g.fillStyle = fill;
  g.fill();
  if (ol) {
    g.lineWidth = lw || LW;
    g.strokeStyle = ol;
    g.stroke();
  }
}

/** Upright cylinder (stools, chip stacks, tables, bottles). */
function cyl(g, cx, cy, r, hgt, cTop, cSide, ol, lw) {
  const rx = r * ISO_R;
  const ry = rx * 0.5;
  const hz = hgt * ISO.kz;
  g.lineJoin = 'round';
  g.lineWidth = lw || LW;
  g.strokeStyle = ol;

  if (hz > 0.2) {
    g.beginPath();
    g.moveTo(cx - rx, cy - hz);
    g.ellipse(cx, cy, rx, ry, 0, Math.PI, 0, true);
    g.lineTo(cx + rx, cy - hz);
    g.ellipse(cx, cy - hz, rx, ry, 0, 0, Math.PI, true);
    g.closePath();
    g.fillStyle = cSide;
    g.fill();
    g.stroke();
  }
  ellipse(g, cx, cy - hz, rx, ry);
  g.fillStyle = cTop;
  g.fill();
  g.stroke();
}

function cylAt(g, dx, dy, z0, r, hgt, cTop, cSide, ol, lw) {
  cyl(g, LX(dx, dy), LY(dx, dy, z0), r, hgt, cTop, cSide, ol, lw);
}

/**
 * Soft elliptical contact shadow under a footprint.
 * @param {string} [sh] palette.shadow; falls back to the built-in when absent.
 */
function groundShadow(g, dx, dy, hw, hh, k, sh) {
  const A = (hw + hh) * ISO.kx * (k || 0.88);
  ellipse(g, LX(dx, dy), LY(dx, dy, 0) + 1.5, A, A * 0.5);
  g.fillStyle = typeof sh === 'string' && sh ? sh : SHADOW_STRONG;
  g.fill();
}

/* --- Face-local decal mapping ---------------------------------------
 * A prism's two visible faces are parameterised by (u, v):
 *   u = 0..1 along the base edge, v = 0..1 upward.
 *   point(u,v) = (cx + ox + ax*u, cy + oy + ay*u - hz*v)
 * Scratch objects avoid per-frame allocation in the animated overlays.
 */
const _fl = { ox: 0, oy: 0, ax: 0, ay: 0 };
const _fr = { ox: 0, oy: 0, ax: 0, ay: 0 };
const _pt = { x: 0, y: 0 };

function faceLeft(hw, hh, out) {
  const A = (hw + hh) * ISO.kx;
  const B = (hw - hh) * ISO.kx;
  out.ox = -A;
  out.oy = -B * 0.5;
  out.ax = A + B;
  out.ay = (A + B) * 0.5;
  return out;
}

function faceRight(hw, hh, out) {
  const A = (hw + hh) * ISO.kx;
  const B = (hw - hh) * ISO.kx;
  out.ox = B;
  out.oy = A * 0.5;
  out.ax = A - B;
  out.ay = (B - A) * 0.5;
  return out;
}

function facePt(cx, cy, f, hz, u, v) {
  _pt.x = cx + f.ox + f.ax * u;
  _pt.y = cy + f.oy + f.ay * u - hz * v;
  return _pt;
}

function facePath(g, cx, cy, f, hz, u0, u1, v0, v1) {
  g.beginPath();
  let p = facePt(cx, cy, f, hz, u0, v0);
  g.moveTo(p.x, p.y);
  p = facePt(cx, cy, f, hz, u1, v0);
  g.lineTo(p.x, p.y);
  p = facePt(cx, cy, f, hz, u1, v1);
  g.lineTo(p.x, p.y);
  p = facePt(cx, cy, f, hz, u0, v1);
  g.lineTo(p.x, p.y);
  g.closePath();
}

function facePanel(g, cx, cy, f, hz, u0, u1, v0, v1, fill, ol, lw) {
  facePath(g, cx, cy, f, hz, u0, u1, v0, v1);
  g.fillStyle = fill;
  g.fill();
  if (ol) {
    g.lineJoin = 'round';
    g.lineWidth = lw || LW_THIN;
    g.strokeStyle = ol;
    g.stroke();
  }
}

/** A wheel/disc standing upright and facing the camera (prize wheel, screens). */
function upright(g, cx, cy, r) {
  g.beginPath();
  g.arc(cx, cy, Math.max(0.5, r), 0, TAU);
}

/* ------------------------------------------------------------------ *
 *  Palette — bright cartoon art direction per tier, tinted by the world
 * ------------------------------------------------------------------ */

const TIER_ART = [
  // tier 1 — scrappy but cheerful: mint floor, tangerine accents
  {
    floorA: '#8ed6b6', floorB: '#7ccca8', floorEdge: '#5fb995', floorLine: '#4fa886',
    slab: '#3f9a7a', slabDark: '#2e7a5f', rim: '#57b894',
    wall: '#e2f3ea', wallSide: '#bfe2d3', wallTop: '#f4fbf7',
    accent: '#ff8b3d', neon: '#3ff0ae', gold: '#ffd23f',
    wood: '#d18d51', felt: '#2fc46f', metal: '#c3d0d8', chair: '#ff6b5c',
    screen: '#16283a', screenLit: '#63f2cf', cabinet: '#ff7a4d',
    carpetVip: '#ff9ecb', cloth: '#5ec7ff',
    bgTop: '#6fd8cb', bgBot: '#1d6d7d',
    flickerBias: 1
  },
  // tier 2 — warm plush: amber carpet, brass and cherry
  {
    floorA: '#f2b06a', floorB: '#e7a05c', floorEdge: '#cf8746', floorLine: '#bd7838',
    slab: '#a8632c', slabDark: '#834a20', rim: '#c2793c',
    wall: '#ffe6c2', wallSide: '#f0cd9f', wallTop: '#fff5e2',
    accent: '#ffb02e', neon: '#ffd23f', gold: '#ffcf4d',
    wood: '#b8703a', felt: '#2eb85f', metal: '#e6cb92', chair: '#e14b5a',
    screen: '#1d2436', screenLit: '#ffe08a', cabinet: '#e8455e',
    carpetVip: '#d24d84', cloth: '#7fb7ff',
    bgTop: '#ffd6a0', bgBot: '#8a4257',
    flickerBias: 0
  },
  // tier 3 — luxe: violet carpet, gold and hot pink LED
  {
    floorA: '#a878e8', floorB: '#9a6bda', floorEdge: '#7f52bd', floorLine: '#6d43a8',
    slab: '#5f34a0', slabDark: '#47257c', rim: '#7a49bd',
    wall: '#ecdcff', wallSide: '#cdb2f0', wallTop: '#f8f1ff',
    accent: '#ffd23f', neon: '#ff4fbf', gold: '#ffd76a',
    wood: '#7a3fb0', felt: '#22c07a', metal: '#ffd76a', chair: '#ff4f8b',
    screen: '#1b1330', screenLit: '#ff7fd8', cabinet: '#5f3fd6',
    carpetVip: '#ff5fae', cloth: '#61e3ff',
    bgTop: '#cfa9ff', bgBot: '#3a1d6e',
    flickerBias: 0
  }
];

const _paletteCache = new Map();

/**
 * A palette entry is only usable if it is a non-empty color STRING. config.js
 * is the authority on these, but a hand-edited world/tier can hand us null, a
 * number or an object — every read goes through colStr()/pick3() so one
 * missing or garbage field degrades to the next fallback instead of painting
 * "undefined" into fillStyle (which silently no-ops the whole shape).
 */
function colStr(v) {
  return typeof v === 'string' && v.length > 2 ? v : null;
}

/** First usable color out of (world field, tier field, baked art default). */
function pick3(a, b, c) {
  return colStr(a) || colStr(b) || c;
}

/**
 * Blend the tier's cartoon art palette with the (deliberately muted) world
 * palette from config.js, pushing every world color through vivid() first so
 * the result stays high-chroma while keeping the world's hue identity.
 *
 * Palette fields consumed, in priority order world -> tier -> TIER_ART:
 *   floor, floorAlt, wall, wallTop, accent, neon, carpet,
 *   faceTop / faceLeft / faceRight  (the three faces of a world-accent iso box),
 *   outline (the thick structural ink), shadow (contact shadows), skirt (the
 *   raised slab's side faces).
 * Every one of them is optional.
 */
function paletteFor(worldDef, tierIdx) {
  const key = (worldDef && worldDef.key ? worldDef.key : 'w') + '|' + tierIdx;
  const hit = _paletteCache.get(key);
  if (hit) return hit;

  const art = TIER_ART[clamp(tierIdx, 0, TIER_ART.length - 1)];
  const wp = (worldDef && worldDef.palette) || {};
  const td = tierDef(tierIdx + 1);
  const tp = (td && td.palette) || {};

  // Target ~L0.55 / S>=0.65 — saturated cartoon, not the previous milky
  // pastel (L0.63 with only a soft saturation floor).
  const wFloor = vivid(pick3(wp.floor, tp.floor, art.floorA), 0.66, 0.55);
  const wFloorAlt = vivid(pick3(wp.floorAlt, tp.floorAlt, art.floorB), 0.62, 0.5);
  const wWall = vivid(pick3(wp.wall, tp.wall, art.wall), 0.34, 0.82);
  const wCarpet = vivid(pick3(wp.carpet, tp.carpet, art.carpetVip), 0.72, 0.52);

  // World identity must DOMINATE the tier's cartoon flavor (was a 34% RGB
  // blend, i.e. the tier was 66% of what the player saw). The tier now only
  // nudges the world's own floor HUE (hue-space, not RGB — an RGB mix would
  // still soften chroma whenever the two hues disagree) and a fixed high
  // saturation/lightness target is guaranteed rather than inherited.
  const floorA = hueTint(art.floorA, wFloor, 0.82, 0.68, 0.55);
  const floorB = hueTint(art.floorB, wFloorAlt, 0.82, 0.62, 0.5);

  // Never RGB-mix two different hues for a saturated accent — mixing e.g. a
  // mint tier-neon with a hot-pink world-neon cancels chroma and produces a
  // grey mauve/beige "mud" color. Take the world's hue outright; the tier
  // only supplies a saturation/lightness target.
  const accentSrc = pick3(wp.accent, tp.accent, art.accent);
  const neonSrc = pick3(wp.neon, tp.neon, art.neon);
  const accent = hueForce(accentSrc, 0.8, 0.56);
  const neon = hueForce(neonSrc, 0.88, 0.6);

  /* --- skirt: the two visible side faces of the raised slab --- */
  const skirtSrc = pick3(wp.skirt, tp.skirt, null);
  const slab = skirtSrc ? mix(art.slab, vivid(skirtSrc, 0.44, 0.44), 0.55) : mix(art.slab, wFloor, 0.26);

  /* --- outline: the thick structural ink. Authored dark; if it is missing or
         somehow light, ink() of the slab is the safe fallback. --- */
  const outlineSrc = pick3(wp.outline, tp.outline, null);
  const outline = outlineSrc && toHsl(outlineSrc).l < 0.55 ? outlineSrc : ink(slab);

  /* --- shadow: must be a translucent CSS color; anything else falls back. --- */
  const shadowSrc = pick3(wp.shadow, tp.shadow, null);
  const shadow = shadowSrc || SHADOW_STRONG;

  /* --- the world's signature three-face iso box. Any single missing face is
         derived from whichever face IS present, then from the accent. --- */
  const faceBase = pick3(wp.faceLeft, wp.faceTop, colStr(wp.faceRight) || accent);
  const faceTop = vivid(pick3(wp.faceTop, tp.faceTop, shade(faceBase, 0.22)), 0.65, 0.62);
  const faceLeft = vivid(pick3(wp.faceLeft, tp.faceLeft, faceBase), 0.7, 0.52);
  const faceRight = vivid(pick3(wp.faceRight, tp.faceRight, shade(faceBase, -0.2)), 0.7, 0.4);

  // Object materials that previously had ZERO world influence (felt/metal/
  // gold/cloth/screen were literally `art.felt` etc. — a hard-coded TIER_ART
  // constant). Each now blends toward the world's accent hue in HSL hue-space
  // (never RGB across hues — see hueTint) so a blackjack felt, a slot cabinet
  // and a neon-lit screen all carry the world's identity, not just its tier.
  const wood = hueTint(art.wood, accentSrc, 0.55, 0.55, 0.4);
  const chair = hueTint(art.chair, accentSrc, 0.5, 0.72, 0.55);
  const cabinet = hueTint(art.cabinet, accentSrc, 0.55, 0.72, 0.52);
  const felt = hueTint(art.felt, accentSrc, 0.35, 0.65, 0.4);
  const metal = hueTint(art.metal, accentSrc, 0.28, 0.22, 0.72);
  const gold = hueTint(art.gold, accentSrc, 0.16, 0.78, 0.64);
  const cloth = hueTint(art.cloth, accentSrc, 0.4, 0.55, 0.6);
  // Screens were a near-black navy in every tier/world, filling the biggest
  // venues (sportsbook wall, slot cabinets) as a black rectangle. Lift to a
  // saturated mid-tone tied to the world's own faceRight/accent so it reads
  // as colored glass, not a hole.
  const screen = vivid(pick3(wp.faceRight, wp.faceLeft, accentSrc), 0.5, 0.32);
  // screenLit borrows the (now world-hued) neon's OWN hue rather than mixing
  // it with the tier's screenLit constant — same cross-hue-mud risk as neon.
  const screenLit = hueForce(neon, 0.72, 0.74);

  const P = {
    tierIdx,
    tierDef: td,
    flicker: (td.flicker || 0) * art.flickerBias,
    chandeliers: td.chandeliers || 0,
    goldAmt: td.gold || 0,

    floorA,
    floorB,
    /** alias: the checker's alternate tile, driven by palette.floorAlt */
    floorAlt: floorB,
    floorEdge: mix(art.floorEdge, wFloor, 0.3),
    floorLine: mix(art.floorLine, wFloor, 0.25),
    slab,
    /** alias: the raised platform's side faces, driven by palette.skirt */
    skirt: slab,
    slabDark: skirtSrc ? shade(slab, -0.22) : mix(art.slabDark, wFloor, 0.2),
    rim: mix(art.rim, wFloor, 0.28),

    /** thick structural ink, driven by palette.outline */
    outline,
    /** contact-shadow fill, driven by palette.shadow */
    shadow,

    /** the world's signature iso box: lit top / mid left / dark right */
    faceTop,
    faceLeft,
    faceRight,
    accentFaces: {
      t: faceTop,
      l: faceLeft,
      r: faceRight,
      d: shade(faceRight, -0.18),
      o: outline
    },

    wall: mix(art.wall, wWall, 0.4),
    wallSide: mix(art.wallSide, wWall, 0.4),
    wallTop: colStr(tp.wallTop) ? mix(art.wallTop, vivid(tp.wallTop, 0.3, 0.86), 0.35) : mix(art.wallTop, wWall, 0.3),

    accent,
    neon,
    gold,
    wood,
    felt,
    metal,
    chair,
    screen,
    screenLit,
    cabinet,
    carpetVip: mix(art.carpetVip, wCarpet, 0.45),
    cloth,

    bgTop: mix(art.bgTop, accent, 0.22),
    // Was a dark teal/indigo (L~0.32-0.36) filling the lower half of the
    // frame — the strongest "dark top-down game" tell. Force a bright
    // sand/sky ground tied to the world hue instead (defect 6).
    bgBot: hueForce(mix(art.bgBot, wFloor, 0.35), 0.5, 0.6),

    skin: '#ffcf9e',
    ink: '#241a33'
  };

  if (_paletteCache.size < 64) _paletteCache.set(key, P);
  return P;
}

/* ------------------------------------------------------------------ *
 *  Venue heights (world px) — drives sprite canvas bounds
 * ------------------------------------------------------------------ */

const VEN_H = {
  slots: 56,
  blackjack: 34,
  roulette: 36,
  craps: 38,
  sportsbook: 74,
  wheel: 104,
  vip: 46,
  bar: 66,
  buffet: 52,
  showroom: 92,
  security: 64,
  cashier: 56,
  tokenBooth: 52
};

/* ------------------------------------------------------------------ *
 *  Baked venue sprites — chunky iso objects
 *  Every baker draws in ISO px with the footprint centre at (0, 0),
 *  base plane at y = 0.  hw / hh are half extents in WORLD px.
 * ------------------------------------------------------------------ */

/** Ring of stools around a table footprint. */
function stoolRing(g, hw, hh, P, n, rk) {
  const F = faces(P.chair, P.outline);
  const r = Math.min(hw, hh) * 0.24;
  for (let i = 0; i < n; i++) {
    const a = Math.PI * 0.22 + (i / (n - 1 || 1)) * Math.PI * 1.56;
    cylAt(g, Math.cos(a) * hw * rk, Math.sin(a) * hh * rk, 0, r, 11, F.t, F.l, F.o, LW);
  }
}

/** A few short, fat chip stacks on a table top. */
function chipStacks(g, dx, dy, z0, s, seed, count, P) {
  const ol = P && P.outline;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + rnd(seed + i, 3) * 0.6;
    const px = dx + Math.cos(a) * s * 3.1;
    const py = dy + Math.sin(a) * s * 3.1;
    const n = 2 + Math.floor(rnd(seed + i, 5) * 3);
    const col = i % 3 === 0 ? '#ff4d5e' : i % 3 === 1 ? '#f7f3e8' : '#3fa8ff';
    const F = faces(col, ol);
    cylAt(g, px, py, z0, s * 1.6, n * 1.9, F.t, F.l, F.o, LW_THIN);
  }
}

/** A flat felt/rug diamond with an outline. */
function padAt(g, dx, dy, z0, hw, hh, fill, ol, lw) {
  isoDiamond(g, LX(dx, dy), LY(dx, dy, z0), hw, hh);
  g.fillStyle = fill;
  g.fill();
  if (ol) {
    g.lineJoin = 'round';
    g.lineWidth = lw || LW_THIN;
    g.strokeStyle = ol;
    g.stroke();
  }
}

function bakeSlots(g, hw, hh, P, seed) {
  groundShadow(g, 0, 0, hw, hh, 0.86, P.shadow);

  const st = faces(P.chair, P.outline);
  cylAt(g, hw * 0.68, hh * 0.68, 0, Math.min(hw, hh) * 0.28, 11, st.t, st.l, st.o, LW);

  // Main cabinet body routed through the world's signature three-face box
  // (P.accentFaces) instead of the tier-only P.cabinet material, so a slot
  // machine actually carries its world's identity.
  const C = P.accentFaces || faces(P.cabinet, P.outline);
  const bw = hw * 0.6;
  const bh = hh * 0.6;
  const H = 40;
  const cx = LX(-hw * 0.12, -hh * 0.12);
  const cy = LY(-hw * 0.12, -hh * 0.12, 0);
  prism(g, cx, cy, bw, bh, H, C.t, C.l, C.r, C.o, LW);

  // Gilded marquee crown only escalates in from tier 2 — tier 1 stays bare,
  // matching the "scrappy/grim" narrative instead of a cheerful gold-topped
  // cabinet on day one.
  if (P.tierIdx > 0) {
    const M = faces(P.gold, P.outline);
    prism(g, cx, cy - H * ISO.kz, bw * 1.05, bh * 1.05, 9, M.t, M.l, M.r, M.o, LW);
  }

  const f = faceLeft(bw, bh, _fl);
  const hz = H * ISO.kz;
  facePanel(g, cx, cy, f, hz, 0.13, 0.87, 0.44, 0.88, P.screen, C.o, LW * 0.85);
  facePanel(g, cx, cy, f, hz, 0.13, 0.87, 0.14, 0.34, shade(P.cabinet, -0.4), C.o, LW * 0.85);
  for (let i = 0; i < 3; i++) {
    const p = facePt(cx, cy, f, hz, 0.26 + i * 0.24, 0.24);
    g.beginPath();
    g.arc(p.x, p.y, Math.max(1, bw * 0.1), 0, TAU);
    g.fillStyle = i === 1 ? '#ff4d5e' : P.gold;
    g.fill();
    g.lineWidth = LW * 0.6;
    g.strokeStyle = C.o;
    g.stroke();
  }

  const fr2 = faceRight(bw, bh, _fr);
  const lp = facePt(cx, cy, fr2, hz, 0.92, 0.5);
  const lx = lp.x;
  const ly = lp.y;
  g.strokeStyle = C.o;
  g.lineCap = 'round';
  g.lineWidth = LW * 1.6;
  g.beginPath();
  g.moveTo(lx, ly);
  g.lineTo(lx + bw * 0.5, ly - hz * 0.6);
  g.stroke();
  g.beginPath();
  g.arc(lx + bw * 0.5, ly - hz * 0.6, Math.max(2.4, bw * 0.3), 0, TAU);
  g.fillStyle = '#ff4d5e';
  g.fill();
  g.lineWidth = LW;
  g.stroke();

  // Tier 3 escalates ornament density (not just hue): a gold accent rail
  // wraps the cabinet's base.
  if (P.tierIdx === 2) {
    const G = faces(P.gold, P.outline);
    prism(g, cx, cy, bw * 1.02, bh * 1.02, 3, G.t, G.l, G.r, G.o, LW_THIN);
  }
  void seed;
}

function bakeBlackjack(g, hw, hh, P, seed) {
  groundShadow(g, 0, 0, hw, hh, 0.9, P.shadow);
  stoolRing(g, hw, hh, P, 5, 0.95);

  const r = Math.min(hw, hh) * 0.82;
  const W = faces(P.wood, P.outline);
  cyl(g, 0, 0, r, 20, W.t, W.l, W.o, LW);
  discAt(g, 0, 0, 20, r * 0.84, P.felt, P.outline, LW_THIN);

  // dealer crescent along the far (-wy) edge — bare rope at tier 1, a gilded
  // rail once the venue has escalated past "grim".
  const F = P.tierIdx > 0 ? faces(P.gold, P.outline) : faces(P.metal, P.outline);
  g.lineWidth = P.tierIdx === 2 ? LW * 1.7 : LW * 1.3;
  g.strokeStyle = F.l;
  g.beginPath();
  g.ellipse(LX(0, 0), LY(0, 0, 20), r * 0.6 * ISO_R, r * 0.3 * ISO_R, 0, Math.PI * 1.08, Math.PI * 1.92);
  g.stroke();

  // betting circles
  g.lineWidth = LW_THIN;
  g.strokeStyle = rgba('#ffffff', 0.7);
  for (let i = 0; i < 3; i++) {
    const a = Math.PI * 0.3 + i * Math.PI * 0.2;
    isoDisc(g, LX(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55), LY(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, 20), r * 0.16);
    g.stroke();
  }
  chipStacks(g, 0, r * 0.25, 20, Math.min(hw, hh) * 0.1, seed, 3, P);
}

function bakeRoulette(g, hw, hh, P, seed) {
  groundShadow(g, 0, 0, hw, hh, 0.9, P.shadow);
  stoolRing(g, hw, hh, P, 6, 0.95);

  const tw = hw * 0.86;
  const th = hh * 0.86;
  const W = faces(P.wood, P.outline);
  prismAt(g, 0, 0, 0, tw, th, 20, W.t, W.l, W.r, W.o, LW);
  padAt(g, 0, 0, 20, tw * 0.88, th * 0.88, P.felt, P.outline, LW_THIN);

  // betting grid drawn in world space so it lies correctly on the felt
  g.lineWidth = LW_THIN * 0.8;
  g.strokeStyle = rgba('#ffffff', 0.55);
  const gx0 = -tw * 0.72;
  const gx1 = tw * 0.72;
  const gy0 = th * 0.06;
  const gy1 = th * 0.72;
  g.beginPath();
  for (let c = 0; c <= 6; c++) {
    const x = gx0 + ((gx1 - gx0) * c) / 6;
    g.moveTo(LX(x, gy0), LY(x, gy0, 20));
    g.lineTo(LX(x, gy1), LY(x, gy1, 20));
  }
  for (let r2 = 0; r2 <= 3; r2++) {
    const y = gy0 + ((gy1 - gy0) * r2) / 3;
    g.moveTo(LX(gx0, y), LY(gx0, y, 20));
    g.lineTo(LX(gx1, y), LY(gx1, y, 20));
  }
  g.stroke();

  // wheel well (the wheel itself is animated on top)
  const wr = Math.min(hw, hh) * 0.56;
  cylAt(g, 0, -th * 0.42, 20, wr, 5, shade(P.wood, -0.25), W.r, W.o, LW_THIN);
  // Tier escalation: a gold rim appears once the venue is past "grim".
  if (P.tierIdx > 0) {
    const G = faces(P.gold, P.outline);
    discAt(g, 0, -th * 0.42, 25, wr * 1.02, 'rgba(0,0,0,0)', G.l, LW_THIN * (P.tierIdx === 2 ? 1.8 : 1));
  }
  chipStacks(g, tw * 0.4, th * 0.35, 20, Math.min(hw, hh) * 0.08, seed, 2, P);
}

function bakeCraps(g, hw, hh, P, seed) {
  groundShadow(g, 0, 0, hw, hh, 0.9, P.shadow);
  stoolRing(g, hw, hh, P, 7, 0.95);

  const tw = hw * 0.9;
  const th = hh * 0.86;
  const W = faces(P.wood, P.outline);
  prismAt(g, 0, 0, 0, tw, th, 20, W.t, W.l, W.r, W.o, LW);
  padAt(g, 0, 0, 20, tw * 0.88, th * 0.88, P.felt, P.outline, LW_THIN);

  // high rail — plain metal at tier 1 (bare), gilded once the venue has
  // escalated, thicker still at tier 3.
  const R = P.tierIdx > 0 ? faces(P.gold, P.outline) : faces(P.metal, P.outline);
  isoDiamond(g, LX(0, 0), LY(0, 0, 26), tw * 0.95, th * 0.95);
  g.lineJoin = 'round';
  g.lineWidth = LW * (P.tierIdx === 2 ? 2.8 : 2.2);
  g.strokeStyle = R.o;
  g.stroke();
  g.lineWidth = LW * (P.tierIdx === 2 ? 1.8 : 1.4);
  g.strokeStyle = R.l;
  g.stroke();

  // pass line + number boxes
  g.lineWidth = LW_THIN;
  g.strokeStyle = rgba('#ffffff', 0.6);
  g.beginPath();
  g.moveTo(LX(-tw * 0.7, 0), LY(-tw * 0.7, 0, 20));
  g.lineTo(LX(tw * 0.7, 0), LY(tw * 0.7, 0, 20));
  g.stroke();
  for (let i = 0; i < 6; i++) {
    const bx = -tw * 0.62 + i * tw * 0.25;
    padAt(g, bx, -th * 0.42, 20.3, tw * 0.1, th * 0.16, rgba('#ffffff', 0.16), rgba('#ffffff', 0.5), LW_THIN * 0.8);
  }
  // dice
  const D = faces('#fbf6e8', P.outline);
  prismAt(g, tw * 0.3, th * 0.3, 20, 4.5, 4.5, 9, D.t, D.l, D.r, D.o, LW_THIN);
  prismAt(g, tw * 0.44, th * 0.16, 20, 4.5, 4.5, 9, D.t, D.l, D.r, D.o, LW_THIN);
  chipStacks(g, -tw * 0.25, th * 0.35, 20, Math.min(hw, hh) * 0.09, seed, 3, P);
}

function bakeSportsbook(g, hw, hh, P, seed) {
  groundShadow(g, 0, 0, hw, hh, 0.9, P.shadow);

  // screen wall along the far edge
  const bw = hw * 0.95;
  const bh = hh * 0.15;
  const H = 58;
  const dx = 0;
  const dy = -hh * 0.62;
  // The screen wall is the sportsbook's biggest flat face — route it through
  // the world's signature three-face box instead of a tier-only wall shade,
  // and drop the tier-3 guard that previously suppressed it at the top tier.
  const A = P.accentFaces || faces(shade(P.wall, -0.2), P.outline);
  prismAt(g, dx, dy, 0, bw, bh, H, A.t, A.l, A.r, A.o, LW);

  const cx = LX(dx, dy);
  const cy = LY(dx, dy, 0);
  const f = faceLeft(bw, bh, _fl);
  const hz = H * ISO.kz;
  const cols = 4;
  const rows = 2;
  for (let r2 = 0; r2 < rows; r2++) {
    for (let c = 0; c < cols; c++) {
      const u0 = 0.05 + c * 0.235;
      const v0 = 0.2 + r2 * 0.38;
      facePanel(g, cx, cy, f, hz, u0, u0 + 0.19, v0, v0 + 0.3, P.screen, A.o, LW * 0.8);
    }
  }

  // counter + stools
  const W = faces(P.wood, P.outline);
  prismAt(g, 0, hh * 0.34, 0, hw * 0.88, hh * 0.22, 18, W.t, W.l, W.r, W.o, LW);
  const S = faces(P.chair, P.outline);
  for (let i = 0; i < 5; i++) {
    cylAt(g, -hw * 0.66 + i * hw * 0.33, hh * 0.75, 0, Math.min(hw, hh) * 0.16, 12, S.t, S.l, S.o, LW);
  }
  void seed;
}

function bakeWheel(g, hw, hh, P, seed) {
  groundShadow(g, 0, 0, hw, hh, 0.85, P.shadow);
  const W = faces(P.wood, P.outline);
  prismAt(g, 0, hh * 0.1, 0, hw * 0.42, hh * 0.42, 26, W.t, W.l, W.r, W.o, LW);
  // Tier escalation: a gold trim ring appears once the venue is past "grim".
  if (P.tierIdx > 0) {
    const G = faces(P.gold, P.outline);
    prismAt(g, 0, hh * 0.1, 26, hw * 0.44, hh * 0.44, 2.5, G.t, G.l, G.r, G.o, LW_THIN);
  }
  // the spinning wheel disc is drawn by animWheel; bake only its dark backing ring
  const cx = LX(0, -hh * 0.1);
  const cy = LY(0, -hh * 0.1, 26) - 44 * ISO.kz;
  const r = Math.min(hw, hh) * 0.82;
  upright(g, cx, cy, r * 1.06);
  g.fillStyle = P.outline;
  g.fill();
  void seed;
}

function bakeVip(g, hw, hh, P, seed) {
  groundShadow(g, 0, 0, hw, hh, 0.92, P.shadow);
  padAt(g, 0, 0, 0.5, hw * 0.9, hh * 0.9, P.carpetVip, P.outline, LW);
  padAt(g, 0, 0, 0.8, hw * 0.76, hh * 0.76, shade(P.carpetVip, 0.16), rgba(P.gold, 0.9), LW);

  // sofa along the far edge — routed through the world's signature three-face
  // box so the VIP room's biggest prism carries world identity, not just tier.
  const C = P.accentFaces || faces(P.chair, P.outline);
  prismAt(g, 0, -hh * 0.5, 0, hw * 0.62, hh * 0.16, 14, C.t, C.l, C.r, C.o, LW);
  prismAt(g, 0, -hh * 0.66, 0, hw * 0.62, hh * 0.07, 30, C.t, C.d, C.r, C.o, LW);

  // low gold-rimmed table
  const M = faces(P.gold, P.outline);
  cylAt(g, 0, hh * 0.02, 0, Math.min(hw, hh) * 0.34, 14, M.t, M.l, M.o, LW);
  chipStacks(g, 0, hh * 0.02, 14, Math.min(hw, hh) * 0.07, seed, 2, P);
  // Tier 3 adds a second, taller inner gold ring on the table — ornament
  // density escalates with tier, not just hue.
  if (P.tierIdx === 2) {
    cylAt(g, 0, hh * 0.02, 14, Math.min(hw, hh) * 0.2, 5, M.t, M.l, M.o, LW_THIN);
  }

  // rope stanchions across the front
  const prev = { x: 0, y: 0, has: false };
  for (let i = 0; i < 4; i++) {
    const px = -hw * 0.72 + i * hw * 0.48;
    const py = hh * 0.78;
    cylAt(g, px, py, 0, Math.min(hw, hh) * 0.07, 22, M.t, M.l, M.o, LW_THIN);
    const tx = LX(px, py);
    const ty = LY(px, py, 22);
    if (prev.has) {
      g.beginPath();
      g.moveTo(prev.x, prev.y);
      g.quadraticCurveTo((prev.x + tx) / 2, (prev.y + ty) / 2 + 7, tx, ty);
      g.lineWidth = LW * 1.5;
      g.lineCap = 'round';
      g.strokeStyle = '#c8265a';
      g.stroke();
    }
    prev.x = tx;
    prev.y = ty;
    prev.has = true;
  }
}

function bakeBar(g, hw, hh, P, seed) {
  groundShadow(g, 0, 0, hw, hh, 0.9, P.shadow);

  // Back board — the biggest flat face in the room, so this is where the
  // world's signature three-face box (palette.faceTop/faceLeft/faceRight,
  // exposed as P.accentFaces) reads best. Falls back inside paletteFor().
  // (Previously suppressed at tier 3 in favour of plain wood — removed so
  // the world's identity survives at every tier.)
  const A = P.accentFaces || faces(shade(P.wall, -0.15), P.outline);
  prismAt(g, 0, -hh * 0.55, 0, hw * 0.95, hh * 0.22, 46, A.t, A.l, A.r, A.o, LW);
  // shelf + bottles
  const M = faces(P.metal, P.outline);
  prismAt(g, 0, -hh * 0.3, 22, hw * 0.9, hh * 0.08, 3, M.t, M.l, M.r, M.o, LW_THIN);
  const n = Math.max(5, Math.round(hw / 8));
  const BOT = ['#4fbf5a', '#ff8a3d', '#ff4d5e', '#3fa8ff', '#ffd23f', '#b06bff'];
  for (let i = 0; i < n; i++) {
    const bx = -hw * 0.84 + (i * hw * 1.68) / (n - 1 || 1);
    const bh2 = 11 + rnd(seed + i, 21) * 8;
    const col = BOT[Math.floor(rnd(seed + i, 31) * BOT.length) % BOT.length];
    const F = faces(col, P.outline);
    cylAt(g, bx, -hh * 0.3, 25, 2.6, bh2, F.t, F.l, F.o, LW_THIN * 0.9);
  }

  // counter
  const W = faces(P.wood, P.outline);
  prismAt(g, 0, hh * 0.35, 0, hw * 0.95, hh * 0.3, 22, W.t, W.l, W.r, W.o, LW);
  const G = faces(P.gold, P.outline);
  prismAt(g, 0, hh * 0.35, 22, hw * 0.97, hh * 0.32, 2.5, G.t, G.l, G.r, G.o, LW_THIN);

  const S = faces(P.chair, P.outline);
  const stools = Math.max(3, Math.round(hw / 18));
  for (let i = 0; i < stools; i++) {
    const sx = -hw * 0.72 + (i * hw * 1.44) / (stools - 1 || 1);
    cylAt(g, sx, hh * 0.95, 0, Math.min(hw, hh) * 0.2, 13, S.t, S.l, S.o, LW);
  }
}

function bakeBuffet(g, hw, hh, P, seed) {
  groundShadow(g, 0, 0, hw, hh, 0.9, P.shadow);
  const M = faces(P.metal, P.outline);
  prismAt(g, 0, 0, 0, hw * 0.9, hh * 0.55, 24, M.t, M.l, M.r, M.o, LW);

  // Tier 3 adds a 5th premium tray — tier escalation via ornament density,
  // not just recoloring the same 4 trays.
  const FOOD = ['#ff8a3d', '#7ed957', '#ff4d5e', '#ffd23f', '#ffb0d9'];
  const trays = P.tierIdx === 2 ? 5 : 4;
  for (let i = 0; i < trays; i++) {
    const tx = -hw * 0.64 + (i * hw * 1.28) / (trays - 1 || 1);
    const T = faces('#eef3f6', P.outline);
    prismAt(g, tx, 0, 24, hw * 0.13, hh * 0.4, 4, T.t, T.l, T.r, T.o, LW_THIN);
    padAt(g, tx, 0, 28.4, hw * 0.1, hh * 0.32, FOOD[i % FOOD.length], P.outline, LW_THIN);
  }

  // sneeze guard — a tier 2+ upgrade; a tier 1 buffet is bare trays on a
  // metal counter, matching "bare concrete, torn linoleum".
  if (P.tierIdx > 0) {
    const gz = 24;
    g.lineWidth = LW_THIN;
    g.strokeStyle = rgba(P.cloth, 0.85);
    g.beginPath();
    g.moveTo(LX(-hw * 0.86, -hh * 0.5), LY(-hw * 0.86, -hh * 0.5, gz));
    g.lineTo(LX(-hw * 0.86, -hh * 0.5), LY(-hw * 0.86, -hh * 0.5, gz + 18));
    g.lineTo(LX(hw * 0.86, -hh * 0.5), LY(hw * 0.86, -hh * 0.5, gz + 18));
    g.lineTo(LX(hw * 0.86, -hh * 0.5), LY(hw * 0.86, -hh * 0.5, gz));
    g.stroke();
  }

  // heat lamps
  for (let i = 0; i < 3; i++) {
    const lx = -hw * 0.5 + i * hw * 0.5;
    const p = { x: LX(lx, -hh * 0.5), y: LY(lx, -hh * 0.5, gz + 16) };
    g.beginPath();
    g.arc(p.x, p.y, 3.2, 0, TAU);
    g.fillStyle = '#ff9a3c';
    g.fill();
    g.lineWidth = LW_THIN;
    g.strokeStyle = ink('#ff9a3c');
    g.stroke();
  }
  void seed;
}

function bakeShowroom(g, hw, hh, P, seed) {
  groundShadow(g, 0, 0, hw, hh, 0.92, P.shadow);

  // stage
  const W = faces(P.wood, P.outline);
  prismAt(g, 0, hh * 0.12, 0, hw * 0.8, hh * 0.55, 14, W.t, W.l, W.r, W.o, LW);

  // backdrop wall — the showroom's biggest flat face, routed through the
  // world's signature three-face box so it reads at every tier.
  const A = P.accentFaces || faces(shade(P.wall, -0.28), P.outline);
  prismAt(g, 0, -hh * 0.58, 0, hw * 0.86, hh * 0.13, 58, A.t, A.l, A.r, A.o, LW);

  // curtains
  const curtain = P.tierIdx === 2 ? '#c8175a' : P.tierIdx === 1 ? '#d8323f' : '#e05a4a';
  const C = faces(curtain, P.outline);
  prismAt(g, -hw * 0.66, -hh * 0.5, 0, hw * 0.2, hh * 0.11, 62, C.t, C.l, C.r, C.o, LW);
  prismAt(g, hw * 0.66, -hh * 0.5, 0, hw * 0.2, hh * 0.11, 62, C.t, C.l, C.r, C.o, LW);
  // pelmet
  prismAt(g, 0, -hh * 0.5, 58, hw * 0.9, hh * 0.11, 10, C.t, C.d, C.r, C.o, LW);
  if (P.goldAmt > 0.2) {
    const G = faces(P.gold, P.outline);
    prismAt(g, 0, -hh * 0.5, 56, hw * 0.9, hh * 0.115, 2.5, G.t, G.l, G.r, G.o, LW_THIN);
  }

  // seating rows in front of the stage
  const S = faces(P.chair, P.outline);
  for (let r2 = 0; r2 < 2; r2++) {
    for (let c = 0; c < 5; c++) {
      prismAt(g, -hw * 0.6 + c * hw * 0.3, hh * 0.6 + r2 * hh * 0.2, 0, hw * 0.07, hh * 0.05, 12, S.t, S.l, S.r, S.o, LW_THIN);
    }
  }
  void seed;
}

function bakeSecurity(g, hw, hh, P, seed) {
  groundShadow(g, 0, 0, hw, hh, 0.8, P.shadow);
  // Arch pillars + lintel routed through the world's signature three-face
  // box instead of plain metal, so security carries world identity too.
  const M = P.accentFaces || faces(P.metal, P.outline);
  const t = Math.min(hw, hh) * 0.16;
  prismAt(g, -hw * 0.55, 0, 0, t, hh * 0.75, 44, M.t, M.l, M.r, M.o, LW);
  prismAt(g, hw * 0.55, 0, 0, t, hh * 0.75, 44, M.t, M.l, M.r, M.o, LW);
  prismAt(g, 0, 0, 44, hw * 0.7, hh * 0.72, 9, M.t, M.l, M.r, M.o, LW);
  // indicator lamp
  const p = { x: LX(0, hh * 0.7), y: LY(0, hh * 0.7, 50) };
  g.beginPath();
  g.arc(p.x, p.y, 3.4, 0, TAU);
  g.fillStyle = '#5ce07a';
  g.fill();
  g.lineWidth = LW_THIN;
  g.strokeStyle = ink('#5ce07a');
  g.stroke();
  // Tier 3 adds a second scanner light bar — ornament density escalates,
  // not just hue.
  if (P.tierIdx === 2) {
    const G = faces(P.gold, P.outline);
    prismAt(g, 0, 0, 53, hw * 0.7, hh * 0.72, 2.2, G.t, G.l, G.r, G.o, LW_THIN);
  }
  void seed;
}

function bakeCashier(g, hw, hh, P, seed) {
  groundShadow(g, 0, 0, hw, hh, 0.88, P.shadow);
  // Cashier body routed through the world's signature three-face box.
  const W = P.accentFaces || faces(P.wood, P.outline);
  prismAt(g, 0, hh * 0.1, 0, hw * 0.9, hh * 0.6, 26, W.t, W.l, W.r, W.o, LW);

  // glass + grille above the counter
  const bw = hw * 0.86;
  const bh = hh * 0.1;
  const cx = LX(0, -hh * 0.4);
  const cy = LY(0, -hh * 0.4, 26);
  const H = 22;
  const G = faces(P.metal, P.outline);
  prism(g, cx, cy, bw, bh, H, G.t, rgba(P.cloth, 0.55), rgba(P.cloth, 0.4), G.o, LW);
  const f = faceLeft(bw, bh, _fl);
  const hz = H * ISO.kz;
  g.lineWidth = LW_THIN;
  g.strokeStyle = G.o;
  for (let i = 1; i < 5; i++) {
    const u = i / 5;
    const a = facePt(cx, cy, f, hz, u, 0.05);
    const ax = a.x;
    const ay = a.y;
    const b = facePt(cx, cy, f, hz, u, 0.95);
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(b.x, b.y);
    g.stroke();
  }

  // chip tray on the counter
  padAt(g, -hw * 0.2, hh * 0.3, 26, hw * 0.28, hh * 0.2, shade(P.felt, -0.15), P.outline, LW_THIN);
  chipStacks(g, -hw * 0.2, hh * 0.3, 26, Math.min(hw, hh) * 0.11, seed, 2, P);
  if (P.goldAmt > 0.2) {
    const M = faces(P.gold, P.outline);
    prismAt(g, 0, hh * 0.1, 26, hw * 0.92, hh * 0.62, 2.5, M.t, M.l, M.r, M.o, LW_THIN);
  }
}

function bakeTokenBooth(g, hw, hh, P, seed) {
  groundShadow(g, 0, 0, hw, hh, 0.82, P.shadow);
  const M = faces(P.metal, P.outline);
  const bw = hw * 0.6;
  const bh = hh * 0.6;
  const H = 34;
  const cx = LX(0, 0);
  const cy = LY(0, 0, 0);
  prism(g, cx, cy, bw, bh, H, M.t, M.l, M.r, M.o, LW);
  // Gilded crown only from tier 2 — tier 1 stays a bare metal booth.
  if (P.tierIdx > 0) {
    const G = faces(P.gold, P.outline);
    prism(g, cx, cy - H * ISO.kz, bw * 1.1, bh * 1.1, 7, G.t, G.l, G.r, G.o, LW);
  }

  const f = faceLeft(bw, bh, _fl);
  const hz = H * ISO.kz;
  facePanel(g, cx, cy, f, hz, 0.2, 0.8, 0.52, 0.62, '#141826', M.o, LW_THIN);
  facePanel(g, cx, cy, f, hz, 0.26, 0.74, 0.16, 0.36, shade(P.metal, -0.32), M.o, LW_THIN);

  // coin pile out front — an extra coin at tier 3 (richer booth).
  const coins = P.tierIdx === 2 ? 5 : 4;
  for (let i = 0; i < coins; i++) {
    const px = hw * (0.5 + (i % 2) * 0.28);
    const py = hh * (0.5 + Math.floor(i / 2) * 0.3);
    discAt(g, px, py, 0.6 + i * 0.4, 4.2, P.gold, P.outline, LW_THIN);
  }
  void seed;
}

const BAKE_SPRITE = {
  slots: bakeSlots,
  blackjack: bakeBlackjack,
  roulette: bakeRoulette,
  craps: bakeCraps,
  sportsbook: bakeSportsbook,
  wheel: bakeWheel,
  vip: bakeVip,
  bar: bakeBar,
  buffet: bakeBuffet,
  showroom: bakeShowroom,
  security: bakeSecurity,
  cashier: bakeCashier,
  tokenBooth: bakeTokenBooth
};

/* ------------------------------------------------------------------ *
 *  Animated venue overlays — drawn per frame on top of the baked sprite,
 *  same local iso coordinate system (footprint centre at 0,0).
 * ------------------------------------------------------------------ */

const REEL_COLS = ['#ff4d5e', '#ffd23f', '#7ed957', '#3fa8ff', '#ff8ad4'];

function animSlots(g, hw, hh, P, t, seed) {
  const bw = hw * 0.6;
  const bh = hh * 0.6;
  const H = 40;
  const cx = LX(-hw * 0.12, -hh * 0.12);
  const cy = LY(-hw * 0.12, -hh * 0.12, 0);
  const f = faceLeft(bw, bh, _fl);
  const hz = H * ISO.kz;

  g.save();
  facePath(g, cx, cy, f, hz, 0.13, 0.87, 0.44, 0.88);
  g.clip();
  g.fillStyle = P.screen;
  g.fill();

  const rad = Math.max(1.4, bw * 0.17);
  for (let r2 = 0; r2 < 3; r2++) {
    const u = 0.24 + r2 * 0.25;
    const speed = 1.6 + r2 * 0.5 + rnd(seed + r2, 41) * 0.9;
    const off = ((t * speed + rnd(seed + r2, 43)) % 1) * 0.28;
    for (let k = -1; k < 3; k++) {
      const v = 0.5 + off + k * 0.28;
      if (v < 0.4 || v > 0.95) continue;
      const p = facePt(cx, cy, f, hz, u, v);
      const sym = (Math.floor(t * speed + k + r2 * 3 + seed) % REEL_COLS.length + REEL_COLS.length) % REEL_COLS.length;
      g.beginPath();
      g.arc(p.x, p.y, rad, 0, TAU);
      g.fillStyle = REEL_COLS[sym];
      g.fill();
      g.lineWidth = LW_THIN;
      g.strokeStyle = ink(REEL_COLS[sym]);
      g.stroke();
    }
  }
  g.restore();

  // marquee blink
  const blink = 0.45 + 0.55 * Math.abs(Math.sin(t * 3 + seed));
  facePanel(g, cx, cy - H * ISO.kz, faceLeft(bw * 1.05, bh * 1.05, _fr), 9 * ISO.kz,
    0.12, 0.88, 0.25, 0.75, rgba(P.screenLit, blink * 0.85), null, 0);
}

function animRoulette(g, hw, hh, P, t, seed) {
  const th = hh * 0.86;
  const wr = Math.min(hw, hh) * 0.48;
  const cx = LX(0, -th * 0.42);
  const cy = LY(0, -th * 0.42, 25);
  const rx = wr * ISO_R;

  g.save();
  g.translate(cx, cy);
  g.scale(1, 0.5);
  const a0 = t * 1.1 + seed;
  const wedges = 12;
  for (let i = 0; i < wedges; i++) {
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, rx, a0 + (i / wedges) * TAU, a0 + ((i + 1) / wedges) * TAU);
    g.closePath();
    g.fillStyle = i % 2 === 0 ? '#e63950' : '#2b2440';
    g.fill();
  }
  g.beginPath();
  g.arc(0, 0, rx * 0.34, 0, TAU);
  g.fillStyle = P.gold;
  g.fill();
  const ba = -t * 2.6 + seed;
  g.beginPath();
  g.arc(Math.cos(ba) * rx * 0.76, Math.sin(ba) * rx * 0.76, Math.max(1.2, rx * 0.1), 0, TAU);
  g.fillStyle = '#fdfbf2';
  g.fill();
  g.restore();

  ellipse(g, cx, cy, rx, rx * 0.5);
  g.lineWidth = LW;
  g.strokeStyle = ink(P.wood);
  g.stroke();
}

function animWheel(g, hw, hh, P, t, seed) {
  const cx = LX(0, -hh * 0.1);
  const cy = LY(0, -hh * 0.1, 26) - 44 * ISO.kz;
  const r = Math.min(hw, hh) * 0.82;
  const spin = t * 0.9 + Math.sin(t * 0.35 + seed) * 0.8;
  const wedges = 14;
  for (let i = 0; i < wedges; i++) {
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, r, spin + (i / wedges) * TAU, spin + ((i + 1) / wedges) * TAU);
    g.closePath();
    const k = i % 3;
    g.fillStyle = k === 0 ? P.accent : k === 1 ? '#e6355e' : P.cloth;
    g.fill();
  }
  upright(g, cx, cy, r);
  g.lineWidth = LW * 1.6;
  g.lineJoin = 'round';
  g.strokeStyle = ink(P.wood);
  g.stroke();
  upright(g, cx, cy, r * 0.17);
  g.fillStyle = P.gold;
  g.fill();
  g.lineWidth = LW;
  g.stroke();
  // pointer
  g.beginPath();
  g.moveTo(cx, cy - r * 1.2);
  g.lineTo(cx - r * 0.14, cy - r * 0.9);
  g.lineTo(cx + r * 0.14, cy - r * 0.9);
  g.closePath();
  g.fillStyle = P.gold;
  g.fill();
  g.stroke();
}

function animSportsbook(g, hw, hh, P, t, seed) {
  const bw = hw * 0.95;
  const bh = hh * 0.15;
  const H = 58;
  const cx = LX(0, -hh * 0.62);
  const cy = LY(0, -hh * 0.62, 0);
  const f = faceLeft(bw, bh, _fl);
  const hz = H * ISO.kz;
  for (let r2 = 0; r2 < 2; r2++) {
    for (let c = 0; c < 4; c++) {
      const u0 = 0.05 + c * 0.235;
      const v0 = 0.2 + r2 * 0.38;
      const id = r2 * 4 + c;
      facePanel(g, cx, cy, f, hz, u0, u0 + 0.19, v0, v0 + 0.3,
        rgba(P.screenLit, 0.2 + 0.16 * Math.abs(Math.sin(t * 1.3 + id))), null, 0);
      for (let b = 0; b < 3; b++) {
        const ph = rnd(id * 7 + b, 61);
        const len = 0.03 + 0.15 * Math.abs(Math.sin(t * (0.5 + ph) + b + id));
        const vv = v0 + 0.05 + b * 0.08;
        facePanel(g, cx, cy, f, hz, u0 + 0.02, u0 + 0.02 + len, vv, vv + 0.045,
          b === 1 ? '#7ed957' : P.screenLit, null, 0);
      }
    }
  }
  void seed;
}

function animShowroom(g, hw, hh, P, t, seed) {
  const sy = LY(0, hh * 0.12, 14);
  const sx = LX(0, hh * 0.12);
  // spotlight cones
  for (let i = 0; i < 3; i++) {
    const sway = Math.sin(t * (0.5 + i * 0.23) + i * 2 + seed) * hw * 0.3;
    const ox = LX(-hw * 0.4 + i * hw * 0.4, -hh * 0.5);
    const oy = LY(-hw * 0.4 + i * hw * 0.4, -hh * 0.5, 60);
    g.beginPath();
    g.moveTo(ox, oy);
    g.lineTo(sx + sway - hw * 0.18, sy + 4);
    g.lineTo(sx + sway + hw * 0.18, sy + 4);
    g.closePath();
    g.fillStyle = rgba(i === 0 ? '#ff8ad4' : i === 1 ? '#7fdcff' : P.accent, 0.18);
    g.fill();
  }
  // performer
  const bob = Math.sin(t * 4 + seed) * 2.4;
  chibiFigure(g, sx, sy, 7.5, PERFORMER, bob, t, seed, false, P.shadow, P.outline);
  // footlights
  for (let i = 0; i < 6; i++) {
    const on = 0.4 + 0.6 * Math.abs(Math.sin(t * 2.4 + i * 0.9));
    const px = -hw * 0.62 + i * hw * 0.25;
    const p = { x: LX(px, hh * 0.42), y: LY(px, hh * 0.42, 15) };
    g.beginPath();
    g.arc(p.x, p.y, 2.4, 0, TAU);
    g.fillStyle = rgba(P.neon, on);
    g.fill();
  }
}

function animBar(g, hw, hh, P, t, seed) {
  let on = 0.45 + 0.4 * Math.abs(Math.sin(t * 1.7 + seed));
  if (P.flicker > 0 && rnd(Math.floor(t * 9) + seed, 71) < 0.1) on *= 0.35;
  const bw = hw * 0.95;
  const bh = hh * 0.22;
  const cx = LX(0, -hh * 0.55);
  const cy = LY(0, -hh * 0.55, 0);
  const f = faceLeft(bw, bh, _fl);
  facePanel(g, cx, cy, f, 46 * ISO.kz, 0.1, 0.9, 0.78, 0.92, rgba(P.neon, on), null, 0);
}

function animVip(g, hw, hh, P, t, seed) {
  const pulse = 0.4 + 0.3 * Math.sin(t * 1.4 + seed);
  isoDiamond(g, LX(0, 0), LY(0, 0, 1.2), hw * 0.76, hh * 0.76);
  g.lineJoin = 'round';
  g.lineWidth = LW * 1.4;
  g.strokeStyle = rgba(P.gold, clamp(pulse + 0.35, 0.2, 0.95));
  g.stroke();
}

function animSecurity(g, hw, hh, P, t, seed) {
  const scan = (t * 0.8 + rnd(seed, 91)) % 1;
  const z = 6 + scan * 36;
  padAt(g, 0, 0, z, hw * 0.5, hh * 0.6, rgba(P.neon, 0.4), null, 0);
}

function animBuffet(g, hw, hh, P, t, seed) {
  // steam wisps over the trays
  for (let i = 0; i < 3; i++) {
    const px = -hw * 0.5 + i * hw * 0.5;
    const ph = ((t * 0.5 + i * 0.33 + rnd(seed + i, 51)) % 1);
    const p = { x: LX(px, 0), y: LY(px, 0, 30 + ph * 24) };
    g.beginPath();
    g.arc(p.x, p.y, 2.6 + ph * 2.4, 0, TAU);
    g.fillStyle = rgba('#ffffff', 0.3 * (1 - ph));
    g.fill();
  }
  void P;
}

const ANIM_SPRITE = {
  slots: animSlots,
  roulette: animRoulette,
  wheel: animWheel,
  sportsbook: animSportsbook,
  showroom: animShowroom,
  bar: animBar,
  vip: animVip,
  security: animSecurity,
  buffet: animBuffet
};

/* ------------------------------------------------------------------ *
 *  Chibi figures
 * ------------------------------------------------------------------ */

/**
 * Below this many CSS px per figure unit the chibi's uniform detail — the
 * hi-vis band (0.26u), the tie, the cap brim (0.2u) — is at or under one
 * device pixel, so all three roles collapse into "small dark blob" and the
 * screen-space marker is the ONLY thing carrying role. That is a single point
 * of failure: a marker that gets staggered, culled or turned off takes role
 * identity with it. Under this threshold the sprite repaints its torso as a
 * flat role-coloured EMBLEM with a minimum screen size, using the same shape
 * vocabulary as the markers (diamond / shield / broom) so the two reinforce
 * one cue instead of teaching two.
 *
 * 9 px/unit ~= a 25 CSS px tall figure, which is where the band stops reading.
 */
const ROLE_LOD_PX = 9;
/** Minimum on-screen radius (CSS px) of that emblem. */
const ROLE_LOD_MIN = 5.5;

const U_GUEST = 8.0;
// Staff used to be 8.6 — a 7.5% edge over a guest, i.e. 0.8 CSS px at the
// phone's fit zoom, which is no silhouette cue at all. Staff are a distinct
// CLASS of actor, so they get a visibly taller sprite on top of the uniform
// colour + square shoulders + hi-vis band.
const U_WORKER = 9.6;
const U_VIP = 10.6;
const U_ACTOR = 10.0;

const HAIR = ['#3a2a1e', '#6b3f22', '#1f1a22', '#b8763a', '#8c4a2a', '#d9b06a', '#5a3550'];
const SKINS = ['#ffcf9e', '#f2b98a', '#d99a6c', '#b9784d', '#8c5a3a'];

/**
 * Style record for a figure.
 * { body, skin, hair, hat,
 *   hatType:'none'|'cap'|'visor'|'crown'|'mask'|'tophat'|'mic'|'beanie',
 *   badge, tie, band, shape:'round'|'uniform'|'coat', prop:'none'|'bag' }
 *
 * `band` (hi-vis chest stripe), `shape` (torso silhouette) and `hatType` are the
 * NON-COLOUR half of role identity: they survive greyscale, colour blindness and
 * a 4 CSS px torso, which a hue never does.
 */
function styleOf(body, skin, hair, hat, hatType, badge, tie, band, shape, prop) {
  return {
    body,
    bodyD: shade(body, -0.2),
    ink: ink(body),
    skin: skin || '#ffcf9e',
    skinInk: ink(skin || '#ffcf9e'),
    hair: hair || '#3a2a1e',
    hat: hat || null,
    hatType: hatType || 'none',
    badge: badge || null,
    tie: tie || null,
    band: band || null,
    shape: shape || 'round',
    prop: prop || 'none'
  };
}

/**
 * Staff uniforms are separated from the crowd by LIGHTNESS, not by hue.
 * The old palette encoded role as a torso hue only, and two of the three roles
 * landed inside the random guest palette (guard #2f6fd0 h216 vs the blue guest
 * h210; cleaner #2fc0b0 h173 vs the cyan guest h190) — so a guard read as a blue
 * guest. Every floor/felt/chair material is forced to L>=0.40 by paletteFor()
 * and guests to L~0.50 by guestStyle(), so pushing the two coloured uniforms to
 * L~0.20 puts them in a band nothing else in the scene occupies. Each role also
 * gets its own hi-vis band colour, headwear and prop so the identification never
 * depends on the hue channel alone.
 */
const ROLE_STYLE = {
  // white shirt + dark waistcoat + red bowtie + green visor: the croupier read
  dealer: styleOf('#f7f9fb', '#ffcf9e', '#2a2333', '#1f6b46', 'visor', null, '#d81e5b', '#1b2130', 'uniform'),
  // navy uniform + gold hi-vis band + peaked cap
  guard: styleOf('#0d2b52', '#e8b184', '#1f1a2b', '#0a1f3d', 'cap', '#ffd400', null, '#ffd400', 'uniform'),
  // graphite overalls + orange hi-vis band + white cap (plus the mop prop)
  cleaner: styleOf('#2b2f38', '#d99a6c', '#3a2a1e', '#e8edf0', 'cap', null, null, '#ff7a00', 'uniform')
};

// The gold crown used to be shared by the showroom performer, the live-event VIP
// and every VIP guest — three unrelated things reading as the same character.
// It is now reserved for the live-event VIP; the performer gets a headset mic
// and VIP guests get a top hat.
const PERFORMER = styleOf('#ff4d8b', '#ffcf9e', '#22202c', '#ffd23f', 'mic', null, '#ffd23f', null, 'coat');

const ACTOR_STYLE = {
  thief: styleOf('#141019', '#e8b184', '#16141f', '#16141f', 'mask', null, null, null, 'round'),
  brinks: styleOf('#3a4048', '#e8b184', '#2a2e33', '#2a3038', 'cap', '#ffd23f', null, '#ffd400', 'uniform'),
  counter: styleOf('#3b1f6e', '#f2b98a', '#2a2333', null, 'none', null, null, null, 'coat'),
  angry: styleOf('#7a1f10', '#ffbe8a', '#5a2a18', null, 'none', null, null, null, 'round'),
  vip: styleOf('#2b2438', '#ffcf9e', '#22202c', '#ffd23f', 'crown', null, '#ffd23f', null, 'coat')
};

/**
 * Guest archetypes. The sim hands the renderer nothing but a random palette
 * colour, so the crowd was a hue lottery with zero silhouette variety. Deriving
 * a stable archetype from the guest's id seed costs nothing, is deterministic
 * for the life of the guest, and gives the crowd four readable body shapes —
 * which also stops "one more anonymous blob" from being the only thing a player
 * can say about anybody on the floor.
 */
const GUEST_ARCHETYPES = [
  { hat: null, hatType: 'none', shape: 'round', prop: 'none', tie: null },
  { hat: '#2a2f45', hatType: 'cap', shape: 'round', prop: 'none', tie: null },
  { hat: null, hatType: 'none', shape: 'round', prop: 'bag', tie: null },
  { hat: '#20242e', hatType: 'beanie', shape: 'coat', prop: 'none', tie: '#e8edf0' }
];

const _guestStyleCache = new Map();

function guestStyle(color, seedN) {
  const arche = Math.abs((seedN * 13) | 0) % GUEST_ARCHETYPES.length;
  const key = color + '|' + arche;
  let s = _guestStyleCache.get(key);
  if (!s) {
    // Guest colors used to go straight to styleOf() with no saturation
    // treatment, unlike every world color (which is always pushed through
    // vivid()). Roughly half of CONFIG.guest.palette is desaturated
    // tan/beige, so the crowd read as muddy khaki against the (now bright)
    // floor. Force the same high-chroma treatment here.
    // The target lightness dropped 0.55 -> 0.50 because paletteFor() forces
    // floorA to S0.68/L0.55 — i.e. guests were EXACTLY the swatch of the carpet
    // they stood on in the warm/speakeasy worlds. 0.50 also keeps the crowd well
    // clear of the L~0.20 staff uniforms.
    const body = vivid(color, 0.74, 0.5);
    const A = GUEST_ARCHETYPES[arche];
    s = styleOf(
      body,
      SKINS[Math.abs(seedN | 0) % SKINS.length],
      HAIR[Math.abs((seedN * 7) | 0) % HAIR.length],
      A.hat,
      A.hatType,
      null,
      A.tie,
      null,
      A.shape,
      A.prop
    );
    if (_guestStyleCache.size < 256) _guestStyleCache.set(key, s);
  }
  return s;
}

/**
 * Big-headed chibi: contact shadow, chunky body blob, oversized head with a
 * thick outline, two eyes, role headwear. `bob` shifts the body/head only, so
 * the shadow stays planted on the floor.
 * @param {string} [sh] palette.shadow; falls back to the built-in when absent.
 * @param {string} [ol] palette.outline (P.outline) — the single heavy ink
 *   contour for the whole silhouette (legs/torso/head), matching every other
 *   object in the scene. Falls back to the fill-derived S.ink/S.skinInk (the
 *   old per-character tinted edge) only when not supplied.
 */
function chibiFigure(g, ix, iy, u, S, bob, t, seedN, moving, sh, ol) {
  // One walk phase drives the legs, the torso squash AND the contact shadow.
  // The legs used to be two static rects, so a walking dealer was pixel-identical
  // to a standing one and the only motion cue was a 2-px vertical bob — half of
  // the "you never see the staff move" complaint. A real stride plus a shadow
  // that slides under the figure reads as walking even at ~10 CSS px tall.
  const stride = moving ? Math.sin(t * 11 + seedN) : 0;

  // contact shadow
  ellipse(g, ix + stride * u * 0.17, iy, u * (1.05 - Math.abs(stride) * 0.07), u * 0.48);
  g.fillStyle = typeof sh === 'string' && sh ? sh : SHADOW_STRONG;
  g.fill();

  const inkCol = typeof ol === 'string' && ol ? ol : S.ink;
  const by = iy + bob;
  const sq = moving ? 1 + stride * 0.05 : 1;

  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.lineWidth = LW_CHAR;

  // legs — antiphase swing along the iso-x axis, with the forward leg lifting
  // off the floor. At stride 0 this is exactly the old static pose.
  g.fillStyle = inkCol;
  for (let li = 0; li < 2; li++) {
    const ph = li === 0 ? stride : -stride;
    const lx = ix + (li === 0 ? -u * 0.42 : u * 0.1) + ph * u * 0.24;
    const lift = Math.max(0, ph) * u * 0.16;
    rr(g, lx, by - u * 0.44 - lift, u * 0.32, u * 0.46 - lift * 0.45, u * 0.15);
    g.fill();
  }

  // torso — the silhouette carries class information: square shoulders for a
  // uniform, a floor-length coat for VIPs/performers, the round blob for guests.
  const shape = S.shape;
  const tw = u * (shape === 'uniform' ? 1.42 : 1.3) * sq;
  const th = shape === 'coat' ? u * 1.34 : u * 1.14;
  const tr = shape === 'uniform' ? u * 0.14 : u * 0.42;
  rr(g, ix - tw / 2, by - u * 1.5, tw, th, tr);
  g.fillStyle = S.body;
  g.fill();
  g.strokeStyle = inkCol;
  g.stroke();

  // hi-vis chest band — the staff cue that survives greyscale
  if (S.band) {
    rr(g, ix - tw / 2, by - u * 1.14, tw, u * 0.26, u * 0.1);
    g.fillStyle = S.band;
    g.fill();
  }

  // carried prop (shopper tote)
  if (S.prop === 'bag') {
    rr(g, ix + u * 0.56, by - u * 1.0, u * 0.5, u * 0.62, u * 0.1);
    g.fillStyle = shade(S.body, 0.28);
    g.fill();
    g.strokeStyle = inkCol;
    g.stroke();
  }

  // tie / lapel accent
  if (S.tie) {
    g.beginPath();
    g.moveTo(ix, by - u * 1.42);
    g.lineTo(ix - u * 0.18, by - u * 1.12);
    g.lineTo(ix + u * 0.18, by - u * 1.12);
    g.closePath();
    g.fillStyle = S.tie;
    g.fill();
  }
  if (S.badge) {
    g.beginPath();
    g.arc(ix + u * 0.38, by - u * 1.16, u * 0.14, 0, TAU);
    g.fillStyle = S.badge;
    g.fill();
  }

  // head
  const hy = by - u * 2.02;
  const hr = u * 0.72;
  g.beginPath();
  g.arc(ix, hy, hr, 0, TAU);
  g.fillStyle = S.skin;
  g.fill();
  g.strokeStyle = inkCol;
  g.stroke();

  // hair cap
  g.beginPath();
  g.arc(ix, hy - u * 0.04, hr * 0.99, Math.PI, TAU);
  g.closePath();
  g.fillStyle = S.hair;
  g.fill();

  // eyes
  g.fillStyle = '#221c2e';
  g.beginPath();
  g.arc(ix - u * 0.26, hy + u * 0.1, u * 0.11, 0, TAU);
  g.fill();
  g.beginPath();
  g.arc(ix + u * 0.26, hy + u * 0.1, u * 0.11, 0, TAU);
  g.fill();

  // headwear
  const ht = S.hatType;
  if (ht === 'cap') {
    g.beginPath();
    g.arc(ix, hy - u * 0.1, hr * 1.02, Math.PI, TAU);
    g.closePath();
    g.fillStyle = S.hat;
    g.fill();
    g.strokeStyle = ink(S.hat);
    g.stroke();
    rr(g, ix - hr * 1.15, hy - u * 0.24, hr * 2.3, u * 0.2, u * 0.09);
    g.fillStyle = S.hat;
    g.fill();
    g.stroke();
  } else if (ht === 'visor') {
    rr(g, ix - hr * 1.05, hy - u * 0.26, hr * 2.1, u * 0.24, u * 0.1);
    g.fillStyle = S.hat;
    g.fill();
    g.strokeStyle = ink(S.hat);
    g.stroke();
  } else if (ht === 'mask') {
    rr(g, ix - hr * 0.95, hy - u * 0.06, hr * 1.9, u * 0.3, u * 0.08);
    g.fillStyle = S.hat;
    g.fill();
  } else if (ht === 'tophat') {
    // VIP GUESTS wear this; the crown belongs to the live-event VIP alone.
    rr(g, ix - hr * 1.3, hy - u * 0.34, hr * 2.6, u * 0.17, u * 0.07);
    g.fillStyle = S.hat || '#1b1b28';
    g.fill();
    g.strokeStyle = ink(S.hat || '#1b1b28');
    g.stroke();
    rr(g, ix - hr * 0.64, hy - u * 0.98, hr * 1.28, u * 0.7, u * 0.06);
    g.fill();
    g.stroke();
    rr(g, ix - hr * 0.64, hy - u * 0.52, hr * 1.28, u * 0.16, u * 0.04);
    g.fillStyle = '#ffd400';
    g.fill();
  } else if (ht === 'beanie') {
    g.beginPath();
    g.arc(ix, hy - u * 0.06, hr * 1.0, Math.PI, TAU);
    g.closePath();
    g.fillStyle = S.hat || '#20242e';
    g.fill();
    rr(g, ix - hr * 1.0, hy - u * 0.16, hr * 2.0, u * 0.16, u * 0.07);
    g.fill();
  } else if (ht === 'mic') {
    // Showroom performer: headset boom + mic ball, so the stage act is not
    // another gold crown.
    g.lineWidth = Math.max(LW_THIN, u * 0.1);
    g.strokeStyle = '#22202c';
    g.beginPath();
    g.arc(ix, hy - u * 0.12, hr * 1.04, Math.PI * 1.08, TAU * 0.98);
    g.stroke();
    g.beginPath();
    g.moveTo(ix + hr * 0.98, hy - u * 0.02);
    g.lineTo(ix + hr * 0.5, hy + u * 0.34);
    g.stroke();
    g.beginPath();
    g.arc(ix + hr * 0.44, hy + u * 0.38, u * 0.16, 0, TAU);
    g.fillStyle = S.hat || '#ffd23f';
    g.fill();
    g.lineWidth = LW_CHAR;
  } else if (ht === 'crown') {
    g.beginPath();
    g.moveTo(ix - hr * 0.8, hy - hr * 0.72);
    g.lineTo(ix - hr * 0.42, hy - hr * 1.35);
    g.lineTo(ix, hy - hr * 0.82);
    g.lineTo(ix + hr * 0.42, hy - hr * 1.35);
    g.lineTo(ix + hr * 0.8, hy - hr * 0.72);
    g.closePath();
    g.fillStyle = S.hat || '#ffd23f';
    g.fill();
    g.strokeStyle = ink(S.hat || '#ffd23f');
    g.stroke();
  }
}

/**
 * Guest states that should draw a patience bar + queue chevron.
 * Must stay in sync with sim/guests.js's QUEUE_STATES table plus the
 * at-the-counter service states. Older generic aliases are kept so a guest sim
 * that reports a different vocabulary still renders sensibly.
 */
const WAITING_STATES = {
  queueSecurity: 1,
  queueCashier: 1,
  queueVenue: 1,
  queueService: 1,
  queueCashout: 1,
  security: 1,
  cashier: 1,
  cashout: 1,
  waitToken: 1,
  queue: 1,
  queueing: 1,
  waiting: 1,
  wait: 1
};

function byDepth(a, b) {
  return a.d - b.d;
}

/* ------------------------------------------------------------------ *
 *  Role markers (C4)
 *
 *  Everything here is CSS px in the SCREEN-SPACE overlay pass, never
 *  world-scaled: the old chest badge was a 0.49 CSS px dot at the phone's fit
 *  zoom, i.e. invisible exactly when identification matters most. A marker
 *  drawn at a fixed screen size cannot vanish however far the player zooms out.
 *  The glyphs are SHAPES first and colours second so they still separate in
 *  greyscale and for colour-blind players.
 * ------------------------------------------------------------------ */

/** Base disc radius, CSS px. Never scales below this. */
const PIP_R = 8;
/** Gap in CSS px between the top of the head and the marker. */
const PIP_LIFT = 9;
/** Iso px from a figure's ground anchor to the top of its head, per unit. */
const HEAD_UP = 2.9;
/** How many upward hops (per lane, 3 lanes) an overlay may take before giving up.
 *  One hop clears one blocker, so this bounds the tallest resolvable pile; 20
 *  covers "the entire staff and every flagged guest standing on one tile", which
 *  is the worst case a shift change can actually produce. */
const STACK_TRIES = 20;
/** Breathing gap left between two stacked overlays, CSS px. */
const MARK_GAP = 2;
/** Money-popup box height (CSS px) and how many hops it may take. */
const POPUP_STEP = 17;
const POPUP_TRIES = 20;
/** Marker budgets. Staff are few and their identity is the point of the whole
 *  system, so they get their own generous budget and are NEVER traded away for
 *  guest markers; only the flagged-guest pass is density-capped. */
/**
 * Staff marker budget. Was 64, which is more staff than fit on a phone screen
 * without the markers becoming the screen — measured on a Luxury Resort save,
 * ~50 staff produced a solid mat of overlapping pills. 20 icon pips is still
 * every dealer on a mid-game floor, and the placement pass keeps them from
 * colliding.
 */
const WORKER_MARK_MAX = 20;
/** Word-plates (as opposed to icon pips) allowed on screen at once. */
const TEXT_PLATE_MAX = 6;
/** ...and how many may carry the SAME message. Six "No table" plates restate
 *  one fact six times; two is enough to read it as a pattern. */
const TEXT_PLATE_PER_KEY_MAX = 2;
/**
 * Below this zoom a staff word-plate is suppressed unless its subject is in an
 * actionable state. Roughly "the player has leaned in to inspect one area",
 * where there is both room for words and a reason to want them.
 */
const ZOOM_FOR_TEXT = 1.9;
const GUEST_MARK_MAX = 24;
/**
 * Angry guests get their OWN, much tighter cap.
 *
 * A VIP marker is per-subject information: that specific guest is worth money,
 * and twenty of them in a packed VIP room is twenty useful facts. "Angry" is
 * not like that — it is one systemic fact ("service is too slow") restated once
 * per guest. On a busy floor the old shared cap of 24 put two dozen pulsing red
 * pins over the casino, which read as an error state and buried the staff
 * markers the player actually needs. A few is a signal; two dozen is noise.
 */
const ANGRY_MARK_MAX = 3;

/** Role/kind -> { glyph, col } table. Colours match the uniforms. */
const MARK = {
  dealer: { glyph: 'diamond', col: '#ffffff', key: 'role.dealer.name' },
  guard: { glyph: 'shield', col: '#ffd400', key: 'role.guard.name' },
  cleaner: { glyph: 'broom', col: '#ff7a00', key: 'role.cleaner.name' },
  vip: { glyph: 'star', col: '#ffd23f', key: 'role.vipGuest.name' },
  angry: { glyph: 'bang', col: '#ff5a4a', key: 'state.guest.angry' }
};

/**
 * Draw one role glyph centred at (cx, cy) inside radius r.
 * Pure canvas path work — no state left behind except fill/stroke style.
 */
function pipGlyph(g, cx, cy, r, glyph, col) {
  g.fillStyle = col;
  g.strokeStyle = col;
  if (glyph === 'diamond') {
    g.beginPath();
    g.moveTo(cx, cy - r);
    g.lineTo(cx + r * 0.72, cy);
    g.lineTo(cx, cy + r);
    g.lineTo(cx - r * 0.72, cy);
    g.closePath();
    g.fill();
  } else if (glyph === 'shield') {
    g.beginPath();
    g.moveTo(cx, cy - r);
    g.lineTo(cx + r * 0.82, cy - r * 0.5);
    g.lineTo(cx + r * 0.82, cy + r * 0.16);
    g.quadraticCurveTo(cx + r * 0.6, cy + r, cx, cy + r);
    g.quadraticCurveTo(cx - r * 0.6, cy + r, cx - r * 0.82, cy + r * 0.16);
    g.lineTo(cx - r * 0.82, cy - r * 0.5);
    g.closePath();
    g.fill();
  } else if (glyph === 'broom') {
    g.lineWidth = Math.max(1.6, r * 0.3);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx + r * 0.62, cy - r * 0.86);
    g.lineTo(cx - r * 0.14, cy + r * 0.12);
    g.stroke();
    g.beginPath();
    g.moveTo(cx - r * 0.62, cy + r * 0.9);
    g.lineTo(cx - r * 0.72, cy + r * 0.06);
    g.lineTo(cx + r * 0.36, cy + r * 0.34);
    g.lineTo(cx + r * 0.12, cy + r * 1.0);
    g.closePath();
    g.fill();
  } else if (glyph === 'star') {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr2 = i % 2 === 0 ? r : r * 0.46;
      const px = cx + Math.cos(a) * rr2;
      const py = cy + Math.sin(a) * rr2;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
    g.fill();
  } else if (glyph === 'bang') {
    const w = Math.max(1.8, r * 0.38);
    rr(g, cx - w / 2, cy - r, w, r * 1.24, w * 0.5);
    g.fill();
    g.beginPath();
    g.arc(cx, cy + r * 0.66, w * 0.62, 0, TAU);
    g.fill();
  }
}

/* ------------------------------------------------------------------ *
 *  Renderer
 * ------------------------------------------------------------------ */

/** Slab / wall geometry, world px. */
const SLAB_H = 26;
const WALL_H = 48;
/** How far below the fit-the-whole-floor zoom the player may pull back.
 *  Must be < 1 or minZoom collides with fitView() and zoom-out stops working. */
const ZOOM_OUT_HEADROOM = 0.6;

/** Breathing margin left around the diorama by the 'contain' framing. Cover
 *  deliberately has none — a margin is backdrop, which is what it removes. */
const FIT_MARGIN = 0.95;

/**
 * Normalise a framing mode. Accepts the two natural vocabularies (cover/fill,
 * contain/fit/whole) because callers outside this file think in both.
 * @returns {'cover'|'contain'}
 */
function normFrameMode(mode, fallback) {
  if (mode === 'cover' || mode === 'fill') return 'cover';
  if (mode === 'contain' || mode === 'fit' || mode === 'whole') return 'contain';
  return fallback === 'contain' ? 'contain' : 'cover';
}

const BAKE_MAX_PIXELS = 8.4e6;
const BAKE_COOLDOWN_MS = 220;

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas || null;
    this.ctx = null;
    if (this.canvas && typeof this.canvas.getContext === 'function') {
      this.ctx = this.canvas.getContext('2d', { alpha: false }) || this.canvas.getContext('2d');
    }

    this.dpr = 1;
    this.cssW = 960;
    this.cssH = 600;
    this._bw = 0;
    this._bh = 0;

    /* ---- Adaptive resolution -------------------------------------------
     * Measured on a Pixel 10 Pro at Luxury Resort scale (~140 actors): the
     * frame loop ran at 14 fps while JS sat 87% IDLE and ScriptDuration was
     * 8% of wall. Nothing was CPU-bound — the cost is RASTERISATION of ~32k
     * canvas path ops into an 822x1592 backing store (1.31 MP) every frame.
     *
     * Raster cost scales with pixel count, so the cheapest large lever is to
     * render fewer pixels and let the compositor upscale. This tracks frame
     * time and walks the render scale down when the game is missing frames,
     * back up when it has headroom. The CSS size never changes, so layout,
     * hit-testing and the camera contract are all untouched.
     */
    /** Multiplier on dpr for the backing store. 1 = full device resolution. */
    this._renderScale = 1;
    /** Smoothed frame time (ms), the signal the scaler reacts to. */
    this._frameEma = 0;
    /** Frames since the last scale change — hysteresis against oscillation. */
    this._sinceScale = 0;

    /** Camera: ISO px -> CSS px is  css = iso * zoom + pan. */
    this.camera = { zoom: 1, panX: 0, panY: 0 };
    // Was a flat 0.45 — on a phone-sized viewport fitView() clamped to this
    // floor and rendered ~10 CSS px tall chibis with a sub-1px outline, so it
    // got raised to 0.9 to keep figures legible at the default framing. But a
    // flat 0.9 floor is itself too high on narrow portrait viewports: the
    // diorama's iso bounding box is often wider than 0.9x the viewport can
    // show, so fitView()/zoom-out both get clamped up and the floor plan
    // renders cropped with no way to see the whole thing at once.
    // _updateMinZoom() keeps this viewport-aware: it never exceeds 0.9 (so
    // figures stay legible when the screen is wide enough) but relaxes down
    // to fit the diorama's width when the viewport is narrower than that.
    this.minZoom = 0.9;
    this.maxZoom = 3.0;

    /**
     * CSS px of UI chrome floating OVER each canvas edge (C2). The canvas is
     * full-viewport, so the HUD on top and the collapsed build drawer at the
     * bottom hide part of it; framing against the raw canvas box put the casino
     * behind them. All-zero is the default and reproduces the old behaviour
     * exactly, so nothing regresses if main.js never calls setViewInsets().
     */
    this.viewInsets = { top: 0, right: 0, bottom: 0, left: 0 };

    /**
     * Framing policy: 'cover' fills the visible rect and crops the rest,
     * 'contain' shows the whole diorama and letterboxes. Cover is the default —
     * see fitView() for why a phone must not letterbox an iso diamond.
     */
    this._frameMode = 'cover';

    /** 'off' | 'roles' | 'all' — how much text identification to draw (C4). */
    this.labelMode = 'roles';
    /** Injected translator (C4); the renderer must not depend on locale files. */
    this._tr = null;

    /**
     * Flat [x,y,w,h,...] of EVERY screen-space overlay box placed this frame —
     * role markers (labelled or not), actor labels and money popups. It used to
     * hold nameplates only, so a disc-only marker was free to land in the middle
     * of somebody else's plate and "Guard" rendered as "G<star>rd". One shared
     * occupancy list is the only way overlays can dodge each other.
     */
    this._markRects = [];

    // True while the camera still sits exactly where fitView() put it (no user
    // pan/zoom since). Only then may a late setViewInsets() re-frame the view —
    // yanking a camera the player has aimed themselves would be hostile.
    this._camClean = false;

    // world extents (world px)
    this.worldW = 960;
    this.worldH = 640;
    this.tile = CONFIG.grid.tile;
    this.cols = CONFIG.grid.cols;
    this.rows = CONFIG.grid.rows;

    /** Iso-space bounding box of the whole diorama. */
    this._isoB = { minX: -480, minY: -60, maxX: 480, maxY: 460 };

    // time
    this.t = 0;
    this._last = 0;

    // popups
    this._popups = [];

    // baked ground plane (iso space)
    this._bake = null;
    this._bakeKey = '';
    this._bucket = 1;
    this._bakeAt = 0;

    // per-venue baked sprites, shared by (key|w|h)
    this._spriteCache = new Map();

    // layout cache
    this._layout = null;
    this._layoutRef = null;
    this._rects = [];
    this._nodes = [];
    this._decor = [];
    this._pixelUnits = false;
    this._slotCount = -1;
    this._decorTier = -1;
    this._decorWorld = '';
    this._entrance = null;
    this._exit = null;

    // reusable z-buffer for depth-sorted drawables
    this._z = [];
    this._zPool = [];

    // cached screen-space gradients
    this._bg = null;
    this._bgKey = '';
    this._vig = null;
    this._vigKey = '';

    this._fitWorld = null;
    this._fitPending = true;

    this.resize();
  }

  /* ---------------- sizing ---------------- */

  /**
   * Walk the backing-store resolution toward whatever this device can actually
   * rasterise at 60fps.
   *
   * Deliberately slow and hysteretic: a resize reallocates the backing store,
   * so thrashing it would cost more than it saves. It needs ~1s of consistent
   * evidence before each step, and it steps down faster than it steps back up
   * (a stutter should be fixed promptly; a recovery can afford to be gradual).
   *
   * @param {number} dt seconds since the previous frame
   */
  _tuneRenderScale(dt) {
    if (!(dt > 0)) return;
    const ms = dt * 1000;
    // Ignore the first frames and any single monster frame (a GC pause, a
    // layout rebuild) — those are not a resolution problem.
    if (ms > 90) return;
    this._frameEma = this._frameEma ? this._frameEma * 0.85 + ms * 0.15 : ms;
    this._sinceScale++;
    // 30 frames is ~1.4s at the frame rates this actually fires at. Long enough
    // to be evidence, short enough that a player on a weak device is not left
    // at 14fps for ten seconds while the scaler creeps down one step at a time.
    if (this._sinceScale < 30) return;

    const cur = this._renderScale;
    let next = cur;
    // 20ms ~ under 50fps: give up pixels, in a big step — the measured cost is
    // very close to linear in pixel count, so halving the step doubles the time
    // spent stuttering for no benefit. 13ms ~ comfortably above 60fps: take
    // some back, gently. The gap between the thresholds is the dead band.
    // Floor 0.5: on this 2.6x-dpr phone that is still a 1.0x backing store
    // (411x796), i.e. exactly what a non-retina display would show.
    if (this._frameEma > 20 && cur > 0.5) next = Math.max(0.5, cur - 0.2);
    else if (this._frameEma < 13 && cur < 1) next = Math.min(1, cur + 0.1);

    if (next !== cur) {
      this._renderScale = next;
      this._sinceScale = 0;
      // Re-baseline: the next frames are measuring a different resolution, and
      // carrying the old average in would immediately trigger another step.
      this._frameEma = 0;
      this.resize();
    }
  }

  /** Re-measure the canvas and rebuild the backing store for the current DPR. */
  resize() {
    const c = this.canvas;
    if (!c) return;

    const dpr = clamp(
      (typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1) *
        (this._renderScale || 1),
      // The floor is deliberately below 1: on a 2.6x-dpr phone even 0.75 is
      // sharper than a 1x desktop display, and a playable 60fps beats a
      // pin-sharp 14fps every time.
      0.6,
      2
    );

    let w = c.clientWidth || 0;
    let h = c.clientHeight || 0;

    // Guard against attribute-driven sizing feeding back into itself. Compare
    // like with like: w/h here are CSS px while _bw/_bh are DEVICE px
    // (round(cssW * dpr)), so the comparison must scale w/h by dpr first —
    // otherwise this fires spuriously whenever the CSS size happens to equal
    // the old device size (e.g. a dpr=2 window exactly doubling in both
    // dimensions), permanently locking the canvas at its previous CSS size.
    if (
      this._bw &&
      Math.abs(w * dpr - this._bw) < 1 &&
      Math.abs(h * dpr - this._bh) < 1 &&
      dpr !== 1
    ) {
      w = this.cssW;
      h = this.cssH;
    }

    if (!(w > 0) || !(h > 0)) {
      const p = c.parentElement;
      if (p) {
        w = p.clientWidth || w;
        h = p.clientHeight || h;
      }
    }
    if (!(w > 0)) w = 960;
    if (!(h > 0)) h = 600;

    this.dpr = dpr;
    this.cssW = w;
    this.cssH = h;
    this._bw = Math.max(1, Math.round(w * dpr));
    this._bh = Math.max(1, Math.round(h * dpr));

    if (c.width !== this._bw) c.width = this._bw;
    if (c.height !== this._bh) c.height = this._bh;

    this._vig = null;
    this._bg = null;
    this._updateMinZoom();
    this._clampPan();
  }

  /**
   * Recompute the zoom-out floor from the current viewport size and the
   * diorama's iso bounding box, so fitView() and manual zoom-out
   * (zoomBy/setZoom, which both clamp against this.minZoom) can always reach
   * a zoom level that shows the whole floor width, even on narrow portrait
   * viewports where a flat 0.9 floor would clamp the fit up and crop the
   * diorama. Never exceeds 0.9 so figures stay legible when the screen is
   * wide enough to not need to relax the floor.
   *
   * This is ALSO what keeps the whole-diorama view reachable now that the
   * default framing is 'cover': minZoom is derived from the CONTAIN zoom and
   * always lands strictly below it, so pinch-out / the "-" button can always
   * pull back to the whole floor plan even though fitView() no longer starts
   * there.
   */
  _updateMinZoom() {
    const b = this._isoB;
    const iw = Math.max(1, b.maxX - b.minX);
    const ih = Math.max(1, b.maxY - b.minY);
    const v = this._viewRect();

    // The zoom at which the whole diorama just fits the UNOBSTRUCTED viewport.
    // Height matters as much as width on a tall phone screen, so fit against
    // both. Using the inset rect here is what keeps zoom-out headroom alive once
    // chrome covers part of the canvas (C2) — measuring against the raw canvas
    // box would leave the floor "fitting" behind the HUD.
    const fit = Math.min((v.w * FIT_MARGIN) / iw, (v.h * FIT_MARGIN) / ih);

    // minZoom must sit strictly BELOW the fit zoom. It used to be the width-fit
    // value itself, which meant fitView() landed the camera exactly on its own
    // floor: on a 411px phone both were 0.61, so the "-" button and pinch-out
    // were dead on arrival and the player could never pull back from the
    // default framing. Keep the 0.9 ceiling so figures stay legible on wide
    // screens, and keep an absolute floor so a huge casino cannot zoom to dust —
    // but never let that absolute floor rise ABOVE the contain zoom, or a very
    // large casino would make the whole-diorama view unreachable.
    this.minZoom = clamp(Math.min(fit * ZOOM_OUT_HEADROOM, 0.9), Math.min(0.18, fit), 0.9);
  }

  /**
   * CONTRACT C2 — declare how much UI chrome floats over each canvas edge.
   * fitView(), centerOn(), _clampPan() and _updateMinZoom() all frame against
   * the resulting rectangle instead of the raw canvas box.
   *
   * Callers measure real boxes (getBoundingClientRect + env(safe-area-inset-*))
   * and may fire this on every resize/drawer toggle, so an unchanged call must
   * cost nothing: it returns false without touching the camera.
   * @returns {boolean} true when the insets actually changed
   */
  setViewInsets({ top = 0, right = 0, bottom = 0, left = 0 } = {}) {
    const px = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const next = { top: px(top), right: px(right), bottom: px(bottom), left: px(left) };
    const cur = this.viewInsets;
    if (
      cur.top === next.top &&
      cur.right === next.right &&
      cur.bottom === next.bottom &&
      cur.left === next.left
    ) {
      return false;
    }

    this.viewInsets = next;
    this._updateMinZoom();
    // Re-frame only while the camera is untouched since the last fit; otherwise
    // just re-clamp so the (possibly now smaller) legal envelope still holds.
    if (this._camClean) this.fitView();
    else this._clampPan();
    return true;
  }

  /**
   * The unobstructed part of the canvas in CSS px, i.e. the canvas box minus
   * this.viewInsets. Clamped to a usable minimum so a bogus/oversized inset can
   * never produce a zero or negative viewport (which would make the fit zoom
   * explode). With the default all-zero insets this is exactly the canvas box.
   * @returns {{x:number,y:number,w:number,h:number}}
   */
  _viewRect() {
    const s = this.viewInsets || { top: 0, right: 0, bottom: 0, left: 0 };
    const minW = Math.min(this.cssW, 80);
    const minH = Math.min(this.cssH, 80);
    let x = s.left;
    let y = s.top;
    let w = this.cssW - s.left - s.right;
    let h = this.cssH - s.top - s.bottom;
    if (!(w >= minW)) {
      w = minW;
      x = clamp(s.left, 0, Math.max(0, this.cssW - minW));
    }
    if (!(h >= minH)) {
      h = minH;
      y = clamp(s.top, 0, Math.max(0, this.cssH - minH));
    }
    return { x, y, w, h };
  }

  /* ---------------- identification (C4) ---------------- */

  /**
   * How much textual identification to draw over the floor (C4).
   * 'off'   — shape/colour markers only.
   * 'roles' — markers + a role nameplate on every staff member (default).
   * 'all'   — the above plus nameplates on flagged guests (VIP / angry).
   * Anything unrecognised falls back to the default rather than throwing.
   * @param {string} mode
   * @returns {string} the mode actually in effect
   */
  setLabelMode(mode) {
    this.labelMode = mode === 'off' || mode === 'all' ? mode : 'roles';
    return this.labelMode;
  }

  /**
   * Inject the translator (C4). The renderer must not reach into locale files
   * itself, and a caller may swap languages mid-session, so the function is
   * stored rather than its results.
   * @param {(key:string)=>string} fn
   */
  setTranslator(fn) {
    this._tr = typeof fn === 'function' ? fn : null;
  }

  /**
   * Translate a key through the injected translator, falling back to the bundled
   * one and finally to the raw key — a missing string must never blank a label
   * or throw inside the draw loop.
   */
  _t(key) {
    const tr = this._tr;
    if (tr) {
      try {
        const s = tr(key);
        if (typeof s === 'string' && s) return s;
      } catch (_e) { /* fall through to the bundled translator */ }
    }
    try {
      const s = t(key);
      if (typeof s === 'string' && s) return s;
    } catch (_e) { /* fall through to the key */ }
    return key;
  }

  /* ---------------- coordinate mapping (the contract) ---------------- */

  /**
   * CSS px (relative to the canvas box) -> WORLD px.
   * Inverts BOTH the camera and the iso projection, which is what keeps
   * guests.hitTest / liveEvents.hitTest working unchanged.
   * Also accepts a MouseEvent/PointerEvent/Touch-like object with clientX/clientY.
   * @returns {{x:number, y:number}}
   */
  screenToWorld(sx, sy) {
    const { px, py } = this._toCssPx(sx, sy);
    const z = this.camera.zoom || 1;
    return isoToWorld((px - this.camera.panX) / z, (py - this.camera.panY) / z);
  }

  /**
   * Same input contract as screenToWorld, but inverts at world height `wz`
   * instead of the ground plane — use this to hit-test against what is
   * actually drawn on screen (a character's body sits well above its ground
   * anchor; see isoToWorldAtHeight for why). screenToWorld(sx, sy) is
   * equivalent to this with wz = 0.
   * @param {number|MouseEvent} sx @param {number} [sy] @param {number} [wz]
   * @returns {{x:number, y:number}}
   */
  screenToWorldAtHeight(sx, sy, wz = 0) {
    const { px, py } = this._toCssPx(sx, sy);
    const z = this.camera.zoom || 1;
    return isoToWorldAtHeight((px - this.camera.panX) / z, (py - this.camera.panY) / z, wz);
  }

  /** Shared input handling for screenToWorld*: accepts (cssX, cssY) or a
   *  MouseEvent/PointerEvent/Touch-like object with clientX/clientY. */
  _toCssPx(sx, sy) {
    if (sx && typeof sx === 'object') {
      const ev = sx;
      const cx = Number.isFinite(ev.clientX) ? ev.clientX : 0;
      const cy = Number.isFinite(ev.clientY) ? ev.clientY : 0;
      const rect = this.canvas && this.canvas.getBoundingClientRect
        ? this.canvas.getBoundingClientRect()
        : { left: 0, top: 0 };
      return { px: cx - rect.left, py: cy - rect.top };
    }
    return { px: Number(sx) || 0, py: Number(sy) || 0 };
  }

  /**
   * WORLD px -> CSS px relative to the canvas box.
   * @param {number} wx @param {number} wy @param {number} [wz]
   * @returns {{x:number,y:number}}
   */
  worldToScreen(wx, wy, wz = 0) {
    const z = this.camera.zoom || 1;
    const p = worldToIso(wx, wy, wz);
    return { x: p.x * z + this.camera.panX, y: p.y * z + this.camera.panY };
  }

  /** CSS px -> ISO px (no world conversion). */
  screenToIso(sx, sy) {
    const z = this.camera.zoom || 1;
    return { x: ((Number(sx) || 0) - this.camera.panX) / z, y: ((Number(sy) || 0) - this.camera.panY) / z };
  }

  /**
   * The visible viewport (the canvas's CSS box) expressed in iso px, i.e. the
   * inverse of screenToIso applied to the four corners. Used to frustum-cull
   * venues/guests/workers/actors before z-sorting and drawing them — camera
   * zoom ranges over [minZoom, maxZoom] against a fixed-size world, so at
   * higher zoom most of the layout is off-screen and should cost nothing per
   * frame.
   * @returns {{minX:number,maxX:number,minY:number,maxY:number}}
   */
  _visibleIso() {
    const z = this.camera.zoom || 1;
    const panX = this.camera.panX;
    const panY = this.camera.panY;
    return {
      minX: (0 - panX) / z,
      maxX: (this.cssW - panX) / z,
      minY: (0 - panY) / z,
      maxY: (this.cssH - panY) / z
    };
  }

  /**
   * The visible rect MINUS the chrome that covers it (contract C2), in iso px.
   *
   * The actor cull used the raw canvas box, but the HUD and the build sheet are
   * both opaque and sit on top of it. With the sheet expanded in portrait only
   * ~24% of the screen actually shows the casino, so roughly three quarters of
   * the guests and staff were being drawn at full detail underneath furniture
   * nobody can see through — and figures are 91% of all draw calls
   * (_drawGuest 52% + _drawWorker 39%, measured).
   *
   * Culling against the inset rect is invisible by construction: the pixels it
   * skips are painted over by an opaque element in the same frame. The chrome
   * insets are re-measured every UI tick, so this follows the drawer up and
   * down on its own.
   */
  _visibleIsoInset() {
    const z = this.camera.zoom || 1;
    const panX = this.camera.panX;
    const panY = this.camera.panY;
    const s = this.viewInsets || { top: 0, right: 0, bottom: 0, left: 0 };
    // A little slack so a figure mid-stride never pops at the sheet's edge
    // while the drawer is animating between its two positions.
    const PAD = 24;
    const l = Math.max(0, (Number(s.left) || 0) - PAD);
    const r2 = Math.max(0, (Number(s.right) || 0) - PAD);
    const t2 = Math.max(0, (Number(s.top) || 0) - PAD);
    const b = Math.max(0, (Number(s.bottom) || 0) - PAD);
    // Never let a bogus inset collapse the world to nothing.
    const w = this.cssW - l - r2;
    const h = this.cssH - t2 - b;
    if (!(w > 40) || !(h > 40)) return this._visibleIso();
    return {
      minX: (l - panX) / z,
      maxX: (this.cssW - r2 - panX) / z,
      minY: (t2 - panY) / z,
      maxY: (this.cssH - b - panY) / z
    };
  }

  /* ---------------- camera ---------------- */

  /** @returns {number} current zoom */
  getZoom() {
    return this.camera.zoom;
  }

  /**
   * Zoom about a screen anchor. The world point under (anchorCssX, anchorCssY)
   * stays EXACTLY under it. Clamped to [minZoom, maxZoom].
   *
   * The pan clamp is deliberately skipped when the anchor sits over the diorama:
   * in that case the content provably still covers the on-screen anchor, so no
   * clamp is needed and the anchor stays pixel-exact. Only an anchor over empty
   * backdrop (where zooming in really can push the floor away) gets clamped.
   * @returns {number} the zoom actually applied
   */
  zoomBy(factor, anchorCssX, anchorCssY) {
    const f = Number(factor);
    if (!Number.isFinite(f) || f <= 0) return this.camera.zoom;
    const c = this.camera;
    const z0 = c.zoom || 1;
    const z1 = clamp(z0 * f, this.minZoom, this.maxZoom);
    if (Math.abs(z1 - z0) < 1e-9) return z0;

    const ax = Number.isFinite(anchorCssX) ? anchorCssX : this.cssW / 2;
    const ay = Number.isFinite(anchorCssY) ? anchorCssY : this.cssH / 2;

    const k = z1 / z0;
    c.panX = ax - (ax - c.panX) * k;
    c.panY = ay - (ay - c.panY) * k;
    c.zoom = z1;
    // Clamp unconditionally. The anchor invariant then holds exactly whenever the
    // clamp is not binding (the normal case), and when it does bind we keep the
    // floor on screen rather than preserving the anchor -- that is the clamp's job.
    // Clamping only for off-content anchors used to do both things wrong: the anchor
    // drifted when the cursor sat on the backdrop, and zooming out over the floor
    // could leave the camera outside the legal envelope so the next pan snapped.
    this._clampPan();
    this._camClean = false;
    return z1;
  }

  /** Absolute zoom about a screen anchor. @returns {number} */
  setZoom(z, anchorCssX, anchorCssY) {
    const target = Number(z);
    if (!Number.isFinite(target) || target <= 0) return this.camera.zoom;
    return this.zoomBy(clamp(target, this.minZoom, this.maxZoom) / (this.camera.zoom || 1), anchorCssX, anchorCssY);
  }

  /** Drag the view by a CSS-pixel delta, clamped so the diorama stays reachable. */
  panBy(dxCss, dyCss) {
    const dx = Number(dxCss);
    const dy = Number(dyCss);
    if (Number.isFinite(dx)) this.camera.panX += dx;
    if (Number.isFinite(dy)) this.camera.panY += dy;
    this._clampPan();
    if (Number.isFinite(dx) || Number.isFinite(dy)) this._camClean = false;
  }

  /**
   * Reset zoom + pan so the layout is framed inside the INSET rectangle (C2),
   * which is the part of the canvas the player can actually see. Insets are
   * re-read here on every call, so a drawer that opened since the last fit is
   * honoured without any extra plumbing.
   *
   * FRAMING POLICY — the default is 'cover' (fill the view, crop the rest), not
   * 'contain' (show everything, letterbox the rest). The diorama's iso bounding
   * box is ~1.66:1 landscape; a phone viewport is ~0.54:1 portrait. Containing
   * one in the other is a 3x aspect mismatch, so on the 411x760 target device
   * the casino occupied ~24% of the screen (~13.5% actual ink) and the rest was
   * backdrop gradient — measured, and the loudest single part of "it looks bad
   * on mobile". Covering fills the visible rect and lets the player pan, which
   * is what every tycoon game on a phone does.
   *
   * On a wide screen the two are nearly identical (cover 1.88 vs contain 1.67 at
   * 1600x900), so this only bites where it needs to.
   *
   * The whole-diorama view stays reachable two ways: fitView('contain'), and
   * simply zooming out — _updateMinZoom() still derives minZoom from the
   * contain zoom, so it always sits below it.
   *
   * @param {'cover'|'fill'|'contain'|'fit'|'whole'} [mode] omit to reuse the
   *   current mode, which is what an inset change or world switch wants.
   * @returns {number} the zoom actually applied
   */
  fitView(mode) {
    const m = normFrameMode(mode, this._frameMode);
    this._frameMode = m;
    const b = this._isoB;
    const iw = Math.max(1, b.maxX - b.minX);
    const ih = Math.max(1, b.maxY - b.minY);
    const v = this._viewRect();
    // minZoom is derived from the same rect; recompute it first so a fit issued
    // right after an inset change cannot clamp against a stale floor.
    this._updateMinZoom();
    const raw = m === 'cover'
      ? Math.max(v.w / iw, v.h / ih)
      : Math.min((v.w * FIT_MARGIN) / iw, (v.h * FIT_MARGIN) / ih);
    const z = clamp(raw, this.minZoom, this.maxZoom);
    this.camera.zoom = z;
    this.camera.panX = v.x + v.w / 2 - (b.minX + iw / 2) * z;
    this.camera.panY = v.y + v.h / 2 - (b.minY + ih / 2) * z;
    this._clampPan();
    this._camClean = true;
    return z;
  }

  /** @returns {'cover'|'contain'} the framing policy currently in effect */
  getFrameMode() {
    return this._frameMode;
  }

  /**
   * Flip between the filled view and the whole-diorama view, and re-frame.
   * This is what a "fit" button should call: one control, both framings, no
   * extra state in the caller.
   * @returns {'cover'|'contain'} the mode now in effect
   */
  toggleFrame() {
    this.fitView(this._frameMode === 'cover' ? 'contain' : 'cover');
    return this._frameMode;
  }

  /** Centre the view on a world-pixel point, keeping the current zoom. */
  centerOn(wx, wy) {
    const z = this.camera.zoom || 1;
    const p = worldToIso(wx, wy, 0);
    const v = this._viewRect();
    this.camera.panX = v.x + v.w / 2 - p.x * z;
    this.camera.panY = v.y + v.h / 2 - p.y * z;
    this._clampPan();
    this._camClean = false;
  }

  /**
   * Keep the diorama inside the inset rectangle (C2) — content parked under the
   * HUD or the build drawer is not reachable, so it must not count as visible.
   *
   * Two regimes, because one rule cannot serve both:
   *
   * - Content LARGER than the view on an axis (the normal case under the
   *   'cover' framing): a hard map clamp — the content's own edge may not come
   *   inside the view edge. Filling the screen is pointless if the very first
   *   drag can slide 60% backdrop into it, which is what the old flat 40% rule
   *   allowed.
   * - Content SMALLER than the view (zoomed right out, or a tiny starter
   *   casino): keep 40% of it on screen, so it can still be nudged around and
   *   can never be flicked away entirely.
   */
  _clampPan() {
    const b = this._isoB;
    const z = this.camera.zoom || 1;
    const cw = (b.maxX - b.minX) * z;
    const ch = (b.maxY - b.minY) * z;
    const v = this._viewRect();

    if (cw >= v.w) {
      // loX <= hiX is guaranteed by cw >= v.w, so no degenerate branch here.
      this.camera.panX = clamp(this.camera.panX, v.x + v.w - b.maxX * z, v.x - b.minX * z);
    } else {
      const keepX = cw * 0.4;
      const loX = v.x + keepX - b.maxX * z;
      const hiX = v.x + v.w - keepX - b.minX * z;
      this.camera.panX = loX > hiX
        ? v.x + (v.w - cw) / 2 - b.minX * z
        : clamp(this.camera.panX, loX, hiX);
    }

    if (ch >= v.h) {
      this.camera.panY = clamp(this.camera.panY, v.y + v.h - b.maxY * z, v.y - b.minY * z);
    } else {
      const keepY = ch * 0.4;
      const loY = v.y + keepY - b.maxY * z;
      const hiY = v.y + v.h - keepY - b.minY * z;
      this.camera.panY = loY > hiY
        ? v.y + (v.h - ch) / 2 - b.minY * z
        : clamp(this.camera.panY, loY, hiY);
    }
  }

  /* ---------------- popups ---------------- */

  /**
   * Spawn a floating text popup at WORLD coordinates.
   * @param {number} x world px @param {number} y world px
   * @param {string} text @param {string} [color]
   */
  popup(x, y, text, color) {
    const list = this._popups;
    if (list.length >= RCFG.maxPopups) list.splice(0, list.length - RCFG.maxPopups + 1);
    const wx = Number(x) || 0;
    const wy = Number(y) || 0;
    const str = String(text == null ? '' : text);
    // Box width, estimated from the character count rather than measured: the
    // draw context's font is not set outside the draw loop, and this has to be
    // the SAME number the draw pass reserves with, or the occupancy decision
    // made here would not match the box that actually lands on screen.
    const bw = Math.max(20, str.length * 8.4 + 8);
    list.push({
      x: wx,
      y: wy,
      text: str,
      bw,
      color: typeof color === 'string' && color ? color : '#9be27a',
      age: 0,
      life: RCFG.popupLife > 0 ? RCFG.popupLife : 1.1,
      dx: (Math.random() - 0.5) * 8,
      // Anti-collision offset, resolved ONCE here rather than per frame. Two
      // tables paying out on the same tick used to print their +$ on top of each
      // other (and on top of a dealer's nameplate) as one unreadable smear.
      // Re-resolving every frame instead would make a rising popup jitter as it
      // slid past the boxes it was testing against, so it is baked in at spawn:
      // the occupancy list still holds the previous frame's overlays, which is
      // one frame stale and entirely good enough.
      ...this._popupOffset(wx, wy, str)
    });
  }

  /**
   * Pick a spawn offset (CSS px) that keeps a new popup clear of the overlays
   * already on screen. Text width is estimated from the character count rather
   * than measured: the draw context's font is not set outside the draw loop,
   * and a few px of slack costs nothing for an occupancy test.
   * @returns {{ox:number, oy:number}}
   */
  _popupOffset(wx, wy, text) {
    const s = this.worldToScreen(wx, wy, 0);
    const w = Math.max(20, text.length * 8.4 + 8);
    const x0 = s.x - w / 2;
    const y0 = s.y - 16 - POPUP_STEP / 2;
    const slot = this._place(x0, y0, w, POPUP_STEP, MARK_GAP, POPUP_TRIES);
    if (!slot) return { ox: 0, oy: 0 };


    // BOUND THE DODGE.
    //
    // _place() will walk as far as it needs to find free space. On a busy floor
    // (90 guests, every table paying at once) that turned the payouts into a
    // ladder of "+9.28 / +9.10 / +9.14" marching up the right-hand edge of the
    // screen, each number hovering over no venue in particular — observed on the
    // device at Luxury Resort scale.
    //
    // A number that slightly overlaps its neighbour but sits over the table that
    // earned it is more useful than a tidy column that has lost its referent, so
    // past this radius we stop dodging and accept the overlap. The limits are
    // sized to the legitimate case — four tables settling on one income tick,
    // which needs three steps of stagger and may take a lane shift to get there.
    const dy = slot.y - y0;
    const dx = slot.x - x0;
    if (Math.abs(dy) > POPUP_STEP * 12 || Math.abs(dx) > w * 2) return { ox: 0, oy: 0 };
    // CLAIM the slot immediately. Everything that pays out on one sim tick —
    // the income tick settling four tables at once is the normal case — spawns
    // BEFORE the next frame resets the occupancy list. Testing without claiming
    // meant all of them read an identical list, chose the identical slot and
    // landed exactly on top of each other: the "+$ smear" this offset exists to
    // prevent, still there, just one frame later. (The early-out on an empty
    // list was part of the same bug — the first popup of a tick has to reserve
    // too, or the second one has nothing to dodge.)
    //
    // Nothing is leaked if draw() stops running: _reserve() is capped, and once
    // the list is full _place() simply fails and popups fall back to no offset,
    // which is exactly the pre-fix behaviour.
    this._reserve(slot.x, slot.y, w, POPUP_STEP);
    return { ox: slot.x - x0, oy: slot.y - y0 };
  }

  /** Drop every live popup (used on world switch). */
  clearPopups() {
    this._popups.length = 0;
  }

  /**
   * Force a full re-bake of the static ground plane and every venue sprite.
   * Call this if the layout object is mutated in place rather than rebuilt.
   */
  invalidate() {
    this._layout = null;
    this._layoutRef = null;
    this._bakeKey = '';
    this._slotCount = -1;
    this._dropSprites();
  }

  _dropSprites() {
    this._spriteCache.clear();
    const rects = this._rects;
    for (let i = 0; i < rects.length; i++) rects[i].spr = null;
  }

  /* ---------------- layout ingestion ---------------- */

  _syncLayout(layout, P, worldId) {
    const tile = Number(layout.tile) > 0 ? layout.tile : CONFIG.grid.tile;
    const cols = Math.max(1, Math.floor(Number(layout.cols) || CONFIG.grid.cols));
    const rows = Math.max(1, Math.floor(Number(layout.rows) || CONFIG.grid.rows));

    this.worldW = cols * tile;
    this.worldH = rows * tile;
    this.tile = tile;
    this.cols = cols;
    this.rows = rows;

    const slots = Array.isArray(layout.slots) ? layout.slots : [];

    // Detect whether slot rects are expressed in grid cells (per contract) or pixels.
    let pixelUnits = false;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s) continue;
      if (Number(s.w) >= tile || Number(s.x) > cols || Number(s.y) > rows) {
        pixelUnits = true;
        break;
      }
    }
    this._pixelUnits = pixelUnits;
    const k = pixelUnits ? 1 : tile;

    const rects = this._rects;
    rects.length = 0;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s) continue;
      const key = typeof s.key === 'string' ? s.key : '';
      const kind = s.kind === 'station' ? 'station' : 'venue';
      const def = kind === 'station' ? STATIONS[key] : VENUES[key];
      const fw = def && def.footprint ? def.footprint.w : 1;
      const fh = def && def.footprint ? def.footprint.h : 1;
      const w = (Number(s.w) > 0 ? Number(s.w) : fw) * k;
      const h = (Number(s.h) > 0 ? Number(s.h) : fh) * k;
      const x = (Number(s.x) || 0) * k;
      const y = (Number(s.y) || 0) * k;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const icx = LX(cx, cy);
      const icy = LY(cx, cy, 0);

      // Precompute the iso-space bounding box this venue's baked sprite (plus
      // its animated overlay, which draws relative to the same origin) can
      // occupy, so draw() can cull it without ever creating its offscreen
      // sprite canvas. Mirrors the bounding math in _spriteFor exactly, plus
      // a flat safety margin for animated overlays that may reach slightly
      // beyond the static sprite bounds (glows, particle bursts, etc).
      const hw = w / 2;
      const hh = h / 2;
      const objH = VEN_H[key] || 42;
      const cHx = (hw + hh) * ISO.kx;
      const cHy = (hw + hh) * ISO.ky;
      const cPadS = tile * 0.95;
      const cPadT = tile * 0.6;
      const cPadB = tile * 0.8;
      const cullMargin = 60;

      rects.push({
        key,
        kind,
        index: Number.isFinite(s.index) ? s.index : i,
        x,
        y,
        w,
        h,
        hw,
        hh,
        cx,
        cy,
        icx,
        icy,
        depth: cx + cy,
        spr: null,
        sprBucket: -1,
        cullMinX: icx - cHx - cPadS - cullMargin,
        cullMaxX: icx + cHx + cPadS + cullMargin,
        cullMinY: icy - cHy - objH * ISO.kz - cPadT - cullMargin,
        cullMaxY: icy + cHy + cPadB + cullMargin,
        seed: (i * 37 + key.length * 11 + (Number(s.index) || 0) * 5) | 0
      });
    }

    // queue nodes (world px)
    const nodes = this._nodes;
    nodes.length = 0;
    if (typeof layout.nodeFor === 'function') {
      for (let i = 0; i < rects.length; i++) {
        const r2 = rects[i];
        let n = null;
        try {
          n = layout.nodeFor(r2.kind, r2.key, r2.index);
        } catch (err) {
          n = null;
        }
        if (n && Number.isFinite(n.x) && Number.isFinite(n.y)) nodes.push({ x: n.x, y: n.y });
      }
    }

    // entrance / exit in world px
    const cellish = (p) => {
      if (!p || typeof p !== 'object') return null;
      const px = Number(p.x) || 0;
      const py = Number(p.y) || 0;
      const asPixels = px > cols || py > rows;
      return asPixels ? { x: px, y: py } : { x: px * tile + tile / 2, y: py * tile + tile / 2 };
    };
    this._entrance = cellish(layout.entrance);
    this._exit = cellish(layout.exit);

    // decorative fixtures — deterministic per world + tier
    const decor = this._decor;
    decor.length = 0;
    const nCh = P.chandeliers;
    for (let i = 0; i < nCh; i++) {
      const gx = (0.5 + i) / nCh;
      const gy = 0.32 + (i % 2) * 0.34;
      decor.push({
        type: 'lamp',
        x: this.worldW * clamp(gx, 0.12, 0.88),
        y: this.worldH * clamp(gy, 0.14, 0.84),
        r: tile * (P.tierIdx === 2 ? 0.5 : 0.38),
        z: 150,
        seed: i * 13 + worldId * 7
      });
    }
    const nNeon = P.tierIdx === 0 ? 3 : P.tierIdx === 1 ? 3 : 4;
    for (let i = 0; i < nNeon; i++) {
      decor.push({
        type: 'neon',
        x: this.worldW * (0.18 + (i / Math.max(1, nNeon - 1 || 1)) * 0.62),
        y: tile,
        w: tile * 2.1,
        h: tile * 0.5,
        z: WALL_H * 0.62,
        seed: i * 29 + worldId * 3
      });
    }

    this._isoBounds();
    this._layout = layout;
  }

  /** Iso-space bounding box of the entire diorama (slab skirt + back walls included). */
  _isoBounds() {
    const W = this.worldW;
    const H = this.worldH;
    const pad = this.tile * 0.8;
    const b = this._isoB;
    b.minX = LX(0, H) - pad;
    b.maxX = LX(W, 0) + pad;
    b.minY = LY(0, 0, WALL_H + 26) - pad;
    b.maxY = LY(W, H, 0) + SLAB_H * ISO.kz + pad;
    this._updateMinZoom();
    return b;
  }

  /* ---------------- ground-plane bake (iso space) ---------------- */

  _ensureBake(layout, P, worldDef, now) {
    const b = this._isoB;
    const iw = Math.max(1, b.maxX - b.minX);
    const ih = Math.max(1, b.maxY - b.minY);

    // Quantise to half steps so a pinch-zoom crosses at most a handful of buckets.
    let bucket = clamp(Math.round(this.dpr * this.camera.zoom * 2) / 2, 0.5, 3);
    while (bucket > 0.5 && iw * ih * bucket * bucket > BAKE_MAX_PIXELS) bucket -= 0.5;

    const key =
      (worldDef && worldDef.key ? worldDef.key : 'w') +
      '|' + P.tierIdx +
      '|' + this.cols + 'x' + this.rows +
      '|' + this._rects.length +
      '|' + bucket.toFixed(2);

    if (this._bake && this._bakeKey === key && this._layoutRef === layout) return;

    // A resolution-only change can wait; a layout change cannot.
    const structural = !this._bake || this._bakeKey === '' || this._layoutRef !== layout;
    if (!structural && now - this._bakeAt < BAKE_COOLDOWN_MS) return;

    this._layoutRef = layout;
    this._bakeKey = key;
    this._bakeAt = now;
    this._bucket = bucket;
    // Only a genuine structural change (new/changed layout) needs every venue
    // sprite thrown away. A resolution-only bucket change (zoom) must NOT
    // blanket-clear the cache: _spriteFor is keyed on `_bucket` and tracks
    // each rect's own `sprBucket`, so it already re-bakes lazily, and only
    // for rects actually requested this frame (i.e. only visible ones, once
    // draw() culls the rest) — not every venue in the layout.
    if (structural) this._dropSprites();

    const bw = Math.max(1, Math.round(iw * bucket));
    const bh = Math.max(1, Math.round(ih * bucket));

    if (!this._bake) {
      this._bake =
        typeof document !== 'undefined' && document.createElement
          ? document.createElement('canvas')
          : null;
      if (!this._bake) return;
    }
    this._bake.width = bw;
    this._bake.height = bh;
    const g = this._bake.getContext('2d');
    if (!g) return;

    g.setTransform(bucket, 0, 0, bucket, -b.minX * bucket, -b.minY * bucket);
    g.clearRect(b.minX, b.minY, iw, ih);
    g.lineJoin = 'round';
    g.lineCap = 'round';

    this._bakeSlab(g, P);
    this._bakeFloor(g, P);
    this._bakeWalls(g, layout, P);
    this._bakeLightPools(g, P);
    this._bakeQueuePads(g, P);
    this._bakeDoors(g, P);
  }

  /**
   * The raised platform: two visible skirt faces + a thick rim outline.
   * Fill = palette.skirt (P.skirt), stroke = palette.outline (P.outline);
   * both already fell back to a derived color inside paletteFor().
   */
  _bakeSlab(g, P) {
    const W = this.worldW;
    const H = this.worldH;
    const dz = SLAB_H * ISO.kz;
    const S = faces(P.skirt || P.slab, P.outline);
    const OL = P.outline || S.o;

    // south-facing skirt (+wy edge)
    let ax = LX(0, H);
    let ay = LY(0, H, 0);
    let bx = LX(W, H);
    let by = LY(W, H, 0);
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.lineTo(bx, by + dz);
    g.lineTo(ax, ay + dz);
    g.closePath();
    g.fillStyle = S.l;
    g.fill();
    g.lineWidth = LW;
    g.strokeStyle = OL;
    g.stroke();

    // east-facing skirt (+wx edge)
    ax = LX(W, H);
    ay = LY(W, H, 0);
    bx = LX(W, 0);
    by = LY(W, 0, 0);
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.lineTo(bx, by + dz);
    g.lineTo(ax, ay + dz);
    g.closePath();
    g.fillStyle = P.slabDark || shade(P.skirt || P.slab, -0.22);
    g.fill();
    g.stroke();
  }

  _bakeFloor(g, P) {
    const tile = this.tile;
    const cols = this.cols;
    const rows = this.rows;
    const hw = tile / 2;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const wx = x * tile + hw;
        const wy = y * tile + hw;
        const border = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
        isoDiamond(g, LX(wx, wy), LY(wx, wy, 0), hw, hw);
        g.fillStyle = border ? P.floorEdge : (x + y) % 2 === 0 ? P.floorA : P.floorB;
        g.fill();
      }
    }

    // grid seams along both world axes
    const W = this.worldW;
    const H = this.worldH;
    g.lineWidth = 0.9;
    g.strokeStyle = rgba(P.floorLine, 0.5);
    g.beginPath();
    for (let x = 0; x <= cols; x++) {
      const wx = x * tile;
      g.moveTo(LX(wx, 0), LY(wx, 0, 0));
      g.lineTo(LX(wx, H), LY(wx, H, 0));
    }
    for (let y = 0; y <= rows; y++) {
      const wy = y * tile;
      g.moveTo(LX(0, wy), LY(0, wy, 0));
      g.lineTo(LX(W, wy), LY(W, wy, 0));
    }
    g.stroke();

    // thick rim around the whole slab top — palette.outline is the ink here
    isoDiamond(g, LX(W / 2, H / 2), LY(W / 2, H / 2, 0), W / 2, H / 2);
    g.lineWidth = LW * 1.4;
    g.strokeStyle = P.outline || ink(P.slab);
    g.stroke();
  }

  /** Low chunky walls along the two BACK edges only (wy = 0 and wx = 0). */
  _bakeWalls(g, layout, P) {
    const tile = this.tile;
    const W = this.worldW;
    const H = this.worldH;
    const F = faces(P.wall, P.outline);
    const OL = P.outline || F.o;
    const t = tile / 2;

    // north wall strip: world y in [0, tile], full width
    prism(g, LX(W / 2, t), LY(W / 2, t, 0), W / 2, t, WALL_H, P.wallTop, F.l, F.r, OL, LW * 1.2);
    // west wall strip: world x in [0, tile], full height (skip the shared corner)
    prism(g, LX(t, (H + tile) / 2), LY(t, (H + tile) / 2, 0), t, (H - tile) / 2, WALL_H,
      P.wallTop, shade(P.wallSide, 0.05), P.wallSide, OL, LW * 1.2);

    // Baseboard trim along the inner faces. At high tiers gold wins; otherwise
    // this is the world's signature three-face box (palette.faceTop/Left/Right).
    const G = P.goldAmt > 0.2 ? faces(P.gold, P.outline) : (P.accentFaces || faces(P.accent, P.outline));
    prism(g, LX(W / 2, tile), LY(W / 2, tile, WALL_H * 0.86), W / 2, 1.2, 3.5, G.t, G.l, G.r, G.o, LW_THIN);
    prism(g, LX(tile, (H + tile) / 2), LY(tile, (H + tile) / 2, WALL_H * 0.86), 1.2, (H - tile) / 2, 3.5,
      G.t, G.l, G.r, G.o, LW_THIN);

    // neon signs mounted on the north wall's inner face
    const decor = this._decor;
    for (let i = 0; i < decor.length; i++) {
      const d = decor[i];
      if (d.type !== 'neon') continue;
      const x0 = d.x - d.w / 2;
      const x1 = d.x + d.w / 2;
      const z0 = d.z - d.h / 2;
      const z1 = d.z + d.h / 2;
      g.beginPath();
      g.moveTo(LX(x0, tile), LY(x0, tile, z1));
      g.lineTo(LX(x1, tile), LY(x1, tile, z1));
      g.lineTo(LX(x1, tile), LY(x1, tile, z0));
      g.lineTo(LX(x0, tile), LY(x0, tile, z0));
      g.closePath();
      g.fillStyle = shade(P.neon, -0.55);
      g.fill();
      g.lineWidth = LW;
      g.strokeStyle = ink(P.neon);
      g.stroke();
    }
    void layout;
  }

  /** Warm pools of light on the floor under the hanging lamps. */
  _bakeLightPools(g, P) {
    const decor = this._decor;
    for (let i = 0; i < decor.length; i++) {
      const d = decor[i];
      if (d.type !== 'lamp') continue;
      const cx = LX(d.x, d.y);
      const cy = LY(d.x, d.y, 0);
      const rad = d.r * 7;
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
      gr.addColorStop(0, rgba(P.tierIdx === 2 ? P.gold : '#fff2c2', 0.3));
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.save();
      g.translate(cx, cy);
      g.scale(1, 0.5);
      g.translate(-cx, -cy);
      g.fillStyle = gr;
      g.beginPath();
      g.arc(cx, cy, rad, 0, TAU);
      g.fill();
      g.restore();
    }
  }

  _bakeQueuePads(g, P) {
    const nodes = this._nodes;
    if (nodes.length === 0) return;
    const tile = this.tile;
    const dot = Math.max(1.5, RCFG.queueDotRadius);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      isoDisc(g, LX(n.x, n.y), LY(n.x, n.y, 0.4), tile * 0.36);
      g.fillStyle = rgba(P.accent, 0.3);
      g.fill();
      g.lineWidth = LW_THIN;
      g.strokeStyle = rgba(ink(P.accent), 0.55);
      g.stroke();
      for (let k = 1; k <= 3; k++) {
        const qy = n.y + tile * 0.62 * k;
        isoDisc(g, LX(n.x, qy), LY(n.x, qy, 0.4), dot);
        g.fillStyle = rgba(P.accent, 0.34 - k * 0.07);
        g.fill();
      }
    }
  }

  _bakeDoors(g, P) {
    const tile = this.tile;
    const draw = (p, isIn) => {
      if (!p) return;
      const col = isIn ? '#4fd07a' : '#ff6a5a';
      const F = faces(col, P.outline);
      isoDiamond(g, LX(p.x, p.y), LY(p.x, p.y, 0.6), tile * 0.85, tile * 0.5);
      g.fillStyle = F.l;
      g.fill();
      g.lineWidth = LW * 1.2;
      g.strokeStyle = F.o;
      g.stroke();

      // glow carpet
      const cx = LX(p.x, p.y);
      const cy = LY(p.x, p.y, 0);
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, tile * 2.4);
      gr.addColorStop(0, rgba(isIn ? P.neon : '#ff8a6a', 0.3));
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.save();
      g.translate(cx, cy);
      g.scale(1, 0.5);
      g.translate(-cx, -cy);
      g.fillStyle = gr;
      g.beginPath();
      g.arc(cx, cy, tile * 2.4, 0, TAU);
      g.fill();
      g.restore();

      // arrows pointing in / out along +wy
      g.lineWidth = LW * 1.3;
      g.lineCap = 'round';
      g.strokeStyle = rgba('#ffffff', 0.85);
      for (let i = 0; i < 2; i++) {
        const off = -tile * 0.18 + i * tile * 0.34;
        const dy = isIn ? -1 : 1;
        g.beginPath();
        g.moveTo(LX(p.x - tile * 0.24, p.y + off), LY(p.x - tile * 0.24, p.y + off, 1));
        g.lineTo(LX(p.x, p.y + off + dy * tile * 0.22), LY(p.x, p.y + off + dy * tile * 0.22, 1));
        g.lineTo(LX(p.x + tile * 0.24, p.y + off), LY(p.x + tile * 0.24, p.y + off, 1));
        g.stroke();
      }
    };
    draw(this._entrance, true);
    draw(this._exit, false);
  }

  /* ---------------- venue sprite bake ---------------- */

  /**
   * Bake (or fetch) the chunky iso sprite for one venue footprint, at the
   * current resolution bucket. Keyed (including the bucket) so a zoom-driven
   * resolution change only re-bakes sprites that are actually requested this
   * frame — i.e. only visible venues, once draw() culls the rest — instead of
   * requiring a blanket cache drop that forces every venue in the layout to
   * re-bake, on screen or not.
   */
  _spriteFor(r, P) {
    if (r.spr && r.sprBucket === this._bucket) return r.spr;
    const ck = r.key + '|' + r.w + '|' + r.h + '|' + this._bucket;
    let s = this._spriteCache.get(ck);
    if (s) {
      r.spr = s;
      r.sprBucket = this._bucket;
      return s;
    }
    if (typeof document === 'undefined' || !document.createElement) return null;

    const fn = BAKE_SPRITE[r.key];
    const hw = r.hw;
    const hh = r.hh;
    const objH = VEN_H[r.key] || 42;
    const Hx = (hw + hh) * ISO.kx;
    const Hy = (hw + hh) * ISO.ky;
    const padS = this.tile * 0.95;
    const padT = this.tile * 0.6;
    const padB = this.tile * 0.8;
    const left = -Hx - padS;
    const right = Hx + padS;
    const top = -Hy - objH * ISO.kz - padT;
    const bot = Hy + padB;
    const res = this._bucket;

    const cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.ceil((right - left) * res));
    cv.height = Math.max(2, Math.ceil((bot - top) * res));
    const sg = cv.getContext('2d');
    if (!sg) return null;
    sg.setTransform(res, 0, 0, res, -left * res, -top * res);
    sg.lineJoin = 'round';
    sg.lineCap = 'round';
    if (fn) {
      try {
        fn(sg, hw, hh, P, r.seed);
      } catch (err) {
        /* a broken sprite must never kill the frame */
      }
    } else {
      const F = faces(P.metal, P.outline);
      prism(sg, 0, 0, hw * 0.8, hh * 0.8, 26, F.t, F.l, F.r, F.o, LW);
    }

    s = { c: cv, ox: left, oy: top, w: right - left, h: bot - top };
    this._spriteCache.set(ck, s);
    r.spr = s;
    r.sprBucket = this._bucket;
    return s;
  }

  /* ---------------- z-buffer ---------------- */

  _zAdd(kind, o, ix, iy, d) {
    const pool = this._zPool;
    const n = this._z.length;
    let e = pool[n];
    if (!e) {
      e = { kind: 0, o: null, ix: 0, iy: 0, d: 0 };
      pool[n] = e;
    }
    e.kind = kind;
    e.o = o;
    e.ix = ix;
    e.iy = iy;
    e.d = d;
    this._z.push(e);
  }

  /* ---------------- main draw ---------------- */

  /**
   * @param {{worldState:object, worldDef:object, layout:object,
   *          guests:Array, workers:Array, actors:Array, tier:number}} ctx3
   */
  draw(ctx3) {
    const g = this.ctx;
    if (!g) return;

    // auto-resize if the CSS box or the device pixel ratio changed underneath us.
    // curDpr must include _renderScale, or the adaptive scaler below would look
    // like a dpr change to this check and re-resize the backing store every frame.
    const c = this.canvas;
    const curDpr = clamp(
      (typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1) *
        (this._renderScale || 1),
      0.6,
      2
    );
    if (
      c &&
      c.clientWidth > 0 &&
      (Math.abs(c.clientWidth - this.cssW) > 1 ||
        Math.abs(c.clientHeight - this.cssH) > 1 ||
        curDpr !== this.dpr)
    ) {
      this.resize();
    }

    const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    let dt = this._last ? (now - this._last) / 1000 : 0;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this._last = now;

    this._tuneRenderScale(dt);
    this.t += dt;
    const t = this.t;

    const ctxIn = ctx3 || {};
    const worldDef = ctxIn.worldDef || {};
    const worldState = ctxIn.worldState || null;
    const layout = ctxIn.layout || null;
    const guests = Array.isArray(ctxIn.guests) ? ctxIn.guests : [];
    const workers = Array.isArray(ctxIn.workers) ? ctxIn.workers : [];
    const actors = Array.isArray(ctxIn.actors) ? ctxIn.actors : [];

    let tierNum = Number(ctxIn.tier);
    if (!Number.isFinite(tierNum) || tierNum < 1) {
      tierNum = worldState && Number.isFinite(worldState.tier) ? worldState.tier : 1;
    }
    const tierIdx = clamp(Math.floor(tierNum) - 1, 0, 2);
    const P = paletteFor(worldDef, tierIdx);

    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._drawBackdrop(g, P, worldDef, tierIdx);

    if (!layout) {
      this._drawNoLayout(g);
      return;
    }

    const slotCount = Array.isArray(layout.slots) ? layout.slots.length : 0;
    if (
      this._layout !== layout ||
      this._decorTier !== tierIdx ||
      this._decorWorld !== worldDef.key ||
      this._slotCount !== slotCount
    ) {
      this._syncLayout(layout, P, Number(worldDef.id) || 0);
      this._slotCount = slotCount;
      this._bakeKey = '';
      this._dropSprites();
      if (this._fitWorld !== worldDef.key) {
        this._fitWorld = worldDef.key;
        this._fitPending = true;
      }
    }
    this._decorTier = tierIdx;
    this._decorWorld = worldDef.key;

    if (this._fitPending) {
      this._fitPending = false;
      this.fitView();
    }

    this._ensureBake(layout, P, worldDef, now);

    const cam = this.camera;
    const z = cam.zoom || 1;

    g.save();
    g.setTransform(this.dpr * z, 0, 0, this.dpr * z, this.dpr * cam.panX, this.dpr * cam.panY);
    g.lineJoin = 'round';
    g.lineCap = 'round';

    // 1. baked ground plane
    const b = this._isoB;
    if (this._bake && this._bake.width > 0) {
      g.drawImage(this._bake, b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    }

    // 2. depth-sorted drawables: venues + staff + guests + actors, by (wx + wy)
    //    Frustum-culled against the visible iso viewport first — at higher
    //    zoom most of the fixed-size world sits off-screen and must not be
    //    z-sorted/drawn/re-baked every frame just because it exists.
    const zb = this._z;
    zb.length = 0;

    // Chrome-aware: see _visibleIsoInset(). Figures are 91% of all draw calls,
    // so not drawing the ones hidden behind the HUD and the opaque build sheet
    // is the single largest saving available without changing a single pixel.
    const vis = this._visibleIsoInset();
    // Chibi figures top out around u=10.6 (VIP/actor): head + highlight ring
    // reach roughly 30-40 iso px up from the ground anchor, a patience bar a
    // little further; generous margins here just mean a few extra px of
    // slack, never a visible pop-in.
    const CX = 70;
    const CUP = 90;
    const CDN = 40;
    const visMinX = vis.minX - CX;
    const visMaxX = vis.maxX + CX;
    const visMinY = vis.minY - CUP;
    const visMaxY = vis.maxY + CDN;

    const rects = this._rects;
    for (let i = 0; i < rects.length; i++) {
      const r2 = rects[i];
      if (r2.cullMaxX < vis.minX || r2.cullMinX > vis.maxX || r2.cullMaxY < vis.minY || r2.cullMinY > vis.maxY) {
        continue;
      }
      this._zAdd(0, r2, r2.icx, r2.icy, r2.depth);
    }
    for (let i = 0; i < workers.length; i++) {
      const o = workers[i];
      if (!o) continue;
      const wx = Number(o.x) || 0;
      const wy = Number(o.y) || 0;
      const ix = LX(wx, wy);
      const iy = LY(wx, wy, 0);
      if (ix < visMinX || ix > visMaxX || iy < visMinY || iy > visMaxY) continue;
      this._zAdd(2, o, ix, iy, wx + wy + 0.4);
    }
    for (let i = 0; i < guests.length; i++) {
      const o = guests[i];
      if (!o) continue;
      const wx = Number(o.x) || 0;
      const wy = Number(o.y) || 0;
      const ix = LX(wx, wy);
      const iy = LY(wx, wy, 0);
      if (ix < visMinX || ix > visMaxX || iy < visMinY || iy > visMaxY) continue;
      this._zAdd(1, o, ix, iy, wx + wy + 0.4);
    }
    for (let i = 0; i < actors.length; i++) {
      const o = actors[i];
      if (!o) continue;
      const wx = Number(o.x) || 0;
      const wy = Number(o.y) || 0;
      const ix = LX(wx, wy);
      const iy = LY(wx, wy, 0);
      if (ix < visMinX || ix > visMaxX || iy < visMinY || iy > visMaxY) continue;
      this._zAdd(3, o, ix, iy, wx + wy + 0.8);
    }

    zb.sort(byDepth);

    for (let i = 0; i < zb.length; i++) {
      const e = zb[i];
      if (e.kind === 0) this._drawVenue(g, e.o, P, t);
      else if (e.kind === 1) this._drawGuest(g, e.o, e.ix, e.iy, P, t);
      else if (e.kind === 2) this._drawWorker(g, e.o, e.ix, e.iy, P, t);
      else this._drawActor(g, e.o, e.ix, e.iy, P, t);
    }

    // release sim references so dead guests are not pinned by the z-buffer pool
    for (let i = 0; i < zb.length; i++) zb[i].o = null;

    // 3. hanging lamps float above everything
    this._drawLamps(g, P, t);

    g.restore();

    // 4. screen-space overlays: role markers + actor labels + money popups
    //    (never zoom-scaled — that is the whole point, see _drawRoleMarkers)
    //
    //    All three share one occupancy list, reset here rather than inside any
    //    one of them: whoever draws first must not own a resource the other two
    //    depend on. Order matters — markers claim their slots first (identity
    //    beats decoration), then actor labels, then popups.
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._markRects.length = 0;
    this._drawRoleMarkers(g, guests, workers, t);
    this._drawActorLabels(g, actors);
    this._drawPopups(g, dt);

    // 5. atmosphere
    this._drawAtmosphere(g, P, t);
  }

  /* ---------------- backdrop / atmosphere ---------------- */

  _drawBackdrop(g, P, worldDef, tierIdx) {
    const key = this.cssW + 'x' + this.cssH + '|' + tierIdx + '|' + (worldDef && worldDef.key ? worldDef.key : 'w');
    if (!this._bg || this._bgKey !== key) {
      const grad = g.createLinearGradient(0, 0, 0, this.cssH);
      grad.addColorStop(0, P.bgTop);
      grad.addColorStop(1, P.bgBot);
      this._bg = grad;
      this._bgKey = key;
    }
    g.fillStyle = this._bg;
    g.fillRect(0, 0, this.cssW, this.cssH);
  }

  _drawNoLayout(g) {
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = '700 18px ' + FONT_STACK;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.direction = dir();
    g.fillText(this._t('app.loading'), this.cssW / 2, this.cssH / 2);
    g.direction = 'ltr';
    g.textAlign = 'start';
    g.textBaseline = 'alphabetic';
  }

  _drawAtmosphere(g, P, t) {
    const W = this.cssW;
    const H = this.cssH;

    // tier-1 buzzing fluorescent flicker — a neon-tinted flash instead of a
    // full-frame dark overlay, which re-darkened the whole bright cartoon
    // scene on every flicker tick.
    if (P.flicker > 0 && rnd(Math.floor(t * 11), 701) < P.flicker * 0.16) {
      g.fillStyle = rgba(P.neon, 0.06);
      g.fillRect(0, 0, W, H);
    }

    // A dark-purple corner vignette was the single strongest "dark top-down
    // game with a skew applied" tell (~15% dark overlay at the corners).
    // Replaced with a subtle warm bloom toward the centre that never darkens
    // the frame, matching the bright, vignette-free target look.
    const key = W + 'x' + H;
    if (!this._vig || this._vigKey !== key) {
      const r0 = Math.min(W, H) * 0.1;
      const r1 = Math.max(W, H) * 0.75;
      const grad = g.createRadialGradient(W / 2, H * 0.42, r0, W / 2, H * 0.5, r1);
      grad.addColorStop(0, 'rgba(255,250,235,0.12)');
      grad.addColorStop(1, 'rgba(255,250,235,0)');
      this._vig = grad;
      this._vigKey = key;
    }
    g.fillStyle = this._vig;
    g.fillRect(0, 0, W, H);
  }

  /* ---------------- venues ---------------- */

  _drawVenue(g, r, P, t) {
    const spr = this._spriteFor(r, P);
    if (spr) g.drawImage(spr.c, r.icx + spr.ox, r.icy + spr.oy, spr.w, spr.h);
    const fn = ANIM_SPRITE[r.key];
    if (!fn) return;
    g.save();
    g.translate(r.icx, r.icy);
    fn(g, r.hw, r.hh, P, t, r.seed);
    g.restore();
  }

  /* ---------------- hanging lamps ---------------- */

  _drawLamps(g, P, t) {
    const decor = this._decor;
    for (let i = 0; i < decor.length; i++) {
      const d = decor[i];
      if (d.type === 'lamp') {
        const cx = LX(d.x, d.y);
        const cy = LY(d.x, d.y, d.z);
        const pulse = 0.86 + 0.14 * Math.sin(t * 1.3 + d.seed);
        // cord
        g.lineWidth = LW_THIN;
        g.strokeStyle = 'rgba(30,20,45,0.5)';
        g.beginPath();
        g.moveTo(cx, cy - d.r * 3.2);
        g.lineTo(cx, cy - d.r * 0.6);
        g.stroke();
        // shade
        const F = faces(P.goldAmt > 0.2 ? P.gold : P.metal, P.outline);
        g.beginPath();
        g.moveTo(cx - d.r, cy);
        g.lineTo(cx - d.r * 0.34, cy - d.r * 0.95);
        g.lineTo(cx + d.r * 0.34, cy - d.r * 0.95);
        g.lineTo(cx + d.r, cy);
        g.closePath();
        g.fillStyle = F.l;
        g.fill();
        g.lineWidth = LW;
        g.strokeStyle = F.o;
        g.stroke();
        // bulb
        g.beginPath();
        g.arc(cx, cy + d.r * 0.16, d.r * 0.34, 0, TAU);
        g.fillStyle = rgba('#fff6d8', pulse);
        g.fill();
      } else if (d.type === 'neon') {
        let on = 1;
        if (P.flicker > 0) {
          const f = rnd(Math.floor(t * 14) + d.seed, 601);
          on = f < P.flicker * 0.5 ? 0.2 + rnd(Math.floor(t * 23) + d.seed, 611) * 0.4 : 1;
        } else {
          on = 0.75 + 0.25 * Math.abs(Math.sin(t * 1.6 + d.seed));
        }
        const tile = this.tile;
        const x0 = d.x - d.w * 0.42;
        const x1 = d.x + d.w * 0.42;
        const z0 = d.z - d.h * 0.3;
        const z1 = d.z + d.h * 0.3;
        g.beginPath();
        g.moveTo(LX(x0, tile), LY(x0, tile, z1));
        g.lineTo(LX(x1, tile), LY(x1, tile, z1));
        g.lineTo(LX(x1, tile), LY(x1, tile, z0));
        g.lineTo(LX(x0, tile), LY(x0, tile, z0));
        g.closePath();
        g.fillStyle = rgba(P.neon, 0.35 + 0.55 * on);
        g.fill();
      }
    }
  }

  /* ---------------- figures ---------------- */

  _drawGuest(g, o, ix, iy, P, t) {
    const vip = o.vip === true;
    const seedN = idSeed(o.id);
    const u = vip ? U_VIP : U_GUEST;

    const tx = Number(o.tx);
    const ty = Number(o.ty);
    let moving = false;
    if (Number.isFinite(tx) && Number.isFinite(ty)) {
      const ddx = tx - (Number(o.x) || 0);
      const ddy = ty - (Number(o.y) || 0);
      moving = ddx * ddx + ddy * ddy > 6;
    }
    const bob = moving ? -Math.abs(Math.sin(t * 9 + seedN)) * u * 0.2 : Math.sin(t * 1.8 + seedN) * u * 0.04;

    const color = typeof o.color === 'string' && o.color ? o.color : '#e8a55f';
    let S;
    if (vip) {
      S = _vipStyleFor(color);
    } else {
      S = guestStyle(color, seedN);
    }
    chibiFigure(g, ix, iy, u, S, bob, t, seedN, moving, P.shadow, P.outline);

    // guests.js flips `angry` when patience runs out and the guest walks out on
    // you — the single most expensive guest state, and the renderer never read
    // the flag at all. Steam puffs (same idiom as the live-event angry actor)
    // plus the screen-space '!' marker make a walkout visible before it happens.
    if (o.angry === true) {
      const by = iy + bob;
      g.fillStyle = 'rgba(255,120,100,0.62)';
      for (let i = 0; i < 2; i++) {
        const px = ix + (i === 0 ? -u * 0.72 : u * 0.72);
        const py = by - u * 2.85 - Math.abs(Math.sin(t * 4 + i + seedN)) * u * 0.35;
        g.beginPath();
        g.arc(px, py, u * 0.22, 0, TAU);
        g.fill();
      }
    }

    // patience bar for anyone queueing or getting fed up
    const patience = Number(o.patience);
    const st = typeof o.state === 'string' ? o.state : '';
    const waiting = WAITING_STATES[st] === 1;
    if (Number.isFinite(patience) && (waiting || patience < CONFIG.guest.lowPatience)) {
      const frac = clamp(patience / (CONFIG.guest.patienceMax || 100), 0, 1);
      const bw = u * 1.7;
      const bh = Math.max(1.8, u * 0.26);
      const bx = ix - bw / 2;
      const by = iy + bob - u * 3.45;
      rr(g, bx - 1, by - 1, bw + 2, bh + 2, bh * 0.8);
      g.fillStyle = 'rgba(28,18,44,0.8)';
      g.fill();
      rr(g, bx, by, bw * frac, bh, bh * 0.5);
      g.fillStyle = frac > 0.5 ? '#5ce07a' : frac > 0.22 ? '#ffc43d' : '#ff5a4a';
      g.fill();
    }

    if (waiting) {
      g.beginPath();
      g.moveTo(ix - u * 0.5, iy + u * 0.46);
      g.lineTo(ix, iy + u * 0.74);
      g.lineTo(ix + u * 0.5, iy + u * 0.46);
      g.closePath();
      g.fillStyle = rgba(P.accent, 0.5);
      g.fill();
    }
  }

  _drawWorker(g, o, ix, iy, P, t) {
    const role = o.role === 'guard' ? 'guard' : o.role === 'cleaner' ? 'cleaner' : 'dealer';
    const S = ROLE_STYLE[role];
    const seedN = idSeed(o.id);
    const st = typeof o.state === 'string' ? o.state : '';
    const moving = st === 'walking' || st === 'patrol' || st === 'responding';
    const responding = st === 'responding';
    const u = U_WORKER;
    const bob = moving ? -Math.abs(Math.sin(t * 9 + seedN)) * u * 0.2 : Math.sin(t * 2.2 + seedN) * u * 0.04;
    const pulse = 0.5 + 0.5 * Math.sin(t * (RCFG.highlightPulse || 2.2));

    // Role-coloured floor tint. At the phone's fit zoom this disc is wider than
    // the whole figure, so it is the first thing that reads as "staff, not
    // guest" — the sprite itself is only ~11 CSS px tall there. A guard on its
    // way to an incident gets the same pulsing red treatment live-event actors
    // use, because "the guard is responding" was previously invisible: every
    // staff state collapsed into one walk-bob boolean.
    const mk = MARK[role];
    isoDisc(g, ix, iy, u * (responding ? 1.7 + pulse * 0.3 : 1.45));
    g.fillStyle = rgba(responding ? '#ff3b30' : mk.col, responding ? 0.2 + pulse * 0.2 : 0.15);
    g.fill();
    if (responding) {
      g.lineWidth = 2 + pulse * 1.6;
      g.strokeStyle = rgba('#ff3b30', 0.55 + pulse * 0.35);
      g.stroke();
    }

    // Footstep puffs trailing the direction of travel — a second motion cue that
    // survives when the figure is too small for the stride itself to register.
    if (moving) {
      const dxw = Number(o.tx) - (Number(o.x) || 0);
      const dyw = Number(o.ty) - (Number(o.y) || 0);
      if (Number.isFinite(dxw) && Number.isFinite(dyw)) {
        let dix = LX(dxw, dyw);
        let diy = LY(dxw, dyw, 0);
        const len = Math.sqrt(dix * dix + diy * diy);
        if (len > 0.001) {
          dix /= len;
          diy /= len;
          for (let i = 0; i < 2; i++) {
            const ph = ((t * 2.4 + seedN + i * 0.5) % 1 + 1) % 1;
            const back = u * (0.35 + ph * 1.35);
            ellipse(g, ix - dix * back, iy - diy * back, u * (0.2 + ph * 0.4), u * (0.1 + ph * 0.2));
            g.fillStyle = rgba('#ffffff', 0.26 * (1 - ph));
            g.fill();
          }
        }
      }
    }

    chibiFigure(g, ix, iy, u, S, bob, t, seedN, moving, P.shadow, P.outline);

    if (role === 'cleaner') {
      const by = iy + bob;
      g.lineWidth = LW_CHAR;
      g.lineCap = 'round';
      g.strokeStyle = '#c9862a';
      g.beginPath();
      g.moveTo(ix + u * 0.78, by - u * 2.1);
      g.lineTo(ix + u * 0.98, by + u * 0.1);
      g.stroke();
      ellipse(g, ix + u * 0.98, by + u * 0.24, u * 0.36, u * 0.2);
      g.fillStyle = '#e6edf0';
      g.fill();
      g.strokeStyle = ink('#e6edf0');
      g.stroke();
    } else if (role === 'dealer' && st === 'working') {
      // A dealt card in hand: an unmanned table earns nothing, so "this dealer
      // is actually running a table" has to be visible on the sprite, not only
      // in the marker.
      const by = iy + bob;
      g.save();
      g.translate(ix + u * 0.72, by - u * 1.05);
      g.rotate(-0.3 + Math.sin(t * 3 + seedN) * 0.14);
      rr(g, -u * 0.16, -u * 0.24, u * 0.32, u * 0.5, u * 0.06);
      g.fillStyle = '#fbf7ec';
      g.fill();
      g.lineWidth = LW_THIN;
      g.strokeStyle = '#2b2438';
      g.stroke();
      g.restore();
    }

    this._roleEmblem(g, ix, iy + bob, u, mk);
    void P;
  }

  /**
   * Small-size role cue painted ON the sprite (see ROLE_LOD_PX). Drawn in the
   * world transform, so the size is divided by the camera zoom to hold a fixed
   * MINIMUM on-screen size — the same trick the screen-space markers use, and
   * the reason the old chest badge (a fixed 0.14u dot) was half a pixel at the
   * phone's framing.
   *
   * Fades in over the last 45% of the threshold rather than switching, so a
   * pinch does not pop the emblem on and off.
   */
  _roleEmblem(g, ix, by, u, mk) {
    const zoom = this.camera.zoom || 1;
    const perUnit = u * zoom;
    if (perUnit >= ROLE_LOD_PX) return;
    const lod = clamp((ROLE_LOD_PX - perUnit) / (ROLE_LOD_PX * 0.45), 0, 1);

    // Iso radius that never renders smaller than ROLE_LOD_MIN CSS px.
    const r = Math.max(u * 0.82, ROLE_LOD_MIN / zoom);
    const cy = by - u * 1.05;

    const a0 = g.globalAlpha;
    g.globalAlpha = a0 * lod;
    // Dark backing disc: the emblem has to separate from a navy uniform AND
    // from a bright floor, and a halo does both without a second colour.
    g.beginPath();
    g.arc(ix, cy, r * 1.12, 0, TAU);
    g.fillStyle = 'rgba(14,10,24,0.82)';
    g.fill();
    pipGlyph(g, ix, cy, r, mk.glyph, mk.col);
    g.globalAlpha = a0;
    g.lineWidth = LW_CHAR;
    g.lineCap = 'round';
  }

  _drawActor(g, a, ix, iy, P, t) {
    const type = typeof a.type === 'string' ? a.type : 'thief';
    const def = (CONFIG.liveEvents.types && CONFIG.liveEvents.types[type]) || null;
    const col = def && def.color ? def.color : '#e67e22';
    const caught = a.caught === true;
    const seedN = idSeed(a.id);
    const u = U_ACTOR;
    const pulse = 0.5 + 0.5 * Math.sin(t * (RCFG.highlightPulse || 2.2));

    // floor highlight ring — this is the clickable affordance, it must pop.
    // Derived directly from the actual hit radius (liveEvents.hitTest's `base`)
    // so the brightest, most eye-catching pixels are never drawn outside the
    // circle a click is tested against — fill, pulsing stroke and TTL arc all
    // stay <= clickR.
    const clickR = Math.max(10, CONFIG.liveEvents.clickRadius);
    isoDisc(g, ix, iy, clickR * 0.72);
    g.fillStyle = rgba(col, caught ? 0.12 : 0.2 + pulse * 0.14);
    g.fill();
    isoDisc(g, ix, iy, clickR * (0.86 + pulse * 0.1));
    g.lineWidth = 2.4 + pulse * 1.6;
    g.strokeStyle = rgba(col, caught ? 0.3 : 0.65 + pulse * 0.35);
    g.stroke();

    // ttl arc
    const ttl = Number(a.ttl);
    const maxTtl = def && Number.isFinite(def.ttl) ? def.ttl : 0;
    if (!caught && Number.isFinite(ttl) && maxTtl > 0) {
      const frac = clamp(ttl / maxTtl, 0, 1);
      const rx = clickR * 0.98 * ISO_R;
      g.beginPath();
      g.ellipse(ix, iy, rx, rx * 0.5, 0, -Math.PI / 2, -Math.PI / 2 + frac * TAU);
      g.lineWidth = 2.6;
      g.strokeStyle = frac > 0.35 ? '#5ce07a' : '#ff5a4a';
      g.stroke();
    }

    const bob = caught ? 0 : -Math.abs(Math.sin(t * 10 + seedN)) * u * 0.2;
    const S = ACTOR_STYLE[type] || ACTOR_STYLE.thief;

    if (type === 'brinks') {
      const F = faces('#7d8894', P.outline);
      prism(g, ix + u * 1.1, iy, u * 1.5, u * 0.9, 22, F.t, F.l, F.r, F.o, LW);
      const G = faces(P.gold, P.outline);
      prism(g, ix + u * 1.1, iy - 22 * ISO.kz, u * 0.5, u * 0.4, 6, G.t, G.l, G.r, G.o, LW_THIN);
    }

    chibiFigure(g, ix, iy, u, S, bob, t, seedN, !caught, P.shadow, P.outline);

    const by = iy + bob;
    if (type === 'thief') {
      const F = faces('#c9a86a', P.outline);
      g.beginPath();
      g.arc(ix + u * 0.95, by - u * 1.5, u * 0.52, 0, TAU);
      g.fillStyle = F.l;
      g.fill();
      g.lineWidth = LW_CHAR;
      g.strokeStyle = F.o;
      g.stroke();
    } else if (type === 'counter') {
      for (let i = 0; i < 3; i++) {
        g.save();
        g.translate(ix + u * 0.78, by - u * 1.1);
        g.rotate((i - 1) * 0.36);
        rr(g, -u * 0.14, -u * 0.5, u * 0.3, u * 0.6, u * 0.06);
        g.fillStyle = '#fbf7ec';
        g.fill();
        g.lineWidth = LW_THIN;
        g.strokeStyle = '#2b2438';
        g.stroke();
        g.restore();
      }
    } else if (type === 'angry') {
      g.fillStyle = 'rgba(255,255,255,0.6)';
      for (let i = 0; i < 2; i++) {
        const px = ix + (i === 0 ? -u * 0.75 : u * 0.75);
        const py = by - u * 2.9 - Math.abs(Math.sin(t * 4 + i)) * u * 0.35;
        g.beginPath();
        g.arc(px, py, u * 0.24, 0, TAU);
        g.fill();
      }
    }

    if (caught) {
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.strokeStyle = '#5ce07a';
      g.beginPath();
      g.moveTo(ix - u * 0.6, by - u * 1.5);
      g.lineTo(ix - u * 0.16, by - u * 1.05);
      g.lineTo(ix + u * 0.72, by - u * 2.2);
      g.stroke();
    }
  }

  /* ---------------- screen-space overlays ---------------- */

  /**
   * The highest (smallest y) TOP among every box already placed this frame that
   * intersects [x, y, w, h]. Infinity means the slot is free.
   *
   * Returning the topmost blocker rather than a boolean is what lets _place()
   * clear a whole stack in one hop instead of one rung at a time.
   * @returns {number}
   */
  _blockTop(x, y, w, h) {
    const r = this._markRects;
    let top = Infinity;
    for (let i = 0; i < r.length; i += 4) {
      if (x < r[i] + r[i + 2] && x + w > r[i] && y < r[i + 1] + r[i + 3] && y + h > r[i + 1]) {
        if (r[i + 1] < top) top = r[i + 1];
      }
    }
    return top;
  }

  /**
   * The lowest (largest y) BOTTOM among the boxes already placed this frame that
   * intersect [x, y, w, h]. -Infinity means the slot is free.
   *
   * Mirror of _blockTop, for the downward half of _place()'s search.
   * @returns {number}
   */
  _blockBottom(x, y, w, h) {
    const r = this._markRects;
    let bot = -Infinity;
    for (let i = 0; i < r.length; i += 4) {
      if (x < r[i] + r[i + 2] && x + w > r[i] && y < r[i + 1] + r[i + 3] && y + h > r[i + 1]) {
        const b = r[i + 1] + r[i + 3];
        if (b > bot) bot = b;
      }
    }
    return bot;
  }

  /** Claim a box for the rest of the frame. Bounded so a 90-guest floor cannot
   *  turn the overlap test into an O(n^2) frame killer. */
  _reserve(x, y, w, h) {
    const r = this._markRects;
    if (r.length < 480) r.push(x, y, w, h);
  }

  /**
   * Clamp an overlay box into the UNOBSTRUCTED rect (C2) rather than the raw
   * canvas box.
   *
   * The canvas is full-bleed, so "inside the canvas" is not the same as
   * "visible": the top 72 CSS px sit under the HUD and the bottom ~96 under the
   * action dock. A marker whose preferred slot lands there is drawn and then
   * covered, which is how staff at the BACK of the floor (small screen y, the
   * marker sits ~64 px above the head) ended up with no visible pill at all
   * while the rest of the shift had one. Cover framing made that worse, not
   * better, because it zooms in and pushes more of the floor past the top edge.
   *
   * The hi bounds go through Math.max so a box wider/taller than the visible
   * rect still produces a valid (top-left-pinned) position instead of NaN.
   * @returns {{x:number, y:number}}
   */
  _clampBox(x, y, w, h) {
    const v = this._viewRect();
    const loX = v.x + 2;
    const loY = v.y + 2;
    return {
      x: clamp(x, loX, Math.max(loX, v.x + v.w - w - 2)),
      y: clamp(y, loY, Math.max(loY, v.y + v.h - h - 2))
    };
  }

  /**
   * Find a free slot for a w x h box whose preferred top-left is (x, y).
   *
   * The box is pushed UPWARD — the direction that keeps an overlay above its own
   * subject rather than over somebody else's — by hopping it directly above
   * whatever is blocking it. A fixed-pitch ladder does NOT work here and was
   * tried first: staff (u 9.6), guests (8.0) and VIPs (10.6) sit at different
   * heights above their anchor, so their ladders are out of phase and every rung
   * of one lands straddling two boxes of another. Hopping above the blocker is
   * phase-free and converges monotonically.
   *
   * Each lane is searched UP first, then DOWN, before moving to a left and then
   * a right shoulder. The downward half is not optional: the ceiling is now the
   * visible rect's top rather than the canvas top, and on a short landscape
   * viewport (286 usable px) a dozen markers want the same band under the HUD —
   * the upward ladder runs out after one rung and, without a downward search,
   * every one of them falls back onto the others. Measured: 12 overlapping
   * boxes at 915x412 with up-only, 0 with both.
   *
   * The preferred point is clamped through _clampBox() first, so every slot this
   * can return — including the very first one, which is the common case — is
   * somewhere the player can actually see.
   * @returns {{x:number, y:number, moved:boolean}|null} null when nothing fits
   */
  _place(x, y, w, h, gap, tries) {
    // A shoulder has to clear the whole box, not half of it: an offset smaller
    // than w just lands the box on top of the lane it was trying to escape.
    const side = w + gap;
    const v = this._viewRect();
    const loX = v.x + 2;
    const hiX = Math.max(loX, v.x + v.w - w - 2);
    // Ceiling and floor are the visible rect's edges, not the canvas's: climbing
    // a stack up behind the HUD only trades an overlap for an invisible marker.
    const ceil = v.y + 2;
    const floor = Math.max(ceil, v.y + v.h - h - 2);
    // Same clamp as _clampBox, inlined: this runs once per overlay per frame and
    // the helper would re-measure the view rect and allocate a second object.
    const sx = clamp(x, loX, hiX);
    const sy = clamp(y, ceil, floor);
    for (let s = 0; s < 3; s++) {
      const xx = clamp(s === 0 ? sx : s === 1 ? sx - side : sx + side, loX, hiX);
      // Up first — an overlay above its subject reads as belonging to it.
      let yy = sy;
      for (let i = 0; i < tries; i++) {
        const blocked = this._blockTop(xx, yy, w, h);
        if (blocked === Infinity) return { x: xx, y: yy, moved: i > 0 || s > 0 };
        yy = blocked - h - gap;
        if (yy < ceil) break;
      }
      // Then down. Anything found here has certainly moved (the up pass already
      // rejected the preferred slot), so the caller draws its leader line.
      yy = sy;
      for (let i = 0; i < tries; i++) {
        const blocked = this._blockBottom(xx, yy, w, h);
        if (blocked === -Infinity) return { x: xx, y: yy, moved: true };
        yy = blocked + gap;
        if (yy > floor) break;
      }
    }
    return null;
  }

  /**
   * CONTRACT C4 — screen-space role markers.
   *
   * Drawn in the overlay pass (identity transform), so their size is fixed in
   * CSS px and independent of camera zoom: at the phone's ~0.5 fit zoom the
   * world-space chest badge was half a pixel, which is why "many characters,
   * you can't tell what they do" was the headline complaint. Marked subjects are
   * every staff member plus the guests in a state that costs the player money
   * (VIP, angry) — marking all ~90 guests would be noise, not information.
   */
  _drawRoleMarkers(g, guests, workers, tt) {
    const zoom = this.camera.zoom || 1;
    // Grow a little with zoom for looks, but never shrink below the base size.
    const k = clamp(zoom, 0.95, 1.35);
    const r = PIP_R * k;
    const mode = this.labelMode;
    const wantWorkerText = mode === 'roles' || mode === 'all';
    const wantGuestText = mode === 'all';
    const pulse = 0.5 + 0.5 * Math.sin(tt * 6);
    // Density culling is ROLE-AWARE: staff run first, out of their own budget,
    // so no amount of guest traffic can take a dealer's marker away. Only the
    // flagged-guest pass is capped, and a crowded VIP room genuinely is better
    // served by 24 markers than by 90.
    let staff = 0;
    let flagged = 0;

    g.font = '800 ' + Math.round(11 * k) + 'px ' + FONT_STACK;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.direction = dir();

    // PASS ORDER MATTERS, and TEXT IS RATIONED.
    //
    // Verified on the device at Luxury Resort scale: the floor carries ~50
    // staff, and drawing a "Dealer"/"Guard"/"Cleaner" word-plate for each one
    // covered the casino edge to edge — the diorama was completely invisible
    // behind its own labels. The fix is not a smaller cap alone; it is asking
    // what the plate is FOR. The sprite already carries role (uniform colour,
    // role emblem, hi-vis band, silhouette), so a word-plate is only worth its
    // real estate when it says something the sprite cannot:
    //   - an ACTIONABLE state (a guard running to an incident, a dealer with
    //     no table to run — both cost the player money right now), or
    //   - the player has zoomed in far enough that there is room for words.
    // Everyone else gets the compact icon pip, which is what actually answers
    // "which one is the dealer?" at a glance.
    //
    // Actionable staff are drawn FIRST so that the budget can never be spent on
    // twenty idle cleaners before reaching the guard who needs attention.
    // The budget is also shared FAIRLY BETWEEN ROLES. Verified on the device:
    // staffSim hands workers over grouped by role, so a single ordered sweep
    // spent all 20 slots on dealers and the player saw twenty identical dealer
    // diamonds and not one guard or cleaner — which defeats the entire point of
    // the marker ("which one is the guard?"). So pass 1 gives each role an equal
    // share, and pass 2 hands any unclaimed slots back to whoever is left.
    const forceText = mode === 'all';
    const roleShare = Math.max(1, Math.ceil(WORKER_MARK_MAX / 3));
    const byRole = { dealer: 0, guard: 0, cleaner: 0 };
    // Reused across frames: this runs every draw, so it must not allocate.
    // Passes 1 and 2 both consider non-actionable workers, so without this a
    // worker drawn in the fair-share pass would be drawn AGAIN in the fill pass
    // and collide with its own reserved box.
    const drawn = this._markDrawn || (this._markDrawn = new Set());
    drawn.clear();
    const keyPlates = this._markKeyPlates || (this._markKeyPlates = Object.create(null));
    for (const kk in keyPlates) keyPlates[kk] = 0;
    let plates = 0;
    for (let pass = 0; pass < 3 && staff < WORKER_MARK_MAX; pass++) {
      for (let i = 0; i < workers.length && staff < WORKER_MARK_MAX; i++) {
        const o = workers[i];
        if (!o || drawn.has(i)) continue;
        const role = o.role === 'guard' ? 'guard' : o.role === 'cleaner' ? 'cleaner' : 'dealer';
        const st = typeof o.state === 'string' ? o.state : '';
        const alert = role === 'guard' && st === 'responding';
        const idle = st === 'idle';
        const actionable = alert || (role === 'dealer' && idle);
        // pass 0 = actionable only; pass 1 = fair share per role; pass 2 = fill.
        if (pass === 0 ? !actionable : actionable) continue;
        if (pass === 1 && byRole[role] >= roleShare) continue;

        const m = MARK[role];
        // The label says the STATE when the state is the actionable thing.
        let key = m.key;
        if (alert) key = 'state.guard.responding';
        else if (role === 'dealer' && idle) key = 'state.dealer.idle';
        const status = alert
          ? '#ff3b30'
          : idle
            ? '#6b7280'
            : st === 'working'
              ? '#5ce07a'
              : null;

        // Cap plates PER MESSAGE as well as in total. Six dealers with no table
        // is one fact, not six — the same "say it once" rule that the angry
        // guest markers needed. A responding guard alongside two idle dealers
        // is informative; six copies of "No table" is just the wall of words
        // again in a shorter font.
        const perKey = keyPlates[key] || 0;
        const wantText =
          wantWorkerText &&
          plates < TEXT_PLATE_MAX &&
          (forceText || perKey < TEXT_PLATE_PER_KEY_MAX) &&
          (actionable || forceText || zoom >= ZOOM_FOR_TEXT);

        if (this._marker(g, o, U_WORKER, m, wantText ? this._t(key) : '', alert ? pulse : 0, status, r, k)) {
          staff++;
          byRole[role]++;
          drawn.add(i);
          if (wantText) {
            plates++;
            keyPlates[key] = (keyPlates[key] || 0) + 1;
          }
        }
      }
    }

    // VIPs first, out of the shared budget: a VIP marker is per-subject
    // information and must never be crowded out by a queue of angry guests.
    for (let i = 0; i < guests.length && flagged < GUEST_MARK_MAX; i++) {
      const o = guests[i];
      if (!o || o.vip !== true) continue;
      if (this._marker(g, o, U_VIP, MARK.vip, wantGuestText ? this._t(MARK.vip.key) : '', 0, null, r, k)) {
        flagged++;
      }
    }

    // Then a strictly limited number of angry guests, and without the pulsing
    // alert ring: the ring is reserved for things the player can act on RIGHT
    // NOW (a guard running to an incident). A walkout is a nudge to build more
    // capacity, not an alarm, so it gets the pill and the existing steam puffs.
    let angry = 0;
    for (let i = 0; i < guests.length && angry < ANGRY_MARK_MAX && flagged < GUEST_MARK_MAX; i++) {
      const o = guests[i];
      if (!o || o.angry !== true || o.vip === true) continue;
      if (this._marker(g, o, U_GUEST, MARK.angry, wantGuestText ? this._t(MARK.angry.key) : '', 0, null, r, k)) {
        angry++;
        flagged++;
      }
    }

    g.direction = 'ltr';
    g.textAlign = 'start';
    g.textBaseline = 'alphabetic';
  }

  /**
   * One marker: a dark pill with a shape glyph, an optional nameplate, an
   * optional pulsing alert ring and an optional status dot, anchored above the
   * subject's head. All sizes are CSS px.
   *
   * LAYOUT RULE — a marker never overlaps another overlay. Every marker,
   * labelled or not, both tests and claims a box in this._markRects. The old
   * code only did that for LABELLED markers, so a disc-only marker (a VIP star
   * in 'roles' mode, anything at all in 'off' mode) was free to land in the
   * middle of a nameplate: "Guard" rendered as "G<star>rd" on the device. When
   * the preferred slot is taken the marker climbs (then descends, see _place);
   * only if every lane is full does it drop the nameplate — the disc IS the
   * identity, the plate is only its expansion, so the plate is what gets
   * sacrificed.
   *
   * The whole search happens inside the UNOBSTRUCTED rect (C2). "Inside the
   * canvas" is not good enough now that the canvas is full-bleed: a pill placed
   * in the top 72 px is simply painted under the HUD, which is how staff at the
   * back of the floor read as having no marker at all.
   *
   * @returns {boolean} false when the subject is off-screen and nothing was drawn
   */
  _marker(g, o, u, m, label, alertPulse, statusCol, r, k) {
    const p = this.worldToScreen(Number(o.x) || 0, Number(o.y) || 0, 0);
    // Visibility is judged against the UNOBSTRUCTED rect (C2), not the canvas
    // box: a figure whose anchor is 60 px above the visible rect is behind the
    // HUD, so a marker for it is pure clutter. The margins are asymmetric
    // because a chibi is drawn UPWARD from its ground anchor — an anchor just
    // past the bottom edge still has a head on screen.
    const v = this._viewRect();
    if (p.x < v.x - 70 || p.x > v.x + v.w + 70) return false;
    if (p.y < v.y - 30 || p.y > v.y + v.h + 45) return false;

    const h = r * 2 + 3;
    const pad = 5 * k;
    let tw = label ? g.measureText(label).width : 0;
    let w = label ? h + pad + tw + pad : h;
    // Head anchor: where the tail wants to point, and the bottom of the column
    // of candidate slots.
    const headY = p.y - u * HEAD_UP * (this.camera.zoom || 1) - PIP_LIFT * k;
    // Keep the whole pill inside the VISIBLE rect: a marker for someone near an
    // edge used to be printed half off-screen (or, at the back of the floor,
    // entirely behind the HUD), which is the one place identification matters
    // most — that is where guests enter and staff congregate.
    const wantY = headY - h;
    let want = this._clampBox(p.x - w / 2, wantY, w, h);

    let slot = this._place(want.x, want.y, w, h, MARK_GAP, STACK_TRIES);
    if (!slot && label) {
      // Nothing fits at nameplate width. Shed the plate and try again as a disc,
      // which is a third of the width and almost always finds a home.
      label = '';
      tw = 0;
      w = h;
      want = this._clampBox(p.x - w / 2, wantY, w, h);
      slot = this._place(want.x, want.y, w, h, MARK_GAP, STACK_TRIES);
    }
    // Last resort: draw where it wanted to go anyway. A pile-up this deep is
    // pathological, and an overlapping disc still says "there is a guard here" —
    // a missing one says nothing at all, which is strictly worse.
    const x0 = slot ? slot.x : want.x;
    const top = slot ? slot.y : want.y;
    // "Detached" means the pill is no longer sitting directly over the head —
    // because it dodged a neighbour, or because it was clamped down out of the
    // HUD. Both need the leader line; only the vertical offset matters, since a
    // purely horizontal edge clamp still reads as attached via the tail.
    const stacked = (slot ? slot.moved : false) || Math.abs(top - wantY) > 0.5;
    this._reserve(x0, top, w, h);
    const cy = top + h / 2;
    const gx = x0 + h / 2;

    if (stacked) {
      // The marker had to move to dodge somebody. A leader line back to the head
      // is what keeps it unambiguously THIS figure's marker rather than a label
      // for whatever it now floats above — the short tail cannot span the gap.
      g.beginPath();
      g.moveTo(x0 + w / 2, cy + h / 2);
      g.lineTo(p.x, headY);
      g.lineWidth = 1.4;
      g.strokeStyle = 'rgba(14,10,24,0.72)';
      g.stroke();
    } else {
      // Tail first, so the pill covers its base. Kept inside the (possibly
      // edge-clamped) pill so it always reads as attached to it.
      const tx = clamp(p.x, x0 + 6 * k, x0 + w - 6 * k);
      g.beginPath();
      g.moveTo(tx - 3.4 * k, cy + h / 2 - 1);
      g.lineTo(tx + 3.4 * k, cy + h / 2 - 1);
      g.lineTo(tx, cy + h / 2 + 5 * k);
      g.closePath();
      g.fillStyle = 'rgba(14,10,24,0.88)';
      g.fill();
    }

    if (alertPulse > 0) {
      g.beginPath();
      g.arc(gx, cy, h / 2 + 2 + alertPulse * 3, 0, TAU);
      g.lineWidth = 2 + alertPulse * 1.6;
      g.strokeStyle = rgba('#ff3b30', 0.45 + alertPulse * 0.45);
      g.stroke();
    }

    rr(g, x0, cy - h / 2, w, h, h / 2);
    g.fillStyle = 'rgba(14,10,24,0.88)';
    g.fill();
    g.lineWidth = 1.6 * k;
    g.strokeStyle = m.col;
    g.stroke();

    pipGlyph(g, gx, cy, r * 0.72, m.glyph, m.col);

    if (statusCol) {
      g.beginPath();
      g.arc(x0 + h - r * 0.3, cy - r * 0.72, Math.max(2.2, r * 0.34), 0, TAU);
      g.fillStyle = statusCol;
      g.fill();
      g.lineWidth = 1.2;
      g.strokeStyle = 'rgba(14,10,24,0.95)';
      g.stroke();
    }

    if (label) {
      g.fillStyle = '#ffffff';
      g.fillText(label, x0 + h + pad + tw / 2, cy + 0.5);
    }
    return true;
  }

  _drawActorLabels(g, actors) {
    if (actors.length === 0) return;
    g.font = '800 12px ' + FONT_STACK;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.direction = dir();
    const v = this._viewRect();
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      if (!a) continue;
      const type = typeof a.type === 'string' ? a.type : 'thief';
      const def = (CONFIG.liveEvents.types && CONFIG.liveEvents.types[type]) || null;
      // Labels are locale keys (config.js carries labelKey, liveEvents.js stamps
      // a.labelKey per actor/variant) so they follow a mid-session language
      // switch. a.label is only a legacy escape hatch for a pre-i18n save.
      const labelKey =
        (typeof a.labelKey === 'string' && a.labelKey) ||
        (def && typeof def.labelKey === 'string' && def.labelKey) ||
        '';
      // C4: through the INJECTED translator, like every other string the
      // renderer draws. Calling the bundled t() directly meant a host that swaps
      // in its own translator (or a language switched after boot) updated every
      // role nameplate but left "Thief!" in the old language.
      const label = labelKey
        ? this._t(labelKey)
        : typeof a.label === 'string' && a.label
          ? a.label
          : '';
      if (!label) continue;
      const col = def && def.color ? def.color : '#e67e22';
      const p = this.worldToScreen(Number(a.x) || 0, Number(a.y) || 0, 0);
      if (p.x < v.x - 80 || p.x > v.x + v.w + 80) continue;
      if (p.y < v.y - 30 || p.y > v.y + v.h + 45) continue;
      const tw = g.measureText(label).width;
      const pw = tw + 14;
      const ph = 18;
      // Share the role markers' occupancy list (they ran first, this frame), so
      // a "Thief!" plate can no longer be stamped through a guard's nameplate,
      // and clamp into the visible rect for the same reason markers do.
      const want = this._clampBox(p.x - pw / 2, p.y - 34 * (this.camera.zoom || 1) - ph, pw, ph);
      const slot = this._place(want.x, want.y, pw, ph, MARK_GAP, STACK_TRIES);
      const bx = slot ? slot.x : want.x;
      const py = slot ? slot.y : want.y;
      this._reserve(bx, py, pw, ph);
      rr(g, bx, py, pw, ph, 7);
      g.fillStyle = 'rgba(22,14,36,0.88)';
      g.fill();
      g.lineWidth = 1.6;
      g.strokeStyle = col;
      g.stroke();
      g.fillStyle = '#ffffff';
      // Centre on the box, not on the actor: the box may have been nudged onto a
      // shoulder to dodge a marker, and the text has to travel with it.
      g.fillText(label, bx + pw / 2, py + ph / 2 + 0.5);
    }
    g.direction = 'ltr';
    g.textAlign = 'start';
    g.textBaseline = 'alphabetic';
  }

  _drawPopups(g, dt) {
    const list = this._popups;
    if (list.length === 0) return;

    g.font = '900 14px ' + FONT_STACK;
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.age += dt;
      if (p.age >= p.life) {
        list.splice(i, 1);
        continue;
      }
      const k = p.age / p.life;
      const alpha = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
      const s = this.worldToScreen(p.x, p.y, 0);
      // p.ox / p.oy are the spawn-time anti-collision offset (see popup());
      // constants for the life of the popup, so the rise stays perfectly smooth.
      const x = s.x + p.dx * k + (Number(p.ox) || 0);
      const y = s.y - k * RCFG.popupRise - 16 + (Number(p.oy) || 0);
      // Claim the box so the NEXT popup (and this one, next frame) dodges it.
      const tw = g.measureText(p.text).width;
      this._reserve(x - tw / 2 - 3, y - POPUP_STEP / 2, tw + 6, POPUP_STEP);
      g.globalAlpha = clamp(alpha, 0, 1);
      g.lineWidth = 3.5;
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(26,16,40,0.85)';
      g.strokeText(p.text, x, y);
      g.fillStyle = p.color;
      g.fillText(p.text, x, y);
    }
    g.globalAlpha = 1;
    g.textAlign = 'start';
    g.textBaseline = 'alphabetic';
  }
}

/* VIP guests get a fancier, larger, gold-trimmed style. */
const _vipStyleCache = new Map();
function _vipStyleFor(color) {
  let s = _vipStyleCache.get(color);
  if (!s) {
    // Top hat + long coat, NOT the crown — the crown now identifies the
    // live-event VIP only (three actor kinds used to share it).
    s = styleOf(mix(color, CONFIG.guest.vipColor || '#ffd76a', 0.55), '#ffcf9e', '#22202c', '#1b1b28', 'tophat', '#ffd23f', '#ffffff', null, 'coat');
    if (_vipStyleCache.size < 64) _vipStyleCache.set(color, s);
  }
  return s;
}

export default Renderer;
