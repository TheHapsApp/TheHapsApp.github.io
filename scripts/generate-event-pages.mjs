#!/usr/bin/env node
/* Pre-renders a static page per upcoming event at /event/{id}/index.html and
 * regenerates sitemap.xml, so event content is crawlable and shared links get
 * per-event titles/descriptions/images (the SPA at / renders client-side and
 * is invisible to crawlers).
 *
 * Mirrors the web browser's feed gates (events/app.js): merged_into null,
 * is_hidden false, is_low_priority false, is_virtual false,
 * enrichment_status != expanded. No location gate — pages are generated for
 * every region in the catalog.
 *
 * Recently-ended events (started within KEEP_PAST_DAYS) keep their pages —
 * rendered with an "ended" notice — instead of 404ing the morning after
 * Google crawled them; they drop out of the sitemap and landing lists.
 *
 * Multi-date series collapse the same way the app and web grid do
 * (exhibit_id, else normalized title|venue). Every occurrence gets a page so
 * any shared /event/{id} link previews correctly, but non-representative
 * occurrences canonical-link to the representative and only representatives
 * are listed in the sitemap, so search engines see one page per real-world
 * event. The representative is sticky across builds (persisted next to the
 * --cache dataset) so canonicals don't flap as occurrences pass.
 *
 * sitemap <lastmod> is content-hash based: a page's lastmod only moves when
 * its rendered content actually changes. (events.updated_at is bumped by the
 * nightly re-scrape on every touched row, so using it stamped ~65% of the
 * sitemap "modified today" every day — a lastmod crawlers learn to ignore.)
 *
 * Usage: node scripts/generate-event-pages.mjs --site <dir>
 *   <dir> is a built copy of the site; pages land in <dir>/event/,
 *   sitemap at <dir>/sitemap.xml.
 */
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const SB = 'https://cvcnugkqdgmcntsuplaj.supabase.co/rest/v1';
const KEY = 'sb_publishable_8FPhq5etjCNGvPwaQyFyCA_La2INImz';
const SITE = 'https://thehaps.app';
const APP_ID = '6775696204';
const PAGE = 1000;
const GRACE_MS = 4 * 3600e3;      // an occurrence stays "live" until 4h past its end (or start when no end)
const KEEP_PAST_DAYS = 7;         // ended events keep a (noticed) page this long before 404ing
const RELATED_CAP = 6;            // cross-links per event page ("More events near {city}")
// How long a cached dataset (--cache) may be reused before we refetch anyway,
// even on a push, so the site self-heals if the nightly refresh ever fails.
const CACHE_MAX_AGE_MS = 24 * 3600e3;

const SELECT = 'id,title,one_line_summary,description,start_time,end_time,venue,address,city,state,' +
  'latitude,longitude,image_url,ticket_url,event_url,link_url,original_url,is_free,price_summary,' +
  'age_restriction,precision_class,is_long_running,exhibit_id,updated_at';
// Category map is fetched separately (see attachCategories) rather than embedded
// in SELECT — embedding made every offset page recompute the category JSON for
// all preceding rows, blowing the 3s anon statement_timeout past ~28k events.
const ECM_SELECT = 'event_id,is_primary,event_categories(name,slug)';
const ECM_CHUNK = 150; // event ids per batch — keeps each ?in.(...) URL well under proxy limits

// Static pages preserved at the head of the generated sitemap.
const STATIC_URLS = [
  ['/', 'daily', '1.0'],
  ['/about/', 'monthly', '0.7'],
  ['/beta', 'monthly', '0.8'],
  ['/privacy', 'yearly', '0.5'],
  ['/terms', 'yearly', '0.5'],
  ['/delete-account', 'yearly', '0.5']
];

/* City landing pages: same centers/radius as the interactive browser's city
 * picker (events/app.js CITIES), Utah only while CA scraping is paused.
 * `browser` is the hash slug the SPA understands (/#city=...). */
const LANDING_CITIES = [
  { slug: 'salt-lake-city', browser: 'slc', name: 'Salt Lake City', lat: 40.7608, lng: -111.8910,
    blurb: 'From downtown concerts and festivals to family days in the parks, Salt Lake City always has something going on. Here’s everything coming up around SLC, updated every day.' },
  { slug: 'provo', browser: 'provo', name: 'Provo & Orem', lat: 40.2338, lng: -111.6585,
    blurb: 'Utah Valley keeps busy — live music, campus events, outdoor adventures, and family fun across Provo, Orem, and the surrounding cities, updated every day.' },
  { slug: 'ogden', browser: 'ogden', name: 'Ogden', lat: 41.2230, lng: -111.9738,
    blurb: 'Historic 25th Street, the mountains next door, and a packed local calendar — here’s what’s happening in and around Ogden, updated every day.' },
  { slug: 'park-city', browser: 'park-city', name: 'Park City', lat: 40.6461, lng: -111.4980,
    blurb: 'Mountain-town living means concerts, art strolls, outdoor events, and après everything. Here’s what’s coming up in Park City, updated every day.' },
  { slug: 'logan', browser: 'logan', name: 'Logan', lat: 41.7370, lng: -111.8338,
    blurb: 'Cache Valley’s best events — theater, markets, university happenings, and family activities in and around Logan, updated every day.' },
  { slug: 'st-george', browser: 'st-george', name: 'St. George', lat: 37.0965, lng: -113.5684,
    blurb: 'Sunshine, red rock, and a busy calendar — concerts, outdoor adventures, and community events across St. George and southern Utah, updated every day.' }
];
const CITY_RADIUS_MI = 25;
const CAT_PAGE_MIN_GROUPS = 4;     // skip thin category pages
const HUB_WINDOW_DAYS = 60;
const FREE_WINDOW_DAYS = 30;
const LIST_CAP = 60;

// Per-category landing-page phrasing (falls back to "{label} events in {city}").
const CAT_PHRASES = {
  'music': 'Live music & concerts in',
  'food-drink': 'Food & drink events in',
  'nightlife': 'Nightlife & late-night events in',
  'arts-culture': 'Arts & culture events in',
  'theater-performing-arts': 'Theater & performing arts in',
  'film-cinema': 'Movie screenings & film events in',
  'family-kids': 'Family & kids activities in',
  'outdoors-nature': 'Outdoor activities & nature events in',
  'sports-fitness': 'Sports & fitness events in',
  'markets-shopping': 'Markets & shopping events in',
  'community': 'Community events in',
  'date-night': 'Date night ideas in',
  'education-workshops': 'Classes & workshops in',
  'health-wellness': 'Health & wellness events in',
  'holidays-seasonal': 'Seasonal & holiday events in',
  'networking-business': 'Networking & business events in',
  'religious-spiritual': 'Religious & spiritual events in',
  'service': 'Volunteer & service opportunities in',
  'singles': 'Singles events in',
  'teens': 'Teen events & activities in'
};

const CATS = {
  'music': ['Music', '🎵'], 'food-drink': ['Food & Drink', '🍜'], 'nightlife': ['Nightlife', '🍸'],
  'arts-culture': ['Arts & Culture', '🎨'], 'theater-performing-arts': ['Theater', '🎭'],
  'film-cinema': ['Film', '🎬'], 'family-kids': ['Family & Kids', '🎈'],
  'outdoors-nature': ['Outdoors', '🌲'], 'sports-fitness': ['Sports & Fitness', '🏃'],
  'markets-shopping': ['Markets', '🛍️'], 'community': ['Community', '🤝'],
  'date-night': ['Date Night', '🌹'], 'education-workshops': ['Workshops', '📚'],
  'health-wellness': ['Wellness', '🧘'], 'holidays-seasonal': ['Seasonal', '🎉'],
  'networking-business': ['Networking', '💼'], 'religious-spiritual': ['Spiritual', '🕊️'],
  'service': ['Service', '💗'], 'singles': ['Singles', '💘'], 'teens': ['Teens', '🎮']
};

// ---------- utils ----------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Sources store HTML in `description`, and entities can survive in any text
// field. Mirror the app + SPA: decode entities first, then strip tags. esc()
// still runs last before output, so pages stay injection-safe.
const NAMED_ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', sbquo: '‚',
  ldquo: '“', rdquo: '”', bdquo: '„',
  ndash: '–', mdash: '—', hellip: '…',
  copy: '©', reg: '®', trade: '™',
  middot: '·', bull: '•', laquo: '«', raquo: '»', deg: '°',
  eacute: 'é', Eacute: 'É', aacute: 'á', Aacute: 'Á',
  iacute: 'í', oacute: 'ó', uacute: 'ú',
  ntilde: 'ñ', Ntilde: 'Ñ', ouml: 'ö', uuml: 'ü',
  auml: 'ä', agrave: 'à', iexcl: '¡'
};
function decodeEntities(s) {
  if (s == null) return '';
  s = String(s);
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = (body[1] === 'x' || body[1] === 'X')
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code >= 1 && code <= 0x10FFFF) {
        try { return String.fromCodePoint(code); } catch { return m; }
      }
      return m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENT, body) ? NAMED_ENT[body] : m;
  });
}
// Strip HTML tags, mapping <br>/<p> to line breaks. Entities must be decoded
// first so "&lt;p&gt;" has become a real tag this can act on.
function stripTags(s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function safeUrl(u) {
  if (typeof u !== 'string') return '';
  u = u.trim();
  return /^https?:\/\//i.test(u) ? u : '';
}
function tzFor(state) {
  const s = (state || '').trim().toLowerCase();
  if (s === 'ca' || s === 'california' || s === 'nv' || s === 'nevada') return 'America/Los_Angeles';
  if (s === 'ny' || s === 'new york') return 'America/New_York';
  return 'America/Denver';
}
function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  f.formatToParts(date).forEach(x => { p[x.type] = x.value; });
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, ss: +p.second };
}
function isoLocal(date, tz) {
  const p = tzParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  const offMin = Math.round((asUtc - date.getTime()) / 60000);
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  const pad = n => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
function fmt(date, tz, opts) {
  return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz }, opts)).format(date);
}
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function haversineMi(lat1, lng1, lat2, lng2) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const pad2 = n => String(n).padStart(2, '0');
function localDateStr(date, tz) {
  const p = tzParts(date, tz);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}
/* Upcoming weekend as local date strings (America/Denver — all landing cities
 * are Utah). Mon–Thu → the coming Fri/Sat/Sun; Fri counts as the weekend's
 * start; Sat → Sat+Sun; Sun → just Sunday. */
function weekendDates() {
  const now = new Date();
  const tz = 'America/Denver';
  const p = tzParts(now, tz);
  const dowName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dowName);
  const base = Date.UTC(p.y, p.m - 1, p.d);
  const day = n => {
    const d = new Date(base + n * 86400e3);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  };
  if (dow === 6) return [day(0), day(1)];
  if (dow === 0) return [day(0)];
  const fri = 5 - dow;
  return [day(fri), day(fri + 1), day(fri + 2)];
}
function weekendLabel(dates) {
  const f = s => {
    const [y, m, d] = s.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(y, m - 1, d)));
  };
  if (dates.length === 1) return f(dates[0]);
  const a = f(dates[0]), b = f(dates[dates.length - 1]);
  return a.split(' ')[0] === b.split(' ')[0] ? `${a}–${b.split(' ')[1]}` : `${a} – ${b}`;
}
function nearestCity(lat, lng) {
  if (lat == null || lng == null) return null;
  let best = null, bestD = CITY_RADIUS_MI;
  for (const c of LANDING_CITIES) {
    const d = haversineMi(lat, lng, c.lat, c.lng);
    if (d <= bestD) { best = c; bestD = d; }
  }
  return best;
}

// ---------- fetch ----------
const HEADERS = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const sleep = ms => new Promise(res => setTimeout(res, ms));

// PostgREST returns transient 5xx (notably 503 PGRST002 "Could not query the
// database for the schema cache. Retrying.") when the database is briefly
// overloaded or reloading its schema cache. A single blip used to abort the
// whole nightly build; retry with exponential backoff so it self-heals.
async function sbFetchJson(url, label) {
  const MAX_TRIES = 5;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.ok) return r.json();
      const body = await r.text();
      // 4xx (other than 429) are real bugs — fail fast, don't burn retries.
      if (r.status < 500 && r.status !== 429) {
        throw new Error(`PostgREST ${r.status}: ${body}`);
      }
      lastErr = new Error(`PostgREST ${r.status}: ${body}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < MAX_TRIES) {
      const backoff = Math.min(2000 * 2 ** (attempt - 1), 30000) + Math.floor(Math.random() * 500);
      console.warn(`${label || 'fetch'} attempt ${attempt}/${MAX_TRIES} failed (${lastErr.message}); retrying in ${backoff}ms…`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function fetchAll() {
  const floor = new Date(Date.now() - KEEP_PAST_DAYS * 86400e3).toISOString();
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const p = new URLSearchParams({
      select: SELECT,
      merged_into: 'is.null',
      is_hidden: 'eq.false',
      is_low_priority: 'eq.false',
      is_virtual: 'eq.false',
      enrichment_status: 'neq.expanded',
      order: 'start_time.asc,id.asc',
      limit: String(PAGE),
      offset: String(offset)
    });
    p.append('start_time', 'gte.' + floor);
    const page = await sbFetchJson(`${SB}/events?${p}`, `events offset=${offset}`);
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  await attachCategories(rows);
  return rows;
}

// Stitch each event's category map back onto the rows in the shape toItem()
// expects: r.event_category_map = [{ is_primary, event_categories:{name,slug} }].
// Batched indexed lookups on event_category_map.event_id — each request is
// cheap and bounded, so no single query approaches the anon statement_timeout.
async function attachCategories(rows) {
  const byEvent = new Map();
  for (let i = 0; i < rows.length; i += ECM_CHUNK) {
    const ids = rows.slice(i, i + ECM_CHUNK).map(r => r.id).filter(Boolean);
    if (!ids.length) continue;
    const p = new URLSearchParams({ select: ECM_SELECT });
    p.append('event_id', 'in.(' + ids.join(',') + ')');
    const batch = await sbFetchJson(`${SB}/event_category_map?${p}`, `categories batch i=${i}`);
    for (const m of batch) {
      if (!byEvent.has(m.event_id)) byEvent.set(m.event_id, []);
      byEvent.get(m.event_id).push({ is_primary: m.is_primary, event_categories: m.event_categories });
    }
  }
  for (const r of rows) r.event_category_map = byEvent.get(r.id) || [];
}

/* Returns the upcoming-events dataset, reusing a recent on-disk cache when one
 * is present so that push-triggered deploys don't re-hit Supabase — every push
 * was previously re-fetching all ~28k rows. The nightly cron passes
 * SEO_FORCE_REFRESH=1 to bypass the cache and refresh the data once per day.
 * Pages are always regenerated from this data, so output stays consistent. */
async function loadRows(cachePath, forceRefresh) {
  if (cachePath && !forceRefresh) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'));
      const ageMs = Date.now() - (cached.generatedAt || 0);
      if (Array.isArray(cached.rows) && ageMs >= 0 && ageMs < CACHE_MAX_AGE_MS) {
        console.log(`Reusing cached dataset: ${cached.rows.length} rows, ` +
          `${(ageMs / 3600e3).toFixed(1)}h old — skipping Supabase fetch.`);
        return cached.rows;
      }
    } catch { /* missing/unreadable/stale cache → fall through to a live fetch */ }
  }
  const rows = await fetchAll();
  if (cachePath) {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ generatedAt: Date.now(), rows }));
    console.log(`Cached dataset (${rows.length} rows) → ${cachePath}`);
  }
  return rows;
}

// ---------- event model ----------
const DECODE_FIELDS = ['title', 'one_line_summary', 'description', 'venue', 'address', 'city'];
function toItem(r) {
  if (!r.id || !r.title || !r.start_time) return null;
  // Decode entities once on the shared row object (mirrors the app's
  // Event.fromX) so every downstream esc() renders clean text. The long
  // description additionally gets tag-stripped where it's emitted.
  for (const f of DECODE_FIELDS) {
    if (typeof r[f] === 'string') r[f] = decodeEntities(r[f]);
  }
  const tz = tzFor(r.state);
  const start = new Date(r.start_time);
  const end = r.end_time ? new Date(r.end_time) : null;
  // Seed value for a page's first-ever sitemap <lastmod> (see resolveLastmod);
  // after that the content hash owns it — the scraper bumps updated_at on
  // every row write (SCHEMA.md), changed or not, so it can't be the signal.
  // Fall back to start_time for any legacy row missing it.
  const upd = r.updated_at ? Date.parse(r.updated_at) : NaN;
  const mtimeMs = Number.isFinite(upd) ? upd : start.getTime();
  // Live until GRACE_MS past the end (or the start when no end is known).
  // Ended occurrences keep their pages (KEEP_PAST_DAYS fetch floor) but are
  // excluded from the sitemap, landing lists, and related-events links.
  const ended = (end || start).getTime() < Date.now() - GRACE_MS;
  const cont = r.precision_class === 'continuous';
  const dropIn = r.precision_class === 'drop_in_window';
  const sp = tzParts(start, tz);
  const ep = end ? tzParts(end, tz) : null;
  const allDay = !!(ep && sp.hh === 0 && sp.mm === 0 && ep.hh === 23 && ep.mm >= 55);
  const slugs = [];
  let primary = null;
  (r.event_category_map || []).forEach(m => {
    const c = m && m.event_categories;
    if (c && c.slug && CATS[c.slug]) {
      slugs.push(c.slug);
      if (m.is_primary || !primary) primary = c.slug;
    }
  });
  return { r, id: r.id, tz, start, end, ended, cont, dropIn, allDay, slugs, primary, mtimeMs };
}

function dateLine(it) {
  const t = it.tz;
  if (it.cont) {
    return 'Daily' + (it.end ? ' · through ' + fmt(it.end, t, { weekday: 'long', month: 'long', day: 'numeric' }) : ' · ongoing');
  }
  let line = fmt(it.start, t, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const time = d => fmt(d, t, { hour: 'numeric', minute: '2-digit' });
  if (it.allDay) line += ' · All day';
  else if (it.dropIn) line += ' · Drop in ' + time(it.start) + (it.end ? ' – ' + time(it.end) : '');
  else {
    line += ' · ' + time(it.start);
    if (it.end && it.end - it.start < 14 * 3600e3) line += ' – ' + time(it.end);
  }
  return line;
}

function metaDescription(it) {
  const r = it.r;
  let base = stripTags(r.one_line_summary || r.description || '').replace(/\s+/g, ' ').trim();
  if (!base) {
    base = `${r.title} at ${r.venue || r.city || 'a venue near you'} on ` +
      fmt(it.start, it.tz, { month: 'long', day: 'numeric' }) + '. Find local events on Haps.';
  }
  return base.length > 158 ? base.slice(0, 155).replace(/\s+\S*$/, '') + '…' : base;
}

function jsonLd(it, group, canonical) {
  const r = it.r;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: r.title,
    startDate: isoLocal(it.start, it.tz),
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    eventStatus: 'https://schema.org/EventScheduled',
    url: canonical
  };
  if (it.end) ld.endDate = isoLocal(it.end, it.tz);
  const desc = stripTags(r.one_line_summary || r.description || '').replace(/\s+/g, ' ').trim();
  if (desc) ld.description = desc.slice(0, 500);
  const img = safeUrl(r.image_url);
  if (img) ld.image = [img];
  const loc = { '@type': 'Place', name: r.venue || r.city || 'TBA' };
  const addr = { '@type': 'PostalAddress', addressCountry: 'US' };
  if (r.address) addr.streetAddress = r.address;
  if (r.city) addr.addressLocality = r.city;
  if (r.state) addr.addressRegion = r.state;
  loc.address = addr;
  if (r.latitude != null && r.longitude != null) {
    loc.geo = { '@type': 'GeoCoordinates', latitude: r.latitude, longitude: r.longitude };
  }
  ld.location = loc;
  if (r.is_free === true) {
    ld.isAccessibleForFree = true;
    ld.offers = { '@type': 'Offer', price: 0, priceCurrency: 'USD', availability: 'https://schema.org/InStock', url: canonical };
  } else {
    const tix = safeUrl(r.ticket_url);
    if (tix) ld.offers = { '@type': 'Offer', url: tix, availability: 'https://schema.org/InStock' };
  }
  // Embedding in <script>: < stops a crafted description from closing the tag.
  return JSON.stringify(ld).replace(/</g, '\\u003c');
}

// ---------- page ----------
const BASE_CSS = `
:root{--violet:#7c3aed;--ink:#1b1430;--muted:#6b6480;--line:#e9e2f8;--bg:#faf8ff}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--ink);line-height:1.55}
.topbar{background:#fff;border-bottom:1px solid var(--line);padding:.65rem 1.1rem;display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:.45rem;font-weight:800;font-size:1.15rem;color:var(--ink);text-decoration:none}.brand img{height:28px;width:28px;border-radius:7px}
.getapp{background:var(--violet);color:#fff;text-decoration:none;font-weight:700;font-size:.9rem;padding:.45rem .9rem;border-radius:999px}
main{max-width:680px;margin:0 auto;padding:1.2rem 1.1rem 3rem}
.hero-img{width:100%;max-height:380px;object-fit:cover;border-radius:16px;border:1px solid var(--line);margin:.3rem 0 1rem}
h1{font-size:1.65rem;line-height:1.25;margin:.4rem 0 .5rem}
.lede{color:var(--muted);margin:.2rem 0 .8rem}
.tags{display:flex;flex-wrap:wrap;gap:.4rem;margin:.4rem 0}
.tag{background:#efe9fb;color:#5b21b6;border-radius:999px;padding:.22rem .65rem;font-size:.82rem;font-weight:600}
.tag-free{background:#e7f6ec;color:#15803d}.tag-age{background:#fdeaea;color:#b91c1c}
.facts{list-style:none;padding:0;margin:.8rem 0}.facts li{padding:.3rem 0}
.facts a{color:var(--violet)}
.actions{display:flex;flex-wrap:wrap;gap:.6rem;margin:1rem 0 1.4rem}
.btn{display:inline-block;text-decoration:none;font-weight:700;padding:.6rem 1.1rem;border-radius:12px;border:1.5px solid var(--line);color:var(--ink);background:#fff}
.btn-primary{background:var(--violet);border-color:var(--violet);color:#fff}
.dates h2{font-size:1.05rem;margin:1.2rem 0 .5rem}
.pills{display:flex;flex-wrap:wrap;gap:.45rem}
.pill{background:#fff;border:1px solid var(--line);border-radius:999px;padding:.3rem .7rem;font-size:.85rem;color:var(--ink);text-decoration:none}
.pill.is-on{border-color:var(--violet);background:#efe9fb;font-weight:700}
.desc{margin-top:1.2rem}.desc p{margin:.6rem 0}
.notice{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:12px;padding:.6rem .9rem;margin:.5rem 0 .8rem;font-weight:600}
.notice a{color:var(--violet)}
.morecity{margin:1.2rem 0 0;font-weight:700}.morecity a{color:var(--violet)}
.appcta{margin-top:1.8rem;background:#fff;border:1px solid var(--line);border-radius:16px;padding:1rem 1.2rem}
.appcta a{color:var(--violet);font-weight:700}
.footer{border-top:1px solid var(--line);color:var(--muted);font-size:.85rem;padding:1.2rem;text-align:center}
.footer a{color:var(--muted)}
h2{font-size:1.15rem;margin:1.6rem 0 .6rem}
.ev-list{list-style:none;padding:0;margin:.4rem 0}
.ev{background:#fff;border:1px solid var(--line);border-radius:14px;padding:.7rem .95rem;margin:.55rem 0}
.ev-date{display:block;color:var(--violet);font-weight:700;font-size:.82rem;text-transform:uppercase;letter-spacing:.02em}
.ev-title{display:inline-block;color:var(--ink);font-weight:700;font-size:1.02rem;text-decoration:none;margin:.1rem 0}
.ev-title:hover{color:var(--violet)}
.ev-venue{display:block;color:var(--muted);font-size:.88rem}
.ev .tags{margin:.35rem 0 0}
.quick{display:flex;flex-wrap:wrap;gap:.45rem;margin:.8rem 0 .4rem}
.crumbs{font-size:.85rem;color:var(--muted);margin:.2rem 0 .6rem}.crumbs a{color:var(--muted)}
.cities{margin-top:1.6rem;color:var(--muted);font-size:.9rem}.cities a{color:var(--violet);text-decoration:none;font-weight:600}
`;

function pageHtml(it, group, related = '') {
  const r = it.r;
  const rep = group.rep;
  const canonical = `${SITE}/event/${rep.id}/`;
  const selfUrl = `${SITE}/event/${it.id}/`;
  const title = r.title + (r.venue ? ` at ${r.venue}` : r.city ? ` in ${r.city}` : '');
  const headTitle = `${title} — ${fmt(it.start, it.tz, { month: 'short', day: 'numeric' })} | Haps`;
  const desc = metaDescription(it);
  const img = safeUrl(r.image_url) || `${SITE}/assets/og-image.png`;
  const link = safeUrl(r.ticket_url) || safeUrl(r.event_url) || safeUrl(r.link_url) || safeUrl(r.original_url);
  const maps = 'https://maps.google.com/?q=' +
    encodeURIComponent([r.venue, r.address, r.city].filter(Boolean).join(', '));
  const place = [r.venue, r.address, r.city, /^(ut|utah)$/i.test(r.state || '') ? 'UT' : r.state]
    .filter(Boolean).join(', ');

  let badges = '';
  it.slugs.slice(0, 3).forEach(s => { badges += `<span class="tag">${CATS[s][1]} ${esc(CATS[s][0])}</span>`; });
  if (r.is_free === true) badges += '<span class="tag tag-free">Free</span>';
  if (r.age_restriction && /^\d/.test(r.age_restriction)) badges += `<span class="tag tag-age">${esc(r.age_restriction)}</span>`;

  let facts = `<li>🗓 ${esc(dateLine(it))}</li>`;
  if (place) facts += `<li>📍 ${esc(place)} · <a href="${esc(maps)}" rel="noopener">Directions</a></li>`;
  if (r.price_summary) facts += `<li>🎟 ${esc(r.price_summary)}</li>`;
  else if (r.is_free === true) facts += '<li>🎟 Free</li>';

  let datesBlock = '';
  if (group.items.length > 1) {
    const pills = group.items.slice(0, 16).map(o =>
      `<a class="pill${o.id === it.id ? ' is-on' : ''}" href="/event/${esc(o.id)}/">` +
      esc(fmt(o.start, o.tz, { weekday: 'short', month: 'short', day: 'numeric' })) +
      (o.allDay || o.cont ? '' : ' · ' + esc(fmt(o.start, o.tz, { hour: 'numeric', minute: '2-digit' }))) + '</a>'
    ).join('');
    datesBlock = `<section class="dates"><h2>All dates &amp; times</h2><div class="pills">${pills}` +
      (group.items.length > 16 ? '<span class="pill">+ more in the app</span>' : '') + '</div></section>';
  }

  let notice = '';
  if (it.ended) {
    const near = nearestCity(r.latitude, r.longitude);
    const more = near
      ? `<a href="/events/${near.slug}/">Find more things to do in ${esc(near.name)} →</a>`
      : '<a href="/">Browse upcoming events →</a>';
    notice = `<p class="notice">${group.items.some(o => !o.ended)
      ? 'This date has passed — see the other dates &amp; times below.'
      : 'This event has ended.'} ${more}</p>`;
  }

  const descText = stripTags(r.description || '');   // entities decoded in toItem; drop HTML tags
  const descHtml = descText
    ? '<section class="desc">' + descText.split(/\n{2,}/).slice(0, 12)
        .map(par => `<p>${esc(par).replace(/\n/g, '<br>')}</p>`).join('') + '</section>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(headTitle)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" href="/assets/icon-512.png">
<link rel="apple-touch-icon" href="/assets/icon-512.png">
<meta name="apple-itunes-app" content="app-id=${APP_ID}, app-argument=${esc(selfUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Haps">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(selfUrl)}">
<meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${jsonLd(it, group, canonical)}</script>
<style>${BASE_CSS}</style>
<script src="/assets/analytics.js"></script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/"><img src="/assets/icon-512.png" alt=""> haps</a>
  <a class="getapp" href="/beta">Get the app</a>
</header>
<main>
  <article>
    ${safeUrl(r.image_url) ? `<img class="hero-img" src="${esc(safeUrl(r.image_url))}" alt="${esc(r.title)}" onerror="this.remove()">` : ''}
    ${badges ? `<div class="tags">${badges}</div>` : ''}
    <h1>${esc(r.title)}</h1>
    ${notice}
    ${r.one_line_summary ? `<p class="lede">${esc(r.one_line_summary)}</p>` : ''}
    <ul class="facts">${facts}</ul>
    <div class="actions">
      ${link ? `<a class="btn btn-primary" href="${esc(link)}" rel="noopener">${safeUrl(r.ticket_url) ? 'Get tickets ↗' : 'Event website ↗'}</a>` : ''}
      <a class="btn" href="/#e=${esc(it.id)}">Save &amp; browse more events</a>
    </div>
    ${datesBlock}
    ${descHtml}
    ${related}
    ${(() => {
      const near = nearestCity(r.latitude, r.longitude);
      return near ? `<p class="morecity"><a href="/events/${near.slug}/">More things to do in ${esc(near.name)} →</a></p>` : '';
    })()}
    <div class="appcta"><strong>Take it with you.</strong> Save this event in the Haps app and get a reminder before it starts. <a href="/beta">Get the app →</a></div>
  </article>
</main>
<footer class="footer">
  © 2026 Haps App · <a href="/">Browse all events</a> · <a href="/about/">About</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
</footer>
</body>
</html>
`;
}

// ---------- landing pages ----------
function groupItems(items) {
  const groups = new Map();
  items.forEach(it => {
    const key = (it.r.is_long_running && it.r.exhibit_id)
      ? 'ex:' + it.r.exhibit_id
      : norm(it.r.title) + '|' + norm(it.r.venue);
    if (!groups.has(key)) groups.set(key, { rep: it, items: [] });
    groups.get(key).items.push(it);
  });
  return groups;
}

function rowHtml(o, g) {
  const r = o.r;
  const when = fmt(o.start, o.tz, { weekday: 'short', month: 'short', day: 'numeric' }) +
    (o.allDay || o.cont ? '' : ' · ' + fmt(o.start, o.tz, { hour: 'numeric', minute: '2-digit' }));
  let tags = '';
  if (o.primary && CATS[o.primary]) tags += `<span class="tag">${CATS[o.primary][1]} ${esc(CATS[o.primary][0])}</span>`;
  if (r.is_free === true) tags += '<span class="tag tag-free">Free</span>';
  const dayCount = new Set(g.items.map(x => localDateStr(x.start, x.tz))).size;
  if (dayCount > 1) tags += `<span class="tag">📅 ${dayCount} dates</span>`;
  const venue = [r.venue, r.city].filter(Boolean).join(' · ');
  return `<li class="ev"><span class="ev-date">${esc(when)}</span>` +
    `<a class="ev-title" href="/event/${esc(o.id)}/">${esc(r.title)}</a>` +
    (venue ? `<span class="ev-venue">${esc(venue)}</span>` : '') +
    (tags ? `<div class="tags">${tags}</div>` : '') + '</li>';
}

function itemListLd(name, urls) {
  return JSON.stringify({
    '@context': 'https://schema.org', '@type': 'ItemList', name,
    itemListElement: urls.slice(0, 30).map((u, i) => ({ '@type': 'ListItem', position: i + 1, url: u }))
  }).replace(/</g, '\\u003c');
}

function landingHtml(o) {
  // o: { path, headTitle, metaDesc, h1, lede, crumb, quick, picked:{rows,urls,total},
  //      emptyMsg, browseHash, city }
  const url = SITE + o.path;
  const list = o.picked.rows.length
    ? `<ol class="ev-list">${o.picked.rows.join('\n')}</ol>` +
      (o.picked.total > o.picked.rows.length
        ? `<p class="lede">…and ${o.picked.total - o.picked.rows.length} more — <a href="${esc(o.browseHash)}">browse them all</a>.</p>` : '')
    : `<p class="lede">${esc(o.emptyMsg)}</p>`;
  const others = LANDING_CITIES.filter(c => c.slug !== o.city.slug)
    .map(c => `<a href="/events/${c.slug}/">${esc(c.name)}</a>`).join(' · ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.headTitle)}</title>
<meta name="description" content="${esc(o.metaDesc)}">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" href="/assets/icon-512.png">
<link rel="apple-touch-icon" href="/assets/icon-512.png">
<meta name="apple-itunes-app" content="app-id=${APP_ID}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Haps">
<meta property="og:title" content="${esc(o.h1)}">
<meta property="og:description" content="${esc(o.metaDesc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE}/assets/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${itemListLd(o.h1, o.picked.urls)}</script>
<style>${BASE_CSS}</style>
<script src="/assets/analytics.js"></script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/"><img src="/assets/icon-512.png" alt=""> haps</a>
  <a class="getapp" href="/beta">Get the app</a>
</header>
<main>
  ${o.crumb ? `<nav class="crumbs">${o.crumb}</nav>` : ''}
  <h1>${esc(o.h1)}</h1>
  <p class="lede">${esc(o.lede)}</p>
  ${o.quick ? `<div class="quick">${o.quick}</div>` : ''}
  <div class="actions">
    <a class="btn btn-primary" href="${esc(o.browseHash)}">Browse with filters &amp; map</a>
    <a class="btn" href="/beta">Get the app</a>
  </div>
  ${list}
  <div class="appcta"><strong>Never miss a thing.</strong> The Haps app learns what you like, syncs your saves, and reminds you before events start. <a href="/beta">Get the app →</a></div>
  <p class="cities">Things to do in: ${others}</p>
</main>
<footer class="footer">
  © 2026 Haps App · <a href="/">Browse all events</a> · <a href="/about/">About</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
</footer>
</body>
</html>
`;
}

/* Builds all landing pages for one city. Returns [{ path, html }]. */
function cityPages(city, items) {
  const now = Date.now();
  const cityItems = items.filter(it => it.r.latitude != null && it.r.longitude != null &&
    haversineMi(it.r.latitude, it.r.longitude, city.lat, city.lng) <= CITY_RADIUS_MI);
  const groups = [...groupItems(cityItems).values()];
  const hubPath = `/events/${city.slug}/`;
  const crumb = `<a href="/events/${city.slug}/">Things to do in ${esc(city.name)}</a> ›`;

  // First live occurrence per group matching pred → sorted rows + event-page
  // URLs. Ended occurrences (kept in the dataset so their pages don't 404)
  // never appear on landing lists.
  function pick(pred, cap = LIST_CAP) {
    const picked = [];
    groups.forEach(g => {
      const o = g.items.find(x => !x.ended && pred(x));
      if (o) picked.push({ o, g });
    });
    picked.sort((a, b) => a.o.start - b.o.start);
    return {
      total: picked.length,
      // Newest event on this landing page → its sitemap <lastmod>. 0 when empty
      // (sitemapLastmod() then falls back to build time).
      mtimeMs: picked.length ? Math.max(...picked.map(p => p.o.mtimeMs)) : 0,
      rows: picked.slice(0, cap).map(p => rowHtml(p.o, p.g)),
      urls: picked.slice(0, cap).map(p => `${SITE}/event/${p.o.id}/`)
    };
  }

  const pages = [];
  const wkDates = weekendDates();
  const wkSet = new Set(wkDates);
  const wkLabel = weekendLabel(wkDates);

  const weekend = pick(o => wkSet.has(localDateStr(o.start, o.tz)));
  pages.push({
    path: `/events/${city.slug}/this-weekend/`,
    mtimeMs: weekend.mtimeMs,
    html: landingHtml({
      path: `/events/${city.slug}/this-weekend/`, city, crumb: `${crumb} This weekend`,
      headTitle: `Things to Do in ${city.name} This Weekend | Haps`,
      h1: `Things to do in ${city.name} this weekend`,
      lede: `${weekend.total} event${weekend.total === 1 ? '' : 's'} happening around ${city.name} this weekend (${wkLabel}) — updated daily.`,
      metaDesc: `What's happening in ${city.name} this weekend (${wkLabel}): ${weekend.total} events — concerts, markets, family fun, nightlife and more. Updated daily on Haps.`,
      picked: weekend, emptyMsg: 'Nothing on the calendar yet — check back soon or browse all upcoming events.',
      browseHash: `/#city=${city.browser}&when=weekend`
    })
  });

  const free = pick(o => o.r.is_free === true && o.start.getTime() <= now + FREE_WINDOW_DAYS * 86400e3);
  if (free.total >= CAT_PAGE_MIN_GROUPS) {
    pages.push({
      path: `/events/${city.slug}/free/`,
      mtimeMs: free.mtimeMs,
      html: landingHtml({
        path: `/events/${city.slug}/free/`, city, crumb: `${crumb} Free`,
        headTitle: `Free Things to Do in ${city.name} | Haps`,
        h1: `Free things to do in ${city.name}`,
        lede: `${free.total} free events coming up around ${city.name} in the next ${FREE_WINDOW_DAYS} days — no ticket required.`,
        metaDesc: `${free.total} free events in ${city.name}, Utah — free concerts, markets, family activities and more over the next ${FREE_WINDOW_DAYS} days. Updated daily on Haps.`,
        picked: free, emptyMsg: 'No free events listed right now — check back soon.',
        browseHash: `/#city=${city.browser}&free=1`
      })
    });
  }

  const catPages = [];
  Object.keys(CATS).forEach(slug => {
    const picked = pick(o => o.slugs.includes(slug) && o.start.getTime() <= now + HUB_WINDOW_DAYS * 86400e3);
    if (picked.total < CAT_PAGE_MIN_GROUPS) return;
    const phrase = CAT_PHRASES[slug] || `${CATS[slug][0]} events in`;
    const h1 = `${phrase} ${city.name}`;
    catPages.push({ slug, label: CATS[slug][0], emoji: CATS[slug][1], count: picked.total });
    pages.push({
      path: `/events/${city.slug}/${slug}/`,
      mtimeMs: picked.mtimeMs,
      html: landingHtml({
        path: `/events/${city.slug}/${slug}/`, city, crumb: `${crumb} ${esc(CATS[slug][0])}`,
        headTitle: `${h1.charAt(0).toUpperCase() + h1.slice(1)} | Haps`,
        h1: h1.charAt(0).toUpperCase() + h1.slice(1),
        lede: `${picked.total} upcoming ${CATS[slug][0].toLowerCase()} event${picked.total === 1 ? '' : 's'} around ${city.name} — updated daily.`,
        metaDesc: `${picked.total} upcoming ${CATS[slug][0].toLowerCase()} events in ${city.name}, Utah. Dates, times, venues and tickets — updated daily on Haps.`,
        picked, emptyMsg: 'Nothing listed right now — check back soon.',
        browseHash: `/#city=${city.browser}&cat=${slug}`
      })
    });
  });

  const hub = pick(o => o.start.getTime() <= now + HUB_WINDOW_DAYS * 86400e3);
  let quick = `<a class="pill is-on" href="/events/${city.slug}/this-weekend/">🗓️ This weekend</a>`;
  if (free.total >= CAT_PAGE_MIN_GROUPS) quick += `<a class="pill" href="/events/${city.slug}/free/">💸 Free</a>`;
  catPages.sort((a, b) => b.count - a.count).forEach(c => {
    quick += `<a class="pill" href="/events/${city.slug}/${c.slug}/">${c.emoji} ${esc(c.label)}</a>`;
  });
  pages.unshift({
    path: hubPath,
    mtimeMs: hub.mtimeMs,
    html: landingHtml({
      path: hubPath, city, crumb: '',
      headTitle: `Things to Do in ${city.name} — Local Events Calendar | Haps`,
      h1: `Things to do in ${city.name}`,
      lede: city.blurb,
      metaDesc: `Looking for things to do in ${city.name}? ${hub.total} upcoming events — concerts, festivals, food, family fun, nightlife and more. Updated daily on Haps.`,
      quick,
      picked: hub, emptyMsg: 'Nothing listed right now — check back soon.',
      browseHash: `/#city=${city.browser}`
    })
  });

  return pages;
}

// ---------- sitemap ----------
/* W3C-datetime (sitemaps.org profile) <lastmod>, UTC at seconds precision.
 * Capped at build time so a stray future updated_at / clock skew can't emit a
 * lastmod in the future; falls back to build time when no event timestamp is
 * known (e.g. an empty landing page). */
function sitemapLastmod(mtimeMs, buildMs) {
  const t = Math.min(mtimeMs || buildMs, buildMs);
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function sitemapXml(repEntries, landingEntries, buildMs) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  // Static pages carry no <lastmod> on purpose: they change rarely, and a fresh
  // date stamped on every daily build is the always-"now" lastmod crawlers
  // learn to ignore. Event + landing pages get a real per-page lastmod.
  STATIC_URLS.forEach(([p, freq, pri]) => {
    lines.push(`  <url><loc>${SITE}${p}</loc><changefreq>${freq}</changefreq><priority>${pri}</priority></url>`);
  });
  landingEntries.forEach(({ path: p, mtimeMs }) => {
    lines.push(`  <url><loc>${SITE}${p}</loc><lastmod>${sitemapLastmod(mtimeMs, buildMs)}</lastmod>` +
      `<changefreq>daily</changefreq><priority>0.8</priority></url>`);
  });
  repEntries.forEach(({ id, mtimeMs }) => {
    lines.push(`  <url><loc>${SITE}/event/${id}/</loc><lastmod>${sitemapLastmod(mtimeMs, buildMs)}</lastmod>` +
      `<changefreq>daily</changefreq><priority>0.6</priority></url>`);
  });
  lines.push('</urlset>', '');
  return lines.join('\n');
}

// ---------- SEO state (persisted next to the --cache dataset) ----------
/* seo-state.json rides along in the same CI cache dir as events.json:
 *   stamps: { "E:<id>" | "L:<path>": { h: <content sha1>, ms: <lastmod> } }
 *   reps:   { <group key>: <representative event id> }
 * stamps make sitemap <lastmod> honest — it only moves when the page content
 * hash moves. reps pin each series' canonical target so it doesn't hop to a
 * different occurrence id every day as dates pass. Losing the file is safe:
 * lastmods fall back to updated_at (one noisy build) and reps re-seed. */
const sha1 = s => createHash('sha1').update(s).digest('hex');

// Everything that feeds the rendered page except the related-events block,
// which rolls with the catalog daily and must not bump lastmod.
function contentKey(it, group) {
  const r = it.r;
  return JSON.stringify([
    r.title, r.one_line_summary, r.description, r.start_time, r.end_time,
    r.venue, r.address, r.city, r.state, r.image_url, r.ticket_url,
    r.event_url, r.link_url, r.original_url, r.is_free, r.price_summary,
    r.age_restriction, it.slugs, it.ended, group.rep.id,
    group.items.length, group.items.slice(0, 16).map(o => [o.id, o.r.start_time])
  ]);
}

// ---------- main ----------
async function main() {
  const siteArg = process.argv.indexOf('--site');
  if (siteArg < 0 || !process.argv[siteArg + 1]) {
    console.error('Usage: node scripts/generate-event-pages.mjs --site <built-site-dir>');
    process.exit(1);
  }
  const siteDir = path.resolve(process.argv[siteArg + 1]);
  const cacheArg = process.argv.indexOf('--cache');
  const cachePath = cacheArg > -1 && process.argv[cacheArg + 1]
    ? path.resolve(process.argv[cacheArg + 1]) : null;
  const forceRefresh = process.env.SEO_FORCE_REFRESH === '1';
  const buildMs = Date.now(); // upper bound for every sitemap <lastmod>

  console.log(forceRefresh ? 'Refreshing dataset from Supabase…' : 'Loading dataset…');
  const rows = await loadRows(cachePath, forceRefresh);
  const items = rows.map(toItem).filter(Boolean);
  console.log(`${rows.length} rows → ${items.length} usable`);

  // Group multi-date series; rows arrive start-ascending so items[0] = earliest = representative.
  const groups = groupItems(items);

  // Load persisted SEO state; keep last build's representative when it still
  // exists so canonicals stay put instead of hopping ids as dates pass.
  const statePath = cachePath ? path.join(path.dirname(cachePath), 'seo-state.json') : null;
  let prevState = {};
  if (statePath) {
    try { prevState = JSON.parse(await readFile(statePath, 'utf8')) || {}; }
    catch { /* first run / evicted cache → cold start */ }
  }
  const prevStamps = prevState.stamps || {}, prevReps = prevState.reps || {};
  const nextState = { stamps: {}, reps: {} };
  for (const [key, g] of groups) {
    const kept = prevReps[key] && g.items.find(o => o.id === prevReps[key]);
    if (kept) g.rep = kept;
    nextState.reps[key] = g.rep.id;
  }
  // lastmod only moves when the page's content hash moves; a hash never seen
  // before seeds from updated_at (capped at build time by sitemapLastmod).
  function resolveLastmod(key, hash, fallbackMs) {
    const prev = prevStamps[key];
    const ms = prev && prev.h === hash ? prev.ms : (prev ? buildMs : (fallbackMs || buildMs));
    nextState.stamps[key] = { h: hash, ms };
    return ms;
  }

  // Cross-link graph: per landing city, one live occurrence per group, sorted
  // by start. Feeds each event page's "More events near {city}" block so the
  // ~8k event pages link each other instead of being sitemap-only orphans.
  const cityUpcoming = new Map();
  for (const g of groups.values()) {
    const o = g.items.find(x => !x.ended && /^[0-9a-f-]{36}$/i.test(x.id));
    if (!o) continue;
    const near = nearestCity(o.r.latitude, o.r.longitude);
    if (!near) continue;
    if (!cityUpcoming.has(near.slug)) cityUpcoming.set(near.slug, []);
    cityUpcoming.get(near.slug).push({ o, g, city: near });
  }
  for (const list of cityUpcoming.values()) list.sort((a, b) => a.o.start - b.o.start);
  function relatedHtml(it, group) {
    const near = nearestCity(it.r.latitude, it.r.longitude);
    const list = near && cityUpcoming.get(near.slug);
    if (!list) return '';
    const later = [], before = [];
    for (const c of list) {
      if (c.g.rep.id === group.rep.id) continue;
      (c.o.start >= it.start ? later : before).push(c);
    }
    const picks = later.slice(0, RELATED_CAP);
    for (let i = before.length - 1; i >= 0 && picks.length < RELATED_CAP; i--) picks.push(before[i]);
    if (!picks.length) return '';
    picks.sort((a, b) => a.o.start - b.o.start);
    return `<section class="related"><h2>More events near ${esc(near.name)}</h2><ol class="ev-list">` +
      picks.map(c => rowHtml(c.o, c.g)).join('\n') + '</ol></section>';
  }

  const eventDir = path.join(siteDir, 'event');
  await rm(eventDir, { recursive: true, force: true });

  let written = 0;
  const repEntries = [];
  for (const group of groups.values()) {
    let newestMs = 0;
    for (const it of group.items) {
      if (!/^[0-9a-f-]{36}$/i.test(it.id)) continue;
      const dir = path.join(eventDir, it.id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'index.html'), pageHtml(it, group, relatedHtml(it, group)));
      newestMs = Math.max(newestMs, resolveLastmod('E:' + it.id, sha1(contentKey(it, group)), it.mtimeMs));
      written++;
    }
    // One sitemap entry per collapsed series, only while it still has a live
    // occurrence; ended-but-kept pages stay reachable but stop being advertised.
    if (/^[0-9a-f-]{36}$/i.test(group.rep.id) && group.items.some(o => !o.ended)) {
      repEntries.push({ id: group.rep.id, mtimeMs: newestMs });
    }
  }

  // City / category landing pages under /events/{city}/...
  const landingEntries = [];
  for (const city of LANDING_CITIES) {
    for (const page of cityPages(city, items)) {
      const dir = path.join(siteDir, page.path.slice(1));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'index.html'), page.html);
      landingEntries.push({
        path: page.path,
        mtimeMs: resolveLastmod('L:' + page.path, sha1(page.html), page.mtimeMs)
      });
    }
  }

  await writeFile(path.join(siteDir, 'sitemap.xml'), sitemapXml(repEntries, landingEntries, buildMs));
  if (statePath) {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(nextState));
  }

  const endedCount = items.filter(it => it.ended).length;
  console.log(`Wrote ${written} event pages (${endedCount} ended-but-kept; ${repEntries.length} collapsed events in sitemap) → ${eventDir}`);
  console.log(`Wrote ${landingEntries.length} landing pages: ${landingEntries.map(e => e.path).join(' ')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
