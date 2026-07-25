/**
 * he.js — Hebrew locale (the game's original language).
 *
 * Flat keys only. Must stay key-for-key identical to en.js.
 *
 * REGISTER (one register, no exceptions): the game speaks to ONE player, so
 * every instruction is second-person masculine SINGULAR — 'קנה', 'שדרג',
 * 'אסוף', 'פתח', 'התחבר'. The file used to mix in polite plurals ('נהלו',
 * 'פתחו', 'הקישו') on the PWA/shell strings, which read like a group briefing
 * two lines below a 'קנה' button. Anything added here follows the singular.
 * Impersonal/generic phrasing ('מגייסים', 'קונים') is fine — it is not a
 * second register, it is the same voice describing a habit.
 *
 * No English words inside Hebrew strings (the titles used to read
 * 'רולטה — High Roller'), and no glossing in parentheses on buttons.
 * 'בלאקג׳ק' is spelled as one word everywhere.
 *
 * Placeholders interpolate as {name} — see i18n.js `t(key, params)`.
 */

export default {
  /* ---------------------------------------------------------------- *
   *  App shell (index.html, manifest, boot screen)
   * ---------------------------------------------------------------- */
  // Tab title / task switcher. One language only — it used to carry the
  // English brand AND a Hebrew name in the same line.
  'app.title': 'מנהל קזינו',
  'app.name': 'מנהל קזינו — אימפריית הימורים',
  'app.shortName': 'מנהל קזינו',
  'app.description': 'נהל את הקזינו שלך, מלא את האולם במשחקים, גייס צוות ובנה אימפריית הימורים במשחק סרק איזומטרי.',
  // Mirrored as a literal in index.html's <noscript> — a crawler and a
  // JS-disabled browser never reach this table. Keep the two in step.
  'app.noscript': 'המשחק דורש JavaScript כדי לרוץ. הפעל JavaScript בדפדפן וטען מחדש את הדף.',
  'app.loading': 'טוען קזינו…',

  /* ---------------------------------------------------------------- *
   *  Common
   * ---------------------------------------------------------------- */
  'common.close': 'סגור',
  'common.dash': '—',

  /* ---------------------------------------------------------------- *
   *  Units. Only unit.perSecond / unit.perSecondFull are read (hud.js,
   *  worldMap.js). The compact-money suffixes below are the locale's declared
   *  vocabulary but are NOT wired: economy.fmtMoney formats from its own
   *  MONEY_UNITS table, which is identical in both locales.
   * ---------------------------------------------------------------- */
  'unit.perSecond': '/ש׳',
  'unit.perSecondFull': '/שנ׳',
  'unit.seconds': 'שניות',
  'unit.secondsShort': 'שנ׳',
  'unit.minutes': 'דקות',
  'unit.minutesShort': 'דק׳',
  'unit.k': 'K',
  'unit.m': 'M',
  'unit.b': 'B',
  'unit.t': 'T',
  'unit.qa': 'Qa',

  /* ---------------------------------------------------------------- *
   *  Language switcher
   * ---------------------------------------------------------------- */
  'lang.label': 'שפה',
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
  'hud.money': 'קופה:',
  // The noun only. hud.js appends unit.perSecond to the VALUE ("1.2K/ש׳"), so
  // 'הכנסה/שנייה:' printed the unit twice — and it was the longest chip in a
  // bar that has no room to spare on a 411px phone.
  'hud.income': 'הכנסה:',
  'hud.diamonds': 'יהלומים:',
  'hud.guests': 'אורחים:',
  'hud.tier': 'דרגה',
  'hud.loading': 'טוען…',
  'hud.casino': 'קזינו',

  /* ---------------------------------------------------------------- *
   *  Zoom cluster
   * ---------------------------------------------------------------- */
  'zoom.in': 'התקרב',
  'zoom.out': 'התרחק',
  'zoom.fit': 'מרכז מפה',

  /* ---------------------------------------------------------------- *
   *  Build drawer
   * ---------------------------------------------------------------- */
  'panel.tab.venues': 'מתחמים',
  'panel.tab.stations': 'עמדות',
  'panel.tab.staff': 'צוות',
  'panel.tab.systems': 'מערכות',
  'panel.buy': 'קנה',
  'panel.buyX10': 'קנה ×10',
  'panel.upgrade': 'שדרג',
  'panel.upgradeX10': 'שדרג ×10',
  'panel.x10': 'קנייה פי 10',
  'panel.max': 'מקסימום',
  'panel.owned': 'בבעלות: {count}',
  'panel.ownedLevel': 'בבעלות: {count} (רמה {level})',
  'panel.level': 'רמה {level}',
  'panel.drawerToggle': 'פתח/סגור חנות',

  /* ---------------------------------------------------------------- *
   *  Action bar
   * ---------------------------------------------------------------- */
  'action.worlds': '🌍 עולמות',
  'action.worldsTitle': 'מפת העולמות',
  'action.roulette': '🎡 רולטה',
  'action.rouletteTitle': 'מיני-משחק רולטה',
  'action.blackjack': '🃏 בלאקג׳ק',
  'action.blackjackTitle': 'מיני-משחק בלאקג׳ק',
  'action.shop': '💎 חנות',
  'action.shopTitle': 'חנות יהלומים',
  // The guide's entry point (main.js mountActionBar). A PLAIN TYPOGRAPHIC '?',
  // not the ❓ emoji it used to be: an emoji carries its own colour from the
  // font, so it ignored .action-btn--help's quiet `--btn-fg` and rendered as
  // the loudest thing on screen. As text, CSS owns its colour.
  // Hebrew uses the same '?' character as Latin, and it is bidi-neutral (not a
  // mirrored pair like parentheses), so it renders identically inside the RTL
  // dock; the accessible name still comes from action.helpTitle.
  'action.help': '?',
  'action.helpTitle': 'איך משחקים',

  /* ---------------------------------------------------------------- *
   *  World map modal
   * ---------------------------------------------------------------- */
  'map.title': 'מפת עולמות',
  'map.money': 'קופה: {amount}',
  'map.income': 'הכנסה: {amount}',
  'map.current': 'הסניף הנוכחי',
  'map.switch': 'עבור לסניף',
  'map.unlock': 'פתח סניף',
  'map.unlockCost': 'עלות פתיחה: {amount}',
  'map.missing': 'חסר: {amount}',
  'map.ready': 'מוכן לפתיחה',
  'map.locked': 'נעול',
  'map.notEnough': 'אין מספיק כסף כדי לפתוח את הסניף הזה',
  'map.unlocked': 'סניף חדש נפתח!',

  /* ---------------------------------------------------------------- *
   *  Tiers (visual progression inside a branch)
   * ---------------------------------------------------------------- */
  'tier.1.name': 'מתחם מוזנח',
  'tier.1.desc': 'בטון חשוף, לינוליאום קרוע וניאון מרצד.',
  'tier.2.name': 'מתחם מסודר',
  'tier.2.desc': 'שטיח מקיר לקיר, תאורה חמה ושולחנות מרופדים.',
  'tier.3.name': 'מתחם יוקרה',
  'tier.3.desc': 'שטיחי יוקרה, שנדלירים, עץ וזהב ומסכי לד.',

  /* ---------------------------------------------------------------- *
   *  Worlds
   * ---------------------------------------------------------------- */
  'world.industrial.name': 'אזור תעשייה מוזנח',
  'world.industrial.desc': 'מחסן סלוטים חלוד בשולי העיר. לקוחות דלי אמצעים, שכירות זולה, הכל מתחיל כאן.',
  'world.downtown.name': 'דאונטאון וגאס',
  'world.downtown.desc': 'רחוב ניאון תוסס במרכז העיר. תיירים, שלטי ענק וזרם אורחים בלתי פוסק.',
  'world.macau.name': 'מאקאו',
  'world.macau.desc': 'ריזורט יוקרה על החוף עם מזרקות מים ומהמרים כבדים שמניחים סכומי עתק.',
  'world.cruise.name': 'אוניית קזינו',
  'world.cruise.desc': 'הימורים בלב ים. סיפון צר, מתחמים ייחודיים ואורחים שבויים לכל ההפלגה.',
  'world.speakeasy.name': 'שנות ה-20',
  'world.speakeasy.desc': 'בר מחתרתי מימי היובש. ג׳אז, ויסקי מוברח וגנגסטרים עם כיסים עמוקים.',
  'world.cyber.name': 'קזינו עתידני',
  'world.cyber.desc': 'הולוגרמות, דילרים רובוטיים ורצפות תאורה. הימורים במהירות האור.',

  /* ---------------------------------------------------------------- *
   *  Venues
   * ---------------------------------------------------------------- */
  'venue.slots.name': 'מכונות סלוטים',
  'venue.slots.desc': 'זול לתפעול, הכנסה נמוכה אך יציבה. לא דורש דילר.',
  'venue.blackjack.name': 'שולחן בלאקג׳ק',
  'venue.blackjack.desc': 'הכנסה גבוהה, אך כל שולחן חייב דילר משלו.',
  'venue.roulette.name': 'שולחן רולטה',
  'venue.roulette.desc': 'קלאסיקה עם קהל סביב הגלגל. דורש דילר.',
  'venue.craps.name': 'שולחן קרפס',
  'venue.craps.desc': 'שולחן קבוצתי רועש שיוצר התקהלות ומושך אורחים נוספים לקזינו.',
  'venue.sportsbook.name': 'זירת ספורט לייב',
  'venue.sportsbook.desc': 'קיר מסכים להימורי ספורט ומרוצים, עם אירועי מרוץ תקופתיים ובונוס.',
  'venue.wheel.name': 'גלגל המזל',
  'venue.wheel.desc': 'הפעלה תקופתית שמייצרת התקהלות ומטר טיפים לקזינו.',
  'venue.vip.name': 'חדר VIP',
  'venue.vip.desc': 'מעט אורחים, סכומי עתק. דורש דילר צמוד ושירות ללא דופי.',
  'venue.bar.name': 'בר',
  'venue.bar.desc': 'משקה מרענן את הסבלנות ומעלה משמעותית את הנטייה לסיכון.',
  'venue.buffet.name': 'בופה',
  'venue.buffet.desc': 'ארוחה חמה שמחזירה אנרגיה ומאריכה את זמן השהייה בקזינו.',
  'venue.showroom.name': 'אולם הופעות',
  'venue.showroom.desc': 'מופע חי שממלא סבלנות ואנרגיה גם יחד ומקפיץ את מצב הרוח בקזינו.',

  /* ---------------------------------------------------------------- *
   *  Stations
   * ---------------------------------------------------------------- */
  'station.security.name': 'עמדת בידוק',
  'station.security.desc': 'בדיקת תעודות בכניסה. תור ארוך מבריח אורחים עוד לפני שנכנסו.',
  'station.cashier.name': 'קופת צ׳יפים',
  'station.cashier.desc': 'המרת מזומן לצ׳יפים בכניסה ופדיון ביציאה — צוואר הבקבוק המרכזי.',
  'station.tokenBooth.name': 'עמדת פריטה',
  'station.tokenBooth.desc': 'אסימונים למתחם הסלוטים. בלעדיה שורות הסלוטים משביתות את עצמן.',

  /* ---------------------------------------------------------------- *
   *  Staff
   * ---------------------------------------------------------------- */
  'staff.dealers.name': 'דילרים',
  'staff.dealers.desc': 'כל שולחן דילר חייב דילר. שדרוג מעלה את מהירות החלוקה ואת אחוז הבית.',
  'staff.guards.name': 'מאבטחים',
  'staff.guards.desc': 'מגיבים לאירועים בזמן אמת: גנבים, רמאים ולקוחות זועמים.',
  'staff.cleaners.name': 'עובדי ניקיון',
  'staff.cleaners.desc': 'שומרים על ניקיון הרצפה ומקצרים זמני השבתה של מתחמים.',
  'staff.cameras.name': 'מצלמות אבטחה',
  'staff.cameras.desc': 'מזהות אוטומטית גנבים ורמאים ומגדילות את סיכויי התפיסה.',

  /* ---------------------------------------------------------------- *
   *  Systems
   * ---------------------------------------------------------------- */
  'system.hvac.name': 'מיזוג וחמצן',
  'system.hvac.desc': 'אוויר צח מאריך את זמן השהייה: אנרגיה של האורחים יורדת לאט יותר.',
  'system.lighting.name': 'תאורה ואווירה',
  'system.lighting.desc': 'תאורה נכונה מרגיעה תורים ומעלה את הנטייה של האורחים להמר.',

  /* ---------------------------------------------------------------- *
   *  Canvas actor markers (renderer.js MARK table).
   *  These are drawn as 11px nameplates over a figure's head, so they must
   *  stay SHORT — the renderer drops a plate that would overlap a neighbour.
   *  Role nouns, not sentences; the drawer's staff.* names are the long form.
   * ---------------------------------------------------------------- */
  'role.dealer.name': 'דילר',
  'role.guard.name': 'מאבטח',
  'role.cleaner.name': 'ניקיון',
  'role.vipGuest.name': 'אורח VIP',
  // Shown instead of the role when the STATE is the actionable thing.
  'state.guard.responding': 'בדרך לאירוע',
  'state.dealer.idle': 'ללא שולחן',
  'state.guest.angry': 'זועם',

  /* ---------------------------------------------------------------- *
   *  Mini-games — shared
   * ---------------------------------------------------------------- */
  'mini.cooldown': 'המשחק יהיה זמין שוב בעוד:',

  /* ---------------------------------------------------------------- *
   *  Mini-game — roulette
   * ---------------------------------------------------------------- */
  'mini.roulette.title': 'רולטה — מהמר כבד',
  'mini.roulette.betAmount': 'הימור קבוע: {amount}',
  'mini.roulette.spin': 'סובב',
  'mini.roulette.bet.red': 'אדום',
  'mini.roulette.bet.black': 'שחור',
  'mini.roulette.bet.even': 'זוגי',
  'mini.roulette.bet.odd': 'אי-זוגי',
  'mini.roulette.bet.dozen': 'תריסר',
  'mini.roulette.bet.single': 'מספר בודד',
  // Payout multiplier appended to each bet button ("אדום (×2)").
  'mini.roulette.payoutTag': '(×{mult})',
  'mini.roulette.dozen.1': '1-12',
  'mini.roulette.dozen.2': '13-24',
  'mini.roulette.dozen.3': '25-36',
  'mini.roulette.color.red': 'אדום',
  'mini.roulette.color.black': 'שחור',
  'mini.roulette.color.green': 'ירוק',
  'mini.roulette.pickNumber': '— בחר מספר —',
  'mini.roulette.needBet': 'בחר סוג הימור',
  'mini.roulette.needDozen': 'בחר תריסר',
  'mini.roulette.needNumber': 'בחר מספר',
  'mini.roulette.noMoney': 'אין מספיק כסף להימור',
  'mini.roulette.straight': 'פגיעה במספר בודד! +{amount} יהלומים',
  'mini.roulette.result': 'יצא {number} ({color})',
  // Not 'זכייה אפשרית' — settleRouletteBet already paid it.
  'mini.roulette.win': 'ניצחת! זכייה: {amount}',
  'mini.roulette.lose': 'הפסדת את ההימור.',
  'mini.roulette.takeCash': 'קח מזומן',
  'mini.roulette.gotCash': 'קיבלת {amount}',
  'mini.roulette.takeBoost': 'קח בוסט הכנסה ×{mult}',
  'mini.roulette.boostOn': 'בוסט הכנסה פעיל!',
  // The stake is settled the moment the wheel is spun, so the payout is
  // already in the wallet. These two say so: `banked` under the win line
  // (turning the choice into "keep this or trade it in"), `autoCollected` as a
  // toast when the modal is closed before the wheel finished.
  'mini.roulette.banked': 'כבר נכנס לקופה: {amount}',
  'mini.roulette.autoCollected': 'הזכייה נכנסה לקופה: {amount}',
  'mini.roulette.keepCash': 'השאר במזומן',
  'mini.roulette.swapBoost': 'החלף בהכנסה ×{mult}',

  /* ---------------------------------------------------------------- *
   *  Mini-game — blackjack
   * ---------------------------------------------------------------- */
  'mini.blackjack.title': 'בלאקג׳ק — אתגר הדילר',
  'mini.blackjack.intro': 'יד אחת מול הדילר הראשי. הדילר עוצר על {value}.',
  'mini.blackjack.start': 'התחל יד',
  'mini.blackjack.dealer': 'דילר',
  'mini.blackjack.dealerScore': 'דילר ({value})',
  // 'אתה', not 'שחקן': the other side of the table is the player himself.
  'mini.blackjack.player': 'אתה ({value})',
  // No English glossing in parentheses — it also blew the button width.
  'mini.blackjack.hit': 'קח קלף',
  'mini.blackjack.stand': 'עצור',
  'mini.blackjack.blackjack': 'בלאקג׳ק! יד מושלמת',
  'mini.blackjack.win': 'ניצחת!',
  'mini.blackjack.push': 'תיקו',
  'mini.blackjack.bust': 'נשרפת — הפסד',
  'mini.blackjack.dealerBlackjack': 'לדילר בלאקג׳ק — הפסד',
  'mini.blackjack.lose': 'הפסדת',
  'mini.blackjack.pushToast': 'תיקו! קיבלת {amount} יהלומים',
  'mini.blackjack.loseToast': 'הפסדת את היד',
  'mini.blackjack.takeDiamonds': 'קח {amount} 💎',
  'mini.blackjack.gotDiamonds': 'קיבלת {amount} יהלומים',
  'mini.blackjack.takeDealerBoost': 'בוסט לדילרים ×{mult}',
  'mini.blackjack.dealerBoostOn': 'בוסט לדילרים פעיל!',
  'mini.blackjack.takeCash': 'קח מזומן',
  'mini.blackjack.gotCash': 'קיבלת {amount}',
  // Closing a won hand used to burn the 15-minute cooldown and pay nothing;
  // the default reward (gems) is now granted on the way out and announced here.
  'mini.blackjack.autoCollected': 'קיבלת את הפרס: {amount} 💎',

  /* ---------------------------------------------------------------- *
   *  Shop (IAP simulation)
   * ---------------------------------------------------------------- */
  'shop.title': 'חנות יהלומים',
  'shop.section.packs': 'קניית יהלומים',
  // 'מבצעים', not 'הנחות': the section sells a one-time unlock, not a discount.
  'shop.section.specials': 'מבצעים מיוחדים',
  'shop.section.spend': 'הוצאת יהלומים',
  'shop.pack.small': 'חופן יהלומים',
  'shop.pack.medium': 'שק יהלומים',
  'shop.pack.large': 'כספת יהלומים',
  'shop.pack.mega': 'מכרה יהלומים',
  // NO shop.price.* keys, still. Prices are not translatable strings: when they
  // lived here, each table held an unrelated bare number and nothing tied a
  // pack's two prices together, so they drifted. They now live in
  // CONFIG.monetization.pricing as ONE price set per currency, and
  // priceSetFor(locale) hands monetization.js the whole set at once.
  // The owner's rule IS that currency follows the language (₪ for Hebrew,
  // $ for English), but it switches as a complete set — a language toggle can
  // never re-price one product against its neighbours the way it used to.
  'shop.noAds': 'ללא פרסומות',
  'shop.noAdsTag': '🚫📺 חד-פעמי',
  'shop.noAdsDone': '✓ פרסומות הופסקו! תודה על התמיכה.',
  'shop.spend.skipCooldown': 'איפוס זמן צינון',
  'shop.spend.instantCash': 'מזומן מיידי (שעה)',
  'shop.spend.megaBoost': 'בוסטר ×5 ל-10 דקות',
  'shop.bought': '✓ קנית {name} ({amount} יהלומים)',
  'shop.itemCooldown': 'זמין שוב בעוד {minutes} דק׳',
  'shop.spendCooldown': 'פעולה זו זמינה שוב בעוד {minutes} דקות',
  'shop.notEnough': 'יהלומים לא מספיקים',
  'shop.cooldownReset': '✓ זמני הצינון אופסו',
  'shop.gotCash': '✓ קיבלת {amount} מזומן',
  'shop.megaBoostOn': '✓ בוסטר ×5 הופעל ל-10 דקות',
  // '✓ נרכש' — the old '✓ רכוש' is the noun 'property' / the imperative
  // 'acquire!', not 'purchased'. The `.shop-item.purchased::after` badge
  // renders `content: attr(data-badge)`, so whoever adds the class must set
  // data-badge to this string; the stylesheet holds no copy of its own.
  'shop.purchased': '✓ נרכש',

  /* ---------------------------------------------------------------- *
   *  Rewarded ads
   * ---------------------------------------------------------------- */
  'ad.title': 'צפייה בפרסומת',
  'ad.label': 'סיים את הצפייה וקבל את הפרס!',
  'ad.skip': 'דלג',
  'ad.reward': '🎬 קיבלת בונוס פרסומת! +{amount} יהלומים ו-2x הכנסה',
  'ad.noAdsOwned': 'כבר רכשת את חבילת "ללא פרסומות"',
  'ad.cooldown': 'הפרסומת הבאה זמינה בעוד {seconds} שניות',
  'ad.button': '🎬 פרסומת',
  'ad.buttonTitle': 'צפה בפרסומת לבונוס',
  // 'שנ׳' (unit.secondsShort), not a bare English 's'.
  'ad.buttonCooldown': 'זמין בעוד {seconds} שנ׳',

  /* ---------------------------------------------------------------- *
   *  Offline earnings
   * ---------------------------------------------------------------- */
  'offline.title': 'רווחי אופליין',
  'offline.away': 'היית מחוץ למשחק {time}',
  'offline.collect': 'אסוף',
  'offline.double': '🎬 הכפל ×{mult}',
  'offline.toast': 'הרווחת {amount} בזמן שלא היית',
  'offline.branch': 'סניף {id}',

  /* ---------------------------------------------------------------- *
   *  Live events
   * ---------------------------------------------------------------- */
  'event.flagged': 'המצלמות זיהו פעילות חשודה!',

  'event.thief.label': 'גנב',
  'event.thief.spawn': 'גנב חוטף שק מזומנים!',
  'event.thief.player': 'תפסת את הגנב! +{amount}',
  'event.thief.staff': 'המאבטחים תפסו את הגנב! +{amount}',
  'event.thief.escape': 'הגנב ברח עם {amount}',

  // 'רכב מיגון', not the Brink's brand name (en.js says 'Armored Car').
  'event.brinks.label': 'רכב מיגון',
  'event.brinks.spawn': 'רכב המיגון הגיע לאסוף את הקופה.',
  'event.brinks.done': 'הקופה הועברה בבטחה. +{amount}',
  'event.brinks.escort': 'ליווית את הסבלים עד היציאה! +{amount}',
  'event.brinks.robbed': 'שוד! רכב המיגון נשדד ונלקחו {amount}',

  'event.robber.label': 'שודד',
  'event.robber.spawn': 'שודד מנסה לחטוף את המשלוח!',
  'event.robber.stopped': 'השוד סוכל! +{amount}',

  'event.counter.label': 'סופר קלפים',
  'event.counter.spawn': 'חשד לספירת קלפים באחד השולחנות...',
  'event.counter.player': 'סילקת את סופר הקלפים! +{amount}',
  'event.counter.staff': 'האבטחה סילקה את סופר הקלפים. +{amount}',
  'event.counter.escape': 'סופר הקלפים התחמק עם {amount}',

  'event.angry.label': 'לקוח זועם',
  'event.angry.spawn': 'לקוח זועם עושה סצנה!',
  'event.angry.player': 'הרגעת את הלקוח הזועם. +{amount}',
  'event.angry.staff': 'האבטחה הרגיעה את הלקוח הזועם. +{amount}',
  'event.angry.escape': 'הלקוח הזועם הרס את האווירה. -{amount}',

  'event.vip.label': 'אורח VIP',
  'event.vip.spawn': 'סלבריטי הגיע לקזינו!',
  'event.vip.escort': 'ליווית את ה-VIP! ×{mult} הכנסה ל-{seconds} שניות. +{amount}',
  'event.vip.left': 'ה-VIP עזב בלי שקיבל יחס.',

  /* ---------------------------------------------------------------- *
   *  PWA install / update
   * ---------------------------------------------------------------- */
  'pwa.install': '📲 התקן אפליקציה',
  'pwa.installTitle': 'התקנת המשחק על המסך הראשי',
  'pwa.installAria': 'התקן אפליקציה',
  'pwa.installing': 'מתקין את המשחק…',
  'pwa.installed': 'המשחק הותקן! אפשר לפתוח אותו ממסך הבית 🎰',
  'pwa.update': 'גרסה חדשה של המשחק זמינה',
  'pwa.updateToast': 'גרסה חדשה זמינה — הקש רענן',
  'pwa.refresh': 'רענן',
  // The Refresh button's busy state. NOT hud.loading ('טוען…'): the pending
  // version is being applied, nothing is loading — and 'טוען…' on a Refresh
  // button reads as if the game itself is starting over.
  'pwa.updating': 'מעדכן…',
  'pwa.helpInApp': 'הדף נפתח בדפדפן פנימי (למשל בתוך WhatsApp) שלא יכול להתקין אפליקציות ולא שומר את ההתקדמות באותו מקום. פתח את תפריט ⋮ ובחר "פתח בדפדפן" (Chrome), ואז בתפריט ⋮ של Chrome בחר "התקנת אפליקציה".',
  'pwa.helpChrome': 'פתח את תפריט ⋮ של Chrome ובחר "התקנת אפליקציה" כדי להוסיף את המשחק למסך הבית.',
  // Quoted verbatim by sw.js's last-resort offline page (it cannot import an
  // ES module). Change one and change the other — see sw.js offlineFallbackPage().
  'pwa.offlineTitle': 'לא זמין',
  'pwa.offlineLine1': 'המשחק אינו זמין במצב לא מקוון.',
  'pwa.offlineLine2': 'התחבר לרשת ונסה שוב.',

  /* ---------------------------------------------------------------- *
   *  First-run guide (src/ui/tutorial.js coach marks)
   * ---------------------------------------------------------------- */
  'tutorial.next': 'הבא',
  'tutorial.skip': 'דלג',
  'tutorial.progress': '{current} מתוך {total}',
  'tutorial.finish': 'קדימה, לשחק',
  'tutorial.replay': 'הרץ את המדריך מחדש',

  'tutorial.step.welcome.title': 'ברוך הבא לאולם',
  'tutorial.step.welcome.body': 'אורחים נכנסים, ממירים מזומן לצ׳יפים, מהמרים — ומכל הימור נשאר לבית אחוז. התפקיד שלך הוא לפנות כל צוואר בקבוק בדרך.',
  'tutorial.step.money.title': 'קופה והכנסה',
  'tutorial.step.money.body': 'הקופה שייכת לסניף הזה בלבד — לכל קזינו שלך קופה משלו. ההכנסה היא מה שהאולם מרוויח בכל שנייה, איתך או בלעדיך. היהלומים משותפים לכל האימפריה.',
  'tutorial.step.tier.title': 'הדרגה נמדדת בהוצאות',
  'tutorial.step.tier.body': 'הדרגה נקבעת לפי כמה השקעת בסניף, לא לפי כמה כסף צברת. תמשיך לקנות: כל דרגה מחדשת את מראה האולם ומעלה את כל ההכנסות.',
  'tutorial.step.drawer.title': 'מגירת הבנייה',
  'tutorial.step.drawer.body': 'כל מה שאפשר לבנות, לגייס ולשדרג נמצא מאחורי הידית הזאת. החלק אותה למעלה כדי לפתוח את המגירה.',
  'tutorial.step.slots.title': 'קנה את המכונה הראשונה',
  'tutorial.step.slots.body': 'סלוטים זולים, לא צריכים דילר ומכניסים כל היום. קנה אחד — האולם מסדר את עצמו, אתה לא מציב שום דבר ידנית.',
  'tutorial.step.cashier.title': 'הקופה היא צוואר הבקבוק',
  'tutorial.step.cashier.body': 'כל אורח ממיר כאן מזומן לצ׳יפים לפני שהוא מהמר, ופודה בחזרה בדרך החוצה. קופה אחת פירושה תור אחד, וכשהסבלנות נגמרת הם יוצאים בלי להמר אגורה. הוסף קופאים ברגע שהתור מתארך.',
  'tutorial.step.dealers.title': 'קודם דילר, אחר כך שולחן',
  'tutorial.step.dealers.body': 'בלאקג׳ק, רולטה, קרפס, גלגל המזל וחדר ה-VIP — כל אחד מהם צריך דילר משלו. שולחן בלי דילר לא מכניס כלום, אז קודם מגייסים ורק אחר כך קונים.',
  // Not part of the numbered sequence: a one-off card shown the first time the
  // player is free to poke at the floor itself.
  'tutorial.step.tap.title': 'לחץ על האולם',
  'tutorial.step.tap.body': 'לחיצה על אורח מכניסה טיפ. וכשמופיע גנב, סופר קלפים או לקוח זועם — לחץ עליו לפני שהוא נעלם. כל אחד שבורח עולה לך כסף.',
  'tutorial.doneTitle': 'הקזינו בידיים שלך',
  // Quotes the glyph the dock actually shows now (action.help), not the old ❓.
  'tutorial.doneBody': 'זה כל הלופ. כל השאר מחכה לך בכפתור "?" בכל רגע.',

  /* ---------------------------------------------------------------- *
   *  Help modal (the reopenable "?" guide, four tabbed pages)
   * ---------------------------------------------------------------- */
  'help.title': 'איך משחקים',
  'help.tab.loop': 'הלופ',
  'help.tab.build': 'בנייה',
  'help.tab.floor': 'באולם',
  'help.tab.empire': 'האימפריה',

  'help.loop.title': 'הלופ המרכזי',
  'help.loop.body': 'אורח נכנס, עובר בידוק בכניסה, ממיר מזומן לצ׳יפים בקופה, משחק עד שהסבלנות או האנרגיה נגמרות, מתאושש בבר, בבופה או באולם ההופעות, ואז פודה את הצ׳יפים ויוצא. מכל הימור נשאר לבית אחוז — האחוז הזה הוא ההכנסה שלך.',
  'help.currency.title': 'קופה ויהלומים',
  'help.currency.body': 'הקופה היא לפי סניף: לכל קזינו שלך קופה נפרדת, וסניף שאתה לא צופה בו ממשיך להרוויח בחצי קצב. היהלומים משותפים לכל האימפריה וקונים בהם איפוס זמני צינון, מזומן מיידי ובוסטים גדולים.',

  'help.build.title': 'מתחמים, עמדות, צוות ומערכות',
  'help.build.body': 'מתחמים או מכניסים כסף (אלה של ההימורים) או מטעינים את האורחים (בר, בופה, אולם הופעות). העמדות הן הזרימה: בידוק בכניסה, קופת הצ׳יפים, ועמדת הפריטה שמזינה את הסלוטים. הצוות הוא הדילרים, המאבטחים, עובדי הניקיון והמצלמות. המערכות הן מיזוג ותאורה, שמשאירות את האורחים באולם יותר זמן. כל רכישה מוצבת מעצמה — אין הצבה ידנית.',
  'help.dealers.title': 'שולחנות צריכים דילרים',
  'help.dealers.body': 'בלאקג׳ק, רולטה, קרפס, גלגל המזל וחדר VIP — דילר אחד לכל שולחן. אם יש יותר שולחנות מדילרים, העודפים פשוט עומדים ריקים ולא מכניסים כלום. קודם מגייסים.',
  'help.tier.title': 'דרגות',
  'help.tier.body': 'לכל סניף שלוש דרגות, ממתחם מוזנח ועד מתחם יוקרה. עולים בדרגה לפי סך ההוצאות בסניף, לא לפי החיסכון, ואף פעם לא יורדים בחזרה. כל דרגה מחדשת את מראה האולם ומכפילה את ההכנסה.',

  'help.events.title': 'אירועים בזמן אמת',
  'help.events.body': 'גנבים, סופרי קלפים, לקוחות זועמים, איסוף כסף ברכב מיגון ואורחי VIP מופיעים באולם בזמן שאתה משחק. לחיצה עליהם מטפלת בהם מיד ומזכה בפרס המלא; המאבטחים והמצלמות יגיעו לבד — לאט יותר ובתמורה קטנה יותר. כל אחד שבורח עולה לך בכסף או הורס את האווירה.',
  'help.tips.title': 'טיפים ומצלמה',
  'help.tips.body': 'לחיצה על אורח מכניסה טיפ ומוסיפה לו קצת סבלנות. גרירה מזיזה את התצוגה, צביטה מקרבת ומרחיקה, וכפתור ⛶ מחזיר את כל האולם למסך.',
  'help.minigames.title': 'מיני-משחקים',
  'help.minigames.body': 'רולטה ובלאקג׳ק נפתחים אחת ל-15 דקות כל אחד. ברולטה ההימור הוא נתח קבוע מההכנסה שלך — בהתחלה זו כמעט כל הקופה, אז אל תסובב על סכום שאתה לא יכול להרשות לעצמך להפסיד. בלאקג׳ק משלם ביהלומים ובבוסט לדילרים במקום במזומן.',

  'help.worlds.title': 'סניפים חדשים',
  'help.worlds.body': 'שישה סניפים, נפתחים לפי הסדר, וכל אחד רווחי בהרבה מקודמו. הכסף מכל הסניפים שבבעלותך נספר לטובת הסניף הבא, וכולם ממשיכים להרוויח במקביל — אף פעם לא מתחילים מהתחלה. הראשון, דאונטאון וגאס, נפתח ב-200,000: זה רחוק מהמכונה הראשונה שלך, וזה בכוונה.',
  'help.offline.title': 'כשאתה לא במשחק',
  'help.offline.body': 'הקזינו ממשיך להרוויח גם כשהוא סגור, בחצי קצב, עד 8 שעות. תחזור ותאסוף — צפייה בפרסומת מכפילה את הסכום.'
};
