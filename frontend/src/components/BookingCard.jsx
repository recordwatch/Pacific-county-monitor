import { useState } from 'react'
import { showTime, duration } from '../format'
import { stayMs } from '../statsUtils'

function bail(c) {
  if (c.bondType === 'Same Case') return 'Same case (bail set on another charge)'
  const amount = c.bondAmount != null ? `$${c.bondAmount.toLocaleString('en-US')}` : c.bondAmountRaw
  if (c.bondType === 'Sentenced' || c.bondType === 'No Bail Allowed' || c.bondType === 'Bail Not Set') return c.bondType
  return [amount, c.bondType && `(${c.bondType})`].filter(Boolean).join(' ')
}

export default function BookingCard({ entry, now }) {
  const [open, setOpen] = useState(false)
  const released = entry.status === 'released'
  // Stays always start at the county's Booked At, never at firstSeen.
  const heldMs = released ? stayMs(entry) : Date.parse(now) - Date.parse(entry.bookedAt)
  const approx = released && entry.releaseSource !== 'county'
  const held = duration(heldMs)

  return (
    <div className={`card ${released ? 'card-released' : 'card-custody'}`}>
      <div className="card-header" onClick={() => setOpen(!open)}>
        <div className="card-left">
          <div className="card-name">{entry.name}</div>
          <div className="card-meta">
            #{entry.number} &nbsp;·&nbsp; Booked: {showTime(entry.bookedAt) ?? entry.bookedAtRaw}
            {held && (
              <span className="card-time-held"> &nbsp;·&nbsp; {released ? 'Held' : 'Held so far'}: {approx ? `about ${held}` : held}</span>
            )}
          </div>
        </div>
        <div className="card-right">
          <span className={`badge ${released ? 'badge-released' : 'badge-custody'}`}>{released ? 'Released' : 'In Custody'}</span>
          <span className="card-toggle">{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {open && (
        <div className="card-body">
          {released && (
            <div className="card-release-row">
              {entry.releaseSource === 'county' ? (
                <>Released: {showTime(entry.releasedAt)} (county release time)</>
              ) : (
                <span className="card-approx">
                  Left the roster between {showTime(entry.lastSeenInCustodyAt) ?? 'booking'} and {showTime(entry.detectedReleasedAt)}.
                  {' '}The county's release time wasn't matched, so the time held is approximate.
                </span>
              )}
            </div>
          )}
          {entry.firstSeenOn === 'bookings' && (
            <div className="card-release-row card-approx">Booked and released between two hourly checks; seen only on the county's recent-bookings list.</div>
          )}
          <div className="card-charges">
            <div className="charges-title">Charges ({entry.charges.length})</div>
            {entry.charges.length === 0 && <div className="charge-row charge-pending">None listed by the county.</div>}
            {entry.charges.map((c, i) => (
              <div key={i} className="charge-row">
                <div className="charge-violation">{c.charge || 'Charge not listed'}</div>
                <div className="charge-bail">Bail: {bail(c)}</div>
                <div className="charge-meta">
                  {[c.court && `Court: ${c.court}`, c.caseNumber && `Case/Warrant #${c.caseNumber}`,
                    c.arrestAgency && `Arresting agency: ${c.arrestAgency}`,
                    c.arrestDateRaw && `Charge date: ${showTime(c.arrestDate) ?? c.arrestDateRaw}`].filter(Boolean).join(' · ')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
