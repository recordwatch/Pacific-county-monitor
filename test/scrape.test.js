import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScrape, GuardError, bookingId } from '../scrape.js';

// State tests: runScrape against a temp data folder and fake parsed pages
// (made-up people). The real data/ folder is never touched.

const quiet = { log: () => {}, warn: () => {} };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pacific-test-'));
}

function snapshot(dir) {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).map(f => [f, fs.readFileSync(path.join(dir, f), 'utf-8')]));
}

function person(number, name = `PERSON, NUMBER ${number}`, bookedAtRaw = '10:00:00 10/01/2026') {
  const [h, mi, s, mo, d, y] = bookedAtRaw.split(/[: /]/);
  return { number: String(number), name, bookedAt: `${y}-${mo}-${d}T${h}:${mi}:${s}-07:00`, bookedAtRaw, charges: [] };
}

function release(name, releasedAtRaw) {
  const [h, mi, s, mo, d, y] = releasedAtRaw.split(/[: /]/);
  return { name, releasedAt: `${y}-${mo}-${d}T${h}:${mi}:${s}-07:00`, releasedAtRaw, ambiguous: false };
}

// Pages "rebuilt" at the given Pacific time (HTTP dates are UTC; PDT = UTC-7).
function pages({ roster = [], bookings = [], releases = [], builtAt = '2026-10-10T10:05:00-07:00' } = {}) {
  const lm = new Date(builtAt).toUTCString();
  return { roster, bookings, releases, warnings: [], lastModified: { roster: lm, bookings: lm, releases: lm } };
}

async function run(dir, page, opts = {}) {
  return runScrape({ dataDir: dir, fetchAll: async () => page, env: opts.env ?? {}, now: opts.now ?? '2026-10-10T10:10:00-07:00', ...quiet, ...opts.io });
}

function read(dir, f = 'bookings.json') {
  return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
}

const roster25 = () => Array.from({ length: 25 }, (_, i) => person(1000 + i));

async function launched(roster = roster25()) {
  const dir = tmpDir();
  await run(dir, pages({ roster }), { env: { ALLOW_FRESH_START: '1' }, now: '2026-10-10T09:10:00-07:00' });
  return dir;
}

// --- reading data files strictly ---

test('missing data files stop the run unless ALLOW_FRESH_START=1; nothing written', async () => {
  const dir = tmpDir();
  await assert.rejects(run(dir, pages({ roster: [person(1)] })), /missing; refusing to start from empty/);
  assert.deepEqual(snapshot(dir), {});
});

test('a corrupt data file stops the run and is left as is', async () => {
  const dir = await launched();
  fs.writeFileSync(path.join(dir, 'bookings.json'), '{"truncated":');
  const before = snapshot(dir);
  await assert.rejects(run(dir, pages({ roster: roster25() })), /could not be parsed/);
  assert.deepEqual(snapshot(dir), before);
});

test('first run: everyone is the launch cohort, times are ISO with offset', async () => {
  const dir = await launched();
  const b = Object.values(read(dir));
  assert.equal(b.length, 25);
  assert.ok(b.every(x => x.launchCohort === true && x.status === 'in_custody'));
  assert.ok(b.every(x => x.firstSeen === '2026-10-10T09:10:00-07:00'));
  assert.equal(b[0].lastSeenInCustodyAt, '2026-10-10T10:05:00-07:00'); // roster rebuild time, not our run time
  assert.equal(read(dir, 'status.json').inCustody, 25);
});

test('two open bookings for one Number in the data stops the run', async () => {
  const dir = await launched();
  const data = read(dir);
  const extra = { ...data[bookingId(person(1000))], id: 'x', bookedAtRaw: 'x' };
  data.x = extra;
  fs.writeFileSync(path.join(dir, 'bookings.json'), JSON.stringify(data));
  await assert.rejects(run(dir, pages({ roster: roster25() })), /two open bookings for Number 1000/);
});

// --- bookings and releases ---

test('a new booking after launch is not launch cohort', async () => {
  const dir = await launched();
  await run(dir, pages({ roster: [...roster25(), person(2000, 'NEW, PERSON', '09:30:00 10/10/2026')] }));
  const b = read(dir)[bookingId(person(2000, 'NEW, PERSON', '09:30:00 10/10/2026'))];
  assert.equal(b.launchCohort, false);
  assert.equal(b.firstSeenOn, 'roster');
});

test('leaving the roster is a detected release with its uncertainty window', async () => {
  const dir = await launched();
  const r = roster25().slice(1);
  await run(dir, pages({ roster: r, builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
  const b = read(dir)[bookingId(person(1000))];
  assert.equal(b.status, 'released');
  assert.equal(b.releaseSource, 'detected');
  assert.equal(b.releasedAt, '2026-10-10T11:10:00-07:00');
  assert.equal(b.detectedReleasedAt, '2026-10-10T11:10:00-07:00');
  assert.equal(b.lastSeenInCustodyAt, '2026-10-10T10:05:00-07:00');
  assert.equal(read(dir, 'status.json').inCustody, 24);
});

test('county release time on the same run upgrades the detected release', async () => {
  const dir = await launched();
  const gone = person(1000, 'DOE, JANE Q'.replace(' ', ' '));
  const roster = [gone, ...roster25().slice(1)];
  await run(dir, pages({ roster }), { now: '2026-10-10T10:10:00-07:00' });
  await run(dir, pages({ roster: roster.slice(1), releases: [release('DOE, JANE Q', '10:40:00 10/10/2026')], builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
  const b = read(dir)[bookingId(gone)];
  assert.equal(b.releaseSource, 'county');
  assert.equal(b.releasedAt, '2026-10-10T10:40:00-07:00');
  assert.equal(b.releasedAtRaw, '10:40:00 10/10/2026');
  assert.equal(b.detectedReleasedAt, '2026-10-10T11:10:00-07:00'); // old guess kept
  const seen = read(dir, 'releases_seen.json');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].matchedBookingId, bookingId(gone));
});

test('county release time that shows up a run later still upgrades', async () => {
  const dir = await launched();
  await run(dir, pages({ roster: roster25().slice(1), builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
  await run(dir, pages({ roster: roster25().slice(1), releases: [release('PERSON, NUMBER 1000', '10:59:00 10/10/2026')], builtAt: '2026-10-10T12:05:00-07:00' }), { now: '2026-10-10T12:10:00-07:00' });
  assert.equal(read(dir)[bookingId(person(1000))].releaseSource, 'county');
});

test('release-page sightings track first and last rebuild seen', async () => {
  const dir = await launched();
  const rel = [release('PERSON, NUMBER 1000', '10:30:00 10/10/2026')];
  await run(dir, pages({ roster: roster25().slice(1), releases: rel, builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
  await run(dir, pages({ roster: roster25().slice(1), releases: rel, builtAt: '2026-10-10T12:05:00-07:00' }), { now: '2026-10-10T12:10:00-07:00' });
  const [s] = read(dir, 'releases_seen.json');
  assert.equal(s.firstSeenAt, '2026-10-10T11:05:00-07:00');
  assert.equal(s.lastSeenAt, '2026-10-10T12:05:00-07:00');
});

test('no county time when two released people share the name', async () => {
  const dir = await launched([person(1, 'SMITH, JOHN'), person(2, 'SMITH, JOHN', '11:00:00 10/01/2026'), ...roster25()]);
  await run(dir, pages({ roster: roster25(), releases: [release('SMITH, JOHN', '10:30:00 10/10/2026')], builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
  const d = read(dir);
  assert.equal(d[bookingId(person(1, 'SMITH, JOHN'))].releaseSource, 'detected');
  assert.equal(d[bookingId(person(2, 'SMITH, JOHN', '11:00:00 10/01/2026'))].releaseSource, 'detected');
});

test('no county time when someone with the same name is still in custody', async () => {
  const dir = await launched([person(1, 'SMITH, JOHN'), person(2, 'SMITH, JOHN', '11:00:00 10/01/2026'), ...roster25()]);
  await run(dir, pages({ roster: [person(2, 'SMITH, JOHN', '11:00:00 10/01/2026'), ...roster25()], releases: [release('SMITH, JOHN', '10:30:00 10/10/2026')], builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
  assert.equal(read(dir)[bookingId(person(1, 'SMITH, JOHN'))].releaseSource, 'detected');
});

test('no county time when it falls outside the release window', async () => {
  const dir = await launched();
  // Last on the roster at the 10:05 rebuild; a "release" at 08:00 can't be this stay.
  await run(dir, pages({ roster: roster25().slice(1), releases: [release('PERSON, NUMBER 1000', '08:00:00 10/10/2026')], builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
  assert.equal(read(dir)[bookingId(person(1000))].releaseSource, 'detected');
});

test('county time up to 60 min before the last roster sighting still matches (roster lag)', async () => {
  const dir = await launched(); // last on the roster at the 10:05 rebuild
  await run(dir, pages({ roster: roster25().slice(1), releases: [release('PERSON, NUMBER 1000', '09:50:00 10/10/2026')], builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
  const b = read(dir)[bookingId(person(1000))];
  assert.equal(b.releaseSource, 'county');
  assert.equal(b.releasedAt, '2026-10-10T09:50:00-07:00');
});

test('county time more than 60 min before the last roster sighting does not match', async () => {
  const dir = await launched();
  await run(dir, pages({ roster: roster25().slice(1), releases: [release('PERSON, NUMBER 1000', '09:00:00 10/10/2026')], builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
  assert.equal(read(dir)[bookingId(person(1000))].releaseSource, 'detected');
});

test('county time before Booked At never matches, even inside the roster-lag window', async () => {
  const dir = await launched();
  const quick = person(3000, 'QUICK, STAY', '10:20:00 10/10/2026');
  await run(dir, pages({ roster: [...roster25(), quick] }), { now: '2026-10-10T10:25:00-07:00' });
  // Released "10:00", 20 min before this booking: can't be this stay.
  await run(dir, pages({ roster: roster25(), releases: [release('QUICK, STAY', '10:00:00 10/10/2026')], builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
  assert.equal(read(dir)[bookingId(quick)].releaseSource, 'detected');
});

test('two release rows with one name match nobody', async () => {
  const dir = await launched();
  await run(dir, pages({ roster: roster25().slice(1), releases: [release('PERSON, NUMBER 1000', '10:30:00 10/10/2026'), release('PERSON, NUMBER 1000', '10:45:00 10/10/2026')], builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
  assert.equal(read(dir)[bookingId(person(1000))].releaseSource, 'detected');
});

test('an unparseable or fall-back-hour Released At never becomes a county time', async () => {
  for (const row of [{ name: 'PERSON, NUMBER 1000', releasedAt: null, releasedAtRaw: '', ambiguous: false },
                     { ...release('PERSON, NUMBER 1000', '10:30:00 10/10/2026'), ambiguous: true }]) {
    const dir = await launched();
    await run(dir, pages({ roster: roster25().slice(1), releases: [row], builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
    assert.equal(read(dir)[bookingId(person(1000))].releaseSource, 'detected');
  }
});

test('reappearing on the roster reverses the release and keeps it in releaseReversals', async () => {
  const dir = await launched();
  await run(dir, pages({ roster: roster25().slice(1), builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
  await run(dir, pages({ roster: roster25(), builtAt: '2026-10-10T12:05:00-07:00' }), { now: '2026-10-10T12:10:00-07:00' });
  const b = read(dir)[bookingId(person(1000))];
  assert.equal(b.status, 'in_custody');
  assert.equal(b.releasedAt, null);
  assert.equal(b.releaseSource, null);
  assert.deepEqual(b.releaseReversals, [{ releasedAt: '2026-10-10T11:10:00-07:00', releaseSource: 'detected', reversedAt: '2026-10-10T12:10:00-07:00' }]);
  assert.equal(b.lastSeenInCustodyAt, '2026-10-10T12:05:00-07:00');
  assert.equal(Object.keys(read(dir)).length, 25);
});

test('rebooked under the same Number after a seen release: a separate record', async () => {
  const dir = await launched();
  await run(dir, pages({ roster: roster25().slice(1) }), { now: '2026-10-10T11:10:00-07:00' });
  const again = person(1000, 'PERSON, NUMBER 1000', '13:00:00 10/10/2026');
  await run(dir, pages({ roster: [again, ...roster25().slice(1)] }), { now: '2026-10-10T13:10:00-07:00' });
  const d = read(dir);
  assert.equal(d[bookingId(person(1000))].status, 'released');
  assert.equal(d[bookingId(again)].status, 'in_custody');
  assert.equal(Object.keys(d).length, 26);
});

test('rebooked between two runs (new Booked At, never seen leaving): old closed as detected, new opened', async () => {
  const dir = await launched();
  const again = person(1000, 'PERSON, NUMBER 1000', '13:00:00 10/10/2026');
  await run(dir, pages({ roster: [again, ...roster25().slice(1)] }), { now: '2026-10-10T13:10:00-07:00' });
  const d = read(dir);
  assert.equal(d[bookingId(person(1000))].releaseSource, 'detected');
  assert.equal(d[bookingId(again)].status, 'in_custody');
  assert.equal(read(dir, 'status.json').inCustody, 25);
});

test('booked and released between runs: recorded from bookings.html as a short stay', async () => {
  const dir = await launched();
  const quick = person(3000, 'QUICK, STAY', '10:20:00 10/10/2026');
  await run(dir, pages({ roster: roster25(), bookings: [quick], releases: [release('QUICK, STAY', '10:50:00 10/10/2026')], builtAt: '2026-10-10T11:05:00-07:00' }), { now: '2026-10-10T11:10:00-07:00' });
  const b = read(dir)[bookingId(quick)];
  assert.equal(b.firstSeenOn, 'bookings');
  assert.equal(b.status, 'released');
  assert.equal(b.lastSeenInCustodyAt, null);
  assert.equal(b.releaseSource, 'county'); // window: Booked At -> this run
  assert.equal(b.releasedAt, '2026-10-10T10:50:00-07:00');
  // Seen again on bookings.html next hour: not duplicated.
  await run(dir, pages({ roster: roster25(), bookings: [quick], builtAt: '2026-10-10T12:05:00-07:00' }), { now: '2026-10-10T12:10:00-07:00' });
  assert.equal(Object.keys(read(dir)).length, 26);
});

test('someone on both the roster and bookings.html is one booking, in custody', async () => {
  const dir = await launched();
  const p = person(4000, 'BOTH, PAGES', '10:20:00 10/10/2026');
  await run(dir, pages({ roster: [...roster25(), p], bookings: [p] }));
  assert.equal(read(dir)[bookingId(p)].status, 'in_custody');
  assert.equal(Object.keys(read(dir)).length, 26);
});

test('charges and name refresh for people still in custody', async () => {
  const dir = await launched();
  const updated = { ...person(1000, 'PERSON, NUMBER 1000 X'), charges: [{ charge: 'THEFT 3', bondType: 'Cash', bondAmount: 500 }] };
  await run(dir, pages({ roster: [updated, ...roster25().slice(1)] }));
  const b = read(dir)[bookingId(person(1000))];
  assert.equal(b.name, 'PERSON, NUMBER 1000 X');
  assert.equal(b.charges.length, 1);
});

// --- partial-load guard (small population) ---

test('guard: a drop of 6 of 25 aborts and writes nothing', async () => {
  const dir = await launched();
  const before = snapshot(dir);
  await assert.rejects(run(dir, pages({ roster: roster25().slice(6) })), GuardError);
  assert.deepEqual(snapshot(dir), before);
});

test('guard: a drop of exactly 5 of 25 is allowed', async () => {
  const dir = await launched();
  await run(dir, pages({ roster: roster25().slice(5) }));
  assert.equal(read(dir, 'status.json').inCustody, 20);
});

test('guard: ALLOW_BIG_DROP=1 lets a real big drop through', async () => {
  const dir = await launched();
  await run(dir, pages({ roster: roster25().slice(6) }), { env: { ALLOW_BIG_DROP: '1' } });
  assert.equal(read(dir, 'status.json').inCustody, 19);
});

test('guard: new bookings in the same run offset the drop', async () => {
  const dir = await launched();
  const newcomers = [person(5001), person(5002)];
  await run(dir, pages({ roster: [...roster25().slice(6), ...newcomers] })); // -6 +2 = -4
  assert.equal(read(dir, 'status.json').inCustody, 21);
});

test('guard: a tiny roster can lose everyone but one (by design: 5-person minimum)', async () => {
  const dir = await launched([person(1), person(2), person(3), person(4), person(5)]);
  await run(dir, pages({ roster: [person(1)] }));
  assert.equal(read(dir, 'status.json').inCustody, 1);
});

// --- fetch failures, retry, dry run ---

test('a network error is retried once, then the run succeeds', async () => {
  const dir = await launched();
  let calls = 0;
  const fetchAll = async () => {
    if (++calls === 1) { const e = new Error('ETIMEDOUT'); e.isAxiosError = true; throw e; }
    return pages({ roster: roster25() });
  };
  await runScrape({ dataDir: dir, fetchAll, env: { RETRY_DELAY_MS: '0' }, now: '2026-10-10T10:10:00-07:00', ...quiet });
  assert.equal(calls, 2);
});

test('two network errors fail the run with nothing written', async () => {
  const dir = await launched();
  const before = snapshot(dir);
  let calls = 0;
  const fetchAll = async () => { calls++; const e = new Error('ECONNRESET'); e.isAxiosError = true; throw e; };
  await assert.rejects(runScrape({ dataDir: dir, fetchAll, env: { RETRY_DELAY_MS: '0' }, ...quiet }), /ECONNRESET/);
  assert.equal(calls, 2);
  assert.deepEqual(snapshot(dir), before);
});

test('a bad page (parser error) is not retried and writes nothing', async () => {
  const dir = await launched();
  const before = snapshot(dir);
  let calls = 0;
  const fetchAll = async () => { calls++; throw new Error('roster: no #main-table (error or maintenance page?)'); };
  await assert.rejects(runScrape({ dataDir: dir, fetchAll, env: {}, ...quiet }), /main-table/);
  assert.equal(calls, 1);
  assert.deepEqual(snapshot(dir), before);
});

test('DRY_RUN=1 computes everything and writes nothing', async () => {
  const dir = await launched();
  const before = snapshot(dir);
  const { status } = await run(dir, pages({ roster: roster25().slice(1) }), { env: { DRY_RUN: '1' } });
  assert.equal(status.inCustody, 24);
  assert.deepEqual(snapshot(dir), before);
});
