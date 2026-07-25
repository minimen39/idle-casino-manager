/**
 * config.js — every balance number in the game lives here.
 * Nothing outside this file should hardcode gameplay constants.
 *
 * Cost curve convention:  cost = baseCost * costGrowth ^ currentCount
 * Income curve convention: income = baseIncome * incomeGrowth ^ (level - 1) * count
 */

/* ------------------------------------------------------------------ *
 *  CONFIG — global tuning
 * ------------------------------------------------------------------ */

export const CONFIG = {
  /** localStorage key + schema version. */
  storageKey: 'idleCasino.v1',
  version: 1,

  /** Core loop timing. */
  loop: {
    maxDt: 0.05,          // seconds; dt clamp in main.js
    incomeTickMs: 1000,   // how often passive income is paid out
    autosaveMs: 10000,
    saveThrottleMs: 2000  // minimum gap between real localStorage writes
  },

  /** Starting resources. */
  start: {
    money: 60,            // enough for two slot machines in world 0
    diamonds: 5
  },

  /** Grid / layout defaults (layout.js reads these). */
  grid: {
    tile: 32,
    cols: 30,
    rows: 20,
    minCols: 22,
    minRows: 15,
    padding: 1            // wall thickness in tiles
  },

  /** Economy knobs. */
  economy: {
    /** Upgrading an instance level costs this multiple of its next-unit cost. */
    levelCostMult: 4.2,
    levelCostGrowth: 1.6,
    maxLevel: 25,
    /** House edge applied to guest wagers -> casino income. */
    houseEdge: 0.14,
    /** Venues that need a dealer produce this fraction when unstaffed. */
    unstaffedOutput: 0,
    /** Multiplier applied to income from every service (non-gamble) venue. */
    serviceIncomeMult: 0.55,
    /** Global soft multiplier per station level (throughput -> more guests served). */
    stationIncomeBonus: 0.03,
    /** Cleanliness below this starts hurting income. */
    dirtyPenaltyFloor: 0.45,
    dirtyPenaltyMax: 0.35   // at 0 cleanliness income drops by 35%
  },

  /** Guest simulation. */
  guest: {
    spawnIntervalBase: 3.4,     // seconds between arrivals at spawnMult 1
    spawnIntervalMin: 0.35,
    /** Each placed gamble venue shortens the spawn interval a little. */
    spawnPerVenue: 0.022,
    maxGuests: 90,
    walkSpeed: 42,              // world pixels / second
    walkSpeedVariance: 0.25,
    patienceMax: 100,
    patienceDrainQueue: 4.2,    // per second while waiting in a queue
    patienceDrainIdle: 0.9,
    energyMax: 100,
    energyDrainPlay: 2.1,       // per second while gambling
    energyDrainWalk: 0.6,
    /** Below these thresholds the guest looks for bar / buffet / showroom. */
    lowPatience: 34,
    lowEnergy: 30,
    wealthMin: 90,
    wealthMax: 720,
    vipChance: 0.045,
    vipWealthMult: 9,
    /** Fraction of remaining wealth converted to chips at the cashier. */
    chipsFraction: 0.75,
    /** Wager per play tick as a fraction of held chips. */
    wagerFraction: 0.14,
    wagerMin: 3,
    /** How long a single "play" beat lasts before the next wager. */
    playBeat: 1.6,
    /** Risk appetite raised by service venues -> bigger wagers. */
    riskMax: 1.8,
    riskDecay: 0.012,
    /** Max guests allowed to wait per venue before newcomers look elsewhere. */
    maxQueue: 6,
    abandonPatience: 0,
    /** Colors used for procedural guest figures. */
    palette: [
      '#e8d9c0', '#d3a15f', '#8c5a3c', '#f0c8a0',
      '#c94f4f', '#4f8cc9', '#63b06a', '#b47fd0',
      '#e0a13c', '#5fb8c9'
    ],
    vipColor: '#ffd76a'
  },

  /** Visual / gameplay tier thresholds, keyed off lifetime investment in a world. */
  tier: {
    thresholds: [0, 18000, 450000],  // index 0 => tier 1, etc.
    /** Income multiplier granted by the tier itself (atmosphere). */
    incomeMult: [1, 1.18, 1.45],
    /** Patience drain multiplier — nicer casinos are more pleasant to wait in. */
    patienceMult: [1, 0.88, 0.72]
  },

  /** Offline earnings. */
  offline: {
    capHours: 8,
    rate: 0.5,          // fraction of live income earned while away
    minSeconds: 45,     // below this we do not bother reporting
    adMultiplier: 2     // rewarded ad doubles the offline payout
  },

  /** Real-time live events (spec section 5). */
  liveEvents: {
    minInterval: 22,          // seconds
    maxInterval: 48,
    /** Interval shrinks as the casino gets bigger/richer. */
    intervalPerVenue: 0.35,
    minIntervalFloor: 9,
    maxConcurrent: 4,
    /** Guards auto-resolve within this radius (world px), scaled by guard level. */
    guardRadius: 90,
    guardRadiusPerLevel: 14,
    guardSpeed: 62,
    /** Cameras give a per-second chance to auto-flag an actor. */
    cameraAutoChance: 0.02,
    cameraAutoChancePerLevel: 0.012,
    /** Clicking within this radius (world px) counts as a hit. */
    clickRadius: 22,
    types: {
      thief: {
        labelKey: 'event.thief.label',
        weight: 34,
        ttl: 9,               // seconds before it escapes
        speed: 58,
        /** Reward = incomeRate * rewardSeconds (clamped by min/max). */
        rewardSeconds: 14,
        rewardMin: 40,
        rewardMax: 5e11,
        /** Penalty if it escapes = money * penaltyFraction (clamped). */
        penaltyFraction: 0.035,
        // Scaled to CONFIG.start.money (60) so a fresh player loses ~8%, not ~42%.
        penaltyMin: 5,
        color: '#c0392b'
      },
      brinks: {
        labelKey: 'event.brinks.label',
        weight: 14,
        ttl: 16,
        speed: 26,
        rewardSeconds: 55,
        rewardMin: 150,
        rewardMax: 5e11,
        penaltyFraction: 0.06,
        // Scaled to CONFIG.start.money (60) so a robbed convoy can't wipe out
        // a brand-new player's entire starting bankroll (was penaltyMin: 60).
        penaltyMin: 15,
        color: '#7f8c8d'
      },
      counter: {
        labelKey: 'event.counter.label',
        weight: 22,
        ttl: 22,
        speed: 0,             // sits at a table
        rewardSeconds: 26,
        rewardMin: 80,
        rewardMax: 5e11,
        /** Drains this fraction of income per second while active. */
        drainPerSecond: 0.22,
        penaltyFraction: 0.02,
        // Scaled to CONFIG.start.money (60) so a fresh player loses ~13%, not ~50%.
        penaltyMin: 8,
        color: '#8e44ad'
      },
      angry: {
        labelKey: 'event.angry.label',
        weight: 20,
        ttl: 14,
        speed: 18,
        rewardSeconds: 10,
        rewardMin: 30,
        rewardMax: 5e11,
        /** If unhandled, nearby guests lose patience. */
        moodRadius: 120,
        moodDrain: 9,
        penaltyFraction: 0.015,
        // Scaled to CONFIG.start.money (60) so a fresh player loses ~8%, not ~33%.
        penaltyMin: 5,
        color: '#e67e22'
      },
      vip: {
        labelKey: 'event.vip.label',
        weight: 10,
        ttl: 20,
        speed: 34,
        rewardSeconds: 70,
        rewardMin: 200,
        rewardMax: 5e11,
        /** Escorting a VIP grants a short income boost instead of a penalty. */
        boostMult: 2,
        boostSeconds: 30,
        penaltyFraction: 0,
        penaltyMin: 0,
        color: '#f1c40f'
      }
    }
  },

  /** Mini-games (spec section 6). */
  minigames: {
    cooldownMs: 900000,          // 15 minutes, both games
    roulette: {
      /** Bet = this many seconds of current income, floored/capped. */
      betSeconds: 45,
      betMin: 50,
      betMax: 1e12,
      /** Bet types the player can pick. */
      bets: [
        { key: 'red',    nameKey: 'mini.roulette.bet.red',    payout: 2,  chance: 18 / 37 },
        { key: 'black',  nameKey: 'mini.roulette.bet.black',  payout: 2,  chance: 18 / 37 },
        { key: 'even',   nameKey: 'mini.roulette.bet.even',   payout: 2,  chance: 18 / 37 },
        { key: 'odd',    nameKey: 'mini.roulette.bet.odd',    payout: 2,  chance: 18 / 37 },
        { key: 'dozen',  nameKey: 'mini.roulette.bet.dozen',  payout: 3,  chance: 12 / 37 },
        { key: 'single', nameKey: 'mini.roulette.bet.single', payout: 12, chance: 1 / 37 }
      ],
      /** On a win the player may take the cash or a global income boost. */
      boostMult: 2.5,
      boostSeconds: 120,
      diamondsOnStraight: 3
    },
    blackjack: {
      /** Blackjack rewards diamonds + a dealer boost rather than raw cash. */
      diamondsWin: 4,
      diamondsBlackjack: 8,
      diamondsPush: 1,
      dealerBoostMult: 2,
      dealerBoostSeconds: 180,
      cashWinSeconds: 60,       // consolation cash = incomeRate * this
      cashWinMin: 100,
      decks: 6,
      dealerStandsOn: 17
    }
  },

  /** Monetization simulation (spec section 8). */
  monetization: {
    /**
     * Must stay >= adBoost.seconds*1000 so a boost always fully expires before
     * it can be refreshed — otherwise re-watching just before expiry chains
     * into a permanent multiplier. See adBoost below.
     */
    adCooldownMs: 240000,
    adBoost: { mult: 2, seconds: 180 },
    adDiamonds: 2,
    noAdsPriceKey: 'shop.price.noAds',
    diamondPacks: [
      { key: 'small',  nameKey: 'shop.pack.small',  priceKey: 'shop.price.small',  amount: 80 },
      { key: 'medium', nameKey: 'shop.pack.medium', priceKey: 'shop.price.medium', amount: 500 },
      { key: 'large',  nameKey: 'shop.pack.large',  priceKey: 'shop.price.large',  amount: 1500 },
      { key: 'mega',   nameKey: 'shop.pack.mega',   priceKey: 'shop.price.mega',   amount: 5000 }
    ],
    /** Things diamonds buy. */
    diamondSpends: [
      { key: 'skipCooldown', nameKey: 'shop.spend.skipCooldown', cost: 15 },
      { key: 'instantCash',  nameKey: 'shop.spend.instantCash',  cost: 25, seconds: 3600 },
      { key: 'megaBoost',    nameKey: 'shop.spend.megaBoost',    cost: 40, mult: 5, seconds: 600 }
    ]
  },

  /** World unlock pricing helper (mirrors WORLDS[i].unlockCost). */
  worlds: {
    /** Money from ANY unlocked world can pay for the next branch. */
    payFromAnyWorld: true
  },

  /** Rendering hints shared with renderer.js. */
  render: {
    maxPopups: 40,
    popupLife: 1.1,
    popupRise: 26,
    queueDotRadius: 3,
    guestRadius: 4.5,
    highlightPulse: 2.2
  }
};

/* ------------------------------------------------------------------ *
 *  TIERS — visual progression inside a single branch (spec section 2a)
 * ------------------------------------------------------------------ */

export const TIERS = [
  {
    tier: 1,
    key: 'grim',
    nameKey: 'tier.1.name',
    descKey: 'tier.1.desc',
    minInvestment: CONFIG.tier.thresholds[0],
    incomeMult: CONFIG.tier.incomeMult[0],
    palette: {
      floor: '#b7bfae',
      floorAlt: '#a6af9c',
      wall: '#8f9a86',
      wallTop: '#9fab92',
      accent: '#c7cc9c',
      neon: '#8ef7c8',
      carpet: '#8a7a5c',
      trim: '#9aa08a',
      light: 'rgba(220,255,220,0.10)',
      outline: '#2a2e22',
      shadow: 'rgba(20,25,15,0.30)',
      skirt: '#6b7560'
    },
    flicker: 0.35,
    chandeliers: 0,
    gold: 0
  },
  {
    tier: 2,
    key: 'warm',
    nameKey: 'tier.2.name',
    descKey: 'tier.2.desc',
    minInvestment: CONFIG.tier.thresholds[1],
    incomeMult: CONFIG.tier.incomeMult[1],
    palette: {
      floor: '#c98a52',
      floorAlt: '#b97a44',
      wall: '#a8663f',
      wallTop: '#c07f4c',
      accent: '#ffb238',
      neon: '#ffd76a',
      carpet: '#b23a4a',
      trim: '#d99a4e',
      light: 'rgba(255,205,140,0.18)',
      outline: '#3a1f10',
      shadow: 'rgba(30,15,8,0.32)',
      skirt: '#8a5a30'
    },
    flicker: 0.06,
    chandeliers: 2,
    gold: 0.3
  },
  {
    tier: 3,
    key: 'luxury',
    nameKey: 'tier.3.name',
    descKey: 'tier.3.desc',
    minInvestment: CONFIG.tier.thresholds[2],
    incomeMult: CONFIG.tier.incomeMult[2],
    palette: {
      floor: '#5c2a66',
      floorAlt: '#4e2258',
      wall: '#7a3f82',
      wallTop: '#8f52a0',
      accent: '#ffe066',
      neon: '#ff5ae0',
      carpet: '#7a0e30',
      trim: '#ffe066',
      light: 'rgba(255,230,180,0.28)',
      outline: '#200a26',
      shadow: 'rgba(25,5,20,0.40)',
      skirt: '#ffe066'
    },
    flicker: 0,
    chandeliers: 5,
    gold: 1
  }
];

/* ------------------------------------------------------------------ *
 *  WORLDS — the six branches of the empire (spec section 2b)
 * ------------------------------------------------------------------ */

export const WORLDS = [
  {
    id: 0,
    key: 'industrial',
    nameKey: 'world.industrial.name',
    descKey: 'world.industrial.desc',
    unlockCost: 0,
    incomeMult: 1,
    guestWealthMult: 1,
    spawnMult: 1,
    // BUGFIX: this used to be a blue-grey/wall pair whose HUE sat right in the
    // renderer's cyan/turquoise band — paletteFor() in renderer.js force-
    // saturates every world color (vivid()/hueForce()), so a ~200° input hue
    // came out as a swimming-pool cyan floor, not grim concrete. Floor/floorAlt
    // and skirt are re-hued to a steel-blue (~230°) and a rust-brown (~32°)
    // respectively, well clear of world 3 (cruise)'s genuine turquoise
    // (~180°). accent/neon were already correct (rust-orange / acid-green)
    // and are untouched. Verified against renderer.js's paletteFor()/vivid()/
    // hueTint() math for all 3 tiers — see the fix report for the numbers.
    palette: {
      floor: '#7c829c',
      floorAlt: '#686d87',
      wall: '#5f584e',
      accent: '#e8631c',
      neon: '#9dfa3c',
      carpet: '#8a5a34',
      faceTop: '#f0854a',
      faceLeft: '#e8631c',
      faceRight: '#b3480f',
      outline: '#241c14',
      shadow: 'rgba(20,15,10,0.35)',
      skirt: '#473e33'
    },
    unlockedByDefault: true
  },
  {
    id: 1,
    key: 'downtown',
    nameKey: 'world.downtown.name',
    descKey: 'world.downtown.desc',
    unlockCost: 200000,
    incomeMult: 3.6,
    guestWealthMult: 2.4,
    spawnMult: 1.35,
    palette: {
      floor: '#221c46',
      floorAlt: '#2c2456',
      wall: '#3a2f66',
      accent: '#ffcf3f',
      neon: '#ff2fb0',
      carpet: '#7a1f3a',
      faceTop: '#ffe28a',
      faceLeft: '#ffcf3f',
      faceRight: '#c99a1e',
      outline: '#160f30',
      shadow: 'rgba(10,8,25,0.40)',
      skirt: '#38e8ff'
    },
    unlockedByDefault: false
  },
  {
    id: 2,
    key: 'macau',
    nameKey: 'world.macau.name',
    descKey: 'world.macau.desc',
    unlockCost: 4500000,
    incomeMult: 14,
    guestWealthMult: 7,
    spawnMult: 1.15,
    palette: {
      floor: '#ece0c0',
      floorAlt: '#e0d2a8',
      wall: '#1f6b4a',
      accent: '#d4af37',
      neon: '#ff2d3c',
      carpet: '#7a1420',
      faceTop: '#2e8f63',
      faceLeft: '#1f6b4a',
      faceRight: '#134a33',
      outline: '#241608',
      shadow: 'rgba(20,10,5,0.35)',
      skirt: '#b8860b'
    },
    unlockedByDefault: false
  },
  {
    id: 3,
    key: 'cruise',
    nameKey: 'world.cruise.name',
    descKey: 'world.cruise.desc',
    unlockCost: 90000000,
    incomeMult: 55,
    guestWealthMult: 18,
    spawnMult: 1.55,
    palette: {
      floor: '#28c2c9',
      floorAlt: '#1fa8ae',
      wall: '#123f6b',
      accent: '#ffd23f',
      neon: '#38d6ff',
      carpet: '#0f5a6b',
      faceTop: '#5be0e6',
      faceLeft: '#28c2c9',
      faceRight: '#0f8a90',
      outline: '#08222e',
      shadow: 'rgba(5,20,25,0.32)',
      skirt: '#f4f7f0'
    },
    unlockedByDefault: false
  },
  {
    id: 4,
    key: 'speakeasy',
    nameKey: 'world.speakeasy.name',
    descKey: 'world.speakeasy.desc',
    unlockCost: 1800000000,
    incomeMult: 220,
    guestWealthMult: 46,
    spawnMult: 1.25,
    palette: {
      floor: '#5a3420',
      floorAlt: '#4a2a18',
      wall: '#6b4226',
      accent: '#c9973f',
      neon: '#ffb454',
      carpet: '#5c1220',
      faceTop: '#8a5a34',
      faceLeft: '#6b4226',
      faceRight: '#432815',
      outline: '#1c0f08',
      shadow: 'rgba(15,8,5,0.38)',
      skirt: '#c9973f'
    },
    unlockedByDefault: false
  },
  {
    id: 5,
    key: 'cyber',
    nameKey: 'world.cyber.name',
    descKey: 'world.cyber.desc',
    unlockCost: 40000000000,
    incomeMult: 900,
    guestWealthMult: 120,
    spawnMult: 1.8,
    palette: {
      floor: '#140a24',
      floorAlt: '#1c1030',
      wall: '#241640',
      accent: '#c8ff3c',
      neon: '#ff2bd6',
      carpet: '#1c1436',
      faceTop: '#39e8ff',
      faceLeft: '#00c2e0',
      faceRight: '#0090a8',
      outline: '#05030c',
      shadow: 'rgba(0,0,0,0.45)',
      skirt: '#ff2bd6'
    },
    unlockedByDefault: false
  }
];

/* ------------------------------------------------------------------ *
 *  VENUES — 10 buildable areas (spec section 4)
 *  kind 'gamble' produces income from guests; 'service' restores guests.
 * ------------------------------------------------------------------ */

export const VENUES = {
  slots: {
    key: 'slots',
    nameKey: 'venue.slots.name',
    descKey: 'venue.slots.desc',
    kind: 'gamble',
    baseCost: 30,
    costGrowth: 1.145,
    baseIncome: 1.1,
    incomeGrowth: 1.13,
    needsDealer: false,
    capacity: 1,
    serviceTime: 4,
    patienceRestore: 0,
    energyRestore: 0,
    riskBoost: 0,
    crowdPull: 0.05,
    footprint: { w: 1, h: 1 },
    maxCount: 30,
    order: 1
  },
  blackjack: {
    key: 'blackjack',
    nameKey: 'venue.blackjack.name',
    descKey: 'venue.blackjack.desc',
    kind: 'gamble',
    baseCost: 420,
    costGrowth: 1.175,
    baseIncome: 8.5,
    incomeGrowth: 1.14,
    needsDealer: true,
    capacity: 5,
    serviceTime: 9,
    patienceRestore: 0,
    energyRestore: 0,
    riskBoost: 0.04,
    crowdPull: 0.18,
    footprint: { w: 2, h: 2 },
    maxCount: 20,
    order: 2
  },
  roulette: {
    key: 'roulette',
    nameKey: 'venue.roulette.name',
    descKey: 'venue.roulette.desc',
    kind: 'gamble',
    baseCost: 1600,
    costGrowth: 1.185,
    baseIncome: 26,
    incomeGrowth: 1.145,
    needsDealer: true,
    capacity: 7,
    serviceTime: 12,
    patienceRestore: 0,
    energyRestore: 0,
    riskBoost: 0.06,
    crowdPull: 0.28,
    footprint: { w: 2, h: 2 },
    maxCount: 16,
    order: 3
  },
  craps: {
    key: 'craps',
    nameKey: 'venue.craps.name',
    descKey: 'venue.craps.desc',
    kind: 'gamble',
    baseCost: 6200,
    costGrowth: 1.195,
    baseIncome: 62,
    incomeGrowth: 1.15,
    needsDealer: true,
    capacity: 9,
    serviceTime: 14,
    patienceRestore: 0,
    energyRestore: 0,
    riskBoost: 0.12,
    crowdPull: 0.75,
    footprint: { w: 3, h: 2 },
    maxCount: 12,
    order: 4
  },
  sportsbook: {
    key: 'sportsbook',
    nameKey: 'venue.sportsbook.name',
    descKey: 'venue.sportsbook.desc',
    kind: 'gamble',
    baseCost: 24000,
    costGrowth: 1.2,
    baseIncome: 155,
    incomeGrowth: 1.155,
    needsDealer: false,
    capacity: 10,
    serviceTime: 18,
    patienceRestore: 6,
    energyRestore: 0,
    riskBoost: 0.1,
    crowdPull: 0.45,
    /** Periodic race event: every N seconds pays a burst worth M seconds of its income. */
    eventEvery: 75,
    eventBurstSeconds: 30,
    footprint: { w: 4, h: 2 },
    maxCount: 8,
    order: 5
  },
  wheel: {
    key: 'wheel',
    nameKey: 'venue.wheel.name',
    descKey: 'venue.wheel.desc',
    kind: 'gamble',
    baseCost: 95000,
    costGrowth: 1.21,
    baseIncome: 430,
    incomeGrowth: 1.16,
    needsDealer: true,
    capacity: 12,
    serviceTime: 10,
    patienceRestore: 10,
    energyRestore: 0,
    riskBoost: 0.15,
    crowdPull: 0.9,
    eventEvery: 45,
    eventBurstSeconds: 22,
    footprint: { w: 3, h: 3 },
    maxCount: 6,
    order: 6
  },
  vip: {
    key: 'vip',
    nameKey: 'venue.vip.name',
    descKey: 'venue.vip.desc',
    kind: 'gamble',
    baseCost: 450000,
    costGrowth: 1.225,
    baseIncome: 1700,
    incomeGrowth: 1.17,
    needsDealer: true,
    capacity: 2,
    serviceTime: 26,
    patienceRestore: 20,
    energyRestore: 15,
    riskBoost: 0.3,
    crowdPull: 0.1,
    vipOnly: true,
    footprint: { w: 3, h: 3 },
    maxCount: 6,
    order: 7
  },
  bar: {
    key: 'bar',
    nameKey: 'venue.bar.name',
    descKey: 'venue.bar.desc',
    kind: 'service',
    baseCost: 260,
    costGrowth: 1.16,
    baseIncome: 3.2,
    incomeGrowth: 1.12,
    needsDealer: false,
    capacity: 4,
    serviceTime: 7,
    patienceRestore: 45,
    energyRestore: 18,
    riskBoost: 0.22,
    crowdPull: 0.2,
    footprint: { w: 3, h: 1 },
    maxCount: 10,
    order: 8
  },
  buffet: {
    key: 'buffet',
    nameKey: 'venue.buffet.name',
    descKey: 'venue.buffet.desc',
    kind: 'service',
    baseCost: 1300,
    costGrowth: 1.17,
    baseIncome: 9,
    incomeGrowth: 1.125,
    needsDealer: false,
    capacity: 6,
    serviceTime: 12,
    patienceRestore: 22,
    energyRestore: 62,
    riskBoost: 0.08,
    crowdPull: 0.25,
    footprint: { w: 3, h: 2 },
    maxCount: 8,
    order: 9
  },
  showroom: {
    key: 'showroom',
    nameKey: 'venue.showroom.name',
    descKey: 'venue.showroom.desc',
    kind: 'service',
    baseCost: 16000,
    costGrowth: 1.19,
    baseIncome: 42,
    incomeGrowth: 1.14,
    needsDealer: false,
    capacity: 12,
    serviceTime: 20,
    patienceRestore: 60,
    energyRestore: 48,
    riskBoost: 0.28,
    crowdPull: 0.6,
    footprint: { w: 4, h: 3 },
    maxCount: 5,
    order: 10
  }
};

/* ------------------------------------------------------------------ *
 *  STATIONS — flow bottlenecks (spec section 3)
 * ------------------------------------------------------------------ */

export const STATIONS = {
  security: {
    key: 'security',
    nameKey: 'station.security.name',
    descKey: 'station.security.desc',
    baseCost: 90,
    costGrowth: 1.19,
    baseThroughput: 0.55,     // guests per second per unit at level 1
    throughputGrowth: 1.16,
    serviceTime: 1.8,
    footprint: { w: 1, h: 1 },
    maxCount: 8,
    order: 1
  },
  cashier: {
    key: 'cashier',
    nameKey: 'station.cashier.name',
    descKey: 'station.cashier.desc',
    baseCost: 140,
    costGrowth: 1.2,
    baseThroughput: 0.45,
    throughputGrowth: 1.18,
    serviceTime: 2.4,
    footprint: { w: 2, h: 1 },
    maxCount: 10,
    order: 2
  },
  tokenBooth: {
    key: 'tokenBooth',
    nameKey: 'station.tokenBooth.name',
    descKey: 'station.tokenBooth.desc',
    baseCost: 320,
    costGrowth: 1.185,
    baseThroughput: 0.8,
    throughputGrowth: 1.15,
    serviceTime: 1.2,
    /** Each unit keeps this many slot machines supplied. */
    slotsPerUnit: 6,
    footprint: { w: 1, h: 1 },
    maxCount: 8,
    order: 3
  }
};

/* ------------------------------------------------------------------ *
 *  STAFF — hired crew (spec section 7)
 *  count = how many are hired, level = shared training level.
 * ------------------------------------------------------------------ */

export const STAFF = {
  dealers: {
    key: 'dealers',
    nameKey: 'staff.dealers.name',
    descKey: 'staff.dealers.desc',
    baseCost: 180,
    costGrowth: 1.185,
    effectPerLevel: 0.09,     // +9% table output per level
    baseEffect: 1,
    maxCount: 40,
    order: 1
  },
  guards: {
    key: 'guards',
    nameKey: 'staff.guards.name',
    descKey: 'staff.guards.desc',
    baseCost: 260,
    costGrowth: 1.19,
    effectPerLevel: 0.12,     // +12% response radius & speed per level
    baseEffect: 1,
    maxCount: 20,
    order: 2
  },
  cleaners: {
    key: 'cleaners',
    nameKey: 'staff.cleaners.name',
    descKey: 'staff.cleaners.desc',
    baseCost: 150,
    costGrowth: 1.175,
    effectPerLevel: 0.1,
    baseEffect: 1,
    /** Cleanliness restored per second per cleaner (0..1 scale). */
    cleanPerSecond: 0.018,
    dirtPerGuestSecond: 0.0009,
    maxCount: 16,
    order: 3
  },
  cameras: {
    key: 'cameras',
    nameKey: 'staff.cameras.name',
    descKey: 'staff.cameras.desc',
    baseCost: 400,
    costGrowth: 1.2,
    effectPerLevel: 0.15,
    baseEffect: 1,
    maxCount: 24,
    order: 4
  }
};

/* ------------------------------------------------------------------ *
 *  SYSTEMS — atmosphere infrastructure (spec section 7)
 *  Level-only upgrades, no counts.
 * ------------------------------------------------------------------ */

export const SYSTEMS = {
  hvac: {
    key: 'hvac',
    nameKey: 'system.hvac.name',
    descKey: 'system.hvac.desc',
    baseCost: 900,
    costGrowth: 1.24,
    effectPerLevel: 0.06,     // -6% energy drain per level (multiplicative floor applied)
    maxLevel: 20,
    order: 1
  },
  lighting: {
    key: 'lighting',
    nameKey: 'system.lighting.name',
    descKey: 'system.lighting.desc',
    baseCost: 1100,
    costGrowth: 1.245,
    effectPerLevel: 0.05,     // -5% patience drain, +5% risk appetite per level
    maxLevel: 20,
    order: 2
  }
};

/* ------------------------------------------------------------------ *
 *  Derived helpers (pure lookups, no state)
 * ------------------------------------------------------------------ */

/** Ordered list of venue keys (stable UI order). */
export const VENUE_KEYS = Object.keys(VENUES).sort((a, b) => VENUES[a].order - VENUES[b].order);
export const STATION_KEYS = Object.keys(STATIONS).sort((a, b) => STATIONS[a].order - STATIONS[b].order);
export const STAFF_KEYS = Object.keys(STAFF).sort((a, b) => STAFF[a].order - STAFF[b].order);
export const SYSTEM_KEYS = Object.keys(SYSTEMS).sort((a, b) => SYSTEMS[a].order - SYSTEMS[b].order);

/** Definition table for a purchase kind, or null. */
export function defsFor(kind) {
  if (kind === 'venue') return VENUES;
  if (kind === 'station') return STATIONS;
  if (kind === 'staff') return STAFF;
  if (kind === 'system') return SYSTEMS;
  return null;
}

/** Single definition lookup; returns null instead of throwing. */
export function defOf(kind, key) {
  const table = defsFor(kind);
  if (!table) return null;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

/** World definition by id, falling back to world 0. */
export function worldDefById(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return WORLDS[0];
  return WORLDS[n] || WORLDS[0];
}

/** Tier definition (1..3) with clamping. */
export function tierDef(tier) {
  const idx = Math.max(0, Math.min(TIERS.length - 1, (Number(tier) || 1) - 1));
  return TIERS[idx];
}

export default CONFIG;
