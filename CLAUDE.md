# Pacific County Jail Roster Monitor — Project Context

## Standing rules (every session, before any work)
1. Always paste the full, real diff. Never a summary.
2. Never commit until the user replies "commit".
3. Any field claiming a county value (release time, release reason, status) must be backed by a value that actually parses. Otherwise it's labeled `detected` or `unverified`.
4. Test edge cases and list them: blank, unparseable, small populations, reappearance, rebuild/error pages.
5. Flag anything uncertain instead of deciding silently.
6. After pushing any data backfill, wait for the next scrape run and confirm the backfill counts survived.
7. Check "Pending verification" below first, every session. Add anything that can only be checked later.

Hard constraints for build work:
- No DELETE / DROP / TRUNCATE / UPDATE on stored data and no schema changes unless explicitly approved.
- Don't touch the scraper or parser unless that's the task.
- Row counts identical before and after any change that isn't meant to change them.
- Before/after numbers for anything that changes a published stat.
- `git pull` before auditing, so the checkout matches deployed main.
- Backfills go inside the scraper as idempotent migrations, never as a data push from a work session (it conflicts with the next run's rebase and turns it red).

## Pending verification
- [ ] **Release-page window.** Observed Oct 9, 2026: NOVCASKI (released 10/08 14:56) was on `releases.html` at the 13:05 rebuild (~22 h) and gone at 15:05 (~24 h). The 14:05 rebuild wasn't captured. Working assumption: rolling 24 h. Confirm from the first week of real runs (each release's first and last sighting on `releases.html`).
- [ ] **Bookings-page window.** LEITCH (booked 10/09 10:22) listed at 15:05 the same day; two 10/07 bookings were not listed on 10/09 morning. Window is somewhere under ~40 h; assumed 24 h. Confirm from real runs.
- [ ] **Number = person ID, not booking ID.** Inferred from VINE `offenderID` and low numbers on long-known people (33136) vs. new ones (203336). Confirm the first time someone is rebooked: same Number, new Booked At?
- [ ] **Timezone of all timestamps.** Assumed Pacific wall-clock (no marker on the page). Prove it by comparing a booking's Booked At with the first hourly rebuild it appears in.
- [ ] **Hourly rebuild at :05.** Observed 07:05, 08:05, 09:05, 13:05, 15:05 PDT on Oct 9. Re-check from `Last-Modified` logged by real runs, including overnight and weekends.
- [ ] **Terms of use.** None found on the roster page or county homepage (Oct 9). Not a confirmed permission. Optional: ask the Sheriff's Office / Jail (360-875-9390) and record the answer and date here.
- [ ] **cron-job.org token expires 2027-08-08.** Renew before then (calendar reminder); when it expires every trigger stops silently except for cron-job.org failure emails.

## Decisions
- **Public repo + GitHub Pages ("public for now", decided Oct 9, 2026).** Consequence, accepted knowingly: every name in committed JSON and in all git history is public and can't be recalled by going private later. JSON on Pages can't be noindexed. Revisit before the history grows.
- **Cadence: hourly at :10** (5 minutes after the county's :05 rebuild), triggered by cron-job.org via `workflow_dispatch`, no GitHub `schedule`. Rationale: the source can't change faster than hourly, and releases stay listed ~24 h, so an outage under ~22 h loses no county release times.
- **Scrape all three pages every run** (roster, `bookings.html`, `releases.html`, one at a time with a gap; decided Oct 10, 2026). Someone booked and released between two hourly runs never appears on the roster we see, but does appear on `bookings.html` (with Number and charges) and then `releases.html`. Reading only the roster would miss those short stays entirely.
- **Parser is strict (decided Oct 10, 2026):** a duplicate Number on one page, or a person with no charges table, fails the whole run instead of merging or skipping. Revisit if either ever fires on a real page.
- **GR 31:** the Warrant/Citation# column holds court cause numbers (e.g. `25-1-00082-25`). Undecided whether to publish it. Flag before it goes on the frontend.

## Source map (verified on the live site, Oct 9, 2026)
Three static HTML pages on IIS, all rebuilt together every hour at about :05 (same `Last-Modified` on all three). Also the VINE link per person. No JSON, no PDF, no pagination, no detail pages.

| Page | URL | Content | Key |
|---|---|---|---|
| Roster | https://co.pacific.wa.us/jail/roster/ | Everyone in custody now (25–26 people on Oct 9) | Number |
| Bookings | https://co.pacific.wa.us/jail/roster/bookings.html | Recent bookings, same layout as roster incl. charges; window ~24 h (unconfirmed) | Number |
| Releases | https://co.pacific.wa.us/jail/roster/releases.html | Name + Released At only; window ~24 h (unconfirmed) | **Name only** |

### Gap tolerance (Phase 1.0)
Hybrid. The roster lists current inmates only, so leaving the roster is a *detected* release. A real county release time exists only on `releases.html`, for about 24 h, keyed by name only. So:
- A release is first recorded as `detected` with `lastSeenInCustodyAt`, then upgraded to `county` when a parseable Released At is matched to it (keep the old detected time in its own field).
- Match by name **only when exactly one person with that normalized name left the roster** in the window. Ambiguous or unmatched → stays `detected`, logged.
- Needs: partial-load guard, reappearance path with `releaseReversals`, `releaseSource` on every release.

### Roster / bookings row
`tr.name` row: `td.inmate` = Name, then Number, then `td.date` Booked At, then a VINE link (`offenderID=<Number>`). The next row (hidden) holds a charges sub-table.
- **Name:** `LAST, FIRST MIDDLE`. **Can contain non-breaking spaces (`\xa0`)** — LEITCH, PAUL\xa0ANGELO on Oct 9. Normalize all whitespace before storing or comparing.
- **Number:** VINE `offenderID`. Probably a person ID (see Pending). Rebooking under a known Number = new booking record, never a merge into the old one.
- **Booked At:** `HH:MM:SS MM/DD/YYYY` (time first), no zone. Official booking time; durations start here, never `firstSeen`.

### Charges sub-table (per charge)
Columns: Arrest Date, Arresting Agency, Court, Billing Agency, Bond Type, Bond Amount, Warrant/Citation#, Description.
- **Arrest Date is not this booking's arrest.** It can be years earlier (ASCHOFF: 10/06/2024 charge, booked 02/28/2026). Treat as offense/case date. Never use it for durations.
- **Bail is per charge, and it's bail set, not posted.** Bond Type values seen: Cash or Surety, Same Case, Sentenced, No Bail Allowed, Cash, Bail Not Set. "Same Case" rows carry `$0` (like Pierce's CONCURRENT): never sum bail per charge. `$0` is ambiguous (sentenced / no bail allowed / same case) — store Bond Type alongside, never treat `$0` alone as "no bail".
- Courts seen: SUP, SDC, NDC, RMU, LBM, SBM, DOC. Agencies seen: PCSO, RPD, LBPD, WSP, DFW, SBPD, STP, PCJ, DOC. Meanings of the codes not yet confirmed.
- No release reason or disposition anywhere on the site.

### Releases row
`tr.name` row: Name, `td.date` Released At (`HH:MM:SS MM/DD/YYYY`). No Number, no charges.

### Placeholder / error states
- Empty `<tbody>` on `bookings.html` or `releases.html` is **normal** (seen Oct 9) and must not fail the run.
- Roster with zero rows, or no `#main-table`, is treated as a failure (non-zero exit), never stored as "everyone released".
- No rebuild/maintenance page seen yet. Any page missing `#main-table` fails the run.

### Population and guards
Small roster (~25). Partial-load guard: abort if in-custody drops by more than 5 people **and** more than 10%; with ~25 people, the 5-person rule is what trips it. Override via workflow input. Not backtestable until real history exists — backtest from `data/status.json` commit history after a few weeks.

### Launch cohort
Everyone on the roster at the first run gets `firstSeen` = launch. Some were booked long before (earliest seen: 09/07/2025). No stat may start a clock at `firstSeen`.

## Launch to-dos
- [x] **First run** (done Oct 10, 2026, run #1, 26 in custody): after the workflow is on `main`, run "Scrape" once by hand (Actions → Scrape → Run workflow) with **allow_fresh_start** ticked. Every later run leaves it unticked. Ticking it when data already exists does nothing (it only applies to missing files).
- [x] **Verify the first real run** (done Oct 10: green, `26 on the county roster`, `c551f6e` by github-actions[bot]) (standing rule): green, the `N on the county roster` log line, and `data/` committed by github-actions[bot].
- [x] **cron-job.org job** (set up Oct 10; test run 14:22 green). Still to confirm: the first scheduled :10 run.
  Job details: POST `https://api.github.com/repos/recordwatch/Pacific-county-monitor/actions/workflows/scrape.yml/dispatches`, body `{"ref":"main"}`, crontab `10 * * * *` in America/Los_Angeles, failure emails on. Add this repo to the existing fine-grained token's repository access (Actions: Read and write) before creating the job. A 204 on the test run means it worked; confirm a workflow_dispatch run actually started.
- [ ] **Header link to the hub:** the frontend header links to https://wajaildata.org, like the sibling monitors. Build it with the frontend.
- [ ] **Hub button for Pacific:** once GitHub Pages is live, add a `<a class="nav-btn">` for Pacific County to the `.nav-section` block in `recordwatch/mason-jail-roster`'s `server.js` (serves the wajaildata.org homepage). Needs push access to that repo. Don't add it before the site is live (it would link to a 404).

## Template
Built from `recordwatch/whatcom-jail-monitor` (public + Pages, Oct 9 hardening). Fix-once-check-siblings: Whatcom's CLAUDE.md is missing these standing rules.
