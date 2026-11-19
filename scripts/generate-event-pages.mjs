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
// IndexNow accepts up to 10,000 URLs per POST; landing pages come first.
const INDEXNOW_MAX_URLS = 10000;
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
  'age_restriction,precision_class,is_long_running,exhibit_id,is_featured,updated_at,appeal_score,' +
  // >=2 / >=4 merged source listings — a "lots of outlets covered it" signal for
  // landing-page ranking. JSON-path select keeps egress tiny vs the whole blob.
  'ms2:merged_sources->1->>source_site,ms4:merged_sources->3->>source_site';
// Category map is fetched separately (see attachCategories) rather than embedded
// in SELECT — embedding made every offset page recompute the category JSON for
// all preceding rows, blowing the 3s anon statement_timeout past ~28k events.
const ECM_SELECT = 'event_id,is_primary,event_categories(name,slug)';
const ECM_CHUNK = 150; // event ids per batch — keeps each ?in.(...) URL well under proxy limits

// Static pages preserved at the head of the generated sitemap.
const STATIC_URLS = [
  ['/', 'daily', '1.0'],
  ['/about/', 'monthly', '0.7'],
  ['/embed/', 'monthly', '0.6'],
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
const EMBED_FEED_CAP = 12;         // widget shows at most 10; 2 spare for ended-today skips

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

/* Niche "topic" landing pages: keyword matches on the event title (and the
 * one-line summary where `inSummary`), not categories — these mirror what
 * people actually search ("trivia night salt lake", "turkey trot utah",
 * "christmas lights provo"). Each city's page only exists while it has
 * >= CAT_PAGE_MIN_GROUPS collapsed events in TOPIC_WINDOW_DAYS, so seasonal
 * topics (christmas, holiday-markets, runs-races) come and go on their own.
 * Title-only topics are the ones whose words show up loosely in summaries
 * ("a romantic comedy", "trivia program"). Regexes were tuned against the
 * live catalog — check sample matches before adding one. */
const TOPIC_WINDOW_DAYS = 60;
const TOPICS = [
  { slug: 'christmas', q: 'christmas', label: 'Christmas', emoji: '🎄', inSummary: true, year: true,
    re: /christmas|holiday lights|festival of trees|\bsanta\b(?! (clara|fe|monica|barbara|cruz|rosa|ana)\b)|nutcracker|tree lighting|hanukkah|menorah|winter wonderland|light display/i,
    h1: 'Christmas & holiday events in', head: 'Christmas Events in {city} {year} — Lights, Santa & Shows',
    intro: 'Light displays, tree lightings, visits with Santa, Nutcracker performances, carolers and holiday concerts — every Christmas event we know of around {city}, updated daily through the season.',
    about: ['The Christmas season around {city} starts the weekend before Thanksgiving with tree lightings and “lights on” nights and builds through Christmas Eve. Free community events (lightings, parades, Santa visits, sing-alongs) are mostly on Friday and Saturday evenings in late November and early December.',
      'Ticketed favorites such as light shows, the Nutcracker and holiday concerts sell out, so book early for weekends.'] },
  { slug: 'holiday-markets', q: 'market', label: 'Holiday markets', emoji: '🎁', inSummary: false, year: true,
    re: /craft (fair|show|market|bazaar|boutique)|holiday (market|bazaar|boutique|craft)|christmas (market|bazaar|boutique|gift)|makers? market|artisan (market|fair)|vendor (fair|market)/i,
    h1: 'Holiday markets & craft fairs in', head: 'Holiday Markets & Craft Fairs in {city} {year}',
    intro: 'Shop local makers, artisans and small vendors at holiday markets, craft fairs and boutiques around {city} — dates, hours and locations in one place.',
    about: ['Holiday markets around {city} usually start the weekend before Thanksgiving and run through mid-December, with the biggest crowds on Saturdays. Many are one-day church, school or community-center craft fairs; others are multi-week makers’ markets with food trucks and live music.',
      'Most charge little or nothing to get in, but some vendors are cash-only, so bring a few bills. If you’re shopping for something specific, go early on the first day — handmade items sell out.'] },
  /* Seasonal holiday topics, added 2026-11-19 for December search demand.
   * URLs carry no year so each season builds on last year's ranking; the
   * >= CAT_PAGE_MIN_GROUPS gate drops them from the sitemap off-season.
   * `exclude` knocks out venue-hours / parking / rehearsal rows that share
   * the words. Regexes sampled against the live UT catalog 2026-11-19. */
  { slug: 'christmas-lights', q: 'lights', label: 'Christmas lights', emoji: '✨', inSummary: false, year: true,
    re: /(christmas|holiday|festival of|winter|zoo ?) ?lights\b|light (display|show|festival|maze|tour)|lights (on|tour|show|display|festival|celebration)|illuminat(e|ed)\b|luminaria|christmas in color|zoolights|dazzling garden/i,
    exclude: /parking|hours\b|closed|closing|practice|rehearsal|volunteer/i,
    h1: 'Christmas lights & light shows in', head: 'Christmas Lights in {city} {year} — Light Shows & Displays',
    intro: 'Where to see Christmas lights around {city}: drive-thru light shows, zoo and garden light displays, festival-of-lights nights and tree lightings — with dates and hours, updated daily.',
    about: ['Most Christmas light displays around {city} switch on the week of Thanksgiving and run nightly from dusk until early January. Weeknights are far less crowded than Fridays and Saturdays, and the week between Christmas and New Year’s is the busiest of the season.',
      'Drive-thru shows and zoo or garden light walks often sell timed tickets, so book ahead for weekends. Neighborhood and city “lights on” nights are usually free and often come with Santa visits, hot cocoa and live music. Dress warmly — walking displays take an hour or more.'] },
  { slug: 'santa', q: 'santa', label: 'See Santa', emoji: '🎅', inSummary: false, year: true,
    re: /\bsanta\b(?! (clara|fe|monica|barbara|cruz|rosa|ana)\b)|north pole|polar express|\bmrs\.? claus\b/i,
    exclude: /paint|brush|burlesque|21\+|hours\b/i,
    h1: 'Where to see Santa in', head: 'Where to See Santa in {city} {year} — Breakfast with Santa & Photos',
    intro: 'Breakfast with Santa, photos with Santa, Santa’s arrival parades, North Pole train rides and Santa runs around {city} — every Santa event we know of, updated daily.',
    about: ['Santa appearances around {city} cluster on the first three weekends of December. Breakfasts with Santa at hotels, conference centers and city recreation centers almost always need advance tickets and sell out, so reserve early.',
      'Free visits are common at city tree lightings, library events and shopping centers. Most let you take your own photos; some offer professional photo packages. Themed train rides and Polar Express–style events book up weeks ahead.'] },
  { slug: 'nutcracker', q: 'nutcracker', label: 'The Nutcracker', emoji: '🩰', inSummary: false, year: true,
    re: /nutcracker/i,
    exclude: /parking|audition|rehearsal|hours\b/i,
    h1: 'The Nutcracker in', head: 'The Nutcracker in {city} {year} — Ballet Performances & Tickets',
    intro: 'Every Nutcracker performance we know of around {city}: professional ballet companies, local dance studios and community productions, plus Nutcracker teas and kids’ events.',
    about: ['Nutcracker season around {city} runs from late November through Christmas week. Professional company productions cost the most and sell out first, especially weekend matinees. Dance-studio and civic ballet productions are cheaper, often family-friendly in length, and a great first ballet for young kids.',
      'Many productions add sensory-friendly or shortened children’s performances, and some host Nutcracker tea parties where kids meet the dancers.'] },
  { slug: 'holiday-concerts', q: 'christmas concert', label: 'Holiday shows', emoji: '🎶', inSummary: false, year: true,
    re: /messiah|christmas carol|caroling|carolers|carol sing|christmas (concert|choir|show|spectacular|pops|musical)|holiday (concert|pops|choir|show|spectacular)|handel|sing-?along/i,
    exclude: /parking|practice|rehearsal|audition|livestream|hours\b/i,
    h1: 'Holiday concerts & Christmas shows in', head: 'Christmas Concerts & Holiday Shows in {city} {year}',
    intro: 'Holiday pops concerts, Messiah sing-ins, A Christmas Carol productions, choir and organ concerts and Christmas spectaculars around {city} — dates, venues and tickets, updated daily.',
    about: ['December is the busiest month of the year for live music and theater around {city}. Symphony and touring holiday shows sell out early. Church, school and community choir concerts and Messiah sing-alongs are often free or donation-based, but seating is first come, first served.',
      'A Christmas Carol runs in several productions most years, from big stage musicals to one-man shows, so compare dates and run times before you buy tickets.'] },
  { slug: 'hanukkah', q: 'hanukkah', label: 'Hanukkah', emoji: '🕎', inSummary: true, year: true,
    re: /hanukkah|chanukah|menorah/i,
    h1: 'Hanukkah events in', head: 'Hanukkah Events in {city} {year} — Menorah Lightings & Celebrations',
    intro: 'Public menorah lightings, Hanukkah parties, family workshops and community celebrations around {city}.' },
  { slug: 'new-years-eve', q: 'new year', label: 'New Year’s Eve', emoji: '🎆', inSummary: false, year: true,
    re: /new years?'?’?s? eve|\bnye\b|noon years?'?’?s?( eve)?|countdown (party|crawl|celebration)/i,
    exclude: /hours\b|closing|closed|new years?'?’?s? day/i,
    h1: 'New Year’s Eve events in', head: 'New Year’s Eve in {city} {year} — Parties, Fireworks & Family Events',
    intro: 'New Year’s Eve parties, fireworks, masquerade balls, bar crawls, ski-resort torchlight parades and kid-friendly “Noon Year’s Eve” countdowns around {city}.',
    about: ['New Year’s Eve around {city} ranges from 21+ club nights and bar crawls to family festivals with early fireworks. Libraries, museums and rec centers host daytime “Noon Year’s Eve” countdowns for little kids who won’t make it to midnight.',
      'Ski resorts often hold torchlight parades and fireworks after dark. Big parties and dinner packages sell out or raise prices in the last week, so buy early. Plan for rideshare surge pricing after midnight.'] },
  { slug: 'runs-races', q: '5k', label: 'Fun runs & 5Ks', emoji: '🏅', inSummary: false,
    re: /\b(5|10)k\b|half marathon|\bmarathon\b|fun run|turkey trot|gobbler|jingle (run|bell run)|ugly sweater run/i,
    h1: 'Fun runs, 5Ks & races in', head: 'Fun Runs, 5Ks & Races in {city} | Haps',
    intro: 'Turkey trots, holiday fun runs, 5Ks, 10Ks and half marathons around {city} — find a race for every pace, from kids’ 1Ks to serious courses.' },
  { slug: 'trivia', q: 'trivia', label: 'Trivia nights', emoji: '🧠', inSummary: false,
    re: /\btrivia\b|quiz night|pub quiz/i,
    h1: 'Trivia nights in', head: 'Trivia Nights in {city} — Weekly Pub Quiz Schedule | Haps',
    intro: 'Weekly trivia and pub quiz nights at bars, breweries and cafés around {city}. Grab a team and find your night.' },
  { slug: 'comedy', q: 'comedy', label: 'Comedy', emoji: '😂', inSummary: false,
    re: /\bcomedy\b|stand-?up comed|\bimprov\b|comedian/i,
    h1: 'Comedy shows & improv in', head: 'Comedy Shows & Improv in {city} | Haps',
    intro: 'Stand-up, improv, sketch and clean comedy shows around {city} — touring headliners and local favorites.' },
  { slug: 'karaoke', q: 'karaoke', label: 'Karaoke', emoji: '🎤', inSummary: false,
    re: /\bkaraoke\b/i,
    h1: 'Karaoke nights in', head: 'Karaoke Nights in {city} | Haps',
    intro: 'Where to sing around {city} — karaoke nights at bars and venues, including all-ages options.' },
  { slug: 'dance', q: 'dance', label: 'Dancing', emoji: '💃', inSummary: false,
    re: /\bsalsa\b|swing danc|line danc|ballroom|contra danc|\bbachata\b|dance (night|party|social)|square danc|country swing/i,
    h1: 'Dance classes, socials & dance nights in', head: 'Salsa, Swing & Line Dancing in {city} | Haps',
    intro: 'Salsa, bachata, swing, line dancing, contra and ballroom — beginner classes, social dances and performances around {city}.' },
  { slug: 'paint-pottery', q: 'pottery', label: 'Paint & pottery', emoji: '🖌️', inSummary: true,
    re: /paint (night|party|and sip|& sip|n sip|your own)|sip (and|&) paint|pottery|ceramic|wheel throwing|craft night|wreath making|candle making/i,
    h1: 'Paint nights, pottery & craft workshops in', head: 'Paint Nights, Pottery & Craft Workshops in {city} | Haps',
    intro: 'Paint-and-sip nights, pottery and ceramics workshops, wreath making and adult craft nights around {city} — a fun night out or a creative date.' },
  { slug: 'yoga', q: 'yoga', label: 'Yoga', emoji: '🧘', inSummary: false,
    re: /\byoga\b/i,
    h1: 'Yoga classes & community yoga in', head: 'Yoga Classes & Free Community Yoga in {city} | Haps',
    intro: 'Community and drop-in yoga around {city} — free classes, hot yoga, chair yoga, yoga in the park and more.' },
  { slug: 'storytime', q: 'storytime', label: 'Storytime', emoji: '📖', inSummary: false,
    re: /story ?time/i,
    h1: 'Storytimes for kids in', head: 'Library Storytimes for Kids & Toddlers in {city} | Haps',
    intro: 'Baby, toddler, preschool and bilingual storytimes at libraries and bookstores around {city} — almost all free.' },
  { slug: 'book-clubs', q: 'book club', label: 'Book clubs', emoji: '📚', inSummary: false,
    re: /book club|book group/i,
    h1: 'Book clubs in', head: 'Book Clubs in {city} — Meetups Open to New Members | Haps',
    intro: 'Book clubs meeting at libraries, bookstores and cafés around {city} — fiction, nonfiction, graphic novels, teen and kids clubs.' },
  { slug: 'art-walks', q: 'art stroll', label: 'Art walks', emoji: '🖼️', inSummary: false,
    re: /art (walk|stroll)|gallery stroll|gallery night|artabout/i,
    h1: 'Art walks & gallery strolls in', head: 'Art Walks & Gallery Strolls in {city} | Haps',
    intro: 'Monthly gallery strolls and art walks around {city} — meet artists, see new shows, most of them free.' },
  { slug: 'festivals', q: 'festival', label: 'Festivals', emoji: '🎪', inSummary: false, year: true,
    re: /\bfestival\b|\bfest\b/i,
    h1: 'Festivals in', head: 'Festivals in {city} {year} | Haps',
    intro: 'Upcoming festivals around {city} — food, film, music, lights, culture and seasonal celebrations.' }
];

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
  // List rows show the date alone when the time is unknown: all-day,
  // continuous, or a bare local-midnight start (sources with no time land at
  // 00:00 — "12:00 AM" on a list is almost never a real start time).
  const noTime = allDay || cont || (sp.hh === 0 && sp.mm === 0);
  const slugs = [];
  let primary = null;
  (r.event_category_map || []).forEach(m => {
    const c = m && m.event_categories;
    if (c && c.slug && CATS[c.slug]) {
      slugs.push(c.slug);
      if (m.is_primary || !primary) primary = c.slug;
    }
  });
  return { r, id: r.id, tz, start, end, ended, cont, dropIn, allDay, noTime, slugs, primary, mtimeMs };
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
// Inline line icons for the event-page fact list (replaces emoji).
const svgIcon = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  cal: svgIcon('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>'),
  pin: svgIcon('<path d="M12 21s-6-5.3-6-11a6 6 0 0 1 12 0c0 5.7-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>'),
  ticket: svgIcon('<path d="M4 8V6h16v2a2 2 0 0 0 0 4v2a2 2 0 0 0 0 4H4a2 2 0 0 0 0-4v-2a2 2 0 0 0 0-4z"/><path d="M14 6v12"/>')
};

const BASE_CSS = `
/* Colors, radii and fonts come from /assets/tokens.css (shared with the site). */
:root{--violet:var(--brand);--maxw:720px}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 var(--font-body);background:var(--paper);color:var(--text);-webkit-font-smoothing:antialiased}
a{color:var(--brand)}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.topbar{background:var(--surface);border-bottom:1px solid var(--line);padding:.6rem max(1rem,calc((100% - 1180px)/2));display:flex;align-items:center;justify-content:space-between;gap:1rem}
.brand{display:flex;align-items:center;gap:.5rem;font-family:var(--font-display);font-weight:800;font-stretch:80%;font-size:1.35rem;letter-spacing:-.01em;color:var(--ink);text-decoration:none}.brand img{height:28px;width:28px;border-radius:7px}
.getapp{background:var(--brand);color:#fff;text-decoration:none;font-weight:600;font-size:.9rem;padding:.45rem .85rem;border-radius:var(--r-sm)}
.getapp:hover{background:var(--brand-hover)}
main{max-width:var(--maxw);margin:0 auto;padding:1.4rem 1rem 3rem}
.hero-img{width:100%;aspect-ratio:16/9;max-height:400px;object-fit:cover;border-radius:var(--r-md);margin:.2rem 0 1.1rem;background:var(--sunk)}
h1{font-family:var(--font-display);font-weight:800;font-stretch:72%;font-size:clamp(2rem,6vw,3rem);line-height:1;text-transform:uppercase;letter-spacing:-.005em;color:var(--ink);margin:.4rem 0 .6rem;text-wrap:balance}
article h1{font-stretch:80%;text-transform:none;font-size:clamp(1.8rem,5vw,2.5rem);line-height:1.08}
h2{font-family:var(--font-display);font-weight:800;font-stretch:75%;font-size:1.5rem;line-height:1.05;text-transform:uppercase;color:var(--ink);margin:2rem 0 .7rem}
.lede{color:var(--muted);margin:.2rem 0 .9rem;max-width:62ch}
.intro{margin:.2rem 0 .9rem;max-width:62ch}
.tags{display:flex;flex-wrap:wrap;gap:.35rem;margin:.4rem 0}
.tag{border:1px solid var(--line);background:var(--surface);color:var(--text);border-radius:var(--r-sm);padding:.14rem .5rem;font-size:.78rem;font-weight:500}
.tag-free,.tag-pick{background:var(--mark);border-color:var(--mark);color:var(--mark-ink);font-weight:700;font-size:.66rem;letter-spacing:.07em;text-transform:uppercase;padding:.2rem .45rem}
.tag-age{color:var(--danger);border-color:currentColor}
.facts{list-style:none;padding:.9rem 0;margin:1rem 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);display:grid;gap:.45rem}
.facts li{display:flex;gap:.65rem;align-items:flex-start}
.facts svg{flex:0 0 auto;width:17px;height:17px;margin-top:.22rem;fill:none;stroke:var(--muted);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.facts a{color:var(--brand);font-weight:600}
.actions{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0 1.4rem}
.btn{display:inline-block;text-decoration:none;font-weight:600;padding:.6rem 1rem;border-radius:var(--r-sm);border:1px solid var(--line-strong);color:var(--ink);background:var(--surface)}
.btn:hover{border-color:var(--ink)}
.btn-primary{background:var(--brand);border-color:var(--brand);color:#fff}
.btn-primary:hover{background:var(--brand-hover);border-color:var(--brand-hover)}
.dates h2{font-size:1.2rem;margin:1.6rem 0 .6rem}
.pills{display:flex;flex-wrap:wrap;gap:.35rem}
.pill{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-sm);padding:.28rem .6rem;font-size:.85rem;color:var(--ink);text-decoration:none;font-variant-numeric:tabular-nums}
.pill:hover{border-color:var(--line-strong)}
.pill.is-on{border-color:var(--ink);background:var(--ink);color:var(--paper);font-weight:600}
.desc{margin-top:1.4rem;max-width:66ch}.desc p{margin:.7rem 0}
.notice{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--mark);color:var(--ink);border-radius:var(--r-sm);padding:.6rem .9rem;margin:.5rem 0 .9rem;font-weight:600}
.notice a{color:var(--brand)}
.morecity{margin:1.4rem 0 0;font-weight:600}.morecity a{color:var(--brand)}
.appcta{margin-top:2rem;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:1rem 1.2rem;color:var(--muted)}
.appcta strong{color:var(--ink)}
.appcta a{color:var(--brand);font-weight:600}
.footer{border-top:1px solid var(--line);background:var(--surface);color:var(--muted);font-size:.85rem;padding:1.4rem 1rem}
.footer a{color:var(--text)}
.ev-list{list-style:none;padding:0;margin:.4rem 0;border-top:2px solid var(--ink)}
.ev{padding:.75rem 0;border-bottom:1px solid var(--line)}
.ev-date{display:block;color:var(--brand);font-family:var(--font-display);font-weight:700;font-stretch:85%;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
.ev-title{display:inline-block;color:var(--ink);font-weight:650;font-size:1.02rem;line-height:1.3;text-decoration:none;margin:.15rem 0 .1rem}
.ev-title:hover{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.ev-venue{display:block;color:var(--muted);font-size:.88rem}
.ev .tags{margin:.4rem 0 0}
.quick{display:flex;flex-wrap:wrap;gap:.35rem;margin:.7rem 0 .4rem;align-items:center}
.qlabel{font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin-right:.3rem;min-width:6.5rem}
.more{margin-top:2rem}.more h2{margin:0 0 .4rem}
.picks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.2rem .9rem;list-style:none;padding:0;margin:.4rem 0 1rem}
@media(min-width:620px){.picks{grid-template-columns:repeat(4,minmax(0,1fr))}}
.pk{display:flex;flex-direction:column;min-width:0}
.pk a{color:inherit;text-decoration:none;display:flex;flex-direction:column;height:100%}
.pk-img{width:100%;aspect-ratio:4/3;object-fit:cover;background:var(--sunk);display:block;border-radius:var(--r-md)}
.pk-ph{width:100%;aspect-ratio:4/3;background:var(--sunk);color:var(--muted);border-radius:var(--r-md);display:flex;align-items:center;justify-content:center;text-align:center;padding:0 .6rem;font-family:var(--font-display);font-stretch:75%;font-size:.95rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.pk-body{padding:.5rem .05rem 0}
.pk-date{display:block;color:var(--brand);font-family:var(--font-display);font-weight:700;font-stretch:85%;font-size:.74rem;text-transform:uppercase;letter-spacing:.04em}
.pk-title{display:block;color:var(--ink);font-weight:650;font-size:.94rem;line-height:1.3;margin:.12rem 0}
.pk a:hover .pk-title{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.pk-flag{display:inline-block;vertical-align:.12em;margin-right:.35rem;background:var(--mark);color:var(--mark-ink);font-size:.6rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:.1rem .35rem;border-radius:var(--r-sm)}
.pk-venue{display:block;color:var(--muted);font-size:.8rem;line-height:1.3}
.crumbs{font-size:.85rem;color:var(--muted);margin:.2rem 0 .6rem}.crumbs a{color:var(--muted)}
.cities{margin-top:1.8rem;color:var(--muted);font-size:.9rem}.cities a{color:var(--brand);text-decoration:none;font-weight:600}
@media(max-width:560px){.qlabel{min-width:100%;margin-bottom:.1rem}}
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
  it.slugs.slice(0, 3).forEach(s => { badges += `<span class="tag">${esc(CATS[s][0])}</span>`; });
  if (r.is_free === true) badges += '<span class="tag tag-free">Free</span>';
  if (r.age_restriction && /^\d/.test(r.age_restriction)) badges += `<span class="tag tag-age">${esc(r.age_restriction)}</span>`;

  let facts = `<li>${ICON.cal}<span>${esc(dateLine(it))}</span></li>`;
  if (place) facts += `<li>${ICON.pin}<span>${esc(place)} · <a href="${esc(maps)}" rel="noopener">Directions</a></span></li>`;
  if (r.price_summary) facts += `<li>${ICON.ticket}<span>${esc(r.price_summary)}</span></li>`;
  else if (r.is_free === true) facts += `<li>${ICON.ticket}<span>Free</span></li>`;

  let datesBlock = '';
  if (group.items.length > 1) {
    const pills = group.items.slice(0, 16).map(o =>
      `<a class="pill${o.id === it.id ? ' is-on' : ''}" href="/event/${esc(o.id)}/">` +
      esc(fmt(o.start, o.tz, { weekday: 'short', month: 'short', day: 'numeric' })) +
      (o.noTime ? '' : ' · ' + esc(fmt(o.start, o.tz, { hour: 'numeric', minute: '2-digit' }))) + '</a>'
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
<link rel="icon" href="/assets/icon-64.png">
<link rel="apple-touch-icon" href="/assets/icon-180.png">
<meta name="apple-itunes-app" content="app-id=${APP_ID}, app-argument=${esc(selfUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Haps">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(selfUrl)}">
<meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${jsonLd(it, group, canonical)}</script>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,600..800&display=swap">
<link rel="stylesheet" href="/assets/tokens.css?v=1">
<style>${BASE_CSS}</style>
<meta name="haps:event-id" content="${esc(it.id)}">
<meta name="haps:venue" content="${esc(r.venue || '')}">
<script src="/assets/analytics.js"></script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/"><img src="/assets/icon-64.png" alt=""> haps</a>
  <a class="getapp" href="/beta">Get the app</a>
</header>
<main>
  <article>
    ${safeUrl(r.image_url) ? `<img class="hero-img" src="${esc(safeUrl(r.image_url))}" alt="${esc(r.title)}" fetchpriority="high" onerror="this.remove()">` : ''}
    ${badges ? `<div class="tags">${badges}</div>` : ''}
    <h1>${esc(r.title)}</h1>
    ${notice}
    ${r.one_line_summary ? `<p class="lede">${esc(r.one_line_summary)}</p>` : ''}
    <ul class="facts">${facts}</ul>
    <div class="actions">
      ${link ? `<a class="btn btn-primary" href="${esc(link)}" rel="noopener" data-co="${esc(it.id)}" data-co-kind="${safeUrl(r.ticket_url) ? 'tickets' : 'website'}" data-co-venue="${esc(r.venue || '')}" data-co-surface="event_page">${safeUrl(r.ticket_url) ? 'Get tickets ↗' : 'Event website ↗'}</a>` : ''}
      <a class="btn" href="/#e=${esc(it.id)}">Save &amp; browse more events</a>
    </div>
    ${datesBlock}
    ${descHtml}
    ${related}
    ${(() => {
      const near = nearestCity(r.latitude, r.longitude);
      return near
        ? `<p class="morecity"><a href="/events/${near.slug}/">More things to do in ${esc(near.name)} →</a>` +
          ` · <a href="/events/${near.slug}/this-weekend/">This weekend →</a></p>`
        : '';
    })()}
  <div class="appcta"><strong>Take it with you.</strong> Save this event in the Haps app and get a reminder before it starts. <a href="/beta">Get the app →</a></div>
  </article>
</main>
<footer class="footer">
  © 2026 Haps App · <a href="/">Browse all events</a> · <a href="/about/">About</a> · <a href="/embed/">Add events to your site</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
</footer>
</body>
</html>
`;
}

// ---------- landing pages ----------
/* "Standout" ranking for landing-page Top picks (Daniel, 2026-11-17): lead with
 * things a general audience would get excited about, but NOT pro sports or
 * arena tours — those are advertised everywhere already and repeat weekly —
 * and keep a local/quirky mix via per-venue / per-category caps. Admin Boost
 * (is_featured) always wins. Routine recurring programs (storytime, weekly
 * yoga, library classes, book clubs…) are dropped from general pages and only
 * appear on their own topic pages. */
const SPORTS_MATCHUP_RE = /\b(vs\.?|versus|v\.)\s/i;
const ARENA_RE = /delta center|maverik center|usana|utah first credit union amph|america first field|rice-eccles|vivint|huntsman center|lavell edwards|marriott center|dee events center|spectrum\b/i;
const ROUTINE_RE = /story ?time|\byoga\b|book (club|group)|\blapsit\b|\btoddler|\bbaby\b|\btots\b|\bpreschool\b|\besl\b|english (class|conversation)|conversation (club|group|class)|homework help|tutoring|computer (class|basics|help)|tech help|open lab|knitting|crochet|\blego\b|chess club|support group|recovery|\bal-?anon\b|\bmeditation\b|\bzumba\b|tai chi|\bpilates\b|aerobics|bingo|blood drive|office hours|study hall|teen (hangout|lounge)|craft(y)? (corner|time)/i;
const LIBRARY_RE = /\blibrary\b|\bbranch\b/i;

const coreTitle = t => norm(String(t || '')
  .replace(/\(.*?\)/g, ' ')
  .replace(/\s[—–-]\s.*$/, '')          // "X — Live at the Eccles", "X - 2026"
  .replace(/\b(19|20)\d\d\b/g, ' ')
  .replace(/^(the|a|an)\s+/i, ''));

function isRoutine(o, g) {
  const r = o.r;
  if (ROUTINE_RE.test(r.title)) return true;
  if (LIBRARY_RE.test(r.venue || '') && (r.appeal_score == null || r.appeal_score <= 6)) return true;
  // Weekly-ish series: 4+ dates in the window and nothing special about it.
  const days = new Set(g.items.filter(x => !x.ended).map(x => localDateStr(x.start, x.tz))).size;
  return days >= 4 && (r.appeal_score == null || r.appeal_score <= 6);
}
function standoutScore(o, g, routineOk = false) {
  const r = o.r;
  let s = r.appeal_score == null ? 5 : r.appeal_score;
  if (r.ms2) s += 0.5;                 // listed by 2+ outlets
  if (r.ms4) s += 0.5;                 // …4+
  if (safeUrl(r.image_url)) s += 0.3;
  if (r.is_free === true) s += 0.4;
  if (SPORTS_MATCHUP_RE.test(r.title)) s -= 3;
  if (ARENA_RE.test(r.venue || '')) s -= 2;
  if (/\btour\b/i.test(r.title)) s -= 1;    // touring headliners: advertised everywhere
  if (!routineOk && isRoutine(o, g)) s -= 3;
  if (groupFeatured(g)) s += 100;
  return s;
}
const PICKS_N = 8;
/* Greedy diverse top-N: best score first, at most 1 sports matchup, 2 per
 * venue, 3 per primary category. Boosted events bypass the caps. */
function topPicks(list, routineOk = false) {
  const ranked = list.map(p => ({ p, s: standoutScore(p.o, p.g, routineOk) })).sort((a, b) => b.s - a.s);
  const out = [], venue = new Map(), cat = new Map(), seen = [];
  let sports = 0;
  for (const { p, s } of ranked) {
    if (out.length >= PICKS_N) break;
    const boosted = s >= 100;
    if (!boosted && s < 6) break;      // don't pad Top picks with filler
    const v = norm(p.o.r.venue), c = p.o.primary || '-';
    // One slot per event: recurring dates ("Zipline Tours" Nov 18 + 19) and
    // same-venue title variants ("Bards Night Out Karaoke!" / "... With Madeline").
    const core = coreTitle(p.o.r.title);
    if (core && seen.some(x => x.core === core ||
        (v && x.v === v && (x.core.startsWith(core) || core.startsWith(x.core))))) continue;
    const isSports = SPORTS_MATCHUP_RE.test(p.o.r.title);
    if (!boosted && ((v && (venue.get(v) || 0) >= 2) || (cat.get(c) || 0) >= 3 || (isSports && sports >= 1))) continue;
    out.push(p);
    seen.push({ core, v });
    if (v) venue.set(v, (venue.get(v) || 0) + 1);
    cat.set(c, (cat.get(c) || 0) + 1);
    if (isSports) sports++;
  }
  return out;
}
function pickCardHtml(o, g) {
  const r = o.r;
  const when = fmt(o.start, o.tz, { weekday: 'short', month: 'short', day: 'numeric' }) +
    (o.noTime ? '' : ' · ' + fmt(o.start, o.tz, { hour: 'numeric', minute: '2-digit' }));
  const img = safeUrl(r.image_url);
  const ph = (o.primary && CATS[o.primary]) ? CATS[o.primary][0] : 'Event';
  return `<li class="pk"><a href="/event/${esc(o.id)}/">` +
    // No-image / broken-image fallback is a plain text tile (no emoji — matches
    // the site's token-based redesign; see /assets/tokens.css).
    (img ? `<img class="pk-img" src="${esc(img)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;pk-ph&quot;>${esc(ph)}</span>'">`
         : `<span class="pk-ph">${esc(ph)}</span>`) +
    `<span class="pk-body"><span class="pk-date">${esc(when)}</span>` +
    `<span class="pk-title">${groupFeatured(g) ? '<span class="pk-flag">Pick</span>' : ''}${esc(r.title)}</span>` +
    (r.venue ? `<span class="pk-venue">${esc(r.venue)}</span>` : '') + '</span></a></li>';
}

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

// A series counts as featured when ANY of its occurrences carries the flag —
// admin "Boost" (app detail screen / web ?admin=1 overlay) stars one row, not
// the whole group, and the weekend list may surface a different occurrence.
const groupFeatured = g => g.items.some(x => x.r.is_featured === true);

function rowHtml(o, g) {
  const r = o.r;
  const when = fmt(o.start, o.tz, { weekday: 'short', month: 'short', day: 'numeric' }) +
    (o.noTime ? '' : ' · ' + fmt(o.start, o.tz, { hour: 'numeric', minute: '2-digit' }));
  let tags = '';
  if (groupFeatured(g)) tags += '<span class="tag tag-pick">Our pick</span>';
  if (o.primary && CATS[o.primary]) tags += `<span class="tag">${esc(CATS[o.primary][0])}</span>`;
  if (r.is_free === true) tags += '<span class="tag tag-free">Free</span>';
  const dayCount = new Set(g.items.map(x => localDateStr(x.start, x.tz))).size;
  if (dayCount > 1) tags += `<span class="tag">${dayCount} dates</span>`;
  const venue = [r.venue, r.city].filter(Boolean).join(' · ');
  return `<li class="ev"><span class="ev-date">${esc(when)}</span>` +
    `<a class="ev-title" href="/event/${esc(o.id)}/">${esc(r.title)}</a>` +
    (venue ? `<span class="ev-venue">${esc(venue)}</span>` : '') +
    (tags ? `<div class="tags">${tags}</div>` : '') + '</li>';
}

/* One event in an embed feed (/embed/v1/{city}/{list}.json). Short keys —
 * these are fetched by every page that embeds the widget. Times are ISO UTC;
 * the widget formats them in `tz`. */
function feedItem(o, g) {
  const r = o.r;
  const it = { id: o.id, t: r.title, s: o.start.toISOString(), tz: o.tz };
  if (o.noTime) it.ad = 1;
  if (r.venue) it.v = r.venue;
  if (r.city) it.c = r.city;
  if (r.is_free === true) it.free = 1;
  if (groupFeatured(g)) it.pick = 1;
  const img = safeUrl(r.image_url);
  if (img) it.img = img;
  const n = new Set(g.items.map(x => localDateStr(x.start, x.tz))).size;
  if (n > 1) it.n = n;
  return it;
}

function itemListLd(name, urls) {
  return JSON.stringify({
    '@context': 'https://schema.org', '@type': 'ItemList', name,
    itemListElement: urls.slice(0, 30).map((u, i) => ({ '@type': 'ListItem', position: i + 1, url: u }))
  }).replace(/</g, '\\u003c');
}

function landingHtml(o) {
  // o: { path, headTitle, metaDesc, h1, lede, intro?, crumb, quick? (hub nav, top),
  //      more? (sibling-page nav, bottom), picked:{rows,urls,total}, emptyMsg,
  //      browseHash, city }
  const url = SITE + o.path;
  const picks = o.picked.picks && o.picked.picks.length >= 3
    ? `<h2>Top picks</h2><ol class="picks">${o.picked.picks.join('')}</ol>` +
      `<h2>${o.picked.total > 0 ? 'Everything coming up' : ''}</h2>`
    : '';
  const list = picks + (o.picked.rows.length
    ? `<ol class="ev-list">${o.picked.rows.join('\n')}</ol>` +
      (o.picked.total > o.picked.rows.length
        ? `<p class="lede">…and ${o.picked.total - o.picked.rows.length} more — <a href="${esc(o.browseHash)}">browse them all</a>.</p>` : '')
    : `<p class="lede">${esc(o.emptyMsg)}</p>`);
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
<link rel="icon" href="/assets/icon-64.png">
<link rel="apple-touch-icon" href="/assets/icon-180.png">
<meta name="apple-itunes-app" content="app-id=${APP_ID}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Haps">
<meta property="og:title" content="${esc(o.h1)}">
<meta property="og:description" content="${esc(o.metaDesc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE}/assets/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${itemListLd(o.h1, [...new Set([...(o.picked.pickUrls || []), ...o.picked.urls])])}</script>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,600..800&display=swap">
<link rel="stylesheet" href="/assets/tokens.css?v=1">
<style>${BASE_CSS}</style>
<script src="/assets/analytics.js"></script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/"><img src="/assets/icon-64.png" alt=""> haps</a>
  <a class="getapp" href="/beta">Get the app</a>
</header>
<main>
  ${o.crumb ? `<nav class="crumbs">${o.crumb}</nav>` : ''}
  <h1>${esc(o.h1)}</h1>
  <p class="lede">${esc(o.lede)}</p>
  ${o.intro ? `<p class="intro">${esc(o.intro)}</p>` : ''}
  ${o.quick || ''}
  <div class="actions">
    <a class="btn btn-primary" href="${esc(o.browseHash)}">Browse with filters &amp; map</a>
    <a class="btn" href="/beta">Get the app</a>
  </div>
  ${list}
  ${o.about && o.about.length ? `<section class="about"><h2>Good to know</h2>${o.about.map(p => `<p class="intro">${esc(p)}</p>`).join('')}</section>` : ''}
  ${o.more ? `<section class="more"><h2>More things to do in ${esc(o.city.name)}</h2>${o.more}</section>` : ''}
  <div class="appcta"><strong>Never miss a thing.</strong> The Haps app learns what you like, syncs your saves, and reminds you before events start. <a href="/beta">Get the app →</a></div>
  <p class="cities">Things to do in: ${others}</p>
</main>
<footer class="footer">
  © 2026 Haps App · <a href="/">Browse all events</a> · <a href="/about/">About</a> · <a href="/embed/">Add events to your site</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
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
  // opts.routineOk: keep routine recurring programs (topic pages only).
  function pick(pred, cap = LIST_CAP, opts = {}) {
    let picked = [];
    groups.forEach(g => {
      const o = g.items.find(x => !x.ended && pred(x));
      if (o && (opts.routineOk || !isRoutine(o, g))) picked.push({ o, g });
    });
    // Same show listed under venue-name variants ("The Eccles Theater" vs
    // "eccles theater") survives the title|venue grouping — collapse on core
    // title + first local date, keeping the best-scoring copy.
    const seen = new Map();
    picked.forEach(p => {
      const k = coreTitle(p.o.r.title) + '|' + localDateStr(p.o.start, p.o.tz);
      const cur = seen.get(k);
      if (!cur || standoutScore(p.o, p.g) > standoutScore(cur.o, cur.g)) seen.set(k, p);
    });
    picked = [...seen.values()];
    // featuredFirst: admin-boosted events (is_featured, the app/overlay "star")
    // pin to the top as the page's suggested picks; the rest stay chronological.
    picked.sort((a, b) => {
      if (opts.featuredFirst) {
        const d = (groupFeatured(a.g) ? 0 : 1) - (groupFeatured(b.g) ? 0 : 1);
        if (d) return d;
      }
      return a.o.start - b.o.start;
    });
    const top = topPicks(picked, opts.routineOk);
    return {
      total: picked.length,
      featured: picked.filter(p => groupFeatured(p.g)).length,
      // Newest event on this landing page → its sitemap <lastmod>. 0 when empty
      // (sitemapLastmod() then falls back to build time).
      mtimeMs: picked.length ? Math.max(...picked.map(p => p.o.mtimeMs)) : 0,
      rows: picked.slice(0, cap).map(p => rowHtml(p.o, p.g)),
      urls: picked.slice(0, cap).map(p => `${SITE}/event/${p.o.id}/`),
      picks: top.map(p => pickCardHtml(p.o, p.g)),
      pickUrls: top.map(p => `${SITE}/event/${p.o.id}/`),
      feed: picked.slice(0, EMBED_FEED_CAP).map(p => feedItem(p.o, p.g))
    };
  }

  const DAY = 86400e3;
  const within = days => o => o.start.getTime() <= now + days * DAY;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const year = tzParts(new Date(), 'America/Denver').y;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const fill = (t, extra = {}) => t.replace(/\{city\}/g, city.name).replace(/\{year\}/g, year)
    .replace(/\{(\w+)\}/g, (m, k) => (k in extra ? extra[k] : m));

  /* Page specs first, HTML second: every sub-page links its siblings (the
   * "More things to do" nav), so the full set must be known before rendering.
   * group: 'when' | 'topic' | 'cat' — controls nav grouping on the hub. */
  const specs = [];
  const add = (group, slug, label, emoji, picked, o) =>
    specs.push({ group, slug, label, emoji, picked, path: `/events/${city.slug}/${slug}/`, o });

  const wkDates = weekendDates();
  const wkSet = new Set(wkDates);
  const wkLabel = weekendLabel(wkDates);
  const todayStr = localDateStr(new Date(), 'America/Denver');
  const todayLabel = fmt(new Date(), 'America/Denver', { weekday: 'long', month: 'long', day: 'numeric' });

  // --- when ---
  const today = pick(o => localDateStr(o.start, o.tz) === todayStr, LIST_CAP, { featuredFirst: true });
  if (today.total >= CAT_PAGE_MIN_GROUPS) add('when', 'today', 'Today', '⏰', today, {
    headTitle: `Things to Do in ${city.name} Today & Tonight | Haps`,
    h1: `Things to do in ${city.name} today`,
    lede: `${plural(today.total, 'event')} around ${city.name} today, ${todayLabel} — from daytime activities to tonight’s shows. Updated daily.`,
    metaDesc: `What's happening in ${city.name} today and tonight (${todayLabel}): ${today.total} events — live music, family activities, classes, nightlife and more.`,
    emptyMsg: 'Nothing listed for today — try this weekend.', browseHash: `/#city=${city.browser}&when=today`
  });

  const weekend = pick(o => wkSet.has(localDateStr(o.start, o.tz)), LIST_CAP, { featuredFirst: true });
  add('when', 'this-weekend', 'This weekend', '🗓️', weekend, {
    headTitle: `Things to Do in ${city.name} This Weekend | Haps`,
    h1: `Things to do in ${city.name} this weekend`,
    lede: `${plural(weekend.total, 'event')} happening around ${city.name} this weekend (${wkLabel})` +
      `${weekend.featured ? ' — starting with our top picks' : ''} — updated daily.`,
    metaDesc: `What's happening in ${city.name} this weekend (${wkLabel}): ${weekend.total} events — concerts, markets, family fun, nightlife and more. Updated daily on Haps.`,
    emptyMsg: 'Nothing on the calendar yet — check back soon or browse all upcoming events.',
    browseHash: `/#city=${city.browser}&when=weekend`
  });

  const week = pick(o => o.start.getTime() >= now - GRACE_MS && within(7)(o), LIST_CAP, { featuredFirst: true });
  if (week.total >= CAT_PAGE_MIN_GROUPS) add('when', 'this-week', 'This week', '📆', week, {
    headTitle: `Things to Do in ${city.name} This Week | Haps`,
    h1: `Things to do in ${city.name} this week`,
    lede: `${plural(week.total, 'event')} around ${city.name} in the next 7 days — updated daily.`,
    metaDesc: `${week.total} events in ${city.name}, Utah over the next 7 days — concerts, shows, family activities, classes and more. Updated daily on Haps.`,
    emptyMsg: 'Nothing listed this week — check back soon.', browseHash: `/#city=${city.browser}&when=week`
  });

  const free = pick(o => o.r.is_free === true && within(FREE_WINDOW_DAYS)(o));
  if (free.total >= CAT_PAGE_MIN_GROUPS) add('when', 'free', 'Free', '💸', free, {
    headTitle: `Free Things to Do in ${city.name} | Haps`,
    h1: `Free things to do in ${city.name}`,
    lede: `${free.total} free events coming up around ${city.name} in the next ${FREE_WINDOW_DAYS} days — no ticket required.`,
    metaDesc: `${free.total} free events in ${city.name}, Utah — free concerts, markets, family activities and more over the next ${FREE_WINDOW_DAYS} days. Updated daily on Haps.`,
    emptyMsg: 'No free events listed right now — check back soon.', browseHash: `/#city=${city.browser}&free=1`
  });

  const freeKids = pick(o => o.r.is_free === true && o.slugs.includes('family-kids') && within(FREE_WINDOW_DAYS)(o));
  if (freeKids.total >= CAT_PAGE_MIN_GROUPS) add('when', 'free-kids', 'Free with kids', '🧸', freeKids, {
    headTitle: `Free Things to Do with Kids in ${city.name} | Haps`,
    h1: `Free things to do with kids in ${city.name}`,
    lede: `${plural(freeKids.total, 'free family event')} around ${city.name} in the next ${FREE_WINDOW_DAYS} days.`,
    intro: `Storytimes, library programs, park events, family festivals and kids’ activities around ${city.name} that don’t cost a thing.`,
    metaDesc: `${freeKids.total} free kids' and family events in ${city.name}, Utah — storytimes, crafts, festivals and more over the next ${FREE_WINDOW_DAYS} days.`,
    emptyMsg: 'No free family events listed right now — check back soon.',
    browseHash: `/#city=${city.browser}&cat=family-kids&free=1`
  });

  // --- topics (keyword) ---
  TOPICS.forEach(t => {
    const picked = pick(o => within(TOPIC_WINDOW_DAYS)(o) &&
      t.re.test(t.inSummary ? `${o.r.title} ${o.r.one_line_summary || ''}` : o.r.title) &&
      !(t.exclude && t.exclude.test(o.r.title)), LIST_CAP, { routineOk: true });
    if (picked.total < CAT_PAGE_MIN_GROUPS) return;
    const h1 = `${t.h1} ${city.name}`;
    add('topic', t.slug, t.label, t.emoji, picked, {
      headTitle: fill(t.head),
      h1: cap(h1),
      lede: `${plural(picked.total, 'upcoming event')} around ${city.name} — updated daily.`,
      intro: fill(t.intro),
      about: (t.about || []).map(p => fill(p)),
      metaDesc: `${fill(t.intro)} ${picked.total} upcoming — updated daily on Haps.`,
      emptyMsg: 'Nothing listed right now — check back soon.',
      browseHash: `/#city=${city.browser}&q=${encodeURIComponent(t.q)}`
    });
  });

  // --- categories ---
  Object.keys(CATS).forEach(slug => {
    const picked = pick(o => o.slugs.includes(slug) && within(HUB_WINDOW_DAYS)(o));
    if (picked.total < CAT_PAGE_MIN_GROUPS) return;
    const phrase = CAT_PHRASES[slug] || `${CATS[slug][0]} events in`;
    const h1 = cap(`${phrase} ${city.name}`);
    add('cat', slug, CATS[slug][0], CATS[slug][1], picked, {
      headTitle: `${h1} | Haps`, h1,
      lede: `${picked.total} upcoming ${CATS[slug][0].toLowerCase()} event${picked.total === 1 ? '' : 's'} around ${city.name} — updated daily.`,
      metaDesc: `${picked.total} upcoming ${CATS[slug][0].toLowerCase()} events in ${city.name}, Utah. Dates, times, venues and tickets — updated daily on Haps.`,
      emptyMsg: 'Nothing listed right now — check back soon.',
      browseHash: `/#city=${city.browser}&cat=${slug}`
    });
  });

  // Nav pills, grouped. `current` marks the page being rendered.
  const GROUPS = [['when', 'When'], ['topic', 'Popular now'], ['cat', 'Categories']];
  const ordered = g => {
    const list = specs.filter(x => x.group === g);
    return g === 'when' ? list : list.slice().sort((a, b) => b.picked.total - a.picked.total);
  };
  const nav = current => GROUPS.map(([g, label]) => {
    const list = ordered(g);
    if (!list.length) return '';
    return `<div class="quick"><span class="qlabel">${label}</span>` + list.map(x =>
      `<a class="pill${x.path === current ? ' is-on' : ''}" href="${x.path}">${esc(x.label)}</a>`).join('') + '</div>';
  }).join('');

  const pages = specs.map(x => ({
    path: x.path,
    mtimeMs: x.picked.mtimeMs,
    embed: { list: x.slug, label: x.label, group: x.group, title: x.o.h1, total: x.picked.total, items: x.picked.feed },
    html: landingHtml(Object.assign({
      path: x.path, city, crumb: `${crumb} ${esc(x.label)}`,
      picked: x.picked, more: nav(x.path)
    }, x.o))
  }));

  const hub = pick(within(HUB_WINDOW_DAYS));
  pages.unshift({
    path: hubPath,
    mtimeMs: hub.mtimeMs,
    embed: { list: 'all', label: 'Everything', group: 'all', title: `Things to do in ${city.name}`, total: hub.total, items: hub.feed },
    html: landingHtml({
      path: hubPath, city, crumb: '',
      headTitle: `Things to Do in ${city.name} — Local Events Calendar | Haps`,
      h1: `Things to do in ${city.name}`,
      lede: city.blurb,
      metaDesc: `Looking for things to do in ${city.name}? ${hub.total} upcoming events — concerts, festivals, food, family fun, nightlife and more. Updated daily on Haps.`,
      quick: nav(hubPath),
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
  // Keys whose content changed (or appeared) this build → IndexNow ping.
  // Empty on a cold start (no prior state), so an evicted cache can't
  // resubmit the whole site.
  const warm = Object.keys(prevStamps).length > 0;
  const changedKeys = new Set();
  function resolveLastmod(key, hash, fallbackMs) {
    const prev = prevStamps[key];
    if (warm && (!prev || prev.h !== hash)) changedKeys.add(key);
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
      repEntries.push({ id: group.rep.id, mtimeMs: newestMs,
        changed: group.items.some(it => changedKeys.has('E:' + it.id)) });
    }
  }

  // City / category landing pages under /events/{city}/...
  const landingEntries = [];
  const embedIndex = { generatedAt: new Date(buildMs).toISOString(), cities: [] };
  const embedDir = path.join(siteDir, 'embed', 'v1');
  for (const city of LANDING_CITIES) {
    const cityLists = [];
    embedIndex.cities.push({ slug: city.slug, name: city.name, lists: cityLists });
    await mkdir(path.join(embedDir, city.slug), { recursive: true });
    for (const page of cityPages(city, items)) {
      const e = page.embed;
      cityLists.push({ list: e.list, label: e.label, group: e.group, total: e.total });
      await writeFile(path.join(embedDir, city.slug, `${e.list}.json`), JSON.stringify({
        city: city.slug, cityName: city.name, list: e.list, title: e.title,
        url: SITE + page.path, total: e.total, items: e.items
      }));
      const dir = path.join(siteDir, page.path.slice(1));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'index.html'), page.html);
      landingEntries.push({
        path: page.path,
        mtimeMs: resolveLastmod('L:' + page.path, sha1(page.html), page.mtimeMs)
      });
    }
  }

  await writeFile(path.join(embedDir, 'index.json'), JSON.stringify(embedIndex));
  await writeFile(path.join(siteDir, 'sitemap.xml'), sitemapXml(repEntries, landingEntries, buildMs));
  if (statePath) {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(nextState));
  }

  // IndexNow: sitemap URLs whose content changed this build. The workflow
  // submits this list after the deploy is live (see deploy.yml `indexnow`).
  const inArg = process.argv.indexOf('--indexnow-out');
  if (inArg > -1 && process.argv[inArg + 1]) {
    const urls = [
      ...landingEntries.filter(e => changedKeys.has('L:' + e.path)).map(e => SITE + e.path),
      ...repEntries.filter(e => e.changed).map(e => `${SITE}/event/${e.id}/`)
    ].slice(0, INDEXNOW_MAX_URLS);
    await writeFile(path.resolve(process.argv[inArg + 1]), urls.join('\n') + (urls.length ? '\n' : ''));
    console.log(`IndexNow: ${urls.length} changed URLs${warm ? '' : ' (cold start — none submitted)'}`);
  }

  const endedCount = items.filter(it => it.ended).length;
  console.log(`Wrote ${written} event pages (${endedCount} ended-but-kept; ${repEntries.length} collapsed events in sitemap) → ${eventDir}`);
  console.log(`Wrote ${landingEntries.length} landing pages: ${landingEntries.map(e => e.path).join(' ')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
