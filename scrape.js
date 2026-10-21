import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';
import { scrapeAll } from './scrapers/pacific.js';
import { nowPacificISO, toPacificISO, normalizeSpace } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 5000);

// Partial-load guard. Releases are detected by people leaving the roster, so
// a short roster would mark everyone missing from it as released. Abort
// (writing nothing) when in-custody would drop by more than both thresholds.
// At ~25 people the 5-person rule is the one that trips. Not backtested yet:
// there is no history (see CLAUDE.md). ALLOW_BIG_DROP=1 overrides one run.
const GUARD_MIN_PEOPLE = 5;
const GUARD_MIN_FRACTION = 0.10;

// The county rebuilds its pages about hourly; its clock and ours can differ a
// little. County release times this far outside a booking's window still
// count as inside it.
const MATCH_TOLERANCE_MS = 10 * 60 * 1000;
// The roster can still list someone after the county's recorded release time
// (Oct 20, 2026: listed at the 13:05 rebuild, released 12:49:50). So a county
// time may fall this far before the last roster sighting. The exactly-one-
// candidate rule still applies, so a wider window can't pair two people.
const ROSTER_LAG_MS = 60 * 60 * 1000;

export class GuardError extends Error {}

// A missing or unreadable data file stops the run instead of starting over
// from empty: an empty bookings file would make everyone look newly booked
// and would be written back over the full history. ALLOW_FRESH_START=1 is
// only for the deliberate first run.
function readJSON(file, fallback, env) {
  const name = path.basename(file);
  if (!fs.existsSync(file)) {
    if (env.ALLOW_FRESH_START === '1') return fallback;
    throw new Error(`${name} is missing; refusing to start from empty (set ALLOW_FRESH_START=1 for a deliberate first run)`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`${name} could not be parsed: ${err.message}`);
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 1) + '\n');
}

// HTTP Last-Modified -> Pacific ISO, or null.
function httpDateToISO(text) {
  const t = text ? Date.parse(text) : NaN;
  return Number.isNaN(t) ? null : toPacificISO(new Date(t));
}

const ms = iso => (iso ? Date.parse(iso) : NaN);

// One record per booking. Number is a person ID (probably; see CLAUDE.md),
// so Number alone can't key a booking: a rebooking would merge into the old
// record. Booked At (raw text, so an unparseable one still keys) completes it.
export function bookingId(p) {
  return `${p.number}|${p.bookedAtRaw}`;
}

function newBooking(p, { now, seenOn, launch }) {
  return {
    id: bookingId(p),
    number: p.number,
    name: p.name,
    bookedAt: p.bookedAt,
    bookedAtRaw: p.bookedAtRaw,
    charges: p.charges,
    status: 'in_custody',
    firstSeen: now,
    firstSeenOn: seenOn, // 'roster' or 'bookings' (left before any run saw them on the roster)
    launchCohort: launch, // already listed on the very first run: firstSeen is launch day, not arrival
    lastSeenInCustodyAt: null,
    releasedAt: null,
    releaseSource: null,
    releasedAtRaw: null,
    detectedReleasedAt: null,
    releaseReversals: [],
  };
}

function markDetectedRelease(b, detectedAt) {
  b.status = 'released';
  b.releasedAt = detectedAt;
  b.releaseSource = 'detected';
  b.releasedAtRaw = null;
  b.detectedReleasedAt = detectedAt;
}

// Upgrade detected releases to the county's published time when exactly one
// released booking can be the person on a releases.html row. Name only on that
// page, so: same normalized name, the county time falls inside the booking's
// release window, and nothing else (no other booking, no other row with the
// same name) could claim it. Anything ambiguous stays detected and is logged.
function matchCountyReleases(bookings, releaseRows, log) {
  let upgraded = 0;
  const rowsByName = new Map();
  for (const r of releaseRows) {
    const key = normalizeSpace(r.name).toUpperCase();
    rowsByName.set(key, [...(rowsByName.get(key) || []), r]);
  }
  for (const [name, rows] of rowsByName) {
    const usable = rows.filter(r => r.releasedAt && !r.ambiguous);
    if (usable.length === 0) continue;
    if (rows.length > 1) {
      log(`  COUNTY RELEASE not matched: ${rows.length} rows for "${name}" on releases.html (ambiguous)`);
      continue;
    }
    const row = usable[0];
    const t = ms(row.releasedAt);
    const sameName = Object.values(bookings).filter(b => normalizeSpace(b.name).toUpperCase() === name);
    if (sameName.some(b => b.releaseSource === 'county' && b.releasedAtRaw === row.releasedAtRaw)) continue; // already matched
    const inWindow = sameName.filter(b => {
      if (b.status !== 'released' || b.releaseSource !== 'detected') return false;
      const start = Math.max((ms(b.bookedAt) || -Infinity) - MATCH_TOLERANCE_MS,
                             (ms(b.lastSeenInCustodyAt) || -Infinity) - ROSTER_LAG_MS);
      const end = ms(b.detectedReleasedAt);
      return t >= start && t <= end + MATCH_TOLERANCE_MS;
    });
    const stillIn = sameName.filter(b => b.status === 'in_custody');
    if (inWindow.length === 1 && stillIn.length === 0) {
      const b = inWindow[0];
      b.releasedAt = row.releasedAt;
      b.releasedAtRaw = row.releasedAtRaw;
      b.releaseSource = 'county';
      upgraded++;
      log(`  COUNTY RELEASE: ${b.name} (${b.number}) released ${row.releasedAt} (detected ${b.detectedReleasedAt})`);
    } else if (inWindow.length + stillIn.length > 0) {
      log(`  COUNTY RELEASE not matched: "${name}" ${row.releasedAt}: ${inWindow.length} detected release(s) in window, ${stillIn.length} same-name in custody`);
    }
  }
  return upgraded;
}

// One run. Returns a summary; throws (writing nothing) on any failure.
// Exposed with injectable inputs so tests can run it against copies of the
// data files and fake county pages.
export async function runScrape({ dataDir, fetchAll, env = process.env, now = nowPacificISO(), log = console.log, warn = console.warn }) {
  const BOOKINGS_FILE = path.join(dataDir, 'bookings.json');
  const RELEASES_FILE = path.join(dataDir, 'releases_seen.json');
  const STATUS_FILE = path.join(dataDir, 'status.json');

  const bookings = readJSON(BOOKINGS_FILE, {}, env);
  const releasesSeen = readJSON(RELEASES_FILE, [], env);
  const prevStatus = readJSON(STATUS_FILE, null, env);
  const firstRun = prevStatus === null;

  let page;
  try {
    page = await fetchAll();
  } catch (err) {
    // Retry network errors once (a momentary timeout shouldn't turn the run
    // red); a page that arrived but was wrong won't fix itself.
    if (!err.isAxiosError) throw err;
    warn(`  Fetch failed, retrying once: ${err.message}`);
    await sleep(Number(env.RETRY_DELAY_MS ?? RETRY_DELAY_MS));
    page = await fetchAll();
  }
  for (const w of page.warnings) warn(`  WARNING ${w}`);

  // When the county last rebuilt the roster we're reading. Anyone on it was in
  // custody at that time; it's a tighter bound than our own run time.
  const rosterAt = httpDateToISO(page.lastModified.roster) ?? now;

  const open = new Map(); // number -> open booking
  for (const b of Object.values(bookings)) {
    if (b.status !== 'in_custody') continue;
    if (open.has(b.number)) throw new Error(`data has two open bookings for Number ${b.number}; fix the data before running`);
    open.set(b.number, b);
  }
  const prevInCustody = open.size;

  const counts = { new: 0, released: 0, reappeared: 0, rebooked: 0, shortStays: 0, countyTimes: 0 };
  const onRoster = new Set();

  for (const p of page.roster) {
    onRoster.add(p.number);
    const id = bookingId(p);
    const current = open.get(p.number);
    if (current && current.id === id) {
      if (current.name !== p.name) warn(`  NAME CHANGE ${p.number}: "${current.name}" -> "${p.name}"`);
      current.name = p.name;
      current.charges = p.charges; // charges can be added or change bond type while held
      current.lastSeenInCustodyAt = rosterAt;
      continue;
    }
    if (current) {
      // Same Number, different Booked At, and we never saw them leave: a
      // release and rebooking between two runs, or the county edited the
      // booking time. Recorded as a release plus a new booking, and flagged.
      warn(`  REBOOKED ${p.number} ${p.name}: open booking ${current.bookedAtRaw} replaced by ${p.bookedAtRaw} without a release seen in between`);
      markDetectedRelease(current, now);
      counts.rebooked++;
    }
    const existing = bookings[id];
    if (existing) {
      // Back on the roster after we marked them released: the release was
      // wrong (most likely a short roster). Reverse it, keeping the old
      // release so the reversal stays visible.
      log(`  REAPPEARED: ${existing.name} (${existing.number}), marked released ${existing.releasedAt} (${existing.releaseSource})`);
      existing.releaseReversals.push({ releasedAt: existing.releasedAt, releaseSource: existing.releaseSource, reversedAt: now });
      existing.status = 'in_custody';
      existing.releasedAt = existing.releaseSource = existing.releasedAtRaw = existing.detectedReleasedAt = null;
      existing.name = p.name;
      existing.charges = p.charges;
      existing.lastSeenInCustodyAt = rosterAt;
      open.set(p.number, existing);
      counts.reappeared++;
      continue;
    }
    const b = newBooking(p, { now, seenOn: 'roster', launch: firstRun });
    b.lastSeenInCustodyAt = rosterAt;
    bookings[id] = b;
    open.set(p.number, b);
    counts.new++;
    log(`  NEW: ${b.name} (${b.number}) booked ${b.bookedAt ?? b.bookedAtRaw}`);
  }

  // Open bookings no longer on the roster: detected releases. The real
  // release was after lastSeenInCustodyAt and before now.
  const releasedNow = [...open.values()].filter(b => b.status === 'in_custody' && !onRoster.has(b.number));
  for (const b of releasedNow) {
    markDetectedRelease(b, now);
    counts.released++;
    log(`  RELEASED: ${b.name} (${b.number}), last on the roster ${b.lastSeenInCustodyAt}`);
  }

  // Booked and gone between two runs: on bookings.html, never on a roster we
  // read. Recorded as a released booking we never saw in custody.
  for (const p of page.bookings) {
    if (onRoster.has(p.number)) continue;
    const id = bookingId(p);
    if (bookings[id]) continue;
    const b = newBooking(p, { now, seenOn: 'bookings', launch: firstRun });
    markDetectedRelease(b, now);
    bookings[id] = b;
    counts.shortStays++;
    log(`  SHORT STAY: ${b.name} (${b.number}) booked ${b.bookedAt ?? b.bookedAtRaw}, already off the roster`);
  }

  const nextInCustody = Object.values(bookings).filter(b => b.status === 'in_custody').length;
  const drop = prevInCustody - nextInCustody;
  log(`  ${page.roster.length} on the county roster; in custody ${prevInCustody} -> ${nextInCustody}`);
  if (drop > GUARD_MIN_PEOPLE && drop > prevInCustody * GUARD_MIN_FRACTION) {
    if (env.ALLOW_BIG_DROP === '1') {
      warn(`  In custody dropping by ${drop}; allowed by ALLOW_BIG_DROP=1.`);
    } else {
      throw new GuardError(`In custody would drop by ${drop} (${prevInCustody} -> ${nextInCustody}), more than ${GUARD_MIN_PEOPLE} people and ${GUARD_MIN_FRACTION * 100}%. ` +
        'Looks like a partial roster from the county; nothing written. If the drop is real, re-run with ALLOW_BIG_DROP=1.');
    }
  }

  counts.countyTimes = matchCountyReleases(bookings, page.releases, log);

  // Every releases.html row we've ever seen, with first and last sighting
  // (by the page's own rebuild time). Settles how long the county keeps a
  // release listed (Pending verification in CLAUDE.md).
  const releasesAt = httpDateToISO(page.lastModified.releases) ?? now;
  for (const r of page.releases) {
    const key = `${r.name}|${r.releasedAtRaw}`;
    const seen = releasesSeen.find(s => `${s.name}|${s.releasedAtRaw}` === key);
    if (seen) seen.lastSeenAt = releasesAt;
    else releasesSeen.push({ name: r.name, releasedAt: r.releasedAt, releasedAtRaw: r.releasedAtRaw, firstSeenAt: releasesAt, lastSeenAt: releasesAt });
  }
  for (const s of releasesSeen) {
    const b = Object.values(bookings).find(b => b.releaseSource === 'county' && b.releasedAtRaw === s.releasedAtRaw && normalizeSpace(b.name).toUpperCase() === normalizeSpace(s.name).toUpperCase());
    s.matchedBookingId = b ? b.id : null;
  }

  const status = {
    inCustody: nextInCustody,
    lastUpdated: now,
    countyLastModified: {
      roster: httpDateToISO(page.lastModified.roster),
      bookings: httpDateToISO(page.lastModified.bookings),
      releases: httpDateToISO(page.lastModified.releases),
    },
    lastRun: counts,
  };

  if (env.DRY_RUN === '1') {
    log('  DRY_RUN=1: nothing written.');
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    writeJSON(BOOKINGS_FILE, bookings);
    writeJSON(RELEASES_FILE, releasesSeen);
    writeJSON(STATUS_FILE, status);
  }
  return { status, counts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  console.log(`[${nowPacificISO()}] Running Pacific County scrape (data: ${dataDir})...`);
  runScrape({ dataDir, fetchAll: () => scrapeAll({ sleep }) })
    .then(({ status, counts }) => {
      console.log(`[${nowPacificISO()}] Done. ${counts.new} new, ${counts.released} released, ${counts.shortStays} short stay(s), ${counts.reappeared} reappeared, ${counts.rebooked} rebooked, ${counts.countyTimes} county release time(s). ${status.inCustody} in custody.`);
    })
    .catch(err => {
      console.error(err instanceof GuardError ? err.message : `Fatal: ${err.stack || err.message}`);
      process.exit(1);
    });
}
