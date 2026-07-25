/**
 * staff.js — worker AI: dealers, guards, cleaners.
 *
 * Owns:
 *  - Walking dealers who man dealer-requiring tables (an unmanned table earns
 *    nothing; the *pure* aggregate used by economy.js is `dealerCoverage`).
 *  - Patrolling guards who are available for LiveEventSim to redirect toward
 *    live-event actors (see the "responding" protocol documented below).
 *  - Wandering cleaners who restore a sim-local cleanliness value that decays
 *    with estimated guest traffic and gives a small income multiplier.
 *  - The token-booth refill loop: a sim-local 0..1 `tokenSupply` value that
 *    eases toward how well the placed token booths can keep the slots floor
 *    stocked, standing in for the guests' "tokensLow" condition (spec section 3).
 *
 * Cameras (STAFF.cameras) are fixed installations with no walking worker —
 * liveEvents.js is expected to read worldState.staff.cameras directly for its
 * auto-flag chance (CONFIG.liveEvents.cameraAutoChance*).
 *
 * No sim state ever leaks into worldState: this module only ever *reads*
 * worldState.staff/venues/stations. Anything derived lives on the StaffSim
 * instance (cleanliness, tokenSupply, incomeMultiplier, workers) so the
 * integrator wires it in explicitly — see the report notes for exact hooks.
 */

import { CONFIG, STAFF, STATIONS, VENUES, VENUE_KEYS } from '../core/config.js';

/* ------------------------------------------------------------------ *
 *  Small pure helpers
 * ------------------------------------------------------------------ */

let uidCounter = 1;
function nextId(prefix) {
  return prefix + '_' + uidCounter++;
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function growthMult(growth, exponent) {
  const g = Number(growth);
  const n = Number(exponent);
  if (!Number.isFinite(g) || g <= 0) return 1;
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.pow(g, n);
}

/** No staff-specific walk speed exists in CONFIG; reuse the guest pace as a
 * sane baseline and scale per role using each STAFF entry's own effectPerLevel. */
const BASE_WORKER_SPEED =
  CONFIG.guest && Number.isFinite(CONFIG.guest.walkSpeed) ? CONFIG.guest.walkSpeed : 42;

/** A dealer crossing the floor is the one piece of staff motion the player is
 * meant to READ. At the guest pace (and once the phone's ~0.5 fit-zoom has
 * shrunk it) a table-to-table hop takes 6-11s and looks like another guest
 * shuffling in line, so dealers get a purposeful stride. Guards deliberately
 * keep their own 1.3x: liveEvents.js balance depends on their response time. */
const DEALER_WALK_MULT = 1.55;

function speedForRole(role, level) {
  const lvl = Math.max(1, Math.floor(level) || 1);
  if (role === 'guard') {
    const bonus = 1 + STAFF.guards.effectPerLevel * (lvl - 1);
    return BASE_WORKER_SPEED * 1.3 * bonus; // guards move briskly toward trouble
  }
  if (role === 'cleaner') {
    const bonus = 1 + STAFF.cleaners.effectPerLevel * (lvl - 1);
    return BASE_WORKER_SPEED * 0.7 * bonus; // cleaners amble
  }
  // No level scaling for dealers: STAFF.dealers.effectPerLevel is table OUTPUT,
  // not pace, and a levelled-up dealer sprinting the floor would read as a bug.
  return BASE_WORKER_SPEED * DEALER_WALK_MULT; // dealers stride between tables
}

/* ------------------------------------------------------------------ *
 *  Shift rotation tuning
 *
 *  A dealer used to claim one table at spawn and never re-target, so it
 *  performed exactly ONE walk per session and then stood still forever. These
 *  numbers give it a reason to move without making the floor look twitchy:
 *  a post is held for most of a minute, and the jitter is rolled per worker so
 *  a room full of dealers never changes shift in lockstep.
 * ------------------------------------------------------------------ */

const SHIFT_MIN_SECONDS = 22;
const SHIFT_MAX_SECONDS = 38;
/** Don't drag a colleague off a post they only just reached — that reads as
 * twitchy rather than as a shift change. */
const MIN_SWAP_SHIFT = SHIFT_MIN_SECONDS * 0.5;
/** Retry gap when nobody is swappable yet (rather than serving a full shift). */
const SHIFT_RETRY_SECONDS = SHIFT_MIN_SECONDS * 0.3;
/** A dealer only leaves the floor entirely when a colleague can take the post. */
const BREAK_MIN_SECONDS = 3;
const BREAK_MAX_SECONDS = 6;
/** Distance penalty (world px) on the post a dealer just left, so "nearest free
 * table" never hands it straight back and cancels the walk the player saw. */
const REVISIT_PENALTY = CONFIG.grid.tile * 10;

function rollShift() {
  return SHIFT_MIN_SECONDS + Math.random() * (SHIFT_MAX_SECONDS - SHIFT_MIN_SECONDS);
}

function rollBreak() {
  return BREAK_MIN_SECONDS + Math.random() * (BREAK_MAX_SECONDS - BREAK_MIN_SECONDS);
}

/** One full stride, in world px — `walkPhase` advances by 1 per stride so a
 * renderer walk cycle stays locked to distance covered, not to wall time. */
const STRIDE_PX = Math.max(1, CONFIG.grid.tile * 0.8);

/** Cardinal heading in WORLD space (y grows south), for the renderer. */
function cardinalOf(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'e' : 'w';
  return dy >= 0 ? 's' : 'n';
}

/** Longest live-event actor lifetime, used as a defensive timeout so a guard
 * redirected by liveEvents.js (state:'responding') can never get stuck forever
 * if nobody resets it. */
const MAX_ACTOR_TTL = Object.keys(CONFIG.liveEvents.types || {}).reduce((max, key) => {
  const ttl = Number(CONFIG.liveEvents.types[key] && CONFIG.liveEvents.types[key].ttl);
  return Number.isFinite(ttl) && ttl > max ? ttl : max;
}, 0) || 20;
const MAX_RESPOND_SECONDS = MAX_ACTOR_TTL + 5;

/** Token-booth refill pacing, derived from the station's own serviceTime. */
const TOKEN_REFILL_SECONDS = Math.max(1, STATIONS.tokenBooth.serviceTime * 4);
const TOKEN_DEPLETE_SECONDS = Math.max(1, STATIONS.tokenBooth.serviceTime * 10);

function moveToward(worker, tx, ty, speed, dt) {
  const dx = tx - worker.x;
  const dy = ty - worker.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 0.5) {
    worker.x = tx;
    worker.y = ty;
    return true;
  }
  const step = Math.max(0, speed) * dt;
  if (step >= dist) {
    worker.x = tx;
    worker.y = ty;
    return true;
  }
  worker.x += (dx / dist) * step;
  worker.y += (dy / dist) * step;
  return false;
}

/**
 * layout.entrance / layout.exit are GRID-CELL coordinates (see the coordinate
 * convention in layout.js's header); workers move in WORLD PIXELS. Convert,
 * while tolerating a point that is already in pixels — the same heuristic
 * guests.js, liveEvents.js and renderer.js use for these two points.
 * @returns {{x:number,y:number}|null}
 */
function toPixelPoint(pt, layout, tile) {
  if (!pt) return null;
  const x = Number(pt.x);
  const y = Number(pt.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const cols = layout && Number.isFinite(layout.cols) ? layout.cols : CONFIG.grid.cols;
  const rows = layout && Number.isFinite(layout.rows) ? layout.rows : CONFIG.grid.rows;
  if (x <= cols && y <= rows) return { x: (x + 0.5) * tile, y: (y + 0.5) * tile };
  return { x, y };
}

function centerOfSlot(slot, tile) {
  const w = Number.isFinite(slot.w) ? slot.w : 1;
  const h = Number.isFinite(slot.h) ? slot.h : 1;
  const x = Number.isFinite(slot.x) ? slot.x : 0;
  const y = Number.isFinite(slot.y) ? slot.y : 0;
  return { x: (x + w / 2) * tile, y: (y + h / 2) * tile };
}

function nodeForSlot(layout, slot, tile) {
  if (layout && typeof layout.nodeFor === 'function') {
    try {
      const p = layout.nodeFor(slot.kind, slot.key, slot.index);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    } catch (err) {
      /* fall through to the geometric fallback below */
    }
  }
  return centerOfSlot(slot, tile);
}

/** Guarded `layout.walk[row][col]` lookup — walk is indexed [y][x]. */
function isWalkable(layout, gx, gy) {
  const walk = layout && Array.isArray(layout.walk) ? layout.walk : null;
  if (!walk) return false;
  const row = walk[gy];
  return Array.isArray(row) && row[gx] === true;
}

/**
 * Where a dealer actually STANDS to work a table.
 *
 * `layout.nodeFor()` returns the *queue* cell — the cell just SOUTH of the
 * footprint, which is exactly where guests line up — so a dealer posted there
 * is buried in the customer line ~11 world px from the head of the queue. The
 * baked table art reserves the far (-y) edge for the dealer, so prefer the cell
 * just north of the footprint, then the two flanks, and only fall back to the
 * queue node when the floor plan leaves nothing else walkable.
 */
function dealerPostForSlot(layout, slot, tile) {
  const w = Number.isFinite(slot.w) ? slot.w : 1;
  const h = Number.isFinite(slot.h) ? slot.h : 1;
  const x0 = Number.isFinite(slot.x) ? slot.x : 0;
  const y0 = Number.isFinite(slot.y) ? slot.y : 0;
  const midX = x0 + Math.floor(w / 2);
  const midY = y0 + Math.floor(h / 2);

  const candidates = [
    { x: midX, y: y0 - 1 },      // north: the dealer crescent the art draws
    { x: x0 - 1, y: midY },      // west flank
    { x: x0 + w, y: midY }       // east flank
  ];
  for (const c of candidates) {
    if (isWalkable(layout, c.x, c.y)) return { x: (c.x + 0.5) * tile, y: (c.y + 0.5) * tile };
  }
  return nodeForSlot(layout, slot, tile);
}

/* ------------------------------------------------------------------ *
 *  Pure export: dealer coverage (no sim state, safe to import anywhere)
 * ------------------------------------------------------------------ */

/**
 * Fraction (0..1) of dealer-requiring venue instances that could plausibly be
 * staffed given how many dealers are hired. Pure: derived only from counts on
 * the given worldState, never from live sim positions.
 * @param {object} worldState
 * @returns {number}
 */
/**
 * How many dealer-requiring venue instances this world owns.
 *
 * This is also the cap on how many dealers are worth hiring: a dealer can only
 * ever man one table, so the 41st dealer on a 40-table floor is pure cost with
 * no income. economy.js uses it as the dynamic `maxCount` for the dealers unit
 * — buy 55 blackjack tables and you may hire 55 dealers, not the 40 a hardcoded
 * cap used to allow.
 *
 * @param {any} worldState
 * @returns {number} 0 when the world has no dealer-requiring venues yet
 */
export function dealerSlots(worldState) {
  if (!worldState || !worldState.venues) return 0;
  let n = 0;
  for (const key of VENUE_KEYS) {
    const def = VENUES[key];
    if (!def || !def.needsDealer) continue;
    const entry = worldState.venues[key];
    if (entry && Number.isFinite(entry.count)) n += Math.max(0, entry.count);
  }
  return n;
}

export function dealerCoverage(worldState) {
  if (!worldState || !worldState.venues) return 0;

  const neededInstances = dealerSlots(worldState);

  if (neededInstances <= 0) return 1; // nothing needs a dealer -> fully "covered"

  const dealers =
    worldState.staff && worldState.staff.dealers && Number.isFinite(worldState.staff.dealers.count)
      ? Math.max(0, worldState.staff.dealers.count)
      : 0;

  return clamp01(dealers / neededInstances);
}

/* ------------------------------------------------------------------ *
 *  StaffSim
 * ------------------------------------------------------------------ */

export class StaffSim {
  /**
   * @param {object} worldState
   * @param {object} worldDef
   * @param {object} layout
   */
  constructor(worldState, worldDef, layout) {
    this.worldState = worldState && typeof worldState === 'object' ? worldState : null;
    this.worldDef = worldDef && typeof worldDef === 'object' ? worldDef : null;

    this.layout = null;
    this._restPoint = { x: 0, y: 0 };
    /** Where off-duty dealers stand. Deliberately NOT the entrance tile: guests
     * spawn there, so a dealer parked on it disappears into the arrival stream. */
    this._breakPoint = { x: 0, y: 0 };
    this._waypoints = [{ x: 0, y: 0 }];
    this._tables = [];

    /** Live guest headcount pushed in by the integrator (see setGuestCount).
     * null = nobody wired it up, fall back to the installed-capacity estimate. */
    this._guestCount = null;

    /** @type {Array<object>} live worker list, see get workers() */
    this._workers = [];

    /** 0..1, restored by cleaners, decayed by estimated guest traffic. */
    this.cleanliness = 1;
    /** 0..1, eased toward how well token booths can supply the slots floor. */
    this.tokenSupply = 1;

    this.setLayout(layout);
    this._syncWorkerCounts();
    this._reassignDealers();
  }

  /** Re-run whenever the caller rebuilds the layout (counts/tile changed). */
  setLayout(layout) {
    this.layout = layout && typeof layout === 'object' ? layout : null;

    const tile =
      this.layout && Number.isFinite(this.layout.tile) ? this.layout.tile : CONFIG.grid.tile;
    const entrance =
      toPixelPoint(this.layout && this.layout.entrance, this.layout, tile) ||
      { x: tile * 1.5, y: tile * 1.5 };

    this._restPoint = { x: entrance.x, y: entrance.y };
    this._breakPoint = this._computeBreakPoint(tile);
    this._waypoints = this._buildWaypoints(tile);
    this._tables = this._collectDealerTables(tile);

    // Drop any dealer assignment pointing at a table that no longer exists;
    // _reassignDealers() (called by update/constructor) will re-slot them.
    const tableIds = new Set(this._tables.map((t) => t.tableId));
    for (const w of this._workers) {
      if (w.role === 'dealer' && w.targetId && !tableIds.has(w.targetId)) {
        w.targetId = null;
        w.state = 'walking';
      }
      if (!Number.isFinite(w.x)) w.x = this._restPoint.x;
      if (!Number.isFinite(w.y)) w.y = this._restPoint.y;
    }
    this._reassignDealers();
  }

  /**
   * Advance the simulation.
   * @param {number} dt seconds
   */
  update(dt) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (!this.worldState) return;

    this._syncWorkerCounts();
    this._reassignDealers();
    if (step > 0) {
      this._updateWorkers(step);
      this._updateCleanliness(step);
      this._updateTokenSupply(step);
    }
  }

  /**
   * Live guest headcount, pushed in by the integrator (GuestSim is not visible
   * from this module). Cleanliness decay is per *guest*, so without this the
   * floor decayed at a rate set by installed seat capacity and an empty casino
   * got dirty exactly as fast as a packed one.
   * @param {number|null} n concurrent guests, or null to fall back to capacity
   */
  setGuestCount(n) {
    this._guestCount = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }

  /**
   * [{id, role, x, y, state, targetId, moving, speed, dirX, dirY, facing,
   *   walkPhase}, ...] — dealers/guards/cleaners only.
   * `state` is truthful about motion: 'walking' whenever the worker is actually
   * crossing the floor (including a dealer heading off for a break), so a
   * renderer can gate its walk cycle on it. Standing states are 'working'
   * (dealer at its table), 'break', 'patrol'/'idle' and 'responding'.
   */
  get workers() {
    return this._workers;
  }

  /** Ids of the tables a dealer is currently assigned to — the spatial truth,
   * as opposed to the pure count ratio in dealerCoverage(). */
  get mannedTableIds() {
    const ids = new Set();
    for (const t of this._tables) if (t.dealerId) ids.add(t.tableId);
    return ids;
  }

  /** 0..1 fraction of dealer-requiring tables that currently have a dealer at them. */
  get tableCoverage() {
    if (this._tables.length === 0) return 1;
    let manned = 0;
    for (const t of this._tables) if (t.dealerId) manned++;
    return clamp01(manned / this._tables.length);
  }

  /** True once the token floor is running low (booths can't keep up with slot count). */
  get tokensLow() {
    return this.tokenSupply < 0.5;
  }

  /** Small income multiplier derived from cleanliness (spec 7: "multiplies income slightly"). */
  get incomeMultiplier() {
    const floor = CONFIG.economy.dirtyPenaltyFloor;
    if (!(floor > 0) || this.cleanliness >= floor) return 1;
    const deficit = clamp01((floor - this.cleanliness) / floor);
    return 1 - deficit * CONFIG.economy.dirtyPenaltyMax;
  }

  /* -------------------------- internals -------------------------- */

  /** A staff corner a couple of tiles inside the entrance, clear of the guest
   * spawn stream. Walks north off the door until it finds a walkable cell. */
  _computeBreakPoint(tile) {
    const gx = Math.floor(this._restPoint.x / tile);
    const gy = Math.floor(this._restPoint.y / tile);
    for (let step = 2; step <= 4; step++) {
      if (isWalkable(this.layout, gx, gy - step)) {
        return { x: (gx + 0.5) * tile, y: (gy - step + 0.5) * tile };
      }
    }
    return { x: this._restPoint.x, y: this._restPoint.y };
  }

  _buildWaypoints(tile) {
    const pts = [];
    if (this.layout) {
      // entrance/exit are grid cells; centerOfSlot() already returns pixels.
      const ent = toPixelPoint(this.layout.entrance, this.layout, tile);
      if (ent) pts.push(ent);
      const ext = toPixelPoint(this.layout.exit, this.layout, tile);
      if (ext) pts.push(ext);
      const slots = Array.isArray(this.layout.slots) ? this.layout.slots : [];
      for (const slot of slots) {
        if (!slot) continue;
        pts.push(centerOfSlot(slot, tile));
      }
    }
    if (pts.length === 0) pts.push({ x: this._restPoint.x, y: this._restPoint.y });
    return pts;
  }

  _collectDealerTables(tile) {
    const slots = this.layout && Array.isArray(this.layout.slots) ? this.layout.slots : [];
    const tables = [];
    for (const slot of slots) {
      if (!slot || slot.kind !== 'venue') continue;
      const def = VENUES[slot.key];
      if (!def || !def.needsDealer) continue;
      const pos = dealerPostForSlot(this.layout, slot, tile);
      tables.push({
        tableId: slot.key + '#' + slot.index,
        key: slot.key,
        index: slot.index,
        x: pos.x,
        y: pos.y,
        dealerId: null
      });
    }
    return tables;
  }

  _syncWorkerCounts() {
    const staff = this.worldState && this.worldState.staff;
    if (!staff) return;
    this._syncRole('dealer', staff.dealers);
    this._syncRole('guard', staff.guards);
    this._syncRole('cleaner', staff.cleaners);
  }

  _syncRole(role, entry) {
    const count = entry && Number.isFinite(entry.count) ? Math.max(0, Math.floor(entry.count)) : 0;
    const list = this._workers.filter((w) => w.role === role);

    if (list.length < count) {
      for (let i = list.length; i < count; i++) this._workers.push(this._spawnWorker(role));
    } else if (list.length > count) {
      let toRemove = list.length - count;
      for (let i = list.length - 1; i >= 0 && toRemove > 0; i--) {
        this._removeWorker(list[i]);
        toRemove--;
      }
    }
  }

  _spawnWorker(role) {
    const rest = this._restPoint;
    return {
      id: nextId(role),
      role,
      x: rest.x,
      y: rest.y,
      tx: rest.x,
      ty: rest.y,
      state: role === 'dealer' ? 'walking' : 'patrol',
      targetId: null,
      // Motion published for the renderer's walk cycle; see _applyMotion().
      moving: false,
      speed: 0,
      dirX: 0,
      dirY: 1,
      facing: 's',
      walkPhase: 0,
      _wpIndex: null,
      _wait: 0,
      _respondFor: 0,
      // Dealer shift rotation.
      _shiftFor: 0,
      _shiftLen: rollShift(),
      _break: 0,
      _lastTableId: null
    };
  }

  _removeWorker(worker) {
    const idx = this._workers.indexOf(worker);
    if (idx !== -1) this._workers.splice(idx, 1);
    if (worker.role === 'dealer') {
      for (const t of this._tables) if (t.dealerId === worker.id) t.dealerId = null;
    }
  }

  /** Idle dealers claim the nearest still-unmanned table; freed tables (table
   * count shrank, or a dealer was let go) are picked up next tick. */
  _reassignDealers() {
    if (this._tables.length === 0) return;

    const dealers = this._workers.filter((w) => w.role === 'dealer');

    // Rebuild ownership from the WORKERS, never from the tables. setLayout()
    // recreates every table object from scratch with `dealerId: null` (which
    // happens on every purchase that changes a count), so trusting the table
    // side made already-claimed posts look free and let the next hire
    // double-book them while other tables stayed empty forever.
    for (const t of this._tables) t.dealerId = null;
    for (const w of dealers) {
      if (!w.targetId) continue;
      const t = this._tables.find((x) => x.tableId === w.targetId);
      if (!t) {
        w.targetId = null; // the venue count dropped; back into the pool
        continue;
      }
      if (t.dealerId) {
        w.targetId = null; // duplicate claimant; back into the pool
        continue;
      }
      t.dealerId = w.id;
      // A rebuild also MOVES the table, so refresh the cached target point.
      w.tx = t.x;
      w.ty = t.y;
    }

    const freeTables = this._tables.filter((t) => !t.dealerId);
    if (freeTables.length === 0) return;

    for (const w of dealers) {
      if (freeTables.length === 0) break;
      if (w.targetId || w._break > 0) continue; // posted, or off duty
      const t = this._pickTable(w, freeTables);
      freeTables.splice(freeTables.indexOf(t), 1);
      this._claimTable(w, t);
    }
  }

  /** Nearest of `candidates`, with a penalty on the post this dealer just left
   * so a rotation is never immediately undone. */
  _pickTable(w, candidates) {
    let best = candidates[0];
    let bestScore = Infinity;
    for (const t of candidates) {
      const dx = t.x - w.x;
      const dy = t.y - w.y;
      let score = Math.sqrt(dx * dx + dy * dy);
      if (t.tableId === w._lastTableId) score += REVISIT_PENALTY;
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  /** Put `w` on the books for `table` and start a fresh shift. */
  _claimTable(w, table, lastTableId) {
    w.targetId = table.tableId;
    w.tx = table.x;
    w.ty = table.y;
    w.state = 'walking';
    w._shiftFor = 0;
    w._shiftLen = rollShift();
    if (lastTableId !== undefined) w._lastTableId = lastTableId;
    table.dealerId = w.id;
  }

  _updateWorkers(dt) {
    const staff = this.worldState.staff || {};
    const guardSpeed = speedForRole('guard', staff.guards ? staff.guards.level : 1);
    const cleanerSpeed = speedForRole('cleaner', staff.cleaners ? staff.cleaners.level : 1);
    const dealerSpeed = speedForRole('dealer', staff.dealers ? staff.dealers.level : 1);
    const waypoints = this._waypoints;

    for (const w of this._workers) {
      const px = w.x;
      const py = w.y;
      if (w.role === 'dealer') this._updateDealer(w, dt, dealerSpeed);
      else if (w.role === 'guard') this._updateGuard(w, dt, guardSpeed, waypoints);
      else if (w.role === 'cleaner') this._updatePatroller(w, dt, cleanerSpeed, waypoints);
      this._applyMotion(w, px, py, dt);
    }
  }

  /**
   * Publish the motion the renderer's walk cycle needs. Derived from the
   * position DELTA rather than from `state`, so it can never disagree with what
   * the sprite actually did this frame:
   *   moving    — did the worker cover ground
   *   speed     — world px/s actually travelled
   *   dirX/dirY — unit heading, retained while standing still so a posted
   *               dealer keeps facing the way it arrived
   *   facing    — 'n'|'e'|'s'|'w' cardinal of the heading in WORLD space
   *   walkPhase — 0..1 stride phase, advanced by DISTANCE (one stride per
   *               STRIDE_PX) so legs stay locked to the feet, not to wall time
   */
  _applyMotion(w, px, py, dt) {
    const dx = w.x - px;
    const dy = w.y - py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (!(dist > 1e-4)) {
      w.moving = false;
      w.speed = 0;
      return;
    }
    w.moving = true;
    w.speed = dt > 0 ? dist / dt : 0;
    w.dirX = dx / dist;
    w.dirY = dy / dist;
    w.facing = cardinalOf(dx, dy);
    w.walkPhase = (w.walkPhase + dist / STRIDE_PX) % 1;
  }

  /**
   * Dealers hold a post for a shift, then rotate. Three ways out of a shift,
   * all of which HAND THE TABLE OVER rather than abandon it (an unmanned table
   * earns nothing): take an unmanned table (frees one, fills one — coverage is
   * unchanged), trade places with a colleague, or pass the post to a dealer who
   * is currently off-post and go take a break.
   */
  _updateDealer(w, dt, speed) {
    // Off duty: walk to the staff corner, stand there, then rejoin the pool.
    if (w._break > 0) {
      const bp = this._breakPoint;
      const arrived = moveToward(w, bp.x, bp.y, speed, dt);
      if (arrived) w._break = Math.max(0, w._break - dt);
      w.state = arrived ? 'break' : 'walking';
      return;
    }

    if (w.targetId) {
      const table = this._tables.find((t) => t.tableId === w.targetId);
      if (table) {
        const arrived = moveToward(w, table.x, table.y, speed, dt);
        if (!arrived) {
          w.state = 'walking';
          return;
        }
        w.state = 'working';
        w._shiftFor += dt;
        if (w._shiftFor >= w._shiftLen) this._rotateDealer(w, table);
        return;
      }
      w.targetId = null; // table vanished (venue count dropped)
    }

    // No post to hold (no dealer tables yet, or more dealers than tables).
    // Stroll the floor rather than standing on the entrance tile guests spawn
    // on — unassigned staff should still look employed.
    this._updatePatroller(w, dt, speed, this._waypoints);
    if (w.state === 'patrol') w.state = 'walking';
  }

  /** End of shift: move `w` off `current` in whichever way keeps coverage. */
  _rotateDealer(w, current) {
    const others = this._tables.filter((t) => t !== current);
    if (others.length === 0) {
      // Sole table: there is nowhere to hand it to, and walking away would
      // simply stop it earning. Serve another shift.
      w._shiftFor = 0;
      w._shiftLen = rollShift();
      return;
    }

    // 1. An unmanned table is worth more than the one we are standing at, and
    //    swapping one empty post for another leaves total coverage unchanged.
    const free = others.filter((t) => !t.dealerId);
    if (free.length > 0) {
      current.dealerId = null;
      this._claimTable(w, this._pickTable(w, free), current.tableId);
      return;
    }

    // 2. Every post is taken: trade places with whoever has been on station
    //    longest. Both tables keep an owner throughout the crossover.
    //    Skipping the post we came from stops two dealers pairing off and
    //    ping-ponging between the same two tables for the rest of the session.
    const dealers = this._workers.filter((d) => d.role === 'dealer');
    let partnerTable = null;
    let partner = null;
    for (let pass = 0; pass < 2 && !partner; pass++) {
      for (const t of others) {
        if (pass === 0 && t.tableId === w._lastTableId) continue;
        const p = dealers.find((d) => d.id === t.dealerId);
        if (!p || p === w) continue;
        if ((p._shiftFor || 0) < MIN_SWAP_SHIFT) continue; // only just sat down
        if (!partner || (p._shiftFor || 0) > (partner._shiftFor || 0)) {
          partner = p;
          partnerTable = t;
        }
      }
    }
    if (partner) {
      this._claimTable(partner, current, partnerTable.tableId);
      this._claimTable(w, partnerTable, current.tableId);
      return;
    }

    // 3. Nobody to trade with, but a colleague is off-post: hand the table over
    //    (_reassignDealers slots them in next tick) and take a real break.
    const spare = dealers.find((d) => d !== w && !d.targetId && !(d._break > 0));
    if (spare) {
      current.dealerId = null;
      w.targetId = null;
      w._lastTableId = current.tableId;
      w._break = rollBreak();
      w.state = 'walking';
      return;
    }

    // Every colleague has only just taken their own post. Hold this one and
    // re-check soon rather than sitting out another whole shift.
    w._shiftFor = 0;
    w._shiftLen = SHIFT_RETRY_SECONDS;
  }

  /**
   * Guards default to a gentle floor patrol. liveEvents.js may redirect one by
   * setting `worker.state = 'responding'`, `worker.tx/ty` to the actor's
   * position and `worker.targetId` to the actor's id; this loop then walks the
   * guard there and automatically falls back to patrol if nothing clears the
   * responding state within MAX_RESPOND_SECONDS (defensive — never gets stuck).
   */
  _updateGuard(w, dt, speed, waypoints) {
    if (w.state === 'responding') {
      w._respondFor += dt;
      const tx = Number.isFinite(w.tx) ? w.tx : this._restPoint.x;
      const ty = Number.isFinite(w.ty) ? w.ty : this._restPoint.y;
      moveToward(w, tx, ty, speed, dt);
      if (w._respondFor > MAX_RESPOND_SECONDS) {
        w.state = 'patrol';
        w.targetId = null;
        w._respondFor = 0;
      }
      return;
    }
    w._respondFor = 0;
    this._updatePatroller(w, dt, speed, waypoints);
  }

  _updatePatroller(w, dt, speed, waypoints) {
    if (w._wait > 0) {
      w._wait = Math.max(0, w._wait - dt);
      w.state = 'idle';
      return;
    }
    if (waypoints.length === 0) return;
    if (!Number.isFinite(w._wpIndex)) w._wpIndex = Math.floor(Math.random() * waypoints.length);

    const target = waypoints[w._wpIndex % waypoints.length];
    const arrived = moveToward(w, target.x, target.y, speed, dt);
    w.state = 'patrol';
    if (arrived) {
      w._wpIndex = (w._wpIndex + 1 + Math.floor(Math.random() * 2)) % waypoints.length;
      w._wait = 1 + Math.random() * 2;
    }
  }

  _updateCleanliness(dt) {
    const cleaners = this.worldState.staff && this.worldState.staff.cleaners;
    const count = cleaners && Number.isFinite(cleaners.count) ? Math.max(0, cleaners.count) : 0;
    const level = cleaners && Number.isFinite(cleaners.level) ? Math.max(1, cleaners.level) : 1;

    const perSecond = STAFF.cleaners.cleanPerSecond * (1 + STAFF.cleaners.effectPerLevel * (level - 1));
    const restore = count * perSecond;
    const dirt = this._estimateTraffic() * STAFF.cleaners.dirtPerGuestSecond;

    this.cleanliness = clamp01(this.cleanliness + (restore - dirt) * dt);
  }

  /** Live guest traffic. GuestSim isn't visible from here, so the integrator
   * pushes the headcount in every frame (see setGuestCount); the installed
   * capacity below is only the fallback for a caller that never wires it up. */
  _estimateTraffic() {
    if (this._guestCount !== null) return this._guestCount;

    const venues = this.worldState.venues || {};
    let capacity = 0;
    for (const key of VENUE_KEYS) {
      const def = VENUES[key];
      const entry = venues[key];
      if (!def || !entry || !Number.isFinite(entry.count)) continue;
      capacity += def.capacity * entry.count;
    }
    return capacity;
  }

  _updateTokenSupply(dt) {
    const tokenBooth = this.worldState.stations && this.worldState.stations.tokenBooth;
    const slots = this.worldState.venues && this.worldState.venues.slots;
    const slotCount = slots && Number.isFinite(slots.count) ? Math.max(0, slots.count) : 0;

    if (slotCount <= 0) {
      this.tokenSupply = 1;
      return;
    }

    if (!tokenBooth || tokenBooth.count <= 0) {
      this.tokenSupply = clamp01(this.tokenSupply - dt / TOKEN_DEPLETE_SECONDS);
      return;
    }

    const level = Math.max(1, Math.floor(tokenBooth.level) || 1);
    const mult = growthMult(STATIONS.tokenBooth.throughputGrowth, level - 1);
    const capacity = tokenBooth.count * STATIONS.tokenBooth.slotsPerUnit * mult;
    const target = clamp01(capacity / slotCount);

    // Ease toward the target rather than snapping, modeling the time it takes
    // booth attendants to restock (or run down) the floor.
    if (this.tokenSupply < target) {
      this.tokenSupply = Math.min(target, this.tokenSupply + dt / TOKEN_REFILL_SECONDS);
    } else if (this.tokenSupply > target) {
      this.tokenSupply = Math.max(target, this.tokenSupply - dt / TOKEN_DEPLETE_SECONDS);
    }
  }
}

export default StaffSim;
