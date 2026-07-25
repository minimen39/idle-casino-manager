/**
 * main.js — boot + integration layer.
 *
 * Responsibilities (nothing else lives here):
 *   0. Boot prelude, before ANY module renders: put the document on a
 *      trailing-slash URL (so the service worker's './' scope matches) and
 *      initialise the locale (so <html lang/dir> and the first paint are right).
 *   1. Boot the persisted state, credit offline earnings and show the report.
 *   2. Build the floor plan and construct the three sims for the active branch.
 *   3. Mount every UI module into its DOM host and provide the buttons that
 *      open the modals the UI modules expose (world map, mini-games, shop, ad).
 *   4. Run the rAF loop: the SIM step gets a dt clamped to CONFIG.loop.maxDt,
 *      while income / autosave / UI timers run off the real elapsed time, so a
 *      phone that drops frames still earns exactly what the HUD advertises.
 *   5. Route canvas pointer input: screen -> world -> live events -> guests,
 *      and drive the renderer camera (wheel zoom, drag pan, pinch, keyboard).
 *   6. Invalidate the layout on 'purchase' and fully rebuild the sims on
 *      'world:switched' / 'world:unlocked'.
 *   7. Own the two things only the shell can own: the camera's view insets
 *      (contract C2 — how much chrome floats over the full-viewport canvas) and
 *      the Android hardware Back button (a Back press closes the top modal
 *      instead of leaving the installed PWA).
 *
 * Camera contract used here (renderer.js owns the implementation):
 *   renderer.screenToWorld(cssX, cssY) -> world px   (canvas-relative CSS px in)
 *   renderer.zoomBy(factor, anchorCssX, anchorCssY)
 *   renderer.setZoom(z, anchorCssX, anchorCssY)
 *   renderer.panBy(dxCss, dyCss) / renderer.fitView() / renderer.getZoom()
 * Every call is feature-detected so a renderer without a camera still runs.
 *
 * Income authority: GuestSim.payToEconomy is turned OFF here on purpose (the
 * flag exists for exactly this) so the 1s tick below is the single source of
 * earnings for the active branch. The guest sim still tracks everything and
 * still produces the floating "+$" popups, which are forwarded to the renderer.
 * That forwarding (drainPopups) is the ONLY place a guest's money becomes a
 * popup — a tip must never draw its own on top of it.
 *
 * i18n: every string main.js puts on screen comes from t(). initLocale() runs
 * before anything is mounted, and 'locale:changed' re-labels what is already on
 * screen (see applyLocaleToUI) — switching language never needs a reload.
 */

import {
  CONFIG,
  VENUE_KEYS,
  STATION_KEYS,
  worldDefById
} from './core/config.js';
import { bus, toast } from './core/events.js';
import {
  state,
  activeWorld,
  save,
  flushSave,
  grantOffline,
  multiplyOfflineReward
} from './core/state.js';
import { incomeRate, addMoney, fmtMoney, fmtTime, recomputeTier } from './core/economy.js';
import {
  initLocale,
  t,
  hasKey,
  dir as localeDir,
  getLocale,
  onLocaleChanged
} from './core/i18n.js';
import { buildLayout } from './sim/layout.js';
import { GuestSim } from './sim/guests.js';
import { StaffSim } from './sim/staff.js';
import { LiveEventSim } from './sim/liveEvents.js';
import { Renderer } from './render/renderer.js';

import * as hud from './ui/hud.js';
import * as panels from './ui/panels.js';
import * as worldMap from './ui/worldMap.js';
import * as minigames from './ui/minigames.js';
import * as monetization from './ui/monetization.js';

/* ------------------------------------------------------------------ *
 *  Boot prelude — runs at module evaluation, before anything is mounted
 *
 *  1. ensureTrailingSlash(): a WhatsApp/shared link without the trailing slash
 *     ('…/idle-casino-manager') sits OUTSIDE the service worker's './' scope,
 *     so Chrome shows its offline page even with the whole app cached, and every
 *     relative URL (./sw.js, ./manifest.webmanifest) resolves one level too
 *     high. history.replaceState fixes the document URL in place — no
 *     navigation, so it can never loop.
 *  2. initLocale(): restores the saved language (or picks one from
 *     navigator.language) and stamps <html lang/dir> before the first paint.
 * ------------------------------------------------------------------ */

/**
 * Rewrite '…/path' to '…/path/' when the document was opened without the
 * trailing slash. No-op for a file that names itself (…/index.html), for
 * non-http(s) documents (file://), and whenever it is already correct.
 * Uses history.replaceState — never a reload — so it cannot loop.
 */
function ensureTrailingSlash() {
  try {
    if (typeof location === 'undefined' || typeof history === 'undefined') return;
    if (typeof history.replaceState !== 'function') return;
    const proto = String(location.protocol || '');
    if (proto !== 'http:' && proto !== 'https:') return;

    const path = String(location.pathname || '');
    if (path === '' || path.charAt(path.length - 1) === '/') return;
    const lower = path.toLowerCase();
    if (lower.slice(-5) === '.html' || lower.slice(-4) === '.htm') return;

    const next = path + '/' + String(location.search || '') + String(location.hash || '');
    history.replaceState(history.state, '', next);
  } catch (err) {
    /* A blocked/opaque history is not worth failing the boot over. */
  }
}

ensureTrailingSlash();
initLocale();

/**
 * ./ui/pwa.js (install prompt / offline banner / update toast) is pulled in with
 * a *dynamic* import on purpose: it is the only UI module that is not required
 * for the game to run, and a missing or throwing pwa.js must never blank the
 * screen. It is mounted and updated exactly like the static UI modules below —
 * see mountPwaUI() / refreshUI(). Contract expected of it:
 *     mount(hostElement)   optional
 *     update()             optional, called on every UI refresh
 * The path stays relative so it resolves under the GitHub Pages subpath.
 *
 * The fetch is kicked off here, at module-evaluation time, so pwa.js is ready
 * essentially as early as a static import would be — it has to attach its
 * 'beforeinstallprompt' listener before Chrome fires that event.
 */
const pwaModulePromise = (() => {
  let p = null;
  try {
    p = import('./ui/pwa.js');
  } catch (err) {
    return null;
  }
  // Keep a handler attached so a failed load can never surface as an
  // unhandled rejection; mountPwaUI() attaches the real one.
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
})();

/* ------------------------------------------------------------------ *
 *  Local integration constants (pacing only — no balance numbers)
 * ------------------------------------------------------------------ */

const TUNING = {
  /** How often the DOM HUD/panels are refreshed, seconds. */
  uiTick: 0.25,
  /** Guards only get dispatched to an actor this far away (world px). */
  guardDispatchRadius: 520,
  /** Cleanliness bridge: token pool is topped up once supply recovers. */
  tokenRefillAt: 0.5,
  /** Popup color for guest earnings. */
  popupColor: '#9be27a',
  /** Android fires a burst of resize events while the URL bar animates. */
  viewportDebounceMs: 150,
  /**
   * Coming back from the background: below this many seconds away the credited
   * offline earnings are reported with a toast, above it with the full modal
   * (which can still be doubled by a rewarded ad).
   */
  resumeModalSeconds: 300,
  /** Give up on the Screen Wake Lock after this many rejected attempts. */
  wakeLockMaxFailures: 3
};

/**
 * Sanity bound on the REAL elapsed time a single frame may credit, seconds.
 * The wall-clock accumulators (income / autosave / UI) run off unclamped time
 * so a slow phone earns what the HUD advertises — see frame(). Time spent
 * backgrounded never gets here (startLoop resets the clock and grantOffline
 * pays that), so this only bounds a stall the loop lived through.
 */
const RAW_DT_CAP = 5;

/* ------------------------------------------------------------------ *
 *  Module-level runtime handles
 * ------------------------------------------------------------------ */

/** @type {HTMLCanvasElement|null} */
let canvas = null;
/** @type {Renderer|null} */
let renderer = null;

/** @type {any} */ let layout = null;
/** @type {GuestSim|null} */ let guestSim = null;
/** @type {StaffSim|null} */ let staffSim = null;
/** @type {LiveEventSim|null} */ let liveSim = null;

let layoutSig = '';
let currentWorldId = -1;

let running = false;
/** Handle of the pending requestAnimationFrame, so the loop can be cancelled. */
let rafId = 0;
let lastFrame = 0;
let incomeAcc = 0;
let saveAcc = 0;
let uiAcc = 0;

/** The offline report produced at boot, kept so the ad can double it. */
let offlineReport = null;
/** True while an offline-earnings modal is on screen (never stack two). */
let offlineModalOpen = false;

/** The lazily imported ./ui/pwa.js namespace, or null while unavailable. */
/** @type {{mount?:Function, update?:Function}|null} */
let pwaUI = null;

/** Screen Wake Lock sentinel + request bookkeeping (all feature-detected). */
let wakeLock = null;
let wakeLockPending = false;
let wakeLockFailures = 0;

/** Debounce handle for resize / orientationchange. */
let viewportTimer = null;
/** Last known orientation, so a real portrait<->landscape flip can re-frame. */
let lastPortrait = null;

/** @type {HTMLButtonElement|null} The rewarded-ad action-bar button, kept so its cooldown state can be refreshed. */
let adActionBtn = null;

/** @type {HTMLButtonElement|null} The '?' help button, kept so it can be retired if the guide module is absent. */
let helpActionBtn = null;

/**
 * Every action-bar button with the locale keys it was built from, so a language
 * switch can re-label it in place instead of rebuilding the bar.
 * @type {{btn:HTMLButtonElement, labelKey:string, titleKey:string}[]}
 */
const actionButtons = [];

/**
 * Set while an offline-earnings modal is on screen: re-applies every string in
 * it for the current locale. Cleared when the modal is dismissed.
 * @type {(()=>void)|null}
 */
let offlineModalRelocalize = null;

/* ------------------------------------------------------------------ *
 *  Tiny DOM helpers (every lookup is guarded)
 * ------------------------------------------------------------------ */

function byId(id) {
  if (typeof document === 'undefined' || !document.getElementById) return null;
  return document.getElementById(id);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function modalsHost() {
  return byId('modals') || byId('ui-layer') || (typeof document !== 'undefined' ? document.body : null);
}

/** Never let a UI module's failure take the game down. */
function safe(fn, label) {
  try {
    return fn();
  } catch (err) {
    if (typeof console !== 'undefined' && console.error) {
      console.error('[main] ' + label + ' failed:', err);
    }
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 *  Layout / sim lifecycle
 * ------------------------------------------------------------------ */

/** Signature of every placed-instance count: the layout only depends on these. */
function countSignature(w) {
  if (!w) return '';
  let s = String(w.id) + '#';
  const venues = w.venues || {};
  for (let i = 0; i < VENUE_KEYS.length; i++) {
    const e = venues[VENUE_KEYS[i]];
    s += (e && Number.isFinite(e.count) ? e.count : 0) + ',';
  }
  s += '|';
  const stations = w.stations || {};
  for (let i = 0; i < STATION_KEYS.length; i++) {
    const e = stations[STATION_KEYS[i]];
    s += (e && Number.isFinite(e.count) ? e.count : 0) + ',';
  }
  return s;
}

/** Build (or rebuild from scratch) the sims for whichever branch is active. */
function buildSims() {
  const w = activeWorld();
  const def = worldDefById(w.id);

  layout = buildLayout(def, w);
  layoutSig = countSignature(w);
  currentWorldId = w.id;

  staffSim = new StaffSim(w, def, layout);
  guestSim = new GuestSim(w, def, layout);
  guestSim.payToEconomy = false; // the 1s income tick below is the authority
  liveSim = new LiveEventSim(w, def, layout, staffSim);
  if (typeof liveSim.setGuestSim === 'function') liveSim.setGuestSim(guestSim);

  if (renderer) {
    if (typeof renderer.clearPopups === 'function') safe(() => renderer.clearPopups(), 'renderer.clearPopups');
    if (typeof renderer.invalidate === 'function') safe(() => renderer.invalidate(), 'renderer.invalidate');
  }
  // Re-frame the camera once the renderer has actually drawn the new layout.
  requestFitView();
}

/** Cheap check on every 'purchase': only a count change moves the floor plan. */
function refreshLayout() {
  if (!guestSim || !staffSim || !liveSim) return;
  const w = activeWorld();
  const sig = countSignature(w);
  if (sig === layoutSig) return;

  layoutSig = sig;
  layout = buildLayout(worldDefById(w.id), w);
  safe(() => guestSim.setLayout(layout), 'guestSim.setLayout');
  safe(() => staffSim.setLayout(layout), 'staffSim.setLayout');
  safe(() => liveSim.setLayout(layout), 'liveSim.setLayout');
  if (renderer && typeof renderer.invalidate === 'function') {
    safe(() => renderer.invalidate(), 'renderer.invalidate');
  }
  // The floor plan grew/shrank: re-frame it, unless the player is framing it themselves.
  requestFitView();
}

/** Full teardown + rebuild when the player moves to another branch. */
function switchWorld() {
  const w = activeWorld();
  if (w.id === currentWorldId && guestSim) return;

  if (guestSim && typeof guestSim.clear === 'function') safe(() => guestSim.clear(), 'guestSim.clear');
  if (liveSim && typeof liveSim.clear === 'function') safe(() => liveSim.clear(), 'liveSim.clear');
  guestSim = null;
  staffSim = null;
  liveSim = null;

  buildSims();
  refreshUI();
}

/* ------------------------------------------------------------------ *
 *  Cross-sim bridges (documented protocols the modules expose)
 * ------------------------------------------------------------------ */

/** StaffSim owns cleanliness + token supply; GuestSim consumes both. */
function bridgeStaffToGuests() {
  if (!guestSim || !staffSim) return;
  guestSim.setCleanliness(staffSim.cleanliness);
  if (guestSim.tokensLow && staffSim.tokenSupply >= TUNING.tokenRefillAt) {
    guestSim.refillTokens();
  }
}

/**
 * Guards physically walk to live-event trouble. staff.js documents the
 * protocol: set state='responding', tx/ty to the actor and targetId to its id;
 * clearing state back to 'patrol' releases the guard.
 */
function dispatchGuards() {
  if (!liveSim || !staffSim) return;
  const workers = staffSim.workers;
  if (!Array.isArray(workers) || workers.length === 0) return;
  const actors = liveSim.actors;
  const live = [];
  if (Array.isArray(actors)) {
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      if (a && !a.resolved) live.push(a);
    }
  }

  const taken = new Set();
  for (let i = 0; i < workers.length; i++) {
    const wk = workers[i];
    if (!wk || wk.role !== 'guard') continue;

    if (wk.state === 'responding') {
      const still = live.find((a) => a.id === wk.targetId);
      if (still) {
        wk.tx = still.x;
        wk.ty = still.y;
        taken.add(still.id);
        continue;
      }
      wk.state = 'patrol';
      wk.targetId = null;
    }
  }

  for (let i = 0; i < workers.length; i++) {
    const wk = workers[i];
    if (!wk || wk.role !== 'guard' || wk.state === 'responding') continue;

    let best = null;
    let bestD = TUNING.guardDispatchRadius;
    for (let k = 0; k < live.length; k++) {
      const a = live[k];
      if (taken.has(a.id)) continue;
      const d = Math.hypot(a.x - wk.x, a.y - wk.y);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    if (!best) continue;
    taken.add(best.id);
    wk.state = 'responding';
    wk.targetId = best.id;
    wk.tx = best.x;
    wk.ty = best.y;
  }
}

/** Forward the guest sim's "+$" beats into the renderer's popup layer. */
function drainPopups() {
  if (!guestSim || !renderer) return;
  const list = guestSim.popups;
  if (!Array.isArray(list)) return;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || p._sent) continue;
    p._sent = true;
    renderer.popup(p.x, p.y, '+' + fmtMoney(p.amount), TUNING.popupColor);
  }
}

/* ------------------------------------------------------------------ *
 *  Income
 * ------------------------------------------------------------------ */

/**
 * Pay every unlocked branch. The active branch earns its full rate (scaled by
 * how clean the floor is); the rest tick along at CONFIG.offline.rate, which is
 * the same "away from the branch" fraction offline progress uses.
 * @param {number} seconds
 */
function payIncome(seconds) {
  const list = Array.isArray(state.worlds) ? state.worlds : [];
  if (list.length === 0 || !(seconds > 0)) return;
  const active = activeWorld();
  const idleRate = Math.max(0, Number(CONFIG.offline.rate) || 0);
  const clean = staffSim && Number.isFinite(staffSim.incomeMultiplier) ? staffSim.incomeMultiplier : 1;

  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (!w || !w.unlocked) continue;
    let rate = 0;
    try {
      rate = incomeRate(w);
    } catch (err) {
      rate = 0;
    }
    if (!Number.isFinite(rate) || rate <= 0) continue;
    rate *= w === active ? clean : idleRate;
    const amount = rate * seconds;
    if (amount > 0) addMoney(w, amount);
  }
}

/* ------------------------------------------------------------------ *
 *  Camera input (wheel zoom / drag pan / pinch / keyboard) + click routing
 * ------------------------------------------------------------------ */

const CAM = {
  /** Multiplier per wheel notch. */
  wheelFactor: 1.12,
  /** A single button/keyboard/double-click zoom step. */
  stepFactor: 1.35,
  /** Double-click zooms a touch harder than a key press. */
  dblFactor: 1.6,
  /** Arrow-key pan distance, CSS px per press. */
  keyPan: 72,
  /** Wheel notches are clamped so one flick can never teleport the zoom. */
  maxNotches: 4,
  /** A pointerup only counts as a game click within this displacement (CSS px). */
  clickMaxDist: 5,
  /** Touch needs a looser gate: finger jitter on a deliberate tap routinely
   *  exceeds the mouse threshold, which would swallow taps on thieves/cheats. */
  clickMaxDistTouch: 14
};

/** Displacement gate for the pointer type that started the gesture. */
function clickSlopFor(pointerType) {
  return pointerType === 'touch' ? CAM.clickMaxDistTouch : CAM.clickMaxDist;
}

/** Live pointers on the canvas: pointerId -> {x, y, t} in canvas CSS px + ms. */
const pointers = new Map();

/**
 * A contact the browser never closes out — the system UI steals it (notification
 * shade, split-screen handle, an incoming call), or the page is backgrounded
 * mid-gesture — would otherwise sit in `pointers` forever. Two live entries is
 * all it takes to wedge every later touch into a phantom pinch, permanently.
 * Anything not updated for this long is treated as leaked.
 */
const POINTER_STALE_MS = 10000;

/**
 * The current single-pointer gesture, or null.
 * `panning` is the touch-slop latch: false until the contact has travelled far
 * enough to be a drag rather than a tap, and one-way thereafter for the life of
 * the gesture (so a pan that comes back to rest does not re-arm the gate).
 * @type {{id:number, startX:number, startY:number, lastX:number, lastY:number,
 *         maxDist:number, slop:number, canClick:boolean, panning:boolean}|null}
 */
let gesture = null;

/**
 * The current two-pointer pinch, or null. `ids` pins the pinch to the exact two
 * contacts it was baselined on: with a third contact down (a thumb or a palm
 * grazing the glass) the *set* of pointers can change without its size
 * dropping below 2, and a pinch measured against a different finger pair than
 * it started on jumps the camera by the whole difference in one frame.
 * @type {{ids:number[], startDist:number, startZoom:number, midX:number, midY:number}|null}
 */
let pinch = null;

/** Set when the camera should be re-framed after the next draw (layout known then). */
let fitPending = false;

/**
 * Frames that must be drawn even while a modal is up, so a pending re-frame can
 * still be measured and shown. Counted down in frame(); see requestFitView().
 */
let renderWarmup = 0;

/**
 * True once the player has zoomed or panned by hand. A layout rebuild (a
 * purchase) then leaves their framing alone; a boot / branch switch always
 * re-fits because those reset the flag.
 */
let cameraTouched = false;

/**
 * Ask for a fitView once the renderer has actually seen the current layout
 * (fitView needs the drawn bounds, so it is deferred to just after draw()).
 * @param {boolean} [force] re-frame even if the player moved the camera.
 */
function requestFitView(force) {
  if (!force && cameraTouched) return;
  fitPending = true;
  // Framing costs TWO frames: fitView() measures against the frame the renderer
  // just drew, and the result is only visible on the frame after that. Those
  // two must happen even behind a modal (gap G3's render pause) — the offline
  // report opens during boot, before the world has ever been framed, and
  // pausing there would leave a blank canvas under its blur instead of the
  // casino. See the render block in frame().
  renderWarmup = 2;
}

/**
 * Last zoom broadcast on the bus, so 'camera:changed' only fires when the
 * value actually moved. -1 is "never sent".
 */
let lastZoomSent = -1;

/**
 * Broadcast the current zoom so hud.js can update its `.zoom-label`.
 * hud.js listens for 'camera:changed' {zoom} and never imports the renderer,
 * so main.js is the only place that can bridge the two. Polled once per frame
 * (a number compare) rather than emitted from each camera entry point, so
 * renderer-internal zoom changes — fitView() on a world switch, the pan clamp,
 * the [minZoom, maxZoom] clamp — are reflected too.
 */
function syncCameraZoom() {
  if (!renderer || typeof renderer.getZoom !== 'function') return;
  const z = Number(renderer.getZoom());
  if (!Number.isFinite(z) || z <= 0) return;
  if (Math.abs(z - lastZoomSent) < 0.0005) return;
  lastZoomSent = z;
  safe(
    () =>
      bus.emit('camera:changed', {
        zoom: z,
        minZoom: Number(renderer.minZoom) || 0,
        maxZoom: Number(renderer.maxZoom) || 0
      }),
    'bus.emit camera:changed'
  );
}

/** Apply a deferred fitView. Called from the frame loop right after draw(). */
function applyPendingFit() {
  if (!fitPending) return;
  fitPending = false;
  // fitView() frames against the inset rectangle (C2), so the insets must be
  // current BEFORE it runs — otherwise the first frame after a boot / rotation
  // is framed behind the HUD and only corrected on the next re-fit.
  applyViewInsets();
  if (renderer && typeof renderer.fitView === 'function') {
    safe(() => renderer.fitView(), 'renderer.fitView');
    cameraTouched = false;
  }
}

/** Pointer/mouse event -> canvas-relative CSS pixels. */
function cssPos(ev) {
  let left = 0;
  let top = 0;
  if (canvas && canvas.getBoundingClientRect) {
    const rect = canvas.getBoundingClientRect();
    left = rect.left;
    top = rect.top;
  }
  const cx = Number.isFinite(ev && ev.clientX) ? ev.clientX : 0;
  const cy = Number.isFinite(ev && ev.clientY) ? ev.clientY : 0;
  return { x: cx - left, y: cy - top };
}

/** Centre of the canvas in CSS px — the anchor for keyboard/HUD zooming. */
function canvasCenter() {
  if (canvas && canvas.getBoundingClientRect) {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.width / 2, y: rect.height / 2 };
  }
  return { x: 0, y: 0 };
}

function cameraZoomBy(factor, ax, ay) {
  if (!renderer || typeof renderer.zoomBy !== 'function') return;
  if (!Number.isFinite(factor) || factor <= 0) return;
  const a = Number.isFinite(ax) && Number.isFinite(ay) ? { x: ax, y: ay } : canvasCenter();
  cameraTouched = true;
  safe(() => renderer.zoomBy(factor, a.x, a.y), 'renderer.zoomBy');
}

function cameraPanBy(dx, dy) {
  if (!renderer || typeof renderer.panBy !== 'function') return;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  if (dx === 0 && dy === 0) return;
  cameraTouched = true;
  safe(() => renderer.panBy(dx, dy), 'renderer.panBy');
}

/** Bus-driven camera control so HUD buttons never need the renderer. */
function cameraCommand(dir) {
  if (dir === 'fit') {
    if (renderer && typeof renderer.fitView === 'function') {
      safe(() => renderer.fitView(), 'renderer.fitView');
      cameraTouched = false;
      fitPending = false;
    }
    return;
  }
  if (dir === 'out') cameraZoomBy(1 / CAM.stepFactor);
  else cameraZoomBy(CAM.stepFactor);
}

/* ---------------- camera view insets (contract C2) ---------------- *
 *
 *  The canvas is full-viewport, so the HUD (top) and the collapsed build
 *  drawer (bottom sheet) FLOAT OVER it. Left to itself fitView() would frame
 *  the diorama into the raw canvas box and park a third of the casino behind
 *  opaque chrome. renderer.setViewInsets({top,right,bottom,left}) tells the
 *  camera how much of each edge is covered; it frames — and recomputes
 *  minZoom — against the unobstructed rectangle instead.
 *
 *  Everything here is MEASURED. Not one pixel constant: the HUD's height is
 *  60px + safe-top, the drawer strip depends on the handle + header font
 *  metrics, and both change with the language (Hebrew wraps differently), the
 *  breakpoint and the device's notch. A hardcoded number would be wrong on the
 *  first phone that isn't this one.
 * ------------------------------------------------------------------ */

/**
 * Chrome that overlays the canvas. `#hud` is the opaque top bar; `#actions` is
 * the action dock pinned beneath it; `.build-panel` is the drawer, which is a
 * bottom sheet on phones and a side column on wide screens — which edge each one
 * occupies is derived from its geometry below, never assumed.
 *
 * `#actions` earns its place because the dock's pills are opaque and 44px tall:
 * without it the camera happily frames the top of the floor plan underneath
 * them. Its own box is transparent (contract C1) but it is the only stable
 * handle on the row's extent, and the row is solid enough across its width that
 * treating the whole strip as chrome is right.
 */
const INSET_SELECTORS = ['#hud', '#actions', '.build-panel'];

/** No single edge may eat more than this fraction of the canvas. */
const INSET_MAX_FRACTION = 0.4;

/** Last insets pushed to the renderer, so an unchanged measurement is free. */
let lastViewInsets = null;
/**
 * The collapsed sheet's intrusion from the canvas BOTTOM EDGE, as
 * edgeIntrusion() reports it — i.e. the strip height PLUS the safe-area gap the
 * sheet is translated up by. Only ever written from a real measurement taken
 * while the drawer was collapsed, so it is ground truth and directly comparable
 * with `hit.amount`. Cleared on a viewport change (rotation retunes the strip).
 */
let collapsedDrawerPx = 0;
/**
 * Fallback strip height for the window in which we have never SEEN the drawer
 * collapsed. This is a drawer-local height (the `--drawer-collapsed-h` token /
 * contract C3's `collapsedHeight` payload) and therefore excludes the safe-area
 * gap — collapsedDrawerIntrusion() adds it back before comparing.
 */
let collapsedDrawerHintPx = 0;
/** Hidden probe element used to read env(safe-area-inset-*) as real pixels. */
let safeAreaProbe = null;

function pxOf(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * env(safe-area-inset-*) in CSS px.
 *
 * Read off a hidden probe's resolved padding rather than
 * getComputedStyle(:root).getPropertyValue('--safe-top'): a custom property's
 * computed value is a token stream, so browsers are free to hand back the
 * literal 'env(safe-area-inset-top, 0px)' text. Padding always resolves to px.
 */
function safeAreaInsets() {
  const zero = { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof document === 'undefined' || !document.body || typeof window === 'undefined') return zero;
  return (
    safe(() => {
      if (!safeAreaProbe || !safeAreaProbe.isConnected) {
        const node = document.createElement('div');
        node.setAttribute('aria-hidden', 'true');
        node.style.cssText =
          'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
          'padding:env(safe-area-inset-top) env(safe-area-inset-right) ' +
          'env(safe-area-inset-bottom) env(safe-area-inset-left);';
        document.body.appendChild(node);
        safeAreaProbe = node;
      }
      const cs = window.getComputedStyle(safeAreaProbe);
      return {
        top: pxOf(cs.paddingTop),
        right: pxOf(cs.paddingRight),
        bottom: pxOf(cs.paddingBottom),
        left: pxOf(cs.paddingLeft)
      };
    }, 'safeAreaInsets') || zero
  );
}

/**
 * Which canvas edge an overlay hugs, and how far it intrudes from it.
 *
 * This used to just take the smallest of the four intrusions, on the reasoning
 * that a full-width top bar intrudes 60px from the top but the whole height
 * from the bottom. That is only true while the overlay is SHORT. The expanded
 * build sheet is 411x471 on a 411x760 canvas, which makes the candidates
 * top=760, bottom=471, left=411, right=411 — so "smallest" picked 'left' and
 * the camera framed the entire casino off the side of the screen.
 *
 * Span beats distance. An overlay that reaches both vertical edges is a
 * horizontal band and can only be chrome on the top or the bottom, whatever the
 * arithmetic says; the mirror case holds for a vertical band. Only when an
 * overlay spans neither axis (a floating widget like the zoom cluster) does the
 * nearest-edge fallback apply.
 * @returns {{edge:string, amount:number}|null}
 */
function edgeIntrusion(rect, box) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  // No overlap with the canvas at all (off-screen / collapsed away).
  if (rect.bottom <= box.top || rect.top >= box.bottom) return null;
  if (rect.right <= box.left || rect.left >= box.right) return null;

  // Overlays are inset from the edge by a margin/safe-area, so "reaches the
  // edge" needs slack. 2% of the short side is ~8px on a phone, which clears
  // the --spacing-* margins the action dock and the sheet actually use.
  const eps = Math.max(2, Math.min(box.width, box.height) * 0.02);
  const spansX = rect.left <= box.left + eps && rect.right >= box.right - eps;
  const spansY = rect.top <= box.top + eps && rect.bottom >= box.bottom - eps;

  // A band that spans BOTH axes covers the canvas (a full-screen modal
  // backdrop). It is not edge chrome and must not move the camera at all.
  if (spansX && spansY) return null;

  const fromTop = rect.bottom - box.top;
  const fromBottom = box.bottom - rect.top;
  const fromLeft = rect.right - box.left;
  const fromRight = box.right - rect.left;

  if (spansX) {
    // Horizontal band: whichever horizontal edge it sits nearer to.
    return rect.top - box.top <= box.bottom - rect.bottom
      ? { edge: 'top', amount: fromTop }
      : { edge: 'bottom', amount: fromBottom };
  }
  if (spansY) {
    return rect.left - box.left <= box.right - rect.right
      ? { edge: 'left', amount: fromLeft }
      : { edge: 'right', amount: fromRight };
  }

  // Floating widget: nearest edge by smallest intrusion, as before.
  const candidates = [
    { edge: 'top', amount: fromTop },
    { edge: 'bottom', amount: fromBottom },
    { edge: 'left', amount: fromLeft },
    { edge: 'right', amount: fromRight }
  ];
  let best = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!(c.amount > 0)) continue;
    if (!best || c.amount < best.amount) best = c;
  }
  return best;
}

/**
 * The `--drawer-collapsed-h` token, in px, or 0.
 *
 * styles.css owns this number (78px, retuned in the short-landscape block) and
 * panels.js already reads the same token, so this is not a duplicated constant —
 * it is the same single source, read from the DOM. Only a plain px literal is
 * accepted: a calc() resolves to unparseable token text on a custom property.
 */
function cssDrawerCollapsedPx(node) {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 0;
  return (
    safe(() => {
      const raw = String(window.getComputedStyle(node).getPropertyValue('--drawer-collapsed-h') || '').trim();
      if (!/^\d+(\.\d+)?px$/.test(raw)) return 0;
      const px = parseFloat(raw);
      return Number.isFinite(px) && px > 0 ? px : 0;
    }, 'cssDrawerCollapsedPx') || 0
  );
}

/**
 * How much larger than the PREDICTED collapsed strip a measurement may be and
 * still be believed to have been taken with the sheet at rest.
 *
 * The two cases this has to separate are not close: a settled strip measures
 * `--drawer-collapsed-h` + safe-bottom (78 + 24 = 102px on the Pixel), while a
 * measurement taken during the slide reads up to the sheet's full 62dvh (471px)
 * — 4.6x. 1.6 leaves generous room for sub-pixel rounding, a font swap that
 * grew the tab row past its token, and Hebrew's taller line box, while still
 * rejecting anything mid-animation by a wide margin.
 */
const COLLAPSED_STRIP_TOLERANCE = 1.6;

/**
 * What the collapsed strip SHOULD intrude from the canvas bottom, derived from
 * CSS rather than from the sheet's current position.
 *
 * Deliberately does NOT consult `collapsedDrawerPx`: this is the predicate that
 * decides whether a candidate measurement is trustworthy enough to become
 * `collapsedDrawerPx`, so letting a past measurement vouch for the next one
 * would let one bad reading validate its own successors forever.
 *
 * The geometry it predicts is exact, not a guess. `.panels` is
 * `position: fixed; bottom: 0` and `.build-panel` is translated by
 * `100% - var(--drawer-collapsed-h) - var(--safe-bottom)`, so the collapsed
 * sheet's top edge sits exactly that far above the viewport bottom — which,
 * with the canvas full-bleed, is exactly `edgeIntrusion()`'s `fromBottom`.
 * @returns {number} 0 when neither the token nor a C3 payload is available.
 */
function predictedCollapsedIntrusion(node, safeBottom) {
  let strip = cssDrawerCollapsedPx(node);
  if (!(strip > 0)) strip = collapsedDrawerHintPx;
  if (!(strip > 0)) return 0;
  return strip + (safeBottom > 0 ? safeBottom : 0);
}

/**
 * How far the drawer's COLLAPSED strip would intrude from the canvas bottom.
 *
 * This exists because the "only the collapsed strip counts" clamp had a hole:
 * it needs a collapsed measurement, and there is no guarantee one has ever been
 * taken. The player can expand the sheet before the first UI tick; a save with
 * the sheet remembered open restores expanded; a rotation clears the measured
 * value while the sheet is up. Without a fallback the clamp is skipped and the
 * FULL 471px sheet becomes a bottom inset (capped at 40%), which squashes the
 * casino into a band and un-squashes it the moment the sheet closes — the exact
 * seasick re-framing the clamp exists to prevent.
 *
 * Preference order is freshest-and-most-direct first:
 *   1. a real measurement of the collapsed strip (already in canvas-edge units),
 *   2. the live `--drawer-collapsed-h` token,
 *   3. the last `drawer:changed` payload (contract C3).
 * 2 and 3 are drawer-local heights, so the safe-area gap the sheet is
 * translated up by is added back to put them in canvas-edge units.
 * @returns {number} 0 when the strip is genuinely unknown.
 */
function collapsedDrawerIntrusion(node, safeBottom) {
  if (collapsedDrawerPx > 0) return collapsedDrawerPx;
  let strip = cssDrawerCollapsedPx(node);
  if (!(strip > 0)) strip = collapsedDrawerHintPx;
  if (!(strip > 0)) return 0;
  return strip + (safeBottom > 0 ? safeBottom : 0);
}

/**
 * Measure the chrome floating over the canvas and hand it to the renderer.
 * Cheap enough to run on the 0.25s UI tick, which is what makes this
 * self-healing: whatever any other module does to the layout, the camera's idea
 * of the visible rectangle catches up within a quarter second.
 */
function applyViewInsets() {
  if (!renderer || typeof renderer.setViewInsets !== 'function') return; // WS-RENDER may not have landed yet
  if (!canvas || !canvas.getBoundingClientRect) return;
  if (typeof document === 'undefined' || !document.querySelector) return;

  const box = canvas.getBoundingClientRect();
  if (!(box.width > 0) || !(box.height > 0)) return;

  // The safe area is the floor: even with no chrome at all, nothing may be
  // framed under the punch-hole camera or the gesture bar.
  const insets = safeAreaInsets();
  // Captured before the loop mutates `insets`: the collapsed-strip fallback is
  // a drawer-local height and needs the raw safe-area gap, not a running max.
  const safeBottomPx = insets.bottom;
  const maxX = box.width * INSET_MAX_FRACTION;
  const maxY = box.height * INSET_MAX_FRACTION;

  for (let i = 0; i < INSET_SELECTORS.length; i++) {
    const sel = INSET_SELECTORS[i];
    const node = safe(() => document.querySelector(sel), 'querySelector ' + sel);
    if (!node || typeof node.getBoundingClientRect !== 'function') continue;
    const hit = edgeIntrusion(node.getBoundingClientRect(), box);
    if (!hit) continue;

    let amount = hit.amount;
    if (hit.edge === 'bottom' && node.classList) {
      // The expanded drawer is a temporary sheet the player pulled up; framing
      // the casino above it (and re-framing again on every open/close) would be
      // seasick. Only the COLLAPSED strip is permanent chrome.
      //
      // "Collapsed" is NOT simply the absence of `.is-expanded`. The sheet
      // slides on `transition: transform var(--dur-slow)` (320ms) and
      // panels.js flips the classes the instant the collapse STARTS, so for a
      // third of a second the class says collapsed while
      // getBoundingClientRect() still returns the full 471px sheet. Recording
      // that as the collapsed strip is not a cosmetic slip: it becomes the
      // ceiling every later clamp is measured against, so one collapse gesture
      // pins a 40%-of-the-canvas bottom inset that only unwinds when panels.js
      // re-emits on transitionend — and if the player re-opens the sheet
      // inside that window, the clamp this whole branch exists for is a no-op.
      // So cross-check the reading against what CSS says the strip must be.
      const predicted = predictedCollapsedIntrusion(node, safeBottomPx);
      const settled =
        !node.classList.contains('is-expanded') &&
        // No token and no C3 payload: nothing to check against, so trust the
        // measurement exactly as this code did before the check existed.
        (!(predicted > 0) || amount <= predicted * COLLAPSED_STRIP_TOLERANCE);
      if (!settled) {
        const strip = collapsedDrawerIntrusion(node, safeBottomPx);
        if (strip > 0) {
          amount = Math.min(amount, strip);
        } else if (lastViewInsets) {
          // Strip genuinely unknown (no measurement, no token, no C3 payload):
          // hold whatever bottom inset the camera was already framing against
          // rather than letting a temporary sheet redefine it.
          amount = Math.min(amount, lastViewInsets.bottom);
        } else {
          // Nothing known at all — first pass, sheet already open. An expanded
          // sheet is transient chrome, so framing UNDER it is the lesser evil:
          // the alternative is a 40%-of-the-screen inset that snaps back the
          // instant the player closes the sheet.
          amount = 0;
        }
      } else {
        collapsedDrawerPx = amount;
      }
    }

    const cap = hit.edge === 'left' || hit.edge === 'right' ? maxX : maxY;
    if (amount > cap) amount = cap;
    if (amount > insets[hit.edge]) insets[hit.edge] = amount;
  }

  // Sub-pixel churn (a scrollbar-less relayout, a font swap) must not thrash
  // fitView; the renderer no-ops on equal values, we no-op on near-equal ones.
  if (
    lastViewInsets &&
    Math.abs(lastViewInsets.top - insets.top) < 0.5 &&
    Math.abs(lastViewInsets.right - insets.right) < 0.5 &&
    Math.abs(lastViewInsets.bottom - insets.bottom) < 0.5 &&
    Math.abs(lastViewInsets.left - insets.left) < 0.5
  ) {
    return;
  }
  lastViewInsets = insets;
  safe(() => renderer.setViewInsets(insets), 'renderer.setViewInsets');
}

/* ---------------- wheel ---------------- */

function onCanvasWheel(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  if (!renderer || typeof renderer.zoomBy !== 'function') return;

  let dy = Number(ev && ev.deltaY);
  if (!Number.isFinite(dy) || dy === 0) return;

  // Normalise deltaMode: 0 = pixels, 1 = lines, 2 = pages.
  const mode = ev.deltaMode || 0;
  if (mode === 1) dy *= 16;
  else if (mode === 2) {
    const h = canvas && canvas.clientHeight ? canvas.clientHeight : 600;
    dy *= h;
  }

  // ~100px of wheel travel == one notch. Trackpads emit many small deltas,
  // mice emit few large ones; both land on a sane per-event factor.
  let notches = dy / 100;
  if (notches > CAM.maxNotches) notches = CAM.maxNotches;
  else if (notches < -CAM.maxNotches) notches = -CAM.maxNotches;

  const p = cssPos(ev);
  cameraZoomBy(Math.pow(CAM.wheelFactor, -notches), p.x, p.y);
}

/* ---------------- pointer (drag pan / pinch / click) ---------------- */

/** Wall clock for pointer bookkeeping; performance.now() when it exists. */
function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** The first two live contacts, in insertion order — the pair a pinch adopts. */
function pinchPairIds() {
  const ids = [];
  pointers.forEach((v, id) => {
    if (ids.length < 2) ids.push(id);
  });
  return ids.length === 2 ? ids : null;
}

/**
 * Geometry of a specific contact pair. `ids` is the pair the live pinch was
 * baselined on; without it the first two live contacts are used (arming).
 * @param {number[]|null} [ids]
 */
function pinchState(ids) {
  const pair = ids && ids.length === 2 ? ids : pinchPairIds();
  if (!pair) return null;
  const a = pointers.get(pair[0]);
  const b = pointers.get(pair[1]);
  if (!a || !b) return null;
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2
  };
}

function beginPinch() {
  const ids = pinchPairIds();
  const s = pinchState(ids);
  if (!ids || !s || !(s.dist > 0)) return;
  const z = renderer && typeof renderer.getZoom === 'function' ? Number(renderer.getZoom()) : 1;
  pinch = {
    ids,
    startDist: s.dist,
    startZoom: Number.isFinite(z) && z > 0 ? z : 1,
    midX: s.midX,
    midY: s.midY
  };
  if (gesture) gesture.canClick = false; // a second finger is never a tap
}

/**
 * Drop contacts the browser never closed out. Two signals, both cheap:
 *   - a PRIMARY touch pointerdown means the browser considers this the first
 *     finger of a new touch session, so anything still in the map is a leak;
 *   - anything not updated for POINTER_STALE_MS is gone whatever the browser
 *     thinks (covers a stolen non-primary contact, and mouse/pen).
 * Without this a single lost contact wedges pinch AND pan forever, with no
 * recovery short of a reload — the exact failure this file is defending against.
 */
function prunePointers(ev) {
  if (ev && ev.pointerType === 'touch' && ev.isPrimary === true && pointers.size > 0) {
    resetPointers();
    return;
  }
  if (pointers.size === 0) return;
  const cutoff = nowMs() - POINTER_STALE_MS;
  const stale = [];
  pointers.forEach((p, id) => {
    if (!p || !Number.isFinite(p.t) || p.t < cutoff) stale.push(id);
  });
  for (let i = 0; i < stale.length; i++) {
    pointers.delete(stale[i]);
    if (gesture && gesture.id === stale[i]) gesture = null;
    if (pinch && (pinch.ids[0] === stale[i] || pinch.ids[1] === stale[i])) pinch = null;
  }
}

/** Hard reset of all pointer state (app switch, lost focus, leaked contacts). */
function resetPointers() {
  pointers.clear();
  gesture = null;
  pinch = null;
  if (canvas && canvas.style) canvas.style.cursor = '';
}

function onCanvasPointerDown(ev) {
  if (!canvas) return;
  // Chrome only grants a wake lock to a visible document and sometimes only
  // after an interaction; a touch is the cheapest place to retry (the call
  // early-returns once we hold one, or after a few refusals).
  if (!wakeLock) acquireWakeLock();
  prunePointers(ev);
  const p = cssPos(ev);
  p.t = nowMs();
  pointers.set(ev.pointerId, p);

  if (canvas.setPointerCapture) {
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch (err) {
      /* capture is best-effort */
    }
  }

  if (pointers.size >= 2) {
    beginPinch();
    return;
  }

  gesture = {
    id: ev.pointerId,
    startX: p.x,
    startY: p.y,
    lastX: p.x,
    lastY: p.y,
    maxDist: 0,
    slop: clickSlopFor(ev.pointerType),
    // Only the primary button starts a click; middle/right drag pans only.
    canClick: !Number.isFinite(ev.button) || ev.button === 0,
    // Nothing pans until the slop is cleared — see onCanvasPointerMove.
    panning: false
  };
  if (canvas.style) canvas.style.cursor = 'grabbing';
}

function onCanvasPointerMove(ev) {
  if (!pointers.has(ev.pointerId)) return;
  const p = cssPos(ev);
  p.t = nowMs();
  pointers.set(ev.pointerId, p);

  // --- two fingers: pinch zoom about the midpoint, and pan with the midpoint.
  if (pointers.size >= 2) {
    if (!pinch) beginPinch();
    const s = pinchState(pinch ? pinch.ids : null);
    if (!pinch || !s || !(pinch.startDist > 0)) return;
    if (renderer && typeof renderer.setZoom === 'function') {
      const target = pinch.startZoom * (s.dist / pinch.startDist);
      cameraTouched = true;
      safe(() => renderer.setZoom(target, s.midX, s.midY), 'renderer.setZoom');
    }
    cameraPanBy(s.midX - pinch.midX, s.midY - pinch.midY);
    pinch.midX = s.midX;
    pinch.midY = s.midY;
    // Keep the (frozen) single-pointer gesture's origin in sync with its
    // finger while a pinch is in progress. Without this, `gesture.lastX/Y`
    // stays wherever that finger was when the second finger landed; when the
    // pinch ends and this finger keeps panning alone, the single-pointer
    // branch below would compute `dx` against that stale origin and feed the
    // whole accumulated pinch displacement into `cameraPanBy` in one frame.
    if (gesture && pointers.has(gesture.id)) {
      const gp = pointers.get(gesture.id);
      gesture.lastX = gp.x;
      gesture.lastY = gp.y;
    }
    return;
  }

  // --- one finger / mouse button: drag to pan.
  if (!gesture || gesture.id !== ev.pointerId) return;
  const dx = p.x - gesture.lastX;
  const dy = p.y - gesture.lastY;
  gesture.lastX = p.x;
  gesture.lastY = p.y;

  const moved = Math.hypot(p.x - gesture.startX, p.y - gesture.startY);
  if (moved > gesture.maxDist) gesture.maxDist = moved;
  const slop = gesture.slop || CAM.clickMaxDist;
  if (gesture.maxDist > slop) gesture.canClick = false;

  /*
   * TOUCH SLOP. A finger held on a small target still wobbles a few px per
   * frame, and every one of those wobbles used to reach cameraPanBy — so the
   * world visibly crept out from under a stationary finger during a deliberate
   * tap (14px of slop is a lot of creep at the ~0.5 fit zoom).
   *
   * The gate is one-way, and the pre-slop travel is DISCARDED, never
   * accumulated and dumped in the frame the gesture is recognised — that would
   * snap the world by the whole slop radius, which is worse than the creep it
   * replaces.
   *
   * On the move that crosses the threshold, only the part of that move lying
   * beyond the slop radius is applied. Doing the obvious thing instead —
   * dropping the crossing move whole — throws away as much as one full sample
   * of travel, and a fast flick can be sampled ONCE: a 60px first move would
   * lose all 60px, then the finger's return leg would pan the full way back and
   * the camera would end up displaced from a gesture that went nowhere. Scaling
   * bounds the loss at exactly `slop` px however coarsely the digitiser
   * reports, which is what the platform's own scrollers do.
   */
  if (!gesture.panning) {
    if (gesture.maxDist <= slop) return;
    gesture.panning = true;
    // maxDist can only have crossed on THIS move, so it equals `moved` here and
    // moved - slop is the travel that is genuinely a pan.
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) return;
    const keep = Math.min(1, Math.max(0, moved - slop) / len);
    if (!(keep > 0)) return;
    cameraPanBy(dx * keep, dy * keep);
    return;
  }

  cameraPanBy(dx, dy);
}

/**
 * A finger is still down but nothing owns it: adopt it as a fresh single-pointer
 * gesture so panning continues seamlessly after the other finger lifts.
 *
 * The origin is seeded from where that finger is RIGHT NOW (pointers holds its
 * live position, kept current by onCanvasPointerMove) — never from where it was
 * when the pinch started. Seeding from the stale origin would feed the whole
 * accumulated pinch displacement into cameraPanBy on the very next move, which
 * is the same trap the "keep the frozen gesture in sync" comment in
 * onCanvasPointerMove above exists to avoid.
 *
 * canClick stays false (and maxDist Infinity): the tail of a pinch is never a
 * tap, so lifting the second finger must not resolve a thief or tip a guest.
 * `panning` starts true for the same reason — the slop gate is there to protect
 * taps, and this contact has already been disqualified from being one, so
 * making it re-earn the threshold would just drop the first move of the pan.
 */
function promoteSurvivingPointer() {
  if (gesture || pointers.size !== 1) return;
  let id = -1;
  let p = null;
  pointers.forEach((v, k) => {
    if (!p) {
      id = k;
      p = v;
    }
  });
  if (!p) return;
  gesture = {
    id,
    startX: p.x,
    startY: p.y,
    lastX: p.x,
    lastY: p.y,
    maxDist: Infinity,
    slop: CAM.clickMaxDistTouch,
    canClick: false,
    panning: true
  };
}

function endPointer(ev, cancelled) {
  const had = pointers.delete(ev.pointerId);
  if (canvas && canvas.releasePointerCapture) {
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch (err) {
      /* already released */
    }
  }

  // The pinch dies with either of the two contacts it was baselined on. If
  // other contacts are still down, re-arm immediately against the new pair so
  // the gesture continues from the CURRENT geometry instead of snapping to a
  // stale startDist/mid.
  if (pinch && (pinch.ids[0] === ev.pointerId || pinch.ids[1] === ev.pointerId)) {
    pinch = null;
    if (pointers.size >= 2) beginPinch();
  } else if (pointers.size < 2) {
    pinch = null;
  }

  const owned = !!gesture && gesture.id === ev.pointerId;
  const g = owned ? gesture : null;
  if (owned) gesture = null;

  // Whoever is left keeps panning — including the case this whole helper exists
  // for: the FIRST finger (the one that owned `gesture`) lifting out of a pinch.
  promoteSurvivingPointer();

  if (pointers.size === 0 && canvas && canvas.style) canvas.style.cursor = '';
  if (!owned || !g) return;
  if (!had || cancelled) return;

  const p = cssPos(ev);
  const dist = Math.max(g.maxDist, Math.hypot(p.x - g.startX, p.y - g.startY));

  // A pan is not a click: any real displacement (a pan, by definition) already
  // clears canClick / fails this check in onCanvasPointerMove. No duration
  // gate here — a deliberate, held-still aim-then-press on a small mobile
  // target must still register as a tap.
  if (g.canClick && dist <= (g.slop || CAM.clickMaxDist)) {
    onCanvasClick(p.x, p.y);
  }
}

function onCanvasPointerUp(ev) {
  endPointer(ev, false);
}

function onCanvasPointerCancel(ev) {
  endPointer(ev, true);
}

function onCanvasDblClick(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const p = cssPos(ev);
  cameraZoomBy(CAM.dblFactor, p.x, p.y);
}

/* ---------------- keyboard ---------------- */

/** True when the keystroke belongs to a modal, an input or a focused control. */
function keyboardBusy(ev) {
  const t = ev && ev.target;
  if (!t || typeof t !== 'object') return false;
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return true;
  if (t.isContentEditable) return true;
  if (typeof t.closest === 'function') {
    if (t.closest('.modal, .modal-backdrop, [role="dialog"]')) return true;
  }
  // Any open modal swallows camera keys, whatever has focus.
  if (typeof document !== 'undefined' && document.querySelector) {
    if (document.querySelector('.modal-backdrop')) return true;
  }
  return false;
}

function onKeyDown(ev) {
  if (!renderer) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (keyboardBusy(ev)) return;

  const k = ev.key;
  let handled = true;

  switch (k) {
    case '+':
    case '=':
      cameraZoomBy(CAM.stepFactor);
      break;
    case '-':
    case '_':
      cameraZoomBy(1 / CAM.stepFactor);
      break;
    case '0':
    case 'f':
    case 'F':
      cameraCommand('fit');
      break;
    case 'ArrowLeft':
      cameraPanBy(CAM.keyPan, 0);
      break;
    case 'ArrowRight':
      cameraPanBy(-CAM.keyPan, 0);
      break;
    case 'ArrowUp':
      cameraPanBy(0, CAM.keyPan);
      break;
    case 'ArrowDown':
      cameraPanBy(0, -CAM.keyPan);
      break;
    default:
      handled = false;
  }

  if (handled && ev.preventDefault) ev.preventDefault();
}

/* ---------------- click routing (unchanged game behaviour) ---------------- */

/**
 * A confirmed tap on the floor. Coordinates are canvas-relative CSS px; the
 * renderer inverts camera + iso to give world px, which is exactly what
 * liveEvents.hitTest / guests.hitTest expect.
 * @param {number} cx
 * @param {number} cy
 */
function onCanvasClick(cx, cy) {
  if (!renderer) return;
  const pt = safe(() => renderer.screenToWorld(cx, cy), 'renderer.screenToWorld');
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;

  if (liveSim) {
    const actor = safe(() => liveSim.hitTest(pt.x, pt.y), 'liveEvents.hitTest');
    if (actor) {
      safe(() => liveSim.resolve(actor), 'liveEvents.resolve');
      return;
    }
  }

  if (guestSim) {
    const guest = safe(() => guestSim.hitTest(pt.x, pt.y), 'guests.hitTest');
    if (guest) {
      const tipped = safe(() => guestSim.tip(guest), 'guests.tip');
      if (Number.isFinite(tipped) && tipped > 0) {
        // The wallet credit is main.js's job (the guest sim's own income is
        // gated behind payToEconomy=false), but the POPUP is not: guestSim.tip()
        // already pushed one onto guestSim.popups, which drainPopups() forwards
        // to renderer.popup() on the next frame. Drawing a second one here
        // stacked two "+$" labels on top of each other for a single tip.
        addMoney(activeWorld(), tipped);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 *  UI wiring
 * ------------------------------------------------------------------ */

/** Every statically mounted UI module, in mount order. */
const UI_MODULES = [
  { mod: hud, label: 'hud' },
  { mod: panels, label: 'panels' },
  { mod: worldMap, label: 'worldMap' },
  { mod: minigames, label: 'minigames' },
  { mod: monetization, label: 'monetization' }
];

/**
 * Optional hooks a UI module may export so main.js can tell it to rebuild its
 * DOM for a new locale. The first one found wins; a module that re-labels
 * itself inside update() (or from its own 'locale:changed' subscription) needs
 * none of them. main.js never re-mounts a module blindly: worldMap, minigames,
 * monetization and pwa all share the #modals host, so clearing it would take
 * the other three (and any open modal) down with it.
 */
const LOCALE_HOOKS = ['relocalize', 'applyLocale', 'rebuild', 'remount'];

function refreshUI() {
  safe(() => hud.update(), 'hud.update');
  safe(() => panels.update(), 'panels.update');
  safe(() => worldMap.update(), 'worldMap.update');
  safe(() => minigames.update(), 'minigames.update');
  safe(() => monetization.update(), 'monetization.update');
  updatePwaUI();
}

/** Call a module's locale hook, if it exposes one. */
function relocalizeModule(mod, label) {
  if (!mod) return;
  for (let i = 0; i < LOCALE_HOOKS.length; i++) {
    const name = LOCALE_HOOKS[i];
    if (typeof mod[name] === 'function') {
      safe(() => mod[name](), label + '.' + name);
      return;
    }
  }
}

/**
 * The language changed: re-label everything that is already on screen.
 * <html lang/dir> is already updated by i18n.setLocale() before this runs.
 */
function applyLocaleToUI() {
  applyDocumentTitle();
  applyManifestLink();
  relabelActionBar();
  if (offlineModalRelocalize) safe(() => offlineModalRelocalize(), 'offlineModal.relocalize');
  for (let i = 0; i < UI_MODULES.length; i++) {
    relocalizeModule(UI_MODULES[i].mod, UI_MODULES[i].label);
  }
  relocalizeModule(pwaUI, 'pwa');
  relocalizeModule(tutorialUI, 'tutorial');
  // Hebrew and English HUD rows are not the same height, so the chrome the
  // camera has to stay clear of changes with the language.
  applyViewInsets();
  // Anything the renderer baked into a cached layer (tier / venue captions)
  // has to be drawn again in the new language.
  if (renderer && typeof renderer.invalidate === 'function') {
    safe(() => renderer.invalidate(), 'renderer.invalidate');
  }
  refreshUI();
}

/** Keep the browser tab / task-switcher title in the active language. */
function applyDocumentTitle() {
  safe(() => {
    if (typeof document === 'undefined') return;
    const title = t('app.title');
    if (title && title !== 'app.title') document.title = title;
  }, 'document.title');
}

/**
 * Point <link rel="manifest"> at the active locale's manifest, so the install
 * prompt and the home-screen icon carry the player's language rather than the
 * Hebrew default baked into index.html.
 *
 * index.html ships './manifest.webmanifest' (Hebrew) as the pre-JS default; this
 * swaps it to './manifest.<locale>.webmanifest' at boot and again on every
 * language change. Every locale manifest declares the SAME "id": "./", so the
 * browser treats them as one installed app — swapping the href re-reads the
 * metadata instead of creating a second install entry.
 *
 * The href stays relative for the GitHub Pages subpath (see the header note).
 */
function applyManifestLink() {
  safe(() => {
    if (typeof document === 'undefined' || !document.querySelector) return;
    const link = document.querySelector('link[rel="manifest"]');
    if (!link || typeof link.setAttribute !== 'function') return;
    const next = './manifest.' + getLocale() + '.webmanifest';
    if (link.getAttribute('href') === next) return;
    link.setAttribute('href', next);
  }, 'manifest.link');

  // iOS Safari ignores the manifest's short_name for "Add to Home Screen" and
  // reads this meta instead, so the manifest swap alone would still leave an
  // English player with a Hebrew home-screen icon.
  safe(() => {
    if (typeof document === 'undefined' || !document.querySelector) return;
    const meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (!meta || typeof meta.setAttribute !== 'function') return;
    const name = t('app.shortName');
    if (!name || name === 'app.shortName') return;
    if (meta.getAttribute('content') === name) return;
    meta.setAttribute('content', name);
  }, 'appleTitle.meta');
}

/** update() on the PWA module, if it loaded and exposes one. */
function updatePwaUI() {
  if (!pwaUI || typeof pwaUI.update !== 'function') return;
  safe(() => pwaUI.update(), 'pwa.update');
}

/**
 * Load + mount ./ui/pwa.js. Deliberately non-fatal: the game keeps running (and
 * stays installable, since the manifest/SW live outside this module) if the
 * PWA UI is missing.
 */
function mountPwaUI() {
  const host = byId('modals') || byId('ui-layer') || (typeof document !== 'undefined' ? document.body : null);
  const p = pwaModulePromise;
  if (!p || typeof p.then !== 'function') return;
  p.then((mod) => {
    if (!mod) return;
    pwaUI = mod;
    if (typeof pwaUI.mount === 'function') safe(() => pwaUI.mount(host), 'pwa.mount');
    updatePwaUI();
  }).catch((err) => {
    pwaUI = null;
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[main] ui/pwa.js unavailable:', err && err.message ? err.message : err);
    }
  });
}

/* ---------------- guide / help (contract C7, module lands in phase B) ------ *
 *
 *  ./ui/tutorial.js is loaded the same defensive way as ./ui/pwa.js: a dynamic
 *  import, one shared promise, every failure swallowed. It is entirely optional
 *  — a build without the file boots and plays identically, it just has no
 *  guide. Contract this shell calls:
 *      initTutorial({ bus, t, state, save })   optional, once at boot
 *      maybeStartFirstRun()                    optional, once after boot
 *      openHelp(page)                          optional, from the '?' button
 *  Anything missing is skipped, not thrown.
 * -------------------------------------------------------------------------- */

/** @type {Promise<any>|null} shared, so the module is fetched at most once. */
let tutorialModulePromise = null;
/** The resolved ./ui/tutorial.js namespace, or null while unavailable. */
/** @type {{initTutorial?:Function, maybeStartFirstRun?:Function, openHelp?:Function}|null} */
let tutorialUI = null;

function loadTutorialModule() {
  if (tutorialModulePromise) return tutorialModulePromise;
  let p = null;
  try {
    p = import('./ui/tutorial.js');
  } catch (err) {
    p = null;
  }
  if (!p || typeof p.then !== 'function') {
    tutorialModulePromise = Promise.resolve(null);
    return tutorialModulePromise;
  }
  tutorialModulePromise = p
    .then((mod) => {
      tutorialUI = mod || null;
      return tutorialUI;
    })
    .catch((err) => {
      tutorialUI = null;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[main] ui/tutorial.js unavailable:', err && err.message ? err.message : err);
      }
      return null;
    });
  return tutorialModulePromise;
}

/**
 * Retire the '?' button. `hidden` alone is not enough: it is a UA-stylesheet
 * `display: none`, and BOTH `.action-btn { display: inline-block }` and the
 * phone block's `.action-btn { display: inline-flex }` are author rules, which
 * beat the UA origin outright regardless of specificity — the button would stay
 * on screen, still occupying one of the seven 44px slots in the dock's single
 * row. The inline style is the one declaration that reliably wins; `hidden`
 * stays for the accessibility-tree semantics.
 */
function retireHelpButton() {
  if (!helpActionBtn) return;
  helpActionBtn.hidden = true;
  if (helpActionBtn.style) helpActionBtn.style.display = 'none';
}

/** Boot hook: wire the guide's listeners and let it decide about a first run. */
function mountTutorial() {
  loadTutorialModule().then((mod) => {
    // No guide module in this build: take the dead control out of the dock now
    // rather than waiting for the player to discover it does nothing. Ordering
    // is safe — boot() calls mountActionBar() before mountTutorial(), so
    // helpActionBtn exists by the time this promise settles.
    if (!mod || typeof mod.openHelp !== 'function') retireHelpButton();
    if (!mod) return;
    if (typeof mod.initTutorial === 'function') {
      safe(() => mod.initTutorial({ bus, t, state, save }), 'tutorial.initTutorial');
    }
    if (typeof mod.maybeStartFirstRun === 'function') {
      safe(() => mod.maybeStartFirstRun(), 'tutorial.maybeStartFirstRun');
    }
  });
}

/** The '?' button. Degrades to a no-op — and hides itself — with no module. */
function openHelp(page) {
  loadTutorialModule().then((mod) => {
    if (mod && typeof mod.openHelp === 'function') {
      safe(() => mod.openHelp(Number.isFinite(page) ? page : 0), 'tutorial.openHelp');
      return;
    }
    // A control that does nothing is worse than no control: retire it rather
    // than leave the player tapping a dead button.
    retireHelpButton();
  });
}

/**
 * @param {HTMLElement} bar
 * @param {string} labelKey locale key for the visible label
 * @param {string} titleKey locale key for the tooltip
 * @param {Function} onClick
 */
/**
 * Split an action label like "🌍 Worlds" / "🌍 עולמות" into its leading glyph
 * and the words after it.
 *
 * The dock is one non-wrapping row. On a 411px phone, six labelled pills plus
 * the PWA install chip need ~445px, so every label was rendering as a clipped
 * stub ("🌍 …", "🃏 Bl…") — which reads as broken rather than compact, and gets
 * worse in Hebrew where the words are longer. Emitting the icon and the text as
 * separate spans lets the phone stylesheet hide `.action-btn-text` and keep a
 * clean icon-only dock, while the words stay in the DOM (and in `title` /
 * `aria-label`) for wide screens and for assistive tech.
 *
 * @returns {{icon:string, text:string}} icon is '' when the label has no glyph.
 */
function splitActionLabel(label) {
  const s = typeof label === 'string' ? label.trim() : '';
  const cut = s.indexOf(' ');
  if (cut <= 0) return { icon: '', text: s };
  const head = s.slice(0, cut);
  // A leading segment is an icon only if it carries no letters or digits at
  // all — that keeps a genuinely text-only label (or a translation that drops
  // the emoji) from losing its first word.
  if (/[\p{L}\p{N}]/u.test(head)) return { icon: '', text: s };
  return { icon: head, text: s.slice(cut + 1).trim() };
}

/**
 * Paint an action button's label as icon + text spans.
 *
 * Every branch must leave the button showing SOMETHING at icon-only sizes. The
 * phone stylesheet hides `.action-btn-text`, so writing a bare text node is
 * never safe: the ad button's cooldown label ("Ready in 42s" / "זמין בעוד 42 שנ׳")
 * carries no emoji, and as bare text it rendered inside the 44px pill and
 * clipped to a stub for the whole ~4 minute cooldown — the exact failure the
 * icon-only dock exists to remove.
 *
 *  - label with a glyph ("🎬 Watch ad")  -> that glyph + hidden words
 *  - label that IS a glyph ("?")          -> the glyph itself, never hidden
 *  - glyph-less words ("Ready in 42s")    -> keep the glyph the button already
 *                                            had, hide the words
 */
function setActionLabel(btn, label) {
  if (!btn) return;
  const { icon, text } = splitActionLabel(label);

  // A label that is itself a single symbol (the help "?") is the icon.
  if (!icon && text.length <= 2) {
    btn.textContent = text;
    return;
  }

  const prev = btn.querySelector ? btn.querySelector('.action-btn-glyph') : null;
  const glyph = icon || (prev && prev.textContent) || '';

  btn.textContent = '';
  if (glyph) {
    const i = el('span', 'action-btn-glyph', glyph);
    i.setAttribute('aria-hidden', 'true');
    btn.appendChild(i);
  }
  btn.appendChild(el('span', 'action-btn-text', text));
}

function actionButton(bar, labelKey, titleKey, onClick) {
  const btn = el('button', 'action-btn');
  setActionLabel(btn, t(labelKey));
  btn.type = 'button';
  btn.title = t(titleKey);
  // The words can be visually hidden on phones, so the accessible name must not
  // depend on them being rendered.
  btn.setAttribute('aria-label', t(titleKey));
  btn.addEventListener('click', onClick);
  bar.appendChild(btn);
  actionButtons.push({ btn, labelKey, titleKey });
  return btn;
}

function mountActionBar() {
  const layer = byId('ui-layer');
  if (!layer) return;

  const bar = el('div', 'action-bar');
  bar.id = 'actions';
  bar.setAttribute('dir', localeDir());

  actionButton(bar, 'action.worlds', 'action.worldsTitle', () =>
    safe(() => worldMap.openWorldMap(), 'openWorldMap')
  );
  actionButton(bar, 'action.roulette', 'action.rouletteTitle', () =>
    safe(() => minigames.openRoulette(), 'openRoulette')
  );
  actionButton(bar, 'action.blackjack', 'action.blackjackTitle', () =>
    safe(() => minigames.openBlackjack(), 'openBlackjack')
  );
  actionButton(bar, 'action.shop', 'action.shopTitle', () =>
    safe(() => monetization.openShop(), 'openShop')
  );
  adActionBtn = actionButton(bar, 'ad.button', 'ad.buttonTitle', () =>
    safe(() => monetization.tryWatchAd(null), 'tryWatchAd')
  );

  // The guide's entry point (contract C7). The module that answers it is
  // phase B; until it exists openHelp() is a no-op, never a boot failure.
  helpActionBtn = actionButton(bar, 'action.help', 'action.helpTitle', () => openHelp());
  helpActionBtn.classList.add('action-btn--help');
  // The label is the language-neutral '?' glyph, so the accessible name has to
  // come from the title key or a screen reader announces "question mark".
  helpActionBtn.setAttribute('aria-label', t('action.helpTitle'));

  layer.appendChild(bar);
  updateAdButton();
}

/** Re-translate the action bar in place after a language switch. */
function relabelActionBar() {
  const bar = byId('actions');
  if (bar && bar.setAttribute) bar.setAttribute('dir', localeDir());
  for (let i = 0; i < actionButtons.length; i++) {
    const entry = actionButtons[i];
    if (!entry || !entry.btn) continue;
    entry.btn.title = t(entry.titleKey);
    entry.btn.setAttribute('aria-label', t(entry.titleKey));
    // The ad button's label depends on its cooldown, so updateAdButton() owns it.
    if (entry.btn !== adActionBtn) setActionLabel(entry.btn, t(entry.labelKey));
  }
  updateAdButton();
}

/** Reflect the rewarded-ad cooldown (CONFIG.monetization.adCooldownMs) on the action-bar button. */
function updateAdButton() {
  if (!adActionBtn) return;
  const onCooldown = safe(() => monetization.isAdOnCooldown(), 'isAdOnCooldown') === true;
  if (onCooldown) {
    const seconds = safe(() => monetization.getAdCooldownSeconds(), 'getAdCooldownSeconds') || 0;
    adActionBtn.disabled = true;
    adActionBtn.classList.add('is-disabled');
    setActionLabel(adActionBtn, t('ad.buttonCooldown', { seconds }));
  } else {
    adActionBtn.disabled = false;
    adActionBtn.classList.remove('is-disabled');
    setActionLabel(adActionBtn, t('ad.button'));
  }
}

/* ------------------------------------------------------------------ *
 *  Android hardware Back -> close the top modal
 *
 *  In an installed PWA ("display": "standalone") the document has exactly one
 *  history entry, so the system Back gesture leaves the GAME — mid-blackjack,
 *  mid-shop — instead of dismissing the modal that is on screen. That is the
 *  single most jarring thing the app does on a phone.
 *
 *  The mechanism is deliberately DOM-driven rather than an API every modal
 *  owner has to call: main.js watches the modal hosts, and for every open
 *  `.modal-backdrop` there is exactly one history entry we pushed. That keeps
 *  it correct for modals main.js does not own (worldMap / minigames /
 *  monetization) and for the ones that stack, without those modules changing a
 *  line — and it survives the player closing via the × (the entry we pushed is
 *  unwound with history.go, guarded so our own unwind is not read as a Back).
 * ------------------------------------------------------------------ */

/** History entries pushed for currently-open modals. */
let modalHistoryDepth = 0;
/**
 * How many modals are on screen right now (gap G3).
 *
 * SINGLE SOURCE OF TRUTH, deliberately: the render pause reads the very same
 * number the Android Back guard reconciles against, refreshed in the very same
 * pass, so the two can never disagree about whether a modal is up. A second
 * open/close counter maintained by the modal owners would have to be correct in
 * five modules that main.js does not own — and the coach-mark layer, which is
 * NOT a modal (`.coach-layer` / `.coach-backdrop`, per contract C1) and must
 * keep the floor animating underneath it, would be miscounted by exactly that.
 */
let modalOpenCount = 0;
/** Traversals WE requested, so the resulting popstate is not read as a Back. */
let pendingHistoryBack = 0;
/** rAF handle coalescing several DOM mutations into one sync. */
let modalSyncQueued = false;

/** Every `.modal-backdrop` that is actually on screen, in DOM (stacking) order. */
function openModalBackdrops() {
  const out = [];
  if (typeof document === 'undefined' || !document.querySelectorAll) return out;
  const list = safe(() => document.querySelectorAll('.modal-backdrop'), 'querySelectorAll modal');
  if (!list) return out;
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    if (!node || typeof node.getClientRects !== 'function') continue;
    // A detached or display:none backdrop has no boxes: not an open modal.
    if (node.getClientRects().length === 0) continue;
    out.push(node);
  }
  return out;
}

/**
 * Close the topmost modal the way the player would.
 * Driving the module's own '×' (or, failing that, a backdrop click) keeps its
 * teardown running — bus.off, cleared intervals, reset flags — instead of
 * ripping the node out from under a module that still thinks it is open.
 * @returns {boolean} true when something was asked to close.
 */
function closeTopModal() {
  const open = openModalBackdrops();
  if (open.length === 0) return false;
  const top = open[open.length - 1];

  const closeBtn = top.querySelector ? top.querySelector('.modal-close') : null;
  if (closeBtn && typeof closeBtn.click === 'function' && !closeBtn.disabled) {
    safe(() => closeBtn.click(), 'modal.close');
    return true;
  }
  // Backdrop handlers all test `e.target === backdrop`, so the event has to be
  // dispatched on the backdrop itself, not bubbled from a child.
  if (typeof MouseEvent === 'function' && typeof top.dispatchEvent === 'function') {
    safe(() => top.dispatchEvent(new MouseEvent('click', { bubbles: true })), 'modal.backdropClick');
    return true;
  }
  return false;
}

/**
 * Reconcile the pushed history entries with the modals actually on screen.
 * Runs on every mutation of a modal host and again on the UI tick, so it also
 * repairs any drift (a modal that refused to close, one opened from a code path
 * that never mutates a watched host).
 */
function syncModalHistory() {
  // Recount FIRST and unconditionally. The render pause depends on this number,
  // and it must stay correct even where there is no History API to reconcile
  // against (the early return below) — otherwise the canvas would freeze under
  // a modal that opened before the last successful sync and never resume.
  const count = openModalBackdrops().length;
  modalOpenCount = count;
  if (typeof history === 'undefined' || typeof history.pushState !== 'function') return;

  while (modalHistoryDepth < count) {
    modalHistoryDepth++;
    // Same URL — only a state entry. ensureTrailingSlash()'s replaceState and
    // the service worker scope are untouched.
    safe(() => history.pushState({ casinoModal: modalHistoryDepth }, ''), 'history.pushState');
  }

  if (modalHistoryDepth > count) {
    // Closed by the × / backdrop / its own OK button: give the entries back.
    // ONE history.go(-n) produces ONE popstate, so one suppression is enough.
    const steps = modalHistoryDepth - count;
    modalHistoryDepth = count;
    pendingHistoryBack++;
    safe(() => history.go(-steps), 'history.go');
  }
}

/** Coalesce a burst of DOM mutations (a modal is many appendChilds) into one sync. */
function scheduleModalSync() {
  if (modalSyncQueued) return;
  modalSyncQueued = true;
  const run = () => {
    modalSyncQueued = false;
    syncModalHistory();
  };
  if (typeof window !== 'undefined' && window.requestAnimationFrame) window.requestAnimationFrame(run);
  else run();
}

function onPopState() {
  if (pendingHistoryBack > 0) {
    pendingHistoryBack--; // our own unwind, not a Back press
    return;
  }
  if (modalHistoryDepth <= 0) return; // nothing of ours on the stack: let the app close
  modalHistoryDepth--;
  const closed = closeTopModal();
  if (!closed) modalHistoryDepth = 0;
  // A modal that refuses to close (the ad, mid-playback) re-pushes its entry.
  scheduleModalSync();
}

/** Watch the modal hosts so a modal is guarded the frame it appears. */
function watchModalHosts() {
  if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
  const hosts = [byId('modals'), byId('ui-layer'), document.body];
  const observer = new MutationObserver(scheduleModalSync);
  const seen = [];
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i];
    if (!host || seen.indexOf(host) !== -1) continue;
    seen.push(host);
    // childList only, no subtree: every modal in this app is appended as a
    // direct child of one of these hosts, and a subtree watch would fire on
    // every HUD text update four times a second for nothing.
    safe(() => observer.observe(host, { childList: true }), 'observe modal host');
  }
}

/* ------------------------------------------------------------------ *
 *  Offline earnings report
 * ------------------------------------------------------------------ */

/**
 * Localised display name of a branch, resilient to however config.js ends up
 * exposing it: an explicit nameKey wins, then the conventional
 * 'world.<key>.name', then whatever literal name the def still carries, and
 * finally the generic "Branch N".
 * @param {any} def worldDefById(id) result, possibly null
 * @param {number} worldId
 */
function worldName(def, worldId) {
  if (def) {
    if (typeof def.nameKey === 'string' && hasKey(def.nameKey)) return t(def.nameKey);
    if (typeof def.key === 'string' && hasKey('world.' + def.key + '.name')) {
      return t('world.' + def.key + '.name');
    }
    if (typeof def.name === 'string' && def.name.length > 0) return def.name;
  }
  return t('offline.branch', { id: worldId });
}

function showOfflineModal(report) {
  const host = modalsHost();
  if (!host || !report || !(report.total > 0)) {
    if (report && report.total > 0) {
      toast(t('offline.toast', { amount: fmtMoney(report.total) }), 'good');
    }
    return;
  }

  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');
  modal.setAttribute('dir', localeDir());

  const titleEl = el('div', 'modal-title', t('offline.title'));
  modal.appendChild(titleEl);

  const close = el('button', 'modal-close', '×');
  close.type = 'button';
  close.title = t('common.close');
  close.setAttribute('aria-label', t('common.close'));
  modal.appendChild(close);

  const content = el('div', 'modal-content');
  const awayEl = el('div', 'offline-away', t('offline.away', { time: fmtTime(report.seconds) }));
  content.appendChild(awayEl);

  const totalEl = el('div', 'offline-total', fmtMoney(report.total));
  content.appendChild(totalEl);

  const list = el('div', 'offline-list');
  const rows = [];
  const entries = Array.isArray(report.earnedPerWorld) ? report.earnedPerWorld : [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const def = worldDefById(entry.worldId);
    const row = el('div', 'offline-row');
    const nameEl = el('span', 'offline-row-name', worldName(def, entry.worldId));
    row.appendChild(nameEl);
    const amt = el('span', 'offline-row-amount', fmtMoney(entry.amount));
    row.appendChild(amt);
    list.appendChild(row);
    rows.push({ entry, amt, nameEl, def });
  }
  content.appendChild(list);

  const actions = el('div', 'offline-actions');

  const adBtn = el('button', 'success', t('offline.double', { mult: CONFIG.offline.adMultiplier }));
  adBtn.type = 'button';

  const okBtn = el('button', 'secondary', t('offline.collect'));
  okBtn.type = 'button';

  const redraw = () => {
    totalEl.textContent = fmtMoney(report.total);
    for (let i = 0; i < rows.length; i++) {
      rows[i].amt.textContent = fmtMoney(rows[i].entry.amount);
    }
  };

  /** Re-apply every string in this modal for the active locale. */
  const relocalize = () => {
    modal.setAttribute('dir', localeDir());
    titleEl.textContent = t('offline.title');
    awayEl.textContent = t('offline.away', { time: fmtTime(report.seconds) });
    close.title = t('common.close');
    close.setAttribute('aria-label', t('common.close'));
    adBtn.textContent = t('offline.double', { mult: CONFIG.offline.adMultiplier });
    okBtn.textContent = t('offline.collect');
    for (let i = 0; i < rows.length; i++) {
      rows[i].nameEl.textContent = worldName(rows[i].def, rows[i].entry.worldId);
    }
    redraw();
  };

  const dismiss = () => {
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    bus.off('money:changed', redraw);
    if (offlineModalRelocalize === relocalize) offlineModalRelocalize = null;
    offlineModalOpen = false;
  };

  adBtn.addEventListener('click', () => {
    let started = false;
    // monetization.tryWatchAd applies CONFIG.offline.adMultiplier to the report
    // itself once the simulated ad finishes.
    started = safe(() => monetization.tryWatchAd(report), 'tryWatchAd') === true;
    if (!started) {
      // No ad available (no-ads purchased / on cooldown): grant it directly.
      const extra = multiplyOfflineReward(report, CONFIG.offline.adMultiplier);
      if (extra > 0) toast('+' + fmtMoney(extra), 'good');
    }
    adBtn.disabled = true;
    window.setTimeout(redraw, 0);
  });

  okBtn.addEventListener('click', dismiss);
  close.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) dismiss();
  });

  actions.appendChild(adBtn);
  actions.appendChild(okBtn);
  content.appendChild(actions);

  modal.appendChild(content);
  backdrop.appendChild(modal);
  host.appendChild(backdrop);
  offlineModalOpen = true;
  offlineModalRelocalize = relocalize;

  bus.on('money:changed', redraw);
}

/* ------------------------------------------------------------------ *
 *  Main loop
 * ------------------------------------------------------------------ */

function frame(now) {
  if (!running) return;
  rafId = window.requestAnimationFrame(frame);

  const t = Number.isFinite(now) ? now : 0;
  let rawDt = lastFrame ? (t - lastFrame) / 1000 : 0;
  lastFrame = t;
  if (!Number.isFinite(rawDt) || rawDt < 0) rawDt = 0;

  /*
   * TWO clocks, on purpose.
   *
   *   dt (clamped)  drives the SIMULATION. The clamp is what stops a 2-second
   *                 hitch from teleporting every guest across the floor and
   *                 firing a burst of live events in one step.
   *   rawDt         drives everything measured in WALL-CLOCK seconds: the 1s
   *                 income tick, the UI tick, the autosave timer. Feeding those
   *                 the clamped value meant a phone rendering at 12fps
   *                 (rawDt 0.083) credited only 0.05s per frame — the player
   *                 earned ~60% of the $/s the HUD was advertising, and
   *                 autosaved every 17s instead of 10s, silently.
   *
   * This does NOT reintroduce the backgrounded-tab jackpot the clamp used to
   * cover for: time spent hidden never reaches this function. visibilitychange
   * -> onHidden() stops the loop, and startLoop() resets lastFrame to 0, so the
   * first frame after a resume measures rawDt = 0. The away time is credited
   * exactly once, through grantOffline() (which has its own cap and offline
   * rate). RAW_DT_CAP is only a sanity bound for a stall the loop did survive —
   * a long GC, a blocked main thread, an rAF throttled by an occluded window —
   * where the seconds really did elapse with the game on screen.
   */
  const maxDt = Number(CONFIG.loop.maxDt) > 0 ? Number(CONFIG.loop.maxDt) : 0.05;
  if (rawDt > RAW_DT_CAP) rawDt = RAW_DT_CAP;
  const dt = rawDt > maxDt ? maxDt : rawDt;

  // --- simulation -------------------------------------------------
  if (dt > 0) {
    bridgeStaffToGuests();
    if (staffSim) safe(() => staffSim.update(dt), 'staffSim.update');
    if (guestSim) safe(() => guestSim.update(dt), 'guestSim.update');
    if (liveSim) safe(() => liveSim.update(dt), 'liveSim.update');
    dispatchGuards();
    drainPopups();
  }

  // --- 1s income tick ---------------------------------------------
  const tickSeconds = Math.max(0.05, (Number(CONFIG.loop.incomeTickMs) || 1000) / 1000);
  incomeAcc += rawDt;
  // High enough to drain a full RAW_DT_CAP stall in the frame that follows it.
  let guard = 20;
  while (incomeAcc >= tickSeconds && guard-- > 0) {
    incomeAcc -= tickSeconds;
    safe(() => payIncome(tickSeconds), 'payIncome');
  }
  if (incomeAcc > tickSeconds) incomeAcc = 0;

  /* --- render ------------------------------------------------------
   *
   * Gap G3: a modal covers the canvas, and `.modal-backdrop` puts a
   * backdrop-filter blur over it — so every frame drawn underneath makes the
   * compositor re-run a full-screen gaussian blur for pixels nobody can see,
   * at 60Hz, while the wake lock (below) holds the screen on. That is pure
   * battery burn and it is exactly when the modal's own animations need the
   * main thread.
   *
   * Only the DRAW is skipped. The simulation, the income tick, the UI tick and
   * autosave above all keep running, so nothing is lost or double-credited:
   * `running` stays true, the rAF loop keeps turning, and the frame after the
   * modal closes paints the world in its current state. fitPending and
   * lastZoomSent are latches, so a fitView or a zoom change that happened
   * behind the modal is applied on that first frame back rather than dropped.
   */
  if (renderer && (modalOpenCount === 0 || renderWarmup > 0)) {
    if (renderWarmup > 0) renderWarmup--;
    const w = activeWorld();
    safe(
      () =>
        renderer.draw({
          worldState: w,
          worldDef: worldDefById(w.id),
          layout,
          guests: guestSim ? guestSim.guests : [],
          workers: staffSim ? staffSim.workers : [],
          actors: liveSim ? liveSim.actors : [],
          tier: w.tier
        }),
      'renderer.draw'
    );
    // fitView needs the layout the renderer just saw, so it lands here.
    applyPendingFit();
    // ...and the HUD's zoom % is refreshed from whatever zoom survived.
    syncCameraZoom();
  }

  // --- UI ----------------------------------------------------------
  uiAcc += rawDt;
  if (uiAcc >= TUNING.uiTick) {
    uiAcc = 0;
    if (guestSim && typeof hud.setLiveGuestCount === 'function') {
      hud.setLiveGuestCount(guestSim.guests.length);
    }
    safe(() => hud.update(), 'hud.update');
    safe(() => panels.update(), 'panels.update');
    updateAdButton();
    // Both of these are measurements, not state: they re-read the DOM and
    // no-op when nothing moved, which is what makes the camera insets and the
    // Back-button guard self-healing whatever any other module does.
    applyViewInsets();
    syncModalHistory();
  }

  // --- autosave ----------------------------------------------------
  saveAcc += rawDt;
  const autosave = Math.max(1, (Number(CONFIG.loop.autosaveMs) || 10000) / 1000);
  if (saveAcc >= autosave) {
    saveAcc = 0;
    safe(() => save(), 'save');
  }
}

/* ------------------------------------------------------------------ *
 *  Lifecycle: rAF control, visibility, wake lock, viewport
 *
 *  Android backgrounds tabs aggressively and often kills them without ever
 *  firing beforeunload, so everything below is defensive:
 *    - hidden  -> write the save NOW, stop the loop, drop the wake lock
 *    - visible -> credit the away time through the OFFLINE system (never as a
 *                 giant catch-up dt), restart the loop, re-take the wake lock
 * ------------------------------------------------------------------ */

/** Persist immediately (bypasses the throttle) and refresh state.lastSeen. */
function hardSave() {
  safe(() => save(true), 'save(immediate)');
}

/** Start the rAF loop. Safe to call when it is already running. */
function startLoop() {
  if (running) return;
  running = true;
  // Reset every accumulator: the time spent hidden is credited by the offline
  // system, not replayed through the simulation.
  lastFrame = 0;
  incomeAcc = 0;
  uiAcc = 0;
  saveAcc = 0;
  if (typeof window === 'undefined' || !window.requestAnimationFrame) {
    running = false;
    return;
  }
  rafId = window.requestAnimationFrame(frame);
}

/** Stop the rAF loop and cancel the pending frame. */
function stopLoop() {
  running = false;
  if (rafId && typeof window !== 'undefined' && window.cancelAnimationFrame) {
    try {
      window.cancelAnimationFrame(rafId);
    } catch (err) {
      /* cancelling is best-effort */
    }
  }
  rafId = 0;
}

/**
 * Credit whatever accumulated while the tab was backgrounded.
 * grantOffline() measures from state.lastSeen — which hardSave() pinned at the
 * moment we went hidden — caps at CONFIG.offline.capHours and ignores anything
 * shorter than CONFIG.offline.minSeconds, so a quick app switch is a no-op.
 */
function creditAwayTime() {
  const report = safe(() => grantOffline(), 'grantOffline');
  if (!report || !(report.total > 0)) return;

  offlineReport = report;
  const away = Number(report.seconds) || 0;
  if (away >= TUNING.resumeModalSeconds && !offlineModalOpen) {
    showOfflineModal(report);
  } else {
    safe(() => toast(t('offline.toast', { amount: fmtMoney(report.total) }), 'good'), 'toast');
  }
  refreshUI();
}

/* ---------------- screen wake lock ---------------- */

function wakeLockSupported() {
  return (
    typeof navigator !== 'undefined' &&
    navigator.wakeLock &&
    typeof navigator.wakeLock.request === 'function'
  );
}

/**
 * Keep the Pixel's screen awake while the game is on screen. The API rejects on
 * plenty of devices/contexts (insecure origin, battery saver, hidden document);
 * every failure is swallowed and after a few of them we stop asking.
 */
function acquireWakeLock() {
  if (!wakeLockSupported()) return;
  if (wakeLock || wakeLockPending) return;
  if (wakeLockFailures >= TUNING.wakeLockMaxFailures) return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

  let req = null;
  try {
    req = navigator.wakeLock.request('screen');
  } catch (err) {
    wakeLockFailures++;
    return;
  }
  if (!req || typeof req.then !== 'function') return;

  wakeLockPending = true;
  req
    .then((sentinel) => {
      wakeLockPending = false;
      if (!sentinel) return;
      // Went hidden while the request was in flight: hand it straight back.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        try {
          const p = sentinel.release();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (err) {
          /* ignore */
        }
        return;
      }
      wakeLock = sentinel;
      if (typeof sentinel.addEventListener === 'function') {
        sentinel.addEventListener('release', () => {
          if (wakeLock === sentinel) wakeLock = null;
        });
      }
    })
    .catch(() => {
      wakeLockPending = false;
      wakeLockFailures++;
    });
}

/** Drop the wake lock (the browser releases it on hide anyway; be explicit). */
function releaseWakeLock() {
  const sentinel = wakeLock;
  wakeLock = null;
  if (!sentinel || typeof sentinel.release !== 'function') return;
  try {
    const p = sentinel.release();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (err) {
    /* releasing is best-effort */
  }
}

/* ---------------- visibility ---------------- */

function onHidden() {
  hardSave();
  stopLoop();
  releaseWakeLock();
  // Whatever was mid-gesture is not coming back: Chrome does not always fire
  // pointercancel when it backgrounds the page, and a leaked contact would
  // leave the canvas permanently stuck in a phantom pinch.
  resetPointers();
}

function onVisible() {
  creditAwayTime();
  startLoop();
  acquireWakeLock();
  // The viewport can change size while backgrounded (rotation, split screen).
  scheduleViewportChange();
}

function onVisibilityChange() {
  if (typeof document === 'undefined') return;
  if (document.visibilityState === 'hidden') onHidden();
  else onVisible();
}

/* ---------------- viewport / orientation ---------------- */

function isPortrait() {
  if (typeof window === 'undefined') return true;
  const w = Number(window.innerWidth) || 0;
  const h = Number(window.innerHeight) || 0;
  return h >= w;
}

/** Debounced: Android emits a burst of resizes while the URL bar animates. */
function scheduleViewportChange() {
  if (typeof window === 'undefined') return;
  if (viewportTimer !== null) window.clearTimeout(viewportTimer);
  viewportTimer = window.setTimeout(applyViewportChange, TUNING.viewportDebounceMs);
}

function applyViewportChange() {
  viewportTimer = null;
  if (renderer && typeof renderer.resize === 'function') {
    safe(() => renderer.resize(), 'renderer.resize');
  }
  // The collapsed strip is viewport-dependent (styles.css retunes
  // --drawer-collapsed-h under max-height:480px, and it is not even a bottom
  // sheet on a wide layout), so a measurement taken before this change is no
  // longer ground truth. Dropping it makes collapsedDrawerIntrusion() fall
  // through to the live CSS token, which IS current for the new viewport; the
  // very next tick with the sheet collapsed re-measures it for real.
  collapsedDrawerPx = 0;
  // The chrome moved with the viewport (URL bar, rotation, split screen), so
  // re-measure it before anything re-frames against it.
  applyViewInsets();
  const portrait = isPortrait();
  const flipped = lastPortrait !== null && portrait !== lastPortrait;
  lastPortrait = portrait;
  // A real orientation flip invalidates any hand-made framing; a URL-bar
  // resize does not, so that one only re-fits if the player never touched the
  // camera (requestFitView already honours cameraTouched).
  requestFitView(flipped);
}

/* ------------------------------------------------------------------ *
 *  Boot
 * ------------------------------------------------------------------ */

function boot() {
  // FIRST: the language must be settled (and <html lang/dir> stamped) before a
  // single UI module is mounted, so the very first render is already correct.
  // Idempotent — the module-level prelude above normally got here first.
  safe(() => initLocale(), 'initLocale');
  safe(() => ensureTrailingSlash(), 'ensureTrailingSlash');
  applyDocumentTitle();
  applyManifestLink();

  canvas = byId('game');
  if (canvas) {
    renderer = new Renderer(canvas);
  } else if (typeof console !== 'undefined' && console.warn) {
    console.warn('[main] #game canvas not found — running headless.');
  }

  // Tiers can drift after a migration; recompute once before anything reads them.
  const worlds = Array.isArray(state.worlds) ? state.worlds : [];
  for (let i = 0; i < worlds.length; i++) safe(() => recomputeTier(worlds[i]), 'recomputeTier');

  // Offline progress must be granted before the sims start ticking.
  offlineReport = safe(() => grantOffline(), 'grantOffline') || {
    seconds: 0,
    earnedPerWorld: [],
    total: 0
  };

  buildSims();

  // --- mount UI ---
  safe(() => hud.mount(byId('hud')), 'hud.mount');
  safe(() => panels.mount(byId('panels')), 'panels.mount');
  safe(() => worldMap.mount(byId('modals')), 'worldMap.mount');
  safe(() => minigames.mount(byId('modals')), 'minigames.mount');
  safe(() => monetization.mount(byId('modals') || byId('ui-layer')), 'monetization.mount');
  mountActionBar();
  safe(() => mountPwaUI(), 'pwa.mount');
  safe(() => mountTutorial(), 'tutorial.mount');
  refreshUI();

  // --- events ---
  bus.on('purchase', () => {
    refreshLayout();
  });
  bus.on('world:switched', () => {
    switchWorld();
    requestFitView(true); // a new branch always re-frames, even if the player had panned
  });
  bus.on('world:unlocked', () => {
    refreshUI();
  });
  bus.on('tier:up', () => {
    if (renderer) renderer.invalidate();
    refreshUI();
  });
  bus.on('ui:refresh', () => {
    refreshUI();
  });
  // Contract C3: the drawer opened/collapsed, so the chrome over the canvas
  // moved. The payload's collapsedHeight is a DRAWER-LOCAL height (panels.js
  // reads the --drawer-collapsed-h token), not an intrusion from the canvas
  // edge, so it is stored as the fallback hint and never as the measurement —
  // mixing the two units under-inset the camera by the safe-area gap.
  bus.on('drawer:changed', (payload) => {
    const h = payload ? Number(payload.collapsedHeight) : NaN;
    if (Number.isFinite(h) && h > 0) collapsedDrawerHintPx = h;
    applyViewInsets();
  });

  // Language switch: re-label everything on screen. Never a reload.
  onLocaleChanged(() => {
    applyLocaleToUI();
  });

  bus.on('camera:zoom', (payload) => {
    const dir = payload && typeof payload.dir === 'string' ? payload.dir : 'in';
    cameraCommand(dir);
  });

  // --- input ---
  if (canvas && canvas.addEventListener) {
    // The canvas owns the gesture: no browser scrolling / pinch-to-page-zoom.
    if (canvas.style) canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', onCanvasPointerDown);
    canvas.addEventListener('pointermove', onCanvasPointerMove);
    canvas.addEventListener('pointerup', onCanvasPointerUp);
    canvas.addEventListener('pointercancel', onCanvasPointerCancel);
    canvas.addEventListener('lostpointercapture', onCanvasPointerCancel);
    canvas.addEventListener('wheel', onCanvasWheel, { passive: false });
    // onCanvasDblClick preventDefaults: no double-tap-to-zoom on the floor.
    canvas.addEventListener('dblclick', onCanvasDblClick);
    // Long-press on Android pops a context menu in the middle of a drag.
    canvas.addEventListener('contextmenu', (e) => {
      if (e && e.preventDefault) e.preventDefault();
    });
    // Chrome on Android still scrolls/overscrolls (and fires pointercancel,
    // which would abort a pan) unless touchmove is actively cancelled. THIS IS
    // BOUND TO THE CANVAS ONLY — the panels/drawer/modals must keep scrolling.
    canvas.addEventListener(
      'touchmove',
      (e) => {
        if (e && e.cancelable && e.preventDefault) e.preventDefault();
      },
      { passive: false }
    );
    // Safari fires these instead of honouring touch-action for pinch.
    canvas.addEventListener('gesturestart', (e) => e.preventDefault());
    canvas.addEventListener('gesturechange', (e) => e.preventDefault());
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('keydown', onKeyDown);
    // A gesture that is still "down" when the app loses focus (app switch,
    // notification shade, permission dialog) never gets its pointerup: the
    // contact would leak and wedge every later pinch.
    window.addEventListener('blur', resetPointers);
  }

  // Android Back closes the top modal instead of leaving the game.
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('popstate', onPopState);
  }
  watchModalHosts();
  syncModalHistory();

  if (typeof window !== 'undefined' && window.addEventListener) {
    lastPortrait = isPortrait();
    window.addEventListener('resize', scheduleViewportChange);
    window.addEventListener('orientationchange', scheduleViewportChange);
    // The visual viewport is what actually moves when Chrome's URL bar slides.
    if (window.visualViewport && window.visualViewport.addEventListener) {
      window.visualViewport.addEventListener('resize', scheduleViewportChange);
    }

    // beforeunload is unreliable on Android (tabs get killed outright), so
    // pagehide — which does fire on bfcache/eviction — is the real save hook.
    window.addEventListener('pagehide', () => {
      hardSave();
      stopLoop();
      releaseWakeLock();
    });
    window.addEventListener('beforeunload', () => {
      safe(() => flushSave(), 'flushSave');
    });
    // Restored from the back/forward cache: pagehide stopped the loop, so it
    // has to be brought back exactly like a visibility resume.
    window.addEventListener('pageshow', (ev) => {
      if (!ev || !ev.persisted) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      onVisible();
    });
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  // --- offline report ---
  if (offlineReport && offlineReport.total > 0) {
    showOfflineModal(offlineReport);
  }

  // --- go ---
  requestFitView(true); // frame the whole floor on the first drawn frame
  startLoop();
  acquireWakeLock();
}

if (typeof document !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export { boot };
