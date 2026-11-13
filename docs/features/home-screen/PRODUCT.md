# Home screen: product brief

Status: draft for the user's answers. Author: product-manager. Date: 2026-11-13.

## 1. Problem and users

The user asked (translated from Hebrew): "Home screen: it can be made to look better, show data that is more relevant for each user, etc."

Users are core facility managers who keep the service history of lab instruments. They open the app, and Home is the first thing they see. Today Home has: an Ask box, a drop zone for PDFs and photos, four figures (waiting for you, instruments overdue for maintenance, finalized this month vs last, fields read without edits), and two lists ("Needs your attention", "Maintenance due"). PR #305 will add a "Details and goal" link from the accuracy figure to a new Admin "Reading accuracy" page; this brief treats it as coming.

What is weak today, as a manager starting the day:
- Every manager sees the same fleet-wide numbers, even if they look after only a few instruments or one building.
- Home says what is waiting, but not what happened that is worth knowing (an instrument with repeated repairs, a report that failed to read, a service just recorded).
- The four figures have equal weight. The accuracy figure is a tool-quality number, not something a manager acts on today.
- It looks like a list of boxes, not a place that says "this is your day".

"Relevant for each user" is the hard part. There are no user accounts yet (one shared password). Per-user Microsoft Entra sign-in with editor and read-only roles is decided and planned, not built. So "each user" can mean three different things today (see Q1).

## 2. Goals and non-goals

Goals
- G1. In under 10 seconds, a manager can tell what needs doing today: reports to approve, services overdue or close, and anything that went wrong.
- G2. Home can be narrowed to "my part of the fleet" (the instruments or places the person cares about), so the figures and lists are about that part.
- G3. Home looks calmer and clearer: one obvious first thing to do, the most important figure stands out, the rest is quieter. Same slate-and-indigo look, same design system.
- G4. Works on desktop first and on a phone (44 px touch targets, 16 px inputs, no sideways scroll, as today).

Non-goals (nobody builds these)
- No user accounts, sign-in, roles or "who did what" on Home. That waits for the Entra work.
- No new data collected, no new report fields, no tracking of how people use the app.
- No charts that duplicate the Analytics screen; Home links to it.
- No notifications, emails, or scheduled digests.
- No change to the Ask box or drop-zone behaviour, only where they sit and how they look.
- No names or contacts of people on Home (privacy rule).
- No live Claude calls added.

## 3. User stories and acceptance criteria

Story A: "As a manager I want to see what needs me first."
- AC-01 (must) Home shows one clear "needs you" area at the top that combines: reports waiting for review (with how long the oldest has waited) and instruments overdue for maintenance. A tester can read both numbers without scrolling on a desktop 1280x800 window and on a 390 px wide phone.
- AC-02 (must) Each item in that area opens the thing it counts (the waiting reports, the overdue instruments) in one click or tap.
- AC-03 (must) When nothing needs attention, Home says so in plain words and says what to do next (for example "Drop a new report or ask a question").
- AC-04 (must) Reports that failed to read or got stuck are shown on Home with a way to open them. (Assumes such a state is visible in the data; if not, the architect reports it and this becomes later.)

Story B: "I want Home to be about my instruments."
- AC-05 (must) A person can choose which instruments, or which institute/building, Home is about. The choice is easy to find on Home and easy to clear.
- AC-06 (must) When a choice is active, every figure and list on Home counts only that part of the fleet, and Home says which part it is showing (for example "Showing: Building 2, 3 instruments").
- AC-07 (must) With no choice made, Home shows the whole fleet, exactly as the numbers are today.
- AC-08 (must) The choice stays when the page is reloaded on the same browser. (Where it is kept depends on Q1.)
- AC-09 (must) If a chosen instrument is deleted or retired, Home does not break: it drops it from the choice and says so once.
- AC-10 (later) The same choice also pre-filters Reports and Analytics.

Story C: "I want useful figures, not decoration."
- AC-11 (must) The figures row shows, for the chosen part of the fleet: reports waiting for review; instruments overdue; instruments due in the next 30 days; reports finalized this month vs last month. Each figure has a short plain-English note under it, and opens the matching list when clicked.
- AC-12 (must) The accuracy figure ("fields read without edits") stays on Home but is quieter than the action figures, keeps its "shown after 20 fields" rule, and keeps the "Details and goal" link from PR #305 working. It is whole-app, not narrowed by the person's choice, and says so (assumed, see rule R5).
- AC-13 (must) A "Recently finished" list shows the last few finalized reports (instrument, type, service date, no person names), each opening that report.
- AC-14 (later) A "Repeat repairs" hint: instruments with two or more repair reports in the last 90 days, each opening the instrument page.
- AC-15 (later) A small "Recently added instruments or reports" activity line.
- AC-16 (must) Every figure and list has an empty state and a load-error state with a retry, as today.

Story D: "I want Home to look better."
- AC-17 (must) A reviewer can point to: one primary action per area; consistent spacing from the design tokens; the largest figure being the most actionable one; no more than two levels of emphasis among the figures. No new colours outside the existing tokens.
- AC-18 (must) Light and dark themes both look right; text contrast passes the existing axe checks.
- AC-19 (must) On a phone, the page has no sideways scroll, controls are at least 44 px high, and the order is: needs-you, drop zone, figures, lists. The Ask box stays behind the top-bar magnifier as today.
- AC-20 (must) Nothing that worked before breaks: Ask box results, dropping files anywhere on the page, Choose files, Add one by hand, Review buttons, maintenance rows opening the instrument. The existing Home e2e specs, including the phone one, still pass or are updated with a stated reason.
- AC-21 (later) A "Start here" hint for a brand-new install with no instruments and no reports.

Story E: "Home must not leak."
- AC-22 (must) No person's name, contact, account or contract detail appears on Home, in the choice storage, in logs from this feature, or in screenshots and fixtures. Test data uses invented names only.

## 4. Product rules

| # | Rule | State |
|---|------|-------|
| R1 | Home is a read-only summary. Nothing is edited or stored from it except the person's own Home choice (R2). | decided (current design: "nothing is stored on this screen"; user asked only for look and relevance) |
| R2 | "Relevant for each user" before sign-in means a choice of instruments or places, kept in this browser only, no server record of who chose what. | open (Q1) |
| R3 | After sign-in exists, the same choice moves to the person's account, and role (editor or read-only) decides what Home offers (read-only people do not see "Review" as an action). | assumed (follows the decided Entra plan; not built now) |
| R4 | Default, with no choice: the whole fleet. | assumed |
| R5 | The accuracy figure is whole-app and not narrowed by the choice, because it measures the reading, not an instrument. | assumed |
| R6 | "Due soon" window is the one the maintenance service already uses; the 30-day wording in AC-11 follows it, whichever it is. | assumed |
| R7 | The lists show up to 6 rows each, then a link to the full screen, as today. | assumed |
| R8 | Email intake: when it ships, Home may show "arrived by email" counts by allow-listed sender or team, never a person's name or address. Not in this feature. | assumed (later) |
| R9 | English only; plain words; places called "Institute" and "Building". | decided (CLAUDE.md) |
| R10 | Stub mode only; no live Claude calls. | decided (CLAUDE.md) |
| R11 | Demo-ready stop: when every `must` above is met, the team stops and asks the user. `later` items are listed, not built. | decided (CLAUDE.md) |

## 5. Open questions (most important first)

**Q1. What does "relevant for each user" mean today, with no accounts?** (expensive to change: touches privacy and the later sign-in work)
- A. A "My view" choice (instruments and/or Institute/Building) kept in this browser only. Works now, private, no server change. Not shared between devices or people; lost if browser data is cleared.
- B. Same as A, but saved on the server as a shared set of named views anyone can pick (like the existing saved filters). Works across devices, but without accounts it is shared by everyone and could be changed by anyone.
- C. Wait for Entra sign-in and do per-person relevance then. Cleanest, but Home stays the same for everyone for an unknown time.
- D. Role-based Home only (editor vs read-only), no personal choice. Only meaningful after sign-in.
Recommendation: A now, designed so it moves to the account when sign-in lands (R3). Blocks: AC-05 to AC-10, the data model (A needs none), and the architect's plan.

**Q2. Which extra items matter most to start the day?** (cheap to change; ask only if the user wants a say)
- Options: failed or stuck reports (AC-04), recently finished reports (AC-13), repeat repairs (AC-14), due in 30 days (AC-11), arrived-by-email counts (R8).
- Recommendation: failed/stuck, recently finished and due-in-30-days now; repeat repairs and email counts later.
- Blocks: the final list of figures in AC-11 to AC-15. If not answered, the recommendation is used as `assumed`.

**Q3. Should the accuracy figure stay on Home?** (cheap)
- A. Keep, but quieter, with the PR #305 link (recommended). B. Remove from Home; it lives on the Admin page only.
- Blocks: AC-12.

**Q4. Should the choice in Q1 also filter Reports and Analytics?** (cheap)
- A. Not now; Home only (recommended, keeps scope small). B. Yes, everywhere (AC-10, a bigger change).
- Blocks: whether AC-10 is built.

**Q5. What does "looks better" mean to the user?** (cheap; ux-reviewer designs it)
- Options: calmer and less boxy (recommended); more graphic (small charts, trend arrows); denser (more on one screen for large monitors).
- Recommendation: calmer, one clear first action, small trend arrows on figures only if the data is already available.
- Blocks: AC-17 wording only; does not block planning.

## 6. Notes for later roles (no layout decided here)
- Existing data that could feed Home without new storage: report statuses and dates, instrument maintenance state and due date, place, finalized counts, labor and repair counts per instrument (Analytics), the work-dates timeline (instrument page).
- Phone behaviour to keep is in `frontend/tests/e2e/phone-home-ask.spec.ts`.

## Changes
(none yet)
