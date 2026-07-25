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
 * A guest therefore walks the spec's flow bottom-to-top and back:
 *   entrance -> security checkpoint -> cashier bank -> gaming floor ->
 *   service venues -> back to the cashier to cash out -> exit.
 *
 * PLACEMENT (this is the part that makes the room read as finished):
 *   1. The interior width is *searched*, not guessed. Every candidate width in
 *      range is packed for real and scored by the floor area it needs; the
 *      cheapest one whose final grid aspect is sane for a 2:1 iso camera wins.
 *   2. Each band's instances are split into BALANCED rows (rows of roughly
 *      equal run length) instead of "fill left to right, dump the remainder on
 *      the next row" — no more lonely orphan on its own line.
 *   3. Every row is JUSTIFIED: leftover width is handed back as even extra
 *      spacing between instances (capped, so a two-item row does not sprawl),
 *      and the finished run is centred in the floor. Rows fill the width
 *      instead of hugging the west wall.
 *   4. The stack of rows is JUSTIFIED VERTICALLY the same way, with band
 *      boundaries weighted heavier than in-band row gaps, so the bands span
 *      the whole depth of the room and the boundaries read as real aisles.
 *   5. A free concourse row above the south wall and a free corridor column on
 *      the east edge are always reserved, which is what structurally
 *      guarantees the flood-fill reachability check below can succeed.
 *
 * Coordinate convention (per the shared contract):
 *   - `slots[].x/y/w/h` and `entrance`/`exit` are GRID-CELL coordinates.
 *   - `walk` is indexed [row][col] === [y][x], true = walkable.
 *   - `nodeFor()` is the one function that returns WORLD-PIXEL coordinates
 *     (grid cell center * tile), because guests/staff move in world pixels.
 *
 * This module is direction-agnostic: the floor plan lives in world space and
 * is drawn to a canvas, so it is unaffected by the document's rtl/ltr dir.
 *
 * No Math.random is used: a tiny seeded hash of the world key only decides a
 * cosmetic left/right packing direction for the slots bank, so the same
 * world always regenerates an identical layout across reloads.
 */

import { CONFIG, VENUES, STATIONS } from '../core/config.js';

/* ------------------------------------------------------------------ *
 *  Layout-only tuning constants.
 *  CONFIG.grid supplies tile/cols/rows/minCols/minRows/padding; the rest
 *  (spacing policy, aspect window, sane grid ceiling) is specific to how this
 *  generator lays instances out and isn't part of the shared balance table,
 *  so it lives here in one place instead of being scattered as literals.
 * ------------------------------------------------------------------ */
const LAYOUT_TUNING = {
  aisleGap: 1,          // minimum tiles between instances / rows / bands
  cornerCorridor: 1,    // free column reserved on the east edge (the spine)
  concourse: 1,         // free row reserved above the south wall (door lobby)

  // Grid aspect window, measured on the FINAL cols/rows the camera frames.
  // Under the 2:1 iso projection a cols x rows floor lands in a screen box of
  // (cols+rows)/2 by (cols+rows)/4 tiles — always 2:1 — and the diamond fills
  // 2*cols*rows/(cols+rows)^2 of it, which peaks at cols === rows. So a
  // near-square grid both fills the screen best and keeps the camera closest;
  // long thin floors become a sliver and push the camera way out.
  minAspect: 1.00,
  maxAspect: 1.50,
  targetAspect: 1.20,

  // Justification: a row grows its in-row gaps until it covers `rowSpanFill`
  // of the floor width, but never by more than `maxItemGapExtra` per gap —
  // without that cap a two-instance band would smear to opposite walls.
  // Whatever margin is left over becomes the row's leading offset.
  rowSpanFill: 0.78,
  maxItemGapExtra: 6,   // horizontal, between instances in a row
  maxWidthSearch: 96,   // hard cap on candidate widths evaluated (perf guard)
  bandGapWeight: 3,     // vertical slack weighting: band boundary vs row gap

  maxCols: 72,          // sane hard ceiling so a maxed-out world can't run away
  maxRows: 60,
  nodeSearchRadius: 8   // BFS radius used to rescue a queue node that lands off-mask
};

/**
 * Leading-margin anchors for GAMING rows, cycled by row order (0 = flush west,
 * 1 = flush east). A short row would otherwise always centre, so a thinly
 * stocked casino would stack every band into one narrow column down the middle
 * of an empty room. Staggering spreads those bands across the floor while a
 * full row — which has no margin left to shift — is unaffected.
 *
 * Station rows (token booth / cashier / security) deliberately opt out and
 * stay centred: they are the spec's entrance -> checkpoint -> cashier spine and
 * must sit on the axis the entrance door opens onto.
 */
const ROW_ANCHORS = [0.5, 0.16, 0.84, 0.32, 0.68];

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
 *  Row packing — balanced shelves
 *
 *  greedyRows() is a plain shelf pass with an explicit run-length limit.
 *  packRowsBalanced() first asks how few shelves are possible at full width,
 *  then re-runs with the tightest limit that still hits that shelf count, so
 *  the instances spread evenly over the rows (5+4, never 6+3) — which is what
 *  stops a band from looking like a block with a ragged tail.
 * ------------------------------------------------------------------ */

function greedyRows(items, limit, gap) {
  const rows = [];
  let cur = [];
  let curW = 0;
  for (const it of items) {
    const add = cur.length === 0 ? it.w : gap + it.w;
    if (cur.length > 0 && curW + add > limit) {
      rows.push(cur);
      cur = [it];
      curW = it.w;
    } else {
      cur.push(it);
      curW += add;
    }
  }
  if (cur.length > 0) rows.push(cur);
  return rows;
}

function packRowsBalanced(items, maxWidth, gap) {
  if (!items || items.length === 0) return [];

  const width = Math.max(1, Math.floor(maxWidth));
  const minRowCount = greedyRows(items, width, gap).length;

  let widest = 0;
  let sumW = 0;
  for (const it of items) {
    if (it.w > widest) widest = it.w;
    sumW += it.w;
  }
  const totalRun = sumW + (items.length - 1) * gap;
  const ideal = Math.max(widest, Math.ceil(totalRun / Math.max(1, minRowCount)));

  for (let limit = ideal; limit < width; limit++) {
    const rows = greedyRows(items, limit, gap);
    if (rows.length <= minRowCount) return rows;
  }
  return greedyRows(items, width, gap);
}

/**
 * Pack every band at a candidate interior width.
 * @returns {{band:number, items:object[], h:number, y:number, run:number}[]}
 *          one entry per physical row, top to bottom, in band order.
 */
function planRows(bandInstances, packWidth, gap) {
  const out = [];
  for (let b = 0; b < bandInstances.length; b++) {
    const items = bandInstances[b];
    if (!items || items.length === 0) continue;
    for (const row of packRowsBalanced(items, packWidth, gap)) {
      let h = 0;
      let run = 0;
      for (const it of row) {
        if (it.h > h) h = it.h;
        run += it.w;
      }
      run += (row.length - 1) * gap;
      out.push({ band: b, items: row, h, run, y: 0, station: row[0].kind === 'station' });
    }
  }
  return out;
}

/** Minimum interior height a row plan needs at the base aisle gap. */
function requiredHeight(rows, gap) {
  if (rows.length === 0) return 0;
  let h = 0;
  for (const r of rows) h += r.h;
  return h + (rows.length - 1) * gap;
}

/* ------------------------------------------------------------------ *
 *  Justification — hand leftover space back as even spacing.
 * ------------------------------------------------------------------ */

/**
 * Split `slack` whole tiles across `weights` deterministically
 * (largest-remainder, ties broken by index so the result never depends on
 * sort stability).
 */
function shareSlack(slack, weights) {
  const n = weights.length;
  const share = new Array(n).fill(0);
  if (n === 0 || slack <= 0) return share;

  let wsum = 0;
  for (const w of weights) wsum += w;
  if (wsum <= 0) return share;

  const rema = [];
  let assigned = 0;
  for (let i = 0; i < n; i++) {
    const exact = (slack * weights[i]) / wsum;
    const floorPart = Math.floor(exact);
    share[i] = floorPart;
    assigned += floorPart;
    rema.push({ i, r: exact - floorPart });
  }
  rema.sort((a, b) => (b.r - a.r) || (a.i - b.i));
  const left = slack - assigned;
  for (let k = 0; k < left && k < n; k++) share[rema[k].i] += 1;
  return share;
}

/**
 * Assign every item in one row its x, spread across the floor width.
 * @param {number} anchor 0..1 — where the leftover margin puts the finished run.
 */
function justifyRow(row, x0, packWidth, gap, spanFill, maxExtra, anchor) {
  const gaps = row.items.length - 1;
  let extra = 0;
  if (gaps > 0 && packWidth > row.run) {
    const want = Math.ceil((packWidth * spanFill - row.run) / gaps);
    const room = Math.floor((packWidth - row.run) / gaps);
    extra = clamp(Math.min(want, room), 0, maxExtra);
  }
  const span = row.run + extra * gaps;
  const margin = Math.max(0, packWidth - span);
  let x = x0 + clamp(Math.round(margin * anchor), 0, margin);
  for (const it of row.items) {
    it.x = x;
    x += it.w + gap + extra;
  }
}

/** Assign every row its y, spreading the stack over the full floor depth. */
function justifyRows(rows, y0, packHeight, gap, bandGapWeight) {
  const n = rows.length;
  if (n === 0) return;

  const need = requiredHeight(rows, gap);
  const slack = Math.max(0, packHeight - need);

  if (n === 1) {
    rows[0].y = y0 + Math.floor(slack / 2);
    return;
  }

  const weights = [];
  for (let i = 1; i < n; i++) {
    weights.push(rows[i].band !== rows[i - 1].band ? bandGapWeight : 1);
  }
  const share = shareSlack(slack, weights);

  let y = y0;
  for (let i = 0; i < n; i++) {
    rows[i].y = y;
    y += rows[i].h + gap + (i < share.length ? share[i] : 0);
  }
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
 *  Interior sizing — search the width instead of guessing it.
 * ------------------------------------------------------------------ */

/**
 * Try every sane interior width, pack for real, and keep the cheapest floor
 * that lands inside the iso aspect window.
 *
 * "Cheapest" is (cols + rows), NOT cols * rows: the iso screen box a floor
 * needs is (cols+rows)/2 wide by (cols+rows)/4 tall, so that sum is literally
 * how far the camera has to pull back. It is also a far flatter, more stable
 * objective than area — one extra venue nudges the floor instead of flipping
 * it from wide-and-short to tall-and-narrow.
 *
 * Deterministic: candidates are scanned in ascending width order and ties are
 * broken by closeness to the target aspect, then by the narrower floor.
 *
 * @returns {{packWidth:number, packHeight:number, rows:object[]}}
 */
function chooseInterior(bandInstances, gap, bounds) {
  const { minPackWidth, maxPackWidth, minPackHeight, maxPackHeight, chromeW, chromeH } = bounds;

  let best = null;
  let fallback = null;
  const hi = Math.min(maxPackWidth, minPackWidth + LAYOUT_TUNING.maxWidthSearch);

  for (let w = minPackWidth; w <= hi; w++) {
    const rows = planRows(bandInstances, w, gap);
    const need = requiredHeight(rows, gap);
    const h = clamp(Math.max(need, minPackHeight), minPackHeight, maxPackHeight);
    if (need > h) continue; // does not fit inside the row ceiling at this width

    const cols = w + chromeW;
    const grid = h + chromeH;
    const aspect = cols / grid;
    const cost = cols + grid;
    const cand = { packWidth: w, packHeight: h, rows, cost, aspect };

    if (!fallback || cost < fallback.cost) fallback = cand;

    if (aspect < LAYOUT_TUNING.minAspect || aspect > LAYOUT_TUNING.maxAspect) continue;
    if (!best) {
      best = cand;
      continue;
    }
    const dNew = Math.abs(aspect - LAYOUT_TUNING.targetAspect);
    const dOld = Math.abs(best.aspect - LAYOUT_TUNING.targetAspect);
    if (cost < best.cost || (cost === best.cost && dNew < dOld)) best = cand;
  }

  const pick = best || fallback;
  if (pick) return { packWidth: pick.packWidth, packHeight: pick.packHeight, rows: pick.rows };

  // Nothing fit at all (shouldn't happen): widest floor, tallest ceiling.
  const rows = planRows(bandInstances, maxPackWidth, gap);
  return { packWidth: maxPackWidth, packHeight: maxPackHeight, rows };
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
  const gap = LAYOUT_TUNING.aisleGap;

  const seed = hashSeed((worldDef && (worldDef.key || worldDef.id)) || 0);
  const mirrorSlots = (seed % 2) === 1;

  // Gather every band's instances up front so we can size the grid.
  const bandInstances = BANDS.map((band) => {
    const items = bandItems(band.group, band.keys, worldState);
    if (band.mirrorable && mirrorSlots) items.reverse();
    return items;
  });

  // Non-floor chrome: two walls plus the reserved spine column / lobby row.
  const chromeW = 2 * pad + LAYOUT_TUNING.cornerCorridor;
  const chromeH = 2 * pad + LAYOUT_TUNING.concourse;

  const bounds = {
    chromeW,
    chromeH,
    minPackWidth: Math.max(4, minCols - chromeW),
    maxPackWidth: Math.max(4, LAYOUT_TUNING.maxCols - chromeW),
    minPackHeight: Math.max(2, minRows - chromeH),
    maxPackHeight: Math.max(2, LAYOUT_TUNING.maxRows - chromeH)
  };

  const { packWidth, packHeight, rows: rowPlan } =
    chooseInterior(bandInstances, gap, bounds);

  const cols = clamp(packWidth + chromeW, minCols, LAYOUT_TUNING.maxCols);
  const rows = clamp(packHeight + chromeH, minRows, LAYOUT_TUNING.maxRows);

  // Floor rectangle: walls on every edge, plus a free spine column on the east
  // side and a free concourse row above the south wall.
  const x0 = pad;
  const y0 = pad;
  const floorW = Math.max(1, cols - chromeW);
  const floorH = Math.max(1, rows - chromeH);

  // Place: rows down the depth of the floor, instances across its width.
  justifyRows(rowPlan, y0, floorH, gap, LAYOUT_TUNING.bandGapWeight);
  let gamingRow = 0;
  for (const row of rowPlan) {
    const anchor = row.station ? 0.5 : ROW_ANCHORS[gamingRow++ % ROW_ANCHORS.length];
    justifyRow(row, x0, floorW, gap, LAYOUT_TUNING.rowSpanFill, LAYOUT_TUNING.maxItemGapExtra, anchor);
  }

  const placedAll = [];
  for (const row of rowPlan) {
    for (const it of row.items) {
      placedAll.push({
        kind: it.kind,
        key: it.key,
        x: clamp(it.x, x0, Math.max(x0, cols - 2)),
        y: clamp(row.y, y0, Math.max(y0, rows - 2)),
        w: it.w,
        h: it.h,
        index: it.index
      });
    }
  }

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
