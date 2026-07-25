/**
 * events.js — tiny synchronous pub/sub bus shared by every module.
 * No imports: this file must stay dependency-free so anything can use it.
 *
 * Standard event names (payload shapes):
 *   'money:changed'      {worldId, money}
 *   'diamonds:changed'   {diamonds}
 *   'purchase'           {worldId, key, kind}          kind: 'venue'|'station'|'staff'|'system'
 *                        COALESCED (bus.emitCoalesced): a burst of buys inside
 *                        one task fires a single 'purchase' on the next
 *                        microtask, carrying the last buy's payload. Listeners
 *                        must therefore re-read world state, not count events.
 *   'tier:up'            {worldId, tier}
 *   'world:unlocked'     {worldId}
 *   'world:switched'     {worldId}
 *   'guest:served'       {worldId}
 *   'liveEvent:spawn'    {worldId, type, id}
 *   'liveEvent:resolved' {worldId, type, id, reward}
 *   'toast'              {text, kind}                  kind: 'good'|'bad'|'info'
 *   'boost:started'      {kind, mult, seconds}
 *   'ui:refresh'         {}
 */

/** @type {Map<string, Function[]>} */
const listeners = new Map();

/** Names with a coalesced emit in flight -> the payload the flush will carry. */
const pending = new Map();
let flushScheduled = false;

/** Microtask scheduler with a setTimeout fallback for ancient engines. */
function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  const run = () => {
    flushScheduled = false;
    if (pending.size === 0) return;
    // Snapshot + clear first: a listener is allowed to emit again.
    const batch = Array.from(pending.entries());
    pending.clear();
    for (let i = 0; i < batch.length; i++) bus.emit(batch[i][0], batch[i][1]);
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(run);
  else Promise.resolve().then(run).catch(() => {});
}

/** Guard so a throwing listener never kills the game loop. */
function safeCall(fn, payload, name) {
  try {
    fn(payload);
  } catch (err) {
    // Never rethrow into the emitter; log once and continue.
    if (typeof console !== 'undefined' && console.error) {
      console.error('[bus] listener failed for "' + name + '":', err);
    }
  }
}

export const bus = {
  /**
   * Subscribe to an event.
   * @param {string} name
   * @param {(payload:any)=>void} fn
   * @returns {()=>void} unsubscribe helper
   */
  on(name, fn) {
    if (typeof name !== 'string' || typeof fn !== 'function') return () => {};
    let arr = listeners.get(name);
    if (!arr) {
      arr = [];
      listeners.set(name, arr);
    }
    if (arr.indexOf(fn) === -1) arr.push(fn);
    return () => bus.off(name, fn);
  },

  /**
   * Subscribe once; auto-removes after the first emit.
   * @param {string} name
   * @param {(payload:any)=>void} fn
   */
  once(name, fn) {
    if (typeof name !== 'string' || typeof fn !== 'function') return () => {};
    const wrap = (payload) => {
      bus.off(name, wrap);
      fn(payload);
    };
    return bus.on(name, wrap);
  },

  /**
   * Unsubscribe. Safe to call with unknown name/fn.
   * @param {string} name
   * @param {(payload:any)=>void} fn
   */
  off(name, fn) {
    const arr = listeners.get(name);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
    if (arr.length === 0) listeners.delete(name);
  },

  /**
   * Fire an event. Listeners are copied first so handlers may on/off freely.
   * @param {string} name
   * @param {any} [payload]
   */
  emit(name, payload) {
    const arr = listeners.get(name);
    if (!arr || arr.length === 0) return;
    const snapshot = arr.slice();
    for (let i = 0; i < snapshot.length; i++) {
      safeCall(snapshot[i], payload, name);
    }
  },

  /**
   * Fire an event AT MOST ONCE per synchronous burst, on the next microtask.
   * Repeat calls within the same task collapse into a single emit carrying the
   * LAST payload — so only use it for events whose listeners re-read the world
   * state anyway (never for per-item notifications somebody counts).
   *
   * Why it exists: "Buy x10" runs ten synchronous economy.buy() calls, and the
   * 'purchase' listener in main.js rebuilds the whole floor plan (a candidate-
   * width search + grid flood fill + a BFS flow field per venue node). Ten of
   * those back to back on the main thread is a visible stall on the phone.
   * Coalescing turns the whole tap into one rebuild.
   *
   * @param {string} name
   * @param {any} [payload]
   */
  emitCoalesced(name, payload) {
    if (typeof name !== 'string') return;
    pending.set(name, payload);
    scheduleFlush();
  },

  /** Remove every listener (used by resetState / hot reloads). */
  clear() {
    listeners.clear();
    pending.clear();
  },

  /** Debug helper: how many listeners a name currently has. */
  count(name) {
    const arr = listeners.get(name);
    return arr ? arr.length : 0;
  }
};

/** Convenience wrapper used all over the UI. */
export function toast(text, kind) {
  bus.emit('toast', { text: String(text), kind: kind || 'info' });
}

export default bus;
