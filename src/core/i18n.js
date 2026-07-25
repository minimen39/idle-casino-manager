/**
 * i18n.js — the game's translation layer (Hebrew + English).
 *
 * PUBLIC CONTRACT (every adopting module may rely on exactly this):
 *   export const LOCALES        [{ id, name, dir }, ...]
 *   export function t(key, params)   'venue.slots.name' -> string; {tokens} interpolate
 *   export function setLocale(id)    persists, updates <html lang/dir>, emits 'locale:changed'
 *   export function getLocale()      -> 'he' | 'en'
 *   export function dir()            -> 'rtl' | 'ltr'
 *   export function initLocale()     called ONCE at boot
 *
 * Guarantees:
 *   - t() NEVER throws and NEVER renders "undefined". An unknown key falls back
 *     to the Hebrew string, then to the key itself.
 *   - A missing key is console.warn'd at most ONCE, and only on a dev origin
 *     (localhost / 127.0.0.1 / file://). Production is silent.
 *   - This module deliberately does NOT import state.js (that would create a
 *     cycle: state -> economy -> config -> i18n). The choice is persisted
 *     straight to localStorage under 'idleCasino.locale'; main.js is free to
 *     reconcile it with the save file afterwards.
 *   - Only events.js is imported, and events.js itself imports nothing.
 *
 * Paths stay relative — the app is served from a GitHub Pages subpath.
 */

import { bus } from './events.js';
import he from './locales/he.js';
import en from './locales/en.js';

/* ------------------------------------------------------------------ *
 *  Locale table
 * ------------------------------------------------------------------ */

export const LOCALES = [
  { id: 'he', name: 'עברית', dir: 'rtl' },
  { id: 'en', name: 'English', dir: 'ltr' }
];

/** id -> flat string table. */
const TABLES = { he: he, en: en };

/** The locale used whenever anything is missing or unknown. */
const FALLBACK_LOCALE = 'he';

/** localStorage key. Deliberately separate from the save blob. */
const STORAGE_KEY = 'idleCasino.locale';

/** Bus event fired after a real locale change. */
const CHANGE_EVENT = 'locale:changed';

/** Current locale id. Always one of LOCALES[].id. */
let current = FALLBACK_LOCALE;

/** True once initLocale() has run, so a second call is a cheap no-op. */
let initialised = false;

/** Keys already warned about, so a missing key never spams the console. */
const warned = new Set();

/* ------------------------------------------------------------------ *
 *  Tiny guarded helpers
 * ------------------------------------------------------------------ */

/** Run fn, swallowing anything it throws. */
function safe(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return fallback;
  }
}

/** Is this a dev origin? Only there do we warn about missing keys. */
function isDev() {
  return safe(() => {
    if (typeof location === 'undefined') return false;
    const host = String(location.hostname || '');
    if (host === '' ) return true;              // file://
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    return host.slice(-6) === '.local';
  }, false);
}

function warnOnce(message, key) {
  if (!isDev()) return;
  if (warned.has(key)) return;
  warned.add(key);
  safe(() => {
    if (typeof console !== 'undefined' && console.warn) console.warn('[i18n] ' + message);
  });
}

/** The locale descriptor for an id, or null. */
function localeDef(id) {
  for (let i = 0; i < LOCALES.length; i++) {
    if (LOCALES[i].id === id) return LOCALES[i];
  }
  return null;
}

/** True when `id` is a locale this build ships. */
export function isLocale(id) {
  return !!localeDef(id) && !!TABLES[id];
}

/* ------------------------------------------------------------------ *
 *  Persistence (localStorage only — never state.js)
 * ------------------------------------------------------------------ */

function readStored() {
  const raw = safe(() => {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  }, null);
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return isLocale(id) ? id : null;
}

function writeStored(id) {
  safe(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, id);
  });
}

/**
 * Best guess from the browser: Hebrew if navigator.language starts with 'he',
 * English otherwise. Also checks navigator.languages so a device whose primary
 * UI language is English but that lists Hebrew still lands on Hebrew only when
 * Hebrew comes first.
 */
function detectLocale() {
  return safe(() => {
    if (typeof navigator === 'undefined') return 'en';
    const list = [];
    if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
      for (let i = 0; i < navigator.languages.length; i++) list.push(navigator.languages[i]);
    }
    if (navigator.language) list.push(navigator.language);
    for (let i = 0; i < list.length; i++) {
      const tag = String(list[i] || '').toLowerCase();
      if (!tag) continue;
      // 'he', 'he-IL' and the legacy 'iw' code all mean Hebrew.
      if (tag.indexOf('he') === 0 || tag.indexOf('iw') === 0) return 'he';
      if (tag.indexOf('en') === 0) return 'en';
    }
    return 'en';
  }, 'en');
}

/* ------------------------------------------------------------------ *
 *  Document wiring (<html lang> / <html dir>)
 * ------------------------------------------------------------------ */

/**
 * Push the current locale onto <html>. Idempotent and completely guarded, so
 * it is safe to call from a headless/test environment with no document.
 */
function applyToDocument() {
  safe(() => {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const root = document.documentElement;
    const def = localeDef(current);
    root.setAttribute('lang', current);
    root.setAttribute('dir', def ? def.dir : 'rtl');
  });
}

/* ------------------------------------------------------------------ *
 *  Lookup + interpolation
 * ------------------------------------------------------------------ */

/** Raw string for a key in a given locale, or null when absent/blank. */
function rawString(id, key) {
  const table = TABLES[id];
  if (!table) return null;
  if (!Object.prototype.hasOwnProperty.call(table, key)) return null;
  const value = table[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Replace every {token} with params[token].
 * A token with no matching param is left exactly as written (it is a caller
 * bug, and a visible "{amount}" is easier to spot than a silent hole) — this
 * function can never emit the text "undefined".
 */
function interpolate(text, params) {
  if (typeof text !== 'string' || text.indexOf('{') === -1) return text;
  if (!params || typeof params !== 'object') return text;
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return whole;
    const value = params[name];
    if (value === undefined || value === null) return whole;
    return String(value);
  });
}

/**
 * Translate a key.
 * @param {string} key   flat key, e.g. 'venue.slots.name'
 * @param {object} [params] values for {token} placeholders
 * @returns {string} always a string, never "undefined", never throws
 */
export function t(key, params) {
  if (typeof key !== 'string' || key.length === 0) return '';

  let text = rawString(current, key);

  if (text === null && current !== FALLBACK_LOCALE) {
    text = rawString(FALLBACK_LOCALE, key);
    if (text !== null) {
      warnOnce('missing "' + current + '" string for key: ' + key, current + '::' + key);
    }
  }

  if (text === null) {
    warnOnce('unknown key: ' + key, '??::' + key);
    return key;
  }

  return safe(() => interpolate(text, params), text);
}

/** True when the key exists in the current locale or the Hebrew fallback. */
export function hasKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  return rawString(current, key) !== null || rawString(FALLBACK_LOCALE, key) !== null;
}

/* ------------------------------------------------------------------ *
 *  Public locale controls
 * ------------------------------------------------------------------ */

/** @returns {'he'|'en'} the active locale id. */
export function getLocale() {
  return current;
}

/** @returns {'rtl'|'ltr'} writing direction of the active locale. */
export function dir() {
  const def = localeDef(current);
  return def ? def.dir : 'rtl';
}

/** Display name of a locale ('עברית' / 'English'); defaults to the active one. */
export function localeName(id) {
  const def = localeDef(id === undefined ? current : id);
  return def ? def.name : '';
}

/**
 * Switch language: persists the choice, updates <html lang/dir> and emits
 * 'locale:changed' {locale, dir, previous} so every mounted UI module can
 * re-render itself.
 *
 * Unknown ids are ignored. Re-selecting the active locale re-applies the
 * document attributes but does NOT emit (nothing changed), so a language
 * <select> firing on every interaction cannot cause redundant rebuilds.
 *
 * @param {string} id 'he' | 'en'
 * @returns {string} the locale in force after the call
 */
export function setLocale(id) {
  const next = typeof id === 'string' ? id.trim() : '';
  if (!isLocale(next)) {
    warnOnce('unknown locale ignored: ' + String(id), 'locale::' + String(id));
    return current;
  }

  const previous = current;
  current = next;
  writeStored(next);
  applyToDocument();

  if (previous !== next) {
    safe(() => bus.emit(CHANGE_EVENT, { locale: next, dir: dir(), previous }));
  }
  return current;
}

/**
 * Boot-time setup: restore the saved choice, otherwise pick from
 * navigator.language (Hebrew when it starts with 'he', English otherwise),
 * then stamp <html lang/dir>.
 *
 * Deliberately does NOT emit 'locale:changed' — at boot this IS the initial
 * state, and every UI module renders with it on first mount. Safe to call
 * more than once; later calls just re-apply the document attributes.
 *
 * @returns {'he'|'en'} the locale that ended up active
 */
export function initLocale() {
  if (initialised) {
    applyToDocument();
    return current;
  }
  initialised = true;

  const stored = readStored();
  if (stored) {
    current = stored;
  } else {
    const detected = detectLocale();
    current = isLocale(detected) ? detected : FALLBACK_LOCALE;
    // Nothing persisted yet: remember the auto-pick so the very first manual
    // switch is the only thing that can ever change it again.
    writeStored(current);
  }

  applyToDocument();
  return current;
}

/**
 * Convenience subscriber for UI modules:
 *   const off = onLocaleChanged(() => rebuild());
 * @param {(payload:{locale:string, dir:string, previous:string})=>void} fn
 * @returns {()=>void} unsubscribe
 */
export function onLocaleChanged(fn) {
  if (typeof fn !== 'function') return () => {};
  return bus.on(CHANGE_EVENT, fn);
}

export default {
  LOCALES,
  t,
  setLocale,
  getLocale,
  dir,
  initLocale,
  localeName,
  hasKey,
  isLocale,
  onLocaleChanged
};
