/**
 * minigames.js — Roulette (High-Roller Roulette) and Blackjack (Dealer
 * Challenge) mini-games, spec section 6. Each has its own 15-minute
 * cooldown persisted in state.cooldowns, compared against the wall clock
 * so it survives reload.
 *
 * Follows the conventions already established by monetization.js: reuses
 * the site-wide .modal-backdrop / .modal / .card / button classes from
 * styles.css instead of a private stylesheet, and shares the #modals
 * container.
 *
 * export function mount(root)
 * export function update()
 * export function openRoulette()    -- integrator hook
 * export function openBlackjack()   -- integrator hook
 */

import { bus, toast } from '../core/events.js';
import { state, activeWorld, save } from '../core/state.js';
import { CONFIG } from '../core/config.js';
import { addMoney, addDiamonds, incomeRate, fmtMoney, fmtTime } from '../core/economy.js';
import { t, onLocaleChanged } from '../core/i18n.js';

/* ------------------------------------------------------------------ *
 *  Shared module state
 * ------------------------------------------------------------------ */

let root = null;
let modalContainer = null;
/** Guards mount() against double-subscribing the bus (see mount()). */
let mounted = false;

/* ------------------------------------------------------------------ *
 *  Cooldown helpers (state.cooldowns.roulette / state.cooldowns.blackjack)
 * ------------------------------------------------------------------ */

function remainingCooldownMs(key) {
  const until = (state.cooldowns && Number(state.cooldowns[key])) || 0;
  return Math.max(0, until - Date.now());
}

function isOnCooldown(key) {
  return remainingCooldownMs(key) > 0;
}

function startCooldown(key) {
  if (!state.cooldowns) state.cooldowns = { roulette: 0, blackjack: 0 };
  state.cooldowns[key] = Date.now() + CONFIG.minigames.cooldownMs;
  save();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function ensureModalContainer() {
  modalContainer = document.getElementById('modals');
  if (!modalContainer) {
    modalContainer = document.createElement('div');
    modalContainer.id = 'modals';
    modalContainer.className = 'modals';
    const layer = document.getElementById('ui-layer');
    if (layer && layer.appendChild) layer.appendChild(modalContainer);
    else if (root && root.appendChild) root.appendChild(modalContainer);
  }
}

/* ------------------------------------------------------------------ *
 *  ROULETTE
 * ------------------------------------------------------------------ *
 * The pocket order and color mapping below are the fixed rules of a
 * standard European roulette wheel (a game constant, not a tunable
 * balance number) — bet types/names/payouts all come from
 * CONFIG.minigames.roulette.bets, unmodified.
 */

const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
  24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26
];
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

function numberColor(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}
function numberParity(n) {
  return n === 0 ? null : (n % 2 === 0 ? 'even' : 'odd');
}
function numberDozen(n) {
  return n === 0 ? 0 : Math.ceil(n / 12);
}
function colorLabel(c) {
  if (c === 'red') return t('mini.roulette.color.red');
  if (c === 'black') return t('mini.roulette.color.black');
  return t('mini.roulette.color.green');
}

let rl = null; // transient roulette round state, rebuilt each modal open
let rlBackdrop = null;
let rlBody = null;
let rlCanvas = null;
let rlCooldownTimer = null;
let rlRaf = null; // in-flight requestAnimationFrame handle for the spin animation
let rlTitleEl = null;

/**
 * Reward rebalance (see report): the flat income-boost reward used to pay
 * ~2x the expected value of the cash reward for the same win, because
 * boostSeconds was a single constant regardless of which bet's payout
 * multiplier actually won. The boost's duration is scaled so its EV tracks
 * the *actual* cash payout (`cashPayout`), not an assumption about what the
 * bet amount would have been before clamping to [betMin, betMax]. Derivation:
 *   cashEV   = cashPayout            (already amount * def.payout, clamped)
 *   boostEV  = incomeRate * (boostMult - 1) * seconds
 *   solve boostEV = cashEV for `seconds`:
 *     seconds = cashPayout / (incomeRate * (boostMult - 1))
 * When incomeRate is ~0 the boost has no EV at any duration (there's no
 * income to multiply), so fall back to the base bet window as a neutral,
 * cash-favoring duration rather than dividing by ~0.
 */
function boostSecondsForPayout(cashPayout, rate) {
  const cfg = CONFIG.minigames.roulette;
  const denom = Math.max(0.01, (Number(cfg.boostMult) || 1) - 1);
  const incomeRateNum = Number(rate) || 0;
  if (incomeRateNum <= 0) {
    return Math.max(15, Math.round(Number(cfg.betSeconds) || 0));
  }
  const seconds = (Number(cashPayout) || 0) / (incomeRateNum * denom);
  return Math.max(15, Math.round(seconds));
}

function computeRouletteBet() {
  const cfg = CONFIG.minigames.roulette;
  const w = activeWorld();
  let rate = 0;
  try {
    rate = incomeRate(w);
  } catch (err) {
    rate = 0;
  }
  const raw = (Number(rate) || 0) * cfg.betSeconds;
  const clamped = Math.max(cfg.betMin, Math.min(cfg.betMax, raw));
  return Math.max(cfg.betMin, Math.floor(clamped) || cfg.betMin);
}

function drawWheel(ctx, size, rotation) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  const seg = (Math.PI * 2) / WHEEL_ORDER.length;
  for (let i = 0; i < WHEEL_ORDER.length; i++) {
    const num = WHEEL_ORDER[i];
    const start = -Math.PI / 2 + i * seg;
    const end = start + seg;
    const color = numberColor(num);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, start, end);
    ctx.closePath();
    ctx.fillStyle = color === 'red' ? '#c0392b' : color === 'black' ? '#1c1c1c' : '#1e8449';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    ctx.rotate(start + seg / 2);
    ctx.translate(r * 0.78, 0);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = '#fff';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), 0, 0);
    ctx.restore();
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.14, 0, Math.PI * 2);
  ctx.fillStyle = '#d4af37';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.stroke();
}

function drawPointer(ctx, size) {
  ctx.save();
  ctx.translate(size / 2, 6);
  ctx.beginPath();
  ctx.moveTo(-7, -4);
  ctx.lineTo(7, -4);
  ctx.lineTo(0, 10);
  ctx.closePath();
  ctx.fillStyle = '#ffd700';
  ctx.fill();
  ctx.restore();
}

function animateSpin(ctx, size, targetIndex, duration, onDone) {
  const seg = (Math.PI * 2) / WHEEL_ORDER.length;
  const spins = 5 + Math.floor(Math.random() * 2);
  const targetMod = ((Math.PI * 2) - ((targetIndex * seg) % (Math.PI * 2))) % (Math.PI * 2);
  const finalRotation = spins * Math.PI * 2 + targetMod;
  const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const rot = finalRotation * eased;
    drawWheel(ctx, size, rot);
    drawPointer(ctx, size);
    if (t < 1) {
      rlRaf = requestAnimationFrame(frame);
    } else {
      rlRaf = null;
      onDone();
    }
  }
  rlRaf = requestAnimationFrame(frame);
}

function closeRoulette() {
  /*
   * The stake is debited and the round settled the moment Spin is tapped, so a
   * modal torn down mid-animation must never cost the player a win. The payout
   * itself is already in the wallet (see settleRouletteBet) — all that can be
   * missing is the player ever *seeing* it, because renderRouletteOutcome only
   * runs when the wheel finishes. Announce it on the way out.
   */
  if (rl && rl.lastOutcome && rl.lastOutcome.win && rl.paid && !rl.outcomeShown) {
    try {
      toast(t('mini.roulette.autoCollected', { amount: fmtMoney(rl.lastOutcome.payout) }), 'good');
    } catch (err) {
      // a failed toast must never block the teardown below
    }
  }
  if (rlRaf) {
    cancelAnimationFrame(rlRaf);
    rlRaf = null;
  }
  if (rlCooldownTimer) {
    clearInterval(rlCooldownTimer);
    rlCooldownTimer = null;
  }
  if (rlBackdrop && rlBackdrop.parentNode) rlBackdrop.parentNode.removeChild(rlBackdrop);
  rlBackdrop = null;
  rlBody = null;
  rlCanvas = null;
  rlTitleEl = null;
  rl = null;
}

function renderRouletteCooldown() {
  if (!rlBody) return;
  rlBody.innerHTML = '';
  const msg = el('div', null, t('mini.cooldown'));
  msg.style.color = 'var(--text-muted)';
  msg.style.marginBottom = '8px';
  const timer = el('div', 'card-title', fmtTime(Math.ceil(remainingCooldownMs('roulette') / 1000)));
  timer.style.fontSize = '22px';
  timer.style.textAlign = 'center';
  rlBody.appendChild(msg);
  rlBody.appendChild(timer);

  if (rlCooldownTimer) clearInterval(rlCooldownTimer);
  rlCooldownTimer = setInterval(() => {
    if (!isOnCooldown('roulette')) {
      clearInterval(rlCooldownTimer);
      rlCooldownTimer = null;
      renderRouletteGame();
      return;
    }
    if (timer.parentNode) timer.textContent = fmtTime(Math.ceil(remainingCooldownMs('roulette') / 1000));
  }, 1000);
}

function renderRouletteGame() {
  if (!rlBody) return;
  if (rlCooldownTimer) {
    clearInterval(rlCooldownTimer);
    rlCooldownTimer = null;
  }
  rlBody.innerHTML = '';

  // `paid` — the win has already been credited to lastWorld (settlement, not
  // the outcome UI, is what pays). `claimed` — the player has since made the
  // cash-or-boost choice, so neither button may fire again.
  rl = { betKey: null, betParam: null, amount: computeRouletteBet(), spinning: false, claimed: false, paid: false, outcomeShown: false, lastOutcome: null, lastResultBox: null, lastWorld: null };

  const wheelWrap = el('div', null);
  wheelWrap.style.display = 'flex';
  wheelWrap.style.justifyContent = 'center';
  const canvas = document.createElement('canvas');
  canvas.width = 220;
  canvas.height = 220;
  canvas.style.maxWidth = '100%';
  const ctx = canvas.getContext('2d');
  drawWheel(ctx, 220, 0);
  drawPointer(ctx, 220);
  wheelWrap.appendChild(canvas);
  rlBody.appendChild(wheelWrap);
  rlCanvas = canvas;

  const betLine = el('div', null, t('mini.roulette.betAmount', { amount: fmtMoney(rl.amount) }));
  betLine.style.textAlign = 'center';
  betLine.style.color = 'var(--gold)';
  betLine.style.margin = '8px 0';
  rlBody.appendChild(betLine);

  const betRow = el('div', 'shop-grid');
  const subRow = el('div', 'shop-grid');
  subRow.style.marginTop = '6px';
  const resultBox = el('div', null);
  resultBox.style.textAlign = 'center';
  resultBox.style.margin = '10px 0';

  const spinBtn = document.createElement('button');
  spinBtn.type = 'button';
  spinBtn.textContent = t('mini.roulette.spin');
  spinBtn.disabled = true;

  function refreshSpinEnabled() {
    let ready = !!rl.betKey;
    if (rl.betKey === 'dozen' && !rl.betParam) ready = false;
    if (rl.betKey === 'single' && (rl.betParam === null || rl.betParam === undefined)) ready = false;
    spinBtn.disabled = rl.spinning || !ready;
  }

  const bets = CONFIG.minigames.roulette.bets;
  for (const def of bets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shop-item';
    // The payout tag was a hardcoded ' (x2)': a Latin 'x' where every other
    // multiplier in the app is '×', and a parenthesised suffix whose placement
    // next to Hebrew text is a locale decision. Both now live in the tables.
    btn.textContent =
      t('mini.roulette.bet.' + def.key) + ' ' + t('mini.roulette.payoutTag', { mult: def.payout });
    btn.addEventListener('click', () => {
      rl.betKey = def.key;
      rl.betParam = null;
      subRow.innerHTML = '';
      if (def.key === 'dozen') {
        for (let d = 1; d <= 3; d++) {
          const sub = document.createElement('button');
          sub.type = 'button';
          sub.className = 'shop-item';
          sub.textContent = t('mini.roulette.dozen.' + d);
          sub.addEventListener('click', () => {
            rl.betParam = d;
            refreshSpinEnabled();
          });
          subRow.appendChild(sub);
        }
      } else if (def.key === 'single') {
        const select = document.createElement('select');
        select.style.width = '100%';
        select.style.padding = '6px';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = t('mini.roulette.pickNumber');
        select.appendChild(placeholder);
        for (let n = 0; n <= 36; n++) {
          const opt = document.createElement('option');
          opt.value = String(n);
          opt.textContent = String(n);
          select.appendChild(opt);
        }
        select.addEventListener('change', () => {
          rl.betParam = select.value === '' ? null : Number(select.value);
          refreshSpinEnabled();
        });
        subRow.appendChild(select);
      }
      refreshSpinEnabled();
    });
    betRow.appendChild(btn);
  }

  rlBody.appendChild(betRow);
  rlBody.appendChild(subRow);
  rlBody.appendChild(resultBox);
  rlBody.appendChild(spinBtn);

  spinBtn.addEventListener('click', () => {
    if (rl.spinning) return;
    if (!rl.betKey) {
      toast(t('mini.roulette.needBet'), 'bad');
      return;
    }
    if (rl.betKey === 'dozen' && !rl.betParam) {
      toast(t('mini.roulette.needDozen'), 'bad');
      return;
    }
    if (rl.betKey === 'single' && (rl.betParam === null || rl.betParam === undefined)) {
      toast(t('mini.roulette.needNumber'), 'bad');
      return;
    }
    const w = activeWorld();
    if (!w || (Number(w.money) || 0) < rl.amount) {
      toast(t('mini.roulette.noMoney'), 'bad');
      return;
    }
    const def = bets.find((b) => b.key === rl.betKey);
    if (!def) return;

    addMoney(w, -rl.amount);
    rl.spinning = true;
    refreshSpinEnabled();
    betRow.querySelectorAll('button').forEach((b) => { b.disabled = true; });

    const targetIdx = Math.floor(Math.random() * WHEEL_ORDER.length);
    const winNumber = WHEEL_ORDER[targetIdx];

    // Settle the bet (win/lose, PAYOUT, diamonds, cooldown) synchronously,
    // right now — not in the animation's completion callback, and not in the
    // outcome UI's buttons. The stake and the cooldown are spent the instant
    // Spin is tapped, so the winnings must be equally independent of how long
    // the modal happens to live: closing the ×, tapping the backdrop, or the
    // tab being killed one second into the 3.6 s wheel must all leave the
    // player paid. Only the (purely cosmetic) result UI is deferred, guarded
    // by a round token so a stale callback can't write into detached DOM.
    const round = rl;
    const outcome = settleRouletteBet(winNumber, def, round.betParam, round.amount, w);
    round.lastOutcome = outcome;
    round.lastResultBox = resultBox;
    round.lastWorld = w;
    round.paid = outcome.win;

    animateSpin(ctx, 220, targetIdx, 3600, () => {
      if (rl !== round) return; // modal closed or a new round started meanwhile
      round.spinning = false;
      renderRouletteOutcome(outcome, resultBox, w);
    });
  });

  refreshSpinEnabled();
}

/**
 * Resolve a round completely: win/lose, straight-up diamonds, the cooldown,
 * AND the cash payout. Paying here rather than from a button in the outcome UI
 * is the whole point — the modal's lifetime no longer decides whether an
 * already-earned win is honoured.
 * @param {any} w the world that placed (and was debited for) the bet.
 */
function settleRouletteBet(winNumber, def, betParam, amount, w) {
  const color = numberColor(winNumber);
  let win = false;
  if (def.key === 'red' || def.key === 'black') win = color === def.key;
  else if (def.key === 'even' || def.key === 'odd') win = numberParity(winNumber) === def.key;
  else if (def.key === 'dozen') win = numberDozen(winNumber) === betParam;
  else if (def.key === 'single') win = winNumber === betParam;

  startCooldown('roulette');

  const cfg = CONFIG.minigames.roulette;
  if (def.key === 'single' && win) {
    addDiamonds(cfg.diamondsOnStraight);
    toast(t('mini.roulette.straight', { amount: cfg.diamondsOnStraight }), 'good');
  }

  const payout = win ? Math.floor(amount * def.payout) : 0;
  if (win && payout > 0 && w) addMoney(w, payout);
  return { winNumber, color, win, payout, payoutMult: def.payout };
}

function renderRouletteOutcome(outcome, resultBox, w) {
  if (!resultBox) return;
  resultBox.innerHTML = '';
  if (rl) rl.outcomeShown = true;
  const headline = el('div', 'card-title', t('mini.roulette.result', { number: outcome.winNumber, color: colorLabel(outcome.color) }));
  headline.style.fontSize = '16px';
  resultBox.appendChild(headline);

  const cfg = CONFIG.minigames.roulette;
  const alreadyClaimed = !!(rl && rl.claimed);

  if (outcome.win) {
    const payout = outcome.payout;
    const line = el('div', null, t('mini.roulette.win', { amount: fmtMoney(payout) }));
    line.style.color = 'var(--good)';
    line.style.margin = '6px 0';
    resultBox.appendChild(line);

    // The cash is already in the wallet (settleRouletteBet paid it the moment
    // the round resolved). Say so, so the choice below reads as "keep this or
    // trade it in" rather than an unclaimed prize the player might walk away
    // from — which is exactly how the payout used to get lost.
    const bankedLine = el('div', null, t('mini.roulette.banked', { amount: fmtMoney(payout) }));
    bankedLine.style.color = 'var(--text-muted)';
    bankedLine.style.fontSize = '12px';
    bankedLine.style.margin = '2px 0 6px';
    resultBox.appendChild(bankedLine);

    const choices = el('div', null);
    choices.style.display = 'flex';
    choices.style.gap = '8px';
    choices.style.justifyContent = 'center';

    const cashBtn = document.createElement('button');
    cashBtn.type = 'button';
    cashBtn.className = 'success';
    cashBtn.textContent = t('mini.roulette.keepCash');
    cashBtn.disabled = alreadyClaimed;
    cashBtn.addEventListener('click', () => {
      // Pure confirmation: the money was credited at settlement, so this only
      // closes the choice. It must never call addMoney() again.
      if (rl) rl.claimed = true;
      cashBtn.disabled = true;
      boostBtn.disabled = true;
    });

    // Boost duration is scaled to the actual (possibly betMin/betMax-clamped)
    // cash payout, not the payout multiplier alone (see boostSecondsForPayout
    // doc-comment), so its expected value tracks the cash option instead of
    // paying out ~2x -- or ~0x for low-income casinos -- for the same win.
    let boostRate = 0;
    try {
      boostRate = incomeRate(w);
    } catch (err) {
      boostRate = 0;
    }
    const boostSeconds = boostSecondsForPayout(payout, boostRate);
    const boostBtn = document.createElement('button');
    boostBtn.type = 'button';
    boostBtn.className = 'secondary';
    boostBtn.textContent = t('mini.roulette.swapBoost', { mult: cfg.boostMult });
    boostBtn.disabled = alreadyClaimed;
    boostBtn.addEventListener('click', () => {
      const seconds = boostSeconds;
      // The payout is already banked, so trading it for the boost has to hand
      // it back first — otherwise the swap would pay both rewards at once.
      if (w && payout > 0) addMoney(w, -payout);
      state.boosts.income = { mult: cfg.boostMult, until: Date.now() + seconds * 1000 };
      bus.emit('boost:started', { kind: 'income', mult: cfg.boostMult, seconds });
      save();
      toast(t('mini.roulette.boostOn'), 'good');
      if (rl) rl.claimed = true;
      cashBtn.disabled = true;
      boostBtn.disabled = true;
    });

    choices.appendChild(cashBtn);
    choices.appendChild(boostBtn);
    resultBox.appendChild(choices);
  } else {
    const line = el('div', null, t('mini.roulette.lose'));
    line.style.color = 'var(--bad)';
    resultBox.appendChild(line);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'secondary';
  closeBtn.textContent = t('common.close');
  closeBtn.style.marginTop = '10px';
  closeBtn.addEventListener('click', closeRoulette);
  resultBox.appendChild(closeBtn);
}

function showRoulette() {
  closeRoulette();
  ensureModalContainer();

  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');
  const title = el('div', 'modal-title', t('mini.roulette.title'));
  modal.appendChild(title);
  rlTitleEl = title;

  const closeBtn = el('button', 'modal-close', '×');
  closeBtn.type = 'button';
  closeBtn.title = t('common.close');
  closeBtn.setAttribute('aria-label', t('common.close'));
  closeBtn.addEventListener('click', closeRoulette);
  modal.appendChild(closeBtn);

  const content = el('div', 'modal-content');
  modal.appendChild(content);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeRoulette();
  });

  backdrop.appendChild(modal);
  modalContainer.appendChild(backdrop);

  rlBackdrop = backdrop;
  rlBody = content;

  if (isOnCooldown('roulette')) renderRouletteCooldown();
  else renderRouletteGame();
}

/* ------------------------------------------------------------------ *
 *  BLACKJACK
 * ------------------------------------------------------------------ *
 * Standard 52-card deck contents/ranks are fixed game rules, not tunable
 * balance numbers; deck count and dealer-stand threshold come from
 * CONFIG.minigames.blackjack.
 */

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function buildShoe(decks) {
  const shoe = [];
  const n = Math.max(1, Math.floor(Number(decks) || 1));
  for (let d = 0; d < n; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) shoe.push({ rank, suit });
    }
  }
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = shoe[i];
    shoe[i] = shoe[j];
    shoe[j] = tmp;
  }
  return shoe;
}

function rankValue(rank) {
  if (rank === 'A') return 11;
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank);
}

function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += rankValue(c.rank);
    if (c.rank === 'A') aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function isBlackjackHand(cards) {
  return cards.length === 2 && handValue(cards) === 21;
}

let bj = null;
let bjBackdrop = null;
let bjBody = null;
let bjCooldownTimer = null;
let bjTitleEl = null;

function drawCard() {
  if (!bj.shoe.length) bj.shoe = buildShoe(CONFIG.minigames.blackjack.decks);
  return bj.shoe.pop();
}

function closeBlackjack() {
  /*
   * Same shape as the roulette bug: finishBlackjackHand() burns the 15-minute
   * cooldown the instant the hand resolves, but the reward is only handed over
   * by one of the three choice buttons. Closing the modal on a won hand paid
   * nothing and still locked the game out for 15 minutes. Award the default
   * (diamonds — the option the "success" button offers) on the way out.
   */
  if (bj && !bj.claimed && (bj.outcome === 'win' || bj.outcome === 'blackjack')) {
    try {
      const cfg = CONFIG.minigames.blackjack;
      const amount = bj.outcome === 'blackjack' ? cfg.diamondsBlackjack : cfg.diamondsWin;
      bj.claimed = true;
      addDiamonds(amount);
      save();
      toast(t('mini.blackjack.autoCollected', { amount }), 'good');
    } catch (err) {
      // never let the payout wiring block the teardown below
    }
  }
  if (bjCooldownTimer) {
    clearInterval(bjCooldownTimer);
    bjCooldownTimer = null;
  }
  if (bjBackdrop && bjBackdrop.parentNode) bjBackdrop.parentNode.removeChild(bjBackdrop);
  bjBackdrop = null;
  bjBody = null;
  bjTitleEl = null;
  bj = null;
}

function renderCardEl(card, hidden) {
  const box = el('div', null);
  box.style.display = 'inline-flex';
  box.style.alignItems = 'center';
  box.style.justifyContent = 'center';
  box.style.width = '38px';
  box.style.height = '54px';
  box.style.margin = '0 3px';
  box.style.borderRadius = '6px';
  box.style.background = hidden ? 'var(--panel-alt)' : '#fff';
  box.style.border = '1px solid rgba(0,0,0,0.4)';
  box.style.fontWeight = '700';
  box.style.fontSize = '14px';
  if (hidden) {
    box.textContent = '?';
    box.style.color = 'var(--text-muted)';
  } else {
    const isRed = card.suit === '♥' || card.suit === '♦';
    box.style.color = isRed ? '#c0392b' : '#111';
    box.textContent = card.rank + card.suit;
  }
  return box;
}

function renderBlackjackCooldown() {
  if (!bjBody) return;
  bjBody.innerHTML = '';
  const msg = el('div', null, t('mini.cooldown'));
  msg.style.color = 'var(--text-muted)';
  msg.style.marginBottom = '8px';
  const timer = el('div', 'card-title', fmtTime(Math.ceil(remainingCooldownMs('blackjack') / 1000)));
  timer.style.fontSize = '22px';
  timer.style.textAlign = 'center';
  bjBody.appendChild(msg);
  bjBody.appendChild(timer);

  if (bjCooldownTimer) clearInterval(bjCooldownTimer);
  bjCooldownTimer = setInterval(() => {
    if (!isOnCooldown('blackjack')) {
      clearInterval(bjCooldownTimer);
      bjCooldownTimer = null;
      renderBlackjackIntro();
      return;
    }
    if (timer.parentNode) timer.textContent = fmtTime(Math.ceil(remainingCooldownMs('blackjack') / 1000));
  }, 1000);
}

function renderBlackjackIntro() {
  if (!bjBody) return;
  bjBody.innerHTML = '';
  const info = el('div', null, t('mini.blackjack.intro', { value: CONFIG.minigames.blackjack.dealerStandsOn }));
  info.style.color = 'var(--text-muted)';
  info.style.marginBottom = '10px';
  bjBody.appendChild(info);

  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'success';
  startBtn.textContent = t('mini.blackjack.start');
  startBtn.addEventListener('click', () => {
    bj = { shoe: buildShoe(CONFIG.minigames.blackjack.decks), player: [], dealer: [], phase: 'player', outcome: null, claimed: false };
    bj.player = [drawCard(), drawCard()];
    bj.dealer = [drawCard(), drawCard()];

    const playerBJ = isBlackjackHand(bj.player);
    const dealerBJ = isBlackjackHand(bj.dealer);
    if (playerBJ || dealerBJ) {
      bj.phase = 'done';
      bj.outcome = playerBJ && dealerBJ ? 'push' : playerBJ ? 'blackjack' : 'dealerBlackjack';
      finishBlackjackHand();
    }
    renderBlackjackTable();
  });
  bjBody.appendChild(startBtn);
}

function finishBlackjackHand() {
  startCooldown('blackjack');
  const cfg = CONFIG.minigames.blackjack;
  if (bj.outcome === 'push') {
    addDiamonds(cfg.diamondsPush);
    toast(t('mini.blackjack.pushToast', { amount: cfg.diamondsPush }), 'info');
  } else if (bj.outcome === 'dealerBlackjack' || bj.outcome === 'bust' || bj.outcome === 'lose') {
    toast(t('mini.blackjack.loseToast'), 'bad');
  }
}

function outcomeLabel(outcome) {
  if (outcome === 'blackjack') return t('mini.blackjack.blackjack');
  if (outcome === 'win') return t('mini.blackjack.win');
  if (outcome === 'push') return t('mini.blackjack.push');
  if (outcome === 'bust') return t('mini.blackjack.bust');
  if (outcome === 'dealerBlackjack') return t('mini.blackjack.dealerBlackjack');
  return t('mini.blackjack.lose');
}

function renderBlackjackTable() {
  if (!bjBody || !bj) return;
  bjBody.innerHTML = '';

  const dealerLabel = el('div', null, bj.phase === 'player' ? t('mini.blackjack.dealer') : t('mini.blackjack.dealerScore', { value: handValue(bj.dealer) }));
  dealerLabel.style.color = 'var(--text-muted)';
  dealerLabel.style.fontSize = '12px';
  bjBody.appendChild(dealerLabel);

  const dealerRow = el('div', null);
  dealerRow.style.margin = '4px 0 12px';
  bj.dealer.forEach((card, idx) => {
    const hidden = bj.phase === 'player' && idx === 1;
    dealerRow.appendChild(renderCardEl(card, hidden));
  });
  bjBody.appendChild(dealerRow);

  const playerLabel = el('div', null, t('mini.blackjack.player', { value: handValue(bj.player) }));
  playerLabel.style.color = 'var(--text-muted)';
  playerLabel.style.fontSize = '12px';
  bjBody.appendChild(playerLabel);

  const playerRow = el('div', null);
  playerRow.style.margin = '4px 0 12px';
  bj.player.forEach((card) => playerRow.appendChild(renderCardEl(card, false)));
  bjBody.appendChild(playerRow);

  if (bj.phase === 'player') {
    const actions = el('div', null);
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.justifyContent = 'center';

    const hitBtn = document.createElement('button');
    hitBtn.type = 'button';
    hitBtn.textContent = t('mini.blackjack.hit');
    hitBtn.addEventListener('click', () => {
      bj.player.push(drawCard());
      if (handValue(bj.player) > 21) {
        bj.phase = 'done';
        bj.outcome = 'bust';
        finishBlackjackHand();
      }
      renderBlackjackTable();
    });

    const standBtn = document.createElement('button');
    standBtn.type = 'button';
    standBtn.className = 'secondary';
    standBtn.textContent = t('mini.blackjack.stand');
    standBtn.addEventListener('click', () => {
      bj.phase = 'dealer';
      while (handValue(bj.dealer) < CONFIG.minigames.blackjack.dealerStandsOn) {
        bj.dealer.push(drawCard());
      }
      const pv = handValue(bj.player);
      const dv = handValue(bj.dealer);
      bj.phase = 'done';
      if (dv > 21) bj.outcome = 'win';
      else if (dv > pv) bj.outcome = 'lose';
      else if (dv < pv) bj.outcome = 'win';
      else bj.outcome = 'push';
      finishBlackjackHand();
      renderBlackjackTable();
    });

    actions.appendChild(hitBtn);
    actions.appendChild(standBtn);
    bjBody.appendChild(actions);
    return;
  }

  const result = el('div', 'card-title', outcomeLabel(bj.outcome));
  result.style.textAlign = 'center';
  result.style.margin = '8px 0';
  bjBody.appendChild(result);

  if (bj.outcome === 'win' || bj.outcome === 'blackjack') {
    const cfg = CONFIG.minigames.blackjack;
    const choices = el('div', null);
    choices.style.display = 'flex';
    choices.style.gap = '8px';
    choices.style.justifyContent = 'center';
    choices.style.flexWrap = 'wrap';

    const diamondAmt = bj.outcome === 'blackjack' ? cfg.diamondsBlackjack : cfg.diamondsWin;
    const alreadyClaimed = !!bj.claimed;

    const diamondBtn = document.createElement('button');
    diamondBtn.type = 'button';
    diamondBtn.className = 'success';
    diamondBtn.textContent = t('mini.blackjack.takeDiamonds', { amount: diamondAmt });
    diamondBtn.disabled = alreadyClaimed;
    diamondBtn.addEventListener('click', () => {
      addDiamonds(diamondAmt);
      toast(t('mini.blackjack.gotDiamonds', { amount: diamondAmt }), 'good');
      bj.claimed = true;
      diamondBtn.disabled = true;
      dealerBtn.disabled = true;
      cashBtn.disabled = true;
    });

    const dealerBtn = document.createElement('button');
    dealerBtn.type = 'button';
    dealerBtn.className = 'secondary';
    dealerBtn.textContent = t('mini.blackjack.takeDealerBoost', { mult: cfg.dealerBoostMult });
    dealerBtn.disabled = alreadyClaimed;
    dealerBtn.addEventListener('click', () => {
      state.boosts.dealer = { mult: cfg.dealerBoostMult, until: Date.now() + cfg.dealerBoostSeconds * 1000 };
      bus.emit('boost:started', { kind: 'dealer', mult: cfg.dealerBoostMult, seconds: cfg.dealerBoostSeconds });
      save();
      toast(t('mini.blackjack.dealerBoostOn'), 'good');
      bj.claimed = true;
      diamondBtn.disabled = true;
      dealerBtn.disabled = true;
      cashBtn.disabled = true;
    });

    const cashBtn = document.createElement('button');
    cashBtn.type = 'button';
    cashBtn.textContent = t('mini.blackjack.takeCash');
    cashBtn.disabled = alreadyClaimed;
    cashBtn.addEventListener('click', () => {
      const w = activeWorld();
      let rate = 0;
      try {
        rate = incomeRate(w);
      } catch (err) {
        rate = 0;
      }
      const amt = Math.max(cfg.cashWinMin, Math.floor((Number(rate) || 0) * cfg.cashWinSeconds));
      if (w) addMoney(w, amt);
      toast(t('mini.blackjack.gotCash', { amount: fmtMoney(amt) }), 'good');
      bj.claimed = true;
      diamondBtn.disabled = true;
      dealerBtn.disabled = true;
      cashBtn.disabled = true;
    });

    choices.appendChild(diamondBtn);
    choices.appendChild(dealerBtn);
    choices.appendChild(cashBtn);
    bjBody.appendChild(choices);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'secondary';
  closeBtn.textContent = t('common.close');
  closeBtn.style.marginTop = '10px';
  closeBtn.style.display = 'block';
  closeBtn.style.marginLeft = 'auto';
  closeBtn.style.marginRight = 'auto';
  closeBtn.addEventListener('click', closeBlackjack);
  bjBody.appendChild(closeBtn);
}

function showBlackjack() {
  closeBlackjack();
  ensureModalContainer();

  const backdrop = el('div', 'modal-backdrop');
  const modal = el('div', 'modal');
  const title = el('div', 'modal-title', t('mini.blackjack.title'));
  modal.appendChild(title);
  bjTitleEl = title;

  const closeBtn = el('button', 'modal-close', '×');
  closeBtn.type = 'button';
  closeBtn.title = t('common.close');
  closeBtn.setAttribute('aria-label', t('common.close'));
  closeBtn.addEventListener('click', closeBlackjack);
  modal.appendChild(closeBtn);

  const content = el('div', 'modal-content');
  modal.appendChild(content);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeBlackjack();
  });

  backdrop.appendChild(modal);
  modalContainer.appendChild(backdrop);

  bjBackdrop = backdrop;
  bjBody = content;

  if (isOnCooldown('blackjack')) renderBlackjackCooldown();
  else renderBlackjackIntro();
}

/* ------------------------------------------------------------------ *
 *  Public API
 * ------------------------------------------------------------------ */

/**
 * Re-render whichever mini-game modal is currently open so every visible
 * string picks up the new language immediately. Both games are driven
 * entirely off their transient `rl`/`bj` state objects (including the
 * `claimed` flag added specifically for this), so calling their render
 * functions again is always safe: it never re-enables an already-claimed
 * reward and never drops an in-flight spin/animation.
 */
function retranslateRoulette() {
  if (!rlBackdrop) return;
  if (rlTitleEl) rlTitleEl.textContent = t('mini.roulette.title');
  if (isOnCooldown('roulette')) {
    renderRouletteCooldown();
    return;
  }
  if (rl && rl.spinning) return; // mid-animation; the spin-end callback renders fresh text anyway
  if (rl && rl.lastOutcome) {
    renderRouletteOutcome(rl.lastOutcome, rl.lastResultBox, rl.lastWorld);
    return;
  }
  if (rl) renderRouletteGame();
}

function retranslateBlackjack() {
  if (!bjBackdrop) return;
  if (bjTitleEl) bjTitleEl.textContent = t('mini.blackjack.title');
  if (isOnCooldown('blackjack')) {
    renderBlackjackCooldown();
    return;
  }
  if (bj) renderBlackjackTable();
  else renderBlackjackIntro();
}

export function mount(mountRoot) {
  root = mountRoot || null;
  ensureModalContainer();
  // A second mount() would double-subscribe both open hooks (two stacked
  // modals per tap) and add a second onLocaleChanged listener nothing removes.
  if (mounted) return;
  mounted = true;

  // Optional integration hooks: other modules may emit these instead of
  // importing openRoulette()/openBlackjack() directly.
  bus.on('ui:openRoulette', openRoulette);
  bus.on('ui:openBlackjack', openBlackjack);

  onLocaleChanged(() => {
    retranslateRoulette();
    retranslateBlackjack();
  });
}

export function update() {
  // Both modals are self-contained and event-driven; nothing to poll here.
}

/** Integrator hook: open the roulette modal (e.g. from a HUD/panel button). */
export function openRoulette() {
  showRoulette();
}

/** Integrator hook: open the blackjack modal (e.g. from a HUD/panel button). */
export function openBlackjack() {
  showBlackjack();
}

export default { mount, update, openRoulette, openBlackjack };
