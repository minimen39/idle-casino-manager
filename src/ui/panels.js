/**
 * panels.js — the build/upgrade drawer.
 * Four tabs: מתחמים (venues) / עמדות (stations) / צוות (staff) / מערכות (systems).
 * Each row: Hebrew name, owned count/level, what it does, cost, buy button
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

/** Maps a purchase kind to its state-table property name (per state.js shape). */
const STATE_TABLE = {
  venue: 'venues',
  station: 'stations',
  staff: 'staff',
  system: 'systems'
};

const TABS = [
  { id: 'venues', label: 'מתחמים', kind: 'venue', defs: VENUES, keys: VENUE_KEYS },
  { id: 'stations', label: 'עמדות', kind: 'station', defs: STATIONS, keys: STATION_KEYS },
  { id: 'staff', label: 'צוות', kind: 'staff', defs: STAFF, keys: STAFF_KEYS },
  { id: 'systems', label: 'מערכות', kind: 'system', defs: SYSTEMS, keys: SYSTEM_KEYS }
];

let activeTabId = TABS[0].id;
let buyX10 = false;

/** @type {null | HTMLElement} */
let rowsContainer = null;
/** @type {null | HTMLElement} */
let tabBarEl = null;

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
  info.appendChild(el('div', 'panel-row-name', def.name || key));
  info.appendChild(el('div', 'panel-row-desc', def.desc || ''));
  const ownedEl = el('div', 'panel-row-owned', '');
  info.appendChild(ownedEl);

  const actions = el('div', 'panel-row-actions');
  const costEl = el('span', 'panel-row-cost', '');
  const buyBtn = el('button', 'panel-buy-btn', 'קנה');
  buyBtn.type = 'button';
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

/** Applies drawerCollapsed to the DOM (classes + aria-expanded). Safe to call anytime. */
function applyDrawerCollapseState() {
  try {
    if (panelRootEl) {
      panelRootEl.classList.toggle('is-collapsed', drawerCollapsed);
      panelRootEl.classList.toggle('is-expanded', !drawerCollapsed);
    }
    if (drawerHandleEl) {
      drawerHandleEl.setAttribute('aria-expanded', drawerCollapsed ? 'false' : 'true');
    }
  } catch (err) {
    // guarded: a detached/missing element must never throw here
  }
}

/**
 * Sets the drawer's collapsed state.
 * @param {boolean} next
 * @param {boolean} isUserChoice - true when triggered by a tap/swipe/tab-select,
 *   which permanently opts this session out of the media-query auto behaviour.
 */
function setDrawerCollapsed(next, isUserChoice) {
  drawerCollapsed = !!next;
  if (isUserChoice) drawerUserChose = true;
  applyDrawerCollapseState();
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
    handle.setAttribute('aria-label', 'פתח/סגור חנות');
  } catch (err) {
    // guarded
  }

  let dragStartY = null;
  let dragHandled = false;

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
    dragHandled = false;
  });

  handle.addEventListener('pointermove', (e) => {
    if (dragStartY === null) return;
    stop(e);
  });

  handle.addEventListener('pointerup', (e) => {
    if (dragStartY === null) return;
    stop(e);
    const endY = typeof e.clientY === 'number' ? e.clientY : dragStartY;
    const dy = endY - dragStartY;
    dragStartY = null;
    if (dy <= -DRAWER_SWIPE_THRESHOLD) {
      dragHandled = true;
      setDrawerCollapsed(false, true); // swipe up -> expand
    } else if (dy >= DRAWER_SWIPE_THRESHOLD) {
      dragHandled = true;
      setDrawerCollapsed(true, true); // swipe down -> collapse
    }
  });

  handle.addEventListener('pointercancel', (e) => {
    stop(e);
    dragStartY = null;
  });

  handle.addEventListener('click', (e) => {
    stop(e);
    if (dragHandled) {
      // The gesture was already resolved as a swipe; ignore the trailing click.
      dragHandled = false;
      return;
    }
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

  setDrawerCollapsed(!!(drawerMql && drawerMql.matches), false);

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
    } else if (typeof drawerMql.addListener === 'function') {
      // Safari/older WebView fallback; not expected on the Chrome/Android target.
      drawerMql.addListener(onChange);
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
    const btn = el('button', 'panel-tab-btn', tab.label);
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
  label.appendChild(el('span', 'panel-x10-label', 'קנייה פי 10'));
  return label;
}

export function mount(root) {
  if (!root || typeof root.appendChild !== 'function') return;

  const panel = el('div', 'build-panel');
  panel.setAttribute('dir', 'rtl');
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

  unsubscribers.push(bus.on('purchase', () => update()));
  unsubscribers.push(bus.on('ui:refresh', () => update()));
  unsubscribers.push(bus.on('world:switched', () => renderActiveTab()));
  unsubscribers.push(bus.on('tier:up', () => update()));
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
      meta.ownedEl.textContent = 'רמה ' + owned;
    } else {
      const levelSuffix = entry.level > 1 ? ' (רמה ' + entry.level + ')' : '';
      meta.ownedEl.textContent = 'בבעלות: ' + entry.count + levelSuffix;
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
      meta.costEl.textContent = 'מקסימום';
      meta.buyBtn.textContent = '—';
    } else {
      meta.costEl.textContent = Number.isFinite(info.cost) ? fmtMoney(info.cost) : '—';
      const isLevelUp = info.type === 'level';
      const base = isLevelUp ? 'שדרג' : 'קנה';
      meta.buyBtn.textContent = buyX10 ? base + ' ×10' : base;
    }

    meta.buyBtn.disabled = atMax || !affordable;
    meta.buyBtn.classList.toggle('is-disabled', meta.buyBtn.disabled);
  });
}
