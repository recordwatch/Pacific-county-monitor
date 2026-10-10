const TZ = 'America/Los_Angeles';

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

// Pacific wall-clock fields for an instant.
function pacificFields(date) {
  const f = Object.fromEntries(parts.formatToParts(date).map(p => [p.type, p.value]));
  return { y: +f.year, mo: +f.month, d: +f.day, h: +f.hour, mi: +f.minute, s: +f.second };
}

function pad(n, len = 2) { return String(n).padStart(len, '0'); }

function offsetString(minutes) {
  const sign = minutes <= 0 ? '-' : '+';
  const a = Math.abs(minutes);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// Offset (minutes, e.g. -420 for PDT) that Pacific time has at this instant.
function pacificOffsetAt(date) {
  const f = pacificFields(date);
  const asUTC = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
  return Math.round((asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

// An instant as ISO 8601 in Pacific time with its offset,
// e.g. 2026-10-09T06:37:16-07:00. Never zoneless: Safari rejects some
// zoneless strings, and an offset makes every stored time unambiguous.
export function toPacificISO(date) {
  const f = pacificFields(date);
  const off = pacificOffsetAt(date);
  return `${f.y}-${pad(f.mo)}-${pad(f.d)}T${pad(f.h)}:${pad(f.mi)}:${pad(f.s)}${offsetString(off)}`;
}

export function nowPacificISO() {
  return toPacificISO(new Date());
}

// Pacific wall-clock fields -> ISO 8601 with offset, or null if the fields
// aren't a real Pacific time. Returns { iso, ambiguous }: during the
// November fall-back hour (01:00-01:59 happens twice) the earlier (PDT)
// reading is used and ambiguous is true, so callers can flag it.
// A time inside the spring-forward gap (02:00-02:59 in March) doesn't exist
// and returns null.
export function pacificWallClockToISO(y, mo, d, h, mi, s) {
  if (![y, mo, d, h, mi, s].every(Number.isInteger)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const matches = [];
  for (const off of [-420, -480]) { // PDT, PST
    const instant = new Date(wall - off * 60000);
    const f = pacificFields(instant);
    if (f.y === y && f.mo === mo && f.d === d && f.h === h && f.mi === mi && f.s === s) {
      matches.push(instant);
    }
  }
  if (matches.length === 0) return null;
  return { iso: toPacificISO(matches[0]), ambiguous: matches.length > 1 };
}

// The county's format: "HH:MM:SS MM/DD/YYYY" (time first), no zone, assumed
// Pacific wall-clock (see Pending verification in CLAUDE.md).
// Returns { iso, ambiguous } or null if the text doesn't parse.
export function parseCountyTime(text) {
  const m = /^(\d{2}):(\d{2}):(\d{2}) (\d{2})\/(\d{2})\/(\d{4})$/.exec((text || '').trim());
  if (!m) return null;
  const [, h, mi, s, mo, d, y] = m.map(Number);
  return pacificWallClockToISO(y, mo, d, h, mi, s);
}

// Collapse every kind of whitespace (including the non-breaking spaces the
// county puts in some names) to one plain space, and trim.
export function normalizeSpace(text) {
  return (text || '').replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000\ufeff]+/g, ' ').trim();
}
