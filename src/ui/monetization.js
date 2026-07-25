/**
 * monetization.js — Simulated rewarded ads and IAP shop.
 *
 * Spec section 8: Rewarded ads double offline earnings, grant diamonds,
 * start boosters. IAP shop: diamond packs, no-ads one-time purchase,
 * diamond spending options (skip cooldown, instant cash, mega boost).
 *
 * NO actual payments or external network calls — all simulated.
 */

import { CONFIG } from '../core/config.js';
import { bus, toast } from '../core/events.js';
import { state, save, multiplyOfflineReward } from '../core/state.js';
import { addMoney, incomeRate, fmtMoney } from '../core/economy.js';

/* ================================================================
 *  Module State
 * ================================================================ */

let root = null;
let modalContainer = null;
let adModal = null;
let adBackdrop = null;
let shopModal = null;
let shopBackdrop = null;
let adTimerInterval = null;
let adCountdown = 3;
let lastAdTime = 0;
let offlineReportBuffer = null;

// Cooldown for the high-value diamond spends (instant cash / mega boost).
// Without this, free ad-diamonds (CONFIG.monetization.adDiamonds, no per-day cap)
// can be laundered into an unlimited stream of instantCash/megaBoost redemptions,
// each worth a large lump sum of simulated income. This mirrors the pattern used
// by CONFIG.minigames.cooldownMs / state.cooldowns for roulette & blackjack, but
// is tracked in-memory here (like the ad cooldown above) since state.js's
// migrate() only round-trips the roulette/blackjack cooldown keys and would
// silently drop any new persisted keys on reload.
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

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'צפיה בפרסומת';
  modal.appendChild(title);

  const label = document.createElement('div');
  label.className = 'ad-label';
  label.textContent = 'סיים את הצפיה וקבל גמול!';
  modal.appendChild(label);

  const countdown = document.createElement('div');
  countdown.className = 'ad-countdown';
  countdown.textContent = String(adCountdown);
  modal.appendChild(countdown);

  const skipButton = document.createElement('button');
  skipButton.className = 'ad-skip-button';
  skipButton.textContent = 'דלג';
  modal.appendChild(skipButton);

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
  };

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

function completeAd() {
  lastAdTime = Date.now();

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

  toast('🎬 קיבלת בונוס פרסומת! +' + CONFIG.monetization.adDiamonds + ' יהלומים ו-2x הכנסה', 'good');
  save();
}

/* ================================================================
 *  IAP Shop Logic
 * ================================================================ */

function showShop() {
  closeShop();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'חנות יהלומים';
  modal.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '×';
  modal.appendChild(closeBtn);

  const content = document.createElement('div');
  content.className = 'shop-container';

  // --- Diamond Packs Section ---
  const diamondSection = document.createElement('div');

  const diamondTitle = document.createElement('div');
  diamondTitle.className = 'shop-section-title';
  diamondTitle.textContent = 'קניית יהלומים';
  diamondSection.appendChild(diamondTitle);

  const diamondGrid = document.createElement('div');
  diamondGrid.className = 'shop-grid';

  for (const pack of CONFIG.monetization.diamondPacks) {
    const item = document.createElement('button');
    item.className = 'shop-item';

    const name = document.createElement('div');
    name.className = 'shop-item-name';
    name.textContent = pack.name;
    item.appendChild(name);

    const amount = document.createElement('div');
    amount.className = 'shop-item-amount';
    amount.textContent = '💎 ' + pack.amount;
    item.appendChild(amount);

    const price = document.createElement('div');
    price.className = 'shop-item-price';
    price.textContent = pack.price;
    item.appendChild(price);

    item.addEventListener('click', () => {
      purchaseDiamonds(pack.amount, pack.name);
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
    noAdsTitle.textContent = 'הנחות מיוחדות';
    noAdsSection.appendChild(noAdsTitle);

    const noAdsGrid = document.createElement('div');
    noAdsGrid.className = 'shop-grid';

    const noAdsItem = document.createElement('button');
    noAdsItem.className = 'shop-item';

    const noAdsName = document.createElement('div');
    noAdsName.className = 'shop-item-name';
    noAdsName.textContent = 'ללא פרסומות';
    noAdsItem.appendChild(noAdsName);

    const noAdsDesc = document.createElement('div');
    noAdsDesc.className = 'shop-item-amount';
    noAdsDesc.textContent = '🚫📺 חד-פעמי';
    noAdsItem.appendChild(noAdsDesc);

    const noAdsPrice = document.createElement('div');
    noAdsPrice.className = 'shop-item-price';
    noAdsPrice.textContent = CONFIG.monetization.noAdsPrice;
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
  spendTitle.textContent = 'הוצאת יהלומים';
  spendSection.appendChild(spendTitle);

  const spendGrid = document.createElement('div');
  spendGrid.className = 'shop-grid';

  for (const spend of CONFIG.monetization.diamondSpends) {
    const cooldownRemaining = getSpendCooldownRemaining(spend.key);
    const onCooldown = cooldownRemaining > 0;
    const canAfford = state.diamonds >= spend.cost && !onCooldown;

    const item = document.createElement('button');
    item.className = 'shop-item';
    item.disabled = !canAfford;

    const name = document.createElement('div');
    name.className = 'shop-item-name';
    name.textContent = spend.name;
    item.appendChild(name);

    const cost = document.createElement('div');
    cost.className = 'shop-item-price';
    cost.textContent = '💎 ' + spend.cost;
    item.appendChild(cost);

    if (onCooldown) {
      const cd = document.createElement('div');
      cd.className = 'shop-item-amount';
      cd.textContent = 'זמין שוב בעוד ' + Math.ceil(cooldownRemaining / 60000) + ' דק׳';
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
}

function purchaseDiamonds(amount, name) {
  state.diamonds += amount;
  bus.emit('diamonds:changed', { diamonds: state.diamonds });
  toast('✓ קנית ' + name + ' (' + amount + ' יהלומים)', 'good');
  save();
  // Refresh shop to disable items if needed
  showShop();
}

function purchaseNoAds() {
  state.noAds = true;
  bus.emit('toast', { text: '✓ פרסומות הופסקו! תודה על התמיכה.', kind: 'good' });
  save();
  // Close and reopen the shop so the no-ads section disappears.
  showShop();
}

function spendDiamonds(key, cost, spend) {
  if (state.diamonds < cost) {
    toast('יהלומים לא מספיקים', 'bad');
    return;
  }

  const cooldownRemaining = getSpendCooldownRemaining(key);
  if (cooldownRemaining > 0) {
    toast('פעולה זו זמינה שוב בעוד ' + Math.ceil(cooldownRemaining / 60000) + ' דקות', 'info');
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
    toast('✓ זמני הצינון אופסו', 'good');
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
      toast('✓ קיבלת ' + fmtMoney(cashAmount) + ' מזומן', 'good');
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
    toast('✓ בוסטר ×5 הופעל ל-10 דקות', 'good');
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

  lastAdTime = 0;
  adCountdown = 3;
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
    toast('יש לך את ההנחה "ללא פרסומות"', 'info');
    return false;
  }

  if (!canWatchAd()) {
    const remaining = Math.ceil(getAdCooldownRemaining() / 1000);
    toast('צפיה בפרסומת זמינה ב-' + remaining + ' שניות', 'info');
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
