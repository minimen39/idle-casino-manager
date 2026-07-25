/**
 * guests.js — the beating heart of the casino: guest spawning, the full
 * customer FSM (spec sections 3 + 4), bottleneck queues, and the money the
 * house actually earns from wagers.
 *
 * Flow (spec §3):
 *   spawn at entrance
 *     -> queue at עמדת בידוק (security)      [long queue => balk & leave angry]
 *     -> queue at קופת צ׳יפים (cashier)       [THE main bottleneck: cash -> chips]
 *     -> pick a gambling venue weighted by wealth / risk appetite / crowd
 *     -> walk -> queue -> play in bursts (chips -> house income)
 *     -> patience / energy drain; when low visit בר / בופה / אולם הופעות
 *        (restores patience+energy, raises risk appetite -> bigger wagers)
 *     -> back to play, or back to the cashier to cash out -> exit.
 *
 * Slots additionally consume tokens from the עמדת פריטה pool. When the pool
 * runs dry `tokensLow` flips to true; StaffSim clears it (sets it to false)
 * once a worker has refilled the booth, which tops the pool back up.
 *
 * Every balance number comes from ../core/config.js. The small TUNING block
 * below only holds *presentation / steering* constants that have no gameplay
 * balance meaning (pixel spacing, steering strength, retry delays).
 */

import { CONFIG, VENUES, STATIONS, STAFF, SYSTEMS, TIERS } from '../core/config.js';
import { bus } from '../core/events.js';
import { boostMult } from '../core/state.js';
import { addMoney } from '../core/economy.js';

/* ------------------------------------------------------------------ *
 *  Local steering / presentation tuning (no economy balance here)
 * ------------------------------------------------------------------ */

const TUNING = {
  /** Fraction of a tile counted as "arrived at target". */
  arriveFactor: 0.45,
  /** Spacing between guests standing in a queue, in tiles. */
  queueSpacing: 0.6,
  /** Separation radius / push strength (world px). */
  sepRadius: 11,
  sepPush: 34,
  /** Spatial hash bucket size (world px). */
  hashCell: 24,
  /** Seconds a guest loiters before re-deciding where to go. */
  idleRetry: 1.25,
  /** Seconds a guest waits around when the token booth is dry. */
  tokenWait: 3,
  /** Improvised token supply when no booth is built at all (in booth units). */
  improvisedTokenUnits: 0.35,
  /**
   * hitTest() targeting for the isometric chibi sprite (renderer.js
   * chibiFigure()). The visible torso/head is drawn well above the guest's
   * ground anchor (g.x, g.y) in iso pixels -- roughly 1.3-2.7 head-heights,
   * u=8 for a regular guest / u=10.6 for a VIP (renderer.js U_GUEST / U_VIP).
   * The iso->world inverse is a fixed 2:1 dimetric transform (ISO.kx=0.5,
   * ISO.ky=0.25 in renderer.js), under which an iso-space vertical offset of
   * `d` above the anchor lands ~2*d world px away from the anchor in BOTH x
   * and y (toward -x/-y), independent of camera zoom -- the zoom factor
   * cancels between the forward draw and the inverse click transform. These
   * bias the tested point toward the sprite's visible center-of-mass so a
   * click aimed at the character (not its tiny ground shadow) actually hits.
   */
  guestHitBias: 26,
  vipHitBias: 34,
  /** Slack radius (world px) around the biased point, covers feet..head. */
  guestHitRadius: 17,
  vipHitRadius: 22,
  /** Session length jitter for gambling. */
  sessionJitter: 0.25,
  /** How hard a long queue repels a guest choosing a venue. */
  queueAversion: 0.85,
  /** Extra pull a VIP room exerts on a VIP guest. */
  vipPull: 8,
  /** Guests get bored of the venue they just left. */
  repeatPenalty: 0.55,
  /** Lifetime cap (seconds) so nobody can ever get stuck forever. */
  lifetime: 260,
  vipLifetimeMult: 1.9,
  /** Gambling sessions a guest wants before cashing out. */
  sessionsMin: 3,
  sessionsMax: 7,
  vipSessionsBonus: 5,
  /** VIPs move slower / are more patient. */
  vipSpeedMult: 0.82,
  vipPatienceMult: 0.55,
  /** Minimum affordability ratio before a venue is rejected outright. */
  affordCutoff: 0.25
};

/* ------------------------------------------------------------------ *
 *  Small helpers
 * ------------------------------------------------------------------ */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

let GUEST_ID = 1;

/** Guest states that count as "walking around the floor". */
const WALK_STATES = {
  enter: 1,
  toSecurity: 1,
  toCashier: 1,
  toVenue: 1,
  toService: 1,
  toCashout: 1,
  leave: 1,
  idle: 1,
  waitToken: 1
};

/** Guest states where the guest is standing in a line. */
const QUEUE_STATES = {
  queueSecurity: 1,
  queueCashier: 1,
  queueVenue: 1,
  queueService: 1,
  queueCashout: 1
};

/* ------------------------------------------------------------------ *
 *  Node — one placed instance of a venue or a station, with its queue
 * ------------------------------------------------------------------ */

class Node {
  constructor(id, kind, key, index, def) {
    this.id = id;
    this.kind = kind;          // 'venue' | 'station'
    this.key = key;
    this.index = index;
    this.def = def;
    this.x = 0;                // queue head, world px
    this.y = 0;
    this.cx = 0;               // rect centre, world px
    this.cy = 0;
    this.dirX = 0;             // direction the queue extends in
    this.dirY = 1;
    this.capacity = 1;
    this.serviceTime = 1;
    this.staffed = true;
    this.output = 1;           // multiplier (0 when a dealer table is unstaffed)
    this.seats = [];
    this.free = 1;
    this.queue = [];
    this.field = null;         // cached BFS distance field toward this node
  }

  takeSeat() {
    for (let i = 0; i < this.seats.length; i++) {
      if (!this.seats[i].taken) {
        this.seats[i].taken = true;
        this.free--;
        return i;
      }
    }
    return -1;
  }

  releaseSeat(i) {
    if (i >= 0 && i < this.seats.length && this.seats[i].taken) {
      this.seats[i].taken = false;
      this.free++;
    }
  }

  dequeue(g) {
    const i = this.queue.indexOf(g);
    if (i !== -1) this.queue.splice(i, 1);
  }
}

/* ------------------------------------------------------------------ *
 *  GuestSim
 * ------------------------------------------------------------------ */

export class GuestSim {
  /**
   * @param {object} worldState per-world save block (state.worlds[i])
   * @param {object} worldDef   entry from WORLDS
   * @param {object} layout     result of buildLayout()
   */
  constructor(worldState, worldDef, layout) {
    this.worldState = worldState || null;
    this.worldDef = worldDef || null;

    /** @type {Array<object>} */
    this._guests = [];

    /** Token pool for the slot machines (עמדת פריטה). */
    this.tokens = 0;
    this.tokenCapacity = 1;
    /** StaffSim reads this and sets it back to false after a refill. */
    this.tokensLow = false;
    this._tokensLowPrev = false;

    /** Floor cleanliness 0..1 — StaffSim owns it, we only read it. */
    this.cleanliness = 1;

    /** Money produced but not yet handed to economy.addMoney (flushed each frame). */
    this._pending = 0;

    /**
     * Periodic venue-event bursts (sportsbook races / wheel-of-fortune spins,
     * spec §4) always reach the wallet, bypassing payToEconomy below. main.js
     * turns payToEconomy off and pays wager income itself via its 1s tick
     * (economy.incomeRate), but that estimator has no term for eventEvery /
     * eventBurstSeconds — without this separate bucket the burst would only
     * ever render a popup and never actually credit the player.
     */
    this._bonusPending = 0;

    /**
     * When false the sim still tracks everything (stats, popups, incomePerSecond)
     * but never calls addMoney — use it if main.js wants its passive 1s income
     * tick to stay the single authority on the active world's earnings.
     */
    this.payToEconomy = true;

    /** Floating "+$" popups the renderer may draw. */
    this.popups = [];

    /** Periodic venue events (sportsbook races, wheel spins). */
    this.venueEvents = {};

    this.stats = { spawned: 0, served: 0, balked: 0, produced: 0 };

    /** Rolling 1s average of the money the floor is really making. */
    this._rate = 0;
    this._rateAcc = 0;
    this._rateWin = 0;

    this.maxGuests = Math.max(1, Math.floor(num(CONFIG.guest.maxGuests, 90)));

    this.time = 0;
    this._spawnTimer = rand(0, 1);

    // Layout-derived
    this.layout = null;
    this.tile = num(CONFIG.grid.tile, 32);
    this.cols = num(CONFIG.grid.cols, 30);
    this.rows = num(CONFIG.grid.rows, 20);
    this.walk = null;
    this._walkTransposed = false;
    this.entrance = { x: this.tile * 0.5, y: this.tile * 0.5 };
    this.exit = { x: this.tile * 0.5, y: this.tile * 0.5 };
    this._nodes = [];
    this._groups = new Map();
    this._gambleNodes = [];
    this._serviceNodes = [];
    this._exitField = null;

    // Spatial hash (rebuilt every frame, zero-allocation after warm-up)
    this._hash = new Map();
    this._hashStamp = 0;

    // Cached multipliers, refreshed once per update()
    this._mult = {
      base: 1,
      dealer: 1,
      risk: 1,
      patience: 1,
      energy: 1
    };
    this._levels = { venue: {}, station: {} };

    this.setLayout(layout);
    this.tokens = this.tokenCapacity;
  }

  /* ---------------------------------------------------------------- *
   *  Public surface
   * ---------------------------------------------------------------- */

  /** @returns {Array<object>} live guest list (renderer reads this). */
  get guests() {
    return this._guests;
  }

  /** Current guest count. */
  get count() {
    return this._guests.length;
  }

  /**
   * Money per second the floor is actually producing right now (rolling 1s
   * average). This is the *observed* rate — always <= economy.incomeRate(),
   * because queues, missing dealers and empty seats throttle it.
   */
  get incomePerSecond() {
    return this._rate;
  }

  /**
   * Swap in a freshly built layout (counts changed / world switched).
   * Every guest is re-routed so nothing points at a stale node.
   * @param {object} layout
   */
  setLayout(layout) {
    this.layout = layout && typeof layout === 'object' ? layout : null;

    const L = this.layout;
    this.tile = Math.max(1, num(L && L.tile, CONFIG.grid.tile));
    this.cols = Math.max(1, Math.floor(num(L && L.cols, CONFIG.grid.cols)));
    this.rows = Math.max(1, Math.floor(num(L && L.rows, CONFIG.grid.rows)));

    this._readWalkMask(L);
    this._exitField = null;

    const t = this.tile;
    this.entrance = this._resolveEdgePoint(L && L.entrance, t * 1.5, (this.rows - 1.5) * t);
    this.exit = this._resolveEdgePoint(L && L.exit, this.entrance.x, this.entrance.y);

    this._buildNodes();
    this._rerouteAll();
  }

  /** StaffSim / integrator hook for the cleanliness penalty (0..1). */
  setCleanliness(v) {
    this.cleanliness = clamp(num(v, 1), 0, 1);
  }

  /** Manually top the token pool up (StaffSim refill). */
  refillTokens() {
    this.tokens = this.tokenCapacity;
    this.tokensLow = false;
    this._tokensLowPrev = false;
  }

  /**
   * Advance the simulation.
   * @param {number} dt seconds (already clamped by main.js)
   */
  update(dt) {
    let step = num(dt, 0);
    if (step <= 0) return;
    if (step > CONFIG.loop.maxDt * 4) step = CONFIG.loop.maxDt * 4;

    this.time += step;

    if (!this.worldState) return;

    const producedBefore = this.stats.produced;

    this._refreshDerived();
    this._updateTokens(step);
    this._updateVenueEvents(step);
    this._spawnTick(step);
    this._rebuildHash();

    const list = this._guests;
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      g.age += step;
      this._updateGuest(g, step);
      if (g.state === 'gone') {
        this._release(g);
        list.splice(i, 1);
      }
    }

    this._updatePopups(step);
    this._flushIncome();

    this._rateAcc += this.stats.produced - producedBefore;
    this._rateWin += step;
    if (this._rateWin >= 1) {
      const windowRate = this._rateAcc / this._rateWin;
      // Smooth it so the HUD does not flicker between busy and idle seconds.
      this._rate = this._rate * 0.55 + windowRate * 0.45;
      this._rateAcc = 0;
      this._rateWin = 0;
    }
  }

  /**
   * World-pixel hit test (canvas clicks).
   * @returns {object|null} the guest under the point, or null
   */
  hitTest(px, py) {
    const x = num(px, NaN);
    const y = num(py, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    // Base radius still honours CONFIG.render.guestRadius as a floor/scale
    // knob, but the real target for the isometric sprite is the biased point
    // computed per-guest below (see TUNING.guestHitBias / vipHitBias).
    const rBase = Math.max(num(CONFIG.render.guestRadius, 4.5) * 2.4, 11);
    const rGuest = Math.max(rBase, TUNING.guestHitRadius);
    const rVip = Math.max(rBase, TUNING.vipHitRadius);
    const rGuest2 = rGuest * rGuest;
    const rVip2 = rVip * rVip;

    let best = null;
    let bestD = Infinity;
    const list = this._guests;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      const bias = g.vip ? TUNING.vipHitBias : TUNING.guestHitBias;
      // Test against the chibi sprite's visible center, not the invisible
      // ground anchor -- see TUNING comment above hitTest().
      const ax = g.x - bias;
      const ay = g.y - bias;
      const dx = ax - x;
      const dy = ay - y;
      const d = dx * dx + dy * dy;
      const limit = g.vip ? rVip2 : rGuest2;
      if (d <= limit && d < bestD) {
        bestD = d;
        best = g;
      }
    }
    return best;
  }

  /**
   * Optional: the player cheers a guest on (a click that is not a live event).
   * Gives a small tip and a patience bump. Returns the money granted.
   * @param {object} guest
   */
  tip(guest) {
    if (!guest || guest.state === 'gone') return 0;
    const amount = Math.max(1, Math.floor(guest.wealth * CONFIG.economy.houseEdge * 0.1));
    guest.patience = Math.min(CONFIG.guest.patienceMax, guest.patience + 12);
    this._earn(amount, guest.x, guest.y);
    return amount;
  }

  /** Remove every guest (world switch / reset). */
  clear() {
    for (const g of this._guests) this._release(g);
    this._guests.length = 0;
  }

  /* ---------------------------------------------------------------- *
   *  Layout plumbing
   * ---------------------------------------------------------------- */

  _readWalkMask(L) {
    this.walk = null;
    this._walkTransposed = false;
    const w = L && L.walk;
    if (!Array.isArray(w) || w.length === 0 || !Array.isArray(w[0])) return;
    if (w.length === this.rows && w[0].length === this.cols) {
      this.walk = w;
    } else if (w.length === this.cols && w[0].length === this.rows) {
      this.walk = w;
      this._walkTransposed = true;
    } else {
      // Unknown shape: use it row-major and bounds-check on access.
      this.walk = w;
    }
  }

  _walkable(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return false;
    const w = this.walk;
    if (!w) return true;
    const row = this._walkTransposed ? w[cx] : w[cy];
    if (!row) return true;
    const v = this._walkTransposed ? row[cy] : row[cx];
    return v === undefined ? true : !!v;
  }

  /** entrance/exit may be given in grid cells; detect and convert. */
  _resolveEdgePoint(p, fx, fy) {
    const t = this.tile;
    if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) {
      return { x: fx, y: fy };
    }
    const x = Number(p.x);
    const y = Number(p.y);
    const looksGrid =
      x >= 0 && y >= 0 && x <= this.cols && y <= this.rows &&
      Number.isInteger(x) && Number.isInteger(y);
    if (looksGrid) return { x: (x + 0.5) * t, y: (y + 0.5) * t };
    return { x, y };
  }

  /** nodeFor() is contracted to return world pixels; auto-correct grid coords. */
  _resolveNodePoint(raw, cx, cy) {
    if (!raw || !Number.isFinite(Number(raw.x)) || !Number.isFinite(Number(raw.y))) {
      return { x: cx, y: cy };
    }
    const t = this.tile;
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (x >= 0 && y >= 0 && x <= this.cols && y <= this.rows) {
      const gx = (x + 0.5) * t;
      const gy = (y + 0.5) * t;
      // Grid interpretation only wins when the raw point is nowhere near the rect.
      if (Math.hypot(x - cx, y - cy) > t * 3 && Math.hypot(gx - cx, gy - cy) <= t * 3) {
        return { x: gx, y: gy };
      }
    }
    return { x, y };
  }

  _defFor(kind, key) {
    if (kind === 'station') {
      return Object.prototype.hasOwnProperty.call(STATIONS, key) ? STATIONS[key] : null;
    }
    if (kind === 'venue') {
      return Object.prototype.hasOwnProperty.call(VENUES, key) ? VENUES[key] : null;
    }
    if (Object.prototype.hasOwnProperty.call(VENUES, key)) return VENUES[key];
    if (Object.prototype.hasOwnProperty.call(STATIONS, key)) return STATIONS[key];
    return null;
  }

  _kindFor(key) {
    if (Object.prototype.hasOwnProperty.call(VENUES, key)) return 'venue';
    if (Object.prototype.hasOwnProperty.call(STATIONS, key)) return 'station';
    return null;
  }

  _buildNodes() {
    this._nodes = [];
    this._groups = new Map();
    this._gambleNodes = [];
    this._serviceNodes = [];

    const L = this.layout;
    const t = this.tile;
    const slots = L && Array.isArray(L.slots) ? L.slots : [];
    const seen = new Map();

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s || typeof s !== 'object') continue;
      const key = String(s.key || '');
      const kind = this._kindFor(key) || (s.kind === 'station' ? 'station' : 'venue');
      const def = this._defFor(kind, key);
      if (!def) continue;

      const gx = num(s.x, 0);
      const gy = num(s.y, 0);
      const gw = Math.max(1, num(s.w, def.footprint ? def.footprint.w : 1));
      const gh = Math.max(1, num(s.h, def.footprint ? def.footprint.h : 1));
      const cx = (gx + gw / 2) * t;
      const cy = (gy + gh / 2) * t;

      const seenKey = kind + ':' + key;
      const auto = seen.get(seenKey) || 0;
      const index = Number.isFinite(Number(s.index)) ? Math.floor(Number(s.index)) : auto;
      seen.set(seenKey, auto + 1);

      const node = this._makeNode(kind, key, index, def, cx, cy, gw * t, gh * t);
      // Queue point: prefer the layout's own node, falling back to the rect.
      let raw = null;
      if (L && typeof L.nodeFor === 'function') {
        try {
          raw = L.nodeFor(kind, key, index);
        } catch (err) {
          raw = null;
        }
      }
      const pt = this._resolveNodePoint(raw, cx, cy);
      node.x = pt.x;
      node.y = pt.y;
      this._orientNode(node);
      this._registerNode(node);
    }

    this._synthesizeMissing();
    this._refreshDerived(true);
  }

  _makeNode(kind, key, index, def, cx, cy, wpx, hpx) {
    const node = new Node(kind + ':' + key + ':' + index, kind, key, index, def);
    node.cx = cx;
    node.cy = cy;
    node.wpx = wpx;
    node.hpx = hpx;

    const capacity = Math.max(1, Math.floor(num(def.capacity, 1)));
    node.capacity = kind === 'station' ? 1 : capacity;
    node.serviceTime = Math.max(0.2, num(def.serviceTime, 3));
    node.seats = this._makeSeats(cx, cy, wpx, hpx, node.capacity);
    node.free = node.seats.length;
    return node;
  }

  _makeSeats(cx, cy, wpx, hpx, capacity) {
    const t = this.tile;
    const cap = Math.max(1, capacity);
    const seats = [];
    if (cap === 1) {
      seats.push({ x: cx, y: cy, taken: false });
      return seats;
    }
    const rx = Math.max(t * 0.34, (wpx || t) * 0.4);
    const ry = Math.max(t * 0.34, (hpx || t) * 0.4);
    for (let i = 0; i < cap; i++) {
      const a = (Math.PI * 2 * i) / cap - Math.PI / 2;
      seats.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, taken: false });
    }
    return seats;
  }

  /** Queue extends away from the venue body, toward walkable floor. */
  _orientNode(node) {
    let dx = node.x - node.cx;
    let dy = node.y - node.cy;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) {
      dx = 0;
      dy = 1;
    } else {
      dx /= len;
      dy /= len;
    }
    // Snap to the dominant axis for tidy lines.
    if (Math.abs(dx) >= Math.abs(dy)) {
      node.dirX = dx >= 0 ? 1 : -1;
      node.dirY = 0;
    } else {
      node.dirX = 0;
      node.dirY = dy >= 0 ? 1 : -1;
    }
  }

  _registerNode(node) {
    this._nodes.push(node);
    const gk = node.kind + ':' + node.key;
    let arr = this._groups.get(gk);
    if (!arr) {
      arr = [];
      this._groups.set(gk, arr);
    }
    arr.push(node);
    if (node.kind === 'venue') {
      if (node.def.kind === 'service') this._serviceNodes.push(node);
      else this._gambleNodes.push(node);
    }
  }

  /**
   * Insurance: if the world owns units the layout did not place (or the layout
   * only placed venues), synthesize off-grid nodes so the loop never dies.
   */
  _synthesizeMissing() {
    const ws = this.worldState;
    if (!ws) return;
    const t = this.tile;

    const spawnRow = (this.rows - 2.5) * t;
    let cursor = t * 3;

    const ensure = (kind, table, stateMap) => {
      for (const key of Object.keys(table)) {
        const entry = stateMap && stateMap[key];
        const want = entry ? Math.max(0, Math.floor(num(entry.count, 0))) : 0;
        if (want <= 0) continue;
        const gk = kind + ':' + key;
        const have = (this._groups.get(gk) || []).length;
        for (let i = have; i < want; i++) {
          const def = table[key];
          const fw = def.footprint ? Math.max(1, num(def.footprint.w, 1)) : 1;
          const fh = def.footprint ? Math.max(1, num(def.footprint.h, 1)) : 1;
          const cx = clamp(cursor, t, (this.cols - 1) * t);
          const cy = spawnRow;
          cursor += (fw + 1) * t;
          if (cursor > (this.cols - 2) * t) cursor = t * 3;
          const node = this._makeNode(kind, key, i, def, cx, cy, fw * t, fh * t);
          node.x = cx;
          node.y = cy + fh * t * 0.5 + t * 0.5;
          node.synthetic = true;
          this._orientNode(node);
          this._registerNode(node);
        }
      }
    };

    ensure('station', STATIONS, ws.stations);
    ensure('venue', VENUES, ws.venues);
  }

  _group(kind, key) {
    return this._groups.get(kind + ':' + key) || null;
  }

  /* ---------------------------------------------------------------- *
   *  Flow fields (cached BFS per destination)
   * ---------------------------------------------------------------- */

  _cellIndex(cx, cy) {
    return cy * this.cols + cx;
  }

  _nearestWalkableCell(cx, cy) {
    const x = clamp(Math.floor(cx), 0, this.cols - 1);
    const y = clamp(Math.floor(cy), 0, this.rows - 1);
    if (this._walkable(x, y)) return this._cellIndex(x, y);
    for (let r = 1; r <= 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (this._walkable(nx, ny)) return this._cellIndex(nx, ny);
        }
      }
    }
    return -1;
  }

  _buildField(px, py) {
    const cols = this.cols;
    const rows = this.rows;
    const n = cols * rows;
    if (n <= 0) return null;
    const start = this._nearestWalkableCell(px / this.tile, py / this.tile);
    if (start < 0) return null;

    const dist = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    dist[start] = 0;
    queue[tail++] = start;

    while (head < tail) {
      const cur = queue[head++];
      const cd = dist[cur];
      const x = cur % cols;
      const y = (cur - x) / cols;

      if (x > 0 && dist[cur - 1] === -1 && this._walkable(x - 1, y)) {
        dist[cur - 1] = cd + 1;
        queue[tail++] = cur - 1;
      }
      if (x < cols - 1 && dist[cur + 1] === -1 && this._walkable(x + 1, y)) {
        dist[cur + 1] = cd + 1;
        queue[tail++] = cur + 1;
      }
      if (y > 0 && dist[cur - cols] === -1 && this._walkable(x, y - 1)) {
        dist[cur - cols] = cd + 1;
        queue[tail++] = cur - cols;
      }
      if (y < rows - 1 && dist[cur + cols] === -1 && this._walkable(x, y + 1)) {
        dist[cur + cols] = cd + 1;
        queue[tail++] = cur + cols;
      }
    }
    return dist;
  }

  _nodeField(node) {
    if (!node) return null;
    if (node.field === null) {
      node.field = this._buildField(node.x, node.y) || false;
    }
    return node.field || null;
  }

  _exitFieldGet() {
    if (this._exitField === null) {
      this._exitField = this._buildField(this.exit.x, this.exit.y) || false;
    }
    return this._exitField || null;
  }

  /* ---------------------------------------------------------------- *
   *  Derived numbers (refreshed once per frame)
   * ---------------------------------------------------------------- */

  _levelOf(kind, key) {
    const ws = this.worldState;
    if (!ws) return 1;
    const map = kind === 'station' ? ws.stations : ws.venues;
    const entry = map && map[key];
    return entry ? Math.max(1, Math.floor(num(entry.level, 1))) : 1;
  }

  _countOf(kind, key) {
    const ws = this.worldState;
    if (!ws) return 0;
    const map =
      kind === 'station' ? ws.stations : kind === 'staff' ? ws.staff : ws.venues;
    const entry = map && map[key];
    return entry ? Math.max(0, Math.floor(num(entry.count, 0))) : 0;
  }

  _staffLevel(key) {
    const ws = this.worldState;
    const entry = ws && ws.staff && ws.staff[key];
    return entry ? Math.max(1, Math.floor(num(entry.level, 1))) : 1;
  }

  _systemLevel(key) {
    const ws = this.worldState;
    const entry = ws && ws.systems && ws.systems[key];
    return entry ? Math.max(0, Math.floor(num(entry.level, 0))) : 0;
  }

  _unitIncome(def, level) {
    const base = num(def.baseIncome, 0);
    const growth = num(def.incomeGrowth, 1);
    return base * Math.pow(growth, Math.max(0, level - 1));
  }

  _dirtPenalty() {
    const floorAt = num(CONFIG.economy.dirtyPenaltyFloor, 0.45);
    const c = clamp(num(this.cleanliness, 1), 0, 1);
    if (floorAt <= 0 || c >= floorAt) return 1;
    const maxPen = num(CONFIG.economy.dirtyPenaltyMax, 0);
    return 1 - maxPen * (1 - c / floorAt);
  }

  _refreshDerived(force) {
    const ws = this.worldState;
    if (!ws) return;

    const tierIdx = clamp(Math.floor(num(ws.tier, 1)) - 1, 0, TIERS.length - 1);
    const tierIncome = num(CONFIG.tier.incomeMult[tierIdx], 1);
    const tierPatience = num(CONFIG.tier.patienceMult[tierIdx], 1);

    const lightLvl = this._systemLevel('lighting');
    const hvacLvl = this._systemLevel('hvac');
    const lightEff = num(SYSTEMS.lighting.effectPerLevel, 0);
    const hvacEff = num(SYSTEMS.hvac.effectPerLevel, 0);

    let stationBonus = 0;
    for (const key of Object.keys(STATIONS)) {
      if (this._countOf('station', key) > 0) {
        stationBonus += this._levelOf('station', key) - 1;
      }
    }

    const m = this._mult;
    m.base =
      num(this.worldDef && this.worldDef.incomeMult, 1) *
      tierIncome *
      boostMult('income') *
      this._dirtPenalty() *
      (1 + num(CONFIG.economy.stationIncomeBonus, 0) * stationBonus);
    m.dealer =
      (1 + num(STAFF.dealers.effectPerLevel, 0) * (this._staffLevel('dealers') - 1)) *
      boostMult('dealer');
    m.risk = 1 + lightEff * lightLvl;
    m.patience = tierPatience / (1 + lightEff * lightLvl);
    m.energy = 1 / (1 + hvacEff * hvacLvl);
    this._tierAttract = tierIncome;

    this._assignDealers();
    this._refreshTokenCapacity();

    if (force) this._spawnTimer = Math.min(this._spawnTimer, 0.5);
  }

  /**
   * Hand out the hired dealers to the tables that need them, richest table
   * first. Instances beyond the dealer count produce nothing (spec §4).
   */
  _assignDealers() {
    let left = this._countOf('staff', 'dealers');
    const unstaffed = num(CONFIG.economy.unstaffedOutput, 0);

    const keys = Object.keys(VENUES)
      .filter((k) => VENUES[k].needsDealer)
      .sort((a, b) => num(VENUES[b].baseIncome, 0) - num(VENUES[a].baseIncome, 0));

    const allowed = {};
    for (const k of keys) {
      const c = this._countOf('venue', k);
      const take = Math.min(c, Math.max(0, left));
      allowed[k] = take;
      left -= take;
    }

    for (let i = 0; i < this._nodes.length; i++) {
      const node = this._nodes[i];
      if (node.kind !== 'venue') continue;
      if (!node.def.needsDealer) {
        node.staffed = true;
        node.output = 1;
        continue;
      }
      const ok = node.index < (allowed[node.key] || 0);
      node.staffed = ok || unstaffed > 0;
      node.output = ok ? 1 : unstaffed;
    }
  }

  _refreshTokenCapacity() {
    const def = STATIONS.tokenBooth;
    const units = this._countOf('station', 'tokenBooth');
    const per = Math.max(1, num(def.slotsPerUnit, 6));
    const eff = units > 0 ? units : TUNING.improvisedTokenUnits;
    this.tokenCapacity = Math.max(1, eff * per);
    if (this.tokens > this.tokenCapacity) this.tokens = this.tokenCapacity;
  }

  _tokenThroughput() {
    const def = STATIONS.tokenBooth;
    const lvl = this._levelOf('station', 'tokenBooth');
    return Math.max(0.01, num(def.baseThroughput, 0.8) * Math.pow(num(def.throughputGrowth, 1.15), lvl - 1));
  }

  /** Token cost of one slot session, calibrated so 1 booth unit feeds slotsPerUnit machines. */
  _tokenCost() {
    const slotDef = VENUES.slots;
    const boothDef = STATIONS.tokenBooth;
    const per = Math.max(1, num(boothDef.slotsPerUnit, 6));
    return Math.max(0.01, num(slotDef.serviceTime, 4) * (num(boothDef.baseThroughput, 0.8) / per));
  }

  _updateTokens(dt) {
    // StaffSim clears the flag once a worker has refilled the booth.
    if (this._tokensLowPrev && this.tokensLow === false) {
      this.tokens = this.tokenCapacity;
    }

    const units = this._countOf('station', 'tokenBooth');
    const eff = units > 0 ? units : TUNING.improvisedTokenUnits;
    this.tokens = Math.min(this.tokenCapacity, this.tokens + eff * this._tokenThroughput() * dt);
    // Sticky flag: once the booth runs dry it stays flagged until a worker
    // refills it (StaffSim sets tokensLow = false) or the pool refills itself.
    if (this.tokens >= this.tokenCapacity * 0.5) this.tokensLow = false;
    this._tokensLowPrev = this.tokensLow;
  }

  _takeToken() {
    const cost = this._tokenCost();
    if (this.tokens < cost) {
      this.tokensLow = true;
      this._tokensLowPrev = true;
      return false;
    }
    this.tokens -= cost;
    return true;
  }

  /* ---------------------------------------------------------------- *
   *  Periodic venue events (sportsbook races / wheel spins)
   * ---------------------------------------------------------------- */

  _updateVenueEvents(dt) {
    for (const key of Object.keys(VENUES)) {
      const def = VENUES[key];
      const every = num(def.eventEvery, 0);
      if (every <= 0) continue;
      const count = this._countOf('venue', key);
      let ev = this.venueEvents[key];
      if (!ev) {
        ev = { t: 0, surge: 0, flash: 0 };
        this.venueEvents[key] = ev;
      }
      if (count <= 0) {
        ev.t = 0;
        ev.surge = 0;
        ev.flash = 0;
        continue;
      }
      ev.t += dt;
      if (ev.surge > 0) ev.surge = Math.max(0, ev.surge - dt);
      if (ev.flash > 0) ev.flash = Math.max(0, ev.flash - dt);
      if (ev.t >= every) {
        ev.t -= every;
        ev.surge = Math.max(1, num(def.serviceTime, 10));
        ev.flash = 1;
        const level = this._levelOf('venue', key);
        const burst =
          this._unitIncome(def, level) *
          count *
          num(def.eventBurstSeconds, 0) *
          this._mult.base *
          (def.needsDealer ? this._mult.dealer : 1);
        if (burst > 0) {
          const node = (this._group('venue', key) || [])[0];
          this._earnBonus(burst, node ? node.cx : this.entrance.x, node ? node.cy : this.entrance.y);
        }
      }
    }
  }

  _eventSurge() {
    let s = 0;
    for (const key of Object.keys(this.venueEvents)) {
      const ev = this.venueEvents[key];
      if (ev && ev.surge > 0) s += num(VENUES[key] && VENUES[key].crowdPull, 0) * 2;
    }
    return s;
  }

  /* ---------------------------------------------------------------- *
   *  Spawning
   * ---------------------------------------------------------------- */

  /** How attractive the casino is right now (drives the arrival rate). */
  attractiveness() {
    let gambleUnits = 0;
    let crowd = 0;
    for (const key of Object.keys(VENUES)) {
      const c = this._countOf('venue', key);
      if (c <= 0) continue;
      const def = VENUES[key];
      if (def.kind === 'gamble') gambleUnits += c;
      crowd += num(def.crowdPull, 0) * c;
    }
    crowd += this._eventSurge();
    const spawnMult = Math.max(0.05, num(this.worldDef && this.worldDef.spawnMult, 1));
    const tier = Math.max(0.1, num(this._tierAttract, 1));
    return (
      spawnMult *
      tier *
      (1 + num(CONFIG.guest.spawnPerVenue, 0) * gambleUnits + crowd)
    );
  }

  spawnInterval() {
    const base = Math.max(0.05, num(CONFIG.guest.spawnIntervalBase, 3.4));
    const min = Math.max(0.05, num(CONFIG.guest.spawnIntervalMin, 0.35));
    const a = Math.max(0.05, this.attractiveness());
    return Math.max(min, base / a);
  }

  _spawnTick(dt) {
    const ws = this.worldState;
    if (!ws || !ws.unlocked) return;
    if (this._nodes.length === 0) return;

    this._spawnTimer -= dt;
    let guard = 8;
    while (this._spawnTimer <= 0 && guard-- > 0) {
      this._spawnTimer += this.spawnInterval();
      if (this._guests.length < this.maxGuests) this._spawn();
    }
    if (this._spawnTimer < 0) this._spawnTimer = 0;
  }

  _spawn() {
    const gc = CONFIG.guest;
    const vip = Math.random() < num(gc.vipChance, 0.045);
    const wealthMult = Math.max(0.01, num(this.worldDef && this.worldDef.guestWealthMult, 1));

    let wealth = rand(num(gc.wealthMin, 90), num(gc.wealthMax, 720)) * wealthMult;
    if (vip) wealth *= num(gc.vipWealthMult, 9);

    const palette = Array.isArray(gc.palette) && gc.palette.length ? gc.palette : ['#e8d9c0'];
    const speedVar = num(gc.walkSpeedVariance, 0.25);
    const baseSpeed = num(gc.walkSpeed, 42) * rand(1 - speedVar, 1 + speedVar);

    const g = {
      id: GUEST_ID++,
      x: this.entrance.x + rand(-this.tile * 0.4, this.tile * 0.4),
      y: this.entrance.y + rand(-this.tile * 0.4, this.tile * 0.4),
      tx: this.entrance.x,
      ty: this.entrance.y,
      state: 'enter',
      patience: num(gc.patienceMax, 100) * rand(0.78, 1),
      energy: num(gc.energyMax, 100) * rand(0.8, 1),
      chips: 0,
      wealth,
      cash: wealth,
      vip,
      color: vip ? gc.vipColor || '#ffd76a' : palette[(Math.random() * palette.length) | 0],
      speed: vip ? baseSpeed * TUNING.vipSpeedMult : baseSpeed,

      // internals
      risk: 1,
      age: 0,
      ttl: TUNING.lifetime * (vip ? TUNING.vipLifetimeMult : 1) * rand(0.85, 1.15),
      sessions: 0,
      sessionsWanted:
        Math.floor(rand(TUNING.sessionsMin, TUNING.sessionsMax + 1)) +
        (vip ? TUNING.vipSessionsBonus : 0),
      timer: 0,
      beat: 0,
      beatAcc: 0,
      node: null,
      seat: -1,
      field: null,
      lastKey: '',
      checkedIn: false,
      angry: false,
      arrived: false,
      sepX: 0,
      sepY: 0,
      qi: 0
    };

    this._guests.push(g);
    this.stats.spawned++;
    this._route(g);
  }

  /* ---------------------------------------------------------------- *
   *  Routing helpers
   * ---------------------------------------------------------------- */

  _release(g) {
    if (g.node) {
      g.node.dequeue(g);
      if (g.seat >= 0) g.node.releaseSeat(g.seat);
    }
    g.node = null;
    g.seat = -1;
    g.field = null;
  }

  _rerouteAll() {
    for (const g of this._guests) {
      g.node = null;
      g.seat = -1;
      g.field = null;
      g.arrived = false;
      if (g.state === 'leave' || g.state === 'gone') {
        this._goLeave(g);
      } else {
        this._route(g);
      }
    }
  }

  _target(g, x, y, node) {
    g.tx = x;
    g.ty = y;
    g.arrived = false;
    g.field = node ? this._nodeField(node) : this._exitFieldGet();
  }

  _queuePos(node, index) {
    const gap = this.tile * TUNING.queueSpacing;
    const off = gap * (index + 0.6);
    const jitter = ((index % 2) - 0.5) * this.tile * 0.22;
    return {
      x: node.x + node.dirX * off - node.dirY * jitter,
      y: node.y + node.dirY * off + node.dirX * jitter
    };
  }

  /** Pick the least busy instance of a group that still has queue room. */
  _bestNode(group) {
    if (!group || group.length === 0) return null;
    const maxQ = Math.max(1, Math.floor(num(CONFIG.guest.maxQueue, 6)));
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < group.length; i++) {
      const n = group[i];
      if (n.kind === 'venue' && !n.staffed) continue;
      if (n.queue.length >= maxQ) continue;
      const score = n.queue.length * 2 - n.free;
      if (score < bestScore) {
        bestScore = score;
        best = n;
      }
    }
    return best;
  }

  _enqueue(g, node, state) {
    this._release(g);
    g.node = node;
    g.state = state;
    node.queue.push(g);
    g.qi = node.queue.length - 1;
    const p = this._queuePos(node, g.qi);
    this._target(g, p.x, p.y, node);
    return true;
  }

  _walkTo(g, node, state) {
    this._release(g);
    g.node = node;
    g.state = state;
    const p = this._queuePos(node, Math.min(node.queue.length, 3));
    this._target(g, p.x, p.y, node);
    return true;
  }

  _goLeave(g) {
    this._release(g);
    g.state = 'leave';
    this._target(g, this.exit.x + rand(-6, 6), this.exit.y + rand(-6, 6), null);
  }

  _goIdle(g) {
    this._release(g);
    g.state = this.tokensLow ? 'waitToken' : 'idle';
    g.timer = this.tokensLow ? TUNING.tokenWait : TUNING.idleRetry;
    const t = this.tile;
    let cx = g.x;
    let cy = g.y;
    for (let i = 0; i < 6; i++) {
      const nx = clamp(g.x + rand(-t * 2.2, t * 2.2), t, (this.cols - 1) * t);
      const ny = clamp(g.y + rand(-t * 2.2, t * 2.2), t, (this.rows - 1) * t);
      if (this._walkable(Math.floor(nx / t), Math.floor(ny / t))) {
        cx = nx;
        cy = ny;
        break;
      }
    }
    this._target(g, cx, cy, null);
    g.field = null;
  }

  _goStation(g, key, state) {
    const node = this._bestNode(this._group('station', key));
    if (!node) return false;
    return this._enqueue(g, node, state);
  }

  _goCashier(g) {
    const group = this._group('station', 'cashier');
    if (!group || group.length === 0) {
      // No cashier at all: the guest cannot buy in. Loiter, then give up.
      if (g.patience <= 0) {
        this._goLeave(g);
        return true;
      }
      this._goIdle(g);
      return true;
    }
    if (this._goStation(g, 'cashier', 'queueCashier')) return true;
    this._goIdle(g);
    return true;
  }

  _goCashout(g) {
    if (g.chips <= 0) {
      this._goLeave(g);
      return true;
    }
    const group = this._group('station', 'cashier');
    if (!group || group.length === 0) {
      this._goLeave(g);
      return true;
    }
    const node = this._bestNode(group);
    if (!node) {
      this._goIdle(g);
      return true;
    }
    return this._enqueue(g, node, 'queueCashout');
  }

  _venueRequirement(node) {
    const def = node.def;
    const level = this._levelOf('venue', node.key);
    const perGuest = this._unitIncome(def, level) / Math.max(1, num(def.capacity, 1));
    return Math.max(num(CONFIG.guest.wagerMin, 3), perGuest * node.serviceTime);
  }

  _goGamble(g) {
    const list = this._gambleNodes;
    if (list.length === 0) return false;
    const maxQ = Math.max(1, Math.floor(num(CONFIG.guest.maxQueue, 6)));
    const cost = this._tokenCost();
    const candidates = [];
    let total = 0;

    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      const def = node.def;
      if (!node.staffed || node.output <= 0) continue;
      if (def.vipOnly && !g.vip) continue;
      if (node.queue.length >= maxQ) continue;
      if (node.key === 'slots' && this.tokens < cost) {
        this.tokensLow = true;
        continue;
      }

      const required = this._venueRequirement(node);
      const afford = g.chips / required;
      if (afford < TUNING.affordCutoff) continue;

      let w = Math.min(1.6, afford) * Math.pow(1 + required, 0.3);
      w *= 0.6 + 0.4 * clamp(g.risk * this._mult.risk, 0.5, num(CONFIG.guest.riskMax, 1.8));
      w *= 1 + num(def.crowdPull, 0);
      w /= 1 + node.queue.length * TUNING.queueAversion;
      if (def.vipOnly && g.vip) w *= TUNING.vipPull;
      if (node.key === g.lastKey) w *= TUNING.repeatPenalty;
      if (w <= 0) continue;

      candidates.push(node);
      total += w;
      node._w = w;
    }

    if (candidates.length === 0) return false;

    let roll = Math.random() * total;
    let chosen = candidates[candidates.length - 1];
    for (let i = 0; i < candidates.length; i++) {
      roll -= candidates[i]._w;
      if (roll <= 0) {
        chosen = candidates[i];
        break;
      }
    }
    return this._walkTo(g, chosen, 'toVenue');
  }

  _goService(g) {
    const list = this._serviceNodes;
    if (list.length === 0) return false;
    const maxQ = Math.max(1, Math.floor(num(CONFIG.guest.maxQueue, 6)));
    const needPatience = num(CONFIG.guest.patienceMax, 100) - g.patience;
    const needEnergy = num(CONFIG.guest.energyMax, 100) - g.energy;

    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      if (node.queue.length >= maxQ) continue;
      const def = node.def;
      const gain =
        Math.min(needPatience, num(def.patienceRestore, 0)) +
        Math.min(needEnergy, num(def.energyRestore, 0)) +
        num(def.riskBoost, 0) * 40;
      const dist = Math.hypot(node.x - g.x, node.y - g.y) / this.tile;
      const score = gain / (1 + node.queue.length) - dist * 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }
    if (!best) return false;
    return this._walkTo(g, best, 'toService');
  }

  /** Universal router: decides what a guest does next. */
  _route(g) {
    const gc = CONFIG.guest;
    const minChips = num(gc.wagerMin, 3);

    if (g.patience <= num(gc.abandonPatience, 0) && !g.angry) {
      g.angry = true;
      g.patience = 1;
      this.stats.balked++;
      if (g.chips > minChips) return this._goCashout(g);
      return this._goLeave(g);
    }

    if (g.age > g.ttl) {
      if (g.chips > minChips) return this._goCashout(g);
      return this._goLeave(g);
    }

    // עמדת בידוק — everybody is checked at the door exactly once (spec §3).
    if (!g.checkedIn) {
      const sec = this._group('station', 'security');
      if (sec && sec.length > 0) {
        if (this._goStation(g, 'security', 'queueSecurity')) return true;
        this._goIdle(g);   // every checkpoint is jammed: wait by the door
        return true;
      }
      g.checkedIn = true;
    }

    // Not enough chips to play: buy in (the cashier bottleneck) or go home.
    if (g.chips < minChips) {
      const canBuy =
        !g.angry &&
        g.sessions < g.sessionsWanted &&
        g.cash > minChips * 3 &&
        g.patience > 0;
      if (canBuy) return this._goCashier(g);
      if (g.chips > 0) return this._goCashout(g);
      return this._goLeave(g);
    }

    if (g.sessions >= g.sessionsWanted) return this._goCashout(g);

    const lowP = num(gc.lowPatience, 34);
    const lowE = num(gc.lowEnergy, 30);
    if (!g.angry && (g.patience < lowP || g.energy < lowE)) {
      if (this._goService(g)) return true;
      if (g.patience < lowP * 0.45 || g.energy < lowE * 0.45) return this._goCashout(g);
    }

    if (this._goGamble(g)) return true;
    this._goIdle(g);
    return true;
  }

  /* ---------------------------------------------------------------- *
   *  Per-guest update
   * ---------------------------------------------------------------- */

  _updateGuest(g, dt) {
    const gc = CONFIG.guest;
    const state = g.state;

    // --- drains -----------------------------------------------------
    if (QUEUE_STATES[state]) {
      if (!g.angry) {
        const mult = g.vip ? TUNING.vipPatienceMult : 1;
        g.patience -= num(gc.patienceDrainQueue, 4.2) * this._mult.patience * mult * dt;
      }
    } else if (state !== 'gone') {
      g.patience -= num(gc.patienceDrainIdle, 0.9) * this._mult.patience * dt;
    }
    if (state === 'play') {
      g.energy -= num(gc.energyDrainPlay, 2.1) * this._mult.energy * dt;
    } else if (WALK_STATES[state]) {
      g.energy -= num(gc.energyDrainWalk, 0.6) * this._mult.energy * dt;
    }
    g.patience = clamp(g.patience, -5, num(gc.patienceMax, 100));
    g.energy = clamp(g.energy, 0, num(gc.energyMax, 100));
    g.risk = Math.max(1, g.risk - num(gc.riskDecay, 0.012) * dt);

    // Balk out of a queue.
    if (
      QUEUE_STATES[state] &&
      !g.angry &&
      g.patience <= num(gc.abandonPatience, 0)
    ) {
      this._route(g);
      return;
    }

    switch (g.state) {
      case 'enter':
        this._route(g);
        return;

      case 'idle':
      case 'waitToken':
        this._step(g, dt);
        g.timer -= dt;
        if (g.timer <= 0) this._route(g);
        return;

      case 'queueSecurity':
      case 'queueCashier':
      case 'queueCashout':
      case 'queueVenue':
      case 'queueService':
        this._updateQueued(g, dt);
        return;

      case 'toVenue':
      case 'toService':
        this._step(g, dt);
        if (g.arrived) {
          const node = g.node;
          if (!node) {
            this._route(g);
            return;
          }
          const maxQ = Math.max(1, Math.floor(num(gc.maxQueue, 6)));
          if (node.free <= 0 && node.queue.length >= maxQ) {
            this._route(g);
            return;
          }
          this._enqueue(g, node, g.state === 'toVenue' ? 'queueVenue' : 'queueService');
        }
        return;

      case 'toCashier':
      case 'toCashout':
        this._step(g, dt);
        if (g.arrived && g.node) {
          this._enqueue(g, g.node, g.state === 'toCashier' ? 'queueCashier' : 'queueCashout');
        } else if (g.arrived) {
          this._route(g);
        }
        return;

      case 'security':
      case 'cashier':
      case 'cashout':
      case 'service':
        this._step(g, dt);
        g.timer -= dt;
        if (g.timer <= 0) this._finishService(g);
        return;

      case 'play':
        this._updatePlay(g, dt);
        return;

      case 'leave':
        this._step(g, dt);
        if (g.arrived) g.state = 'gone';
        return;

      default:
        this._route(g);
    }
  }

  _updateQueued(g, dt) {
    const node = g.node;
    if (!node) {
      this._route(g);
      return;
    }
    const idx = node.queue.indexOf(g);
    if (idx === -1) {
      this._route(g);
      return;
    }
    if (idx !== g.qi) {
      g.qi = idx;
      const p = this._queuePos(node, idx);
      this._target(g, p.x, p.y, node);
    }
    this._step(g, dt);

    if (idx !== 0) return;
    if (node.free <= 0) return;
    // Wait until we are actually standing at the counter (or have waited long enough).
    const near = Math.hypot(g.x - node.x, g.y - node.y) <= this.tile * 1.4;
    if (!near && !g.arrived) return;

    this._beginService(g, node);
  }

  _beginService(g, node) {
    // Slots need a token from the עמדת פריטה.
    if (node.kind === 'venue' && node.key === 'slots' && !this._takeToken()) {
      node.dequeue(g);
      this._goIdle(g);
      g.state = 'waitToken';
      g.timer = TUNING.tokenWait;
      return;
    }

    const seat = node.takeSeat();
    if (seat < 0) return;
    node.dequeue(g);
    g.seat = seat;
    const s = node.seats[seat];
    g.tx = s.x;
    g.ty = s.y;
    g.field = null;
    g.arrived = false;

    if (node.kind === 'station') {
      g.timer = this._stationServiceTime(node);
      if (node.key === 'security') g.state = 'security';
      else if (g.state === 'queueCashout') g.state = 'cashout';
      else g.state = 'cashier';
      return;
    }

    if (node.def.kind === 'service') {
      g.state = 'service';
      g.timer = node.serviceTime;
      return;
    }

    g.state = 'play';
    g.timer = node.serviceTime * rand(1 - TUNING.sessionJitter, 1 + TUNING.sessionJitter);
    g.beat = Math.max(0.2, num(CONFIG.guest.playBeat, 1.6));
    g.beatAcc = 0;
    g.lastKey = node.key;
  }

  _stationServiceTime(node) {
    const def = node.def;
    const lvl = this._levelOf('station', node.key);
    const thr =
      num(def.baseThroughput, 0.5) * Math.pow(num(def.throughputGrowth, 1.15), lvl - 1);
    if (thr <= 0) return Math.max(0.2, num(def.serviceTime, 2));
    return clamp(1 / thr, 0.15, 30);
  }

  _finishService(g) {
    const node = g.node;
    const state = g.state;
    if (!node) {
      this._route(g);
      return;
    }
    const gc = CONFIG.guest;

    if (state === 'security') {
      g.checkedIn = true;
      this._release(g);
      this._goCashier(g);
      return;
    }

    if (state === 'cashier') {
      const frac = clamp(num(gc.chipsFraction, 0.75), 0.05, 1);
      const buy = Math.max(0, g.cash * frac);
      g.cash -= buy;
      g.chips += buy;
      this._release(g);
      this._route(g);
      return;
    }

    if (state === 'cashout') {
      g.cash += g.chips;
      g.chips = 0;
      this.stats.served++;
      if (this.worldState) {
        this.worldState.guestsServed = Math.floor(num(this.worldState.guestsServed, 0)) + 1;
        bus.emit('guest:served', { worldId: this.worldState.id });
      }
      this._release(g);
      this._goLeave(g);
      return;
    }

    if (state === 'service') {
      const def = node.def;
      g.patience = Math.min(
        num(gc.patienceMax, 100),
        g.patience + num(def.patienceRestore, 0)
      );
      g.energy = Math.min(num(gc.energyMax, 100), g.energy + num(def.energyRestore, 0));
      g.risk = Math.min(num(gc.riskMax, 1.8), g.risk + num(def.riskBoost, 0));
      if (g.patience > 0) g.angry = false;

      // Drinks and food are bought with cash — the service venue's income.
      const level = this._levelOf('venue', node.key);
      const perGuest = this._unitIncome(def, level) / Math.max(1, num(def.capacity, 1));
      let amount =
        perGuest * node.serviceTime * this._mult.base * num(CONFIG.economy.serviceIncomeMult, 0.55);
      amount = Math.min(amount, Math.max(0, g.cash));
      if (amount > 0) {
        g.cash -= amount;
        this._earn(amount, g.x, g.y - this.tile * 0.4);
      }
      this._release(g);
      this._route(g);
      return;
    }

    this._release(g);
    this._route(g);
  }

  _updatePlay(g, dt) {
    const node = g.node;
    if (!node) {
      this._route(g);
      return;
    }
    this._step(g, dt);

    g.timer -= dt;
    if (!this._wager(g, node, dt)) g.timer = 0;

    if (g.timer <= 0) {
      g.sessions++;
      this._release(g);
      this._route(g);
    }
  }

  /**
   * Wagering: chips flow continuously from the guest to the house, batched
   * into visible "beats" of CONFIG.guest.playBeat seconds for the popups.
   * Over a full seat-second a venue yields exactly its configured income,
   * so a fully occupied floor matches economy.incomeRate().
   * @returns {boolean} false when the guest has run dry
   */
  _wager(g, node, dt) {
    const gc = CONFIG.guest;
    const minStake = num(gc.wagerMin, 3);
    if (g.chips < minStake) return false;

    const def = node.def;
    const level = this._levelOf('venue', node.key);
    const perGuest = this._unitIncome(def, level) / Math.max(1, num(def.capacity, 1));
    const risk = clamp(g.risk * this._mult.risk, 0.5, num(gc.riskMax, 1.8));

    let rate = perGuest * this._mult.base * node.output * risk;
    if (def.needsDealer) rate *= this._mult.dealer;

    const beatLen = Math.max(0.2, num(gc.playBeat, 1.6));
    const capRate = (g.chips * clamp(num(gc.wagerFraction, 0.14), 0.01, 1)) / beatLen;
    let amount = Math.min(rate, capRate) * dt;
    amount = Math.min(amount, g.chips);
    if (!(amount > 0)) return g.chips >= minStake;

    g.chips -= amount;
    this._pending += amount;
    this.stats.produced += amount;

    // Batch the floating popup so we do not spam one per frame.
    g.beatAcc = num(g.beatAcc, 0) + amount;
    g.beat -= dt;
    if (g.beat <= 0) {
      g.beat = beatLen;
      if (g.beatAcc > 0) this._pushPopup(g.beatAcc, g.x, g.y - this.tile * 0.5);
      g.beatAcc = 0;
    }

    return g.chips >= minStake;
  }

  /* ---------------------------------------------------------------- *
   *  Money + popups
   * ---------------------------------------------------------------- */

  _earn(amount, x, y) {
    const v = num(amount, 0);
    if (!(v > 0)) return;
    this._pending += v;
    this.stats.produced += v;
    this._pushPopup(v, x, y);
  }

  /**
   * Like _earn, but for money that must reach the wallet even when
   * payToEconomy is off (see the field comment on _bonusPending). The
   * popup and the wallet credit always move together.
   */
  _earnBonus(amount, x, y) {
    const v = num(amount, 0);
    if (!(v > 0)) return;
    this._bonusPending += v;
    this.stats.produced += v;
    this._pushPopup(v, x, y);
  }

  _pushPopup(amount, x, y) {
    const max = Math.max(0, Math.floor(num(CONFIG.render.maxPopups, 40)));
    if (max === 0) return;
    if (this.popups.length >= max) this.popups.shift();
    this.popups.push({
      x: num(x, 0),
      y: num(y, 0),
      amount,
      life: num(CONFIG.render.popupLife, 1.1),
      max: num(CONFIG.render.popupLife, 1.1)
    });
  }

  _updatePopups(dt) {
    const rise = num(CONFIG.render.popupRise, 26);
    const list = this.popups;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= dt;
      p.y -= rise * dt;
      if (p.life <= 0) list.splice(i, 1);
    }
  }

  _flushIncome() {
    // The wager stream stays gated behind payToEconomy (main.js's 1s tick is
    // the authority for it on the active branch); event bonuses are not
    // covered by that tick's estimator, so they always pay out here.
    const bonus = this._bonusPending;
    this._bonusPending = 0;

    let amount = this._pending;
    this._pending = 0;
    if (!this.payToEconomy) amount = 0;

    const total = amount + bonus;
    if (!(total > 0) || !this.worldState) return;

    try {
      addMoney(this.worldState, total);
    } catch (err) {
      // Never let a broken economy module stall the sim.
      this.worldState.money = num(this.worldState.money, 0) + total;
      this.worldState.lifetimeEarned = num(this.worldState.lifetimeEarned, 0) + total;
      bus.emit('money:changed', {
        worldId: this.worldState.id,
        money: this.worldState.money
      });
    }
  }

  /* ---------------------------------------------------------------- *
   *  Movement: flow-field steering + separation
   * ---------------------------------------------------------------- */

  _rebuildHash() {
    this._hashStamp++;
    const stamp = this._hashStamp;
    const size = TUNING.hashCell;
    const hash = this._hash;
    const list = this._guests;

    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      g.sepX = 0;
      g.sepY = 0;
      const cx = Math.floor(g.x / size) + 512;
      const cy = Math.floor(g.y / size) + 512;
      const key = cy * 1024 + cx;
      let bucket = hash.get(key);
      if (!bucket) {
        bucket = { stamp, list: [] };
        hash.set(key, bucket);
      } else if (bucket.stamp !== stamp) {
        bucket.stamp = stamp;
        bucket.list.length = 0;
      }
      bucket.list.push(g);
    }

    // Separation pass.
    const r = TUNING.sepRadius;
    const r2 = r * r;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      if (!WALK_STATES[g.state] && !QUEUE_STATES[g.state]) continue;
      const cx = Math.floor(g.x / size) + 512;
      const cy = Math.floor(g.y / size) + 512;
      let px = 0;
      let py = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const bucket = hash.get((cy + oy) * 1024 + (cx + ox));
          if (!bucket || bucket.stamp !== stamp) continue;
          const arr = bucket.list;
          for (let k = 0; k < arr.length; k++) {
            const o = arr[k];
            if (o === g) continue;
            const dx = g.x - o.x;
            const dy = g.y - o.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= r2) continue;
            const d = Math.sqrt(d2) || 0.001;
            const push = (1 - d / r) / d;
            px += dx * push;
            py += dy * push;
          }
        }
      }
      const mag = Math.hypot(px, py);
      if (mag > 0.0001) {
        const strength = Math.min(TUNING.sepPush, mag * TUNING.sepPush);
        g.sepX = (px / mag) * strength;
        g.sepY = (py / mag) * strength;
      }
    }
  }

  _step(g, dt) {
    const t = this.tile;
    let wx = g.tx;
    let wy = g.ty;

    const field = g.field;
    if (field) {
      const gx = clamp(Math.floor(g.x / t), 0, this.cols - 1);
      const gy = clamp(Math.floor(g.y / t), 0, this.rows - 1);
      const here = field[gy * this.cols + gx];
      if (here > 0) {
        let bestD = here;
        let bx = -1;
        let by = -1;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = gx + ox;
            const ny = gy + oy;
            if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
            if (ox !== 0 && oy !== 0) {
              if (!this._walkable(nx, gy) || !this._walkable(gx, ny)) continue;
            }
            const d = field[ny * this.cols + nx];
            if (d < 0) continue;
            if (d < bestD) {
              bestD = d;
              bx = nx;
              by = ny;
            }
          }
        }
        if (bx >= 0) {
          wx = (bx + 0.5) * t;
          wy = (by + 0.5) * t;
        }
      }
    }

    let dx = wx - g.x;
    let dy = wy - g.y;
    const len = Math.hypot(dx, dy);
    let vx = 0;
    let vy = 0;
    if (len > 0.001) {
      const speed = g.speed;
      vx = (dx / len) * speed;
      vy = (dy / len) * speed;
    }
    vx += g.sepX;
    vy += g.sepY;

    g.x += vx * dt;
    g.y += vy * dt;

    const maxX = this.cols * t;
    const maxY = this.rows * t;
    if (g.x < 2) g.x = 2;
    else if (g.x > maxX - 2) g.x = maxX - 2;
    if (g.y < 2) g.y = 2;
    else if (g.y > maxY - 2) g.y = maxY - 2;

    const adx = g.tx - g.x;
    const ady = g.ty - g.y;
    g.arrived = adx * adx + ady * ady <= (t * TUNING.arriveFactor) * (t * TUNING.arriveFactor);
  }
}

export default GuestSim;
