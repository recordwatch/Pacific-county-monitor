// Stats from data/bookings.json. Every function returns counts only, never
// names, so nothing on the Stats page can identify a person.
//
// Rules (CLAUDE.md / the audit doc):
// - Stays start at the county's Booked At, never firstSeen.
// - Hour-scale stats (median, % out within 24 h) use county release times only.
// - Stats only count people who already left; current holds aren't in them.

const ms = iso => (iso ? Date.parse(iso) : NaN)

export function stayMs(b) {
  const t = ms(b.releasedAt) - ms(b.bookedAt)
  return t > 0 ? t : null
}

function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function range(isos) {
  const t = isos.map(ms).filter(n => !Number.isNaN(n))
  if (!t.length) return null
  return { from: new Date(Math.min(...t)).toISOString(), to: new Date(Math.max(...t)).toISOString() }
}

function tally(values) {
  const m = new Map()
  for (const v of values) m.set(v || '(blank)', (m.get(v || '(blank)') || 0) + 1)
  const total = values.length
  return [...m].map(([name, count]) => ({ name, count, pct: total ? (count / total) * 100 : 0 }))
    .sort((a, b) => b.count - a.count)
}

export const BUCKETS = [
  ['Under 2 h', 2], ['2–6 h', 6], ['6–12 h', 12], ['12–24 h', 24], ['1–2 d', 48],
  ['2–3 d', 72], ['3–7 d', 168], ['7–30 d', 720], ['Over 30 d', Infinity],
]

function buckets(stays) {
  return BUCKETS.map(([name, maxH], i) => {
    const minH = i ? BUCKETS[i - 1][1] : 0
    return { name, count: stays.filter(t => t / 3.6e6 >= minH && t / 3.6e6 < maxH).length }
  })
}

export function computeStats(bookingsObj) {
  const all = Object.values(bookingsObj)
  const released = all.filter(b => b.status === 'released')
  const county = released.filter(b => b.releaseSource === 'county' && stayMs(b) !== null)
  const detected = released.filter(b => b.releaseSource === 'detected' && stayMs(b) !== null)
  const countyStays = county.map(stayMs)

  const charges = all.flatMap(b => b.charges || [])
  return {
    tracking: range(all.map(b => b.firstSeen)),
    inCustody: all.filter(b => b.status === 'in_custody').length,
    launchCohort: all.filter(b => b.launchCohort).length,
    bookingsTotal: all.length,
    released: {
      total: released.length,
      county: county.length,
      detected: detected.length,
      range: range(released.map(b => b.releasedAt)),
    },
    countyStay: {
      n: countyStays.length,
      medianMs: median(countyStays),
      within24h: countyStays.filter(t => t < 24 * 3.6e6).length,
      range: range(county.map(b => b.releasedAt)),
    },
    bucketsCounty: buckets(countyStays),
    bucketsDetected: buckets(detected.map(stayMs)),
    shortStaysFromBookingsPage: all.filter(b => b.firstSeenOn === 'bookings').length,
    reversals: all.filter(b => (b.releaseReversals || []).length).length,
    // Per charge, not per booking: one booking usually has several charges.
    chargeCount: charges.length,
    bondTypes: tally(charges.map(c => c.bondType)),
    courts: tally(charges.map(c => c.court)),
    arrestAgencies: tally(charges.map(c => c.arrestAgency)),
  }
}
