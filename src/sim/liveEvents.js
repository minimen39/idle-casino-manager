/**
 * liveEvents.js — real-time gameplay events (spec section 5).
 *
 * Five types, exactly as specified:
 *   'thief'   — runs from a cash point toward the exit with a money sack.
 *               Click to catch (reward); guards/cameras may auto-catch after a
 *               delay driven by guard count + camera level; escaping costs money.
 *   'brinks'  — armored-truck pickup: porters walk the takings from the cashier
 *               to the entrance escorted by guards. Opportunistic robbers may
 *               spawn during the run and try to intercept the convoy.
 *   'counter' — card counter sitting at a dealer table, silently draining the
 *               house every second until ejected.
 *   'angry'   — guest makes a scene and tanks nearby guests' patience until
 *               security handles it or the player clicks.
 *   'vip'     — celebrity arrival that opens a time-boxed high-earning window.
 *
 * All cadence / reward / penalty numbers come from CONFIG.liveEvents.
 * A handful of derived pacing constants that CONFIG does not define live in the
 * single TUNING block below (never scattered through the logic).
 */

import { CONFIG, VENUES, STAFF } from '../core/config.js';
import { bus, toast } from '../core/events.js';
import { state } from '../core/state.js';
import { incomeRate, addMoney, fmtMoney } from '../core/economy.js';

/* ------------------------------------------------------------------ *
 *  Config shortcuts + local derived pacing constants
 * ------------------------------------------------------------------ */

const LE = (CONFIG && CONFIG.liveEvents) || {};
const TYPE_DEFS = LE.types || {};

/** The five types, in spec order. */
export const LIVE_EVENT_TYPES = ['thief', 'brinks', 'counter', 'angry', 'vip'];

/** Types the staff can resolve on their own. */
const AUTO_CATCHABLE = { thief: true, counter: true, angry: true };

/**
 * Pacing values CONFIG.liveEvents does not carry. Kept in one block on purpose
 * so balance still lives in a single readable place per module.
 */
const TUNING = {
  /** Seconds one point of "guard power" needs to fully handle an actor. */
  guardSecondsPerCatch: 7,
  /** Bonus when an actual guard sprite stands within the response radius. */
  proximityBonus: 1.9,
  /** Bonus once the cameras have flagged the actor. */
  flaggedBonus: 2.2,
  /** Staff catches pay this fraction of the player-click reward. */
  autoRewardFraction: 0.55,
  /** How long a resolved actor lingers so the renderer can flash it. */
  caughtLinger: 0.9,
  /** Grace period before the very first event of a session. */
  spawnGrace: 6,
  /** Wander radius (world px) for the angry guest. */
  wanderRadius: 46,
  /** Base chance a brinks run attracts a robber (scaled down by guard power). */
  robberChance: 0.6,
  robberDelayMin: 1.5,
  robberDelayMax: 5,
  /** Distance (world px) at which a robber snatches the convoy. */
  robberStealRadius: 18,
  /** Porters walking the cash. */
  porters: 2,
  /** Distance (world px) considered "arrived". */
  arriveEpsilon: 5,
  /** Clicking a big convoy is easier than clicking a running thief. */
  brinksClickScale: 1.4,
  /** The world must hold at least this many seconds of income to be worth a pickup. */
  brinksMinMoneySeconds: 30,
  /** Never spawn anything before the branch has this many placed venues. */
  minVenues: 1
};

/** Hebrew UI strings for this module. */
const TEXT = {
  thiefSpawn: 'גנב חוטף שק מזומנים!',
  thiefPlayer: (m) => 'תפסת את הגנב! +' + m,
  thiefStaff: (m) => 'המאבטחים תפסו את הגנב! +' + m,
  thiefEscape: (m) => 'הגנב ברח עם ' + m,
  flagged: 'המצלמות זיהו פעילות חשודה!',

  brinksSpawn: 'ברינקס הגיע לאסוף את הקופה.',
  brinksDone: (m) => 'הקופה הועברה בבטחה. +' + m,
  brinksEscort: (m) => 'ליווית את הסבלים עד היציאה! +' + m,
  brinksRobbed: (m) => 'שוד! הברינקס נשדד ונלקחו ' + m,
  robberSpawn: 'שודד מנסה לחטוף את המשלוח!',
  robberStopped: (m) => 'השוד סוכל! +' + m,

  counterSpawn: 'חשד לספירת קלפים באחד השולחנות...',
  counterPlayer: (m) => 'סילקת את סופר הקלפים! +' + m,
  counterStaff: (m) => 'האבטחה סילקה את סופר הקלפים. +' + m,
  counterEscape: (m) => 'סופר הקלפים התחמק עם ' + m,

  angrySpawn: 'לקוח זועם עושה סצנה!',
  angryPlayer: (m) => 'הרגעת את הלקוח הזועם. +' + m,
  angryStaff: (m) => 'האבטחה הרגיעה את הלקוח הזועם. +' + m,
  angryEscape: (m) => 'הלקוח הזועם הרס את האווירה. -' + m,

  vipSpawn: 'סלבריטי הגיע לקזינו!',
  vipEscort: (m, x, s) => 'ליווית את ה-VIP! ×' + x + ' הכנסה ל-' + s + ' שניות. +' + m,
  vipLeft: 'ה-VIP עזב בלי שקיבל יחס.'
};

/* ------------------------------------------------------------------ *
 *  Small numeric / safety helpers
 * ------------------------------------------------------------------ */

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function randRange(lo, hi) {
  if (!(hi > lo)) return lo;
  return lo + Math.random() * (hi - lo);
}

function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)] || arr[0];
}

/** economy.incomeRate, never throwing, never NaN. */
function rateOf(w) {
  if (!w) return 0;
  try {
    const v = incomeRate(w);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch (err) {
    return 0;
  }
}

/** economy.addMoney with a local fallback so a failure never breaks the loop. */
function grant(w, amount) {
  if (!w) return 0;
  const amt = Math.round(num(amount, 0));
  if (amt === 0) return 0;
  try {
    addMoney(w, amt);
  } catch (err) {
    w.money = Math.max(0, num(w.money, 0) + amt);
    bus.emit('money:changed', { worldId: w.id, money: w.money });
  }
  return amt;
}

/** economy.fmtMoney with a plain fallback. */
function money(n) {
  try {
    const s = fmtMoney(n);
    if (typeof s === 'string' && s.length > 0) return s;
  } catch (err) {
    /* fall through */
  }
  return String(Math.round(num(n, 0)));
}

/** Reward for handling an actor: incomeRate * rewardSeconds, clamped. */
function rewardFor(w, def) {
  if (!def) return 0;
  const raw = rateOf(w) * num(def.rewardSeconds, 0);
  const lo = Math.max(0, num(def.rewardMin, 0));
  const hi = num(def.rewardMax, Number.MAX_SAFE_INTEGER);
  return Math.floor(clamp(Math.max(raw, lo), lo, Math.max(lo, hi)));
}

/** Penalty for letting an actor get away: money * fraction, clamped by wallet. */
function penaltyFor(w, def) {
  if (!w || !def) return 0;
  const wallet = Math.max(0, num(w.money, 0));
  const frac = Math.max(0, num(def.penaltyFraction, 0));
  if (frac <= 0 && num(def.penaltyMin, 0) <= 0) return 0;
  let p = Math.max(wallet * frac, num(def.penaltyMin, 0));
  p = Math.min(p, wallet);
  return Math.floor(Math.max(0, p));
}

/** Start / extend the global income boost (used by the VIP window). */
function startIncomeBoost(mult, seconds) {
  const m = num(mult, 1);
  const s = num(seconds, 0);
  if (m <= 1 || s <= 0) return;
  const boosts = state && state.boosts;
  const now = Date.now();
  if (boosts && boosts.income) {
    const b = boosts.income;
    const active = num(b.until, 0) > now && num(b.mult, 1) > 1;
    if (active && num(b.mult, 1) >= m) {
      b.until = num(b.until, now) + s * 1000;
    } else {
      b.mult = m;
      b.until = now + s * 1000;
    }
  }
  bus.emit('boost:started', { kind: 'income', mult: m, seconds: s });
}

/* ------------------------------------------------------------------ *
 *  Layout helpers (tolerant to grid-cell OR pixel coordinates)
 * ------------------------------------------------------------------ */

function tileSize(layout) {
  const t = num(layout && layout.tile, num(CONFIG.grid && CONFIG.grid.tile, 32));
  return t > 0 ? t : 32;
}

/**
 * entrance/exit are documented as {x,y}; layout.slots rects are grid cells.
 * Accept either unit by treating a value that fits inside the grid as a cell.
 */
function toPixels(pt, layout) {
  if (!pt) return null;
  const t = tileSize(layout);
  const cols = num(layout && layout.cols, num(CONFIG.grid && CONFIG.grid.cols, 30));
  const rows = num(layout && layout.rows, num(CONFIG.grid && CONFIG.grid.rows, 20));
  let x = num(pt.x, NaN);
  let y = num(pt.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x <= cols && y <= rows) {
    x = (x + 0.5) * t;
    y = (y + 0.5) * t;
  }
  return { x, y };
}

function slotCenter(slot, layout) {
  if (!slot) return null;
  const t = tileSize(layout);
  const x = num(slot.x, NaN);
  const y = num(slot.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const w = Math.max(1, num(slot.w, 1));
  const h = Math.max(1, num(slot.h, 1));
  return { x: (x + w / 2) * t, y: (y + h / 2) * t };
}

/* ------------------------------------------------------------------ *
 *  LiveEventSim
 * ------------------------------------------------------------------ */

let NEXT_ID = 1;

export class LiveEventSim {
  /**
   * @param {object} worldState per-world state block
   * @param {object} worldDef   entry from WORLDS
   * @param {object} layout     result of buildLayout()
   * @param {object} [staffSim] StaffSim instance (optional; used for guard proximity)
   */
  constructor(worldState, worldDef, layout, staffSim) {
    this.world = worldState || null;
    this.def = worldDef || null;
    this.staffSim = staffSim || null;
    /** Optional: wired by the integrator so 'angry' can drain guest patience. */
    this.guestSim = null;

    this.layout = null;
    this._actors = [];
    this._timer = num(TUNING.spawnGrace, 6);
    this._elapsed = 0;

    this.setLayout(layout);
  }

  /* ---------------- wiring ---------------- */

  /** Called whenever buildLayout() re-runs. Re-anchors static actors. */
  setLayout(layout) {
    this.layout = layout && typeof layout === 'object' ? layout : null;
    if (!this.layout) return;
    for (const a of this._actors) {
      if (a.type === 'counter') {
        const p = this._randomDealerTable();
        if (p) {
          a.x = p.x;
          a.y = p.y;
          a.tx = p.x;
          a.ty = p.y;
        }
      }
      this._clampToWorld(a);
    }
  }

  /** Optional hook: lets the angry guest actually drain nearby guests' patience. */
  setGuestSim(sim) {
    this.guestSim = sim && typeof sim === 'object' ? sim : null;
  }

  /** Optional hook: swap the staff sim used for guard-proximity lookups. */
  setStaffSim(sim) {
    this.staffSim = sim && typeof sim === 'object' ? sim : null;
  }

  /** Live array of actors: {id, type, x, y, ttl, caught, label, ...}. */
  get actors() {
    return this._actors;
  }

  /** 0..1 atmosphere factor (drops while an angry guest is unhandled). */
  get ambience() {
    let mood = 1;
    for (const a of this._actors) {
      if (a.type === 'angry' && !a.resolved) mood -= 0.25;
    }
    return clamp(mood, 0, 1);
  }

  /** Drop every actor (world switch / reset). */
  clear() {
    this._actors.length = 0;
    this._timer = num(TUNING.spawnGrace, 6);
  }

  /* ---------------- main loop ---------------- */

  update(dt) {
    const step = clamp(num(dt, 0), 0, 0.25);
    if (step <= 0) return;
    const w = this.world;
    if (!w || w.unlocked !== true) return;

    this._elapsed += step;

    // --- spawning ---
    if (this.layout) {
      this._timer -= step;
      if (this._timer <= 0) {
        if (this._liveCount() < Math.max(1, num(LE.maxConcurrent, 4))) this._trySpawn();
        this._scheduleNext();
      }
    }

    // --- actor updates ---
    for (let i = this._actors.length - 1; i >= 0; i--) {
      const a = this._actors[i];
      if (!a) {
        this._actors.splice(i, 1);
        continue;
      }
      if (a.resolved) {
        a.removeIn -= step;
        if (a.removeIn <= 0) this._actors.splice(i, 1);
        continue;
      }

      a.ttl -= step;
      a.age += step;
      a.phase += step;

      try {
        this._updateActor(a, step);
      } catch (err) {
        // A misbehaving actor must never kill the frame.
        a.resolved = true;
        a.removeIn = 0;
      }

      if (!a.resolved && a.ttl <= 0) this._expire(a);
    }
  }

  /* ---------------- clicking ---------------- */

  /**
   * @param {number} px world-pixel x
   * @param {number} py world-pixel y
   * @returns {object|null} actor under the cursor
   */
  hitTest(px, py) {
    const x = num(px, NaN);
    const y = num(py, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const base = Math.max(6, num(LE.clickRadius, 22));

    let best = null;
    let bestD = Infinity;
    for (const a of this._actors) {
      if (!a || a.resolved) continue;
      const r = a.type === 'brinks' ? base * num(TUNING.brinksClickScale, 1.4) : base;
      const dx = a.x - x;
      const dy = a.y - y;
      const d = dx * dx + dy * dy;
      if (d <= r * r && d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  /**
   * Player resolved an actor by clicking it.
   * @param {object} actor
   * @returns {boolean} true when it counted
   */
  resolve(actor) {
    if (!actor || actor.resolved) return false;
    if (this._actors.indexOf(actor) === -1) return false;
    const w = this.world;
    if (!w) return false;
    const def = TYPE_DEFS[actor.type] || {};

    if (actor.type === 'vip') {
      const reward = rewardFor(w, def);
      const mult = num(def.boostMult, 2);
      const secs = num(def.boostSeconds, 30);
      grant(w, reward);
      startIncomeBoost(mult, secs);
      this._finish(actor, true, reward, TEXT.vipEscort(money(reward), mult, Math.round(secs)), 'good');
      return true;
    }

    if (actor.type === 'brinks') {
      const reward = rewardFor(w, def);
      grant(w, reward);
      this._finish(actor, true, reward, TEXT.brinksEscort(money(reward)), 'good');
      return true;
    }

    if (actor.type === 'counter') {
      const reward = rewardFor(w, def);
      grant(w, reward);
      this._finish(actor, true, reward, TEXT.counterPlayer(money(reward)), 'good');
      return true;
    }

    if (actor.type === 'angry') {
      const reward = rewardFor(w, def);
      grant(w, reward);
      this._finish(actor, true, reward, TEXT.angryPlayer(money(reward)), 'good');
      return true;
    }

    // thief (including the brinks robber variant)
    const reward = rewardFor(w, def);
    grant(w, reward);
    const text = actor.variant === 'robber'
      ? TEXT.robberStopped(money(reward))
      : TEXT.thiefPlayer(money(reward));
    this._finish(actor, true, reward, text, 'good');
    return true;
  }

  /* ---------------- spawning ---------------- */

  _liveCount() {
    let n = 0;
    for (const a of this._actors) if (a && !a.resolved) n++;
    return n;
  }

  _venueCount() {
    const w = this.world;
    if (!w || !w.venues) return 0;
    let n = 0;
    for (const key of Object.keys(w.venues)) {
      const entry = w.venues[key];
      n += Math.max(0, num(entry && entry.count, 0));
    }
    return n;
  }

  _scheduleNext() {
    const shrink = num(LE.intervalPerVenue, 0.35) * this._venueCount();
    const floor = Math.max(1, num(LE.minIntervalFloor, 9));
    const lo = Math.max(floor, num(LE.minInterval, 22) - shrink);
    const hi = Math.max(lo + 1, num(LE.maxInterval, 48) - shrink);
    this._timer = randRange(lo, hi);
  }

  /** Weighted pick among the types that make sense right now. */
  _trySpawn() {
    const w = this.world;
    if (!w || this._venueCount() < num(TUNING.minVenues, 1)) return null;

    const pool = [];
    let total = 0;
    for (const type of LIVE_EVENT_TYPES) {
      const def = TYPE_DEFS[type];
      if (!def) continue;
      if (!this._eligible(type)) continue;
      const weight = Math.max(0, num(def.weight, 0));
      if (weight <= 0) continue;
      total += weight;
      pool.push({ type, weight });
    }
    if (pool.length === 0 || total <= 0) return null;

    let roll = Math.random() * total;
    let chosen = pool[pool.length - 1].type;
    for (const entry of pool) {
      roll -= entry.weight;
      if (roll <= 0) {
        chosen = entry.type;
        break;
      }
    }
    return this._spawn(chosen);
  }

  _eligible(type) {
    const w = this.world;
    if (!w) return false;
    if (type === 'counter') return this._dealerTables().length > 0;
    if (type === 'brinks') {
      if (this._cashPoints().length === 0) return false;
      // Only worth collecting once the branch actually holds some takings.
      const threshold = rateOf(w) * num(TUNING.brinksMinMoneySeconds, 30);
      return num(w.money, 0) >= threshold;
    }
    if (type === 'thief') return this._cashPoints().length > 0;
    if (type === 'angry') return this._venuePoints().length > 0;
    if (type === 'vip') return true;
    return false;
  }

  _spawn(type) {
    const def = TYPE_DEFS[type];
    if (!def) return null;

    let actor = null;
    if (type === 'thief') actor = this._spawnThief(def, null);
    else if (type === 'brinks') actor = this._spawnBrinks(def);
    else if (type === 'counter') actor = this._spawnCounter(def);
    else if (type === 'angry') actor = this._spawnAngry(def);
    else if (type === 'vip') actor = this._spawnVip(def);
    if (!actor) return null;

    this._actors.push(actor);
    bus.emit('liveEvent:spawn', {
      worldId: this.world ? this.world.id : 0,
      type: actor.type,
      id: actor.id
    });
    if (actor.spawnText) toast(actor.spawnText, actor.spawnKind || 'info');
    return actor;
  }

  _makeActor(type, def, pos) {
    const ttl = Math.max(1, num(def.ttl, 10));
    const p = pos || this._centerPoint();
    const a = {
      id: NEXT_ID++,
      type,
      label: typeof def.label === 'string' ? def.label : type,
      color: typeof def.color === 'string' ? def.color : '#ffffff',
      x: p.x,
      y: p.y,
      tx: p.x,
      ty: p.y,
      ax: p.x,
      ay: p.y,
      speed: Math.max(0, num(def.speed, 0)),
      ttl,
      maxTtl: ttl,
      age: 0,
      phase: Math.random() * Math.PI * 2,
      caught: false,
      escaped: false,
      success: false,
      resolved: false,
      flagged: false,
      progress: 0,
      drained: 0,
      variant: '',
      removeIn: num(TUNING.caughtLinger, 0.9),
      spawnText: '',
      spawnKind: 'info'
    };
    this._clampToWorld(a);
    return a;
  }

  _spawnThief(def, convoy) {
    const from = convoy ? this._nearEdgePoint() : pickRandom(this._cashPoints());
    const a = this._makeActor('thief', def, from || this._centerPoint());
    const exit = this._exitPoint();
    a.tx = exit.x;
    a.ty = exit.y;
    a.carrying = true;
    if (convoy) {
      a.variant = 'robber';
      a.label = 'שודד';
      a.chase = convoy.id;
      a.spawnText = TEXT.robberSpawn;
      a.spawnKind = 'bad';
    } else {
      a.spawnText = TEXT.thiefSpawn;
      a.spawnKind = 'bad';
    }
    return a;
  }

  _spawnBrinks(def) {
    const from = pickRandom(this._cashPoints()) || this._centerPoint();
    const a = this._makeActor('brinks', def, from);
    const entrance = this._entrancePoint();
    a.tx = entrance.x;
    a.ty = entrance.y;
    a.spawnText = TEXT.brinksSpawn;
    a.spawnKind = 'info';

    const guards = this._guardStats();
    a.escorts = Math.min(Math.max(0, Math.floor(guards.count)), num(TUNING.porters, 2) + 1);
    a.porters = [];
    const porterCount = Math.max(1, num(TUNING.porters, 2));
    for (let i = 0; i < porterCount; i++) {
      a.porters.push({ x: a.x, y: a.y, offset: (i + 1) * 9 });
    }

    // Opportunistic robber: less likely the better the security detail.
    const chance = num(TUNING.robberChance, 0.6) / (1 + guards.power);
    a.robberIn = Math.random() < chance
      ? randRange(num(TUNING.robberDelayMin, 1.5), num(TUNING.robberDelayMax, 5))
      : -1;
    a.robbed = false;
    return a;
  }

  _spawnCounter(def) {
    const table = pickRandom(this._dealerTables());
    if (!table) return null;
    const a = this._makeActor('counter', def, table);
    a.speed = 0;
    a.tableKey = table.key || '';
    a.spawnText = TEXT.counterSpawn;
    a.spawnKind = 'info';
    return a;
  }

  _spawnAngry(def) {
    const spot = pickRandom(this._venuePoints()) || this._centerPoint();
    const a = this._makeActor('angry', def, spot);
    a.ax = spot.x;
    a.ay = spot.y;
    a.spawnText = TEXT.angrySpawn;
    a.spawnKind = 'bad';
    return a;
  }

  _spawnVip(def) {
    const entrance = this._entrancePoint();
    const a = this._makeActor('vip', def, entrance);
    const dest = this._vipDestination();
    a.tx = dest.x;
    a.ty = dest.y;
    a.spawnText = TEXT.vipSpawn;
    a.spawnKind = 'good';
    return a;
  }

  /* ---------------- per-actor behaviour ---------------- */

  _updateActor(a, dt) {
    if (a.type === 'thief') return this._updateThief(a, dt);
    if (a.type === 'brinks') return this._updateBrinks(a, dt);
    if (a.type === 'counter') return this._updateCounter(a, dt);
    if (a.type === 'angry') return this._updateAngry(a, dt);
    if (a.type === 'vip') return this._updateVip(a, dt);
    return undefined;
  }

  _updateThief(a, dt) {
    // A robber chases the convoy; a plain thief bolts for the exit.
    if (a.chase) {
      const convoy = this._actorById(a.chase);
      if (convoy && !convoy.resolved) {
        a.tx = convoy.x;
        a.ty = convoy.y;
      } else {
        a.chase = 0;
        const exit = this._exitPoint();
        a.tx = exit.x;
        a.ty = exit.y;
      }
    }

    const arrived = this._moveToward(a, dt);
    this._autoProgress(a, dt);
    if (a.resolved) return;

    if (a.chase) {
      const convoy = this._actorById(a.chase);
      if (convoy && !convoy.resolved && this._dist(a, convoy) <= num(TUNING.robberStealRadius, 18)) {
        this._robConvoy(convoy);
        // The robber gets away with the loot immediately (_robConvoy already toasted).
        a.escaped = true;
        this._finish(a, false, 0, '', 'bad');
      }
      return;
    }

    if (arrived) this._expire(a);
  }

  _updateBrinks(a, dt) {
    const arrived = this._moveToward(a, dt);

    // Porters trail behind the truck.
    if (Array.isArray(a.porters)) {
      for (const p of a.porters) {
        const dx = a.x - p.x;
        const dy = a.y - p.y;
        const d = Math.hypot(dx, dy);
        const want = num(p.offset, 9);
        if (d > want) {
          const k = ((d - want) / d) * Math.min(1, dt * 6);
          p.x += dx * k;
          p.y += dy * k;
        }
      }
    }

    if (a.robberIn > 0) {
      a.robberIn -= dt;
      if (a.robberIn <= 0) {
        a.robberIn = -1;
        if (this._liveCount() < Math.max(1, num(LE.maxConcurrent, 4))) {
          const thiefDef = TYPE_DEFS.thief;
          if (thiefDef) {
            const robber = this._spawnThief(thiefDef, a);
            if (robber) {
              this._actors.push(robber);
              bus.emit('liveEvent:spawn', {
                worldId: this.world ? this.world.id : 0,
                type: robber.type,
                id: robber.id
              });
              toast(robber.spawnText, robber.spawnKind);
            }
          }
        }
      }
    }

    if (arrived && !a.robbed) this._expire(a);
  }

  _updateCounter(a, dt) {
    const w = this.world;
    const def = TYPE_DEFS.counter || {};
    const drainFrac = Math.max(0, num(def.drainPerSecond, 0));
    if (w && drainFrac > 0) {
      const amount = rateOf(w) * drainFrac * dt;
      const take = Math.min(Math.max(0, num(w.money, 0)), amount);
      if (take > 0.5) {
        grant(w, -Math.floor(take));
        a.drained += Math.floor(take);
      }
    }
    this._autoProgress(a, dt);
  }

  _updateAngry(a, dt) {
    const def = TYPE_DEFS.angry || {};

    // Slow agitated shuffle around the spot where the scene started.
    const r = num(TUNING.wanderRadius, 46);
    a.tx = a.ax + Math.cos(a.phase * 0.9) * r;
    a.ty = a.ay + Math.sin(a.phase * 1.3) * r * 0.6;
    this._moveToward(a, dt);

    // Tank the patience of everyone standing nearby.
    const radius = Math.max(1, num(def.moodRadius, 120));
    const drain = Math.max(0, num(def.moodDrain, 9)) * dt;
    if (drain > 0) {
      const guests = this._guests();
      for (const g of guests) {
        if (!g || !Number.isFinite(g.patience)) continue;
        const dx = g.x - a.x;
        const dy = g.y - a.y;
        if (dx * dx + dy * dy <= radius * radius) {
          g.patience = Math.max(0, g.patience - drain);
        }
      }
    }

    this._autoProgress(a, dt);
  }

  _updateVip(a, dt) {
    const arrived = this._moveToward(a, dt);
    if (!arrived) return;

    // First arrival: re-anchor here, then mill about until the window closes.
    if (a.settled !== true) {
      a.settled = true;
      a.ax = a.x;
      a.ay = a.y;
    }
    const r = num(TUNING.wanderRadius, 46) * 0.5;
    a.tx = a.ax + Math.cos(a.phase) * r;
    a.ty = a.ay + Math.sin(a.phase * 1.7) * r;
  }

  /* ---------------- resolution paths ---------------- */

  /** Guards + cameras working the floor without the player. */
  _autoProgress(a, dt) {
    if (!AUTO_CATCHABLE[a.type]) return;
    const g = this._guardStats();
    const c = this._cameraStats();

    if (!a.flagged && c.count > 0) {
      const perSecond =
        (num(LE.cameraAutoChance, 0.02) +
          num(LE.cameraAutoChancePerLevel, 0.012) * Math.max(0, c.level - 1)) *
        c.count;
      if (Math.random() < perSecond * dt) {
        a.flagged = true;
        if (a.type !== 'angry') toast(TEXT.flagged, 'info');
      }
    }

    if (g.count <= 0 || g.power <= 0) return;

    let rate = g.power / Math.max(0.5, num(TUNING.guardSecondsPerCatch, 7));
    const radius =
      num(LE.guardRadius, 90) + num(LE.guardRadiusPerLevel, 14) * Math.max(0, g.level - 1);
    if (this._nearestGuardDist(a) <= radius) rate *= num(TUNING.proximityBonus, 1.9);
    if (a.flagged) rate *= num(TUNING.flaggedBonus, 2.2);

    a.progress += rate * dt;
    if (a.progress >= 1) this._resolveAuto(a);
  }

  _resolveAuto(a) {
    const w = this.world;
    const def = TYPE_DEFS[a.type] || {};
    const reward = Math.floor(rewardFor(w, def) * num(TUNING.autoRewardFraction, 0.55));
    grant(w, reward);

    let text = '';
    if (a.type === 'thief') {
      text = a.variant === 'robber' ? TEXT.robberStopped(money(reward)) : TEXT.thiefStaff(money(reward));
    } else if (a.type === 'counter') {
      text = TEXT.counterStaff(money(reward));
    } else {
      text = TEXT.angryStaff(money(reward));
    }
    this._finish(a, true, reward, text, 'good');
  }

  /** TTL ran out (or the actor reached its goal) with nobody stopping it. */
  _expire(a) {
    const w = this.world;
    const def = TYPE_DEFS[a.type] || {};

    if (a.type === 'vip') {
      this._finish(a, false, 0, TEXT.vipLeft, 'info');
      return;
    }

    if (a.type === 'brinks') {
      // Made it to the entrance: the takings are banked.
      const reward = rewardFor(w, def);
      grant(w, reward);
      this._finish(a, false, reward, TEXT.brinksDone(money(reward)), 'good');
      return;
    }

    if (a.type === 'counter') {
      const loss = penaltyFor(w, def);
      grant(w, -loss);
      const total = Math.floor(num(a.drained, 0) + loss);
      this._finish(a, false, -loss, TEXT.counterEscape(money(total)), 'bad');
      return;
    }

    if (a.type === 'angry') {
      const loss = penaltyFor(w, def);
      grant(w, -loss);
      this._finish(a, false, -loss, TEXT.angryEscape(money(loss)), 'bad');
      return;
    }

    // thief / robber escaping
    const loss = penaltyFor(w, def);
    grant(w, -loss);
    a.escaped = true;
    this._finish(a, false, -loss, TEXT.thiefEscape(money(loss)), 'bad');
  }

  /** A robber intercepted the convoy. */
  _robConvoy(convoy) {
    if (!convoy || convoy.resolved) return;
    const w = this.world;
    const def = TYPE_DEFS.brinks || {};
    const loss = penaltyFor(w, def);
    grant(w, -loss);
    convoy.robbed = true;
    this._finish(convoy, false, -loss, TEXT.brinksRobbed(money(loss)), 'bad');
  }

  /** Shared bookkeeping for every resolution path. */
  _finish(a, caught, reward, text, kind) {
    a.caught = caught === true;
    /** Renderer hint: green flash vs red flash (a safe brinks run is a win too). */
    a.success = num(reward, 0) >= 0 && a.escaped !== true;
    a.resolved = true;
    a.removeIn = num(TUNING.caughtLinger, 0.9);
    a.ttl = Math.max(0, a.ttl);
    bus.emit('liveEvent:resolved', {
      worldId: this.world ? this.world.id : 0,
      type: a.type,
      id: a.id,
      reward: num(reward, 0)
    });
    if (text) toast(text, kind || 'info');
  }

  /* ---------------- movement + geometry ---------------- */

  _moveToward(a, dt) {
    const speed = Math.max(0, num(a.speed, 0));
    if (speed <= 0) return true;
    const dx = num(a.tx, a.x) - a.x;
    const dy = num(a.ty, a.y) - a.y;
    const d = Math.hypot(dx, dy);
    const eps = num(TUNING.arriveEpsilon, 5);
    if (d <= eps) return true;
    const stepLen = Math.min(d, speed * dt);
    a.x += (dx / d) * stepLen;
    a.y += (dy / d) * stepLen;
    this._clampToWorld(a);
    return d - stepLen <= eps;
  }

  _dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _clampToWorld(a) {
    const layout = this.layout;
    const t = tileSize(layout);
    const cols = Math.max(2, num(layout && layout.cols, num(CONFIG.grid && CONFIG.grid.cols, 30)));
    const rows = Math.max(2, num(layout && layout.rows, num(CONFIG.grid && CONFIG.grid.rows, 20)));
    a.x = clamp(num(a.x, t), t * 0.5, (cols - 0.5) * t);
    a.y = clamp(num(a.y, t), t * 0.5, (rows - 0.5) * t);
  }

  _centerPoint() {
    const layout = this.layout;
    const t = tileSize(layout);
    const cols = num(layout && layout.cols, num(CONFIG.grid && CONFIG.grid.cols, 30));
    const rows = num(layout && layout.rows, num(CONFIG.grid && CONFIG.grid.rows, 20));
    return { x: (cols / 2) * t, y: (rows / 2) * t };
  }

  _entrancePoint() {
    const p = toPixels(this.layout && this.layout.entrance, this.layout);
    return p || this._centerPoint();
  }

  _exitPoint() {
    const p = toPixels(this.layout && this.layout.exit, this.layout);
    return p || this._entrancePoint();
  }

  /** A point just inside the walls, used as a robber's approach spot. */
  _nearEdgePoint() {
    const layout = this.layout;
    const t = tileSize(layout);
    const cols = num(layout && layout.cols, 30);
    const rows = num(layout && layout.rows, 20);
    const edge = Math.floor(Math.random() * 2);
    if (edge === 0) return { x: 1.5 * t, y: randRange(1.5, Math.max(2, rows - 1.5)) * t };
    return { x: (cols - 1.5) * t, y: randRange(1.5, Math.max(2, rows - 1.5)) * t };
  }

  /** Pixel centers of every placed instance, filtered by a predicate on the slot. */
  _slotPoints(predicate) {
    const layout = this.layout;
    const out = [];
    if (!layout || !Array.isArray(layout.slots)) return out;
    for (const s of layout.slots) {
      if (!s || typeof s.key !== 'string') continue;
      let ok = false;
      try {
        ok = predicate(s) === true;
      } catch (err) {
        ok = false;
      }
      if (!ok) continue;

      let p = null;
      if (typeof layout.nodeFor === 'function') {
        try {
          const n = layout.nodeFor(s.kind, s.key, num(s.index, 0));
          if (n && Number.isFinite(Number(n.x)) && Number.isFinite(Number(n.y))) {
            p = { x: Number(n.x), y: Number(n.y) };
          }
        } catch (err) {
          p = null;
        }
      }
      if (!p) p = slotCenter(s, layout);
      if (!p) continue;
      p.key = s.key;
      p.index = num(s.index, 0);
      out.push(p);
    }
    return out;
  }

  /** Cashier / token booth positions — where the money physically is. */
  _cashPoints() {
    let pts = this._slotPoints((s) => s.key === 'cashier');
    if (pts.length === 0) pts = this._slotPoints((s) => s.key === 'tokenBooth');
    if (pts.length === 0) pts = this._slotPoints((s) => !!VENUES[s.key]);
    if (pts.length === 0) {
      const e = this._entrancePoint();
      pts = [{ x: e.x, y: e.y, key: 'entrance', index: 0 }];
    }
    return pts;
  }

  /** Every placed venue instance. */
  _venuePoints() {
    return this._slotPoints((s) => !!VENUES[s.key]);
  }

  /** Venue instances that require a dealer — where a counter can sit. */
  _dealerTables() {
    return this._slotPoints((s) => {
      const def = VENUES[s.key];
      return !!def && def.needsDealer === true;
    });
  }

  _randomDealerTable() {
    return pickRandom(this._dealerTables());
  }

  /** Where a celebrity heads: VIP room if built, else the flashiest table. */
  _vipDestination() {
    const vipRooms = this._slotPoints((s) => s.key === 'vip');
    if (vipRooms.length > 0) return pickRandom(vipRooms);
    const tables = this._dealerTables();
    if (tables.length > 0) return pickRandom(tables);
    const venues = this._venuePoints();
    if (venues.length > 0) return pickRandom(venues);
    return this._centerPoint();
  }

  /* ---------------- staff lookups ---------------- */

  _guardStats() {
    const w = this.world;
    const entry = (w && w.staff && w.staff.guards) || null;
    const def = STAFF.guards || {};
    const count = Math.max(0, Math.floor(num(entry && entry.count, 0)));
    const level = Math.max(1, Math.floor(num(entry && entry.level, 1)));
    const per = num(def.effectPerLevel, 0.12);
    const base = num(def.baseEffect, 1);
    return { count, level, power: count * (base + per * (level - 1)) };
  }

  _cameraStats() {
    const w = this.world;
    const entry = (w && w.staff && w.staff.cameras) || null;
    const count = Math.max(0, Math.floor(num(entry && entry.count, 0)));
    const level = Math.max(1, Math.floor(num(entry && entry.level, 1)));
    return { count, level };
  }

  _nearestGuardDist(a) {
    const sim = this.staffSim;
    if (!sim) return Infinity;
    let workers = null;
    try {
      workers = sim.workers;
    } catch (err) {
      return Infinity;
    }
    if (!Array.isArray(workers) || workers.length === 0) return Infinity;
    let best = Infinity;
    for (const wk of workers) {
      if (!wk || wk.role !== 'guard') continue;
      const dx = num(wk.x, NaN) - a.x;
      const dy = num(wk.y, NaN) - a.y;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
      const d = Math.hypot(dx, dy);
      if (d < best) best = d;
    }
    return best;
  }

  _guests() {
    const sim = this.guestSim;
    if (!sim) return [];
    let list = null;
    try {
      list = sim.guests;
    } catch (err) {
      return [];
    }
    return Array.isArray(list) ? list : [];
  }

  _actorById(id) {
    for (const a of this._actors) {
      if (a && a.id === id) return a;
    }
    return null;
  }
}

export default LiveEventSim;
