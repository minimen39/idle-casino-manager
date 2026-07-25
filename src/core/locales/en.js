/**
 * en.js — English locale.
 *
 * Written as game copy, not a literal translation of he.js: short, punchy and
 * sized for a 411px phone (English words run longer than the Hebrew originals,
 * so HUD labels and buttons stay as tight as possible).
 * Flat keys only. Must stay key-for-key identical to he.js.
 *
 * Placeholders interpolate as {name} — see i18n.js `t(key, params)`.
 */

export default {
  /* ---------------------------------------------------------------- *
   *  App shell (index.html, manifest, boot screen)
   * ---------------------------------------------------------------- */
  'app.title': 'Idle Casino Manager',
  'app.name': 'Idle Casino Manager — Gambling Empire',
  'app.shortName': 'Casino Mgr',
  'app.description': 'Run your own casino, pack the floor with games, hire a crew and grow a gambling empire in this isometric idle tycoon.',
  'app.noscript': 'This game needs JavaScript to run. Please enable JavaScript in your browser and reload the page.',
  'app.loading': 'Loading casino…',

  /* ---------------------------------------------------------------- *
   *  Common
   * ---------------------------------------------------------------- */
  'common.close': 'Close',
  'common.dash': '—',

  /* ---------------------------------------------------------------- *
   *  Units. Only unit.perSecond / unit.perSecondFull are read (hud.js,
   *  worldMap.js). The compact-money suffixes below are the locale's declared
   *  vocabulary but are NOT wired: economy.fmtMoney formats from its own
   *  MONEY_UNITS table, which is identical in both locales.
   * ---------------------------------------------------------------- */
  'unit.perSecond': '/s',
  'unit.perSecondFull': '/sec',
  'unit.seconds': 'seconds',
  'unit.secondsShort': 's',
  'unit.minutes': 'minutes',
  'unit.minutesShort': 'min',
  'unit.k': 'K',
  'unit.m': 'M',
  'unit.b': 'B',
  'unit.t': 'T',
  'unit.qa': 'Qa',

  /* ---------------------------------------------------------------- *
   *  Language switcher
   * ---------------------------------------------------------------- */
  'lang.label': 'Language',
  'lang.he': 'עברית',
  'lang.en': 'English',
  // Compact glyphs for the 44px round HUD toggle. Intentionally IDENTICAL in
  // he.js and en.js: a language switcher names each language in its own
  // script, so these must not be translated.
  'lang.he.short': 'עב',
  'lang.en.short': 'EN',

  /* ---------------------------------------------------------------- *
   *  HUD
   * ---------------------------------------------------------------- */
  'hud.money': 'Cash:',
  // The noun only. hud.js appends unit.perSecond to the VALUE ("1.2K/s"), so a
  // unit in the label too printed it twice — and this is the longest chip in a
  // bar that has no room to spare on a 411px phone.
  'hud.income': 'Income:',
  'hud.diamonds': 'Gems:',
  'hud.guests': 'Guests:',
  'hud.tier': 'Tier',
  'hud.loading': 'Loading…',
  'hud.casino': 'Casino',

  /* ---------------------------------------------------------------- *
   *  Zoom cluster
   * ---------------------------------------------------------------- */
  'zoom.in': 'Zoom in',
  'zoom.out': 'Zoom out',
  'zoom.fit': 'Fit view',

  /* ---------------------------------------------------------------- *
   *  Build drawer
   * ---------------------------------------------------------------- */
  'panel.tab.venues': 'Venues',
  'panel.tab.stations': 'Stations',
  'panel.tab.staff': 'Staff',
  'panel.tab.systems': 'Systems',
  'panel.buy': 'Buy',
  'panel.buyX10': 'Buy ×10',
  'panel.upgrade': 'Upgrade',
  'panel.upgradeX10': 'Upgrade ×10',
  'panel.x10': 'Bulk ×10',
  'panel.max': 'Maxed',
  'panel.owned': 'Owned: {count}',
  'panel.ownedLevel': 'Owned: {count} (Lv {level})',
  'panel.level': 'Level {level}',
  'panel.drawerToggle': 'Open/close shop',

  /* ---------------------------------------------------------------- *
   *  Action bar
   * ---------------------------------------------------------------- */
  'action.worlds': '🌍 Worlds',
  'action.worldsTitle': 'World map',
  'action.roulette': '🎡 Roulette',
  'action.rouletteTitle': 'Roulette mini-game',
  'action.blackjack': '🃏 Blackjack',
  'action.blackjackTitle': 'Blackjack mini-game',
  'action.shop': '💎 Shop',
  'action.shopTitle': 'Gem shop',
  // The guide's entry point (main.js mountActionBar). A PLAIN TYPOGRAPHIC '?',
  // not the ❓ emoji it used to be: an emoji carries its own colour from the
  // font, so it ignored .action-btn--help's quiet `--btn-fg` and rendered as
  // the loudest thing on screen — a bright red glyph shouting louder than the
  // five primary destinations next to it. As text, CSS owns its colour.
  // '?' is bidi-neutral and not mirrored, so it renders identically in RTL,
  // hence the same glyph in both tables; the accessible name still comes from
  // action.helpTitle (a screen reader would otherwise say "question mark").
  'action.help': '?',
  'action.helpTitle': 'How to play',

  /* ---------------------------------------------------------------- *
   *  World map modal
   * ---------------------------------------------------------------- */
  'map.title': 'World Map',
  'map.money': 'Cash: {amount}',
  'map.income': 'Income: {amount}',
  'map.current': 'You are here',
  'map.switch': 'Go here',
  'map.unlock': 'Unlock',
  'map.unlockCost': 'Unlock: {amount}',
  'map.missing': 'Need {amount} more',
  'map.ready': 'Ready to unlock',
  'map.locked': 'Locked',
  'map.notEnough': 'Not enough cash to unlock this branch',
  'map.unlocked': 'New branch unlocked!',

  /* ---------------------------------------------------------------- *
   *  Tiers (visual progression inside a branch)
   * ---------------------------------------------------------------- */
  'tier.1.name': 'Rundown Joint',
  'tier.1.desc': 'Bare concrete, torn lino and flickering neon.',
  'tier.2.name': 'Proper Floor',
  'tier.2.desc': 'Wall-to-wall carpet, warm lights and padded tables.',
  'tier.3.name': 'Luxury Resort',
  'tier.3.desc': 'Plush carpet, chandeliers, gold trim and LED walls.',

  /* ---------------------------------------------------------------- *
   *  Worlds
   * ---------------------------------------------------------------- */
  'world.industrial.name': 'Industrial Zone',
  'world.industrial.desc': 'A rusty slot warehouse on the edge of town. Broke punters, cheap rent — it all starts here.',
  'world.downtown.name': 'Downtown Vegas',
  'world.downtown.desc': 'A buzzing neon strip downtown. Tourists, giant signs and a crowd that never thins out.',
  'world.macau.name': 'Macau',
  'world.macau.desc': 'A beachfront luxury resort with fountains and whales who bet fortunes on every hand.',
  'world.cruise.name': 'Casino Cruise',
  'world.cruise.desc': 'Gambling at sea. Tight decks, one-of-a-kind venues and guests stuck aboard for the whole trip.',
  'world.speakeasy.name': 'The Roaring 20s',
  'world.speakeasy.desc': 'A Prohibition back-room bar. Jazz, smuggled whiskey and gangsters with deep pockets.',
  'world.cyber.name': 'Neon Future',
  'world.cyber.desc': 'Holograms, robot dealers and glowing floors. Gambling at the speed of light.',

  /* ---------------------------------------------------------------- *
   *  Venues
   * ---------------------------------------------------------------- */
  'venue.slots.name': 'Slot Machines',
  'venue.slots.desc': 'Cheap to run, small but steady income. No dealer needed.',
  'venue.blackjack.name': 'Blackjack Table',
  'venue.blackjack.desc': 'Big earner, but every table needs a dealer of its own.',
  'venue.roulette.name': 'Roulette Table',
  'venue.roulette.desc': 'A classic — a crowd forms around the wheel. Needs a dealer.',
  'venue.craps.name': 'Craps Table',
  'venue.craps.desc': 'A loud group table that draws a crowd and pulls extra guests into the casino.',
  'venue.sportsbook.name': 'Live Sportsbook',
  'venue.sportsbook.desc': 'A wall of screens for sports and races, with a bonus payout every race.',
  'venue.wheel.name': 'Wheel of Fortune',
  'venue.wheel.desc': 'Spins on a timer, gathers a crowd and rains tips on the house.',
  'venue.vip.name': 'VIP Room',
  'venue.vip.desc': 'Few guests, huge stakes. Needs a dedicated dealer and flawless service.',
  'venue.bar.name': 'Bar',
  'venue.bar.desc': 'A drink refills patience and makes guests bet a lot bolder.',
  'venue.buffet.name': 'Buffet',
  'venue.buffet.desc': 'A hot meal restores energy and keeps guests on the floor longer.',
  'venue.showroom.name': 'Showroom',
  'venue.showroom.desc': 'A live show refills patience and energy at once, and lifts the whole floor.',

  /* ---------------------------------------------------------------- *
   *  Stations
   * ---------------------------------------------------------------- */
  'station.security.name': 'Security Check',
  'station.security.desc': 'ID checks at the door. A long line scares guests off before they even get in.',
  'station.cashier.name': 'Chip Cashier',
  'station.cashier.desc': 'Cash to chips on the way in, chips to cash on the way out — the main bottleneck.',
  'station.tokenBooth.name': 'Token Booth',
  'station.tokenBooth.desc': 'Feeds tokens to the slot floor. Without it the slot rows shut themselves down.',

  /* ---------------------------------------------------------------- *
   *  Staff
   * ---------------------------------------------------------------- */
  'staff.dealers.name': 'Dealers',
  'staff.dealers.desc': 'Every dealer table needs one. Upgrades speed up the deal and raise the house edge.',
  'staff.guards.name': 'Security Guards',
  'staff.guards.desc': 'Handle live events: thieves, cheats and angry guests.',
  'staff.cleaners.name': 'Cleaners',
  'staff.cleaners.desc': 'Keep the floor clean and cut venue downtime.',
  'staff.cameras.name': 'Security Cameras',
  'staff.cameras.desc': 'Auto-spot thieves and cheats, and raise your catch rate.',

  /* ---------------------------------------------------------------- *
   *  Systems
   * ---------------------------------------------------------------- */
  'system.hvac.name': 'Air & Cooling',
  'system.hvac.desc': 'Fresh air keeps guests around longer: their energy drains slower.',
  'system.lighting.name': 'Lighting & Mood',
  'system.lighting.desc': 'The right lighting calms the queues and makes guests gamble more.',

  /* ---------------------------------------------------------------- *
   *  Canvas actor markers (renderer.js MARK table).
   *  These are drawn as 11px nameplates over a figure's head, so they must
   *  stay SHORT — the renderer drops a plate that would overlap a neighbour.
   *  Role nouns, not sentences; the drawer's staff.* names are the long form.
   * ---------------------------------------------------------------- */
  'role.dealer.name': 'Dealer',
  'role.guard.name': 'Guard',
  'role.cleaner.name': 'Cleaner',
  'role.vipGuest.name': 'VIP',
  // Shown instead of the role when the STATE is the actionable thing.
  'state.guard.responding': 'Responding',
  'state.dealer.idle': 'No table',
  'state.guest.angry': 'Angry',

  /* ---------------------------------------------------------------- *
   *  Mini-games — shared
   * ---------------------------------------------------------------- */
  'mini.cooldown': 'Playable again in:',

  /* ---------------------------------------------------------------- *
   *  Mini-game — roulette
   * ---------------------------------------------------------------- */
  'mini.roulette.title': 'Roulette — High Roller',
  'mini.roulette.betAmount': 'Fixed bet: {amount}',
  'mini.roulette.spin': 'Spin',
  'mini.roulette.bet.red': 'Red',
  'mini.roulette.bet.black': 'Black',
  'mini.roulette.bet.even': 'Even',
  'mini.roulette.bet.odd': 'Odd',
  'mini.roulette.bet.dozen': 'Dozen',
  'mini.roulette.bet.single': 'Single',
  // Payout multiplier appended to each bet button ("Red (×2)").
  'mini.roulette.payoutTag': '(×{mult})',
  'mini.roulette.dozen.1': '1-12',
  'mini.roulette.dozen.2': '13-24',
  'mini.roulette.dozen.3': '25-36',
  'mini.roulette.color.red': 'red',
  'mini.roulette.color.black': 'black',
  'mini.roulette.color.green': 'green',
  'mini.roulette.pickNumber': '— pick a number —',
  'mini.roulette.needBet': 'Pick a bet type',
  'mini.roulette.needDozen': 'Pick a dozen',
  'mini.roulette.needNumber': 'Pick a number',
  'mini.roulette.noMoney': 'Not enough cash to bet',
  'mini.roulette.straight': 'Straight up! +{amount} gems',
  'mini.roulette.result': '{number} ({color})',
  'mini.roulette.win': 'You win! Payout: {amount}',
  'mini.roulette.lose': 'You lost the bet.',
  'mini.roulette.takeCash': 'Take cash',
  'mini.roulette.gotCash': 'Got {amount}',
  'mini.roulette.takeBoost': 'Take ×{mult} income',
  'mini.roulette.boostOn': 'Income boost on!',
  // The stake is settled the moment the wheel is spun, so the payout is
  // already in the wallet. These two say so: `banked` under the win line
  // (turning the choice into "keep this or trade it in"), `autoCollected` as a
  // toast when the modal is closed before the wheel finished.
  'mini.roulette.banked': 'Already added to your cash: {amount}',
  'mini.roulette.autoCollected': 'Winnings collected: {amount}',
  'mini.roulette.keepCash': 'Keep the cash',
  'mini.roulette.swapBoost': 'Swap for ×{mult} income',

  /* ---------------------------------------------------------------- *
   *  Mini-game — blackjack
   * ---------------------------------------------------------------- */
  'mini.blackjack.title': 'Blackjack — Dealer Challenge',
  'mini.blackjack.intro': 'One hand against the house dealer. Dealer stands on {value}.',
  'mini.blackjack.start': 'Deal',
  'mini.blackjack.dealer': 'Dealer',
  'mini.blackjack.dealerScore': 'Dealer ({value})',
  'mini.blackjack.player': 'You ({value})',
  'mini.blackjack.hit': 'Hit',
  'mini.blackjack.stand': 'Stand',
  'mini.blackjack.blackjack': 'Blackjack! Perfect hand',
  'mini.blackjack.win': 'You win!',
  'mini.blackjack.push': 'Push',
  'mini.blackjack.bust': 'Bust — you lose',
  'mini.blackjack.dealerBlackjack': 'Dealer blackjack — you lose',
  'mini.blackjack.lose': 'You lose',
  'mini.blackjack.pushToast': 'Push! +{amount} gems',
  'mini.blackjack.loseToast': 'You lost the hand',
  'mini.blackjack.takeDiamonds': 'Take {amount} 💎',
  'mini.blackjack.gotDiamonds': 'Got {amount} gems',
  'mini.blackjack.takeDealerBoost': 'Dealer boost ×{mult}',
  'mini.blackjack.dealerBoostOn': 'Dealer boost on!',
  'mini.blackjack.takeCash': 'Take cash',
  'mini.blackjack.gotCash': 'Got {amount}',
  // Closing a won hand used to burn the 15-minute cooldown and pay nothing;
  // the default reward (gems) is now granted on the way out and announced here.
  'mini.blackjack.autoCollected': 'Reward collected: {amount} 💎',

  /* ---------------------------------------------------------------- *
   *  Shop (IAP simulation)
   * ---------------------------------------------------------------- */
  'shop.title': 'Gem Shop',
  'shop.section.packs': 'Buy Gems',
  'shop.section.specials': 'Special Offers',
  'shop.section.spend': 'Spend Gems',
  'shop.pack.small': 'Handful of Gems',
  'shop.pack.medium': 'Bag of Gems',
  'shop.pack.large': 'Vault of Gems',
  'shop.pack.mega': 'Gem Mine',
  // NO shop.price.* keys, still. Prices are not translatable strings: when they
  // lived here, each table held an unrelated bare number and nothing tied a
  // pack's two prices together, so they drifted. They now live in
  // CONFIG.monetization.pricing as ONE price set per currency, and
  // priceSetFor(locale) hands monetization.js the whole set at once.
  // The owner's rule IS that currency follows the language (₪ for Hebrew,
  // $ for English), but it switches as a complete set — a language toggle can
  // never re-price one product against its neighbours the way it used to.
  'shop.noAds': 'Remove Ads',
  'shop.noAdsTag': '🚫📺 One-time',
  'shop.noAdsDone': '✓ Ads removed. Thanks for the support!',
  'shop.spend.skipCooldown': 'Reset Cooldowns',
  'shop.spend.instantCash': 'Instant Cash (1 hour)',
  'shop.spend.megaBoost': '×5 Boost for 10 min',
  'shop.bought': '✓ Bought {name} ({amount} gems)',
  'shop.itemCooldown': 'Back in {minutes} min',
  'shop.spendCooldown': 'Available again in {minutes} min',
  'shop.notEnough': 'Not enough gems',
  'shop.cooldownReset': '✓ Cooldowns reset',
  'shop.gotCash': '✓ Got {amount} cash',
  'shop.megaBoostOn': '✓ ×5 boost on for 10 minutes',
  // The `.shop-item.purchased::after` badge. CSS cannot call t(), so any code
  // that adds the class must also set `data-badge` to this string — the
  // stylesheet renders `content: attr(data-badge)` and holds no copy of its own.
  'shop.purchased': '✓ Owned',

  /* ---------------------------------------------------------------- *
   *  Rewarded ads
   * ---------------------------------------------------------------- */
  'ad.title': 'Watch an Ad',
  'ad.label': 'Watch it through and grab your reward!',
  'ad.skip': 'Skip',
  'ad.reward': '🎬 Ad bonus! +{amount} gems and 2x income',
  'ad.noAdsOwned': 'You already own Remove Ads',
  'ad.cooldown': 'Next ad available in {seconds}s',
  'ad.button': '🎬 Ad',
  'ad.buttonTitle': 'Watch an ad for a bonus',
  'ad.buttonCooldown': 'Ready in {seconds}s',

  /* ---------------------------------------------------------------- *
   *  Offline earnings
   * ---------------------------------------------------------------- */
  'offline.title': 'Offline Earnings',
  'offline.away': 'You were away for {time}',
  'offline.collect': 'Collect',
  'offline.double': '🎬 Double ×{mult}',
  'offline.toast': 'You earned {amount} while away',
  'offline.branch': 'Branch {id}',

  /* ---------------------------------------------------------------- *
   *  Live events
   * ---------------------------------------------------------------- */
  'event.flagged': 'The cameras flagged something suspicious!',

  'event.thief.label': 'Thief',
  'event.thief.spawn': 'A thief just grabbed a bag of cash!',
  'event.thief.player': 'You caught the thief! +{amount}',
  'event.thief.staff': 'Security caught the thief! +{amount}',
  'event.thief.escape': 'The thief got away with {amount}',

  'event.brinks.label': 'Armored Car',
  'event.brinks.spawn': 'The armored car is here for a pickup.',
  'event.brinks.done': 'The cash moved out safely. +{amount}',
  'event.brinks.escort': 'You walked the porters to the door! +{amount}',
  'event.brinks.robbed': 'Heist! The convoy was hit for {amount}',

  'event.robber.label': 'Robber',
  'event.robber.spawn': 'A robber is going for the convoy!',
  'event.robber.stopped': 'Heist stopped! +{amount}',

  'event.counter.label': 'Card Counter',
  'event.counter.spawn': 'Someone may be counting cards at a table...',
  'event.counter.player': 'You threw out the card counter! +{amount}',
  'event.counter.staff': 'Security threw out the card counter. +{amount}',
  'event.counter.escape': 'The card counter slipped away with {amount}',

  'event.angry.label': 'Angry Guest',
  'event.angry.spawn': 'An angry guest is making a scene!',
  'event.angry.player': 'You calmed the angry guest down. +{amount}',
  'event.angry.staff': 'Security calmed the angry guest down. +{amount}',
  'event.angry.escape': 'The angry guest killed the mood. -{amount}',

  'event.vip.label': 'VIP Guest',
  'event.vip.spawn': 'A celebrity just walked in!',
  'event.vip.escort': 'You escorted the VIP! ×{mult} income for {seconds}s. +{amount}',
  'event.vip.left': 'The VIP left without getting any attention.',

  /* ---------------------------------------------------------------- *
   *  PWA install / update
   * ---------------------------------------------------------------- */
  'pwa.install': '📲 Install App',
  'pwa.installTitle': 'Add the game to your home screen',
  'pwa.installAria': 'Install app',
  'pwa.installing': 'Installing the game…',
  'pwa.installed': 'Installed! You can open it from your home screen 🎰',
  'pwa.update': 'A new version of the game is available',
  'pwa.updateToast': 'New version available — tap Refresh',
  'pwa.refresh': 'Refresh',
  // The Refresh button's busy state. NOT hud.loading ("Loading…"): the pending
  // version is being applied, nothing is loading.
  'pwa.updating': 'Updating…',
  'pwa.helpInApp': 'This page opened in an in-app browser (inside WhatsApp, for example) that cannot install apps and does not keep your progress in the same place. Open the ⋮ menu and choose "Open in browser" (Chrome), then in the Chrome ⋮ menu choose "Install app".',
  'pwa.helpChrome': 'Open the Chrome ⋮ menu and choose "Install app" to add the game to your home screen.',
  'pwa.offlineTitle': 'Offline',
  'pwa.offlineLine1': 'The game is not available offline.',
  'pwa.offlineLine2': 'Reconnect to the network and try again.',

  /* ---------------------------------------------------------------- *
   *  First-run guide (src/ui/tutorial.js coach marks)
   * ---------------------------------------------------------------- */
  'tutorial.next': 'Next',
  'tutorial.skip': 'Skip',
  'tutorial.progress': '{current} of {total}',
  'tutorial.finish': 'Let me play',
  'tutorial.replay': 'Replay the tutorial',

  'tutorial.step.welcome.title': 'Welcome to the floor',
  'tutorial.step.welcome.body': 'Guests walk in, swap cash for chips, gamble, and the house keeps a cut of every bet. Your job is to clear whatever slows that line down.',
  'tutorial.step.money.title': 'Cash and income',
  'tutorial.step.money.body': 'Cash belongs to this branch alone — every casino you own keeps its own till. Income is what the floor earns every second, with you or without you. Gems are shared across the whole empire.',
  'tutorial.step.tier.title': 'The tier bar fills when you spend',
  'tutorial.step.tier.body': "Your tier is measured by how much you've invested in this branch, not by how much cash you're sitting on. Keep buying: every tier repaints the whole place and lifts all your income.",
  'tutorial.step.drawer.title': 'Your build drawer',
  'tutorial.step.drawer.body': 'Everything you can build, hire or upgrade lives behind this handle. Swipe it up to open the drawer.',
  'tutorial.step.slots.title': 'Buy your first machine',
  'tutorial.step.slots.body': 'Slots are cheap, need no dealer and pay all day. Buy one — the floor lays itself out, you never place anything by hand.',
  'tutorial.step.cashier.title': 'The cashier is the bottleneck',
  'tutorial.step.cashier.body': 'Every guest turns cash into chips here before they gamble, and cashes out on the way home. One cashier means one queue — when their patience runs out they walk straight back out without betting a cent. Add cashiers the moment the line gets long.',
  'tutorial.step.dealers.title': 'Hire the dealer first',
  'tutorial.step.dealers.body': 'Blackjack, roulette, craps, the wheel and the VIP room each need a dealer of their own. A table with no dealer earns exactly nothing — so hire first, buy second.',
  // Not part of the numbered sequence: a one-off card shown the first time the
  // player is free to poke at the floor itself.
  'tutorial.step.tap.title': 'Tap the floor',
  'tutorial.step.tap.body': "Tap a guest and they'll tip you. And when a thief, a card counter or an angry guest turns up — tap them before they get away. Every one that escapes costs you cash.",
  'tutorial.doneTitle': "You're running the place",
  // Quotes the glyph the dock actually shows now (action.help), not the old ❓.
  'tutorial.doneBody': "That's the whole loop. Everything else is waiting behind the “?” button whenever you need it.",

  /* ---------------------------------------------------------------- *
   *  Help modal (the reopenable "?" guide, four tabbed pages)
   * ---------------------------------------------------------------- */
  'help.title': 'How to Play',
  'help.tab.loop': 'The Loop',
  'help.tab.build': 'Building',
  'help.tab.floor': 'On the Floor',
  'help.tab.empire': 'Empire',

  'help.loop.title': 'The core loop',
  'help.loop.body': 'A guest walks in, gets checked at the door, swaps cash for chips at the cashier, plays until their patience or energy runs out, tops up at the bar, buffet or showroom, then cashes out and leaves. The house keeps a cut of every wager — that cut is your income.',
  'help.currency.title': 'Cash and gems',
  'help.currency.body': "Cash is per branch: every casino you own keeps its own till, and a branch you aren't watching keeps earning at half rate. Gems are shared across the whole empire and buy cooldown resets, instant cash and big boosts.",

  'help.build.title': 'Venues, stations, staff and systems',
  'help.build.body': "Venues either earn (the gambling ones) or restore your guests (bar, buffet, showroom). Stations are the flow: the door check, the chip cashier, and the token booth that keeps the slots fed. Staff are your dealers, guards, cleaners and cameras. Systems are air and lighting, which keep guests on the floor longer. Everything you buy places itself — there's no manual layout.",
  'help.dealers.title': 'Tables need dealers',
  'help.dealers.body': 'Blackjack, roulette, craps, the wheel and the VIP room need one dealer per table. Buy more tables than you have dealers and the extras just stand there earning nothing. Hire first.',
  'help.tier.title': 'Tiers',
  'help.tier.body': 'Each branch has three tiers, from a rundown joint to a luxury resort. You climb by total spending in that branch, not by savings, and you never lose a tier. Every tier repaints the floor and multiplies your income.',

  'help.events.title': 'Live events',
  'help.events.body': 'Thieves, card counters, angry guests, armoured-car pickups and VIP arrivals turn up on the floor while you play. Tap one to handle it yourself and take the full reward; your guards and cameras will get there eventually for a smaller one. Anything that gets away costs you cash or kills the mood.',
  'help.tips.title': 'Tips and camera',
  'help.tips.body': 'Tap any guest for a tip and a little extra patience. Drag to move the view, pinch to zoom, and the ⛶ button frames the whole floor again.',
  'help.minigames.title': 'Mini-games',
  'help.minigames.body': "Roulette and blackjack each open once every 15 minutes. Roulette stakes a fixed slice of your income — early on that's most of your cash, so don't spin what you can't afford to lose. Blackjack pays gems and a dealer boost instead of cash.",

  'help.worlds.title': 'New branches',
  'help.worlds.body': "Six branches, opened in order, each far richer than the last. Cash from every branch you own counts towards the next one, and they all keep earning in parallel — you never start over. The first, Downtown Vegas, opens at 200,000: that's a long way from your first slot machine, and it's meant to be.",
  'help.offline.title': "While you're away",
  'help.offline.body': 'The casino keeps earning while it is closed, at half rate, for up to 8 hours. Come back and collect — an ad doubles the payout.'
};
