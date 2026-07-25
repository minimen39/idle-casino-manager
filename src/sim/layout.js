/**
 * layout.js — deterministic floor-plan generator for a single world/branch.
 *
 * buildLayout(worldDef, worldState) is a pure function of the world's
 * definition + its current venue/station counts: same counts always produce
 * the same grid, so callers only need to re-run it when a count changes.
 *
 * Floor plan (top = back wall, bottom = entrance), matching goal.md section 3+4:
 *   back wall band   : bar, buffet, showroom            (patience/energy service)
 *   special band     : craps, sportsbook, wheel, vip    (their own attraction zones)
 *   table games band : blackjack, roulette               (dealer tables, middle floor)
 *   slots band       : slots                             (packed banks)
 *   token band       : tokenBooth                        (refills the slots bank)
 *   cashier band     : cashier                            (chip counter, main bottleneck)
 *   security band    : security                           (checkpoint just inside entrance)
 *   entrance (bottom-center) / exit (bottom-left) doors cut into the south wall.
 *
 * Coordinate convention (per the shared contract):
 *   - `slots[].x/y/w/h` and `entrance`/`exit` are GRID-CELL coordinates.
 *   - `walk` is indexed [row][col] === [y][x], true = walkable.
 *   - `nodeFor()` is the one function that returns WORLD-PIXEL coordinates
 *     (grid cell center * tile), because guests/staff move in world pixels.
 *
 * No Math.random is used: a tiny seeded hash of the world key only decides a
 * cosmetic left/right packing direction for the slots bank, so the same
 * world always regenerates an identical layout across reloads.
 */

import { CONFIG, VENUES, STATIONS } from '../core/config.js';

/* ------------------------------------------------------------------ *
 *  Layout-only tuning constants.
 *  CONFIG.grid supplies tile/cols/rows/minCols/minRows/padding; the rest
 *  (packing slack, sane grid ceiling, aisle width) is specific to how this
 *  generator lays instances out and isn't part of the shared balance table,
 *  so it lives here in one place instead of being scattered as literals.
 * ------------------------------------------------------------------ */
const LAYOUT_TUNING = {
  aisleGap: 1,        // tiles left between instances / packed rows / bands
  areaSlack: 1.85,     // packing-inefficiency multiplier used to size the grid
  widthBias: 1.35,     // width:height bias — casino floors read wider than tall
  cornerCorridor: 1,   // extra walkable column reserved on the right edge (belt & suspenders)
  maxCols: 72,         // sane hard ceiling so a maxed-out world can't run away
  maxRows: 60,
  nodeSearchRadius: 8  // BFS radius used to rescue a queue node that lands off-mask
};

/** Bands, top (back wall) to bottom (entrance), each a {group, keys} pair. */
const BANDS = [
  { group: 'venue', keys: ['bar', 'buffet', 'showroom'] },
  { group: 'venue', keys: ['craps', 'sportsbook', 'wheel', 'vip'] },
  { group: 'venue', keys: ['blackjack', 'roulette'] },
  { group: 'venue', keys: ['slots'], mirrorable: true },
  { group: 'station', keys: ['tokenBooth'] },
  { group: 'station', keys: ['cashier'] },
  { group: 'station', keys: ['security'] }
];

/* ------------------------------------------------------------------ *
 *  Small deterministic helpers
 * ------------------------------------------------------------------ */

/** djb2/FNV-ish string hash — deterministic, no Math.random. */
function hashSeed(str) {
  let h = 2166136261;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function safeCount(stateGroup, key, defTable) {
  const st = stateGroup && stateGroup[key];
  const def = defTable[key];
  const maxCount = def && Number.isFinite(def.maxCount) ? def.maxCount : Infinity;
  const raw = st && Number.isFinite(st.count) ? Math.floor(st.count) : 0;
  return clamp(raw, 0, maxCount);
}

/* ------------------------------------------------------------------ *
 *  Shelf packer — lays a list of {kind,key,w,h,index} items left to right,
 *  wrapping to a new row (with a full-width aisle gap) when out of width.
 *  Every row is guaranteed at least one free gap column because a 1-tile
 *  gap is inserted after every item, so a fully-blocked row is impossible.
 * ------------------------------------------------------------------ */
function packBand(items, startY, x0, x1Incl) {
  const gap = LAYOUT_TUNING.aisleGap;
  let cx = x0;
  let cy = startY;
  let rowH = 0;
  let usedAny = false;
  const placed = [];

  for (const it of items) {
    if (cx > x0 && cx + it.w - 1 > x1Incl) {
      cx = x0;
      cy += rowH + gap;
      rowH = 0;
    }
    placed.push({ kind: it.kind, key: it.key, x: cx, y: cy, w: it.w, h: it.h, index: it.index });
    cx += it.w + gap;
    if (it.h > rowH) rowH = it.h;
    usedAny = true;
  }

  const height = usedAny ? (cy - startY) + rowH : 0;
  return { placed, height };
}

/** Build the {kind,key,w,h,index}[] instance list for one band. */
function bandItems(group, keys, worldState) {
  const defTable = group === 'venue' ? VENUES : STATIONS;
  const stateGroup = group === 'venue'
    ? (worldState && worldState.venues) || {}
    : (worldState && worldState.stations) || {};

  const items = [];
  for (const key of keys) {
    const def = defTable[key];
    if (!def || !def.footprint) continue;
    const count = safeCount(stateGroup, key, defTable);
    for (let i = 0; i < count; i++) {
      items.push({ kind: group, key, w: def.footprint.w, h: def.footprint.h, index: i });
    }
  }
  return items;
}

/* ------------------------------------------------------------------ *
 *  Reachability: flood fill from the entrance over the walkable mask.
 * ------------------------------------------------------------------ */
function floodFill(walk, rows, cols, startX, startY) {
  const seen = new Array(rows);
  for (let r = 0; r < rows; r++) seen[r] = new Array(cols).fill(false);

  if (startY < 0 || startY >= rows || startX < 0 || startX >= cols) return seen;
  if (!walk[startY] || !walk[startY][startX]) return seen;

  const stack = [[startY, startX]];
  seen[startY][startX] = true;

  while (stack.length > 0) {
    const [r, c] = stack.pop();
    const neighbors = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
    for (const [nr, nc] of neighbors) {
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (seen[nr][nc]) continue;
      if (!walk[nr] || !walk[nr][nc]) continue;
      seen[nr][nc] = true;
      stack.push([nr, nc]);
    }
  }
  return seen;
}

function reachabilityOk(walk, rows, cols, entrance, exitPt, nodeCells) {
  const seen = floodFill(walk, rows, cols, entrance.x, entrance.y);
  if (!seen[exitPt.y] || !seen[exitPt.y][exitPt.x]) return false;
  for (const n of nodeCells) {
    if (!seen[n.y] || !seen[n.y][n.x]) return false;
  }
  return true;
}

/**
 * Last-resort fallback: carve a straight corridor down the rightmost
 * interior column plus a clear row right above the entrance, then stitch
 * every queue node to that spine with a straight line. Guarantees a
 * connected graph regardless of how the packer laid instances out.
 */
function carveCorridor(walk, rows, cols, entrance, exitPt, nodeCells) {
  const corridorX = cols - 2; // last interior column (cols-1 is the wall)
  const clearRow = rows - 2;  // last interior row, directly above the south wall

  for (let r = 1; r <= clearRow; r++) {
    if (walk[r]) walk[r][corridorX] = true;
  }
  for (let c = 1; c <= cols - 2; c++) {
    if (walk[clearRow]) walk[clearRow][c] = true;
  }
  // Connect both doors straight up into the cleared row.
  walk[entrance.y][entrance.x] = true;
  walk[exitPt.y][exitPt.x] = true;

  for (const n of nodeCells) {
    const lo = Math.min(n.x, corridorX);
    const hi = Math.max(n.x, corridorX);
    for (let c = lo; c <= hi; c++) {
      if (walk[n.y]) walk[n.y][c] = true;
    }
    const loY = Math.min(n.y, clearRow);
    const hiY = Math.max(n.y, clearRow);
    for (let r = loY; r <= hiY; r++) {
      if (walk[r]) walk[r][corridorX] = true;
    }
  }
}

/** BFS outward from a candidate cell to the nearest walkable one (bounded radius). */
function nearestWalkable(walk, rows, cols, cx, cy, radius) {
  if (walk[cy] && walk[cy][cx]) return { x: cx, y: cy };
  for (let d = 1; d <= radius; d++) {
    for (let dy = -d; dy <= d; dy++) {
      const dx = d - Math.abs(dy);
      const candidates = dx === 0 ? [[cx, cy + dy]] : [[cx - dx, cy + dy], [cx + dx, cy + dy]];
      for (const [x, y] of candidates) {
        if (x < 1 || x > cols - 2 || y < 1 || y > rows - 2) continue;
        if (walk[y] && walk[y][x]) return { x, y };
      }
    }
  }
  // Nothing found nearby — clamp into bounds so callers never index out of range.
  return { x: clamp(cx, 1, Math.max(1, cols - 2)), y: clamp(cy, 1, Math.max(1, rows - 2)) };
}

/* ------------------------------------------------------------------ *
 *  Main entry point
 * ------------------------------------------------------------------ */

/**
 * Build a deterministic floor plan for one world.
 * @param {object} worldDef entry from WORLDS (config.js)
 * @param {object} worldState the matching state.worlds[i] block
 */
export function buildLayout(worldDef, worldState) {
  const grid = CONFIG.grid;
  const tile = grid.tile;
  const pad = grid.padding;
  const minCols = grid.minCols;
  const minRows = grid.minRows;

  const seed = hashSeed((worldDef && (worldDef.key || worldDef.id)) || 0);
  const mirrorSlots = (seed % 2) === 1;

  // Gather every band's instances up front so we can size the grid.
  const bandInstances = BANDS.map((band) => {
    const items = bandItems(band.group, band.keys, worldState);
    if (band.mirrorable && mirrorSlots) items.reverse();
    return items;
  });

  let totalArea = 0;
  for (const items of bandInstances) {
    for (const it of items) totalArea += it.w * it.h;
  }

  // Size the interior width from total footprint area (packing slack + a
  // width bias so floors read wider than tall, like a real casino).
  const rawWidth = Math.ceil(Math.sqrt(totalArea * LAYOUT_TUNING.areaSlack * LAYOUT_TUNING.widthBias));
  const minPackWidth = minCols - 2 * pad - LAYOUT_TUNING.cornerCorridor;
  const maxPackWidth = LAYOUT_TUNING.maxCols - 2 * pad - LAYOUT_TUNING.cornerCorridor;
  const packWidth = clamp(Math.max(rawWidth, minPackWidth), minPackWidth, maxPackWidth);

  const cols = clamp(packWidth + LAYOUT_TUNING.cornerCorridor + 2 * pad, minCols, LAYOUT_TUNING.maxCols);
  const x0 = pad;
  const x1Incl = pad + packWidth - 1;

  // Pack every band top to bottom, skipping bands with nothing placed.
  let cursorY = pad;
  const placedAll = [];
  for (const items of bandInstances) {
    if (items.length === 0) continue;
    const { placed, height } = packBand(items, cursorY, x0, x1Incl);
    placedAll.push(...placed);
    cursorY += height + LAYOUT_TUNING.aisleGap;
  }

  const rows = clamp(cursorY + 2, minRows, LAYOUT_TUNING.maxRows);

  // Walkable mask: interior cells default open, border is wall.
  const walk = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    const interiorRow = r > 0 && r < rows - 1;
    for (let c = 0; c < cols; c++) {
      row[c] = interiorRow && c > 0 && c < cols - 1;
    }
    walk[r] = row;
  }
  for (const rect of placedAll) {
    for (let ry = rect.y; ry < rect.y + rect.h; ry++) {
      if (!walk[ry]) continue;
      for (let rx = rect.x; rx < rect.x + rect.w; rx++) {
        if (rx >= 0 && rx < cols) walk[ry][rx] = false;
      }
    }
  }

  // Doors: entrance bottom-center, exit bottom-left, both cut into the south wall.
  const entranceX = clamp(Math.round(cols / 2), 1, cols - 2);
  const exitX = clamp(pad, 1, cols - 2);
  const doorY = rows - 1;
  const entrance = { x: entranceX, y: doorY };
  const exitPt = { x: exitX, y: doorY };
  walk[doorY][entranceX] = true;
  walk[doorY][exitX] = true;

  // Queue node (grid cell) for every placed instance: the cell just south
  // of its rect, centered horizontally, rescued to the nearest walkable
  // cell if that spot is somehow unavailable.
  const nodeCells = [];
  const nodeMap = new Map();
  for (const rect of placedAll) {
    const preferX = rect.x + Math.floor(rect.w / 2);
    const preferY = rect.y + rect.h;
    const cell = nearestWalkable(walk, rows, cols, preferX, preferY, LAYOUT_TUNING.nodeSearchRadius);
    nodeCells.push(cell);
    nodeMap.set(`${rect.kind}:${rect.key}:${rect.index}`, cell);
  }

  // Self-check: entrance, exit and every queue node must be mutually
  // reachable. If construction somehow left something stranded, carve a
  // guaranteed corridor and recheck once.
  if (!reachabilityOk(walk, rows, cols, entrance, exitPt, nodeCells)) {
    carveCorridor(walk, rows, cols, entrance, exitPt, nodeCells);
    if (!reachabilityOk(walk, rows, cols, entrance, exitPt, nodeCells) &&
      typeof console !== 'undefined' && console.warn) {
      console.warn('[layout] reachability self-check still failing after corridor carve for world', worldDef && worldDef.key);
    }
  }

  const slots = placedAll.map((rect) => ({
    id: `${rect.kind}:${rect.key}:${rect.index}`,
    kind: rect.kind,
    key: rect.key,
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    index: rect.index
  }));

  /**
   * World-pixel center of a placed instance's queue point.
   * @param {'venue'|'station'} kind
   * @param {string} key
   * @param {number} index
   * @returns {{x:number,y:number}|null}
   */
  function nodeFor(kind, key, index) {
    const cell = nodeMap.get(`${kind}:${key}:${index}`);
    if (!cell) return null;
    return { x: (cell.x + 0.5) * tile, y: (cell.y + 0.5) * tile };
  }

  return { cols, rows, tile, entrance, exit: exitPt, slots, walk, nodeFor };
}

export default buildLayout;
