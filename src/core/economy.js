/**
 * economy.js — money math: costs, purchases, income rate, tiers, formatting,
 * and world-unlock funding. Owns every number-crunching rule that touches
 * the player's wallet. All tuning constants come from CONFIG; nothing here
 * is a magic literal.
 *
 * Cost curve convention (see config.js header):
 *   cost = baseCost * costGrowth ^ currentCount
 *
 * Purchase model for venues/stations/staff (which track {count, level}):
 *   - While count < maxCount, `buy` adds another unit at the standard curve.
 *   - Once count is capped, `buy` instead levels up the existing units.
 *     Level-up cost = (cost of the hypothetical next unit) * levelCostMult
 *     * levelCostGrowth ^ (level - 1), per CONFIG.economy. This keeps a
 *     single `buy(w, kind, key)` entry point working for the whole life of
 *     a purchasable, per the shared contract (no separate "upgrade" export
 *     exists in the contract, so both actions live behind `buy`).
 * Systems only ever track {level} and follow the plain cost curve.
 */

import {
  CONFIG,
  WORLDS,
  VENUES,
  STATIONS,
  STAFF,
  SYSTEMS,
  TIERS,
  VENUE_KEYS,
  STATION_KEYS,
  STAFF_KEYS,
  SYSTEM_KEYS,
  defOf,
  worldDefById
} from './config.js';
import { bus } from './events.js';
import { state, save, boostMult, setIncomeEstimator } from './state.js';
import { dealerCoverage } from '../sim/staff.js';

/* ------------------------------------------------------------------ *
 *  Small internal helpers
 * ------------------------------------------------------------------ */

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Maps a purchase `kind` to the property name on a world-state block. */
function stateKeyForKind(kind) {
  if (kind === 'venue') return 'venues';
  if (kind === 'station') return 'stations';
  if (kind === 'staff') return 'staff';
  if (kind === 'system') return 'systems';
  return null;
}

/** Looks up the live {count,level} / {level} entry for a purchasable. */
function entryFor(w, kind, key) {
  const prop = stateKeyForKind(kind);
  if (!prop || !w || !w[prop]) return null;
  const entry = w[prop][key];
  return entry && typeof entry === 'object' ? entry : null;
}

/* ------------------------------------------------------------------ *
 *  Costs
 * ------------------------------------------------------------------ */

/**
 * Pure cost lookup following the standard curve. `currentCount` is the
 * count (venue/station/staff) or level (system) already owned.
 * @param {'venue'|'station'|'staff'|'system'} kind
 * @param {string} key
 * @param {number} currentCount
 * @returns {number} cost, or Infinity if the definition is unknown
 */
export function costOf(kind, key, currentCount) {
  const def = defOf(kind, key);
  if (!def) return Infinity;
  const c = Math.max(0, Math.floor(Number(currentCount)) || 0);
  const cost = def.baseCost * Math.pow(def.costGrowth, c);
  return Number.isFinite(cost) ? cost : Infinity;
}

/**
 * Resolves what the *next* `buy()` on this purchasable would do:
 * grow its count, level it up, or nothing (fully maxed / unknown).
 * @returns {{type:'count'|'level', cost:number}|null}
 */
function nextPurchaseInfo(w, kind, key) {
  const def = defOf(kind, key);
  const entry = entryFor(w, kind, key);
  if (!def || !entry) return null;

  if (kind === 'system') {
    const maxLevel = Number.isFinite(def.maxLevel) ? def.maxLevel : CONFIG.economy.maxLevel;
    const level = Math.max(0, Math.floor(entry.level) || 0);
    if (level >= maxLevel) return null;
    const cost = costOf('system', key, level);
    return { type: 'level', cost };
  }

  const maxCount = Number.isFinite(def.maxCount) ? def.maxCount : Infinity;
  const count = Math.max(0, Math.floor(entry.count) || 0);
  if (count < maxCount) {
    return { type: 'count', cost: costOf(kind, key, count) };
  }

  const maxLevel = CONFIG.economy.maxLevel;
  const level = Math.max(1, Math.floor(entry.level) || 1);
  if (level < maxLevel) {
    const nextUnitCost = costOf(kind, key, maxCount);
    const cost =
      nextUnitCost *
      CONFIG.economy.levelCostMult *
      Math.pow(CONFIG.economy.levelCostGrowth, level - 1);
    return { type: 'level', cost };
  }

  return null; // fully maxed out
}

/**
 * Can this world currently afford its next purchase/level-up?
 * @param {object} w world-state block
 * @param {'venue'|'station'|'staff'|'system'} kind
 * @param {string} key
 */
export function canAfford(w, kind, key) {
  if (!w) return false;
  const info = nextPurchaseInfo(w, kind, key);
  if (!info) return false;
  return Number.isFinite(w.money) && w.money >= info.cost;
}

/**
 * Buys the next unit, or levels up if the purchasable is count-capped.
 * Mutates `w`, emits 'purchase' + 'money:changed', persists, returns bool.
 */
export function buy(w, kind, key) {
  if (!w) return false;
  const info = nextPurchaseInfo(w, kind, key);
  if (!info) return false;
  if (!Number.isFinite(w.money) || w.money < info.cost) return false;

  const entry = entryFor(w, kind, key);
  if (!entry) return false;

  w.money -= info.cost;
  if (info.type === 'count') {
    entry.count = (Math.floor(entry.count) || 0) + 1;
  } else {
    entry.level = (Math.floor(entry.level) || (kind === 'system' ? 0 : 1)) + 1;
  }

  recomputeTier(w);
  bus.emit('purchase', { worldId: w.id, key, kind });
  bus.emit('money:changed', { worldId: w.id, money: w.money });
  save();
  return true;
}

/* ------------------------------------------------------------------ *
 *  Wallets
 * ------------------------------------------------------------------ */

/**
 * Adds (or subtracts) money from a world, clamped at zero, tracks
 * lifetime earnings on gains, emits 'money:changed'.
 */
export function addMoney(w, amount) {
  if (!w) return;
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt === 0) return;
  w.money = Math.max(0, (Number(w.money) || 0) + amt);
  if (amt > 0) w.lifetimeEarned = (Number(w.lifetimeEarned) || 0) + amt;
  bus.emit('money:changed', { worldId: w.id, money: w.money });
  save();
}

/** Adds (or subtracts) premium diamonds on the global state singleton. */
export function addDiamonds(n) {
  const amt = Math.floor(Number(n) || 0);
  if (amt === 0) return;
  state.diamonds = Math.max(0, (Number(state.diamonds) || 0) + amt);
  bus.emit('diamonds:changed', { diamonds: state.diamonds });
  save();
}

/* ------------------------------------------------------------------ *
 *  Income
 * ------------------------------------------------------------------ */

/**
 * Estimated money/second for a world, folding in venue counts+levels,
 * dealer coverage, service-venue discount, station throughput, systems,
 * active boosts, world incomeMult and visual tier. Safe to call before
 * any sim exists (dealerCoverage failures fall back to full coverage so
 * the HUD/offline estimate never gets stuck at zero because a sibling
 * module hasn't finished loading yet).
 * @param {object} w world-state block
 * @returns {number} money per second, always finite and >= 0
 */
export function incomeRate(w) {
  if (!w || !w.venues) return 0;

  let coverage = 1;
  try {
    const c = dealerCoverage(w);
    if (Number.isFinite(c)) coverage = clamp(c, 0, 1);
  } catch (err) {
    coverage = 1;
  }

  const dealerBoost = boostMult('dealer');
  const globalBoost = boostMult('income');
  const dealerMult = CONFIG.economy.unstaffedOutput + (1 - CONFIG.economy.unstaffedOutput) * coverage;

  let venueTotal = 0;
  for (const key of VENUE_KEYS) {
    const def = VENUES[key];
    const entry = w.venues[key];
    if (!def || !entry) continue;
    const count = Math.max(0, Math.floor(entry.count) || 0);
    if (count <= 0) continue;
    const level = Math.max(1, Math.floor(entry.level) || 1);

    let income = def.baseIncome * Math.pow(def.incomeGrowth, level - 1) * count;
    if (def.needsDealer) income *= dealerMult * dealerBoost;
    if (def.kind === 'service') income *= CONFIG.economy.serviceIncomeMult;
    if (Number.isFinite(income) && income > 0) venueTotal += income;
  }

  if (venueTotal <= 0) return 0;

  let stationLevelSum = 0;
  if (w.stations) {
    for (const key of STATION_KEYS) {
      const entry = w.stations[key];
      if (!entry) continue;
      stationLevelSum += Math.max(0, Math.floor(entry.count) || 0) * Math.max(1, Math.floor(entry.level) || 1);
    }
  }
  const stationMult = 1 + CONFIG.economy.stationIncomeBonus * stationLevelSum;

  let systemsBonus = 0;
  if (w.systems) {
    const hvacLevel = Math.max(0, Math.floor(w.systems.hvac ? w.systems.hvac.level : 0) || 0);
    const lightingLevel = Math.max(0, Math.floor(w.systems.lighting ? w.systems.lighting.level : 0) || 0);
    systemsBonus =
      SYSTEMS.hvac.effectPerLevel * hvacLevel * 0.5 + SYSTEMS.lighting.effectPerLevel * lightingLevel * 0.5;
  }
  const systemsMult = 1 + systemsBonus;

  const tier = clamp(Math.floor(w.tier) || 1, 1, TIERS.length);
  const tierMult = TIERS[tier - 1].incomeMult;

  const worldDef = worldDefById(w.id);
  const worldMult = (worldDef && Number.isFinite(worldDef.incomeMult) && worldDef.incomeMult) || 1;

  let rate = venueTotal * stationMult * systemsMult * tierMult * worldMult * globalBoost;
  if (!Number.isFinite(rate) || rate < 0) rate = 0;
  return rate;
}

/* ------------------------------------------------------------------ *
 *  Tiers — derived from lifetime investment, never stored twice
 * ------------------------------------------------------------------ */

/** Total money ever spent building/leveling a purchasable line. */
function investmentForUnit(def, entry) {
  if (!def || !entry) return 0;
  let total = 0;
  const count = Math.max(0, Math.floor(entry.count) || 0);
  for (let c = 0; c < count; c++) total += def.baseCost * Math.pow(def.costGrowth, c);

  const level = Math.max(1, Math.floor(entry.level) || 1);
  if (level > 1) {
    const maxCount = Number.isFinite(def.maxCount) ? def.maxCount : count;
    const nextUnitCost = def.baseCost * Math.pow(def.costGrowth, maxCount);
    for (let lvl = 1; lvl < level; lvl++) {
      total += nextUnitCost * CONFIG.economy.levelCostMult * Math.pow(CONFIG.economy.levelCostGrowth, lvl - 1);
    }
  }
  return total;
}

function investmentForSystem(def, entry) {
  if (!def || !entry) return 0;
  const level = Math.max(0, Math.floor(entry.level) || 0);
  let total = 0;
  for (let lvl = 0; lvl < level; lvl++) total += def.baseCost * Math.pow(def.costGrowth, lvl);
  return total;
}

/** Total money ever poured into a world's venues/stations/staff/systems. */
function totalInvestment(w) {
  if (!w) return 0;
  let total = 0;
  if (w.venues) for (const key of VENUE_KEYS) total += investmentForUnit(VENUES[key], w.venues[key]);
  if (w.stations) for (const key of STATION_KEYS) total += investmentForUnit(STATIONS[key], w.stations[key]);
  if (w.staff) for (const key of STAFF_KEYS) total += investmentForUnit(STAFF[key], w.staff[key]);
  if (w.systems) for (const key of SYSTEM_KEYS) total += investmentForSystem(SYSTEMS[key], w.systems[key]);
  return total;
}

/** Derives the 1..3 visual tier for a world from its lifetime investment. */
export function tierOf(w) {
  if (!w) return 1;
  const inv = totalInvestment(w);
  const thresholds = CONFIG.tier.thresholds;
  let tier = 1;
  for (let i = thresholds.length - 1; i >= 0; i--) {
    if (inv >= thresholds[i]) {
      tier = i + 1;
      break;
    }
  }
  return clamp(tier, 1, TIERS.length);
}

/** Recomputes and stores a world's tier, emitting 'tier:up' on change. */
export function recomputeTier(w) {
  if (!w) return 1;
  const newTier = tierOf(w);
  if (newTier !== w.tier) {
    w.tier = newTier;
    bus.emit('tier:up', { worldId: w.id, tier: newTier });
  }
  return w.tier;
}

/* ------------------------------------------------------------------ *
 *  Formatting
 * ------------------------------------------------------------------ */

const MONEY_UNITS = [
  { v: 1e15, s: 'Qa' },
  { v: 1e12, s: 'T' },
  { v: 1e9, s: 'B' },
  { v: 1e6, s: 'M' },
  { v: 1e3, s: 'K' }
];

/** Compact "1.25K" / "3.4M" / "12.7B" money formatting. */
export function fmtMoney(n) {
  let num = Number(n);
  if (!Number.isFinite(num)) num = 0;
  const neg = num < 0;
  num = Math.abs(num);

  if (num < 1000) {
    const text = Number.isInteger(num) ? String(num) : num.toFixed(num < 10 ? 2 : 1);
    return (neg ? '-' : '') + text;
  }

  for (const unit of MONEY_UNITS) {
    if (num >= unit.v) {
      const val = num / unit.v;
      const text = val.toFixed(val < 10 ? 2 : 1);
      return (neg ? '-' : '') + text + unit.s;
    }
  }
  return (neg ? '-' : '') + String(Math.round(num));
}

/** "MM:SS", or "H:MM:SS" once an hour is crossed. */
export function fmtTime(sec) {
  let s = Math.floor(Number(sec));
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

/* ------------------------------------------------------------------ *
 *  World unlocking
 * ------------------------------------------------------------------ */

/** Unlock cost of the next locked world in sequence, or null if all open. */
export function nextWorldCost() {
  const list = Array.isArray(state.worlds) ? state.worlds : [];
  for (let i = 0; i < WORLDS.length; i++) {
    const w = list[i];
    if (!w || !w.unlocked) return WORLDS[i].unlockCost;
  }
  return null;
}

/**
 * Unlocks a world, paying from whichever unlocked world currently holds
 * the most money (branches unlock in order: the previous branch must
 * already be unlocked). Seeds the new branch the same way world 0 starts
 * (one slot machine + cashier + security) so its loop runs immediately.
 * @param {number} worldId
 * @returns {boolean} true on success
 */
export function tryUnlockWorld(worldId) {
  const idx = Math.floor(Number(worldId));
  if (!Number.isFinite(idx) || idx < 0 || idx >= WORLDS.length) return false;
  if (!Array.isArray(state.worlds) || !state.worlds[idx]) return false;

  const target = state.worlds[idx];
  if (target.unlocked) return false;
  if (idx > 0 && !(state.worlds[idx - 1] && state.worlds[idx - 1].unlocked)) return false;

  const def = WORLDS[idx];
  const cost = Number(def.unlockCost) || 0;

  let payer = null;
  for (const w of state.worlds) {
    if (w && w.unlocked && (!payer || (Number(w.money) || 0) > (Number(payer.money) || 0))) payer = w;
  }
  if (!payer || (Number(payer.money) || 0) < cost) return false;

  payer.money -= cost;
  target.unlocked = true;
  target.money = Math.max(Number(target.money) || 0, CONFIG.start.money);
  if (target.venues && target.venues.slots) target.venues.slots.count = Math.max(target.venues.slots.count, 1);
  if (target.stations) {
    if (target.stations.cashier) target.stations.cashier.count = Math.max(target.stations.cashier.count, 1);
    if (target.stations.security) target.stations.security.count = Math.max(target.stations.security.count, 1);
  }

  recomputeTier(target);
  bus.emit('money:changed', { worldId: payer.id, money: payer.money });
  bus.emit('money:changed', { worldId: target.id, money: target.money });
  bus.emit('world:unlocked', { worldId: target.id });
  save(true);
  return true;
}

/* ------------------------------------------------------------------ *
 *  Wire the offline-earnings estimator (breaks the state<->economy cycle)
 * ------------------------------------------------------------------ */

setIncomeEstimator(incomeRate);
