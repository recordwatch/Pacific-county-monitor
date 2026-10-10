import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parsePeoplePage, parseReleasesPage, PageShapeError } from '../scrapers/pacific.js';
import { parseCountyTime, normalizeSpace } from '../utils.js';

// Fixtures copy the county's real markup (Oct 9, 2026) with made-up people,
// so no real name is ever committed in a test file.

const CHARGE_HEAD = '<thead><tr><th>Arrest Date</th><th>Arresting Agency</th><th>Court</th><th>Billing Agency</th><th>Bond Type</th><th>Bond Amount</th><th>Warrant/Citation#</th><th>Description</th></tr></thead>';

function charge(c = {}) {
  const v = { date: '17:06:00 10/06/2024', agency: 'WSP', court: 'SDC', billing: 'WSP', bond: 'Cash or Surety', amount: '$10,000', cause: '10909', desc: 'DUI', ...c };
  return `<tr><td class="date">${v.date}</td><td>${v.agency}</td><td>${v.court}</td><td>${v.billing}</td><td>${v.bond}</td><td class="currency">${v.amount}</td><td>${v.cause}</td><td>${v.desc}</td></tr>`;
}

function person({ name = 'DOE, JANE Q', number = '100001', booked = '18:04:40 02/28/2026', charges = [charge()], chargeRow = true } = {}) {
  const row = `<tr class="name"><td class="inmate">${name}</td><td>${number}</td><td class="date">${booked}</td><td><a href="https://www.vinelink.com/vinelink/servlet/SubjectSearch?siteID=48626&amp;agency=39&amp;offenderID=${number}">Register</a></td></tr>`;
  if (!chargeRow) return row;
  return row + `<tr style="display:none;"><td class="inmate-info" colspan="4"><table class="sub-table table table-striped table-bordered">${CHARGE_HEAD}<tbody>${charges.join('')}</tbody></table></td></tr>`;
}

function peoplePage(rows, headers = ['Name', 'Number', 'Booked At', 'Notify on Release']) {
  const ths = headers.map(h => `<th>${h}</th>`).join('');
  return `<!DOCTYPE html><html><body><table id="main-table" class="table"><thead><tr>${ths}</tr><tr class="filterColumns"><td colspan="4" class="filter"><input type="text" id="filter"></td></tr></thead><tbody>${rows.join('')}</tbody></table></body></html>`;
}

function releasesPage(rows) {
  const trs = rows.map(([n, t]) => `<tr class="name"><td>${n}</td><td class="date">${t}</td></tr>`).join('');
  return `<!DOCTYPE html><html><body><table id="main-table" class="table"><thead><tr><th>Name</th><th>Released At</th></tr></thead><tbody>${trs}</tbody></table></body></html>`;
}

// --- times ---

test('county time: summer is PDT, winter is PST, always with an offset', () => {
  assert.deepEqual(parseCountyTime('10:22:33 10/09/2026'), { iso: '2026-10-09T10:22:33-07:00', ambiguous: false });
  assert.deepEqual(parseCountyTime('05:23:00 01/07/2026'), { iso: '2026-01-07T05:23:00-08:00', ambiguous: false });
});

test('county time: fall-back hour is flagged ambiguous and read as PDT', () => {
  assert.deepEqual(parseCountyTime('01:30:00 11/01/2026'), { iso: '2026-11-01T01:30:00-07:00', ambiguous: true });
});

test('county time: spring-forward gap, impossible dates, blank and other formats do not parse', () => {
  for (const t of ['02:30:00 03/08/2026', '10:00:00 02/30/2026', '', '   ', '10/09/2026 10:22:33', '10:22 10/09/2026', 'N/A', undefined]) {
    assert.equal(parseCountyTime(t), null, `"${t}" should not parse`);
  }
});

test('normalizeSpace collapses non-breaking and repeated spaces', () => {
  assert.equal(normalizeSpace('  DOE,\u00a0JANE\u00a0 Q '), 'DOE, JANE Q');
});

// --- roster / bookings ---

test('parses a normal roster row, its charges, and bail per charge', () => {
  const html = peoplePage([person({
    name: 'DOE, JANE\u00a0Q',
    charges: [charge(), charge({ bond: 'Same Case', amount: '$0', desc: 'DWLS 1ST DEG' }), charge({ bond: 'Cash or Surety', amount: '$1,000,000' })],
  })]);
  const { people, warnings } = parsePeoplePage(html, 'roster');
  assert.deepEqual(warnings, []);
  assert.equal(people.length, 1);
  const p = people[0];
  assert.equal(p.name, 'DOE, JANE Q');
  assert.equal(p.number, '100001');
  assert.equal(p.bookedAt, '2026-02-28T18:04:40-08:00');
  assert.equal(p.charges.length, 3);
  assert.equal(p.charges[0].arrestDate, '2024-10-06T17:06:00-07:00');
  assert.equal(p.charges[0].bondAmount, 10000);
  assert.equal(p.charges[1].bondType, 'Same Case');
  assert.equal(p.charges[1].bondAmount, 0);
  assert.equal(p.charges[2].bondAmount, 1000000);
});

test('bail text that is not a dollar amount is kept raw with a null amount', () => {
  const { people } = parsePeoplePage(peoplePage([person({ charges: [charge({ amount: 'N/A' }), charge({ amount: '' })] })]), 'roster');
  assert.equal(people[0].charges[0].bondAmount, null);
  assert.equal(people[0].charges[0].bondAmountRaw, 'N/A');
  assert.equal(people[0].charges[1].bondAmount, null);
});

test('several people parse, each with their own charges', () => {
  const html = peoplePage([
    person({ number: '1', charges: [charge(), charge()] }),
    person({ name: 'ROE, RICHARD', number: '2', charges: [charge({ desc: 'THEFT 3' })] }),
  ]);
  const { people } = parsePeoplePage(html, 'roster');
  assert.deepEqual(people.map(p => [p.number, p.charges.length]), [['1', 2], ['2', 1]]);
});

test('a person with an empty charges table parses with zero charges', () => {
  const { people } = parsePeoplePage(peoplePage([person({ charges: [] })]), 'roster');
  assert.equal(people[0].charges.length, 0);
});

test('empty tbody parses as zero people (normal for bookings.html)', () => {
  assert.deepEqual(parsePeoplePage(peoplePage([]), 'bookings.html'), { people: [], warnings: [] });
});

test('unparseable Booked At is kept raw, bookedAt null, with a warning', () => {
  const { people, warnings } = parsePeoplePage(peoplePage([person({ booked: '' }), person({ number: '2', booked: '02/28/2026' })]), 'roster');
  assert.equal(people[0].bookedAt, null);
  assert.equal(people[1].bookedAt, null);
  assert.equal(people[1].bookedAtRaw, '02/28/2026');
  assert.equal(warnings.length, 2);
});

test('fall-back-hour Booked At parses but warns', () => {
  const { people, warnings } = parsePeoplePage(peoplePage([person({ booked: '01:15:00 11/01/2026' })]), 'roster');
  assert.equal(people[0].bookedAt, '2026-11-01T01:15:00-07:00');
  assert.equal(warnings.length, 1);
});

test('error, maintenance and changed pages throw PageShapeError, never zero people', () => {
  const bad = {
    'maintenance page': '<html><body><h1>Site under maintenance</h1></body></html>',
    'IIS error page': '<html><body><h2>500 - Internal server error.</h2></body></html>',
    'blank body': '',
    'renamed column': peoplePage([person()], ['Name', 'Booking #', 'Booked At', 'Notify on Release']),
    'extra column': peoplePage([person()], ['Name', 'Number', 'Booked At', 'Notify on Release', 'Release Date']),
    'blank Number': peoplePage([person({ number: '' })]),
    'non-numeric Number': peoplePage([person({ number: 'PENDING' })]),
    'blank name': peoplePage([person({ name: '' })]),
    'duplicate Number': peoplePage([person(), person({ name: 'ROE, RICHARD' })]),
    'missing charges row': peoplePage([person({ chargeRow: false }), person({ number: '2' })]),
    'missing charges row on last person': peoplePage([person({ chargeRow: false })]),
    'short charge row': peoplePage([person({ charges: ['<tr><td>only one cell</td></tr>'] })]),
  };
  for (const [label, html] of Object.entries(bad)) {
    assert.throws(() => parsePeoplePage(html, 'roster'), PageShapeError, label);
  }
});

// --- releases ---

test('parses releases; empty releases page is normal', () => {
  const { releases, warnings } = parseReleasesPage(releasesPage([['DOE,\u00a0JANE Q', '14:56:00 10/08/2026']]));
  assert.deepEqual(warnings, []);
  assert.deepEqual(releases, [{ name: 'DOE, JANE Q', releasedAt: '2026-10-08T14:56:00-07:00', releasedAtRaw: '14:56:00 10/08/2026', ambiguous: false }]);
  assert.deepEqual(parseReleasesPage(releasesPage([])), { releases: [], warnings: [] });
});

test('unparseable Released At gives releasedAt null (never a county time) and a warning', () => {
  const { releases, warnings } = parseReleasesPage(releasesPage([['DOE, JANE Q', ''], ['ROE, RICHARD', '10/08/2026']]));
  assert.equal(releases[0].releasedAt, null);
  assert.equal(releases[1].releasedAt, null);
  assert.equal(warnings.length, 2);
});

test('releases page that is not the county table throws', () => {
  assert.throws(() => parseReleasesPage('<html><body>Service Unavailable</body></html>'), PageShapeError);
  assert.throws(() => parseReleasesPage(peoplePage([])), PageShapeError); // wrong page's columns
  assert.throws(() => parseReleasesPage(releasesPage([['', '14:56:00 10/08/2026']])), PageShapeError);
});

// --- scrapeAll against a mock server ---

function mockServer(pages) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const page = pages[req.url];
    if (page === undefined) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Last-Modified': 'Fri, 09 Oct 2026 20:05:01 GMT' });
    res.end(page);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}/jail/roster/` })));
}

async function loadScraper(base) {
  process.env.PACIFIC_BASE_URL = base;
  process.env.PACIFIC_GAP_MS = '0';
  return import(`../scrapers/pacific.js?base=${encodeURIComponent(base)}`);
}

test('scrapeAll fetches the three pages one at a time, in order, with a gap between', async () => {
  const { server, hits, base } = await mockServer({
    '/jail/roster/': peoplePage([person()]),
    '/jail/roster/bookings.html': peoplePage([]),
    '/jail/roster/releases.html': releasesPage([]),
  });
  try {
    const { scrapeAll } = await loadScraper(base);
    const sleeps = [];
    const out = await scrapeAll({ sleep: async ms => { sleeps.push(ms); } });
    assert.deepEqual(hits, ['/jail/roster/', '/jail/roster/bookings.html', '/jail/roster/releases.html']);
    assert.equal(sleeps.length, 2);
    assert.equal(out.roster.length, 1);
    assert.equal(out.bookings.length, 0);
    assert.equal(out.lastModified.roster, 'Fri, 09 Oct 2026 20:05:01 GMT');
  } finally { server.close(); }
});

test('scrapeAll: a roster with zero people fails the run', async () => {
  const { server, base } = await mockServer({
    '/jail/roster/': peoplePage([]),
    '/jail/roster/bookings.html': peoplePage([]),
    '/jail/roster/releases.html': releasesPage([]),
  });
  try {
    // A fresh module copy (pointed at the mock server) has its own error class.
    const { scrapeAll, PageShapeError: FreshPageShapeError } = await loadScraper(base);
    await assert.rejects(scrapeAll({ sleep: async () => {} }), FreshPageShapeError);
  } finally { server.close(); }
});

test('scrapeAll: an HTTP error on any page rejects (no partial result)', async () => {
  const { server, base } = await mockServer({
    '/jail/roster/': peoplePage([person()]),
    '/jail/roster/bookings.html': peoplePage([]),
    // releases.html missing -> 404
  });
  try {
    const { scrapeAll } = await loadScraper(base);
    await assert.rejects(scrapeAll({ sleep: async () => {} }), err => err.isAxiosError && err.response?.status === 404);
  } finally { server.close(); }
});
