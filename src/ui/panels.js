/**
 * panels.js — the build/upgrade drawer.
 * Four tabs: venues / stations / staff / systems (labels from t()).
 * Each row: name, owned count/level, what it does, cost, buy button
 * (disabled + dimmed when unaffordable or maxed out), plus a global "buy x10" toggle.
 *
 * export function mount(root)
 * export function update()
 */

import { bus } from '../core/events.js';
import { activeWorld } from '../core/state.js';
import {
  CONFIG,
  VENUES,
  STATIONS,
  STAFF,
  SYSTEMS,
  VENUE_KEYS,
  STATION_KEYS,
  STAFF_KEYS,
  SYSTEM_KEYS,
  defOf
} from '../core/config.js';
import { canAfford, buy, fmtMoney } from '../core/economy.js';
import { t, hasKey, dir, onLocaleChanged } from '../core/i18n.js';

/** Maps a purchase kind to its state-table property name (per state.js shape). */
const STATE_TABLE = {
  venue: 'venues',
  station: 'stations',
  staff: 'staff',
  system: 'systems'
};

const TABS = [
  { id: 'venues', labelKey: 'panel.tab.venues', kind: 'venue', defs: VENUES, keys: VENUE_KEYS },
  { id: 'stations', labelKey: 'panel.tab.stations', kind: 'station', defs: STATIONS, keys: STATION_KEYS },
  { id: 'staff', labelKey: 'panel.tab.staff', kind: 'staff', defs: STAFF, keys: STAFF_KEYS },
  { id: 'systems', labelKey: 'panel.tab.systems', kind: 'system', defs: SYSTEMS, keys: SYSTEM_KEYS }
];

let activeTabId = TABS[0].id;
let buyX10 = false;

/** @type {null | HTMLElement} */
let rowsContainer = null;
/** @type {null | HTMLElement} */
let tabBarEl = null;
/** @type {null | HTMLElement} the "×10" checkbox caption, relabeled on locale change. */
let x10LabelEl = null;

/* ------------------------------------------------------------------
 * Collapsible bottom-sheet behaviour (phones only, no-op on desktop).
 * ------------------------------------------------------------------ */

/**
 * Matches the phone breakpoint used to decide the panel's initial state.
 *
 * MUST stay identical to the media query in styles.css that turns .build-panel
 * into a fixed bottom sheet ("Build drawer -> collapsible bottom sheet"). The
 * two conditions are the two phone orientations of the target device:
 *   max-width:640px   Pixel 8 Pro portrait  (412 x 915)
 *   max-height:480px  Pixel 8 Pro landscape (915 x 412 — width stays > 640)
 * Checking only the width would leave the sheet expanded in landscape, where
 * it is 62dvh tall and would bury most of a 412px-high floor on launch, while
 * the stylesheet's pre-JS baseline has it collapsed.
 */
const DRAWER_MOBILE_QUERY = '(max-width: 640px), (max-height: 480px)';
/** Minimum vertical pointer travel (px) on the handle to count as a swipe. */
const DRAWER_SWIPE_THRESHOLD = 40;
/**
 * How long after a pointer gesture the handle ignores a `click`.
 *
 * The handle resolves EVERY pointer gesture on pointerup (see
 * buildDrawerHandle()), so the synthesised click that trails a touch tap is a
 * duplicate and has to be swallowed. A timestamp rather than a boolean flag on
 * purpose: a flag that is only cleared by the next pointerdown stays armed
 * forever whenever no click follows — which on touch is the common case — and
 * would then eat the first non-pointer activation (a programmatic .click(), an
 * assistive-tech activation) that came along. This expires by itself.
 * Comfortably longer than Chrome's touch->click latency on a mobile-optimised
 * page (no 300ms tap delay, so single-digit ms), short enough that a deliberate
 * second tap is never mistaken for a trailing click.
 */
const DRAWER_CLICK_SUPPRESS_MS = 700;

/**
 * Where the player's own expand/collapse choice is remembered. Persisted
 * straight to localStorage rather than through state.js, exactly like
 * monetization.js's ad cooldown: state.js's migrate() whitelists only known
 * gameplay fields and would silently drop a new UI-preference key on reload.
 * This is a view preference, not save data — a corrupt/missing value just
 * falls back to the breakpoint default.
 */
const DRAWER_PREF_KEY = 'idleCasino.ui.drawerCollapsed';

/** @type {null | HTMLElement} panel root (`.build-panel`), target of .is-collapsed/.is-expanded */
let panelRootEl = null;
/** @type {null | HTMLElement} */
let drawerHandleEl = null;
/** Current collapsed state of the drawer. */
let drawerCollapsed = false;
/** Once true, the media-query listener stops overriding the player's own choice. */
let drawerUserChose = false;
/** @type {null | MediaQueryList} */
let drawerMql = null;
/** Removes the MediaQueryList 'change' listener; see setupDrawerResponsiveness(). */
let drawerMqlOff = null;
/** Last measured height (px) of the strip that stays on screen when collapsed. */
let drawerCollapsedH = 0;
/** collapsedHeight of the last 'drawer:changed' actually put on the bus, or -1. */
let announcedCollapsedH = -1;

/** key -> { def, kind, ownedEl, costEl, buyBtn } for the currently rendered tab. */
let rowMeta = new Map();

let unsubscribers = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function findTab(id) {
  for (const tab of TABS) if (tab.id === id) return tab;
  return TABS[0];
}

/** Current owned amount used both for cost lookup and display. */
function ownedAmount(kind, entry) {
  if (!entry) return 0;
  return kind === 'system' ? entry.level : entry.count;
}

/**
 * Mirrors economy.js's internal `nextPurchaseInfo` (not exported from that
 * module, so re-implemented here against the same CONFIG/def contract
 * documented in economy.js's header comment). Resolves what the *next*
 * `buy()` call on this purchasable would actually do: grow its count,
 * level it up, or nothing (fully maxed on both axes / unknown def).
 * @returns {{type:'count'|'level', cost:number}|null}
 */
function nextPurchase(kind, key, entry) {
  const def = defOf(kind, key);
  if (!def || !entry) return null;

  if (kind === 'system') {
    const maxLevel = Number.isFinite(def.maxLevel) ? def.maxLevel : CONFIG.economy.maxLevel;
    const level = Math.max(0, Math.floor(entry.level) || 0);
    if (level >= maxLevel) return null;
    return { type: 'level', cost: costOf(kind, key, level) };
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
      nextUnitCost * CONFIG.economy.levelCostMult * Math.pow(CONFIG.economy.levelCostGrowth, level - 1);
    return { type: 'level', cost };
  }

  return null; // fully maxed out on both count and level
}

/** Pure cost lookup following the standard curve (mirrors economy.js's costOf). */
function costOf(kind, key, currentCount) {
  const def = defOf(kind, key);
  if (!def) return Infinity;
  const c = Math.max(0, Math.floor(Number(currentCount)) || 0);
  const cost = def.baseCost * Math.pow(def.costGrowth, c);
  return Number.isFinite(cost) ? cost : Infinity;
}

function purchase(tab, key) {
  const w = activeWorld();
  if (!w) return;
  const times = buyX10 ? 10 : 1;
  let boughtAny = false;

  for (let i = 0; i < times; i++) {
    let ok = false;
    try {
      if (!canAfford(w, tab.kind, key)) break;
      ok = buy(w, tab.kind, key);
    } catch (err) {
      break;
    }
    if (!ok) break;
    boughtAny = true;
  }

  if (boughtAny) {
    bus.emit('ui:refresh', {});
    update();
  }
}

function buildRow(tab, key) {
  const def = tab.defs[key];
  if (!def) return null;

  const row = el('div', 'panel-row');
  row.dataset.key = key;

  const info = el('div', 'panel-row-info');
  info.appendChild(el('div', 'panel-row-name', def.nameKey && hasKey(def.nameKey) ? t(def.nameKey) : key));
  info.appendChild(el('div', 'panel-row-desc', def.descKey && hasKey(def.descKey) ? t(def.descKey) : ''));
  const ownedEl = el('div', 'panel-row-owned', '');
  info.appendChild(ownedEl);

  const actions = el('div', 'panel-row-actions');
  const costEl = el('span', 'panel-row-cost', '');
  const buyBtn = el('button', 'panel-buy-btn', t('panel.buy'));
  buyBtn.type = 'button';
  /*
   * English buy/upgrade labels ("Upgrade ×10") run noticeably longer than
   * their Hebrew counterparts ("שדרג ×10") and this button is narrow on a
   * 411px phone. styles.css owns .panel-buy-btn's box; this file cannot add
   * a rule there, so guard the text itself inline: never wrap (which would
   * grow the row's height and reflow the whole list) and ellipsize instead,
   * with a title attribute (set alongside the text in update()) so the full
   * label is still reachable on hover/long-press.
   */
  buyBtn.style.whiteSpace = 'nowrap';
  buyBtn.style.overflow = 'hidden';
  buyBtn.style.textOverflow = 'ellipsis';
  buyBtn.style.maxWidth = '100%';
  buyBtn.addEventListener('click', () => purchase(tab, key));

  actions.appendChild(costEl);
  actions.appendChild(buyBtn);

  row.appendChild(info);
  row.appendChild(actions);

  rowMeta.set(key, { def, kind: tab.kind, ownedEl, costEl, buyBtn });
  return row;
}

function renderActiveTab() {
  if (!rowsContainer) return;
  const tab = findTab(activeTabId);

  rowsContainer.textContent = '';
  rowMeta = new Map();

  const frag = document.createDocumentFragment();
  for (const key of tab.keys) {
    const row = buildRow(tab, key);
    if (row) frag.appendChild(row);
  }
  rowsContainer.appendChild(frag);

  syncTabButtons();
  update();
}

function syncTabButtons() {
  if (!tabBarEl) return;
  const buttons = tabBarEl.querySelectorAll('[data-tab]');
  buttons.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === activeTabId);
  });
}

/** localStorage access that can never throw (private mode, disabled storage). */
function storageSafe(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return fallback;
  }
}

/** The remembered choice, or null when the player has never made one. */
function readDrawerPref() {
  const raw = storageSafe(() => {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(DRAWER_PREF_KEY);
  }, null);
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

function writeDrawerPref(collapsed) {
  storageSafe(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(DRAWER_PREF_KEY, collapsed ? '1' : '0');
  });
}

/**
 * Height (px) of the strip that remains on screen when the sheet is collapsed.
 * main.js needs it to keep that band out of the camera's view rectangle (C2),
 * so it must be a real measurement, never a hardcoded constant. In order:
 *   1. styles.css's own `--drawer-collapsed-h` token, when it resolves to a
 *      plain px length (a `calc()`/`env()` token comes back unresolved and is
 *      rejected). It is authoritative in BOTH states and costs nothing.
 *   2. While collapsed: the part of the sheet still inside the viewport. NOT
 *      the panel's box height — verified on device, the sheet collapses with
 *      `transform: translateY(...)`, so its rect stays a full 62dvh (471px)
 *      while only 78px is on screen. Measuring the box reported 471 and would
 *      have had main.js inset the camera by six times the real strip.
 *   3. The handle + header, which is what the sheet collapses down to.
 *   4. The last value we managed to measure.
 * Never throws; worst case it returns 0 and main.js falls back to its own
 * getBoundingClientRect() measurement.
 */
function measureDrawerCollapsedHeight() {
  try {
    if (!panelRootEl || typeof panelRootEl.getBoundingClientRect !== 'function') return drawerCollapsedH;

    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      const token = String(window.getComputedStyle(panelRootEl).getPropertyValue('--drawer-collapsed-h') || '').trim();
      if (/^\d+(\.\d+)?px$/.test(token)) {
        const px = Math.round(parseFloat(token));
        if (px > 0) {
          drawerCollapsedH = px;
          return drawerCollapsedH;
        }
      }
    }

    if (drawerCollapsed) {
      const rect = panelRootEl.getBoundingClientRect();
      const viewportH =
        typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0;
      const visible = viewportH > 0 ? Math.min(rect.height, Math.max(0, viewportH - rect.top)) : rect.height;
      const h = Math.round(visible);
      if (h > 0) drawerCollapsedH = h;
      return drawerCollapsedH;
    }

    let sum = 0;
    if (drawerHandleEl && typeof drawerHandleEl.getBoundingClientRect === 'function') {
      sum += drawerHandleEl.getBoundingClientRect().height;
    }
    if (tabBarEl && tabBarEl.parentNode && typeof tabBarEl.parentNode.getBoundingClientRect === 'function') {
      sum += tabBarEl.parentNode.getBoundingClientRect().height;
    }
    const measured = Math.round(sum);
    if (measured > 0) drawerCollapsedH = measured;
  } catch (err) {
    // guarded: a detached element must never break the drawer
  }
  return drawerCollapsedH;
}

/**
 * Contract C3: announce the sheet's state so main.js can recompute the
 * camera's view insets (C2). Emitted on every state change, once at mount for
 * the initial state, and again once the CSS transition has settled — the
 * height measured the instant the class flips is mid-animation and would leave
 * the camera framed against a box that no longer exists.
 */
function emitDrawerChanged() {
  try {
    const collapsedHeight = measureDrawerCollapsedHeight();
    announcedCollapsedH = collapsedHeight;
    bus.emit('drawer:changed', {
      expanded: !drawerCollapsed,
      collapsedHeight
    });
  } catch (err) {
    // a listener blowing up must never break the drawer's own state machine
  }
}

/** Applies drawerCollapsed to the DOM (classes + aria-expanded). Safe to call anytime. */
function applyDrawerCollapseState() {
  try {
    if (panelRootEl) {
      panelRootEl.classList.toggle('is-collapsed', drawerCollapsed);
      panelRootEl.classList.toggle('is-expanded', !drawerCollapsed);
    }
    if (drawerHandleEl) {
      drawerHandleEl.setAttribute('aria-expanded', drawerCollapsed ? 'false' : 'true');
      drawerHandleEl.setAttribute('aria-label', t('panel.drawerToggle'));
    }
  } catch (err) {
    // guarded: a detached/missing element must never throw here
  }
}

/**
 * Sets the drawer's collapsed state.
 * @param {boolean} next
 * @param {boolean} isUserChoice - true when triggered by a tap/swipe/tab-select,
 *   which permanently opts this session out of the media-query auto behaviour
 *   AND is remembered across reloads.
 */
function setDrawerCollapsed(next, isUserChoice) {
  const changed = drawerCollapsed !== !!next;
  drawerCollapsed = !!next;
  if (isUserChoice) {
    drawerUserChose = true;
    writeDrawerPref(drawerCollapsed);
  }
  applyDrawerCollapseState();
  if (changed) emitDrawerChanged();
}

/** Expands the drawer if it is currently collapsed (used by tab selection). */
function expandDrawerForSelection() {
  if (drawerCollapsed) setDrawerCollapsed(false, true);
}

function buildDrawerHandle() {
  const handle = el('div', 'drawer-handle');
  try {
    handle.setAttribute('role', 'button');
    handle.setAttribute('tabindex', '0');
    handle.setAttribute('aria-expanded', 'true');
    handle.setAttribute('aria-label', t('panel.drawerToggle'));
  } catch (err) {
    // guarded
  }

  let dragStartY = null;
  /** Date.now() of the last gesture this handle resolved from pointer events. */
  let pointerResolvedAt = 0;

  const stop = (e) => {
    try {
      e.stopPropagation();
    } catch (err) {
      // guarded
    }
  };

  handle.addEventListener('pointerdown', (e) => {
    stop(e);
    dragStartY = typeof e.clientY === 'number' ? e.clientY : null;
    // Capture the pointer so a swipe that drifts off this narrow strip still
    // delivers its pointerup here. Without it the gesture is left dangling
    // (dragStartY never cleared) and the sheet neither opens nor closes.
    try {
      if (e.pointerId !== undefined && typeof handle.setPointerCapture === 'function') {
        handle.setPointerCapture(e.pointerId);
      }
    } catch (err) {
      // guarded: pointer capture is an optimisation, never a requirement
    }
  });

  handle.addEventListener('pointermove', (e) => {
    if (dragStartY === null) return;
    stop(e);
  });

  handle.addEventListener('pointerup', (e) => {
    try {
      if (e.pointerId !== undefined && typeof handle.releasePointerCapture === 'function') {
        handle.releasePointerCapture(e.pointerId);
      }
    } catch (err) {
      // guarded
    }
    if (dragStartY === null) return;
    stop(e);
    const endY = typeof e.clientY === 'number' ? e.clientY : dragStartY;
    const dy = endY - dragStartY;
    dragStartY = null;
    /*
     * Resolve the WHOLE gesture here, taps included — this used to fall through
     * to the click handler for anything under DRAWER_SWIPE_THRESHOLD, and that
     * left a dead zone that matches the "one drawer-handle tap silently did
     * nothing, intermittent" report exactly:
     *
     *   Chrome's tap recogniser cancels the synthesised click once the finger
     *   drifts past its touch slop (~8 CSS px on Android). Between that slop
     *   and the 40px swipe threshold there was therefore NO activation path at
     *   all: too far for a click, not far enough for a swipe. A slightly
     *   sloppy thumb tap — 10-35px of drift, entirely normal on a 30px-tall
     *   strip — did nothing at all, and did it silently. `touch-action: none`
     *   on .drawer-handle stops the browser stealing the gesture as a scroll
     *   but does not stop the tap being cancelled.
     *
     * Resolving on pointerup closes the zone: any pointer sequence that began
     * on the handle now toggles or swipes, whatever the drift.
     */
    pointerResolvedAt = Date.now();
    if (dy <= -DRAWER_SWIPE_THRESHOLD) {
      setDrawerCollapsed(false, true); // swipe up -> expand
    } else if (dy >= DRAWER_SWIPE_THRESHOLD) {
      setDrawerCollapsed(true, true); // swipe down -> collapse
    } else {
      setDrawerCollapsed(!drawerCollapsed, true); // tap (however sloppy) -> toggle
    }
  });

  handle.addEventListener('pointercancel', (e) => {
    stop(e);
    dragStartY = null;
  });

  /*
   * Fallback activation only. Every pointer-driven gesture is already resolved
   * on pointerup above, so the click that trails it is a duplicate; this exists
   * for the paths that produce a click with no pointer sequence of our own
   * (a programmatic .click(), assistive tech, a browser without Pointer Events).
   */
  handle.addEventListener('click', (e) => {
    stop(e);
    if (Date.now() - pointerResolvedAt < DRAWER_CLICK_SUPPRESS_MS) return;
    setDrawerCollapsed(!drawerCollapsed, true);
  });

  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      setDrawerCollapsed(!drawerCollapsed, true);
    }
  });

  drawerHandleEl = handle;
  return handle;
}

/** Starts collapsed on phone widths, expanded otherwise; re-evaluates on breakpoint change
 *  unless the player already made an explicit choice this session. No-op if matchMedia is
 *  unavailable (desktop-safe / test-safe). */
function setupDrawerResponsiveness() {
  drawerUserChose = false;
  drawerMql = null;

  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      drawerMql = window.matchMedia(DRAWER_MOBILE_QUERY);
    }
  } catch (err) {
    drawerMql = null;
  }

  // A remembered choice wins over the breakpoint default and, like an in-session
  // choice, opts out of the media-query auto behaviour — a player who collapsed
  // the sheet to see the floor should not find it reopened on every launch.
  const pref = readDrawerPref();
  if (pref !== null) {
    drawerUserChose = true;
    setDrawerCollapsed(pref, false);
  } else {
    setDrawerCollapsed(!!(drawerMql && drawerMql.matches), false);
  }

  if (!drawerMql) return;

  const onChange = (e) => {
    if (drawerUserChose) return;
    let matches = false;
    try {
      matches = !!e.matches;
    } catch (err) {
      matches = false;
    }
    setDrawerCollapsed(matches, false);
  };

  try {
    if (typeof drawerMql.addEventListener === 'function') {
      drawerMql.addEventListener('change', onChange);
      // Remembering how to detach keeps a second mount() from stacking
      // listeners on the same MediaQueryList (each one re-collapsing the
      // sheet on every rotation).
      drawerMqlOff = () => {
        try {
          drawerMql.removeEventListener('change', onChange);
        } catch (err) {
          /* guarded */
        }
      };
    } else if (typeof drawerMql.addListener === 'function') {
      // Safari/older WebView fallback; not expected on the Chrome/Android target.
      drawerMql.addListener(onChange);
      drawerMqlOff = () => {
        try {
          drawerMql.removeListener(onChange);
        } catch (err) {
          /* guarded */
        }
      };
    }
  } catch (err) {
    // guarded: no-op if the MediaQueryList doesn't support change wiring
  }
}

function buildTabs() {
  const bar = el('div', 'panel-tabs');
  bar.addEventListener('click', () => {
    // Tapping the tab strip itself (not a specific tab button) while collapsed
    // just expands the sheet; per-button handlers below also expand + switch.
    expandDrawerForSelection();
  });
  for (const tab of TABS) {
    const btn = el('button', 'panel-tab-btn', t(tab.labelKey));
    btn.type = 'button';
    btn.dataset.tab = tab.id;
    btn.addEventListener('click', () => {
      expandDrawerForSelection();
      if (activeTabId === tab.id) return;
      activeTabId = tab.id;
      renderActiveTab();
    });
    bar.appendChild(btn);
  }
  tabBarEl = bar;
  return bar;
}

/** Re-applies each tab button's label from the current locale (see relabelStatic()). */
function relabelTabs() {
  if (!tabBarEl) return;
  const buttons = tabBarEl.querySelectorAll('[data-tab]');
  buttons.forEach((btn) => {
    const tab = findTab(btn.dataset.tab);
    btn.textContent = t(tab.labelKey);
  });
}

function buildX10Toggle() {
  const label = el('label', 'panel-x10-toggle');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = buyX10;
  checkbox.addEventListener('change', () => {
    buyX10 = checkbox.checked === true;
    // Full recompute (not just label text) since a row's "buy" vs "level up"
    // label depends on nextPurchase(), not just the x10 flag.
    update();
  });
  label.appendChild(checkbox);
  x10LabelEl = el('span', 'panel-x10-label', t('panel.x10'));
  label.appendChild(x10LabelEl);
  return label;
}

/**
 * Detach everything a previous mount() wired up. Idempotent, and safe to call
 * before the first mount. Without it a second mount() would stack a second set
 * of bus subscriptions (every purchase recomputing the rows twice), a second
 * MediaQueryList listener, and leave the old .build-panel orphaned in the DOM
 * on top of the new one.
 */
function teardown() {
  for (const off of unsubscribers) {
    try {
      if (typeof off === 'function') off();
    } catch (err) {
      // guarded: one bad unsubscribe must not skip the rest
    }
  }
  unsubscribers = [];

  if (typeof drawerMqlOff === 'function') {
    drawerMqlOff();
    drawerMqlOff = null;
  }
  drawerMql = null;

  try {
    if (panelRootEl && panelRootEl.parentNode) panelRootEl.parentNode.removeChild(panelRootEl);
  } catch (err) {
    // guarded
  }
  panelRootEl = null;
  drawerHandleEl = null;
  tabBarEl = null;
  rowsContainer = null;
  x10LabelEl = null;
  rowMeta = new Map();
  // The next mount() re-announces from scratch; leaving the old height latched
  // would let its resize guard suppress the first post-remount announcement.
  announcedCollapsedH = -1;
}

export function mount(root) {
  if (!root || typeof root.appendChild !== 'function') return;
  teardown();

  const panel = el('div', 'build-panel');
  panel.setAttribute('dir', dir());
  panelRootEl = panel;

  const handle = buildDrawerHandle();

  const header = el('div', 'build-panel-header');
  header.appendChild(buildTabs());
  header.appendChild(buildX10Toggle());

  rowsContainer = el('div', 'build-panel-rows');

  panel.appendChild(handle);
  panel.appendChild(header);
  panel.appendChild(rowsContainer);
  root.appendChild(panel);

  renderActiveTab();
  setupDrawerResponsiveness();

  /*
   * The sheet animates between its two heights, so the box measured the
   * instant the class flips is mid-transition. Re-announce once the animation
   * has actually landed (C3), so main.js's camera insets settle on the real
   * geometry. Filtered to the panel's own transitions — a child button's
   * :active transform must not trigger a re-measure storm.
   */
  panel.addEventListener('transitionend', (e) => {
    if (!e || e.target !== panel) return;
    const prop = String(e.propertyName || '');
    if (prop && prop.indexOf('height') === -1 && prop.indexOf('transform') === -1) return;
    emitDrawerChanged();
  });

  /*
   * Contract C3: main.js needs the INITIAL geometry too, not only changes.
   *
   * Three emits, and all three earn their place. setupDrawerResponsiveness()
   * above only emits when the state actually CHANGED, so on a desktop width or
   * a remembered "expanded" preference (both of which leave the module's
   * initial `drawerCollapsed = false` untouched) it emits nothing at all — the
   * first of these is the only announcement of the initial state.
   *
   *   1. now — synchronous, so a listener registered BEFORE us is informed.
   *      main.js is not one: boot() mounts panels at :2156 and only subscribes
   *      to 'drawer:changed' at :2186, so it provably misses this one. Kept
   *      because that ordering is main.js's to change, not ours to depend on.
   *   2. next frame — the freshly-appended sheet has now been laid out, so
   *      getBoundingClientRect() returns something other than 0. This is the
   *      emit main.js actually receives today.
   *   3. next task — because (2) does not exist when the document is hidden:
   *      requestAnimationFrame callbacks do not run in a background tab, and a
   *      PWA can absolutely be launched straight into one. Without this, such a
   *      session would run with camera insets that never saw a collapsed
   *      height until the player first touched the handle.
   */
  emitDrawerChanged();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => emitDrawerChanged());
  }
  if (typeof setTimeout === 'function') {
    setTimeout(() => emitDrawerChanged(), 0);
  }

  /*
   * ...and the collapsed strip can also change height with NO state change at
   * all: --drawer-collapsed-h is retuned 78px -> 68px by the max-height:480px
   * block in styles.css, so rotating the phone resizes the strip while
   * `expanded` stays put. Nothing else announces that — the MediaQueryList in
   * setupDrawerResponsiveness() only fires when its match state FLIPS, and
   * 411x760 and 760x411 both match DRAWER_MOBILE_QUERY — so main.js's camera
   * insets (C2) would keep framing against the pre-rotation strip until the
   * player next toggled the sheet. Guarded on the measured height, so Chrome's
   * URL-bar show/hide resize storm stays silent.
   */
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const announceIfHeightChanged = () => {
      try {
        if (measureDrawerCollapsedHeight() === announcedCollapsedH) return;
        emitDrawerChanged();
      } catch (err) {
        // guarded: a resize must never break the drawer
      }
    };
    // orientationchange can fire before the new media query has been applied,
    // so re-check on the following frame as well as immediately.
    const onViewportChange = () => {
      announceIfHeightChanged();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(announceIfHeightChanged);
      }
    };
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    // teardown() calls every entry here as a plain function, so an ordinary
    // remover slots straight in alongside the bus unsubscribers.
    unsubscribers.push(() => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onViewportChange);
    });
  }

  unsubscribers.push(bus.on('purchase', () => update()));
  unsubscribers.push(bus.on('ui:refresh', () => update()));
  unsubscribers.push(bus.on('world:switched', () => renderActiveTab()));
  unsubscribers.push(bus.on('tier:up', () => update()));
  unsubscribers.push(onLocaleChanged(() => relabelStatic()));
}

/**
 * Re-applies every static (non-data-driven) drawer string from the current
 * locale — tab labels, the drawer handle's aria-label, the ×10 caption —
 * then rebuilds the active tab's rows (buildRow() re-reads t() for the buy
 * button's placeholder text) and recomputes them via update(). Called once
 * per 'locale:changed' event so a language switch updates the drawer
 * instantly without a remount.
 */
function relabelStatic() {
  try {
    if (panelRootEl) panelRootEl.setAttribute('dir', dir());
    if (drawerHandleEl) drawerHandleEl.setAttribute('aria-label', t('panel.drawerToggle'));
    if (x10LabelEl) x10LabelEl.textContent = t('panel.x10');
    relabelTabs();
  } catch (err) {
    // never let a relabel pass crash the drawer
  }
  renderActiveTab();
}

export function update() {
  if (!rowsContainer || rowMeta.size === 0) return;

  let w = null;
  try {
    w = activeWorld();
  } catch (err) {
    w = null;
  }
  if (!w) return;

  const tab = findTab(activeTabId);
  const tableName = STATE_TABLE[tab.kind];
  const table = w[tableName];
  if (!table) return;

  rowMeta.forEach((meta, key) => {
    const entry = table[key];
    if (!entry) return;

    const owned = ownedAmount(tab.kind, entry);
    if (tab.kind === 'system') {
      meta.ownedEl.textContent = t('panel.level', { level: owned });
    } else if (entry.level > 1) {
      meta.ownedEl.textContent = t('panel.ownedLevel', { count: entry.count, level: entry.level });
    } else {
      meta.ownedEl.textContent = t('panel.owned', { count: entry.count });
    }

    let info = null;
    try {
      info = nextPurchase(tab.kind, key, entry);
    } catch (err) {
      info = null;
    }
    const atMax = info === null;

    let affordable = false;
    try {
      affordable = !atMax && canAfford(w, tab.kind, key);
    } catch (err) {
      affordable = false;
    }

    if (atMax) {
      meta.costEl.textContent = t('panel.max');
      meta.buyBtn.textContent = t('common.dash');
      meta.buyBtn.title = '';
    } else {
      meta.costEl.textContent = Number.isFinite(info.cost) ? fmtMoney(info.cost) : t('common.dash');
      const isLevelUp = info.type === 'level';
      let label;
      if (buyX10) {
        label = isLevelUp ? t('panel.upgradeX10') : t('panel.buyX10');
      } else {
        label = isLevelUp ? t('panel.upgrade') : t('panel.buy');
      }
      meta.buyBtn.textContent = label;
      // Full label as a tooltip: the inline ellipsis (see buildRow()) may
      // clip the English "Upgrade ×10" on a narrow phone button.
      meta.buyBtn.title = label;
    }

    meta.buyBtn.disabled = atMax || !affordable;
    meta.buyBtn.classList.toggle('is-disabled', meta.buyBtn.disabled);
  });
}
