/**
 * he.js — Hebrew locale (the game's original language).
 *
 * Every value here is the EXACT string that used to be hard-coded in the UI
 * modules / config.js, so nothing regresses for existing Hebrew players.
 * Flat keys only. Must stay key-for-key identical to en.js.
 *
 * Placeholders interpolate as {name} — see i18n.js `t(key, params)`.
 */

export default {
  /* ---------------------------------------------------------------- *
   *  App shell (index.html, manifest, boot screen)
   * ---------------------------------------------------------------- */
  'app.title': 'Idle Casino Manager - מנהל קזינו סרק',
  'app.name': 'מנהל קזינו — אימפריית הימורים',
  'app.shortName': 'מנהל קזינו',
  'app.description': 'נהלו את הקזינו שלכם, בנו אולם משחקים תוסס, גייסו צוות ופתחו את אימפריית ההימורים שלכם במשחק סרק איזומטרי.',
  'app.noscript': 'המשחק דורש JavaScript מופעל כדי לרוץ. אנא הפעילו JavaScript בדפדפן שלכם וטענו מחדש את הדף.',
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
  'hud.income': 'הכנסה/שנייה:',
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
   *  Mini-games — shared
   * ---------------------------------------------------------------- */
  'mini.cooldown': 'המשחק יהיה זמין שוב בעוד:',

  /* ---------------------------------------------------------------- *
   *  Mini-game — roulette
   * ---------------------------------------------------------------- */
  'mini.roulette.title': 'רולטה — High Roller',
  'mini.roulette.betAmount': 'הימור קבוע: {amount}',
  'mini.roulette.spin': 'סובב',
  'mini.roulette.bet.red': 'אדום',
  'mini.roulette.bet.black': 'שחור',
  'mini.roulette.bet.even': 'זוגי',
  'mini.roulette.bet.odd': 'אי-זוגי',
  'mini.roulette.bet.dozen': 'תריסר',
  'mini.roulette.bet.single': 'מספר בודד',
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
  'mini.roulette.win': 'ניצחת! זכייה אפשרית: {amount}',
  'mini.roulette.lose': 'הפסדת את ההימור.',
  'mini.roulette.takeCash': 'קח מזומן',
  'mini.roulette.gotCash': 'קיבלת {amount}',
  'mini.roulette.takeBoost': 'קח בוסט הכנסה ×{mult}',
  'mini.roulette.boostOn': 'בוסט הכנסה פעיל!',

  /* ---------------------------------------------------------------- *
   *  Mini-game — blackjack
   * ---------------------------------------------------------------- */
  'mini.blackjack.title': 'בלאק ג׳ק — Dealer Challenge',
  'mini.blackjack.intro': 'יד אחת מול הדילר הראשי. הדילר עוצר על {value}.',
  'mini.blackjack.start': 'התחל יד',
  'mini.blackjack.dealer': 'דילר',
  'mini.blackjack.dealerScore': 'דילר ({value})',
  'mini.blackjack.player': 'שחקן ({value})',
  'mini.blackjack.hit': 'משוך (Hit)',
  'mini.blackjack.stand': 'עצור (Stand)',
  'mini.blackjack.blackjack': 'בלאק ג׳ק! ניצחון מושלם',
  'mini.blackjack.win': 'ניצחת!',
  'mini.blackjack.push': 'תיקו',
  'mini.blackjack.bust': 'פסטת — הפסד',
  'mini.blackjack.dealerBlackjack': 'לדילר בלאק ג׳ק — הפסד',
  'mini.blackjack.lose': 'הפסדת',
  'mini.blackjack.pushToast': 'תיקו! קיבלת {amount} יהלומים',
  'mini.blackjack.loseToast': 'הפסדת את היד',
  'mini.blackjack.takeDiamonds': 'קח {amount} 💎',
  'mini.blackjack.gotDiamonds': 'קיבלת {amount} יהלומים',
  'mini.blackjack.takeDealerBoost': 'בוסט לדילרים ×{mult}',
  'mini.blackjack.dealerBoostOn': 'בוסט לדילרים פעיל!',
  'mini.blackjack.takeCash': 'קח מזומן',
  'mini.blackjack.gotCash': 'קיבלת {amount}',

  /* ---------------------------------------------------------------- *
   *  Shop (IAP simulation)
   * ---------------------------------------------------------------- */
  'shop.title': 'חנות יהלומים',
  'shop.section.packs': 'קניית יהלומים',
  'shop.section.specials': 'הנחות מיוחדות',
  'shop.section.spend': 'הוצאת יהלומים',
  'shop.pack.small': 'חופן יהלומים',
  'shop.pack.medium': 'שק יהלומים',
  'shop.pack.large': 'כספת יהלומים',
  'shop.pack.mega': 'מכרה יהלומים',
  'shop.price.small': '₪9.90',
  'shop.price.medium': '₪39.90',
  'shop.price.large': '₪99.90',
  'shop.price.mega': '₪299.90',
  'shop.price.noAds': '₪19.90',
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
  'shop.purchased': '✓ רכוש',

  /* ---------------------------------------------------------------- *
   *  Rewarded ads
   * ---------------------------------------------------------------- */
  'ad.title': 'צפיה בפרסומת',
  'ad.label': 'סיים את הצפיה וקבל גמול!',
  'ad.skip': 'דלג',
  'ad.reward': '🎬 קיבלת בונוס פרסומת! +{amount} יהלומים ו-2x הכנסה',
  'ad.noAdsOwned': 'יש לך את ההנחה "ללא פרסומות"',
  'ad.cooldown': 'צפיה בפרסומת זמינה ב-{seconds} שניות',
  'ad.button': '🎬 פרסומת',
  'ad.buttonTitle': 'צפה בפרסומת לבונוס',
  'ad.buttonCooldown': 'זמין בעוד {seconds}s',

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

  'event.brinks.label': 'ברינקס',
  'event.brinks.spawn': 'ברינקס הגיע לאסוף את הקופה.',
  'event.brinks.done': 'הקופה הועברה בבטחה. +{amount}',
  'event.brinks.escort': 'ליווית את הסבלים עד היציאה! +{amount}',
  'event.brinks.robbed': 'שוד! הברינקס נשדד ונלקחו {amount}',

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
  'pwa.updateToast': 'גרסה חדשה זמינה — הקישו רענן',
  'pwa.refresh': 'רענן',
  'pwa.helpInApp': 'הדף נפתח בדפדפן פנימי (למשל בתוך WhatsApp) שלא יכול להתקין אפליקציות ולא שומר את ההתקדמות באותו מקום. פתחו את תפריט ⋮ ובחרו "פתח בדפדפן" (Chrome), ואז בתפריט ⋮ של Chrome בחרו "התקנת אפליקציה".',
  'pwa.helpChrome': 'פתחו את תפריט ⋮ של Chrome ובחרו "התקנת אפליקציה" כדי להוסיף את המשחק למסך הבית.',
  'pwa.offlineTitle': 'לא זמין',
  'pwa.offlineLine1': 'המשחק אינו זמין במצב לא מקוון.',
  'pwa.offlineLine2': 'התחברו לרשת ונסו שוב.'
};
