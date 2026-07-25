/**
 * main.js — boot + integration layer.
 *
 * Responsibilities (nothing else lives here):
 *   1. Boot the persisted state, credit offline earnings and show the report.
 *   2. Build the floor plan and construct the three sims for the active branch.
 *   3. Mount every UI module into its DOM host and provide the buttons that
 *      open the modals the UI modules expose (world map, mini-games, shop, ad).
 *   4. Run the rAF loop: dt clamped to CONFIG.loop.maxDt, sims tick, renderer
 *      draws, a 1s income tick pays every unlocked branch, autosave every 10s.
 *   5. Route canvas pointer input: screen -> world -> live events -> guests,
 *      and drive the renderer camera (wheel zoom, drag pan, pinch, keyboard).
 *   6. Invalidate the layout on 'purchase' and fully rebuild the sims on
 *      'world:switched' / 'world:unlocked'.
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
const AD_BTN_LABEL = '🎬 פרסומת';

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

/** Live pointers on the canvas: pointerId -> {x, y} in canvas CSS px. */
const pointers = new Map();

/**
 * The current single-pointer gesture, or null.
 * @type {{id:number, startX:number, startY:number, lastX:number, lastY:number,
 *         maxDist:number, canClick:boolean}|null}
 */
let gesture = null;

/**
 * The current two-pointer pinch, or null.
 * @type {{startDist:number, startZoom:number, midX:number, midY:number}|null}
 */
let pinch = null;

/** Set when the camera should be re-framed after the next draw (layout known then). */
let fitPending = false;

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

function pinchState() {
  const list = [];
  pointers.forEach((v) => list.push(v));
  if (list.length < 2) return null;
  const a = list[0];
  const b = list[1];
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2
  };
}

function beginPinch() {
  const s = pinchState();
  if (!s || !(s.dist > 0)) return;
  const z = renderer && typeof renderer.getZoom === 'function' ? Number(renderer.getZoom()) : 1;
  pinch = {
    startDist: s.dist,
    startZoom: Number.isFinite(z) && z > 0 ? z : 1,
    midX: s.midX,
    midY: s.midY
  };
  if (gesture) gesture.canClick = false; // a second finger is never a tap
}

function onCanvasPointerDown(ev) {
  if (!canvas) return;
  // Chrome only grants a wake lock to a visible document and sometimes only
  // after an interaction; a touch is the cheapest place to retry (the call
  // early-returns once we hold one, or after a few refusals).
  if (!wakeLock) acquireWakeLock();
  const p = cssPos(ev);
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
    canClick: !Number.isFinite(ev.button) || ev.button === 0
  };
  if (canvas.style) canvas.style.cursor = 'grabbing';
}

function onCanvasPointerMove(ev) {
  if (!pointers.has(ev.pointerId)) return;
  const p = cssPos(ev);
  pointers.set(ev.pointerId, p);

  // --- two fingers: pinch zoom about the midpoint, and pan with the midpoint.
  if (pointers.size >= 2) {
    if (!pinch) beginPinch();
    const s = pinchState();
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
  if (gesture.maxDist > (gesture.slop || CAM.clickMaxDist)) gesture.canClick = false;

  cameraPanBy(dx, dy);
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

  if (pointers.size < 2) pinch = null;

  if (!gesture || gesture.id !== ev.pointerId) {
    if (pointers.size === 0 && canvas && canvas.style) canvas.style.cursor = '';
    return;
  }

  const g = gesture;
  gesture = null;
  if (pointers.size === 0 && canvas && canvas.style) canvas.style.cursor = '';
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
        addMoney(activeWorld(), tipped);
        renderer.popup(guest.x, guest.y - 8, '+' + fmtMoney(tipped), '#ffd76a');
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 *  UI wiring
 * ------------------------------------------------------------------ */

function refreshUI() {
  safe(() => hud.update(), 'hud.update');
  safe(() => panels.update(), 'panels.update');
  safe(() => worldMap.update(), 'worldMap.update');
  safe(() => minigames.update(), 'minigames.update');
  safe(() => monetization.update(), 'monetization.update');
  updatePwaUI();
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

function actionButton(bar, label, title, onClick) {
  const btn = el('button', 'action-btn', label);
  btn.type = 'button';
  btn.title = title;
  btn.addEventListener('click', onClick);
  bar.appendChild(btn);
  return btn;
}

function mountActionBar() {
  const layer = byId('ui-layer');
  if (!layer) return;

  const bar = el('div', 'action-bar');
  bar.id = 'actions';
  bar.setAttribute('dir', 'rtl');

  actionButton(bar, '🌍 עולמות', 'מפת העולמות', () => safe(() => worldMap.openWorldMap(), 'openWorldMap'));
  actionButton(bar, '🎡 רולטה', 'מיני-משחק רולטה', () => safe(() => minigames.openRoulette(), 'openRoulette'));
  actionButton(bar, '🃏 בלאקג׳ק', 'מיני-משחק בלאקג׳ק', () => safe(() => minigames.openBlackjack(), 'openBlackjack'));
  actionButton(bar, '💎 חנות', 'חנות יהלומים', () => safe(() => monetization.openShop(), 'openShop'));
  adActionBtn = actionButton(bar, AD_BTN_LABEL, 'צפה בפרסומת לבונוס', () =>
    safe(() => monetization.tryWatchAd(null), 'tryWatchAd')
  );

  layer.appendChild(bar);
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
    adActionBtn.textContent = 'זמין בעוד ' + seconds + 's';
  } else {
    adActionBtn.disabled = false;
    adActionBtn.classList.remove('is-disabled');
    adActionBtn.textContent = AD_BTN_LABEL;
  }
}

/* ------------------------------------------------------------------ *
 *  Offline earnings report
 * ------------------------------------------------------------------ */

function showOfflineModal(report) {
  const host = modalsHost();
  if (!host || !report || !(report.total > 0)) {
    if (report && report.total > 0) {
      toast('הרווחת ' + fmtMoney(report.total) + ' בזמן שלא היית', 'good');
    }
    return;
  }

  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');
  modal.setAttribute('dir', 'rtl');

  modal.appendChild(el('div', 'modal-title', 'רווחי אופליין'));

  const close = el('button', 'modal-close', '×');
  close.type = 'button';
  modal.appendChild(close);

  const content = el('div', 'modal-content');
  content.appendChild(
    el('div', 'offline-away', 'היית מחוץ למשחק ' + fmtTime(report.seconds))
  );

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
    row.appendChild(el('span', 'offline-row-name', def ? def.name : 'סניף ' + entry.worldId));
    const amt = el('span', 'offline-row-amount', fmtMoney(entry.amount));
    row.appendChild(amt);
    list.appendChild(row);
    rows.push({ entry, amt });
  }
  content.appendChild(list);

  const actions = el('div', 'offline-actions');

  const adBtn = el('button', 'success', '🎬 הכפל ×' + CONFIG.offline.adMultiplier);
  adBtn.type = 'button';

  const okBtn = el('button', 'secondary', 'אסוף');
  okBtn.type = 'button';

  const redraw = () => {
    totalEl.textContent = fmtMoney(report.total);
    for (let i = 0; i < rows.length; i++) {
      rows[i].amt.textContent = fmtMoney(rows[i].entry.amount);
    }
  };

  const dismiss = () => {
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    bus.off('money:changed', redraw);
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

  bus.on('money:changed', redraw);
}

/* ------------------------------------------------------------------ *
 *  Main loop
 * ------------------------------------------------------------------ */

function frame(now) {
  if (!running) return;
  rafId = window.requestAnimationFrame(frame);

  const t = Number.isFinite(now) ? now : 0;
  let dt = lastFrame ? (t - lastFrame) / 1000 : 0;
  lastFrame = t;
  if (!Number.isFinite(dt) || dt < 0) dt = 0;
  const maxDt = Number(CONFIG.loop.maxDt) > 0 ? Number(CONFIG.loop.maxDt) : 0.05;
  if (dt > maxDt) dt = maxDt;

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
  incomeAcc += dt;
  let guard = 5;
  while (incomeAcc >= tickSeconds && guard-- > 0) {
    incomeAcc -= tickSeconds;
    safe(() => payIncome(tickSeconds), 'payIncome');
  }
  if (incomeAcc > tickSeconds) incomeAcc = 0;

  // --- render ------------------------------------------------------
  if (renderer) {
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
  uiAcc += dt;
  if (uiAcc >= TUNING.uiTick) {
    uiAcc = 0;
    if (guestSim && typeof hud.setLiveGuestCount === 'function') {
      hud.setLiveGuestCount(guestSim.guests.length);
    }
    safe(() => hud.update(), 'hud.update');
    safe(() => panels.update(), 'panels.update');
    updateAdButton();
  }

  // --- autosave ----------------------------------------------------
  saveAcc += dt;
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
    safe(() => toast('הרווחת ' + fmtMoney(report.total) + ' בזמן שלא היית', 'good'), 'toast');
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
  }

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
