import HBarList from './HBarList'
import { computeStats } from '../statsUtils'
import { showDay, showTime, duration } from '../format'

// Counts only: computeStats never returns a name.

function Range({ r }) {
  return r ? <>{showDay(r.from)} – {showDay(r.to)}</> : <>no data yet</>
}

function Card({ num, label, sub }) {
  return (
    <div className="stat-card">
      <div className="stat-card-num">{num}</div>
      <div className="stat-card-label">{label}</div>
      {sub && <div className="stat-card-sub">{sub}</div>}
    </div>
  )
}

export default function StatsPage({ bookings, status }) {
  const s = computeStats(bookings)
  const cs = s.countyStay
  const pct = n => (cs.n ? `${((n / cs.n) * 100).toFixed(0)}%` : '—')

  return (
    <div>
      <div className="section-title">Overview</div>
      <div className="stats-grid">
        <Card num={s.inCustody} label="In custody now" sub={`as of ${showTime(status.countyLastModified?.roster) ?? '—'}`} />
        <Card num={s.released.total} label="Releases recorded" sub={<Range r={s.released.range} />} />
        <Card num={cs.n ? duration(cs.medianMs) : '—'} label="Median stay" sub={`n = ${cs.n}, county release times only`} />
        <Card num={pct(cs.within24h)} label="Out within 24 hours" sub={`${cs.within24h} of ${cs.n}, county release times only`} />
      </div>
      <ul className="caveats">
        <li>Tracking began {s.tracking ? showDay(s.tracking.from) : '—'}. The {s.launchCohort} people already listed then are included, with stays counted from their real booking time.</li>
        <li>Stays are counted from the county's booking time to release. Only people who already left are counted; current long holds are not in these numbers.</li>
        <li>Median and "within 24 hours" use only releases matched to the county's own release time ({s.released.county} of {s.released.total}). The rest ({s.released.detected}) are times we noticed someone gone, accurate to about an hour.</li>
        <li>"In custody" is everyone on the county roster; the county does not say who is on work release or home detention.</li>
      </ul>

      <div className="section-title">Length of stay (county release times, n = {cs.n})</div>
      <HBarList items={s.bucketsCounty} />
      <div className="section-title">Length of stay (noticed-gone times, approximate, n = {s.released.detected})</div>
      <HBarList items={s.bucketsDetected} />

      <div className="section-title">Bail type, per charge (n = {s.chargeCount} charges)</div>
      <div className="section-note">Bail set, not posted. "Same Case" charges carry $0 because the bail is on another charge of the same case.</div>
      <HBarList items={s.bondTypes} />

      <div className="section-title">Court, per charge (n = {s.chargeCount})</div>
      <div className="section-note">County court codes; meanings not yet confirmed.</div>
      <HBarList items={s.courts} />

      <div className="section-title">Arresting agency, per charge (n = {s.chargeCount})</div>
      <HBarList items={s.arrestAgencies} />

      <ul className="caveats">
        <li>{s.shortStaysFromBookingsPage} booking(s) were booked and released between two hourly checks and were seen only on the county's recent-bookings list.</li>
        <li>{s.reversals} release(s) were reversed after the person reappeared on the roster.</li>
      </ul>
    </div>
  )
}
