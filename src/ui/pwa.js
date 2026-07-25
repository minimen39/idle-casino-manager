/**
 * pwa.js — service-worker registration + install/update UI.
 *
 * export function mount(root)
 * export function update()
 *
 * Same shape as every other UI module (hud/panels/worldMap/...), so main.js can
 * treat it identically. main.js pulls it in with a dynamic import and passes the
 * `#modals` host; the install button re-homes itself into the `#actions` action
 * bar when that exists (it is built after the UI modules mount, so the host is
 * resolved lazily at show time rather than at mount time).
 *
 * Everything here is feature-detected and wrapped: on desktop Chrome, Firefox,
 * an insecure origin, or a browser with no service workers this module is a
 * silent no-op and the game is completely unaffected.
 *
 * PATHS: './sw.js' with { scope: './' }. Relative on purpose — the app is served
 * from the GitHub Pages subpath /idle-casino-manager/, where a leading '/' would
 * resolve to the domain root and 404. The same code works on localhost.
 *
 * i18n: every visible string routes through core/i18n.js's t(), and re-renders
 * on 'locale:changed' (see mount()'s onLocaleChanged subscription). One gap:
 * there is no locale key for the update bar's transient "updating…" busy state
 * (setUpdateBarBusy) — it borrows 'hud.loading' ("Loading…"/"טוען…") as the
 * closest existing string. A dedicated 'pwa.updating' key would read better.
 */

import { bus } from '../core/events.js';
import { t, dir, onLocaleChanged } from '../core/i18n.js';

/* ------------------------------------------------------------------ *
 *  Module state
 * ------------------------------------------------------------------ */

/** The host element handed in by main.js (fallback parent for our UI). */
let rootHost = null;

/** The stashed `beforeinstallprompt` event, or null once used/unavailable. */
let deferredPrompt = null;

/** @type {HTMLButtonElement|null} */
let installBtn = null;

/** @type {HTMLElement|null} */
let updateBar = null;

/** @type {HTMLElement|null} the message span inside updateBar, for retexting. */
let updateBarText = null;

/** @type {HTMLButtonElement|null} the "רענן"/"Refresh" button inside updateBar. */
let updateBarRefreshBtn = null;

/** @type {HTMLButtonElement|null} the "×" dismiss button inside updateBar. */
let updateBarDismissBtn = null;

/** @type {ServiceWorkerRegistration|null} */
let registration = null;

/** The worker that is installed and waiting to take over. */
let waitingWorker = null;

/** True only after the user taps "רענן" — gates the controllerchange reload. */
let refreshRequested = false;

/** Latch so a single controllerchange can never reload twice. */
let reloading = false;

let mounted = false;
let stylesInjected = false;
let installed = false;

/**
 * True once the "beforeinstallprompt never arrived" grace period has elapsed.
 * Lets the install button (and its click handler) fall back to manual
 * instructions for browsers — chiefly WhatsApp's in-app WebView on Android —
 * that cannot fire beforeinstallprompt and cannot install anything at all.
 */
let fallbackMode = false;

/** @type {HTMLElement|null} */
let installHelpBar = null;

/** @type {HTMLElement|null} the message span inside installHelpBar, for retexting. */
let installHelpBarText = null;

/** @type {HTMLButtonElement|null} the "×" dismiss button inside installHelpBar. */
let installHelpBarDismissBtn = null;

/** Unsubscribe handle for the 'locale:changed' listener, set once on mount. */
let localeUnsubscribe = null;

/** update() runs 4x/second; do the real work at most once a second. */
let lastUpdateCheck = 0;

/** Throttle for the opportunistic registration.update() poll. */
let lastVersionPoll = 0;
const VERSION_POLL_MS = 15 * 60 * 1000;

/* ------------------------------------------------------------------ *
 *  Guards / tiny helpers
 * ------------------------------------------------------------------ */

function hasDom() {
  return typeof document !== 'undefined' && !!document.createElement;
}

/** Never let anything in this module bubble into the game loop. */
function safe(fn) {
  try {
    return fn();
  } catch (err) {
    return undefined;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** Emit a toast through the shared bus (hud.js renders it). */
function busToast(text, kind) {
  safe(() => bus.emit('toast', { text: String(text), kind: kind || 'info' }));
}

/** matchMedia that never throws on ancient engines. */
function mq(query) {
  if (typeof window === 'undefined' || !window.matchMedia) return null;
  return safe(() => window.matchMedia(query)) || null;
}

/** Is the game already running as an installed app? */
function isStandalone() {
  const modes = ['(display-mode: standalone)', '(display-mode: fullscreen)', '(display-mode: minimal-ui)'];
  for (let i = 0; i < modes.length; i++) {
    const m = mq(modes[i]);
    if (m && m.matches) return true;
  }
  // iOS Safari's non-standard flag.
  if (typeof navigator !== 'undefined' && navigator.standalone === true) return true;
  return false;
}

/**
 * Loose detection for in-app / WebView browsers — chiefly WhatsApp's embedded
 * browser on Android, which is built on Android WebView. WebView neither fires
 * `beforeinstallprompt` nor offers any install UI of its own, and (worse) uses
 * a storage partition separate from real Chrome, so a save made here is
 * stranded unless the player is explicitly told to reopen the link in Chrome.
 * This is only ever used to pick a more specific instruction string — it never
 * gates whether the fallback affordance itself appears.
 */
function isLikelyInAppBrowser() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/\bwv\b/.test(ua)) return true; // Android WebView's UA marker
  if (/FBAN|FBAV|Instagram|Line\//i.test(ua)) return true; // other common in-app browsers
  if (/Android/.test(ua) && typeof window !== 'undefined' && !window.chrome) return true;
  return false;
}

function swSupported() {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    // A service worker needs a secure context: https, localhost, or 127.0.0.1.
    // Checking first keeps register() from logging a console error on http://.
    window.isSecureContext !== false
  );
}

/* ------------------------------------------------------------------ *
 *  Styles
 * ------------------------------------------------------------------ *
 * Injected as the FIRST child of <head> so that styles.css — which is linked
 * later in the document — wins on equal specificity. These are defaults that
 * the stylesheet owner may override freely; this module owns no .css file.
 */

const CSS = [
  // styles.css owns the install button's LOOK (.pwa-install-btn, a green
  // "sticker" pill) and hides it with the shared `.hidden` utility. It is
  // linked after this <style>, so it wins the cascade — this module therefore
  // toggles `.hidden` rather than a display rule of its own. The rule below is
  // only a standalone fallback (identical to theirs, so nothing conflicts) for
  // the case where styles.css has not loaded.
  '.pwa-install-btn.hidden{display:none !important;}',
  '.pwa-install-btn{cursor:pointer;}',

  '.pwa-update-bar{',
  '  position:fixed;',
  '  left:12px;',
  '  right:12px;',
  '  bottom:calc(12px + env(safe-area-inset-bottom, 0px));',
  '  z-index:400;',
  '  display:none;',
  '  align-items:center;',
  '  justify-content:space-between;',
  '  gap:12px;',
  '  padding:12px 14px;',
  '  border-radius:14px;',
  '  background:rgba(21,12,38,0.96);',
  '  border:2px solid #7d5bbe;',
  '  color:#f4ecff;',
  '  font-size:14px;',
  '  font-weight:700;',
  '  box-shadow:0 8px 24px rgba(0,0,0,0.5);',
  '  max-width:520px;',
  '  margin:0 auto;',
  '}',
  '.pwa-update-bar.is-visible{display:flex;}',

  // The message is the only flexible child; min-width:0 lets it shrink instead
  // of forcing the bar wider than a 412px phone and pushing "רענן" off-screen.
  '.pwa-update-text{',
  '  flex:1 1 auto;',
  '  min-width:0;',
  '  overflow-wrap:anywhere;',
  '}',

  '.pwa-update-btn{',
  '  flex:0 0 auto;',
  '  min-height:44px;',
  '  padding:10px 20px;',
  '  border:none;',
  '  border-radius:10px;',
  '  background:#ffcc4d;',
  '  color:#2a1806;',
  '  font-size:15px;',
  '  font-weight:800;',
  '  cursor:pointer;',
  '}',
  '.pwa-update-btn:active{transform:translateY(2px);}',

  '.pwa-update-dismiss{',
  '  flex:0 0 auto;',
  '  min-width:36px;',
  '  min-height:36px;',
  '  border:none;',
  '  background:transparent;',
  '  color:#c9b8e8;',
  '  font-size:20px;',
  '  line-height:1;',
  '  cursor:pointer;',
  '}'
].join('\n');

function injectStyles() {
  if (stylesInjected || !hasDom()) return;
  stylesInjected = true;
  safe(() => {
    const head = document.head || document.getElementsByTagName('head')[0];
    if (!head) return;
    const style = document.createElement('style');
    style.id = 'pwa-styles';
    style.textContent = CSS;
    if (head.firstChild) head.insertBefore(style, head.firstChild);
    else head.appendChild(style);
  });
}

/* ------------------------------------------------------------------ *
 *  Install button
 * ------------------------------------------------------------------ */

/**
 * Where the install button should live. Prefers the action bar, which main.js
 * builds AFTER the UI modules mount — hence resolving this lazily.
 */
function buttonHost() {
  if (!hasDom()) return null;
  return (
    document.getElementById('actions') ||
    document.getElementById('ui-layer') ||
    rootHost ||
    document.body ||
    null
  );
}

function ensureInstallButton() {
  if (installBtn || !hasDom()) return installBtn;
  injectStyles();
  // .pwa-install-btn ONLY — deliberately not .action-btn as well. styles.css
  // defines .pwa-install-btn (a self-contained green "sticker" pill: its own
  // padding, min-height, border, radius and shadow) BEFORE .action-btn, so
  // carrying both classes would let .action-btn's later `background` win and
  // repaint the call-to-action in the ordinary panel colour. It still lays out
  // correctly as a flex item of .action-bar.
  // Born hidden; showInstallButton() is the only thing that reveals it.
  const btn = el('button', 'pwa-install-btn hidden', t('pwa.install'));
  btn.type = 'button';
  btn.title = t('pwa.installTitle');
  btn.setAttribute('aria-label', t('pwa.installAria'));
  btn.addEventListener('click', onInstallClick);
  installBtn = btn;
  return btn;
}

/** Re-apply the active locale's strings to the install button, in place. */
function retextInstallButton() {
  if (!installBtn) return;
  installBtn.textContent = t('pwa.install');
  installBtn.title = t('pwa.installTitle');
  installBtn.setAttribute('aria-label', t('pwa.installAria'));
}

function showInstallButton() {
  if (installed || isStandalone()) return;
  // Normally gated on a real beforeinstallprompt; fallbackMode also lets the
  // button (and manual instructions) through for browsers that never fire it.
  if (!deferredPrompt && !fallbackMode) return;
  const btn = ensureInstallButton();
  if (!btn) return;
  const host = buttonHost();
  if (host && btn.parentNode !== host) safe(() => host.appendChild(btn));
  btn.classList.remove('hidden');
}

function isInstallButtonVisible() {
  return !!installBtn && !installBtn.classList.contains('hidden');
}

function hideInstallButton() {
  if (!installBtn) return;
  installBtn.classList.add('hidden');
}

function onInstallClick() {
  if (!deferredPrompt) {
    // No native prompt available — either a browser that never fires
    // beforeinstallprompt (WhatsApp's in-app WebView, chiefly) or a Chrome
    // that just hasn't offered it yet. Never leave the tap doing nothing:
    // show the manual steps instead.
    showInstallHelpBar();
    return;
  }

  const prompt = deferredPrompt;
  // A beforeinstallprompt event is single-use; drop the reference immediately
  // so a double-tap can never call prompt() twice (which throws).
  deferredPrompt = null;

  if (!prompt || typeof prompt.prompt !== 'function') {
    hideInstallButton();
    return;
  }

  if (installBtn) installBtn.disabled = true;

  safe(() => prompt.prompt());

  const choice = prompt.userChoice;
  if (choice && typeof choice.then === 'function') {
    choice
      .then((result) => {
        const outcome = result && result.outcome;
        if (outcome === 'accepted') busToast(t('pwa.installing'), 'good');
      })
      .catch(() => {})
      .then(() => {
        hideInstallButton();
        if (installBtn) installBtn.disabled = false;
      });
  } else {
    hideInstallButton();
    if (installBtn) installBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 *  Update bar ("רענן")
 * ------------------------------------------------------------------ *
 * The shared bus 'toast' event carries plain text only (see hud.js), so the
 * toast announces the update and this bar carries the tappable action.
 */

function ensureUpdateBar() {
  if (updateBar || !hasDom()) return updateBar;
  injectStyles();

  const bar = el('div', 'pwa-update-bar');
  bar.setAttribute('dir', dir());
  bar.setAttribute('role', 'status');

  const text = el('span', 'pwa-update-text', t('pwa.update'));
  bar.appendChild(text);

  const refresh = el('button', 'pwa-update-btn', t('pwa.refresh'));
  refresh.type = 'button';
  refresh.addEventListener('click', applyUpdate);
  bar.appendChild(refresh);

  const dismiss = el('button', 'pwa-update-dismiss', '×');
  dismiss.type = 'button';
  dismiss.title = t('common.close');
  dismiss.setAttribute('aria-label', t('common.close'));
  dismiss.addEventListener('click', hideUpdateBar);
  bar.appendChild(dismiss);

  const host = rootHost || document.getElementById('ui-layer') || document.body;
  if (host) safe(() => host.appendChild(bar));
  updateBar = bar;
  updateBarText = text;
  updateBarRefreshBtn = refresh;
  updateBarDismissBtn = dismiss;
  return bar;
}

/** Re-apply the active locale's strings (and writing direction) to the update bar. */
function retextUpdateBar() {
  if (!updateBar) return;
  updateBar.setAttribute('dir', dir());
  if (updateBarText) updateBarText.textContent = t('pwa.update');
  if (updateBarRefreshBtn && !updateBarRefreshBtn.disabled) {
    updateBarRefreshBtn.textContent = t('pwa.refresh');
  }
  if (updateBarDismissBtn) {
    updateBarDismissBtn.title = t('common.close');
    updateBarDismissBtn.setAttribute('aria-label', t('common.close'));
  }
}

function showUpdateBar() {
  // The install-help bar reuses .pwa-update-bar's layout, so both are pinned to
  // the SAME fixed slot (left/right 12px, bottom 12px, z-index 400). Showing
  // one must retract the other or they stack into an unreadable pile with the
  // lower bar's buttons unreachable. The update bar wins: it carries a real
  // action ("רענן"), while the help bar is only advisory.
  hideInstallHelpBar();
  const bar = ensureUpdateBar();
  if (bar) bar.classList.add('is-visible');
}

function hideUpdateBar() {
  if (updateBar) updateBar.classList.remove('is-visible');
}

/**
 * Bug fix: applyUpdate() used to hide the bar immediately, before the reload
 * it triggers actually happens — a tap in that window (postMessage sent /
 * fallback timer pending) discarded both the pending update AND the only UI
 * that could retry it. Locking the bar (disabled buttons, "updating…" label)
 * instead keeps it visible and inert until the reload really occurs; doReload()
 * restores it (see below) if a reload turns out not to happen after all.
 */
function setUpdateBarBusy(busy) {
  if (!updateBar) return;
  if (updateBarRefreshBtn) {
    updateBarRefreshBtn.disabled = !!busy;
    // No dedicated "updating…" locale key exists yet (closest is hud.loading,
    // a generic "Loading…"/"טוען…" — see the integrator note in this module's
    // header comment); reusing it beats leaving the busy state untranslated.
    updateBarRefreshBtn.textContent = busy ? t('hud.loading') : t('pwa.refresh');
  }
  if (updateBarDismissBtn) updateBarDismissBtn.disabled = !!busy;
  if (updateBar) updateBar.classList.toggle('is-updating', !!busy);
}

/* ------------------------------------------------------------------ *
 *  Install help bar (manual-install fallback)
 * ------------------------------------------------------------------ *
 * Shown instead of the native prompt when no beforeinstallprompt has arrived
 * — the WhatsApp-in-app-browser case above all. Reuses .pwa-update-bar's
 * layout/styling so it matches the update bar without new CSS.
 */

function installHelpMessage() {
  return isLikelyInAppBrowser() ? t('pwa.helpInApp') : t('pwa.helpChrome');
}

function ensureInstallHelpBar() {
  if (installHelpBar || !hasDom()) return installHelpBar;
  injectStyles();

  const bar = el('div', 'pwa-update-bar pwa-install-help');
  bar.setAttribute('dir', dir());
  bar.setAttribute('role', 'status');

  const text = el('span', 'pwa-update-text', installHelpMessage());
  bar.appendChild(text);

  const dismiss = el('button', 'pwa-update-dismiss', '×');
  dismiss.type = 'button';
  dismiss.title = t('common.close');
  dismiss.setAttribute('aria-label', t('common.close'));
  dismiss.addEventListener('click', hideInstallHelpBar);
  bar.appendChild(dismiss);

  const host = rootHost || document.getElementById('ui-layer') || document.body;
  if (host) safe(() => host.appendChild(bar));
  installHelpBar = bar;
  installHelpBarText = text;
  installHelpBarDismissBtn = dismiss;
  return bar;
}

/** Re-apply the active locale's strings (and writing direction) to the install-help bar. */
function retextInstallHelpBar() {
  if (!installHelpBar) return;
  installHelpBar.setAttribute('dir', dir());
  if (installHelpBarText) installHelpBarText.textContent = installHelpMessage();
  if (installHelpBarDismissBtn) {
    installHelpBarDismissBtn.title = t('common.close');
    installHelpBarDismissBtn.setAttribute('aria-label', t('common.close'));
  }
}

function showInstallHelpBar() {
  // Mutually exclusive with the update bar — they share one fixed slot.
  hideUpdateBar();
  const bar = ensureInstallHelpBar();
  if (bar) bar.classList.add('is-visible');
}

function hideInstallHelpBar() {
  if (installHelpBar) installHelpBar.classList.remove('is-visible');
}

/** A new worker finished installing while an old one is still in control. */
function announceUpdate(worker) {
  if (!worker) return;
  if (waitingWorker === worker && updateBar && updateBar.classList.contains('is-visible')) return;
  waitingWorker = worker;
  busToast(t('pwa.updateToast'), 'info');
  showUpdateBar();
}

/**
 * Tell the waiting worker to take over, then reload once it does.
 * The reload is driven by 'controllerchange' rather than fired immediately so
 * the new page load is served by the NEW worker, not the outgoing one.
 */
function applyUpdate() {
  // Cross-reload guard: if we somehow land back here right after a refresh,
  // do not enter a reload loop — just drop the request. Checked BEFORE
  // touching the bar/state so a stray tap in this window is a true no-op
  // instead of locking a bar that will never get unlocked.
  if (recentlyReloaded()) {
    return;
  }

  refreshRequested = true;
  // Bug fix: this used to call hideUpdateBar() here, before the reload it
  // triggers actually happens. A tap in the few seconds between sending
  // SKIP_WAITING and the controllerchange-driven reload firing discarded
  // BOTH the pending update and the only UI that could retry it. Lock the
  // bar visible/disabled instead; only a real reload (or doReload() failing
  // to start one) should end this state — see setUpdateBarBusy / doReload.
  setUpdateBarBusy(true);
  markReloaded();

  const worker = waitingWorker || (registration && registration.waiting);
  if (worker && typeof worker.postMessage === 'function') {
    safe(() => worker.postMessage({ type: 'SKIP_WAITING' }));
  } else {
    // Nothing waiting after all: a plain reload is the honest fallback.
    doReload();
    return;
  }

  // If controllerchange never arrives (worker wedged), reload anyway.
  safe(() =>
    window.setTimeout(() => {
      if (refreshRequested) doReload();
    }, 3000)
  );
}

function doReload() {
  if (reloading) return;
  reloading = true;
  const started = safe(() => {
    window.location.reload();
    return true;
  });
  if (!started) {
    // The reload never actually got underway (e.g. `window.location.reload`
    // threw, or is unavailable). Restore the bar to its normal, actionable
    // state rather than leaving the player staring at a disabled "updating…"
    // bar that will never resolve — a future tap can try again.
    reloading = false;
    refreshRequested = false;
    setUpdateBarBusy(false);
  }
}

/* sessionStorage can throw in some privacy modes — always guarded. */
const RELOAD_KEY = 'pwa:reloadedAt';

function recentlyReloaded() {
  const raw = safe(() => window.sessionStorage.getItem(RELOAD_KEY));
  if (!raw) return false;
  const at = Number(raw);
  return Number.isFinite(at) && Date.now() - at < 10000;
}

function markReloaded() {
  safe(() => window.sessionStorage.setItem(RELOAD_KEY, String(Date.now())));
}

/* ------------------------------------------------------------------ *
 *  Service worker registration
 * ------------------------------------------------------------------ */

function watchInstalling(reg) {
  const incoming = reg.installing;
  if (!incoming) return;
  incoming.addEventListener('statechange', () => {
    // 'installed' + an existing controller == an UPDATE (not a first install).
    if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
      announceUpdate(incoming);
    }
  });
}

function registerSW() {
  if (!swSupported()) return;

  let promise = null;
  try {
    promise = navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    return; // registration is best-effort; the game does not depend on it
  }
  if (!promise || typeof promise.then !== 'function') return;

  promise
    .then((reg) => {
      if (!reg) return;
      registration = reg;

      // Already waiting when we arrived (installed during a previous visit).
      if (reg.waiting && navigator.serviceWorker.controller) announceUpdate(reg.waiting);

      watchInstalling(reg);
      reg.addEventListener('updatefound', () => watchInstalling(reg));
    })
    .catch(() => {
      // Offline, blocked cookies, unsupported scheme — never surface this.
    });

  // Reload only when the user asked for it, so the very first clients.claim()
  // (which also fires controllerchange) does not bounce the page.
  safe(() =>
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshRequested) return;
      doReload();
    })
  );
}

/** Ask the browser to re-check sw.js. Cheap, throttled, and failure-tolerant. */
function pollForUpdate() {
  if (!registration || typeof registration.update !== 'function') return;
  const now = Date.now();
  if (now - lastVersionPoll < VERSION_POLL_MS) return;
  lastVersionPoll = now;
  safe(() => {
    const p = registration.update();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  });
}

/* ------------------------------------------------------------------ *
 *  Public API
 * ------------------------------------------------------------------ */

/**
 * @param {HTMLElement|null} root Host element supplied by main.js (#modals).
 */
export function mount(root) {
  if (mounted || !hasDom()) return;
  mounted = true;
  rootHost = root || null;

  injectStyles();

  if (isStandalone()) installed = true;

  // Capture the install prompt. Chrome fires this only when the manifest, the
  // icons and the service worker all check out — so its arrival is itself the
  // signal that the app really is installable.
  safe(() =>
    window.addEventListener('beforeinstallprompt', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      deferredPrompt = event;
      showInstallButton();
    })
  );

  safe(() =>
    window.addEventListener('appinstalled', () => {
      installed = true;
      deferredPrompt = null;
      hideInstallButton();
      hideInstallHelpBar();
      busToast(t('pwa.installed'), 'good');
    })
  );

  // Fallback for browsers that never fire beforeinstallprompt at all — chiefly
  // WhatsApp's in-app WebView browser on Android, which cannot install
  // anything and (worse) saves to a storage partition separate from real
  // Chrome, stranding progress unless the player is told to switch browsers.
  // If the real event hasn't shown up within a few seconds, reveal the button
  // anyway; its click handler falls back to manual instructions (above).
  safe(() =>
    window.setTimeout(() => {
      if (deferredPrompt || installed || isStandalone()) return;
      fallbackMode = true;
      showInstallButton();
    }, 4000)
  );

  // Installing from Chrome's own menu (no appinstalled in every case) flips
  // display-mode; react to that too.
  const standaloneMq = mq('(display-mode: standalone)');
  if (standaloneMq) {
    const onChange = (e) => {
      if (e && e.matches) {
        installed = true;
        hideInstallButton();
        hideInstallHelpBar();
      }
    };
    if (typeof standaloneMq.addEventListener === 'function') {
      safe(() => standaloneMq.addEventListener('change', onChange));
    } else if (typeof standaloneMq.addListener === 'function') {
      safe(() => standaloneMq.addListener(onChange));
    }
  }

  // Register after load so the SW never competes with the game's first paint.
  if (swSupported()) {
    if (document.readyState === 'complete') registerSW();
    else safe(() => window.addEventListener('load', registerSW, { once: true }));
  }

  // Coming back to the tab is a good moment to look for a new deploy.
  safe(() =>
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pollForUpdate();
    })
  );

  // Re-render every persistent element this module owns whenever the player
  // switches language, so none of them are stuck showing the old locale.
  if (!localeUnsubscribe) {
    localeUnsubscribe = onLocaleChanged(() => {
      retextInstallButton();
      retextUpdateBar();
      retextInstallHelpBar();
    });
  }
}

/**
 * Called from main.js's UI refresh (~4x/second). Deliberately near-free: the
 * real work is throttled to once a second and touches the DOM only on change.
 */
export function update() {
  if (!mounted) return;

  const now = Date.now();
  if (now - lastUpdateCheck < 1000) return;
  lastUpdateCheck = now;

  if (!installed && isStandalone()) installed = true;

  if (installed || (!deferredPrompt && !fallbackMode)) {
    if (isInstallButtonVisible()) hideInstallButton();
    if (installed) hideInstallHelpBar();
    return;
  }

  // The action bar may have been built after we mounted; re-home if needed.
  if (isInstallButtonVisible()) {
    const host = buttonHost();
    if (host && installBtn.parentNode !== host) safe(() => host.appendChild(installBtn));
  } else {
    showInstallButton();
  }
}

export default { mount, update };
