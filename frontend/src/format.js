// Display helpers. Stored times are ISO 8601 with an offset, which every
// browser (Safari included) parses; they're shown in Pacific time.
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  month: '2-digit', day: '2-digit', year: 'numeric',
  hour: 'numeric', minute: '2-digit',
})
const dayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', year: 'numeric',
})

export function showTime(iso) {
  const d = iso ? new Date(iso) : null
  return d && !isNaN(d) ? fmt.format(d) : null
}

export function showDay(iso) {
  const d = iso ? new Date(iso) : null
  return d && !isNaN(d) ? dayFmt.format(d) : 'Unknown date'
}

export function duration(ms) {
  if (!(ms > 0)) return null
  const mins = Math.floor(ms / 60000)
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
