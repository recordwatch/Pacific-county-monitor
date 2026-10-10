import axios from 'axios';
import * as cheerio from 'cheerio';
import { parseCountyTime, normalizeSpace } from '../utils.js';

// Pacific County publishes three static HTML pages, rebuilt together every
// hour at about :05 (see the source map in CLAUDE.md):
//   roster/                everyone in custody now, with charges
//   roster/bookings.html   recent bookings (~24 h), same layout as the roster
//   roster/releases.html   recent releases (~24 h): name + Released At only
// PACIFIC_BASE_URL exists only so tests can point the scraper at a mock server.
const BASE_URL = process.env.PACIFIC_BASE_URL || 'https://co.pacific.wa.us/jail/roster/';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html',
};

const PERSON_HEADERS = ['Name', 'Number', 'Booked At', 'Notify on Release'];
const CHARGE_HEADERS = ['Arrest Date', 'Arresting Agency', 'Court', 'Billing Agency', 'Bond Type', 'Bond Amount', 'Warrant/Citation#', 'Description'];
const RELEASE_HEADERS = ['Name', 'Released At'];

// Thrown for any page that isn't the county's real table: an error or
// maintenance page, a changed layout. Never parsed as "zero people".
export class PageShapeError extends Error {}

function cellText($, el) {
  return normalizeSpace($(el).text());
}

function headerTexts($, row) {
  return $(row).children('th').map((_, th) => cellText($, th)).get();
}

function checkHeaders(page, got, expected) {
  if (got.length !== expected.length || got.some((h, i) => h !== expected[i])) {
    throw new PageShapeError(`${page}: columns are [${got.join(' | ')}], expected [${expected.join(' | ')}] (layout change?)`);
  }
}

function mainTable($, page) {
  const table = $('table#main-table');
  if (table.length !== 1) throw new PageShapeError(`${page}: no #main-table (error or maintenance page?)`);
  const tbody = table.children('tbody');
  if (tbody.length !== 1) throw new PageShapeError(`${page}: #main-table has no tbody`);
  return { table, tbody };
}

// "$10,000" -> 10000. Anything else (blank, "N/A") -> null; the raw text is
// always kept next to it.
function parseMoney(text) {
  const m = /^\$(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?$/.exec(text);
  if (!m) return null;
  return Number(m[1].replace(/,/g, '')) + (m[2] ? Number(m[2]) / 100 : 0);
}

function parseCharges($, subTable, page, number) {
  checkHeaders(`${page} charges for ${number}`, headerTexts($, $(subTable).find('thead tr').first()), CHARGE_HEADERS);
  return $(subTable).children('tbody').children('tr').map((_, tr) => {
    const c = $(tr).children('td').map((_, td) => cellText($, td)).get();
    if (c.length !== CHARGE_HEADERS.length) {
      throw new PageShapeError(`${page}: a charge row for ${number} has ${c.length} cells, expected ${CHARGE_HEADERS.length}`);
    }
    const arrest = parseCountyTime(c[0]);
    return {
      // Not this booking's arrest: it can be years before Booked At. Treat as
      // the charge's offense/case date, never as the start of a stay.
      arrestDate: arrest?.iso ?? null,
      arrestDateRaw: c[0],
      arrestAgency: c[1],
      court: c[2],
      billingAgency: c[3],
      bondType: c[4],
      // Bail set (not posted), per charge. "Same Case" rows carry $0, so
      // amounts must never be summed per booking.
      bondAmount: parseMoney(c[5]),
      bondAmountRaw: c[5],
      // Court cause numbers: GR 31 question still open (CLAUDE.md).
      caseNumber: c[6],
      charge: c[7],
    };
  }).get();
}

// Roster and bookings pages: one `tr.name` row per person, followed by a
// hidden row holding that person's charges table.
// Returns { people, warnings }. Throws PageShapeError if the page isn't
// the county's table. An empty tbody returns zero people; the caller
// decides whether that's allowed (it is for bookings, not for the roster).
export function parsePeoplePage(html, page) {
  const $ = cheerio.load(html);
  const { table, tbody } = mainTable($, page);
  checkHeaders(page, headerTexts($, table.find('thead tr').first()), PERSON_HEADERS);

  const people = [];
  const warnings = [];
  const rows = tbody.children('tr');
  rows.each((i, tr) => {
    if (!$(tr).hasClass('name')) return; // charge rows are read with their person
    const cells = $(tr).children('td');
    if (cells.length !== PERSON_HEADERS.length) {
      throw new PageShapeError(`${page}: a person row has ${cells.length} cells, expected ${PERSON_HEADERS.length}`);
    }
    const name = cellText($, cells[0]);
    const number = cellText($, cells[1]);
    const bookedAtRaw = cellText($, cells[2]);
    if (!name) throw new PageShapeError(`${page}: a person row has no name`);
    if (!/^\d+$/.test(number)) throw new PageShapeError(`${page}: ${name} has no usable Number ("${number}")`);

    const booked = parseCountyTime(bookedAtRaw);
    if (!booked) warnings.push(`${page}: ${number} Booked At "${bookedAtRaw}" doesn't parse; stored raw, bookedAt null`);
    else if (booked.ambiguous) warnings.push(`${page}: ${number} Booked At "${bookedAtRaw}" falls in the fall-back hour; read as PDT`);

    const next = rows.eq(i + 1);
    const subTable = next.find('td.inmate-info > table.sub-table');
    if (next.hasClass('name') || subTable.length !== 1) {
      throw new PageShapeError(`${page}: ${number} has no charges table after it`);
    }

    people.push({
      number,
      name,
      bookedAt: booked?.iso ?? null,
      bookedAtRaw,
      charges: parseCharges($, subTable, page, number),
    });
  });

  // Number is the key. Two rows with one Number on a single page would be
  // merged silently by a keyed store, so stop instead.
  const seen = new Set();
  for (const p of people) {
    if (seen.has(p.number)) throw new PageShapeError(`${page}: Number ${p.number} appears twice`);
    seen.add(p.number);
  }
  return { people, warnings };
}

// Releases page: name + Released At only, no Number.
// Returns { releases, warnings }. An empty tbody is normal (no releases in
// the window). A Released At that doesn't parse gives releasedAt null, so
// it can never be stored as a county time.
export function parseReleasesPage(html, page = 'releases.html') {
  const $ = cheerio.load(html);
  const { table, tbody } = mainTable($, page);
  checkHeaders(page, headerTexts($, table.find('thead tr').first()), RELEASE_HEADERS);

  const releases = [];
  const warnings = [];
  tbody.children('tr').each((_, tr) => {
    const cells = $(tr).children('td');
    if (cells.length !== RELEASE_HEADERS.length) {
      throw new PageShapeError(`${page}: a release row has ${cells.length} cells, expected ${RELEASE_HEADERS.length}`);
    }
    const name = cellText($, cells[0]);
    const releasedAtRaw = cellText($, cells[1]);
    if (!name) throw new PageShapeError(`${page}: a release row has no name`);
    const released = parseCountyTime(releasedAtRaw);
    if (!released) warnings.push(`${page}: ${name} Released At "${releasedAtRaw}" doesn't parse; not usable as a county time`);
    else if (released.ambiguous) warnings.push(`${page}: ${name} Released At "${releasedAtRaw}" falls in the fall-back hour; read as PDT`);
    releases.push({ name, releasedAt: released?.iso ?? null, releasedAtRaw, ambiguous: !!released?.ambiguous });
  });
  return { releases, warnings };
}

async function fetchPage(file) {
  const url = new URL(file, BASE_URL).toString();
  const res = await axios.get(url, { headers: HEADERS, timeout: 20000, responseType: 'text' });
  return { html: res.data, lastModified: res.headers['last-modified'] ?? null };
}

const GAP_MS = Number(process.env.PACIFIC_GAP_MS ?? 3000);

// Fetches all three pages one at a time, with a gap between requests.
// The roster must have at least one person: zero means a broken page, not
// an empty jail. Bookings and releases may be empty.
export async function scrapeAll({ sleep }) {
  const roster = await fetchPage('');
  await sleep(GAP_MS);
  const bookings = await fetchPage('bookings.html');
  await sleep(GAP_MS);
  const releases = await fetchPage('releases.html');

  const r = parsePeoplePage(roster.html, 'roster');
  if (r.people.length === 0) throw new PageShapeError('roster: 0 people (broken page?)');
  const b = parsePeoplePage(bookings.html, 'bookings.html');
  const rel = parseReleasesPage(releases.html);

  return {
    roster: r.people,
    bookings: b.people,
    releases: rel.releases,
    warnings: [...r.warnings, ...b.warnings, ...rel.warnings],
    lastModified: { roster: roster.lastModified, bookings: bookings.lastModified, releases: releases.lastModified },
  };
}
