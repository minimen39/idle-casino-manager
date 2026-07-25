/**
 * hud.js — top status bar: world name, money, income/sec, diamonds,
 * tier badge with progress to next tier, live guest count, a
 * toast area listening to the 'toast' event, a floating zoom-control
 * cluster for the camera, and a compact language toggle (see
 * buildLangButton()) that flips between the locales in src/core/i18n.js.
 * All strings come from t(); a 'locale:changed' subscription in mount()
 * (see applyStaticLabels()) re-applies them instantly on language switch.
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
import { t, dir, getLocale, setLocale, onLocaleChanged, hasKey } from '../core/i18n.js';

const TOAST_LIFE_MS = 3400;
const TOAST_FADE_MS = 400;
const MAX_TOASTS = 4;

/** @type {null | Record<string, HTMLElement>} */
let els = null;

/** Live guest count, pushed in by the integrator each frame (see setLiveGuestCount). */
let liveGuestCount = 0;

let toastArea = null;
let toastSeq = 0;

/** Guards mount() against a second call, which would double-subscribe 'toast'
 *  (every toast rendered twice) and 'camera:changed', and orphan the first
 *  bar/zoom cluster in #ui-layer. main.js mounts once; this is belt-and-braces. */
let mounted = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function safeNumber(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/*
 * The per-second unit belongs to the VALUE, never to the label. Both locale
 * tables historically baked it into the label as well ('hud.income' ==
 * "Income/s:" / "הכנסה/שנייה:") while update() also appends
 * t('unit.perSecond') to the number, so the HUD printed the unit twice:
 * "Income/s: 1.2K/s". The copy half of the fix ships as a locale change
 * (newLocaleKeys: hud.income -> "Income:" / "הכנסה:"), but this module must
 * not depend on which side lands first — nor on a future translator putting
 * "/ש׳" back — so strip a trailing per-second marker off whatever the table
 * hands us. Runs once per relabel, never per frame.
 */
const PER_SECOND_MARKERS = ['/sec', '/s', '/שנייה', '/שניה', '/שנ׳', '/ש׳'];

function stripPerSecond(raw) {
  let label = String(raw === undefined || raw === null ? '' : raw).replace(/\s+$/, '');
  // A trailing colon is part of the label's punctuation, not of the unit —
  // detach it so "Income/s:" is recognised, then put it back.
  let colon = '';
  if (label.endsWith(':')) {
    colon = ':';
    label = label.slice(0, -1).replace(/\s+$/, '');
  }
  const markers = PER_SECOND_MARKERS.concat([t('unit.perSecond'), t('unit.perSecondFull')]);
  for (const marker of markers) {
    if (typeof marker !== 'string' || marker.length === 0) continue;
    if (label.length > marker.length && label.endsWith(marker)) {
      label = label.slice(0, -marker.length).replace(/\s+$/, '');
      break;
    }
  }
  return label + colon;
}

/** The income stat's label: the noun only, with the unit left to the value. */
function incomeLabelText() {
  return stripPerSecond(t('hud.income'));
}

/**
 * HUD-only money formatter. fmtMoney() is already compact above 1000
 * ("1.23K"), but below it it can emit six characters of precision the top bar
 * has no room for on a 411px phone ("477.62" next to a long Hebrew label, see
 * the HUD-overflow finding). Nothing here is a balance decision — the value
 * shown is the same number, just rounded to what a stat chip can hold:
 *   < 100   one decimal   ("47.6")
 *   < 1000  whole units   ("477")
 *   >= 1000 fmtMoney      ("1.23K")
 * Longest possible output is 5 characters, in every locale.
 */
function fmtMoneyCompact(n) {
  const num = safeNumber(Number(n), 0);
  const abs = Math.abs(num);
  if (abs < 100) {
    const text = Number.isInteger(num) ? String(num) : num.toFixed(1);
    return text;
  }
  if (abs < 1000) return String(Math.trunc(num));
  return fmtMoney(num);
}

/** Build one "label: value" HUD stat block. */
function buildStat(className, labelText) {
  const wrap = el('div', 'hud-stat ' + className);
  const label = el('span', 'hud-stat-label', labelText);
  wrap.appendChild(label);
  const value = el('span', 'hud-stat-value', '—');
  wrap.appendChild(value);
  return { wrap, label, value };
}

/**
 * Build a chunky round zoom-in / zoom-out / fit button cluster.
 * Purely presentational: emits 'camera:zoom' events on the bus and never
 * touches the renderer or camera state directly.
 */
function buildZoomButton(className, glyph, label, camDir) {
  const btn = el('button', 'zoom-btn ' + className, glyph);
  btn.type = 'button';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', () => {
    try {
      bus.emit('camera:zoom', { dir: camDir });
    } catch (err) {
      // never let a UI click crash the game loop
    }
  });
  return btn;
}

function buildZoomControls() {
  const cluster = el('div', 'zoom-controls');
  cluster.setAttribute('dir', dir());

  const zoomInBtn = buildZoomButton('zoom-btn-in', '+', t('zoom.in'), 'in');
  const zoomLabel = el('span', 'zoom-label', '100%');
  const zoomOutBtn = buildZoomButton('zoom-btn-out', '−', t('zoom.out'), 'out');
  const zoomFitBtn = buildZoomButton('zoom-btn-fit', '⛶', t('zoom.fit'), 'fit');

  cluster.appendChild(zoomInBtn);
  cluster.appendChild(zoomLabel);
  cluster.appendChild(zoomOutBtn);
  cluster.appendChild(zoomFitBtn);

  return { cluster, zoomLabel, zoomInBtn, zoomOutBtn, zoomFitBtn };
}

/**
 * Compact glyph shown on the language toggle itself. lang.he / lang.en are the
 * full display names ("עברית" / "English") — too long for a 44px round button —
 * so the tables also carry lang.he.short / lang.en.short. Those two keys hold
 * the SAME value in both locales on purpose: a language switcher must always
 * name each language in its own script, never translated.
 */
function shortLangLabel(id) {
  return t(id === 'en' ? 'lang.en.short' : 'lang.he.short');
}

/**
 * Small round language toggle: shows the CURRENT locale's compact glyph and
 * flips to the other locale on tap. Sized >=44x44 for touch (see mount()'s
 * note on why that overflows #hud's own ~28-34px content box by design —
 * harmless since neither #hud nor #ui-layer clip their children).
 * Kept entirely self-styled (inline styles) since this file does not own
 * styles.css; only CSS custom properties already defined globally are read.
 */
function buildLangButton() {
  const btn = el('button', 'hud-lang-btn', shortLangLabel(getLocale()));
  btn.type = 'button';
  btn.setAttribute('aria-label', t('lang.label'));
  btn.style.flex = '0 0 auto';
  btn.style.width = '44px';
  btn.style.height = '44px';
  btn.style.minWidth = '44px';
  btn.style.minHeight = '44px';
  btn.style.padding = '0';
  btn.style.borderRadius = '50%';
  btn.style.border = '2px solid var(--accent-dark, #7a4a1a)';
  btn.style.background = 'var(--accent, #b8752f)';
  btn.style.color = '#2a1806';
  btn.style.fontWeight = '800';
  btn.style.fontSize = '13px';
  btn.style.lineHeight = '1';
  btn.style.display = 'flex';
  btn.style.alignItems = 'center';
  btn.style.justifyContent = 'center';
  btn.style.cursor = 'pointer';
  btn.addEventListener('click', () => {
    try {
      setLocale(getLocale() === 'he' ? 'en' : 'he');
    } catch (err) {
      // never let a UI click crash the game
    }
  });
  return btn;
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
  if (mounted) return;
  mounted = true;

  const bar = el('div', 'hud-bar');
  bar.setAttribute('dir', dir());

  const worldBlock = el('div', 'hud-world');
  const worldName = el('span', 'hud-world-name', t('hud.loading'));
  worldBlock.appendChild(worldName);

  const money = buildStat('hud-money', t('hud.money'));
  const income = buildStat('hud-income', incomeLabelText());
  const diamonds = buildStat('hud-diamonds', t('hud.diamonds'));
  const guests = buildStat('hud-guests', t('hud.guests'));

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

  const { cluster: zoomControls, zoomLabel, zoomInBtn, zoomOutBtn, zoomFitBtn } = buildZoomControls();

  const langBtn = buildLangButton();

  root.appendChild(bar);
  /*
   * langBtn is a sibling of `bar` directly under #hud (root), not a child
   * of the scrollable/masked .hud-bar — #hud is itself the outer flex row
   * (see styles.css `#hud { display:flex; ... gap: var(--spacing-lg) }`),
   * so this becomes its own reserved flex slot at the far edge of the top
   * bar (the same edge as the last hud-stat, "guests") with the existing
   * gap keeping it clear of every stat, never overlapping money/income.
   * That edge slot is also only ~28-34px tall (see #hud's padding math),
   * shorter than the 44px this button must be for touch, so the button
   * deliberately overflows a few px above/below the bar — harmless, since
   * neither #hud nor #ui-layer clip their children.
   */
  root.appendChild(langBtn);

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
    zoomLabel,
    bar,
    zoomControls,
    moneyLabel: money.label,
    incomeLabel: income.label,
    diamondsLabel: diamonds.label,
    guestsLabel: guests.label,
    zoomInBtn,
    zoomOutBtn,
    zoomFitBtn,
    langBtn
  };

  bus.on('toast', handleToast);
  bus.on('camera:changed', handleCameraChanged);
  onLocaleChanged(() => {
    applyStaticLabels();
    update();
  });

  update();
}

/**
 * Re-applies every static (non-data-driven) HUD string from the current
 * locale. Called once implicitly by mount() (the strings are already
 * correct on first build) and again on every 'locale:changed' event so a
 * language switch updates the HUD instantly without a remount.
 */
function applyStaticLabels() {
  if (!els) return;
  try {
    if (els.bar) els.bar.setAttribute('dir', dir());
    if (els.zoomControls) els.zoomControls.setAttribute('dir', dir());
    if (els.moneyLabel) els.moneyLabel.textContent = t('hud.money');
    if (els.incomeLabel) els.incomeLabel.textContent = incomeLabelText();
    if (els.diamondsLabel) els.diamondsLabel.textContent = t('hud.diamonds');
    if (els.guestsLabel) els.guestsLabel.textContent = t('hud.guests');
    if (els.zoomInBtn) {
      els.zoomInBtn.title = t('zoom.in');
      els.zoomInBtn.setAttribute('aria-label', t('zoom.in'));
    }
    if (els.zoomOutBtn) {
      els.zoomOutBtn.title = t('zoom.out');
      els.zoomOutBtn.setAttribute('aria-label', t('zoom.out'));
    }
    if (els.zoomFitBtn) {
      els.zoomFitBtn.title = t('zoom.fit');
      els.zoomFitBtn.setAttribute('aria-label', t('zoom.fit'));
    }
    if (els.langBtn) {
      els.langBtn.textContent = shortLangLabel(getLocale());
      els.langBtn.setAttribute('aria-label', t('lang.label'));
    }
  } catch (err) {
    // never let a relabel pass crash the HUD
  }
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

/**
 * Resolve a world's display name via its i18n nameKey, falling back to the
 * legacy 'world.<key>.name' pattern, a literal name field, and finally the
 * generic HUD fallback. Mirrors main.js's own worldName() helper.
 * @param {any} def worldDefById(id) result, possibly null
 */
function resolveWorldName(def) {
  if (def) {
    if (typeof def.nameKey === 'string' && hasKey(def.nameKey)) return t(def.nameKey);
    if (typeof def.key === 'string' && hasKey('world.' + def.key + '.name')) {
      return t('world.' + def.key + '.name');
    }
    if (typeof def.name === 'string' && def.name.length > 0) return def.name;
  }
  return t('hud.casino');
}

function computeTierProgress(w) {
  const rawTier = Math.floor(safeNumber(w.tier, 1));
  const tierIdx = Math.max(1, Math.min(3, rawTier));
  const curDef = tierDef(tierIdx);
  const nextDef = tierIdx < 3 ? tierDef(tierIdx + 1) : null;
  const invested = Math.max(0, safeNumber(totalInvestment(w), 0));

  if (!nextDef) return { name: curDef ? t(curDef.nameKey) : '', pct: 1, isMax: true };

  const curMin = curDef ? curDef.minInvestment : 0;
  const nextMin = nextDef.minInvestment;
  const span = nextMin - curMin;
  let pct = span > 0 ? (invested - curMin) / span : 1;
  if (!Number.isFinite(pct)) pct = 0;
  pct = Math.max(0, Math.min(1, pct));

  return { name: curDef ? t(curDef.nameKey) : '', pct, isMax: false };
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
  els.worldName.textContent = resolveWorldName(def);

  try {
    els.money.textContent = fmtMoneyCompact(safeNumber(w.money, 0));
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
    els.income.textContent = fmtMoneyCompact(safeNumber(perSec, 0)) + t('unit.perSecond');
  } catch (err) {
    els.income.textContent = '0' + t('unit.perSecond');
  }

  const diamondCount = Math.floor(safeNumber(state.diamonds, 0));
  els.diamonds.textContent = String(diamondCount);

  els.guests.textContent = String(Math.max(0, Math.floor(liveGuestCount)));

  const progress = computeTierProgress(w);
  /*
   * The badge carries the tier NAME only. Prefixing it with t('hud.tier')
   * ("Tier" / "דרגה") made the longest string in the bar — "Tier Rundown
   * Joint" / "דרגה מתחם מוזנח" — long enough to overlap the neighbouring stat
   * on a 411px phone, and the word is redundant next to the progress bar it
   * labels. The full phrase stays reachable as the title/aria-label.
   */
  els.tierBadge.textContent = progress.name || '—';
  const tierFull = progress.name ? t('hud.tier') + ' ' + progress.name : '';
  els.tierBadge.title = tierFull;
  if (tierFull) els.tierBadge.setAttribute('aria-label', tierFull);
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
