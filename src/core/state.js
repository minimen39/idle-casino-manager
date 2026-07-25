/**
 * state.js — the single source of runtime truth + persistence.
 *
 * IMPORTANT: this module must NOT import economy.js (economy.js imports state.js).
 * To estimate offline earnings we accept an injected estimator:
 *     import { setIncomeEstimator } from './state.js';
 *     setIncomeEstimator(incomeRate);
 */

import { CONFIG, WORLDS, VENUES, STATIONS, STAFF, SYSTEMS } from './config.js';
import { bus } from './events.js';

/* ------------------------------------------------------------------ *
 *  Income estimator injection (breaks the state <-> economy cycle)
 * ------------------------------------------------------------------ */

/** @type {null | ((worldState:any)=>number)} */
export let incomeEstimator = null;

/**
 * Register the money/sec estimator (economy.incomeRate) at boot time.
 * @param {(worldState:any)=>number} fn
 */
export function setIncomeEstimator(fn) {
  incomeEstimator = typeof fn === 'function' ? fn : null;
}

/** Safe call: never throws, never returns NaN/negative. */
function estimate(worldState) {
  if (!incomeEstimator || !worldState) return 0;
  try {
    const v = incomeEstimator(worldState);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch (err) {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 *  Factories
 * ------------------------------------------------------------------ */

function unitEntry() {
  return { count: 0, level: 1 };
}

/**
 * Build a fresh per-world state block.
 * @param {object} worldDef entry from WORLDS
 */
export function createWorldState(worldDef) {
  const def = worldDef && typeof worldDef === 'object' ? worldDef : WORLDS[0];

  const venues = {};
  for (const key of Object.keys(VENUES)) venues[key] = unitEntry();

  const stations = {};
  for (const key of Object.keys(STATIONS)) stations[key] = unitEntry();

  const staff = {};
  for (const key of Object.keys(STAFF)) staff[key] = unitEntry();

  const systems = {};
  for (const key of Object.keys(SYSTEMS)) systems[key] = { level: 0 };

  const unlocked = def.unlockedByDefault === true;

  const w = {
    id: def.id,
    key: def.key,
    unlocked,
    money: unlocked ? CONFIG.start.money : 0,
    lifetimeEarned: 0,
    tier: 1,
    guestsServed: 0,
    venues,
    stations,
    staff,
    systems
  };

  // World 0 opens with one slot machine + a cashier so the loop runs immediately.
  if (unlocked) {
    if (w.venues.slots) w.venues.slots.count = 1;
    if (w.stations.cashier) w.stations.cashier.count = 1;
    if (w.stations.security) w.stations.security.count = 1;
  }

  return w;
}

/** Build a complete fresh save. */
export function createState() {
  return {
    version: CONFIG.version,
    diamonds: CONFIG.start.diamonds,
    noAds: false,
    activeWorld: 0,
    lastSeen: Date.now(),
    boosts: {
      income: { mult: 1, until: 0 },
      dealer: { mult: 1, until: 0 }
    },
    cooldowns: {
      roulette: 0,
      blackjack: 0
    },
    worlds: WORLDS.map((def) => createWorldState(def))
  };
}

/* ------------------------------------------------------------------ *
 *  Sanitising / migration
 * ------------------------------------------------------------------ */

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nonNegative(v, fallback) {
  const n = num(v, fallback);
  return n < 0 ? 0 : n;
}

function mergeUnitMap(rawMap, defTable, levelOnly) {
  const out = {};
  const raw = rawMap && typeof rawMap === 'object' ? rawMap : {};
  for (const key of Object.keys(defTable)) {
    const src = raw[key] && typeof raw[key] === 'object' ? raw[key] : {};
    if (levelOnly) {
      out[key] = { level: Math.floor(nonNegative(src.level, 0)) };
    } else {
      const def = defTable[key] || {};
      const maxCount = Number.isFinite(def.maxCount) ? def.maxCount : Infinity;
      const count = Math.min(maxCount, Math.floor(nonNegative(src.count, 0)));
      const level = Math.max(1, Math.floor(nonNegative(src.level, 1)));
      out[key] = { count, level };
    }
  }
  return out;
}

/** Rebuild one world block from untrusted data, filling any missing key. */
function migrateWorld(raw, def) {
  const fresh = createWorldState(def);
  if (!raw || typeof raw !== 'object') return fresh;

  return {
    id: def.id,
    key: def.key,
    unlocked: raw.unlocked === true || def.unlockedByDefault === true,
    money: nonNegative(raw.money, fresh.money),
    lifetimeEarned: nonNegative(raw.lifetimeEarned, 0),
    tier: Math.max(1, Math.min(3, Math.floor(num(raw.tier, 1)))),
    guestsServed: Math.floor(nonNegative(raw.guestsServed, 0)),
    venues: mergeUnitMap(raw.venues, VENUES, false),
    stations: mergeUnitMap(raw.stations, STATIONS, false),
    staff: mergeUnitMap(raw.staff, STAFF, false),
    systems: mergeUnitMap(raw.systems, SYSTEMS, true)
  };
}

function migrateBoost(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mult = num(src.mult, 1);
  return {
    mult: mult > 0 ? mult : 1,
    until: nonNegative(src.until, 0)
  };
}

/**
 * Bring any persisted payload up to the current schema.
 * Unknown/older versions are handled by simply filling in defaults.
 * @param {any} raw
 * @returns {object} valid state object
 */
export function migrate(raw) {
  const fresh = createState();
  if (!raw || typeof raw !== 'object') return fresh;

  const worlds = Array.isArray(raw.worlds) ? raw.worlds : [];
  const out = {
    version: CONFIG.version,
    diamonds: nonNegative(raw.diamonds, fresh.diamonds),
    noAds: raw.noAds === true,
    activeWorld: 0,
    lastSeen: nonNegative(raw.lastSeen, Date.now()) || Date.now(),
    boosts: {
      income: migrateBoost(raw.boosts && raw.boosts.income),
      dealer: migrateBoost(raw.boosts && raw.boosts.dealer)
    },
    cooldowns: {
      roulette: nonNegative(raw.cooldowns && raw.cooldowns.roulette, 0),
      blackjack: nonNegative(raw.cooldowns && raw.cooldowns.blackjack, 0)
    },
    worlds: WORLDS.map((def, i) => migrateWorld(worlds[i], def))
  };

  // Always guarantee world 0 exists and is playable.
  if (out.worlds.length > 0) out.worlds[0].unlocked = true;

  // activeWorld must point at an unlocked branch.
  const wanted = Math.floor(num(raw.activeWorld, 0));
  out.activeWorld =
    wanted >= 0 && wanted < out.worlds.length && out.worlds[wanted].unlocked ? wanted : 0;

  return out;
}

/* ------------------------------------------------------------------ *
 *  localStorage persistence (throttled, fully guarded)
 * ------------------------------------------------------------------ */

function storage() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    // Touch it once to surface Safari private-mode errors early.
    const probe = '__idleCasinoProbe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch (err) {
    return null;
  }
}

const store = storage();

let saveTimer = null;
let lastSaveAt = 0;
let dirty = false;

function writeNow() {
  saveTimer = null;
  dirty = false;
  lastSaveAt = Date.now();
  if (!store) return false;
  try {
    state.version = CONFIG.version;
    state.lastSeen = Date.now();
    store.setItem(CONFIG.storageKey, JSON.stringify(state));
    return true;
  } catch (err) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[state] save failed:', err);
    }
    return false;
  }
}

/**
 * Persist the state. Throttled to CONFIG.loop.saveThrottleMs.
 * @param {boolean} [immediate] bypass the throttle (use on unload / hard events)
 */
export function save(immediate) {
  dirty = true;
  const gap = CONFIG.loop.saveThrottleMs;
  const since = Date.now() - lastSaveAt;

  if (immediate === true || since >= gap) {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    return writeNow();
  }

  if (saveTimer === null) {
    saveTimer = setTimeout(writeNow, Math.max(0, gap - since));
  }
  return false;
}

/** Force any pending throttled write out to disk. */
export function flushSave() {
  if (dirty || saveTimer !== null) return save(true);
  return false;
}

/**
 * Read + migrate the persisted state.
 * @returns {object|null} migrated state, or null when there is nothing usable
 */
export function load() {
  if (!store) return null;
  let raw = null;
  try {
    raw = store.getItem(CONFIG.storageKey);
  } catch (err) {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return migrate(parsed);
  } catch (err) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[state] corrupt save discarded:', err);
    }
    return null;
  }
}

/* ------------------------------------------------------------------ *
 *  The live singleton
 * ------------------------------------------------------------------ */

/** @type {any} */
export const state = load() || createState();

/**
 * Wipe progress back to a brand-new game.
 * Mutates the existing `state` object so every module keeps its reference.
 */
export function resetState() {
  const fresh = createState();
  for (const key of Object.keys(state)) delete state[key];
  for (const key of Object.keys(fresh)) state[key] = fresh[key];
  if (store) {
    try {
      store.removeItem(CONFIG.storageKey);
    } catch (err) {
      /* ignore */
    }
  }
  save(true);
  bus.emit('world:switched', { worldId: state.activeWorld });
  bus.emit('money:changed', { worldId: 0, money: state.worlds[0].money });
  bus.emit('diamonds:changed', { diamonds: state.diamonds });
  bus.emit('ui:refresh', {});
  return state;
}

/** The world block the player is currently looking at (never null). */
export function activeWorld() {
  const list = state.worlds;
  if (!Array.isArray(list) || list.length === 0) {
    state.worlds = WORLDS.map((def) => createWorldState(def));
    state.activeWorld = 0;
    return state.worlds[0];
  }
  let idx = Math.floor(Number(state.activeWorld));
  if (!Number.isFinite(idx) || idx < 0 || idx >= list.length || !list[idx]) idx = 0;
  state.activeWorld = idx;
  return list[idx];
}

/** Convenience accessor with bounds guard. */
export function worldById(id) {
  const idx = Math.floor(Number(id));
  if (!Array.isArray(state.worlds)) return null;
  if (!Number.isFinite(idx) || idx < 0 || idx >= state.worlds.length) return null;
  return state.worlds[idx] || null;
}

/** Every unlocked world block. */
export function unlockedWorlds() {
  if (!Array.isArray(state.worlds)) return [];
  return state.worlds.filter((w) => w && w.unlocked);
}

/** Is a timed boost still running? */
export function boostActive(kind) {
  const b = state.boosts && state.boosts[kind];
  if (!b) return false;
  return b.until > Date.now() && b.mult > 1;
}

/** Current multiplier for a boost kind (1 when expired). */
export function boostMult(kind) {
  return boostActive(kind) ? state.boosts[kind].mult : 1;
}

/* ------------------------------------------------------------------ *
 *  Offline progression
 * ------------------------------------------------------------------ */

/**
 * Credit earnings accumulated while the tab was closed.
 * Uses the injected income estimator; without one it grants nothing.
 *
 * @returns {{seconds:number, earnedPerWorld:Array<{worldId:number, amount:number}>, total:number}}
 */
export function grantOffline() {
  const now = Date.now();
  const last = Number.isFinite(state.lastSeen) && state.lastSeen > 0 ? state.lastSeen : now;

  const capSeconds = Math.max(0, CONFIG.offline.capHours * 3600);
  let seconds = (now - last) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  seconds = Math.min(seconds, capSeconds);

  const result = { seconds, earnedPerWorld: [], total: 0 };
  state.lastSeen = now;

  if (seconds < CONFIG.offline.minSeconds) {
    result.seconds = seconds;
    return result;
  }

  const rate = CONFIG.offline.rate;
  const list = Array.isArray(state.worlds) ? state.worlds : [];

  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (!w || !w.unlocked) continue;
    const perSec = estimate(w);
    const amount = Math.floor(perSec * seconds * rate);
    if (amount <= 0) continue;
    w.money += amount;
    w.lifetimeEarned += amount;
    result.earnedPerWorld.push({ worldId: w.id, amount });
    result.total += amount;
    bus.emit('money:changed', { worldId: w.id, money: w.money });
  }

  if (result.total > 0) save();
  return result;
}

/**
 * Re-apply an offline payout multiplier (rewarded ad "double offline").
 * @param {{earnedPerWorld:Array<{worldId:number, amount:number}>, total:number}} report
 * @param {number} multiplier total multiplier (2 = double => grants 1x extra)
 * @returns {number} extra money granted
 */
export function multiplyOfflineReward(report, multiplier) {
  if (!report || !Array.isArray(report.earnedPerWorld)) return 0;
  const mult = Number(multiplier);
  if (!Number.isFinite(mult) || mult <= 1) return 0;

  let extraTotal = 0;
  for (const entry of report.earnedPerWorld) {
    const w = worldById(entry && entry.worldId);
    if (!w) continue;
    const extra = Math.floor((entry.amount || 0) * (mult - 1));
    if (extra <= 0) continue;
    w.money += extra;
    w.lifetimeEarned += extra;
    entry.amount += extra;
    extraTotal += extra;
    bus.emit('money:changed', { worldId: w.id, money: w.money });
  }
  report.total += extraTotal;
  if (extraTotal > 0) save(true);
  return extraTotal;
}

/* ------------------------------------------------------------------ *
 *  Flush on page hide so nothing is lost
 * ------------------------------------------------------------------ */

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('beforeunload', () => {
    try {
      flushSave();
    } catch (err) {
      /* ignore */
    }
  });
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    try {
      if (document.visibilityState === 'hidden') flushSave();
    } catch (err) {
      /* ignore */
    }
  });
}

export default state;
