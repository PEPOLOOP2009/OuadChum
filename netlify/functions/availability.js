// Fetches RoomScope's own availability-calendar page server-side (their booking
// system has no public JSON API) and parses it into plain data so the site can
// render the calendar in its own design instead of embedding their page.
//
// RoomScope internals this depends on, discovered by inspecting their rendered
// HTML — if they restyle their calendar this parser may need updating:
//   - <td class="bg-empty|bg-almostempty|bg-almostfull|bg-full ..." data-rs-msg="{typeId}-availability-{d}-{m}-{y}">
//   - <span class="date-remark weekend|holiday">
//   - <span class="number">{count} x</span> inside the day's tooltip
//   - <div id="availability-calendar" data-rs-startdate/-prevdate/-nextdate/-prev="true|false">
const ROOM_TYPE_IDS = {
  '001': 48944, '201': 48920, '202': 48990, '203': 48918, '204': 48992,
  '301': 48994, '302': 48996, '401': 48998, '403': 49000, '404': 49002
};
const TOTAL_ROOMS = Object.keys(ROOM_TYPE_IDS).length;

const STATUS_MAP = {
  'bg-empty': 'available',
  'bg-almostempty': 'almost-available',
  'bg-almostfull': 'almost-full',
  'bg-full': 'full'
};

const CELL_REGEX = /<td class="([^"]*)"\s+data-rs-msg="\d+-availability-(\d+)-(\d+)-(\d+)">([\s\S]*?)<\/td>/g;

function parseCalendar(html) {
  const startMatch = html.match(/data-rs-startdate="(\d{4}-\d{2}-\d{2})"/);
  if (!startMatch) return null;

  const prevMatch = html.match(/data-rs-prevdate="(\d{4}-\d{2}-\d{2})"/);
  const nextMatch = html.match(/data-rs-nextdate="(\d{4}-\d{2}-\d{2})"/);
  const hasPrevMatch = html.match(/data-rs-prev="(true|false)"/);

  const curStart = startMatch[1];
  const curYear = parseInt(curStart.slice(0, 4), 10);
  const curMonth = parseInt(curStart.slice(5, 7), 10);

  const days = [];
  let m;
  CELL_REGEX.lastIndex = 0;
  while ((m = CELL_REGEX.exec(html)) !== null) {
    const [, classAttr, dayStr, monthStr, yearStr, inner] = m;
    const day = parseInt(dayStr, 10);
    const month = parseInt(monthStr, 10);
    const year = parseInt(yearStr, 10);

    const statusToken = classAttr.split(/\s+/).find((c) => STATUS_MAP[c]);
    const status = statusToken ? STATUS_MAP[statusToken] : null;

    const remarkMatch = inner.match(/date-remark ([a-z\s]*)"/);
    const remark = remarkMatch ? remarkMatch[1] : '';

    const countMatch = inner.match(/<span class="number">(\d+)/);
    const count = countMatch ? parseInt(countMatch[1], 10) : (status === 'full' ? 0 : null);

    days.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      inMonth: month === curMonth && year === curYear,
      status,
      count,
      weekend: remark.includes('weekend'),
      holiday: remark.includes('holiday')
    });
  }

  return {
    month: { year: curYear, month: curMonth, startDate: curStart },
    prevDate: prevMatch ? prevMatch[1] : null,
    nextDate: nextMatch ? nextMatch[1] : null,
    hasPrev: hasPrevMatch ? hasPrevMatch[1] === 'true' : true,
    days
  };
}

async function fetchCalendar(typeId, lang, monthParam) {
  let url = `https://reservation.roomscope.com/2698/${lang}/rsvn/availability?SelectedRoomTypes%5B0%5D=${typeId}`;
  if (monthParam) url += `&StartDate=${monthParam}`;

  const upstream = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OuadChumAvailabilityBot/1.0; +https://ouadchum.com)' }
  });
  if (!upstream.ok) throw new Error(`RoomScope responded ${upstream.status}`);
  const html = await upstream.text();
  const parsed = parseCalendar(html);
  if (!parsed) throw new Error('Unrecognized RoomScope page structure');
  return parsed;
}

// Combines every room type's calendar into one grid: a day's count is the sum of
// rooms free that day across all types, banded into the same 4 status levels so
// it renders with the same legend as a single-room calendar.
function aggregateCalendars(calendars) {
  const base = calendars[0];
  const byDate = new Map();

  calendars.forEach((cal) => {
    cal.days.forEach((d) => {
      if (!byDate.has(d.date)) {
        byDate.set(d.date, { date: d.date, inMonth: d.inMonth, weekend: d.weekend, holiday: d.holiday, statuses: [] });
      }
      byDate.get(d.date).statuses.push(d);
    });
  });

  const days = Array.from(byDate.values()).map((entry) => {
    const known = entry.statuses.filter((s) => s.status !== null);
    if (known.length === 0) {
      return { date: entry.date, inMonth: entry.inMonth, status: null, count: null, weekend: entry.weekend, holiday: entry.holiday };
    }
    const sum = known.reduce((acc, s) => acc + (s.count || 0), 0);
    let status;
    if (sum === 0) status = 'full';
    else if (sum <= Math.ceil(TOTAL_ROOMS * 0.3)) status = 'almost-full';
    else if (sum <= Math.ceil(TOTAL_ROOMS * 0.6)) status = 'almost-available';
    else status = 'available';
    return { date: entry.date, inMonth: entry.inMonth, status, count: sum, weekend: entry.weekend, holiday: entry.holiday };
  }).sort((a, b) => a.date.localeCompare(b.date));

  return {
    month: base.month,
    prevDate: base.prevDate,
    nextDate: base.nextDate,
    hasPrev: base.hasPrev,
    days
  };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const roomId = params.roomId;
  const lang = params.lang === 'en' ? 'en' : 'th';
  const monthParam = params.month && /^\d{4}-\d{2}-\d{2}$/.test(params.month) ? params.month : null;

  const isAll = roomId === 'all';
  const typeId = isAll ? null : ROOM_TYPE_IDS[roomId];
  if (!isAll && !typeId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unknown roomId' })
    };
  }

  try {
    let calendar;
    if (isAll) {
      const calendars = await Promise.all(
        Object.values(ROOM_TYPE_IDS).map((id) => fetchCalendar(id, lang, monthParam))
      );
      calendar = aggregateCalendars(calendars);
    } else {
      calendar = await fetchCalendar(typeId, lang, monthParam);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // Short edge/browser cache: keeps the calendar close to live while avoiding
        // hammering RoomScope on every card render / month flip.
        'Cache-Control': 'public, max-age=180, stale-while-revalidate=600'
      },
      body: JSON.stringify({ roomId, typeId, ...calendar })
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Failed to reach RoomScope' })
    };
  }
};
