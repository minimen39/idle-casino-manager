# Design feedback — round 1

Source: designer review of the isometric build, 2026-07-25.
Status: accepted, queued for implementation after the i18n/bugfix workflow lands.

Original notes (Hebrew):
1. צריך גם מדריך first time starting the game and play first time
2. לא ברור — יש כל מיני דמויות שאני לא מבין מה הם ומה התפקיד שלהם
3. גם לא רואים את הדילרים עובדים בשולחן, פשוט הלקוחות רצים אליו
4. שיעשה גם לכלוך ויזואלי שהמנקים ילכו לנקות אותו

---

## R1 — First-time tutorial

**Problem.** A new player opens the game to a near-empty floor with no idea what to do.

**Requirement.** A guided, skippable first-run tutorial that teaches the core loop from
`goal.md` §1: guests enter → convert cash to chips at the cashier → gamble → use service
venues → cash out.

Acceptance criteria:
- Runs automatically on first launch only; persisted in game state (survives reload, and a
  fresh install starts it again). Re-runnable from a menu.
- Skippable at any step, with a visible "skip" affordance.
- Steps are short and *action-gated* — the player performs the action to advance, rather than
  clicking through text:
  1. Buy your first slot machine (highlight the venue row in the drawer)
  2. Add a cashier — explain it is the chip-conversion bottleneck (`goal.md` §3)
  3. Watch a guest complete the loop (highlight a guest, follow it to cash-out)
  4. Tap a thief to catch it (spawn one deliberately for this step)
  5. Point out the branch map and the fact branches earn while you are away
- Each step spotlights its target: dim the rest of the screen, keep the target bright and
  interactive. Must work with the isometric camera (a world-space target must project to the
  right screen position, and follow it if the camera moves).
- Must not fight the camera: while the tutorial highlights a world-space object, either lock
  the camera or track the target.
- All copy via i18n in **both** Hebrew and English. No hard-coded strings.
- Never blocks input permanently — a tutorial bug must not soft-lock the game.

## R2 — Character legibility

**Problem.** The floor is full of figures and the player cannot tell who is who or what any of
them are for.

**Requirement.** Every character role must be identifiable at a glance, plus an on-demand legend.

Acceptance criteria:
- Each role gets a distinct, readable silhouette and palette — not just a body-colour swap.
  Use props and headwear, which read better than colour at small sizes and survive the
  per-world palette shifts:
  - guest (ordinary), VIP (top hat / fur, visibly richer)
  - dealer (visor + waistcoat, stationed at a table)
  - guard (peaked cap, dark uniform, baton)
  - cleaner (cap + mop/bucket)
  - thief (mask + money sack, already has a highlight ring)
  - card counter (seated, subtle tell)
  - angry guest (visible anger state)
- Roles must stay distinguishable in all 6 world palettes and all 3 tiers — verify against the
  darkest and most saturated worlds, not just the default one.
- A **legend** UI: a small toggle that opens a key showing each role icon with its localized
  name and one-line job description.
- **Tap-to-identify**: tapping a character shows a short label with its role and current
  activity (e.g. "Dealer — running blackjack", "Guest — queuing for chips"). Must not conflict
  with the existing tap-to-catch-thief routing: catching a live-event actor keeps priority.
- Role names and descriptions via i18n (he + en).

## R3 — Dealers visibly working

**Problem.** Guests run to a table and gamble, but no dealer is visible working it. The table
looks unstaffed even when `dealerCoverage` says it is staffed.

**Requirement.** A staffed dealer-requiring venue must visibly show its dealer at work.

Acceptance criteria:
- `staff.js` already models dealers manning tables (`dealerCoverage`, unmanned tables earn
  nothing). This is primarily a **rendering/positioning** gap — do not rewrite the economics.
- A dealer assigned to a table stands at the dealer position of that specific table
  (behind the felt, on the dealer arc), not wandering nearby.
- Dealing animation while the table has players: hands/cards motion, chip pushes, a spin for
  roulette. Idle pose when the table is empty.
- The visual state must match the simulation: if the table is unmanned (and therefore earning
  nothing) there must be **no** dealer sprite, so the player can see the problem and fix it by
  hiring. This is the feedback loop that makes `dealerCoverage` legible.
- Depth-sorting must keep the dealer correctly in front of / behind the table.
- Craps, blackjack, roulette and the sportsbook each need a plausible staffed pose.

## R4 — Visual dirt and cleaners

**Problem.** Cleanliness exists only as an invisible number. The player cannot see dirt, and
cleaners appear to wander aimlessly.

**Requirement.** Discrete, visible dirt objects that accumulate with traffic and that cleaners
walk to and remove.

Acceptance criteria:
- Dirt spawns as discrete world-space objects (litter, spilled drinks, cigarette ends) at
  positions correlated with actual guest traffic — near busy venues, queues and the bar/buffet,
  not uniformly at random.
- Spawn rate scales with guest throughput; the existing scalar cleanliness should be **derived
  from** the count of dirt objects so sim and visuals cannot disagree.
- Cleaners target the nearest dirt object, path to it, play a short mopping animation, and the
  object disappears. Cleaners with nothing to clean return to an idle patrol.
- Too much dirt visibly degrades the floor and reduces guest patience/income — keep the
  existing economic effect, just drive it from the object count.
- Dirt must be visible but must not obscure gameplay or be mistaken for a clickable event actor.
- Works across all 6 world palettes and all 3 tiers.

---

## Cross-cutting constraints

- **i18n**: every new user-facing string goes in `src/core/locales/he.js` and `en.js` with
  identical keys. No hard-coded Hebrew or English anywhere in code.
- **No simulation regressions**: guests, staff, live events, economy and state are verified
  working on device. Extend them; do not rewrite their behaviour.
- **Mobile first**: verified target is a real Pixel at 411x796 CSS px, touch only. Tutorial
  spotlights, the legend and tap-to-identify must all work at that size with >=44px touch
  targets.
- **Performance**: the renderer must hold 60fps with ~150 characters. Dirt objects and dealer
  animations add draw calls — they must be depth-sorted with everything else and must not
  introduce per-frame allocations.
- **Deployment**: ships to `https://minimen39.github.io/idle-casino-manager/` — a GitHub Pages
  subpath. Every path stays relative, and `sw.js` `VERSION` must be bumped or installed clients
  never receive the update.
