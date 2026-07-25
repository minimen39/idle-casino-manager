/**
 * monetization.js — Simulated rewarded ads and IAP shop.
 *
 * Spec section 8: Rewarded ads double offline earnings, grant diamonds,
 * start boosters. IAP shop: diamond packs, no-ads one-time purchase,
 * diamond spending options (skip cooldown, instant cash, mega boost).
 *
 * NO actual payments or external network calls — all simulated.
 */

import { CONFIG, priceSetFor } from '../core/config.js';
import { bus, toast } from '../core/events.js';
import { state, save, multiplyOfflineReward } from '../core/state.js';
import { addMoney, incomeRate, fmtMoney } from '../core/economy.js';
import { t, getLocale, onLocaleChanged } from '../core/i18n.js';

/* ================================================================
 *  Module State
 * ================================================================ */

let root = null;
let modalContainer = null;
let adModal = null;
let adBackdrop = null;
let shopModal = null;
let shopBackdrop = null;
/** The scrolling `.shop-container` of the open shop, kept so a rebuild can
 *  restore where the player was (see showShop()). */
let shopContentEl = null;
let adTimerInterval = null;
let adCountdown = 3;
let lastAdTime = 0;
let offlineReportBuffer = null;
let localeUnsubscribe = null;

// Elements of the currently-open ad modal, kept around so a 'locale:changed'
// event can retext it in place without disturbing the running countdown.
let adTitleEl = null;
let adLabelEl = null;
let adSkipEl = null;
let adCloseEl = null;

/**
 * localStorage key for the rewarded-ad cooldown. Persisted directly (like
 * i18n.js does for the language choice) rather than through state.js: this
 * module deliberately does not touch state.js's migrate(), which only
 * round-trips the roulette/blackjack cooldown keys and would silently drop
 * a new one on reload — see the SPEND_COOLDOWN_MS comment below for the same
 * reasoning applied to the diamond-spend cooldowns.
 */
const AD_COOLDOWN_STORAGE_KEY = 'idleCasino.monetization.lastAdTime';

function storageSafe(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return fallback;
  }
}

/** Symbols for the plain-text fallback below, when Intl is unavailable. */
const CURRENCY_FALLBACK_SYMBOL = { ILS: '₪', USD: '$' };

/**
 * The real-money price set for the CURRENT language: shekels for Hebrew,
 * dollars for English (CONFIG.monetization.localeCurrency).
 *
 * Read fresh on every render rather than cached at module load, which is what
 * makes the live language switch re-price the shop: onLocaleChanged() in
 * mount() rebuilds the open shop, and that rebuild picks up the other set.
 * The amounts still never come from the locale TABLES — a price is a property
 * of the product in a market, not a translatable string.
 */
function prices() {
  return priceSetFor(getLocale());
}

/**
 * Render an IAP price.
 *
 * Both the amount and the currency come from CONFIG.monetization.pricing via
 * prices() above; only the *presentation* (digit shapes, symbol placement) is
 * Intl's job. `-u-nu-latn` pins Western digits — Hebrew reads prices in them —
 * and a failing/unsupported Intl falls back to a plain "9.90 ₪" / "1.99 $"
 * shaped string rather than leaving the button blank.
 *
 * @param {number} minor price in minor units (agorot / cents)
 * @param {string} currency ISO code the amount is denominated in
 * @returns {string}
 */
function fmtPrice(minor, currency) {
  const cents = Number(minor);
  if (!Number.isFinite(cents) || cents < 0) return '';
  const units = cents / 100;
  const code = currency || CONFIG.monetization.defaultCurrency;
  return storageSafe(
    () =>
      new Intl.NumberFormat(getLocale() + '-u-nu-latn', {
        style: 'currency',
        currency: code,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(units),
    units.toFixed(2) + ' ' + (CURRENCY_FALLBACK_SYMBOL[code] || code)
  );
}

/** Restore the last-ad timestamp so a page reload cannot grant a free ad. */
function readStoredLastAdTime() {
  const raw = storageSafe(() => {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(AD_COOLDOWN_STORAGE_KEY);
  }, null);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function writeStoredLastAdTime(ts) {
  storageSafe(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(AD_COOLDOWN_STORAGE_KEY, String(ts));
  });
}

// Cooldown for the high-value diamond spends (instant cash / mega boost).
// Without this, free ad-diamonds (CONFIG.monetization.adDiamonds, no per-day cap)
// can be laundered into an unlimited stream of instantCash/megaBoost redemptions,
// each worth a large lump sum of simulated income. This mirrors the pattern used
// by CONFIG.minigames.cooldownMs / state.cooldowns for roulette & blackjack, but
// is tracked in-memory only (unlike the ad cooldown above, which is persisted to
// localStorage) since state.js's migrate() only round-trips the roulette/blackjack
// cooldown keys and would silently drop any new persisted keys on reload. A reload
// during this cooldown resets it early — a much smaller exposure than the ad
// cooldown bug (a free ad each reload), so it is left as a known follow-up rather
// than widened beyond this module's assigned fix.
const SPEND_COOLDOWN_MS = {
  instantCash: 1800000, // 30 minutes
  megaBoost: 1800000    // 30 minutes
};
let lastInstantCashTime = 0;
let lastMegaBoostTime = 0;

/* ================================================================
 *  Rewarded Ad Logic
 * ================================================================ */

/** Resolve (or create) the shared #modals host. Never returns null in a browser. */
function ensureContainer() {
  if (modalContainer && modalContainer.appendChild) return modalContainer;
  modalContainer = document.getElementById('modals');
  if (!modalContainer) {
    modalContainer = document.createElement('div');
    modalContainer.id = 'modals';
    modalContainer.className = 'modals';
    const layer = document.getElementById('ui-layer');
    if (layer && layer.appendChild) layer.appendChild(modalContainer);
    else if (root && root.appendChild) root.appendChild(modalContainer);
    else document.body.appendChild(modalContainer);
  }
  return modalContainer;
}

function closeShop() {
  if (shopBackdrop && shopBackdrop.parentNode) shopBackdrop.parentNode.removeChild(shopBackdrop);
  shopBackdrop = null;
  shopModal = null;
  shopContentEl = null;
}

/**
 * Every purchase/spend re-runs showShop(), which tears the modal down and
 * builds a brand new one — so the player's scroll position was thrown away and
 * they were snapped back to the diamond packs at the top, mid-list. Whichever
 * of the two boxes actually scrolls (styles.css owns that choice), read it
 * before the teardown and put it back after the rebuild.
 */
function readShopScroll() {
  const modalTop = shopModal && Number(shopModal.scrollTop);
  const contentTop = shopContentEl && Number(shopContentEl.scrollTop);
  return {
    modal: Number.isFinite(modalTop) ? modalTop : 0,
    content: Number.isFinite(contentTop) ? contentTop : 0
  };
}

function restoreShopScroll(prev) {
  if (!prev) return;
  try {
    if (shopModal && prev.modal > 0) shopModal.scrollTop = prev.modal;
    if (shopContentEl && prev.content > 0) shopContentEl.scrollTop = prev.content;
  } catch (err) {
    // a detached node must never break the shop
  }
}

function canWatchAd() {
  const now = Date.now();
  return now - lastAdTime >= CONFIG.monetization.adCooldownMs;
}

function getAdCooldownRemaining() {
  const now = Date.now();
  const remaining = CONFIG.monetization.adCooldownMs - (now - lastAdTime);
  return Math.max(0, remaining);
}

/** Remaining ms before a rate-limited diamond spend (instantCash/megaBoost) can be used again. */
function getSpendCooldownRemaining(key) {
  const cooldownMs = SPEND_COOLDOWN_MS[key];
  if (!cooldownMs) return 0;
  const last = key === 'instantCash' ? lastInstantCashTime : key === 'megaBoost' ? lastMegaBoostTime : 0;
  return Math.max(0, cooldownMs - (Date.now() - last));
}

function showAdModal(offlineReport) {
  // Store the offline report to use on successful ad watch
  offlineReportBuffer = offlineReport;

  if (adBackdrop && adBackdrop.parentNode) adBackdrop.parentNode.removeChild(adBackdrop);
  adBackdrop = null;
  adModal = null;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal ad-modal';

  // Bug fix: the modal previously had NO way to close it during the opening
  // countdown (only the post-countdown "skip" button, or a backdrop click
  // that was itself gated on the countdown being done). A real close button,
  // available from the first frame, means the player is never trapped in the
  // modal — it abandons the ad (no reward, no report mutation) rather than
  // completing it.
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'modal-close';
  closeButton.textContent = '×';
  closeButton.title = t('common.close');
  closeButton.setAttribute('aria-label', t('common.close'));
  modal.appendChild(closeButton);

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = t('ad.title');
  modal.appendChild(title);

  const label = document.createElement('div');
  label.className = 'ad-label';
  label.textContent = t('ad.label');
  modal.appendChild(label);

  const countdown = document.createElement('div');
  countdown.className = 'ad-countdown';
  countdown.textContent = String(adCountdown);
  modal.appendChild(countdown);

  const skipButton = document.createElement('button');
  skipButton.className = 'ad-skip-button';
  skipButton.textContent = t('ad.skip');
  modal.appendChild(skipButton);

  adTitleEl = title;
  adLabelEl = label;
  adSkipEl = skipButton;
  adCloseEl = closeButton;

  let localCountdown = adCountdown;
  adTimerInterval = setInterval(() => {
    localCountdown--;
    countdown.textContent = String(localCountdown);

    if (localCountdown <= 0) {
      clearInterval(adTimerInterval);
      adTimerInterval = null;
      skipButton.classList.add('visible');
    }
  }, 1000);

  const closeAd = () => {
    if (adTimerInterval) {
      clearInterval(adTimerInterval);
      adTimerInterval = null;
    }
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    adModal = null;
    adBackdrop = null;
    offlineReportBuffer = null;
    adTitleEl = null;
    adLabelEl = null;
    adSkipEl = null;
    adCloseEl = null;
  };

  // Abandon: closes without granting the reward, at any point in the flow.
  closeButton.addEventListener('click', () => {
    closeAd();
  });

  skipButton.addEventListener('click', () => {
    completeAd();
    closeAd();
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && skipButton.classList.contains('visible')) {
      completeAd();
      closeAd();
    }
  });

  backdrop.appendChild(modal);
  ensureContainer().appendChild(backdrop);

  adModal = modal;
  adBackdrop = backdrop;
}

/** Re-apply the active locale's strings to an already-open ad modal in place. */
function retextAdModal() {
  if (!adModal) return;
  if (adTitleEl) adTitleEl.textContent = t('ad.title');
  if (adLabelEl) adLabelEl.textContent = t('ad.label');
  if (adSkipEl) adSkipEl.textContent = t('ad.skip');
  if (adCloseEl) {
    adCloseEl.title = t('common.close');
    adCloseEl.setAttribute('aria-label', t('common.close'));
  }
}

function completeAd() {
  lastAdTime = Date.now();
  writeStoredLastAdTime(lastAdTime);

  // Double the offline earnings if we have a report.
  // state.multiplyOfflineReward is the single authority for this: it credits
  // each world, updates BOTH `entry.amount` and `report.total`, and emits
  // 'money:changed'. main.js's offline modal redraws its per-world rows from
  // `entry.amount`, so mutating only `total` here would leave the rows and the
  // total disagreeing (and main.js's own no-ad fallback path already calls
  // this same function).
  if (offlineReportBuffer) {
    try {
      multiplyOfflineReward(offlineReportBuffer, CONFIG.offline.adMultiplier);
    } catch (err) {
      /* never let the reward wiring break the rest of the ad payout */
    }
  }

  // Grant diamonds
  state.diamonds += CONFIG.monetization.adDiamonds;
  bus.emit('diamonds:changed', { diamonds: state.diamonds });

  // Start income booster
  const boost = CONFIG.monetization.adBoost;
  state.boosts.income.mult = boost.mult;
  state.boosts.income.until = Date.now() + boost.seconds * 1000;
  bus.emit('boost:started', { kind: 'income', mult: boost.mult, seconds: boost.seconds });

  toast(t('ad.reward', { amount: CONFIG.monetization.adDiamonds }), 'good');
  save();
}

/* ================================================================
 *  IAP Shop Logic
 * ================================================================ */

function showShop() {
  const prevScroll = readShopScroll();
  closeShop();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = t('shop.title');
  modal.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '×';
  closeBtn.title = t('common.close');
  closeBtn.setAttribute('aria-label', t('common.close'));
  modal.appendChild(closeBtn);

  const content = document.createElement('div');
  content.className = 'shop-container';

  // --- Diamond Packs Section ---
  const diamondSection = document.createElement('div');

  const diamondTitle = document.createElement('div');
  diamondTitle.className = 'shop-section-title';
  diamondTitle.textContent = t('shop.section.packs');
  diamondSection.appendChild(diamondTitle);

  const diamondGrid = document.createElement('div');
  diamondGrid.className = 'shop-grid';

  // One price set for the whole shop, so every tag in this render is in the
  // same currency even if the language changed mid-build.
  const priceSet = prices();

  for (const pack of CONFIG.monetization.diamondPacks) {
    // The NAME comes from the locale table (keyed by pack.key); the PRICE comes
    // from CONFIG's price set for the active language — see fmtPrice().
    const packName = t('shop.pack.' + pack.key);
    const packPrice = fmtPrice(priceSet.packs[pack.key], priceSet.currency);

    const item = document.createElement('button');
    item.className = 'shop-item';

    const name = document.createElement('div');
    name.className = 'shop-item-name';
    name.textContent = packName;
    item.appendChild(name);

    const amount = document.createElement('div');
    amount.className = 'shop-item-amount';
    amount.textContent = '💎 ' + pack.amount;
    item.appendChild(amount);

    const price = document.createElement('div');
    price.className = 'shop-item-price';
    price.textContent = packPrice;
    item.appendChild(price);

    item.addEventListener('click', () => {
      purchaseDiamonds(pack.amount, packName);
    });

    diamondGrid.appendChild(item);
  }

  diamondSection.appendChild(diamondGrid);
  content.appendChild(diamondSection);

  // --- No-Ads Package Section ---
  if (!state.noAds) {
    const noAdsSection = document.createElement('div');

    const noAdsTitle = document.createElement('div');
    noAdsTitle.className = 'shop-section-title';
    noAdsTitle.textContent = t('shop.section.specials');
    noAdsSection.appendChild(noAdsTitle);

    const noAdsGrid = document.createElement('div');
    noAdsGrid.className = 'shop-grid';

    const noAdsItem = document.createElement('button');
    noAdsItem.className = 'shop-item';

    const noAdsName = document.createElement('div');
    noAdsName.className = 'shop-item-name';
    noAdsName.textContent = t('shop.noAds');
    noAdsItem.appendChild(noAdsName);

    const noAdsDesc = document.createElement('div');
    noAdsDesc.className = 'shop-item-amount';
    noAdsDesc.textContent = t('shop.noAdsTag');
    noAdsItem.appendChild(noAdsDesc);

    const noAdsPrice = document.createElement('div');
    noAdsPrice.className = 'shop-item-price';
    noAdsPrice.textContent = fmtPrice(priceSet.noAds, priceSet.currency);
    noAdsItem.appendChild(noAdsPrice);

    noAdsItem.addEventListener('click', () => {
      purchaseNoAds();
    });

    noAdsGrid.appendChild(noAdsItem);
    noAdsSection.appendChild(noAdsGrid);
    content.appendChild(noAdsSection);
  }

  // --- Diamond Spends Section ---
  const spendSection = document.createElement('div');

  const spendTitle = document.createElement('div');
  spendTitle.className = 'shop-section-title';
  spendTitle.textContent = t('shop.section.spend');
  spendSection.appendChild(spendTitle);

  const spendGrid = document.createElement('div');
  spendGrid.className = 'shop-grid';

  for (const spend of CONFIG.monetization.diamondSpends) {
    const cooldownRemaining = getSpendCooldownRemaining(spend.key);
    const onCooldown = cooldownRemaining > 0;
    const canAfford = state.diamonds >= spend.cost && !onCooldown;
    // Name comes from the locale table (keyed by spend.key) rather than
    // config.js's Hebrew-only `name` field — see the diamondPacks loop above.
    const spendName = t('shop.spend.' + spend.key);

    const item = document.createElement('button');
    item.className = 'shop-item';
    item.disabled = !canAfford;

    const name = document.createElement('div');
    name.className = 'shop-item-name';
    name.textContent = spendName;
    item.appendChild(name);

    const cost = document.createElement('div');
    cost.className = 'shop-item-price';
    cost.textContent = '💎 ' + spend.cost;
    item.appendChild(cost);

    if (onCooldown) {
      const cd = document.createElement('div');
      cd.className = 'shop-item-amount';
      cd.textContent = t('shop.itemCooldown', { minutes: Math.ceil(cooldownRemaining / 60000) });
      item.appendChild(cd);
    }

    item.addEventListener('click', () => {
      if (canAfford) {
        spendDiamonds(spend.key, spend.cost, spend);
      }
    });

    spendGrid.appendChild(item);
  }

  spendSection.appendChild(spendGrid);
  content.appendChild(spendSection);

  modal.appendChild(content);

  closeBtn.addEventListener('click', closeShop);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeShop();
  });

  backdrop.appendChild(modal);
  ensureContainer().appendChild(backdrop);

  shopModal = modal;
  shopBackdrop = backdrop;
  shopContentEl = content;
  restoreShopScroll(prevScroll);
}

function purchaseDiamonds(amount, name) {
  state.diamonds += amount;
  bus.emit('diamonds:changed', { diamonds: state.diamonds });
  toast(t('shop.bought', { name, amount }), 'good');
  save();
  // Refresh shop to disable items if needed
  showShop();
}

function purchaseNoAds() {
  state.noAds = true;
  bus.emit('toast', { text: t('shop.noAdsDone'), kind: 'good' });
  save();
  // Close and reopen the shop so the no-ads section disappears.
  showShop();
}

function spendDiamonds(key, cost, spend) {
  if (state.diamonds < cost) {
    toast(t('shop.notEnough'), 'bad');
    return;
  }

  const cooldownRemaining = getSpendCooldownRemaining(key);
  if (cooldownRemaining > 0) {
    toast(t('shop.spendCooldown', { minutes: Math.ceil(cooldownRemaining / 60000) }), 'info');
    return;
  }

  state.diamonds -= cost;
  bus.emit('diamonds:changed', { diamonds: state.diamonds });

  if (key === 'skipCooldown') {
    // Clear both mini-game cooldowns so the player can play immediately.
    if (!state.cooldowns) state.cooldowns = { roulette: 0, blackjack: 0 };
    state.cooldowns.roulette = 0;
    state.cooldowns.blackjack = 0;
    bus.emit('ui:refresh', {});
    toast(t('shop.cooldownReset'), 'good');
  } else if (key === 'instantCash') {
    // Grant `spend.seconds` worth of the active branch's real income rate.
    const w = state.worlds[state.activeWorld];
    if (w) {
      let rate = 0;
      try {
        rate = incomeRate(w);
      } catch (err) {
        rate = 0;
      }
      const seconds = Math.max(0, Number(spend.seconds) || 0);
      const cashAmount = Math.max(1, Math.floor((Number(rate) || 0) * seconds));
      addMoney(w, cashAmount);
      toast(t('shop.gotCash', { amount: fmtMoney(cashAmount) }), 'good');
    }
    lastInstantCashTime = Date.now();
  } else if (key === 'megaBoost') {
    // 5x income boost for 10 minutes
    state.boosts.income.mult = spend.mult;
    state.boosts.income.until = Date.now() + spend.seconds * 1000;
    bus.emit('boost:started', {
      kind: 'income',
      mult: spend.mult,
      seconds: spend.seconds
    });
    toast(t('shop.megaBoostOn'), 'good');
    lastMegaBoostTime = Date.now();
  }

  save();
  showShop();
}

/* ================================================================
 *  Public API
 * ================================================================ */

export function mount(mountRoot) {
  root = mountRoot;
  if (!root) return;

  // Find or create the modals container
  modalContainer = document.getElementById('modals');
  if (!modalContainer) {
    modalContainer = document.createElement('div');
    modalContainer.id = 'modals';
    modalContainer.className = 'modals';
    const layer = document.getElementById('ui-layer');
    if (layer && layer.appendChild) layer.appendChild(modalContainer);
    else if (root && root.appendChild) root.appendChild(modalContainer);
    else document.body.appendChild(modalContainer);
  }

  // Listen for ad button clicks from other UI (expected to come via custom events)
  // This module should be called externally when the player wants to watch an ad
  // For now, we just initialize state.

  // Bug fix: this used to hard-reset to 0 on every mount, so reloading the
  // page always granted a fresh ad regardless of when the last one was
  // watched. Restore the persisted timestamp instead (see
  // AD_COOLDOWN_STORAGE_KEY above), mirroring how the mini-game cooldowns
  // survive a reload via state.cooldowns.
  lastAdTime = readStoredLastAdTime();
  adCountdown = 3;

  if (!localeUnsubscribe) {
    localeUnsubscribe = onLocaleChanged(() => {
      retextAdModal();
      if (shopModal) showShop();
    });
  }
}

export function update() {
  // Called each frame; no ongoing state to update in this module.
  // UI refresh happens via event listeners.
}

/**
 * Public methods for external triggers
 */

export function openShop() {
  showShop();
}

export function tryWatchAd(offlineReport) {
  if (state.noAds) {
    toast(t('ad.noAdsOwned'), 'info');
    return false;
  }

  if (!canWatchAd()) {
    const remaining = Math.ceil(getAdCooldownRemaining() / 1000);
    toast(t('ad.cooldown', { seconds: remaining }), 'info');
    return false;
  }

  showAdModal(offlineReport);
  return true;
}

export function isAdOnCooldown() {
  return !canWatchAd();
}

export function getAdCooldownSeconds() {
  return Math.ceil(getAdCooldownRemaining() / 1000);
}

export default {
  mount,
  update,
  openShop,
  tryWatchAd,
  isAdOnCooldown,
  getAdCooldownSeconds
};
