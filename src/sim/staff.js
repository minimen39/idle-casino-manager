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
  return BASE_WORKER_SPEED; // dealers walk at the normal guest pace between tables
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
export function dealerCoverage(worldState) {
  if (!worldState || !worldState.venues) return 0;

  let neededInstances = 0;
  for (const key of VENUE_KEYS) {
    const def = VENUES[key];
    if (!def || !def.needsDealer) continue;
    const entry = worldState.venues[key];
    if (entry && Number.isFinite(entry.count)) neededInstances += Math.max(0, entry.count);
  }

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
    this._waypoints = [{ x: 0, y: 0 }];
    this._tables = [];

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

  /** [{id, role, x, y, state, targetId}, ...] — dealers/guards/cleaners only. */
  get workers() {
    return this._workers;
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
      const pos = nodeForSlot(this.layout, slot, tile);
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
      _wpIndex: null,
      _wait: 0,
      _respondFor: 0
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
    const manned = new Set();
    for (const w of dealers) if (w.targetId) manned.add(w.targetId);
    for (const t of this._tables) {
      if (!manned.has(t.tableId)) t.dealerId = null;
    }

    const freeTables = this._tables.filter((t) => !t.dealerId);
    const idleDealers = dealers.filter((w) => !w.targetId);

    const n = Math.min(freeTables.length, idleDealers.length);
    for (let i = 0; i < n; i++) {
      const w = idleDealers[i];
      const t = freeTables[i];
      w.targetId = t.tableId;
      w.tx = t.x;
      w.ty = t.y;
      w.state = 'walking';
      t.dealerId = w.id;
    }
  }

  _updateWorkers(dt) {
    const staff = this.worldState.staff || {};
    const guardSpeed = speedForRole('guard', staff.guards ? staff.guards.level : 1);
    const cleanerSpeed = speedForRole('cleaner', staff.cleaners ? staff.cleaners.level : 1);
    const dealerSpeed = speedForRole('dealer', staff.dealers ? staff.dealers.level : 1);
    const waypoints = this._waypoints;

    for (const w of this._workers) {
      if (w.role === 'dealer') this._updateDealer(w, dt, dealerSpeed);
      else if (w.role === 'guard') this._updateGuard(w, dt, guardSpeed, waypoints);
      else if (w.role === 'cleaner') this._updatePatroller(w, dt, cleanerSpeed, waypoints);
    }
  }

  _updateDealer(w, dt, speed) {
    if (w.targetId) {
      const table = this._tables.find((t) => t.tableId === w.targetId);
      if (table) {
        const arrived = moveToward(w, table.x, table.y, speed, dt);
        w.state = arrived ? 'working' : 'walking';
        return;
      }
      w.targetId = null; // table vanished (venue count dropped); fall through to idle
    }
    moveToward(w, this._restPoint.x, this._restPoint.y, speed, dt);
    w.state = 'idle';
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

  /** No live guest reference is available to this sim (GuestSim isn't passed
   * in); approximate ambient traffic from the total seated capacity of every
   * placed venue/service as a stand-in for concurrent guest load. */
  _estimateTraffic() {
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
