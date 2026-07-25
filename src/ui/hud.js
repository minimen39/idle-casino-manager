/**
 * hud.js — top status bar: world name, money, income/sec, diamonds,
 * tier badge with progress to next tier, live guest count, a
 * toast area listening to the 'toast' event, and a floating zoom-control
 * cluster for the camera.
 *
 * export function mount(root)
 * export function update()
 * export function setLiveGuestCount(n)   -- integrator hook, see bottom of file.
 *
 * Zoom controls (see buildZoomControls()):
 *   Renders a `.zoom-controls` cluster (positioned bottom-left of the canvas
 *   area via CSS owned by styles.css — this file only creates the DOM/class
 *   hooks, same pattern as .hud-toast-area which also escapes the 60px
 *   top bar via `position: fixed`).
 *   - `.zoom-btn.zoom-btn-in`  -> emits bus.emit('camera:zoom', {dir:'in'})
 *   - `.zoom-btn.zoom-btn-out` -> emits bus.emit('camera:zoom', {dir:'out'})
 *   - `.zoom-btn.zoom-btn-fit` -> emits bus.emit('camera:zoom', {dir:'fit'})
 *   - `.zoom-label` shows the current zoom %, updated when a 'camera:changed'
 *     event {zoom} arrives. hud.js never imports the renderer directly and
 *     never throws if that event never fires — the label just stays at its
 *     last value (initially "100%").
 */

import { bus } from '../core/events.js';
import { state, activeWorld } from '../core/state.js';
import {
  CONFIG,
  tierDef,
  worldDefById,
  VENUES,
  STATIONS,
  STAFF,
  SYSTEMS,
  VENUE_KEYS,
  STATION_KEYS,
  STAFF_KEYS,
  SYSTEM_KEYS
} from '../core/config.js';
import { fmtMoney, incomeRate } from '../core/economy.js';

const TOAST_LIFE_MS = 3400;
const TOAST_FADE_MS = 400;
const MAX_TOASTS = 4;

/** @type {null | Record<string, HTMLElement>} */
let els = null;

/** Live guest count, pushed in by the integrator each frame (see setLiveGuestCount). */
let liveGuestCount = 0;

let toastArea = null;
let toastSeq = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function safeNumber(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/** Build one "label: value" HUD stat block. */
function buildStat(className, labelText) {
  const wrap = el('div', 'hud-stat ' + className);
  wrap.appendChild(el('span', 'hud-stat-label', labelText));
  const value = el('span', 'hud-stat-value', '—');
  wrap.appendChild(value);
  return { wrap, value };
}

/**
 * Build a chunky round zoom-in / zoom-out / fit button cluster.
 * Purely presentational: emits 'camera:zoom' events on the bus and never
 * touches the renderer or camera state directly.
 */
function buildZoomButton(className, glyph, hebrewLabel, dir) {
  const btn = el('button', 'zoom-btn ' + className, glyph);
  btn.type = 'button';
  btn.title = hebrewLabel;
  btn.setAttribute('aria-label', hebrewLabel);
  btn.addEventListener('click', () => {
    try {
      bus.emit('camera:zoom', { dir });
    } catch (err) {
      // never let a UI click crash the game loop
    }
  });
  return btn;
}

function buildZoomControls() {
  const cluster = el('div', 'zoom-controls');
  cluster.setAttribute('dir', 'rtl');

  const zoomInBtn = buildZoomButton('zoom-btn-in', '+', 'התקרב', 'in');
  const zoomLabel = el('span', 'zoom-label', '100%');
  const zoomOutBtn = buildZoomButton('zoom-btn-out', '−', 'התרחק', 'out');
  const zoomFitBtn = buildZoomButton('zoom-btn-fit', '⛶', 'מרכז מפה', 'fit');

  cluster.appendChild(zoomInBtn);
  cluster.appendChild(zoomLabel);
  cluster.appendChild(zoomOutBtn);
  cluster.appendChild(zoomFitBtn);

  return { cluster, zoomLabel };
}

/**
 * Where `position: fixed` overlay clusters may live. See the note in mount():
 * #hud carries a backdrop-filter and would trap them. Never throws, and always
 * returns something appendable.
 * @param {HTMLElement} root the element hud.js was mounted into (#hud)
 */
function overlayHost(root) {
  if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
    const layer = document.getElementById('ui-layer');
    if (layer && typeof layer.appendChild === 'function') return layer;
  }
  const parent = root && root.parentNode;
  if (parent && typeof parent.appendChild === 'function') return parent;
  return root;
}

export function mount(root) {
  if (!root || typeof root.appendChild !== 'function') return;

  const bar = el('div', 'hud-bar');
  bar.setAttribute('dir', 'rtl');

  const worldBlock = el('div', 'hud-world');
  const worldName = el('span', 'hud-world-name', 'טוען…');
  worldBlock.appendChild(worldName);

  const money = buildStat('hud-money', 'קופה:');
  const income = buildStat('hud-income', 'הכנסה/שנייה:');
  const diamonds = buildStat('hud-diamonds', 'יהלומים:');
  const guests = buildStat('hud-guests', 'אורחים:');

  const tierBlock = el('div', 'hud-tier');
  const tierBadge = el('span', 'hud-tier-badge', '—');
  const tierBar = el('div', 'hud-tier-bar');
  const tierFill = el('div', 'hud-tier-fill');
  tierBar.appendChild(tierFill);
  tierBlock.appendChild(tierBadge);
  tierBlock.appendChild(tierBar);

  bar.appendChild(worldBlock);
  bar.appendChild(money.wrap);
  bar.appendChild(income.wrap);
  bar.appendChild(diamonds.wrap);
  bar.appendChild(tierBlock);
  bar.appendChild(guests.wrap);

  const toasts = el('div', 'hud-toast-area');
  toasts.setAttribute('aria-live', 'polite');
  /*
   * styles.css anchors .hud-toast-area with `bottom: 42dvh`, which assumes
   * it resolves against the viewport. Override that here so the toast
   * stack sits just above the collapsed build drawer instead of the
   * mid-screen mark styles.css picked (which also happens to land the
   * toast off-screen once .hud-toast-area is correctly hosted outside
   * #hud's backdrop-filter containing block — see the appendChild note
   * below). Inline style wins over the stylesheet rule regardless of load
   * order or specificity.
   */
  toasts.style.bottom = 'calc(var(--drawer-collapsed-h) + var(--safe-bottom) + 12px)';
  toastArea = toasts;

  const { cluster: zoomControls, zoomLabel } = buildZoomControls();

  root.appendChild(bar);

  /*
   * Both .hud-toast-area and .zoom-controls are `position: fixed` and
   * anchored to the bottom of the viewport, so neither may be a child of
   * #hud: styles.css gives .hud a `backdrop-filter`, and any
   * backdrop-filter other than `none` makes an element a containing block
   * for fixed-position descendants — `bottom: 42dvh` (toasts) / `bottom:
   * calc(40vh + …)` (zoom cluster) would then resolve against the 52-60px
   * top bar and both would render off the top of the screen. styles.css
   * documents #ui-layer as the host (and `#ui-layer > *` re-enables
   * pointer events on it), so honour that, falling back to #hud's parent
   * and then #hud itself.
   */
  overlayHost(root).appendChild(toasts);
  overlayHost(root).appendChild(zoomControls);

  els = {
    worldName,
    money: money.value,
    income: income.value,
    diamonds: diamonds.value,
    guests: guests.value,
    tierBadge,
    tierFill,
    zoomLabel
  };

  bus.on('toast', handleToast);
  bus.on('camera:changed', handleCameraChanged);

  update();
}

/*
 * NOTE: duplicated from economy.js's private (non-exported) totalInvestment()
 * / investmentForUnit() / investmentForSystem() helpers, which drive the
 * *real* w.tier via tierOf()/recomputeTier(). hud.js only owns this file, so
 * rather than reach into economy.js's internals (or edit it to export them),
 * the same computation is mirrored here using the shared config data so the
 * progress bar tracks the identical metric the actual tier is derived from.
 * If economy.js's investment formula changes, this must be updated to match
 * — exporting totalInvestment() from economy.js would remove that risk.
 */
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

/** Total money ever poured into a world's venues/stations/staff/systems — mirrors economy.js. */
function totalInvestment(w) {
  if (!w) return 0;
  let total = 0;
  if (w.venues) for (const key of VENUE_KEYS) total += investmentForUnit(VENUES[key], w.venues[key]);
  if (w.stations) for (const key of STATION_KEYS) total += investmentForUnit(STATIONS[key], w.stations[key]);
  if (w.staff) for (const key of STAFF_KEYS) total += investmentForUnit(STAFF[key], w.staff[key]);
  if (w.systems) for (const key of SYSTEM_KEYS) total += investmentForSystem(SYSTEMS[key], w.systems[key]);
  return total;
}

function computeTierProgress(w) {
  const rawTier = Math.floor(safeNumber(w.tier, 1));
  const tierIdx = Math.max(1, Math.min(3, rawTier));
  const curDef = tierDef(tierIdx);
  const nextDef = tierIdx < 3 ? tierDef(tierIdx + 1) : null;
  const invested = Math.max(0, safeNumber(totalInvestment(w), 0));

  if (!nextDef) return { name: curDef ? curDef.name : '', pct: 1, isMax: true };

  const curMin = curDef ? curDef.minInvestment : 0;
  const nextMin = nextDef.minInvestment;
  const span = nextMin - curMin;
  let pct = span > 0 ? (invested - curMin) / span : 1;
  if (!Number.isFinite(pct)) pct = 0;
  pct = Math.max(0, Math.min(1, pct));

  return { name: curDef ? curDef.name : '', pct, isMax: false };
}

export function update() {
  if (!els) return;

  let w = null;
  try {
    w = activeWorld();
  } catch (err) {
    w = null;
  }
  if (!w) return;

  const def = worldDefById(w.id);
  els.worldName.textContent = def && def.name ? String(def.name) : 'קזינו';

  try {
    els.money.textContent = fmtMoney(safeNumber(w.money, 0));
  } catch (err) {
    els.money.textContent = String(Math.floor(safeNumber(w.money, 0)));
  }

  let perSec = 0;
  try {
    perSec = incomeRate(w);
  } catch (err) {
    perSec = 0;
  }
  try {
    els.income.textContent = fmtMoney(safeNumber(perSec, 0)) + '/ש׳';
  } catch (err) {
    els.income.textContent = '0/ש׳';
  }

  const diamondCount = Math.floor(safeNumber(state.diamonds, 0));
  els.diamonds.textContent = String(diamondCount);

  els.guests.textContent = String(Math.max(0, Math.floor(liveGuestCount)));

  const progress = computeTierProgress(w);
  els.tierBadge.textContent = progress.name || '—';
  els.tierFill.style.width = Math.round(progress.pct * 100) + '%';
  els.tierFill.classList.toggle('is-max', progress.isMax === true);
}

/**
 * Integrator hook: push the current number of active guests each frame.
 * hud.js has no direct reference to GuestSim (owned by sim/guests.js), so
 * main.js should call `hud.setLiveGuestCount(guestSim.guests.length)`
 * once per frame (or whenever it's convenient) before/after hud.update().
 * If never called, the HUD simply shows 0.
 */
export function setLiveGuestCount(n) {
  liveGuestCount = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * 'camera:changed' listener — updates the zoom % label. Best-effort only:
 * if the payload is missing/malformed, or this event is never emitted at
 * all (renderer wiring not yet in place), the label simply keeps showing
 * whatever it last showed ("100%" until the first valid event). Never throws.
 */
function handleCameraChanged(payload) {
  if (!els || !els.zoomLabel) return;
  try {
    const zoom = payload && Number.isFinite(payload.zoom) ? payload.zoom : null;
    if (zoom === null) return;
    els.zoomLabel.textContent = Math.round(zoom * 100) + '%';
  } catch (err) {
    // never let a malformed payload break the HUD
  }
}

function handleToast(payload) {
  if (!toastArea || !payload) return;
  const text = payload.text !== undefined && payload.text !== null ? String(payload.text) : '';
  if (!text) return;
  const kind = payload.kind === 'good' || payload.kind === 'bad' ? payload.kind : 'info';

  while (toastArea.children.length >= MAX_TOASTS) {
    toastArea.removeChild(toastArea.firstChild);
  }

  const id = ++toastSeq;
  const node = el('div', 'hud-toast hud-toast-' + kind, text);
  node.dataset.toastId = String(id);
  toastArea.appendChild(node);

  window.setTimeout(() => {
    node.classList.add('is-fading');
    window.setTimeout(() => {
      if (node.parentNode === toastArea) toastArea.removeChild(node);
    }, TOAST_FADE_MS);
  }, TOAST_LIFE_MS);
}
