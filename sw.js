/* sw.js — Idle Casino Manager service worker.
 *
 * Classic (non-module) service worker on purpose: `type: 'module'` workers are
 * supported in modern Chrome but buy us nothing here and narrow compatibility.
 *
 * PATH RULES (this app is served from a GitHub Pages SUBPATH:
 *   https://minimen39.github.io/idle-casino-manager/ )
 *   -> EVERY url in this file is relative ('./...'). A single leading '/' would
 *      resolve against https://minimen39.github.io/ and 404. There are none.
 *   -> Relative urls in a service worker resolve against the SW's own location,
 *      i.e. the app root directory, which is exactly what we want. The same file
 *      therefore works unchanged from http://localhost:8765/.
 *
 * Strategy:
 *   install   precache the whole app shell (required: any core asset — shell,
 *             ES modules, styles.css — failing to precache rejects install so
 *             the browser retries later rather than activating a worker that
 *             cannot boot the game offline. Optional assets stay tolerant: a
 *             missing icon can never reject the install).
 *   activate   drop stale versioned caches, then clients.claim().
 *   fetch      navigations  -> network raced against a short timeout, falling
 *                              back to the cached shell so start_url returns
 *                              200 offline (Chrome requires this for the
 *                              install prompt) AND on a hung/slow connection,
 *                              not just a hard/fast-rejecting one.
 *              same-origin  -> cache-first with a background revalidate.
 *              cross-origin -> not touched at all (no respondWith).
 *   message    'SKIP_WAITING' activates a waiting update on demand.
 */

'use strict';

/* ------------------------------------------------------------------ *
 *  Cache identity
 * ------------------------------------------------------------------ */

/**
 * Cache generation. Bumping it throws the whole precache away on the next
 * install, so it is only bumped when the CACHING BEHAVIOUR changes — it is no
 * longer the mechanism that gets a deploy to installed clients.
 *
 * It used to be: `handleAsset` is cache-first, so every ES module and
 * styles.css was served from the v4 cache until some later deploy happened to
 * change sw.js's own bytes. A fix that touched only src/** was therefore
 * invisible to an installed player for the entire session (and commit 0e769fe
 * — "Bump service worker cache version so the zoom fix reaches installed
 * clients" — was that failure mode being papered over by hand).
 *
 * Now the background revalidate compares the fresh bytes against the cached
 * ones and, when a precached asset really changed, tells every open client
 * (see notifyClients / ASSET_UPDATED). pwa.js turns that into the same update
 * bar a waiting worker produces, so a deploy is announced within seconds of a
 * launch and one tap on "Refresh" runs the new code. Bumping this constant is
 * now an optimisation, not a release requirement.
 */
var VERSION = 'v7';
var CACHE_PREFIX = 'idle-casino-';
var CACHE_NAME = CACHE_PREFIX + VERSION;

/* ------------------------------------------------------------------ *
 *  Scope-relative URLs
 * ------------------------------------------------------------------ */

/** Absolute url of the app directory, e.g. https://host/idle-casino-manager/ */
var SHELL_URL = new URL('./', self.location.href).href;
/** Absolute url of the explicit document, e.g. https://host/idle-casino-manager/index.html */
var INDEX_URL = new URL('./index.html', self.location.href).href;
/** Path prefix everything we own lives under, e.g. /idle-casino-manager/ */
var SCOPE_PATH = new URL('./', self.location.href).pathname;

/* ------------------------------------------------------------------ *
 *  Precache manifest
 * ------------------------------------------------------------------ *
 *
 * CORE_ASSETS: verified to exist on disk. './' and './index.html' are BOTH
 * listed because they are distinct cache keys even though the server returns
 * the same bytes for each — start_url is './', so './' must be a cache hit.
 *
 * All 19 ES modules are enumerated explicitly; the SW cannot walk the import
 * graph, and a module that is missing from the cache would make the game fail
 * to boot offline with a module-resolution error.
 *
 * Re-verified against the filesystem: `find . -name '*.js'` outside tools/
 * returns exactly these 19 modules plus sw.js itself (which must NOT be
 * precached — the browser fetches it through its own update path), and
 * index.html references only ./styles.css, ./src/main.js, ./manifest.webmanifest,
 * ./icons/favicon-32.png and ./icons/apple-touch-icon-180.png, all listed here
 * or in OPTIONAL_ASSETS below. No drift.
 */
var CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',

  './src/main.js',

  './src/core/config.js',
  './src/core/economy.js',
  './src/core/events.js',
  './src/core/i18n.js',
  './src/core/state.js',

  './src/core/locales/en.js',
  './src/core/locales/he.js',

  './src/render/renderer.js',

  './src/sim/guests.js',
  './src/sim/layout.js',
  './src/sim/liveEvents.js',
  './src/sim/staff.js',

  './src/ui/hud.js',
  './src/ui/minigames.js',
  './src/ui/monetization.js',
  './src/ui/panels.js',
  './src/ui/pwa.js',
  './src/ui/worldMap.js'
];

/*
 * OPTIONAL_ASSETS: nice-to-have. These are fetched individually and a failure is
 * swallowed, so a not-yet-deployed icon can never reject install(). The icon
 * list below mirrors index.html + the manifests; on top of it, install parses
 * the live manifest and precaches whatever icons it actually declares, so this
 * list staying in sync is not load-bearing. All three manifests declare the
 * same icons, so parsing the default one covers the per-locale copies too.
 */
var OPTIONAL_ASSETS = [
  './manifest.webmanifest',
  // main.js swaps <link rel="manifest"> to the per-locale file at boot, so both
  // have to be cached or an offline install prompt reads a 504.
  './manifest.he.webmanifest',
  './manifest.en.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/favicon-32.png',
  './icons/apple-touch-icon-180.png',
  // The first-run guide + help modal (contract C7). It now ships, and is
  // precached like everything else in this list — but it stays OPTIONAL rather
  // than CORE deliberately: main.js imports it lazily behind a guard, so a
  // build without it degrades to "no guide", whereas listing it under
  // CORE_ASSETS would make its absence reject install() and leave the app with
  // NO service worker at all. Resilience is worth more than the loud failure.
  './src/ui/tutorial.js'
];

/* ------------------------------------------------------------------ *
 *  Small helpers — every one of these swallows its own errors so that a
 *  cache miss degrades to a plain network fetch instead of throwing.
 * ------------------------------------------------------------------ */

/** caches.open() that resolves to null instead of rejecting. */
function openCache() {
  return caches.open(CACHE_NAME).catch(function () {
    return null;
  });
}

/** cache.match() that resolves to null instead of rejecting. */
function safeMatch(cache, request) {
  if (!cache) return Promise.resolve(null);
  return cache.match(request).catch(function () {
    return null;
  });
}

/** cache.put() that never rejects (quota errors, opaque bodies, ...). */
function safePut(cache, request, response) {
  if (!cache || !response) return Promise.resolve(false);
  return cache
    .put(request, response)
    .then(function () {
      return true;
    })
    .catch(function () {
      return false;
    });
}

/**
 * Is this response safe to persist?
 * Only same-origin ('basic'), OK, non-partial, non-opaque responses.
 */
function isCacheable(response) {
  if (!response) return false;
  if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.type === 'error') return false;
  if (!response.ok) return false;
  if (response.status !== 200) return false;
  // 'basic' = a normal same-origin fetch. 'default' covers synthetic and
  // navigation-preload responses, which are same-origin here too. 'cors' is
  // rejected — cross-origin never reaches the cache. (The fetch handler already
  // drops other origins before this point; this is the second line of defence.)
  if (response.type !== 'basic' && response.type !== 'default') return false;
  return true;
}

/** Does this url live inside the app directory we control? */
function isInScope(url) {
  return url.pathname.indexOf(SCOPE_PATH) === 0;
}

/**
 * Fetch one url bypassing the HTTP cache and store it under `key`.
 * Resolves true/false; NEVER rejects.
 */
function precacheOne(cache, url, key) {
  if (!cache) return Promise.resolve(false);
  var request = new Request(url, { cache: 'reload', credentials: 'same-origin' });
  return fetch(request)
    .then(function (response) {
      if (!isCacheable(response)) return false;
      // Store under the canonical key so lookups by plain url hit.
      return safePut(cache, key || url, response);
    })
    .catch(function () {
      return false;
    });
}

/**
 * Read manifest.webmanifest and return the absolute urls of every icon it
 * declares. Resolves to [] on any problem — this is a bonus, not a requirement.
 */
function iconsFromManifest() {
  var manifestUrl = new URL('./manifest.webmanifest', self.location.href).href;
  return fetch(new Request(manifestUrl, { cache: 'reload', credentials: 'same-origin' }))
    .then(function (response) {
      if (!response || !response.ok) return [];
      return response.json();
    })
    .then(function (manifest) {
      if (!manifest || !Array.isArray(manifest.icons)) return [];
      var out = [];
      for (var i = 0; i < manifest.icons.length; i++) {
        var icon = manifest.icons[i];
        if (!icon || typeof icon.src !== 'string' || !icon.src) continue;
        try {
          var resolved = new URL(icon.src, manifestUrl).href;
          if (out.indexOf(resolved) === -1) out.push(resolved);
        } catch (err) {
          /* skip a malformed src */
        }
      }
      return out;
    })
    .catch(function () {
      return [];
    });
}

/* ------------------------------------------------------------------ *
 *  install — precache the app shell
 * ------------------------------------------------------------------ */

/** Resolve a list of relative urls against the SW location. */
function absolutize(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    try {
      out.push(new URL(list[i], self.location.href).href);
    } catch (err) {
      /* skip anything unresolvable */
    }
  }
  return out;
}

function precacheAll() {
  return openCache().then(function (cache) {
    // If caches.open() itself failed, there is nothing to precache into and
    // no shell guard for offline use. Silently resolving here would let
    // install() succeed and the browser activate a worker whose cache is
    // completely empty — "installed" but useless offline. Reject instead so
    // the browser discards this worker and retries install() later.
    if (!cache) {
      throw new Error('[sw] precache aborted: caches.open() failed');
    }

    // Every url is precached EXACTLY ONCE. The manifest's icons overlap with
    // OPTIONAL_ASSETS, and issuing two concurrent cache.put() calls for the
    // same key makes one of them lose the race and silently drop the entry —
    // so the lists are merged through this `seen` map rather than run in
    // parallel. It also halves the number of network requests.
    var seen = Object.create(null);
    function unique(urls) {
      var out = [];
      for (var i = 0; i < urls.length; i++) {
        if (seen[urls[i]]) continue;
        seen[urls[i]] = true;
        out.push(urls[i]);
      }
      return out;
    }

    // Core assets, one request each. Deliberately NOT cache.addAll(): addAll is
    // all-or-nothing, so one bad entry rejects the whole install and the app
    // silently loses its service worker (and with it, installability).
    var coreUrls = unique(absolutize(CORE_ASSETS));

    return Promise.all(
      coreUrls.map(function (url) {
        return precacheOne(cache, url);
      })
    ).then(function (coreResults) {
      // Every core asset (shell + all ES modules + styles.css) must have made
      // it into the cache. A partially-precached shell is worse than no
      // service worker at all: it lets Chrome consider the app installable
      // and offline-ready, then serves a 200 shell whose <script type="module">
      // imports 504 offline, so the game boots to a blank canvas. Rejecting
      // here makes the browser discard this worker and retry install() on the
      // next successful page load instead.
      if (coreResults.indexOf(false) !== -1) {
        throw new Error('[sw] precache incomplete: one or more core assets failed');
      }

      // Optional extras: the declared list plus whatever icons the live
      // manifest actually references, deduped against everything above.
      return iconsFromManifest().then(function (iconUrls) {
        var extras = unique(absolutize(OPTIONAL_ASSETS).concat(iconUrls));
        return Promise.all(
          extras.map(function (url) {
            return precacheOne(cache, url);
          })
        );
      });
    });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(precacheAll());
});

/* ------------------------------------------------------------------ *
 *  activate — drop old versions, take control
 * ------------------------------------------------------------------ */

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            // Only ever delete OUR caches, and only stale versions of them.
            if (key.indexOf(CACHE_PREFIX) !== 0 || key === CACHE_NAME) return Promise.resolve(false);
            return caches.delete(key).catch(function () {
              return false;
            });
          })
        );
      })
      .catch(function () {
        /* a failed cleanup must never block activation */
      })
      .then(function () {
        return self.clients.claim();
      })
      .catch(function () {
        /* claim() failing must never leave us unactivated */
      })
  );
});

/* ------------------------------------------------------------------ *
 *  fetch
 * ------------------------------------------------------------------ */

/** How long to give the network before falling back to the cached shell. A
 * hung connect (congested cell, captive portal, stalled edge) can otherwise
 * leave `fetch()` neither resolved nor rejected for tens of seconds, during
 * which `respondWith()` has already committed the navigation to a blank
 * viewport even though a good copy of index.html is sitting in the cache. */
var NAVIGATE_TIMEOUT_MS = 2500;

/*
 * Last-resort offline page: shown only when even the cached index.html is
 * gone. It is deliberately BILINGUAL rather than localized. A service worker
 * is a classic worker with no ES-module import of src/core/locales/*.js and
 * no access to localStorage, so it cannot know which language the player
 * picked; guessing wrong on the one screen that explains what went wrong is
 * worse than showing both lines. Each line carries its own lang/dir so the
 * Hebrew renders RTL and the English LTR inside the same document.
 *
 * The two lines below are verbatim copies of the locale keys
 * `pwa.offlineTitle` / `pwa.offlineLine1` / `pwa.offlineLine2` in
 * src/core/locales/{he,en}.js. They drifted once already ("unavailable" vs the
 * key's "not available", a plural Hebrew imperative against the singular
 * register the rest of the game uses). Edit one, edit the other.
 */
function offlineFallbackPage() {
  return new Response(
    '<!DOCTYPE html><html><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Offline — לא זמין</title>' +
      '<body style="background:#150c26;color:#f4ecff;font-family:system-ui,sans-serif;' +
      'display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;' +
      'height:100vh;margin:0;text-align:center;padding:16px;box-sizing:border-box">' +
      '<p lang="he" dir="rtl" style="margin:0">המשחק אינו זמין במצב לא מקוון.<br>התחבר לרשת ונסה שוב.</p>' +
      '<p lang="en" dir="ltr" style="margin:0">The game is not available offline.<br>Reconnect to the network and try again.</p>' +
      '</body></html>',
    {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }
  );
}

/**
 * Navigation requests: race the network against a timeout, falling back to
 * the cached shell whichever way the network under-performs — a fast reject
 * (hard offline) OR a slow/hung connect (lie-fi, captive portal, stalled edge)
 * both reach the cache immediately instead of leaving the tab blank. A
 * healthy fast network still wins the race and is served (and re-cached)
 * normally, so a deployed update stays visible on every good connection.
 */
function handleNavigate(request) {
  var networkPromise = fetch(request)
    .then(function (response) {
      if (response && isCacheable(response)) {
        var copy = response.clone();
        var isShell = request.url === SHELL_URL || request.url === INDEX_URL;
        openCache().then(function (cache) {
          if (!cache) return;
          // Refresh the document under its own key, and mirror the shell into
          // BOTH shell keys so './' and './index.html' stay interchangeable.
          if (isShell) {
            safePut(cache, SHELL_URL, copy.clone());
            safePut(cache, INDEX_URL, copy.clone());
          }
          safePut(cache, request.url, copy);
        });
      }
      return response;
    })
    .catch(function () {
      return null;
    });

  function fromCache() {
    return caches
      .match(SHELL_URL)
      .then(function (hit) {
        return hit || caches.match(INDEX_URL);
      })
      .then(function (hit) {
        return hit || caches.match(request, { ignoreSearch: true });
      })
      .catch(function () {
        return null;
      });
  }

  var timeoutPromise = new Promise(function (resolve) {
    setTimeout(function () {
      resolve(null);
    }, NAVIGATE_TIMEOUT_MS);
  });

  return Promise.race([networkPromise, timeoutPromise]).then(function (winner) {
    if (winner) return winner;

    // Either the network already failed (fast reject, e.g. hard offline) or
    // it is still hanging past the timeout — either way, do not make the tab
    // wait any longer. Serve the cached shell now.
    return fromCache().then(function (hit) {
      if (hit) return hit;
      // No cache to fall back to: give the in-flight network request a
      // chance to still land (it may resolve after the timeout), then give
      // up and show the offline page.
      return networkPromise.then(function (response) {
        return response || offlineFallbackPage();
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 *  Change detection — "a deploy must not be invisible for a session"
 * ------------------------------------------------------------------ */

/**
 * A cheap identity for a response, built from whatever validators the server
 * sends. GitHub Pages sends ETag + Last-Modified; python's http.server (the
 * local harness) sends Last-Modified + Content-Length. Returns '' when the
 * server sends none of them, which is treated as "cannot tell" — never as
 * "changed", so a validator-less host degrades to today's silent behaviour
 * instead of nagging on every request.
 */
function fingerprint(response) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return '';
  var etag = response.headers.get('etag') || '';
  var modified = response.headers.get('last-modified') || '';
  var length = response.headers.get('content-length') || '';
  var out = etag + '|' + modified + '|' + length;
  return out === '||' ? '' : out;
}

/**
 * url -> the fingerprint we last announced for it. Keyed by fingerprint rather
 * than by url alone so that a SECOND deploy touching the same file, while this
 * worker instance is still alive, is announced too — a worker outlives the
 * page reload that follows "Refresh", so a plain "announced once" flag would
 * go quiet for the rest of the day.
 */
var announced = Object.create(null);

/** Tell every open page that a precached asset on disk no longer matches the
 *  bytes it is currently running. pwa.js turns this into the update bar. */
function notifyClients(url, version) {
  if (announced[url] === version) return;
  announced[url] = version;
  if (!self.clients || typeof self.clients.matchAll !== 'function') return;
  self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (list) {
      for (var i = 0; i < list.length; i++) {
        try {
          list[i].postMessage({ type: 'ASSET_UPDATED', url: url, version: VERSION });
        } catch (err) {
          /* that client went away */
        }
      }
    })
    .catch(function () {
      /* matchAll is best-effort */
    });
}

/**
 * Kick off a background refresh of an asset. Fire-and-forget, never throws.
 * When the fresh copy differs from the one we just served, the new bytes go
 * into the cache (so the very next load runs them) AND the pages that are
 * running the old bytes are told, instead of finding out a session later.
 * @param {Response|null} cached the copy that was served from the cache.
 */
function revalidate(cache, request, cached) {
  var before = fingerprint(cached);
  fetch(request)
    .then(function (response) {
      if (!isCacheable(response)) return;
      var after = fingerprint(response);
      safePut(cache, request, response.clone());
      // Both fingerprints must be readable before a mismatch means anything.
      if (before && after && before !== after) notifyClients(request.url, after);
    })
    .catch(function () {
      /* offline: the cached copy we already served stays valid */
    });
}

/** Guard so an explicit CHECK_UPDATES sweep can never pile up on itself. */
var sweepInFlight = false;
var lastSweepAt = 0;
var SWEEP_MIN_INTERVAL_MS = 60000;

/**
 * Re-check every core asset on demand. A running page never re-requests its
 * own modules, so without this a deploy landing mid-session is only noticed on
 * the next launch; pwa.js posts CHECK_UPDATES when the tab is brought back to
 * the foreground. Throttled, and each changed url still announces at most once.
 */
function sweepCoreAssets() {
  var now = Date.now();
  if (sweepInFlight || now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return Promise.resolve();
  sweepInFlight = true;
  lastSweepAt = now;
  return openCache()
    .then(function (cache) {
      if (!cache) return null;
      var urls = absolutize(CORE_ASSETS);
      return Promise.all(
        urls.map(function (url) {
          var request = new Request(url, { credentials: 'same-origin' });
          return safeMatch(cache, request).then(function (cached) {
            if (!cached) return false;
            return revalidate(cache, request, cached);
          });
        })
      );
    })
    .catch(function () {
      /* a failed sweep is a no-op, never an error the page sees */
    })
    .then(function () {
      sweepInFlight = false;
    });
}

/**
 * Static same-origin assets: cache-first (instant, works offline) with a
 * background revalidate so the next load picks up a redeploy — and so the
 * CURRENT load is told that it is already out of date.
 */
function handleAsset(request) {
  return openCache().then(function (cache) {
    return safeMatch(cache, request).then(function (cached) {
      if (cached) {
        revalidate(cache, request, cached);
        return cached;
      }
      return fetch(request)
        .then(function (response) {
          if (isCacheable(response)) safePut(cache, request, response.clone());
          return response;
        })
        .catch(function () {
          // Last resort: ignore the query string (cache-busting suffixes).
          return caches
            .match(request, { ignoreSearch: true })
            .catch(function () {
              return null;
            })
            .then(function (hit) {
              return hit || new Response('', { status: 504, statusText: 'Offline' });
            });
        });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;

  // Never touch non-GET (no POST/PUT caching, ever).
  if (!request || request.method !== 'GET') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return; // unparseable: let the browser handle it
  }

  // Never touch cross-origin, and never touch non-http(s) schemes
  // (chrome-extension:, blob:, data:, ...).
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Range requests (media seeking) must reach the network untouched.
  if (request.headers && request.headers.has('range')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
    return;
  }

  // Only assets inside our own directory — a sibling app on the same GH Pages
  // origin is none of our business.
  if (!isInScope(url)) return;

  event.respondWith(handleAsset(request));
});

/* ------------------------------------------------------------------ *
 *  message — activate a waiting update on demand
 * ------------------------------------------------------------------ */

self.addEventListener('message', function (event) {
  var data = event ? event.data : null;
  var type = typeof data === 'string' ? data : data && data.type;

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // Asked by pwa.js when the tab comes back to the foreground: re-check the
  // precached shell against the server so a deploy that landed mid-session is
  // announced now rather than at the next cold launch.
  if (type === 'CHECK_UPDATES') {
    if (event && typeof event.waitUntil === 'function') event.waitUntil(sweepCoreAssets());
    else sweepCoreAssets();
    return;
  }

  if (type === 'GET_VERSION' && event.source && event.source.postMessage) {
    try {
      event.source.postMessage({ type: 'VERSION', version: VERSION, cache: CACHE_NAME });
    } catch (err) {
      /* the client went away */
    }
  }
});
