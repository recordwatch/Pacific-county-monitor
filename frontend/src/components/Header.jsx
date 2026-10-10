export default function Header() {
  return (
    <header className="header">
      <div className="header-inner">
        <div className="header-title">
          <span className="header-county">Pacific County</span>
          <h1>Jail Roster</h1>
        </div>
        <div className="header-sub">
          <a className="header-hub" href="https://wajaildata.org">← Washington Jail Data</a>
          <div>Public records — Pacific County Jail</div>
        </div>
      </div>
    </header>
  )
}
