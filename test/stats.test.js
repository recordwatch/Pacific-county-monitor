import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../frontend/src/statsUtils.js';

// Made-up bookings. Stats must never carry a name, and hour-scale stats use
// county release times only, counted from Booked At (never firstSeen).
const base = { charges: [], releaseReversals: [], firstSeenOn: 'roster', launchCohort: false, firstSeen: '2026-10-10T09:10:00-07:00' };
const bookings = {
  a: { ...base, id: 'a', name: 'SECRET, NAME ONE', status: 'released', releaseSource: 'county', bookedAt: '2026-10-10T08:00:00-07:00', releasedAt: '2026-10-10T09:00:00-07:00', firstSeen: '2026-10-10T08:30:00-07:00' },
  b: { ...base, id: 'b', name: 'SECRET, NAME TWO', status: 'released', releaseSource: 'county', bookedAt: '2026-10-08T10:00:00-07:00', releasedAt: '2026-10-10T10:00:00-07:00', launchCohort: true },
  c: { ...base, id: 'c', name: 'SECRET, NAME THREE', status: 'released', releaseSource: 'detected', bookedAt: '2026-10-10T08:00:00-07:00', releasedAt: '2026-10-10T08:20:00-07:00' },
  d: { ...base, id: 'd', name: 'SECRET, NAME FOUR', status: 'in_custody', bookedAt: '2025-09-07T05:23:00-07:00', launchCohort: true,
       charges: [{ bondType: 'Same Case', court: 'SUP', arrestAgency: 'PCSO' }, { bondType: 'Cash or Surety', court: 'SUP', arrestAgency: 'PCSO' }] },
  e: { ...base, id: 'e', name: 'SECRET, NAME FIVE', status: 'released', releaseSource: 'county', bookedAt: null, releasedAt: '2026-10-10T10:00:00-07:00' },
};

test('stats contain no names', () => {
  assert.ok(!JSON.stringify(computeStats(bookings)).includes('SECRET'));
});

test('median and within-24h use county times only, from Booked At', () => {
  const s = computeStats(bookings);
  assert.equal(s.countyStay.n, 2); // e has no parseable Booked At; c is detected
  assert.equal(s.countyStay.medianMs, (1 + 48) / 2 * 3.6e6); // a: 1 h (not 30 min from firstSeen), b: 48 h
  assert.equal(s.countyStay.within24h, 1);
  assert.equal(s.released.detected, 1);
  assert.equal(s.inCustody, 1);
});

test('buckets split by release source and cover every stay once', () => {
  const s = computeStats(bookings);
  assert.equal(s.bucketsCounty.reduce((a, b) => a + b.count, 0), 2);
  assert.equal(s.bucketsCounty.find(b => b.name === '2–3 d').count, 1); // exactly 48 h falls in 2–3 d
  assert.equal(s.bucketsDetected.find(b => b.name === 'Under 2 h').count, 1);
});

test('charge tallies are per charge', () => {
  const s = computeStats(bookings);
  assert.equal(s.chargeCount, 2);
  assert.deepEqual(s.bondTypes.map(t => [t.name, t.count]), [['Same Case', 1], ['Cash or Surety', 1]]);
});

test('empty data gives zeros, not errors', () => {
  const s = computeStats({});
  assert.equal(s.countyStay.n, 0);
  assert.equal(s.countyStay.medianMs, null);
  assert.equal(s.tracking, null);
});
