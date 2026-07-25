/**
 * tutorial.js — first-run coach marks + the permanently reopenable Help guide.
 *
 * Two features, deliberately in one module because they share every string and
 * the same "what does a new player not understand" model:
 *
 *   1. A 7-step DOM-anchored coach sequence that runs ONCE, on a brand-new
 *      save. It highlights a real element, explains it, and moves on. Two of
 *      the steps are action-gated (open the drawer / buy a slot machine), so
 *      the player learns by doing rather than by reading.
 *   2. A multi-page Help modal behind the action bar's "?" button, reachable
 *      forever. It covers the ten systems the audit found are discoverable
 *      only by accident, including the three first-session money traps.
 *
 * PUBLIC CONTRACT (C7 — main.js dynamically imports this file and swallows
 * every failure, so a build without it plays identically, minus the guide):
 *   export function initTutorial({ bus, t, state, save })
 *   export function maybeStartFirstRun()
 *   export function openHelp(page = 0)
 *   export function relocalize()          // main.js calls this on 'locale:changed'
 *
 * Design rules this file must never break:
 *   - NEVER trap the player. Skip is on every card; a gate that never fires
 *     grows an escape hatch after GATE_ESCAPE_MS; a missing anchor auto-
 *     advances after MISSING_MS instead of stalling; a target that scrolls
 *     off-screen drops the scrim entirely rather than blocking the finger
 *     that would bring it back.
 *   - Hold SELECTORS, never element references. panels.js rebuilds every row
 *     from scratch on 'ui:refresh', 'world:switched' and every locale change
 *     (panels.js renderActiveTab()), so any cached node is detached the moment
 *     the player switches language mid-sequence.
 *   - Coach DOM lives in `.coach-layer` under #ui-layer, which contract C1
 *     keeps pointer-events:none; only `.coach-card` and `.coach-backdrop` opt
 *     back in, and the scrim is built as FOUR panels around a hole so the
 *     action-gated steps can still be performed.
 *   - No world-space projection. Every anchor is a plain DOM node; the one
 *     world-space lesson (tap the thief) is an opportunistic bottom card, not
 *     an anchored step.
 */

import { bus as coreBus } from '../core/events.js';
import { state as coreState, save as coreSave } from '../core/state.js';
import { t as coreT, dir } from '../core/i18n.js';

/* ------------------------------------------------------------------ *
 *  Injected dependencies (contract C7 hands these in; the imports above
 *  are the fallback so the module also works if it is ever mounted by
 *  something other than main.js).
 * ------------------------------------------------------------------ */

let bus = coreBus;
let t = coreT;
let state = coreState;
let save = coreSave;

/* ------------------------------------------------------------------ *
 *  Tunables
 * ------------------------------------------------------------------ */

/** A step whose anchor cannot be resolved for this long auto-advances. */
const MISSING_MS = 1500;
/** An action-gated step grows a manual "Next" after this long. */
const GATE_ESCAPE_MS = 10000;
/** Gap between the highlighted element and the card. */
const CARD_GAP = 14;
/** Minimum distance from any viewport edge. */
const EDGE = 12;
/** Breathing room painted around the anchor inside the spotlight hole. */
const SPOT_PAD = 8;
/** The opportunistic "tap the floor" card dismisses itself after this long. */
const HINT_MS = 14000;
/** maybeStartFirstRun() waits this long for the boot frame to settle. */
const START_DELAY_MS = 450;
/** ...and re-checks this often while a modal (e.g. the offline report) is up. */
const START_RETRY_MS = 600;
/** Give up waiting for a clear screen after this many retries (~30 s). */
const START_RETRY_MAX = 50;

/* ------------------------------------------------------------------ *
 *  Tiny guarded helpers — same idioms as the rest of src/ui.
 * ------------------------------------------------------------------ */

/** Run fn, swallowing anything it throws. */
function safe(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return fallback;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** Guarded querySelector: a malformed selector must never break the guide. */
function qs(selector) {
  return safe(() => document.querySelector(selector), null);
}

function vw() {
  return safe(() => window.innerWidth || document.documentElement.clientWidth, 0) || 0;
}

function vh() {
  return safe(() => window.innerHeight || document.documentElement.clientHeight, 0) || 0;
}

/** True while ANY modal (offline report, shop, minigame, help) is on screen. */
function modalOpen() {
  return !!qs('.modal-backdrop');
}

/**
 * Is the build sheet open? panels.js keeps `.is-expanded`/`.is-collapsed` in
 * sync on `.build-panel` (contract C3), and on desktop widths — where there is
 * no sheet at all — it settles on `.is-expanded`, so this reads "the rows are
 * on screen" in both layouts. Missing panel counts as NOT expanded: every
 * caller here uses it to decide whether to ask for it to be opened, and asking
 * for something that does not exist is already a guarded no-op.
 */
function drawerExpanded() {
  const panel = qs('.build-panel');
  return !!panel && safe(() => panel.classList.contains('is-expanded'), false);
}

/**
 * The persisted first-run block (contract C6).
 *
 * A save written by a build older than C6 has no block at all. Default it to
 * `seen: true` rather than `false`: the cost of wrongly re-running the guide
 * for a veteran is an ambush, the cost of wrongly skipping it is nothing at
 * all, because the "?" button replays it on demand.
 */
function tut() {
  if (!state || typeof state !== 'object') return null;
  if (!state.tutorial || typeof state.tutorial !== 'object') {
    state.tutorial = { seen: true, step: 0 };
  }
  return state.tutorial;
}

/**
 * This module's namespaced corner of the save.
 *
 * state.tutorial is sanitised by migrate() down to exactly {seen, step}
 * (state.js migrateTutorial), so anything else parked there is destroyed on
 * the next load. `state.ext` is the supported bag for module-owned keys and is
 * round-tripped verbatim — that is where the one-shot flags belong.
 */
function ext() {
  if (!state || typeof state !== 'object') return {};
  if (!state.ext || typeof state.ext !== 'object') state.ext = {};
  if (!state.ext.tutorial || typeof state.ext.tutorial !== 'object') state.ext.tutorial = {};
  return state.ext.tutorial;
}

function persist(immediate) {
  safe(() => save(immediate === true), false);
}

/* ------------------------------------------------------------------ *
 *  The step table
 *
 *  `targets` is an ORDERED candidate list and the FIRST match wins, which is
 *  how the cashier/dealer steps degrade: they point at the freshly-rendered
 *  row when the tab is showing it, and at the tab button itself otherwise.
 *  `unionAll` instead highlights every match at once (the two HUD readouts
 *  the money step is about are separate sibling nodes).
 *
 *  `fallbackTargets` is the LAST resort, tried only when nothing in `targets`
 *  resolved (see resolveRect()). Round 1 rewrote styles.css and round 2 is
 *  rewriting it again underneath this file, so every step names the coarse
 *  container it lives in as well as its precise anchor: a renamed class then
 *  costs a fuzzier spotlight instead of a step that vanishes after MISSING_MS.
 *  Verified against the live markup at the time of writing — hud.js buildStat()
 *  (.hud-money/.hud-income/.hud-tier inside .hud-bar), panels.js
 *  buildDrawerHandle()/buildTabs()/buildRow() (.drawer-handle,
 *  [data-tab=<id>], .panel-row[data-key=<key>] > … .panel-buy-btn) and
 *  main.js mountActionBar() (#actions.action-bar, .action-btn--help).
 * ------------------------------------------------------------------ */

const STEPS = [
  {
    id: 'welcome',
    titleKey: 'tutorial.step.welcome.title',
    bodyKey: 'tutorial.step.welcome.body',
    // No anchor: a centred card over a full dim, because the subject is the
    // whole floor and a hole around #game would be a hole around everything.
    targets: []
  },
  {
    id: 'money',
    titleKey: 'tutorial.step.money.title',
    bodyKey: 'tutorial.step.money.body',
    targets: ['.hud-money', '.hud-income'],
    unionAll: true,
    fallbackTargets: ['.hud-bar', '#hud']
  },
  {
    id: 'tier',
    titleKey: 'tutorial.step.tier.title',
    bodyKey: 'tutorial.step.tier.body',
    // .hud-tier is the wrapper; the badge and its progress bar are its two
    // children, so either one alone still frames the right thing.
    targets: ['.hud-tier', '.hud-tier-badge'],
    fallbackTargets: ['.hud-bar', '#hud']
  },
  {
    id: 'drawer',
    titleKey: 'tutorial.step.drawer.title',
    bodyKey: 'tutorial.step.drawer.body',
    // On desktop widths .drawer-handle exists but is only styled into a real
    // grab strip inside the phone media block; the header behind it is the
    // next best "this is the sheet" target either way.
    targets: ['.drawer-handle'],
    fallbackTargets: ['.build-panel-header', '.build-panel', '#panels'],
    // Action-gated on the sheet actually opening. panels.js already announces
    // it (contract C3: 'drawer:changed' {expanded}), so no MutationObserver.
    gate: 'drawer',
    // ...unless the drawer is ALREADY open (desktop widths, or a returning
    // player's remembered preference), in which case the instruction is moot
    // and the step degrades to an ordinary Next card.
    gateSatisfiedNow: drawerExpanded
  },
  {
    id: 'slots',
    titleKey: 'tutorial.step.slots.title',
    bodyKey: 'tutorial.step.slots.body',
    targets: ['.panel-row[data-key="slots"] .panel-buy-btn', '.panel-row[data-key="slots"]'],
    fallbackTargets: ['.build-panel [data-tab="venues"]', '.build-panel-rows'],
    // Action-gated on economy.buy()'s own event, matched on kind+key.
    gate: 'purchase:venue:slots',
    // The venues tab is the drawer's default, but the PREVIOUS step is gated on
    // the sheet opening and the player's most natural way to open it is to tap
    // a tab — panels.js buildTabs() expands AND switches on one tap. Land on
    // "staff" that way and this step's anchor is simply not rendered, so the
    // whole buy-your-first-machine lesson auto-advanced away after MISSING_MS.
    // Naming the tab explicitly makes the step self-sufficient.
    revealTab: 'venues'
  },
  {
    id: 'cashier',
    titleKey: 'tutorial.step.cashier.title',
    bodyKey: 'tutorial.step.cashier.body',
    // The tab candidates are SCOPED to .build-panel: [data-tab] is currently
    // unique to panels.js's tab strip, but the help modal already ships a
    // near-identical `.panel-tab-btn` strip and a future one adopting the same
    // data attribute would silently steal these anchors.
    targets: ['.panel-row[data-key="cashier"]', '.build-panel [data-tab="stations"]'],
    fallbackTargets: ['[data-tab="stations"]', '.build-panel-rows'],
    // Bring the row the copy is ABOUT on screen. panels.js exposes no API for
    // this, but its tab buttons are ordinary buttons whose click handler both
    // expands the sheet and switches the tab — so a synthetic click is the
    // whole integration, and the player can switch straight back.
    revealTab: 'stations'
  },
  {
    id: 'dealers',
    titleKey: 'tutorial.step.dealers.title',
    bodyKey: 'tutorial.step.dealers.body',
    targets: ['.panel-row[data-key="dealers"]', '.build-panel [data-tab="staff"]'],
    fallbackTargets: ['[data-tab="staff"]', '.build-panel-rows'],
    revealTab: 'staff'
  },
  {
    id: 'done',
    titleKey: 'tutorial.doneTitle',
    bodyKey: 'tutorial.doneBody',
    // Ends on the thing that makes every other lesson optional: the "?" button.
    // Degrading to the whole dock is a real degradation, not a cosmetic one:
    // "the guide lives down here" is most of the lesson.
    targets: ['.action-btn--help'],
    fallbackTargets: ['#actions', '.action-bar'],
    finish: true
  }
];

/** Steps that count towards "{current} of {total}" — the done card does not. */
const NUMBERED = STEPS.length - 1;

/* ------------------------------------------------------------------ *
 *  Help modal content
 *
 *  Four pages, ordered the way a confused player asks the question: what am I
 *  even doing -> what do I buy -> what is moving around down there -> what is
 *  all this for. Every section is one locale key pair, so the copy lives in
 *  the locale files and this table stays a table.
 * ------------------------------------------------------------------ */

const HELP_PAGES = [
  {
    tabKey: 'help.tab.loop',
    sections: [
      { titleKey: 'help.loop.title', bodyKey: 'help.loop.body' },
      { titleKey: 'help.currency.title', bodyKey: 'help.currency.body' }
    ]
  },
  {
    tabKey: 'help.tab.build',
    sections: [
      { titleKey: 'help.build.title', bodyKey: 'help.build.body' },
      // The dealer trap: a table with no dealer earns EXACTLY zero
      // (CONFIG.economy.unstaffedOutput === 0). Nothing in the drawer says so.
      { titleKey: 'help.dealers.title', bodyKey: 'help.dealers.body' },
      { titleKey: 'help.tier.title', bodyKey: 'help.tier.body' }
    ]
  },
  {
    tabKey: 'help.tab.floor',
    sections: [
      { titleKey: 'help.events.title', bodyKey: 'help.events.body' },
      { titleKey: 'help.tips.title', bodyKey: 'help.tips.body' },
      // The roulette trap: the stake is a fixed slice of income, which on the
      // first session is most of the starting cash.
      { titleKey: 'help.minigames.title', bodyKey: 'help.minigames.body' }
    ]
  },
  {
    tabKey: 'help.tab.empire',
    sections: [
      { titleKey: 'help.worlds.title', bodyKey: 'help.worlds.body' },
      { titleKey: 'help.offline.title', bodyKey: 'help.offline.body' }
    ]
  }
];

/* ------------------------------------------------------------------ *
 *  Module state
 * ------------------------------------------------------------------ */

let inited = false;
/** Bus unsubscribers taken by initTutorial(), released by teardown of nothing —
 *  they live for the page's lifetime, exactly like every other UI module's. */
const unsubscribers = [];

/** Coach sequence. */
let active = false;
let stepIndex = 0;
let layerEl = null;
let cardEl = null;
let cardTitleEl = null;
let cardBodyEl = null;
let cardActionsEl = null;
let spotEl = null;
/** The four scrim panels around the spotlight hole (top/bottom/start/end). */
let scrimEls = [];
let rafHandle = 0;
/** Timestamp the current anchor first went missing, or 0. */
let missingSince = 0;
/** Timestamp the current step was entered — drives the gate escape hatch. */
let stepEnteredAt = 0;
/** True once the current step's gate has fired (or it never had one). */
let gateOpen = false;
/** True once the escape "Next" has been added, so it is added only once. */
let escapeShown = false;
/** Last geometry written to the DOM, so an unchanged frame writes nothing. */
let lastLayout = '';
let startRetries = 0;
let startTimer = 0;

/** Opportunistic "tap the floor" card. */
let hintEl = null;
let hintTimer = 0;

/** Help modal. */
let helpBackdrop = null;
let helpPage = 0;
let helpTabsEl = null;
let helpBodyEl = null;
let helpTitleEl = null;
let helpReplayBtn = null;
let helpCloseBtn = null;

/* ------------------------------------------------------------------ *
 *  Geometry
 * ------------------------------------------------------------------ */

/**
 * Union (or first-match) of an ordered selector list, as a viewport rect.
 * @param {string[]} list
 * @param {boolean} unionAll true to union EVERY match, false to stop at the first
 */
function resolveList(list, unionAll) {
  let box = null;
  for (let i = 0; i < list.length; i++) {
    const node = qs(list[i]);
    if (!node) continue;
    const r = safe(() => node.getBoundingClientRect(), null);
    // A zero box means display:none or a detached node — not a usable anchor.
    if (!r || r.width <= 0 || r.height <= 0) continue;
    if (!box) {
      box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    } else {
      box.left = Math.min(box.left, r.left);
      box.top = Math.min(box.top, r.top);
      box.right = Math.max(box.right, r.right);
      box.bottom = Math.max(box.bottom, r.bottom);
    }
    if (!unionAll) break;
  }
  return box;
}

/**
 * Resolve a step's anchor to a viewport rect, or null.
 * Re-resolved from the selector every single frame — see the header note on
 * why a cached node is a bug waiting for a language switch.
 *
 * `fallbackTargets` is tried only when `targets` produced nothing, and is
 * ALWAYS first-match (never unioned) even on a `unionAll` step: the fallbacks
 * are coarser containers (`.hud-bar`, `#actions`, `.build-panel`), so unioning
 * them with the precise anchors would blow the spotlight up to the whole bar
 * the moment one precise selector still matched. They exist so a step whose
 * exact anchor a CSS/markup pass renamed points at the right REGION instead of
 * silently auto-advancing past the lesson (see MISSING_MS).
 */
function resolveRect(step) {
  const box = resolveList((step && step.targets) || [], step && step.unionAll === true);
  if (box) return box;
  return resolveList((step && step.fallbackTargets) || [], false);
}

/** Is this rect at least partly on screen? */
function onScreen(box) {
  if (!box) return false;
  return box.right > 0 && box.bottom > 0 && box.left < vw() && box.top < vh();
}

function px(n) {
  return Math.round(n) + 'px';
}

/**
 * The anchor rect grown by SPOT_PAD and then CLAMPED to the viewport — the one
 * geometry the scrim hole, the highlight ring and the card all derive from, so
 * the three can never disagree about where the hole is.
 *
 * The clamp is the fix for "the coach spotlight can extend past the right
 * viewport edge": layoutScrim() clamped its own copy, but layoutSpot() drew the
 * ring from the RAW rect, so an anchor flush against an edge (the language pill
 * at the end of #hud, the "?" button at the end of #actions, and their mirror
 * images in RTL) pushed the ring's border SPOT_PAD past the edge, where it was
 * simply cut in half. Clamping here draws a complete ring hugging the edge
 * instead, in both directions and both writing directions — the arithmetic is
 * in physical coordinates, so it needs no RTL branch.
 */
function paddedHole(hole) {
  if (!hole) return null;
  const W = vw();
  const H = vh();
  const left = Math.min(Math.max(0, hole.left - SPOT_PAD), W);
  const top = Math.min(Math.max(0, hole.top - SPOT_PAD), H);
  // max(left, ...) keeps the box non-negative in width/height even for an
  // anchor that is entirely off one edge (updateFrame() normally drops those,
  // but a rect straddling the edge must still produce a valid box).
  const right = Math.max(left, Math.min(W, hole.right + SPOT_PAD));
  const bottom = Math.max(top, Math.min(H, hole.bottom + SPOT_PAD));
  return { left, top, right, bottom };
}

/**
 * Keep a box of `size` inside `extent`, leaving EDGE of margin, in BOTH
 * directions. The old inline clamp only really worked on one side:
 * `Math.min(Math.max(EDGE, pos), Math.max(EDGE, extent - size - EDGE))`
 * collapses its upper bound to EDGE as soon as the box is wider than the
 * viewport, which pins the box to the leading edge and hangs the entire
 * overflow off the trailing one. Centring the unavoidable overflow instead is
 * the same correct answer in LTR and RTL.
 */
function clampAxis(pos, size, extent) {
  if (!(extent > 0)) return EDGE;
  if (size >= extent - 2 * EDGE) return (extent - size) / 2;
  return Math.min(Math.max(EDGE, pos), extent - size - EDGE);
}

/**
 * Paint the dim as four panels around a hole, instead of one full-screen
 * sheet with a cut-out. The hole is not decorative: `.coach-backdrop` is
 * pointer-events:auto (C1), so a solid sheet would make the two action-gated
 * steps physically impossible to complete.
 * @param {{left:number,top:number,right:number,bottom:number}|null} ring
 *   already padded and viewport-clamped by paddedHole()
 */
function layoutScrim(ring) {
  const W = vw();
  const H = vh();
  if (!ring) {
    // No anchor -> dim everything with the first panel and collapse the rest.
    setPanel(scrimEls[0], 0, 0, W, H);
    setPanel(scrimEls[1], 0, 0, 0, 0);
    setPanel(scrimEls[2], 0, 0, 0, 0);
    setPanel(scrimEls[3], 0, 0, 0, 0);
    return;
  }
  setPanel(scrimEls[0], 0, 0, W, ring.top); // above
  setPanel(scrimEls[1], 0, ring.bottom, W, H - ring.bottom); // below
  setPanel(scrimEls[2], 0, ring.top, ring.left, ring.bottom - ring.top); // left of the hole
  setPanel(scrimEls[3], ring.right, ring.top, W - ring.right, ring.bottom - ring.top); // right of it
}

function setPanel(node, x, y, w, h) {
  if (!node) return;
  node.style.left = px(x);
  node.style.top = px(y);
  node.style.width = px(Math.max(0, w));
  node.style.height = px(Math.max(0, h));
}

/**
 * The accent ring drawn around the highlighted element.
 * @param {{left:number,top:number,right:number,bottom:number}|null} ring
 *   already padded and viewport-clamped by paddedHole(), so this can never
 *   draw outside the viewport in either axis or either direction.
 */
function layoutSpot(ring) {
  if (!spotEl) return;
  if (!ring) {
    spotEl.style.display = 'none';
    return;
  }
  spotEl.style.display = '';
  spotEl.style.left = px(ring.left);
  spotEl.style.top = px(ring.top);
  spotEl.style.width = px(ring.right - ring.left);
  spotEl.style.height = px(ring.bottom - ring.top);
}

/**
 * Place the card near the anchor: below it when there is room, above it
 * otherwise, centred on screen when there is no anchor at all. Positioned
 * with physical left/top because getBoundingClientRect() is physical — which
 * is also why this needs no RTL branch: clampAxis() does the right thing in
 * both directions, and the card's own text alignment is `start`.
 * @param {{left:number,top:number,right:number,bottom:number}|null} ring
 */
function layoutCard(ring) {
  if (!cardEl) return;
  const box = safe(() => cardEl.getBoundingClientRect(), null);
  const cw = box ? box.width : 300;
  const ch = box ? box.height : 160;
  const W = vw();
  const H = vh();

  let left;
  let top;
  if (ring) {
    // `ring` already carries SPOT_PAD, so the gap here is CARD_GAP alone.
    const below = ring.bottom + CARD_GAP;
    const above = ring.top - CARD_GAP - ch;
    if (below + ch <= H - EDGE) top = below;
    else if (above >= EDGE) top = above;
    else top = (H - ch) / 2;
    left = (ring.left + ring.right) / 2 - cw / 2;
  } else {
    left = (W - cw) / 2;
    top = (H - ch) / 2;
  }

  cardEl.style.left = px(clampAxis(left, cw, W));
  cardEl.style.top = px(clampAxis(top, ch, H));
}

/* ------------------------------------------------------------------ *
 *  Coach layer DOM
 * ------------------------------------------------------------------ */

function buildLayer() {
  const host = document.getElementById('ui-layer') || document.body;
  if (!host) return false;

  const layer = el('div', 'coach-layer');
  layer.setAttribute('dir', safe(() => dir(), 'rtl'));

  scrimEls = [];
  for (let i = 0; i < 4; i++) {
    // `--part` drops the `inset: 0` shorthand: with left+right+width all set
    // the box is over-constrained, and the declaration the browser throws away
    // is the LEADING one — i.e. `left` in RTL. That would silently mirror the
    // whole scrim in Hebrew.
    const panel = el('div', 'coach-backdrop coach-backdrop--part');
    // Swallow strays so a mis-aimed finger cannot open the shop mid-lesson,
    // but never advance/dismiss on it: an accidental tap must not cost the
    // player the walkthrough. Skip and Next are the only two exits.
    panel.addEventListener('click', (e) => safe(() => e.stopPropagation()));
    layer.appendChild(panel);
    scrimEls.push(panel);
  }

  spotEl = el('div', 'coach-spot');
  layer.appendChild(spotEl);

  const card = el('div', 'coach-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');
  cardTitleEl = el('div', 'coach-card-title', '');
  cardBodyEl = el('div', 'coach-card-body', '');
  cardActionsEl = el('div', 'coach-card-actions');
  card.appendChild(cardTitleEl);
  card.appendChild(cardBodyEl);
  card.appendChild(cardActionsEl);
  layer.appendChild(card);

  host.appendChild(layer);
  layerEl = layer;
  cardEl = card;
  return true;
}

function destroyLayer() {
  if (layerEl && layerEl.parentNode) layerEl.parentNode.removeChild(layerEl);
  layerEl = null;
  cardEl = null;
  cardTitleEl = null;
  cardBodyEl = null;
  cardActionsEl = null;
  spotEl = null;
  scrimEls = [];
  lastLayout = '';
}

/** (Re)build the card's text + buttons for the current step and locale. */
function renderCard() {
  const step = STEPS[stepIndex];
  if (!step || !cardEl) return;

  if (cardTitleEl) cardTitleEl.textContent = t(step.titleKey);
  if (cardBodyEl) cardBodyEl.textContent = t(step.bodyKey);
  if (layerEl) layerEl.setAttribute('dir', safe(() => dir(), 'rtl'));

  if (!cardActionsEl) return;
  cardActionsEl.textContent = '';

  // Progress reads "3 of 7"; the closing card is chrome, not a step.
  const progress = el('span', 'coach-progress', '');
  if (!step.finish) {
    progress.textContent = t('tutorial.progress', { current: stepIndex + 1, total: NUMBERED });
  }
  cardActionsEl.appendChild(progress);

  // Skip is on EVERY card, including the last one. A guide you cannot leave is
  // worse than no guide.
  if (!step.finish) {
    const skip = el('button', 'btn btn--ghost btn--sm coach-skip', t('tutorial.skip'));
    skip.type = 'button';
    skip.addEventListener('click', () => endSequence(true));
    cardActionsEl.appendChild(skip);
  }

  const gated = !!step.gate && !gateOpen;
  if (step.finish) {
    const finish = el('button', 'btn btn--sm', t('tutorial.finish'));
    finish.type = 'button';
    finish.addEventListener('click', () => endSequence(false));
    cardActionsEl.appendChild(finish);
  } else if (!gated) {
    const next = el('button', 'btn btn--sm', t('tutorial.next'));
    next.type = 'button';
    next.addEventListener('click', () => goToStep(stepIndex + 1));
    cardActionsEl.appendChild(next);
  } else if (escapeShown) {
    // The escape hatch: the gate has not fired for GATE_ESCAPE_MS, so the
    // player either cannot afford it or cannot find it. Let them past.
    const next = el('button', 'btn btn--secondary btn--sm', t('tutorial.next'));
    next.type = 'button';
    next.addEventListener('click', () => goToStep(stepIndex + 1));
    cardActionsEl.appendChild(next);
  } else {
    // Gated and still waiting: a pulsing cue instead of a button, so the card
    // never looks like it is missing its primary action.
    cardActionsEl.appendChild(el('span', 'coach-waiting', '●'));
  }
}

/* ------------------------------------------------------------------ *
 *  The step machine
 * ------------------------------------------------------------------ */

function clampStep(n) {
  const i = Math.floor(Number(n) || 0);
  if (!(i >= 0)) return 0;
  return i >= STEPS.length ? STEPS.length - 1 : i;
}

function goToStep(next) {
  if (!active) return;
  const i = Math.floor(Number(next) || 0);
  if (i >= STEPS.length) {
    endSequence(false);
    return;
  }
  stepIndex = clampStep(i);
  enterStep();
}

function enterStep() {
  const step = STEPS[stepIndex];
  if (!step) {
    endSequence(false);
    return;
  }

  stepEnteredAt = Date.now();
  missingSince = 0;
  escapeShown = false;
  lastLayout = '';
  gateOpen = !step.gate || (typeof step.gateSatisfiedNow === 'function' && step.gateSatisfiedNow() === true);

  // Persist progress BEFORE the step renders, so a reload mid-walkthrough
  // resumes exactly here rather than restarting from the welcome card.
  const tu = tut();
  if (tu) {
    tu.step = stepIndex;
    persist(false);
  }

  // Surface the drawer tab the copy is about (see the STEPS note on revealTab).
  // Scoped to .build-panel first for the same reason the STEPS targets are.
  //
  // The `|| !drawerExpanded()` half is what makes the three row-anchored steps
  // survive the drawer step's escape hatch. Those rows are always IN the DOM
  // (panels.js renders every row of the active tab whatever the sheet's state)
  // but a collapsed sheet is translated off the bottom of the screen, so their
  // rects are real, non-zero and entirely below the fold: resolveRect() happily
  // returns one, onScreen() then rejects it, and updateFrame() drops the scrim
  // and the ring — leaving a centred card telling the player to tap a button
  // that is nowhere on screen, with no auto-advance because the anchor never
  // technically went missing. That is reachable today: the previous step's gate
  // grows a manual "Next" after GATE_ESCAPE_MS, so a player who never opened
  // the sheet walks straight into it, and on 'slots' the old !is-active guard
  // suppressed the click precisely because "venues" is panels.js's default tab.
  // Clicking an already-active tab is the right lever rather than a special
  // case: panels.js's handler calls expandDrawerForSelection() BEFORE its
  // already-active early return, so the click means exactly "open the sheet".
  if (step.revealTab) {
    const sel = '[data-tab="' + step.revealTab + '"]';
    const tab = qs('.build-panel ' + sel) || qs(sel);
    const active = tab ? safe(() => tab.classList.contains('is-active'), false) : false;
    if (tab && (!active || !drawerExpanded())) {
      safe(() => tab.click());
    }
  }

  renderCard();

  // A row further down the sheet's scroller is in the DOM but below the fold;
  // nudge it into view once (never on every frame — that would fight the
  // player's own scrolling).
  if (typeof setTimeout === 'function') {
    setTimeout(() => {
      if (!active || STEPS[stepIndex] !== step) return;
      // Fallbacks included: when they are what resolveRect() ended up
      // spotlighting, they are also what needs to be on screen.
      const list = (step.targets || []).concat(step.fallbackTargets || []);
      for (let i = 0; i < list.length; i++) {
        const node = qs(list[i]);
        if (!node || typeof node.scrollIntoView !== 'function') continue;
        const r = safe(() => node.getBoundingClientRect(), null);
        if (r && r.top >= 0 && r.bottom <= vh()) return; // already visible
        safe(() => node.scrollIntoView({ block: 'center', behavior: 'smooth' }));
        return;
      }
    }, 90);
  }
}

/** A gate fired. Only the CURRENT step's gate counts. */
function satisfyGate(name) {
  if (!active) return;
  const step = STEPS[stepIndex];
  if (!step || step.gate !== name || gateOpen) return;
  gateOpen = true;
  // Let the player see what they just did land before the card moves on.
  if (typeof setTimeout === 'function') {
    setTimeout(() => {
      if (!active || STEPS[stepIndex] !== step) return;
      goToStep(stepIndex + 1);
    }, 700);
  } else {
    goToStep(stepIndex + 1);
  }
}

/**
 * @param {boolean} skipped true when the player pressed Skip, which also
 *   suppresses the opportunistic tap card — they have said, explicitly, that
 *   they do not want to be taught.
 */
function endSequence(skipped) {
  active = false;
  if (rafHandle && typeof cancelAnimationFrame === 'function') {
    safe(() => cancelAnimationFrame(rafHandle));
  }
  rafHandle = 0;
  destroyLayer();

  const tu = tut();
  if (tu) {
    tu.seen = true;
    tu.step = STEPS.length;
  }
  if (skipped) ext().tapHintSeen = true;
  // Immediate: the player may close the tab a second later, and re-running the
  // walkthrough on the next launch is the one failure mode that really annoys.
  persist(true);
}

/* ------------------------------------------------------------------ *
 *  Frame loop
 *
 *  Everything is re-resolved and re-measured per frame rather than on a set
 *  of change events, because the things that move an anchor are open-ended:
 *  the drawer's height transition, the HUD reflowing on a language switch,
 *  the sheet's own scroller, Chrome's URL bar sliding. The sequence lasts
 *  well under a minute, and an unchanged frame writes nothing to the DOM.
 * ------------------------------------------------------------------ */

function scheduleFrame() {
  if (!active) return;
  if (typeof requestAnimationFrame !== 'function') return;
  rafHandle = requestAnimationFrame(frame);
}

function frame() {
  rafHandle = 0;
  if (!active) return;
  safe(() => updateFrame());
  scheduleFrame();
}

function updateFrame() {
  const step = STEPS[stepIndex];
  if (!step || !layerEl) return;

  // Stand down while a modal is up (the offline report, the shop, a mini-game).
  // Two stacked dimmers read as a rendering bug, and the coach layer sits above
  // .modal-backdrop in the z-order.
  if (modalOpen()) {
    layerEl.style.display = 'none';
    missingSince = 0;
    return;
  }
  if (layerEl.style.display === 'none') {
    layerEl.style.display = '';
    lastLayout = '';
  }

  // The gate escape hatch (see renderCard()).
  //
  // Dropping lastLayout is not cosmetic. renderCard() swaps the pulsing
  // `.coach-waiting` dot for a real "Next" button, which widens the actions
  // row; `.coach-card` is an absolutely-positioned shrink-to-fit box, so a
  // card that was under its 320px max-width grows — while `left` still holds
  // the value layoutCard() clamped for the NARROWER card. On a step whose
  // anchor sits at the trailing end of a bar (the "?" in #actions, or its RTL
  // mirror) that clamp was already hard against the edge, so the extra width
  // lands outside the viewport: the same defect the clamp exists to prevent,
  // arriving 10s later. Every other renderCard() caller already invalidates
  // (enterStep() clears it, relocalize() clears it); this was the one that
  // did not, and the geometry key it is compared against cannot notice a
  // change of card size on its own.
  if (step.gate && !gateOpen && !escapeShown && Date.now() - stepEnteredAt > GATE_ESCAPE_MS) {
    escapeShown = true;
    renderCard();
    lastLayout = '';
  }

  let hole = resolveRect(step);
  const wanted = (step.targets || []).length > 0;

  if (wanted && !hole) {
    // Anchor gone (a rebuild, a world switch, a tab change). Give it a moment
    // to come back, then move on — a guide must never soft-lock the game.
    if (!missingSince) missingSince = Date.now();
    else if (Date.now() - missingSince > MISSING_MS) {
      missingSince = 0;
      goToStep(stepIndex + 1);
      return;
    }
  } else {
    missingSince = 0;
  }

  // An anchor scrolled out of the viewport gets NO scrim at all: the hole
  // would be off-screen, so a full dim would be all that is left, and it would
  // sit on top of the very control (the drawer handle) that brings the anchor
  // back.
  const offscreen = !!hole && !onScreen(hole);
  const scrimHole = offscreen ? null : hole;
  const dimmed = !offscreen;

  const key =
    (dimmed ? '1' : '0') +
    '|' +
    (scrimHole
      ? Math.round(scrimHole.left) +
        ',' +
        Math.round(scrimHole.top) +
        ',' +
        Math.round(scrimHole.right) +
        ',' +
        Math.round(scrimHole.bottom)
      : 'none') +
    '|' +
    vw() +
    'x' +
    vh();
  if (key === lastLayout) return;
  lastLayout = key;

  for (let i = 0; i < scrimEls.length; i++) {
    if (scrimEls[i]) scrimEls[i].style.display = dimmed ? '' : 'none';
  }
  // ONE padded+clamped rect for all three consumers: the scrim hole, the ring
  // and the card's anchor point are the same box by construction, so they
  // cannot drift apart at a viewport edge (see paddedHole()).
  const ring = paddedHole(scrimHole);
  if (dimmed) layoutScrim(ring);
  layoutSpot(ring);
  layoutCard(ring);
}

/* ------------------------------------------------------------------ *
 *  Opportunistic "tap the floor" card
 *
 *  The one lesson whose subject lives in the canvas, not the DOM. Rather than
 *  projecting a world position through the isometric camera (no world->screen
 *  inverse is exposed), it waits for the first live event to actually spawn
 *  and shows an unanchored card at the bottom of the screen. No scrim, no
 *  blocking — the whole point is that the player can tap the thief.
 * ------------------------------------------------------------------ */

function dismissHint() {
  if (hintTimer && typeof clearTimeout === 'function') clearTimeout(hintTimer);
  hintTimer = 0;
  if (hintEl && hintEl.parentNode) hintEl.parentNode.removeChild(hintEl);
  hintEl = null;
}

function showTapHint() {
  if (hintEl || active) return;
  // Not over a modal: this layer sits ABOVE .modal-backdrop in the z-order, so
  // it would land on top of the offline report / shop / a mini-game. Bail
  // without setting the flag — live events keep spawning, so the lesson simply
  // waits for a clear screen.
  if (modalOpen()) return;
  const host = document.getElementById('ui-layer') || document.body;
  if (!host) return;

  const wrap = el('div', 'coach-layer coach-layer--hint');
  wrap.setAttribute('dir', safe(() => dir(), 'rtl'));
  const card = el('div', 'coach-card coach-card--hint');
  card.setAttribute('role', 'dialog');
  card.appendChild(el('div', 'coach-card-title', t('tutorial.step.tap.title')));
  card.appendChild(el('div', 'coach-card-body', t('tutorial.step.tap.body')));
  const actions = el('div', 'coach-card-actions');
  const ok = el('button', 'btn btn--sm', t('common.close'));
  ok.type = 'button';
  ok.addEventListener('click', dismissHint);
  actions.appendChild(el('span', 'coach-progress', ''));
  actions.appendChild(ok);
  card.appendChild(actions);
  wrap.appendChild(card);
  host.appendChild(wrap);
  hintEl = wrap;

  // Sit clear of the build sheet whatever height it currently is: the CSS
  // fallback assumes the collapsed strip, but the walkthrough leaves the
  // drawer OPEN (step 4), so a player who just finished it would get this card
  // in the middle of the row list. Measured, never hardcoded — the same rule
  // main.js follows for the camera insets (contract C2).
  safe(() => {
    const panel = qs('.build-panel');
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    if (!(r.height > 0)) return;
    const clearance = Math.max(0, vh() - r.top) + 12;
    // ...but never push it up under the top chrome on a fully open sheet: with
    // no scrim the card is opaque, so overlapping the action dock would hide
    // live controls rather than merely dim them.
    const actions = qs('#actions');
    const ar = actions ? safe(() => actions.getBoundingClientRect(), null) : null;
    const ceiling = ar && ar.height > 0 ? ar.bottom + EDGE : EDGE;
    const maxClearance = Math.max(0, vh() - card.getBoundingClientRect().height - ceiling);
    card.style.bottom = px(Math.min(clearance, maxClearance));
  });

  ext().tapHintSeen = true;
  persist(true);

  if (typeof setTimeout === 'function') hintTimer = setTimeout(dismissHint, HINT_MS);
}

/* ------------------------------------------------------------------ *
 *  Help modal
 *
 *  Deliberately built to the SAME contract the three existing modals use
 *  (.modal-backdrop > .modal > .modal-title + .modal-close + .modal-content,
 *  appended to #modals, REMOVED from the DOM on close, backdrop click closes)
 *  — that is what main.js's Android Back guard keys off, and it is DOM-driven
 *  precisely so a new modal needs no main.js change.
 * ------------------------------------------------------------------ */

function closeHelp() {
  if (helpBackdrop && helpBackdrop.parentNode) helpBackdrop.parentNode.removeChild(helpBackdrop);
  helpBackdrop = null;
  helpTabsEl = null;
  helpBodyEl = null;
  helpTitleEl = null;
  helpReplayBtn = null;
  helpCloseBtn = null;
}

function renderHelpTabs() {
  if (!helpTabsEl) return;
  helpTabsEl.textContent = '';
  for (let i = 0; i < HELP_PAGES.length; i++) {
    const page = HELP_PAGES[i];
    const btn = el('button', 'panel-tab-btn help-tab-btn', t(page.tabKey));
    btn.type = 'button';
    if (i === helpPage) btn.classList.add('is-active');
    btn.addEventListener(
      'click',
      (function (index) {
        return function () {
          helpPage = index;
          renderHelpTabs();
          renderHelpBody();
          if (helpBodyEl) safe(() => (helpBodyEl.scrollTop = 0));
        };
      })(i)
    );
    helpTabsEl.appendChild(btn);
  }
}

function renderHelpBody() {
  if (!helpBodyEl) return;
  helpBodyEl.textContent = '';
  const page = HELP_PAGES[helpPage] || HELP_PAGES[0];
  const sections = (page && page.sections) || [];
  for (let i = 0; i < sections.length; i++) {
    const sec = el('div', 'help-section');
    sec.appendChild(el('div', 'help-section-title', t(sections[i].titleKey)));
    sec.appendChild(el('div', 'help-section-body', t(sections[i].bodyKey)));
    helpBodyEl.appendChild(sec);
  }
}

/**
 * Reopenable guide. `page` is an index into HELP_PAGES; anything out of range
 * clamps to the first page (main.js passes a Number, but the "?" button is not
 * the only possible caller).
 */
export function openHelp(page) {
  closeHelp();

  const n = Math.floor(Number(page) || 0);
  helpPage = n >= 0 && n < HELP_PAGES.length ? n : 0;

  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal help-modal');
  modal.setAttribute('dir', safe(() => dir(), 'rtl'));

  helpTitleEl = el('div', 'modal-title', t('help.title'));
  modal.appendChild(helpTitleEl);

  helpCloseBtn = el('button', 'modal-close', '×');
  helpCloseBtn.type = 'button';
  helpCloseBtn.title = t('common.close');
  helpCloseBtn.setAttribute('aria-label', t('common.close'));
  helpCloseBtn.addEventListener('click', closeHelp);
  modal.appendChild(helpCloseBtn);

  const content = el('div', 'modal-content help-content');
  helpTabsEl = el('div', 'panel-tabs help-tabs');
  content.appendChild(helpTabsEl);
  helpBodyEl = el('div', 'help-body');
  content.appendChild(helpBodyEl);

  // Replaying is the honest answer to "I closed it too fast": it re-arms the
  // first-run flag rather than trying to reproduce the sequence some other way.
  const footer = el('div', 'help-footer');
  helpReplayBtn = el('button', 'btn btn--secondary btn--sm', t('tutorial.replay'));
  helpReplayBtn.type = 'button';
  helpReplayBtn.addEventListener('click', () => {
    closeHelp();
    replaySequence();
  });
  footer.appendChild(helpReplayBtn);
  content.appendChild(footer);

  modal.appendChild(content);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeHelp();
  });

  backdrop.appendChild(modal);
  const host = document.getElementById('modals') || document.getElementById('ui-layer') || document.body;
  if (!host) return;
  host.appendChild(backdrop);
  helpBackdrop = backdrop;

  renderHelpTabs();
  renderHelpBody();
}

/* ------------------------------------------------------------------ *
 *  Public API
 * ------------------------------------------------------------------ */

function startSequence(fromStep) {
  if (active) return;
  if (!buildLayer()) return;
  active = true;
  stepIndex = clampStep(fromStep);
  enterStep();
  scheduleFrame();
}

function replaySequence() {
  const tu = tut();
  if (tu) {
    tu.seen = false;
    tu.step = 0;
    persist(true);
  }
  dismissHint();
  startSequence(0);
}

/**
 * Wire the listeners. No DOM yet — main.js calls this once at boot, right
 * after every UI module is mounted.
 */
export function initTutorial(deps) {
  if (deps && typeof deps === 'object') {
    if (deps.bus) bus = deps.bus;
    if (typeof deps.t === 'function') t = deps.t;
    if (deps.state) state = deps.state;
    if (typeof deps.save === 'function') save = deps.save;
  }
  if (inited) return;
  inited = true;

  // Contract C3: panels.js announces the sheet, so the drawer step needs no
  // MutationObserver of its own.
  unsubscribers.push(
    bus.on('drawer:changed', (p) => {
      if (p && p.expanded === true) satisfyGate('drawer');
    })
  );

  // economy.buy() emits this (coalesced) with {worldId, key, kind}.
  unsubscribers.push(
    bus.on('purchase', (p) => {
      if (!p) return;
      satisfyGate('purchase:' + p.kind + ':' + p.key);
    })
  );

  // The one world-space lesson, taught the first time the floor produces
  // something worth tapping — and only if the player finished the walkthrough.
  unsubscribers.push(
    bus.on('liveEvent:spawn', () => {
      const tu = tut();
      if (!tu || tu.seen !== true) return;
      if (ext().tapHintSeen === true) return;
      safe(() => showTapHint());
    })
  );

  // NOTE: nothing subscribes to 'ui:refresh' or 'world:switched' here on
  // purpose. maybeStartFirstRun() is the ONLY thing that may start the
  // sequence, so a mid-session refresh (a purchase, a wipe, a branch switch)
  // can never ambush a player who is already playing. Anchors that a rebuild
  // detached are handled by re-resolving the selector every frame instead.
}

/**
 * Run the walkthrough if — and only if — this is a genuinely new save.
 * Existing saves are back-filled `seen: true` by migrate() (contract C6), so
 * a returning player is never ambushed.
 */
export function maybeStartFirstRun() {
  const tu = tut();
  if (!tu || tu.seen === true) return;
  if (active) return;
  if (typeof setTimeout !== 'function') return;

  startRetries = 0;
  const attempt = () => {
    startTimer = 0;
    const now = tut();
    if (!now || now.seen === true || active) return;
    // Wait out anything already on screen (the offline report modal fires
    // after us in boot()). Bounded, so a permanently-open modal cannot leave
    // this polling forever.
    if (modalOpen() && startRetries < START_RETRY_MAX) {
      startRetries++;
      startTimer = setTimeout(attempt, START_RETRY_MS);
      return;
    }
    safe(() => startSequence(now.step));
  };
  startTimer = setTimeout(attempt, START_DELAY_MS);
}

/**
 * The language changed. main.js calls the first hook it finds on the module
 * ('relocalize'), so this must NOT also subscribe to 'locale:changed' or every
 * string would be rebuilt twice.
 */
export function relocalize() {
  if (active) {
    if (layerEl) layerEl.setAttribute('dir', safe(() => dir(), 'rtl'));
    renderCard();
    lastLayout = ''; // the card changed size, so re-place it next frame
  }
  if (hintEl) {
    // Simplest correct answer for a transient card: drop it. It is re-shown on
    // the next live event if it was never dismissed.
    dismissHint();
  }
  if (helpBackdrop) {
    const page = helpPage;
    openHelp(page);
  }
}
