/**
 * events.js — tiny synchronous pub/sub bus shared by every module.
 * No imports: this file must stay dependency-free so anything can use it.
 *
 * Standard event names (payload shapes):
 *   'money:changed'      {worldId, money}
 *   'diamonds:changed'   {diamonds}
 *   'purchase'           {worldId, key, kind}          kind: 'venue'|'station'|'staff'|'system'
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

  /** Remove every listener (used by resetState / hot reloads). */
  clear() {
    listeners.clear();
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
