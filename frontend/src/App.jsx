import { useState, useEffect } from 'react'
import { HashRouter, Routes, Route, NavLink } from 'react-router-dom'
import Header from './components/Header'
import StatBar from './components/StatBar'
import BookingCard from './components/BookingCard'
import StatsPage from './components/StatsPage'
import { showDay } from './format'

function useData() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    Promise.all([
      fetch('./data/bookings.json').then(r => { if (!r.ok) throw new Error(`bookings.json: ${r.status}`); return r.json() }),
      fetch('./data/status.json').then(r => { if (!r.ok) throw new Error(`status.json: ${r.status}`); return r.json() }),
    ]).then(([bookings, status]) => setData({ bookings, status })).catch(e => setError(e.message))
  }, [])
  return { data, error }
}

const byTime = field => (a, b) => (Date.parse(b[field]) || 0) - (Date.parse(a[field]) || 0)

function List({ entries, groupBy, now }) {
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const shown = q ? entries.filter(e => e.name.toLowerCase().includes(q)) : entries
  const groups = []
  for (const e of shown) {
    const day = showDay(e[groupBy])
    if (groups.at(-1)?.day !== day) groups.push({ day, entries: [] })
    groups.at(-1).entries.push(e)
  }
  return (
    <>
      <input className="search-input" placeholder="Search by name..." value={search} onChange={e => setSearch(e.target.value)} />
      {shown.length === 0 ? <div className="empty">No records match.</div> : (
        <div className="log">
          <div className="log-count">{shown.length} record{shown.length !== 1 ? 's' : ''}</div>
          {groups.map(g => (
            <div key={g.day}>
              <div className="date-separator">{g.day}</div>
              {g.entries.map(e => <BookingCard key={e.id} entry={e} now={now} />)}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function Tabs() {
  const cls = ({ isActive }) => (isActive ? 'active' : '')
  return (
    <div className="filter-tabs">
      <NavLink to="/" end className={cls}>In Custody</NavLink>
      <NavLink to="/released" className={cls}>Released</NavLink>
      <NavLink to="/stats" className={cls}>Stats</NavLink>
    </div>
  )
}

function Page({ children }) {
  const { data, error } = useData()
  return (
    <div className="app">
      <Header />
      {data && <StatBar status={data.status} />}
      <div className="controls"><Tabs /></div>
      {error ? <div className="empty">Couldn't load the data ({error}).</div>
        : !data ? <div className="loading">Loading records...</div>
        : children(data)}
    </div>
  )
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Page>{({ bookings, status }) => (
          <List now={status.lastUpdated} groupBy="bookedAt"
            entries={Object.values(bookings).filter(b => b.status === 'in_custody').sort(byTime('bookedAt'))} />
        )}</Page>} />
        <Route path="/released" element={<Page>{({ bookings, status }) => (
          <List now={status.lastUpdated} groupBy="releasedAt"
            entries={Object.values(bookings).filter(b => b.status === 'released').sort(byTime('releasedAt'))} />
        )}</Page>} />
        <Route path="/stats" element={<Page>{({ bookings, status }) => <StatsPage bookings={bookings} status={status} />}</Page>} />
      </Routes>
    </HashRouter>
  )
}
