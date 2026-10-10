import { showTime } from '../format'

export default function StatBar({ status }) {
  return (
    <div className="statbar">
      <div className="stat">
        <div className="stat-num">{status.inCustody}</div>
        <div className="stat-label">Currently in custody</div>
      </div>
      <div className="stat">
        <div className="stat-num">{showTime(status.countyLastModified?.roster) ?? '—'}</div>
        <div className="stat-label">County roster as of</div>
      </div>
      <div className="stat">
        <div className="stat-num">{showTime(status.lastUpdated) ?? '—'}</div>
        <div className="stat-label">Last checked</div>
      </div>
    </div>
  )
}
