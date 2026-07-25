/**
 * worldMap.js — modal listing all 6 worlds as cards: Hebrew name, description,
 * a palette swatch, live money + income for unlocked branches, and either a
 * "עבור לסניף" switch button or a locked card showing the unlock requirement.
 *
 * Mirrors the structure/CSS conventions already established by monetization.js:
 * reuses the site-wide .modal-backdrop / .modal / .card / .shop-grid classes
 * from styles.css instead of injecting a private stylesheet, and finds/creates
 * the shared #modals container.
 *
 * export function mount(root)
 * export function update()
 * export function openWorldMap()   -- integrator hook: call from hud.js/panels.js
 */

import { bus, toast } from '../core/events.js';
import { state, activeWorld, save } from '../core/state.js';
import { CONFIG, WORLDS } from '../core/config.js';
import { incomeRate, fmtMoney, tryUnlockWorld } from '../core/economy.js';
import { t, onLocaleChanged } from '../core/i18n.js';

/* ------------------------------------------------------------------ *
 *  Module state
 * ------------------------------------------------------------------ */

let root = null;
let modalContainer = null;
let mapBackdrop = null;
let mapGrid = null;
let mapTitleEl = null;
/** Guards mount() against double-subscribing the bus (see mount()). */
let mounted = false;

/** worldId -> { unlocked: bool, moneyEl, incomeEl, missingEl, btn } for the
 *  currently-rendered card, so money-only updates can patch text/disabled
 *  state in place instead of tearing down and rebuilding the buttons
 *  (rebuilding mid-click drops the click — see renderGrid()/updateValues()). */
let cardRefs = [];

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

/** Total money the player can draw on to unlock a new world. */
function affordableFunds() {
  const list = Array.isArray(state.worlds) ? state.worlds : [];
  if (CONFIG.worlds && CONFIG.worlds.payFromAnyWorld === true) {
    let sum = 0;
    for (const w of list) {
      if (w && w.unlocked) sum += Math.max(0, Number(w.money) || 0);
    }
    return sum;
  }
  const w = activeWorld();
  return w ? Math.max(0, Number(w.money) || 0) : 0;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function buildSwatch(palette) {
  const row = el('div', 'wm-swatch');
  row.style.display = 'flex';
  row.style.gap = '4px';
  row.style.margin = '6px 0';
  const keys = ['floor', 'wall', 'accent', 'neon', 'carpet'];
  for (const key of keys) {
    const color = palette && palette[key] ? palette[key] : '#333';
    const chip = document.createElement('span');
    chip.style.display = 'inline-block';
    chip.style.width = '14px';
    chip.style.height = '14px';
    chip.style.borderRadius = '3px';
    chip.style.background = color;
    chip.style.border = '1px solid rgba(255,255,255,0.15)';
    chip.title = key;
    row.appendChild(chip);
  }
  return row;
}

function switchWorld(id) {
  const w = state.worlds && state.worlds[id];
  if (!w || !w.unlocked) return;
  if (state.activeWorld === id) return;
  state.activeWorld = id;
  save();
  // The 'world:switched' subscription in mount() rebuilds the grid for us;
  // calling renderGrid() here as well tore it down twice per tap.
  bus.emit('world:switched', { worldId: id });
  bus.emit('ui:refresh', {});
}

/**
 * economy.tryUnlockWorld() only ever pays from the single richest unlocked
 * world, but affordableFunds() (and the enabled 'פתח סניף' button) advertise
 * the POOLED balance across all unlocked worlds whenever
 * CONFIG.worlds.payFromAnyWorld === true. That mismatch let players see a
 * ready-to-open card that then failed with "not enough money" on click.
 *
 * This file only owns worldMap.js, so rather than teaching economy.js to
 * split a single purchase across payers, we consolidate funds *before*
 * calling tryUnlockWorld: sweep money from the other unlocked worlds into
 * whichever one is currently richest (only as much as needed to cover the
 * cost), then let tryUnlockWorld debit that single, now-sufficient payer.
 * Net effect on player balances is identical to a true multi-payer debit;
 * only the intermediate bookkeeping differs.
 */
function poolFundsForUnlock(idx) {
  if (!(CONFIG.worlds && CONFIG.worlds.payFromAnyWorld === true)) return;
  const def = WORLDS[idx];
  if (!def) return;
  const list = Array.isArray(state.worlds) ? state.worlds : [];
  // Mirror tryUnlockWorld's own unlock-order gate: no point reshuffling
  // balances ahead of a call that will fail regardless (out-of-order world).
  if (idx > 0 && !(list[idx - 1] && list[idx - 1].unlocked)) return;
  const cost = Number(def.unlockCost) || 0;
  const unlocked = list.filter((w) => w && w.unlocked);
  if (unlocked.length === 0) return;

  let payer = unlocked[0];
  for (const w of unlocked) {
    if ((Number(w.money) || 0) > (Number(payer.money) || 0)) payer = w;
  }
  if ((Number(payer.money) || 0) >= cost) return; // richest world already covers it alone

  const total = unlocked.reduce((sum, w) => sum + Math.max(0, Number(w.money) || 0), 0);
  if (total < cost) return; // still short even pooled; let tryUnlockWorld report failure

  const donors = unlocked
    .filter((w) => w !== payer)
    .sort((a, b) => (Number(b.money) || 0) - (Number(a.money) || 0));

  let needed = cost - (Number(payer.money) || 0);
  for (const donor of donors) {
    if (needed <= 0) break;
    const avail = Math.max(0, Number(donor.money) || 0);
    const take = Math.min(avail, needed);
    if (take <= 0) continue;
    donor.money = avail - take;
    payer.money = (Number(payer.money) || 0) + take;
    needed -= take;
    bus.emit('money:changed', { worldId: donor.id, money: donor.money });
  }
  bus.emit('money:changed', { worldId: payer.id, money: payer.money });
  save();
}

function handleUnlock(id) {
  const before = state.worlds && state.worlds[id] && state.worlds[id].unlocked === true;
  let ok = false;
  try {
    poolFundsForUnlock(id);
    ok = tryUnlockWorld(id) === true;
  } catch (err) {
    ok = false;
  }
  const after = state.worlds && state.worlds[id] && state.worlds[id].unlocked === true;
  if (!before && !after) {
    toast(t('map.notEnough'), 'bad');
  } else if (!before && after) {
    toast(t('map.unlocked'), 'good');
  } else if (!ok && after) {
    // world was already unlocked by another path; nothing to announce.
  }
  renderGrid();
}

/* ------------------------------------------------------------------ *
 *  Rendering
 * ------------------------------------------------------------------ */

function buildCard(def) {
  const w = (state.worlds && state.worlds[def.id]) || null;
  const isActive = w && w.unlocked && state.activeWorld === def.id;

  const card = el('div', 'card');
  card.style.minWidth = '220px';
  if (isActive) {
    card.style.borderColor = 'var(--good)';
    card.style.boxShadow = '0 0 0 1px var(--good)';
  }

  const nameKey = 'world.' + def.key + '.name';
  const descKey = 'world.' + def.key + '.desc';
  card.appendChild(el('div', 'card-title', t(nameKey)));

  const desc = el('div', null, t(descKey));
  desc.style.color = 'var(--text-muted)';
  desc.style.fontSize = '12px';
  desc.style.lineHeight = '1.5';
  card.appendChild(desc);

  card.appendChild(buildSwatch(def.palette));

  const refs = { unlocked: !!(w && w.unlocked) };

  if (w && w.unlocked) {
    const moneyEl = el('div', 'card-cost', t('map.money', { amount: fmtMoney(Math.max(0, Number(w.money) || 0)) }));
    card.appendChild(moneyEl);
    let perSec = 0;
    try {
      perSec = incomeRate(w);
    } catch (err) {
      perSec = 0;
    }
    const incomeEl = el('div', 'card-count', t('map.income', { amount: fmtMoney(Math.max(0, Number(perSec) || 0)) + t('unit.perSecondFull') }));
    card.appendChild(incomeEl);
    refs.moneyEl = moneyEl;
    refs.incomeEl = incomeEl;

    const btn = document.createElement('button');
    btn.type = 'button';
    if (isActive) {
      btn.textContent = t('map.current');
      btn.className = 'secondary';
      btn.disabled = true;
    } else {
      btn.textContent = t('map.switch');
      btn.className = 'success';
      btn.addEventListener('click', () => switchWorld(def.id));
    }
    btn.style.marginTop = '6px';
    card.appendChild(btn);
  } else {
    card.appendChild(el('div', 'card-cost', t('map.unlockCost', { amount: fmtMoney(Math.max(0, Number(def.unlockCost) || 0)) })));

    const funds = affordableFunds();
    const missing = Math.max(0, (Number(def.unlockCost) || 0) - funds);
    const missingEl = el('div', 'card-count', missing > 0 ? t('map.missing', { amount: fmtMoney(missing) }) : t('map.ready'));
    card.appendChild(missingEl);
    refs.missingEl = missingEl;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t('map.unlock');
    btn.disabled = missing > 0;
    btn.style.marginTop = '6px';
    btn.addEventListener('click', () => handleUnlock(def.id));
    card.appendChild(btn);
    refs.btn = btn;
  }

  return { card, refs };
}

/**
 * Full rebuild: recreates every card (and its buttons). Only call this on
 * structural changes (open, world unlocked/switched, explicit ui:refresh) —
 * NOT on 'money:changed'/'purchase', which fire in bursts (once per
 * unlocked world per second from payIncome, plus per-frame from live
 * events/guests). Rebuilding on those destroys the button under the
 * pointer between mousedown/mouseup, so the resulting click lands on the
 * grid instead of the new button and 'עבור לסניף'/'פתח סניף' silently
 * no-ops. Use updateValues() for money-only refreshes instead.
 */
function renderGrid() {
  if (!mapGrid) return;
  mapGrid.innerHTML = '';
  cardRefs = [];
  const worlds = Array.isArray(WORLDS) ? WORLDS : [];
  for (const def of worlds) {
    const { card, refs } = buildCard(def);
    mapGrid.appendChild(card);
    cardRefs[def.id] = refs;
  }
}

/**
 * Lightweight refresh for money-driven events: patches existing text nodes
 * and the locked-card button's disabled flag in place. Never touches
 * button identity, so an in-flight click/mousedown on a button survives.
 * Falls back to a full renderGrid() if the grid hasn't been built yet.
 */
function updateValues() {
  if (!mapGrid) return;
  if (cardRefs.length === 0) {
    renderGrid();
    return;
  }
  const worlds = Array.isArray(WORLDS) ? WORLDS : [];
  for (const def of worlds) {
    const refs = cardRefs[def.id];
    if (!refs) continue;
    const w = (state.worlds && state.worlds[def.id]) || null;
    const nowUnlocked = !!(w && w.unlocked);
    if (nowUnlocked !== refs.unlocked) {
      // Lock state changed without a 'world:unlocked'/'world:switched' event
      // reaching us first — fall back to a full rebuild to stay correct.
      renderGrid();
      return;
    }
    if (nowUnlocked) {
      if (refs.moneyEl) refs.moneyEl.textContent = t('map.money', { amount: fmtMoney(Math.max(0, Number(w.money) || 0)) });
      if (refs.incomeEl) {
        let perSec = 0;
        try {
          perSec = incomeRate(w);
        } catch (err) {
          perSec = 0;
        }
        refs.incomeEl.textContent = t('map.income', { amount: fmtMoney(Math.max(0, Number(perSec) || 0)) + t('unit.perSecondFull') });
      }
    } else {
      const funds = affordableFunds();
      const missing = Math.max(0, (Number(def.unlockCost) || 0) - funds);
      if (refs.missingEl) refs.missingEl.textContent = missing > 0 ? t('map.missing', { amount: fmtMoney(missing) }) : t('map.ready');
      if (refs.btn) refs.btn.disabled = missing > 0;
    }
  }
}

function closeMap() {
  if (mapBackdrop && mapBackdrop.parentNode) mapBackdrop.parentNode.removeChild(mapBackdrop);
  mapBackdrop = null;
  mapGrid = null;
  mapTitleEl = null;
  cardRefs = [];
}

function showWorldMap() {
  closeMap();

  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');

  const title = el('div', 'modal-title', t('map.title'));
  modal.appendChild(title);
  mapTitleEl = title;

  const closeBtn = el('button', 'modal-close', '×');
  closeBtn.type = 'button';
  closeBtn.title = t('common.close');
  closeBtn.setAttribute('aria-label', t('common.close'));
  closeBtn.addEventListener('click', closeMap);
  modal.appendChild(closeBtn);

  const content = el('div', 'modal-content');
  const grid = el('div', 'shop-grid');
  content.appendChild(grid);
  modal.appendChild(content);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeMap();
  });

  backdrop.appendChild(modal);
  const target = modalContainer || (root && root.appendChild ? root : document.body);
  target.appendChild(backdrop);

  mapBackdrop = backdrop;
  mapGrid = grid;
  renderGrid();
}

/* ------------------------------------------------------------------ *
 *  Public API
 * ------------------------------------------------------------------ */

export function mount(mountRoot) {
  root = mountRoot || null;
  // A second mount() would double every bus subscription below (each event
  // rebuilding the grid twice) and add a second onLocaleChanged listener that
  // nothing ever removes. main.js mounts once; this keeps it true.
  if (mounted) return;
  mounted = true;

  modalContainer = document.getElementById('modals');
  if (!modalContainer) {
    modalContainer = document.createElement('div');
    modalContainer.id = 'modals';
    modalContainer.className = 'modals';
    const layer = document.getElementById('ui-layer');
    if (layer && layer.appendChild) layer.appendChild(modalContainer);
    else if (root && root.appendChild) root.appendChild(modalContainer);
  }

  // money:changed/purchase fire in bursts (once per unlocked world per
  // second from payIncome, plus per-frame from live events/guests) — patch
  // values in place rather than rebuilding the grid, or in-flight clicks on
  // the switch/unlock buttons get dropped. See updateValues() for why.
  bus.on('money:changed', () => {
    if (mapBackdrop) updateValues();
  });
  bus.on('purchase', () => {
    if (mapBackdrop) updateValues();
  });
  bus.on('world:unlocked', () => {
    if (mapBackdrop) renderGrid();
  });
  bus.on('world:switched', () => {
    if (mapBackdrop) renderGrid();
  });
  // 'ui:refresh' is emitted by anything that changes the wallet or the build
  // state (panels.js on a purchase, monetization.js on a diamond spend,
  // state.js on load) — it is NOT a structural change to the world list, so it
  // gets the in-place patch too. Rebuilding here re-introduced exactly the
  // dropped-click bug renderGrid()'s comment documents: a refresh landing
  // between touchstart and touchend replaces the button under the finger and
  // "עבור לסניף"/"פתח סניף" silently no-ops. updateValues() falls back to a
  // full rebuild by itself if a card's lock state actually changed.
  bus.on('ui:refresh', () => {
    if (mapBackdrop) updateValues();
  });
  // Optional integration hook: other modules may `bus.emit('ui:openWorldMap')`
  // instead of importing openWorldMap() directly.
  bus.on('ui:openWorldMap', openWorldMap);

  // Re-render every visible string (title + cards) the instant the player
  // switches language. Safe to run unconditionally: renderGrid() only ever
  // rebuilds buttons from state, it never drops in-flight money.
  onLocaleChanged(() => {
    if (!mapBackdrop) return;
    if (mapTitleEl) mapTitleEl.textContent = t('map.title');
    renderGrid();
  });
}

/**
 * Called from main.js's refreshUI() (~4x/second while the map is open). Must
 * never rebuild the grid: see renderGrid()'s comment — a teardown between a
 * touchstart and its touchend swallows the click. updateValues() patches text
 * and the disabled flag in place and self-escalates to renderGrid() only when
 * a card's lock state actually changed.
 */
export function update() {
  if (mapBackdrop) updateValues();
}

/** Integrator hook: open the world map modal (e.g. from a HUD button). */
export function openWorldMap() {
  showWorldMap();
}

export default { mount, update, openWorldMap };
