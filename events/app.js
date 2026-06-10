/* Haps — /events web browser.
 * Static client against Supabase PostgREST with the publishable key.
 * Mirrors the app's feed gates (EventsRepository.kt): merged_into null,
 * is_hidden false, is_low_priority false, enrichment_status != expanded,
 * is_virtual false, start_time >= now-4h, bbox prefilter + client radius,
 * client elapsed check via the same effective-end rules.
 */
(function () {
  'use strict';

  // ---------- config ----------
  var SB = 'https://cvcnugkqdgmcntsuplaj.supabase.co/rest/v1';
  var KEY = 'sb_publishable_8FPhq5etjCNGvPwaQyFyCA_La2INImz';
  var PAGE = 250;          // rows per REST page
  var FILL_TARGET = 24;    // keep fetching until this many cards are visible
  var MAX_FILL_FETCHES = 4;
  var SEARCH_LIMIT = 300;
  var GRACE_MS = 4 * 3600e3; // feed floor: now - 4h, same as the app

  var SELECT = 'id,title,one_line_summary,description,start_time,end_time,venue,address,city,state,' +
    'latitude,longitude,image_url,ticket_url,event_url,link_url,original_url,is_free,price_summary,' +
    'age_restriction,is_featured,save_count,precision_class,is_long_running,exhibit_id,series_id,' +
    'vibe_tags,event_category_map(is_primary,event_categories(name,slug))';

  // slug, label, emoji, gradient
  var CATS = [
    ['music', 'Music', '🎵', ['#7c3aed', '#c026d3']],
    ['food-drink', 'Food & Drink', '🍜', ['#ea580c', '#f59e0b']],
    ['nightlife', 'Nightlife', '🍸', ['#312e81', '#7c3aed']],
    ['arts-culture', 'Arts & Culture', '🎨', ['#0ea5e9', '#8b5cf6']],
    ['theater-performing-arts', 'Theater', '🎭', ['#be123c', '#f43f5e']],
    ['film-cinema', 'Film', '🎬', ['#334155', '#64748b']],
    ['family-kids', 'Family & Kids', '🎈', ['#f59e0b', '#ef4444']],
    ['outdoors-nature', 'Outdoors', '🌲', ['#15803d', '#65a30d']],
    ['sports-fitness', 'Sports & Fitness', '🏃', ['#0d9488', '#22c55e']],
    ['markets-shopping', 'Markets', '🛍️', ['#c026d3', '#f472b6']],
    ['community', 'Community', '🤝', ['#0369a1', '#06b6d4']],
    ['date-night', 'Date Night', '🌹', ['#be185d', '#f43f5e']],
    ['education-workshops', 'Workshops', '📚', ['#4338ca', '#3b82f6']],
    ['health-wellness', 'Wellness', '🧘', ['#059669', '#34d399']],
    ['holidays-seasonal', 'Seasonal', '🎉', ['#d97706', '#dc2626']],
    ['networking-business', 'Networking', '💼', ['#1e40af', '#3730a3']],
    ['religious-spiritual', 'Spiritual', '🕊️', ['#6d28d9', '#a78bfa']],
    ['service', 'Service', '💗', ['#0f766e', '#14b8a6']],
    ['singles', 'Singles', '💘', ['#db2777', '#f472b6']],
    ['teens', 'Teens', '🎮', ['#7c2d12', '#ea580c']]
  ];
  var CAT_BY_SLUG = {};
  CATS.forEach(function (c) { CAT_BY_SLUG[c[0]] = c; });

  var CITIES = [
    ['slc', 'Salt Lake City', 40.7608, -111.8910],
    ['provo', 'Provo / Orem', 40.2338, -111.6585],
    ['ogden', 'Ogden', 41.2230, -111.9738],
    ['park-city', 'Park City', 40.6461, -111.4980],
    ['logan', 'Logan', 41.7370, -111.8338],
    ['st-george', 'St. George', 37.0965, -113.5684],
    ['sacramento', 'Sacramento', 38.5816, -121.4944]
  ];
  var RADII = [10, 25, 50, 75];

  // ---------- state ----------
  var state = {
    citySlug: 'slc',
    cityName: 'Salt Lake City',
    lat: 40.7608, lng: -111.8910,
    radius: 25,
    when: 'all',
    cats: {},            // slug -> true
    freeOnly: false,
    sort: 'soonest',
    q: '',
    view: 'grid',        // grid | map
    savedView: false,
    rows: [],            // raw rows, deduped by id, ascending start
    rowIds: {},
    cursor: undefined,   // undefined = not loaded; null = exhausted; string = next start_time
    loading: false,
    error: false
  };

  var els = {};
  ['searchInput', 'searchClear', 'savedBtn', 'savedCount', 'heroCity', 'locChip', 'locLabel',
   'timeChips', 'freeChip', 'catChips', 'resultMeta', 'sortSel', 'viewGrid', 'viewMap',
   'savedNote', 'grid', 'mapWrap', 'stateBox', 'loadMoreWrap', 'loadMoreBtn', 'sentinel',
   'appBanner', 'bannerClose', 'locDialog', 'useGeo', 'cityList', 'radiusChips',
   'detailDialog', 'detailBody', 'toast', 'heroband', 'filterbar']
    .forEach(function (id) { els[id] = document.getElementById(id); });

  // ---------- tiny utils ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safeUrl(u) {
    if (typeof u !== 'string') return '';
    u = u.trim();
    return /^https?:\/\//i.test(u) ? u : '';
  }
  function haversineMi(lat1, lng1, lat2, lng2) {
    var R = 3958.8, toR = Math.PI / 180;
    var dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  var fmtTime = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  var fmtDayShort = new Intl.DateTimeFormat([], { weekday: 'short', month: 'short', day: 'numeric' });
  var fmtDayLong = new Intl.DateTimeFormat([], { weekday: 'long', month: 'long', day: 'numeric' });
  var fmtMonth = new Intl.DateTimeFormat([], { month: 'short' });
  var fmtMonthDay = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  var toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 2400);
  }

  // ---------- saves (localStorage) ----------
  var SAVE_KEY = 'hapsWebSaves';
  function loadSaves() {
    try { return JSON.parse(localStorage.getItem(SAVE_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  var saves = loadSaves();
  function persistSaves() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(saves)); } catch (e) { /* private mode */ }
  }
  function isSaved(id) { return !!saves[id]; }
  function savedIds() { return Object.keys(saves).filter(function (id) { return /^[0-9a-f-]{36}$/i.test(id); }); }
  function toggleSave(id, title) {
    if (saves[id]) { delete saves[id]; toast('Removed from saves'); }
    else { saves[id] = { t: Date.now(), title: (title || '').slice(0, 80) }; toast('Saved 💜 — get the app to sync'); }
    persistSaves();
    refreshSaveUi(id);
  }
  function refreshSaveUi(id) {
    var n = savedIds().length;
    els.savedCount.textContent = String(n);
    els.savedCount.hidden = n === 0;
    if (id) {
      document.querySelectorAll('[data-heart="' + id + '"]').forEach(function (b) {
        b.classList.toggle('is-saved', isSaved(id));
        if (b.classList.contains('dt-btn')) {
          b.querySelector('span').textContent = isSaved(id) ? 'Saved' : 'Save';
        }
      });
    }
  }

  // ---------- time windows ----------
  function feedFloor() { return new Date(Date.now() - GRACE_MS); }
  function chipWindow(when) {
    var now = new Date(), today = startOfDay(now), dow = now.getDay();
    switch (when) {
      case 'today': return { start: null, end: addDays(today, 1) };
      case 'tomorrow': return { start: addDays(today, 1), end: addDays(today, 2) };
      case 'weekend': {
        if (dow === 6) return { start: null, end: addDays(today, 2) };          // Sat → through Sun
        if (dow === 0) return { start: null, end: addDays(today, 1) };          // Sun → through tonight
        var fri = addDays(today, 5 - dow);
        return { start: fri, end: addDays(fri, 3) };
      }
      case 'week': return { start: null, end: addDays(today, 7) };
      default: return { start: null, end: null };
    }
  }

  // ---------- REST ----------
  function rest(pathAndQuery) {
    return fetch(SB + pathAndQuery, {
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function bboxParam() {
    var buf = (state.radius * 1.2) / 69.0;
    var lngBuf = (state.radius * 1.2) / (69.0 * Math.cos(state.lat * Math.PI / 180));
    return '(latitude.gte.' + (state.lat - buf) + ',latitude.lte.' + (state.lat + buf) +
      ',longitude.gte.' + (state.lng - lngBuf) + ',longitude.lte.' + (state.lng + lngBuf) + ')';
  }
  function baseParams(p) {
    p.set('select', SELECT);
    p.set('merged_into', 'is.null');
    p.set('is_hidden', 'eq.false');
    p.set('enrichment_status', 'neq.expanded');
    p.set('order', 'start_time.asc.nullslast');
    p.set('and', bboxParam());
    if (state.freeOnly) p.set('is_free', 'eq.true');
    return p;
  }
  function feedQuery(cursor) {
    var p = baseParams(new URLSearchParams());
    p.set('is_low_priority', 'eq.false');
    p.set('is_virtual', 'eq.false');
    var win = chipWindow(state.when);
    var startFrom = cursor || (win.start && win.start > feedFloor() ? win.start : feedFloor()).toISOString();
    p.append('start_time', (cursor ? 'gt.' : 'gte.') + startFrom);
    if (win.end) p.append('start_time', 'lt.' + win.end.toISOString());
    p.set('limit', String(PAGE));
    return '/events?' + p.toString();
  }
  function searchQuery(q) {
    var p = baseParams(new URLSearchParams());
    var win = chipWindow(state.when);
    var startFrom = (win.start && win.start > feedFloor() ? win.start : feedFloor()).toISOString();
    p.append('start_time', 'gte.' + startFrom);
    if (win.end) p.append('start_time', 'lt.' + win.end.toISOString());
    var pat = '"*' + q.replace(/["\\]/g, ' ').trim() + '*"';
    p.set('or', '(title.ilike.' + pat + ',venue.ilike.' + pat + ',description.ilike.' + pat + ')');
    p.set('limit', String(SEARCH_LIMIT));
    return '/events?' + p.toString();
  }
  function byIdsQuery(ids) {
    var p = new URLSearchParams();
    p.set('select', SELECT);
    p.set('is_hidden', 'eq.false');
    p.set('id', 'in.(' + ids.join(',') + ')');
    p.set('order', 'start_time.asc.nullslast');
    return '/events?' + p.toString();
  }

  // ---------- event model ----------
  function toItem(r) {
    var start = r.start_time ? new Date(r.start_time) : null;
    var end = r.end_time ? new Date(r.end_time) : null;
    var cont = r.precision_class === 'continuous';
    var dropIn = r.precision_class === 'drop_in_window';
    var effEnd = null;
    if (start) {
      if (cont || dropIn) {
        var endOfDay = addDays(startOfDay(start), 1);
        effEnd = end && end > endOfDay ? end : endOfDay;
      } else {
        effEnd = end || new Date(start.getTime() + 2 * 3600e3);
      }
    }
    var slugs = [], primary = null;
    (r.event_category_map || []).forEach(function (m) {
      var c = m && m.event_categories;
      if (c && c.slug) {
        slugs.push(c.slug);
        if (m.is_primary || !primary) primary = c.slug;
      }
    });
    var dist = (r.latitude != null && r.longitude != null)
      ? haversineMi(state.lat, state.lng, r.latitude, r.longitude) : null;
    var allDay = !!(start && end && start.getHours() === 0 && start.getMinutes() === 0 &&
      end.getHours() === 23 && end.getMinutes() >= 55);
    return {
      r: r, id: r.id, start: start, end: end, effEnd: effEnd,
      cont: cont, dropIn: dropIn, allDay: allDay,
      slugs: slugs, primary: primary, dist: dist
    };
  }
  function passesFilters(it, opts) {
    opts = opts || {};
    var now = new Date();
    if (!it.start || !it.effEnd || it.effEnd <= now) return false;
    if (!opts.skipRadius) {
      if (it.dist == null || it.dist > state.radius) return false;
    }
    var activeCats = Object.keys(state.cats);
    if (activeCats.length && !it.slugs.some(function (s) { return state.cats[s]; })) return false;
    if (state.freeOnly && it.r.is_free !== true) return false;
    return true;
  }

  // Collapse multi-date series / long-running runs into one card (the app does
  // this for exhibits and dense multi-day series; title+venue is the web's
  // approximation, keyed on exhibit_id when the pipeline provides one).
  function collapse(items) {
    var groups = {}, order = [];
    items.forEach(function (it) {
      var key = (it.r.is_long_running && it.r.exhibit_id) ? 'ex:' + it.r.exhibit_id
        : (it.r.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|' +
          (it.r.venue || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(it);
    });
    return order.map(function (key) {
      var g = groups[key];
      var days = {};
      g.forEach(function (it) { if (it.start) days[it.start.toDateString()] = true; });
      var dayCount = Object.keys(days).length;
      return { rep: g[0], others: g.slice(1), dayCount: dayCount };
    });
  }
  function sortGroups(gs) {
    if (state.sort === 'trending') {
      gs.sort(function (a, b) {
        var d = (b.rep.r.save_count || 0) - (a.rep.r.save_count || 0);
        return d !== 0 ? d : a.rep.start - b.rep.start;
      });
    } else {
      gs.sort(function (a, b) {
        var fa = a.rep.r.is_featured === true ? 0 : 1;
        var fb = b.rep.r.is_featured === true ? 0 : 1;
        return fa !== fb ? fa - fb : a.rep.start - b.rep.start;
      });
    }
    return gs;
  }
  function visibleGroups() {
    var items = state.rows.map(toItem).filter(function (it) { return passesFilters(it); });
    return sortGroups(collapse(items));
  }

  // ---------- labels ----------
  function whenLabel(it) {
    var now = new Date();
    var day;
    if (it.cont && it.start <= now) day = 'Now';
    else if (sameDay(it.start, now)) day = it.start.getHours() >= 17 ? 'Tonight' : 'Today';
    else if (sameDay(it.start, addDays(startOfDay(now), 1))) day = 'Tomorrow';
    else day = fmtDayShort.format(it.start);
    var time;
    if (it.cont) time = it.end ? 'through ' + fmtMonthDay.format(it.end) : 'ongoing';
    else if (it.allDay) time = 'All day';
    else if (it.dropIn) time = 'Drop in';
    else time = fmtTime.format(it.start);
    return day + ' · ' + time;
  }
  function badgeFor(it) {
    var now = new Date();
    if (it.cont && it.start <= now) return { top: 'NOW', big: '★' };
    return { top: fmtMonth.format(it.start).toUpperCase(), big: String(it.start.getDate()) };
  }
  function gradFor(slug) {
    var c = CAT_BY_SLUG[slug];
    return c ? c[3] : ['#7c3aed', '#c026d3'];
  }
  function emojiFor(slug) {
    var c = CAT_BY_SLUG[slug];
    return c ? c[2] : '✨';
  }
  function linkFor(r) {
    return safeUrl(r.ticket_url) || safeUrl(r.event_url) || safeUrl(r.link_url) || safeUrl(r.original_url);
  }

  // ---------- render: chips ----------
  function renderCatChips() {
    els.catChips.innerHTML = CATS.map(function (c) {
      return '<button class="chip chip-cat' + (state.cats[c[0]] ? ' is-on' : '') + '" data-cat="' + c[0] + '">' +
        c[2] + ' ' + esc(c[1]) + '</button>';
    }).join('');
  }
  function renderLocUi() {
    els.locLabel.textContent = state.cityName + ' · ' + state.radius + ' mi';
    els.heroCity.textContent = state.citySlug === 'geo' ? 'near you' : 'near ' + state.cityName;
    document.title = (state.citySlug === 'geo' ? 'Browse events near you' : state.cityName + ' events') + ' — Haps';
  }
  function renderCityList() {
    els.cityList.innerHTML = CITIES.map(function (c) {
      return '<button class="loc-city' + (state.citySlug === c[0] ? ' is-on' : '') + '" data-city="' + c[0] + '">' + esc(c[1]) + '</button>';
    }).join('');
    els.radiusChips.innerHTML = RADII.map(function (r) {
      return '<button class="chip' + (state.radius === r ? ' is-on' : '') + '" data-radius="' + r + '">' + r + ' mi</button>';
    }).join('');
  }

  // ---------- render: cards ----------
  function heartSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-6.8-4.4-9-8.4C1.6 9 3.4 5.8 6.6 5.8c2 0 3.2 1.1 5.4 3.2 2.2-2.1 3.4-3.2 5.4-3.2 3.2 0 5 3.2 3.6 6.3-2.2 4-9 8.4-9 8.4z"/></svg>';
  }
  function cardHtml(group) {
    var it = group.rep, r = it.r;
    var grad = gradFor(it.primary);
    var img = safeUrl(r.image_url);
    var catMeta = it.primary ? CAT_BY_SLUG[it.primary] : null;
    var badge = badgeFor(it);
    var badges = '';
    if (r.is_featured === true) badges += '<span class="flag-badge b-feat">✨ Featured</span>';
    else if ((r.save_count || 0) >= 5) badges += '<span class="flag-badge">🔥 Trending</span>';
    if (r.is_free === true) badges += '<span class="flag-badge b-free">Free</span>';
    var tags = '';
    if (catMeta) tags += '<span class="tag">' + catMeta[2] + ' ' + esc(catMeta[1]) + '</span>';
    if (group.dayCount > 1) tags += '<span class="tag t-dates">📅 ' + group.dayCount + ' dates</span>';
    if (it.dist != null) tags += '<span class="tag t-dist">' + it.dist.toFixed(1) + ' mi</span>';
    return '<article class="card" data-id="' + esc(it.id) + '" tabindex="0" role="button" aria-label="' + esc(r.title) + '">' +
      '<div class="card-media" style="--g1:' + grad[0] + ';--g2:' + grad[1] + '">' +
        '<span class="fallback-emoji" aria-hidden="true">' + emojiFor(it.primary) + '</span>' +
        (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" onerror="this.remove()">' : '') +
        '<span class="date-badge">' + badge.top + '<span class="dnum">' + badge.big + '</span></span>' +
        '<button class="heart-btn' + (isSaved(it.id) ? ' is-saved' : '') + '" data-heart="' + esc(it.id) + '" aria-label="Save event">' + heartSvg() + '</button>' +
        (badges ? '<span class="flag-badges">' + badges + '</span>' : '') +
      '</div>' +
      '<div class="card-body">' +
        '<span class="card-when">' + esc(whenLabel(it)) + '</span>' +
        '<h3 class="card-title">' + esc(r.title) + '</h3>' +
        '<span class="card-venue">' + esc(r.venue || r.address || r.city || '') + '</span>' +
        '<div class="card-tags">' + tags + '</div>' +
      '</div>' +
    '</article>';
  }
  function promoHtml() {
    return '<aside class="card card-promo">' +
      '<h3>Like what you see?</h3>' +
      '<p>Haps is better in the app — swipe through events, sync your saves, and get reminders before things start.</p>' +
      '<a href="/beta">Join the beta →</a>' +
    '</aside>';
  }
  function skeletonHtml() {
    var one = '<div class="card sk" aria-hidden="true"><div class="card-media"></div>' +
      '<div class="card-body"><div class="sk-line w40"></div><div class="sk-line w90"></div><div class="sk-line w60"></div></div></div>';
    return new Array(9).join(one) + one;
  }

  var renderedGroups = [];
  function renderGrid() {
    var gs = visibleGroups();
    renderedGroups = gs;
    var html = '';
    gs.forEach(function (g, i) {
      if (i === 7 || (i > 7 && (i - 7) % 12 === 0)) html += promoHtml();
      html += cardHtml(g);
    });
    els.grid.innerHTML = html;
    renderMeta(gs.length);
    renderStates(gs.length);
    if (state.view === 'map') renderMap(gs);
  }
  function renderMeta(n) {
    var where = state.citySlug === 'geo' ? 'near you' : 'near ' + state.cityName;
    var txt;
    if (state.savedView) txt = '<strong>' + n + '</strong> saved event' + (n === 1 ? '' : 's');
    else if (state.q) txt = '<strong>' + n + '</strong> result' + (n === 1 ? '' : 's') + ' for “' + esc(state.q) + '” ' + where;
    else txt = '<strong>' + n + (state.cursor ? '+' : '') + '</strong> things to do ' + where + ' · within ' + state.radius + ' mi';
    els.resultMeta.innerHTML = txt;
  }
  function renderStates(visibleCount) {
    els.stateBox.hidden = true;
    els.loadMoreWrap.hidden = true;
    if (state.loading && visibleCount === 0) return;
    if (state.error && visibleCount === 0) {
      els.stateBox.hidden = false;
      els.stateBox.innerHTML = '<div class="big">📡</div><h2>Couldn\'t load events</h2>' +
        '<p>Check your connection and try again.</p><button id="retryBtn">Retry</button>';
      var rb = document.getElementById('retryBtn');
      if (rb) rb.addEventListener('click', function () { resetAndLoad(); });
      return;
    }
    if (visibleCount === 0 && !state.loading) {
      els.stateBox.hidden = false;
      els.stateBox.innerHTML = state.savedView
        ? '<div class="big">💜</div><h2>No saved events yet</h2><p>Tap the heart on any event to keep it here.</p>'
        : '<div class="big">🦗</div><h2>Nothing matches right now</h2>' +
          '<p>Try a wider radius, a different day, or fewer filters.</p>';
      return;
    }
    if (!state.savedView && !state.q && state.cursor && !state.loading) els.loadMoreWrap.hidden = false;
  }

  // ---------- data loading ----------
  var loadToken = 0;
  function mergeRows(rows) {
    rows.forEach(function (r) {
      if (r && r.id && !state.rowIds[r.id]) { state.rowIds[r.id] = true; state.rows.push(r); }
    });
  }
  function visibleCount() {
    return visibleGroups().length;
  }
  function loadFeedPage(fetchesLeft) {
    var token = ++loadToken;
    state.loading = true;
    state.error = false;
    rest(feedQuery(state.cursor || null))
      .then(function (rows) {
        if (token !== loadToken) return;
        mergeRows(rows);
        state.cursor = rows.length >= PAGE && rows[rows.length - 1].start_time
          ? rows[rows.length - 1].start_time : null;
        var more = state.cursor && fetchesLeft > 1 && visibleCount() < FILL_TARGET;
        if (more) { renderGrid(); loadFeedPage(fetchesLeft - 1); }
        else { state.loading = false; renderGrid(); }
      })
      .catch(function () {
        if (token !== loadToken) return;
        state.loading = false; state.error = true;
        renderGrid();
      });
  }
  function loadSearch() {
    var token = ++loadToken;
    state.loading = true; state.error = false;
    rest(searchQuery(state.q))
      .then(function (rows) {
        if (token !== loadToken) return;
        state.rows = []; state.rowIds = {};
        mergeRows(rows);
        state.cursor = null; state.loading = false;
        renderGrid();
      })
      .catch(function () {
        if (token !== loadToken) return;
        state.loading = false; state.error = true; renderGrid();
      });
  }
  function loadSaved() {
    var token = ++loadToken;
    var ids = savedIds();
    state.rows = []; state.rowIds = {}; state.cursor = null;
    if (!ids.length) { state.loading = false; renderGrid(); return; }
    state.loading = true; state.error = false;
    rest(byIdsQuery(ids.slice(0, 200)))
      .then(function (rows) {
        if (token !== loadToken) return;
        mergeRows(rows); state.loading = false;
        renderGrid();
      })
      .catch(function () {
        if (token !== loadToken) return;
        state.loading = false; state.error = true; renderGrid();
      });
  }
  function resetAndLoad() {
    state.rows = []; state.rowIds = {}; state.cursor = undefined;
    els.grid.innerHTML = skeletonHtml();
    els.stateBox.hidden = true; els.loadMoreWrap.hidden = true;
    els.resultMeta.textContent = 'Loading events…';
    syncHash();
    if (state.savedView) loadSaved();
    else if (state.q) loadSearch();
    else loadFeedPage(MAX_FILL_FETCHES);
  }

  // In saved view radius doesn't apply — saved events may be anywhere.
  var origPasses = passesFilters;
  passesFilters = function (it, opts) {
    if (state.savedView) {
      var now = new Date();
      return !!(it.start && it.effEnd && it.effEnd > now && isSaved(it.id));
    }
    return origPasses(it, opts);
  };

  // ---------- detail ----------
  function findItem(id) {
    for (var i = 0; i < renderedGroups.length; i++) {
      if (renderedGroups[i].rep.id === id) return renderedGroups[i];
      var oth = renderedGroups[i].others;
      for (var j = 0; j < oth.length; j++) if (oth[j].id === id) return { rep: oth[j], others: [], dayCount: 1 };
    }
    for (var k = 0; k < state.rows.length; k++) {
      if (state.rows[k].id === id) return { rep: toItem(state.rows[k]), others: [], dayCount: 1 };
    }
    return null;
  }
  function detailHtml(group) {
    var it = group.rep, r = it.r;
    var grad = gradFor(it.primary);
    var img = safeUrl(r.image_url);
    var link = linkFor(r);
    var maps = 'https://maps.google.com/?q=' + encodeURIComponent([r.venue, r.address, r.city].filter(Boolean).join(', '));
    var badges = '';
    (it.slugs.length ? it.slugs : []).slice(0, 3).forEach(function (s) {
      var c = CAT_BY_SLUG[s];
      if (c) badges += '<span class="tag">' + c[2] + ' ' + esc(c[1]) + '</span>';
    });
    if (r.is_free === true) badges += '<span class="tag" style="color:#15803d;background:#e7f6ec">Free</span>';
    if (r.age_restriction && /^\d/.test(r.age_restriction)) badges += '<span class="tag" style="color:#b91c1c;background:#fdeaea">' + esc(r.age_restriction) + '</span>';
    if (r.is_featured === true) badges += '<span class="tag">✨ Featured</span>';

    var dateLine;
    if (it.cont) {
      dateLine = 'Daily' + (it.end ? ' · through ' + fmtDayLong.format(it.end) : ' · ongoing');
    } else {
      dateLine = fmtDayLong.format(it.start);
      if (it.allDay) dateLine += ' · All day';
      else if (it.dropIn) dateLine += ' · Drop in ' + fmtTime.format(it.start) + (it.end ? ' – ' + fmtTime.format(it.end) : '');
      else {
        dateLine += ' · ' + fmtTime.format(it.start);
        if (it.end && it.end - it.start < 14 * 3600e3) dateLine += ' – ' + fmtTime.format(it.end);
      }
    }

    var facts = '<li><span class="f-ico">🗓</span><span>' + esc(dateLine) + '</span></li>';
    var place = [r.venue, r.address].filter(Boolean).join(' · ') || r.city || '';
    if (place) facts += '<li><span class="f-ico">📍</span><span>' + esc(place) + ' &nbsp;<a href="' + esc(maps) + '" target="_blank" rel="noopener">Directions</a></span></li>';
    if (r.price_summary) facts += '<li><span class="f-ico">🎟</span><span>' + esc(r.price_summary) + '</span></li>';
    else if (r.is_free === true) facts += '<li><span class="f-ico">🎟</span><span>Free</span></li>';
    if (it.dist != null && !state.savedView) facts += '<li><span class="f-ico">🚗</span><span>' + it.dist.toFixed(1) + ' miles away</span></li>';

    var datesBlock = '';
    if (group.dayCount > 1) {
      var pills = '';
      var all = [it].concat(group.others).slice(0, 12);
      all.forEach(function (o) {
        pills += '<span class="dt-date-pill">' + esc(fmtDayShort.format(o.start)) +
          (o.allDay || o.cont ? '' : ' · ' + fmtTime.format(o.start)) + '</span>';
      });
      datesBlock = '<div class="dt-dates"><h3>More dates &amp; times</h3><div class="dt-date-pills">' + pills +
        (group.others.length > 11 ? '<span class="dt-date-pill">+ more in the app</span>' : '') + '</div></div>';
    }

    var descHtml = '';
    var desc = (r.description || '').trim();
    if (desc) {
      descHtml = '<div class="dt-desc">' + desc.split(/\n{2,}/).slice(0, 12).map(function (par) {
        return '<p>' + esc(par).replace(/\n/g, '<br>') + '</p>';
      }).join('') + '</div>';
    }
    var vibes = '';
    if (Array.isArray(r.vibe_tags) && r.vibe_tags.length) {
      vibes = '<div class="dt-vibes">' + r.vibe_tags.slice(0, 6).map(function (v) {
        return '<span class="tag t-dist">' + esc(v) + '</span>';
      }).join('') + '</div>';
    }

    return '<div class="dt-media" style="--g1:' + grad[0] + ';--g2:' + grad[1] + '">' +
        '<span class="fallback-emoji" aria-hidden="true">' + emojiFor(it.primary) + '</span>' +
        (img ? '<img src="' + esc(img) + '" alt="">' : '') +
        '<button class="dlg-close dt-close" data-close="detailDialog" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="dt-body">' +
        (badges ? '<div class="dt-badges">' + badges + '</div>' : '') +
        '<h2 class="dt-title">' + esc(r.title) + '</h2>' +
        (r.one_line_summary ? '<p class="dt-lede">' + esc(r.one_line_summary) + '</p>' : '') +
        '<ul class="dt-facts">' + facts + '</ul>' +
        '<div class="dt-actions">' +
          (link ? '<a class="dt-btn primary" href="' + esc(link) + '" target="_blank" rel="noopener">' + (safeUrl(r.ticket_url) ? 'Get tickets ↗' : 'Event website ↗') + '</a>' : '') +
          '<button class="dt-btn' + (isSaved(it.id) ? ' is-saved' : '') + '" data-heart="' + esc(it.id) + '" data-save-title="' + esc(r.title) + '">♥ <span>' + (isSaved(it.id) ? 'Saved' : 'Save') + '</span></button>' +
          '<div class="cal-menu"><button class="dt-btn" id="calBtn">📅 Calendar</button>' +
            '<div class="cal-pop" id="calPop" hidden>' +
              '<button data-cal="google">Google Calendar</button>' +
              '<button data-cal="ics">Apple / Outlook (.ics)</button>' +
            '</div></div>' +
          '<button class="dt-btn" id="shareBtn">↗ Share</button>' +
        '</div>' +
        datesBlock + descHtml + vibes +
        '<div class="dt-appcta"><p><strong>Take it with you.</strong> Save this in the Haps app and get a reminder before it starts.</p><a href="/beta">Get the app</a></div>' +
      '</div>';
  }
  var currentDetail = null;
  function openDetail(group, push) {
    currentDetail = group;
    els.detailBody.innerHTML = detailHtml(group);
    if (!els.detailDialog.open) els.detailDialog.showModal();
    els.detailDialog.scrollTop = 0;
    var body = els.detailDialog.querySelector('div');
    if (body) body.scrollTop = 0;
    if (push !== false) {
      var h = currentHash();
      h.e = group.rep.id;
      history.pushState(null, '', '#' + serializeHash(h));
    }
    wireDetail(group);
  }
  function wireDetail(group) {
    var it = group.rep, r = it.r;
    var calBtn = document.getElementById('calBtn');
    var calPop = document.getElementById('calPop');
    if (calBtn) calBtn.addEventListener('click', function (e) {
      e.stopPropagation(); calPop.hidden = !calPop.hidden;
    });
    if (calPop) calPop.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-cal]');
      if (!b) return;
      if (b.getAttribute('data-cal') === 'google') openGoogleCal(it);
      else downloadIcs(it);
      calPop.hidden = true;
    });
    var shareBtn = document.getElementById('shareBtn');
    if (shareBtn) shareBtn.addEventListener('click', function () { shareEvent(r); });
  }
  function openDetailById(id) {
    var g = findItem(id);
    if (g) { openDetail(g, false); return; }
    rest('/events?' + new URLSearchParams({
      select: SELECT, id: 'eq.' + id, is_hidden: 'eq.false', limit: '1'
    }).toString())
      .then(function (rows) {
        if (rows.length) openDetail({ rep: toItem(rows[0]), others: [], dayCount: 1 }, false);
        else toast('That event is no longer available');
      })
      .catch(function () { toast('Couldn\'t load that event'); });
  }
  function closeDetail() {
    if (els.detailDialog.open) els.detailDialog.close();
  }
  els.detailDialog.addEventListener('close', function () {
    currentDetail = null;
    var h = currentHash();
    if (h.e) { delete h.e; history.replaceState(null, '', '#' + serializeHash(h)); }
  });

  // ---------- calendar / share ----------
  function calDates(it) {
    var fmt = function (d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
    var end = it.end || new Date(it.start.getTime() + 2 * 3600e3);
    return fmt(it.start) + '/' + fmt(end);
  }
  function openGoogleCal(it) {
    var r = it.r;
    var u = 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
      '&text=' + encodeURIComponent(r.title || 'Event') +
      '&dates=' + calDates(it) +
      '&details=' + encodeURIComponent((r.one_line_summary || '') + '\n\nhttps://thehaps.app/event/' + r.id) +
      '&location=' + encodeURIComponent([r.venue, r.address, r.city].filter(Boolean).join(', '));
    window.open(u, '_blank', 'noopener');
  }
  function icsEsc(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  function downloadIcs(it) {
    var r = it.r;
    var d = calDates(it).split('/');
    var ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Haps//thehaps.app//EN', 'BEGIN:VEVENT',
      'UID:' + r.id + '@thehaps.app',
      'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''),
      'DTSTART:' + d[0], 'DTEND:' + d[1],
      'SUMMARY:' + icsEsc(r.title),
      'DESCRIPTION:' + icsEsc((r.one_line_summary || '') + '\nhttps://thehaps.app/event/' + r.id),
      'LOCATION:' + icsEsc([r.venue, r.address, r.city].filter(Boolean).join(', ')),
      'URL:https://thehaps.app/event/' + r.id,
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    a.download = 'haps-event.ics';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function shareEvent(r) {
    var url = 'https://thehaps.app/event/' + r.id;
    if (navigator.share) {
      navigator.share({ title: r.title || 'Haps event', url: url }).catch(function () { /* cancelled */ });
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () { toast('Link copied'); });
    } else {
      prompt('Copy this link:', url); // eslint-disable-line no-alert
    }
  }

  // ---------- map ----------
  var leafletReady = null, map = null, markerLayer = null;
  function loadLeaflet() {
    if (leafletReady) return leafletReady;
    leafletReady = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
    return leafletReady;
  }
  function renderMap(groups) {
    loadLeaflet().then(function () {
      var L = window.L;
      if (!map) {
        map = L.map('map');
        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
          maxZoom: 19
        }).addTo(map);
        markerLayer = L.layerGroup().addTo(map);
      }
      markerLayer.clearLayers();
      var pts = [];
      groups.slice(0, 400).forEach(function (g) {
        var r = g.rep.r;
        if (r.latitude == null || r.longitude == null) return;
        pts.push([r.latitude, r.longitude]);
        var m = window.L.circleMarker([r.latitude, r.longitude], {
          radius: 8, color: '#fff', weight: 2, fillColor: '#7c3aed', fillOpacity: .92
        }).addTo(markerLayer);
        m.bindPopup('<div class="map-pop"><p class="mp-title">' + esc(r.title) + '</p>' +
          '<p class="mp-meta">' + esc(whenLabel(g.rep)) + (r.venue ? ' · ' + esc(r.venue) : '') + '</p>' +
          '<button onclick="window.__hapsOpen(\'' + esc(r.id) + '\')">Details</button></div>');
      });
      map.invalidateSize();
      if (pts.length) map.fitBounds(pts, { padding: [36, 36], maxZoom: 14 });
      else map.setView([state.lat, state.lng], 11);
    }).catch(function () { toast('Map failed to load'); });
  }
  window.__hapsOpen = function (id) { openDetailById(id); };

  // ---------- hash routing ----------
  function currentHash() {
    var out = {};
    var raw = location.hash.replace(/^#/, '');
    if (!raw) return out;
    raw.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
    return out;
  }
  function serializeHash(h) {
    return Object.keys(h).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(h[k]);
    }).join('&');
  }
  function syncHash() {
    var h = {};
    if (state.citySlug === 'geo') h.city = 'geo:' + state.lat.toFixed(4) + ',' + state.lng.toFixed(4);
    else if (state.citySlug !== 'slc') h.city = state.citySlug;
    if (state.radius !== 25) h.r = String(state.radius);
    if (state.when !== 'all') h.when = state.when;
    var cats = Object.keys(state.cats);
    if (cats.length) h.cat = cats.join(',');
    if (state.freeOnly) h.free = '1';
    if (state.sort !== 'soonest') h.sort = state.sort;
    if (state.q) h.q = state.q;
    if (state.view !== 'grid') h.view = state.view;
    if (state.savedView) h.saved = '1';
    var cur = currentHash();
    if (cur.e) h.e = cur.e;
    var s = serializeHash(h);
    history.replaceState(null, '', s ? '#' + s : location.pathname);
  }
  function applyHash() {
    var h = currentHash();
    if (h.city) {
      var geo = h.city.match(/^geo:(-?[\d.]+),(-?[\d.]+)$/);
      if (geo) {
        state.citySlug = 'geo'; state.cityName = 'Near me';
        state.lat = parseFloat(geo[1]); state.lng = parseFloat(geo[2]);
      } else {
        var c = CITIES.find(function (x) { return x[0] === h.city; });
        if (c) { state.citySlug = c[0]; state.cityName = c[1]; state.lat = c[2]; state.lng = c[3]; }
      }
    }
    if (h.r && RADII.indexOf(+h.r) >= 0) state.radius = +h.r;
    if (h.when && ['today', 'tomorrow', 'weekend', 'week'].indexOf(h.when) >= 0) state.when = h.when;
    if (h.cat) h.cat.split(',').forEach(function (s) { if (CAT_BY_SLUG[s]) state.cats[s] = true; });
    if (h.free === '1') state.freeOnly = true;
    if (h.sort === 'trending') state.sort = 'trending';
    if (h.q) state.q = h.q;
    if (h.view === 'map') state.view = 'map';
    if (h.saved === '1') state.savedView = true;
    return h;
  }

  // ---------- view switching ----------
  function setView(v) {
    state.view = v;
    els.viewGrid.classList.toggle('is-on', v === 'grid');
    els.viewGrid.setAttribute('aria-pressed', String(v === 'grid'));
    els.viewMap.classList.toggle('is-on', v === 'map');
    els.viewMap.setAttribute('aria-pressed', String(v === 'map'));
    els.grid.hidden = v === 'map';
    els.mapWrap.hidden = v !== 'map';
    els.loadMoreWrap.hidden = els.loadMoreWrap.hidden || v === 'map';
    syncHash();
    if (v === 'map') renderMap(renderedGroups);
  }
  function setSavedView(on) {
    state.savedView = on;
    els.savedBtn.setAttribute('aria-pressed', String(on));
    els.savedNote.hidden = !on;
    els.heroband.style.display = on ? 'none' : '';
    els.filterbar.style.display = on ? 'none' : '';
    resetAndLoad();
  }

  // ---------- wiring ----------
  els.locChip.addEventListener('click', function () { renderCityList(); els.locDialog.showModal(); });
  document.addEventListener('click', function (e) {
    var closer = e.target.closest('[data-close]');
    if (closer) {
      var d = document.getElementById(closer.getAttribute('data-close'));
      if (d && d.open) d.close();
    }
    var pop = document.getElementById('calPop');
    if (pop && !pop.hidden && !e.target.closest('.cal-menu')) pop.hidden = true;
  });
  [els.locDialog, els.detailDialog].forEach(function (d) {
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
  });

  els.cityList && els.locDialog.addEventListener('click', function (e) {
    var cityBtn = e.target.closest('[data-city]');
    if (cityBtn) {
      var c = CITIES.find(function (x) { return x[0] === cityBtn.getAttribute('data-city'); });
      if (c) {
        state.citySlug = c[0]; state.cityName = c[1]; state.lat = c[2]; state.lng = c[3];
        renderLocUi(); els.locDialog.close(); resetAndLoad();
      }
      return;
    }
    var radBtn = e.target.closest('[data-radius]');
    if (radBtn) {
      state.radius = +radBtn.getAttribute('data-radius');
      renderCityList(); renderLocUi(); resetAndLoad();
    }
  });
  els.useGeo.addEventListener('click', function () {
    if (!navigator.geolocation) { toast('Location not supported here'); return; }
    els.useGeo.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      state.citySlug = 'geo'; state.cityName = 'Near me';
      state.lat = pos.coords.latitude; state.lng = pos.coords.longitude;
      els.useGeo.textContent = '🧭 Use my location';
      renderLocUi(); els.locDialog.close(); resetAndLoad();
    }, function () {
      els.useGeo.textContent = '🧭 Use my location';
      toast('Couldn\'t get your location');
    }, { timeout: 8000 });
  });

  els.timeChips.addEventListener('click', function (e) {
    var b = e.target.closest('[data-when]');
    if (!b) return;
    state.when = b.getAttribute('data-when');
    els.timeChips.querySelectorAll('[data-when]').forEach(function (x) {
      x.classList.toggle('is-on', x === b);
    });
    resetAndLoad();
  });
  els.freeChip.addEventListener('click', function () {
    state.freeOnly = !state.freeOnly;
    els.freeChip.classList.toggle('is-on', state.freeOnly);
    els.freeChip.setAttribute('aria-pressed', String(state.freeOnly));
    resetAndLoad();
  });
  els.catChips.addEventListener('click', function (e) {
    var b = e.target.closest('[data-cat]');
    if (!b) return;
    var slug = b.getAttribute('data-cat');
    if (state.cats[slug]) delete state.cats[slug]; else state.cats[slug] = true;
    b.classList.toggle('is-on', !!state.cats[slug]);
    // category filtering is client-side (matches the app); no refetch needed
    syncHash(); renderGrid();
    maybeAutoFill();
  });
  function maybeAutoFill() {
    if (!state.savedView && !state.q && state.cursor && visibleCount() < FILL_TARGET && !state.loading) {
      loadFeedPage(2);
    }
  }
  els.sortSel.addEventListener('change', function () {
    state.sort = els.sortSel.value;
    syncHash(); renderGrid();
  });
  els.viewGrid.addEventListener('click', function () { setView('grid'); });
  els.viewMap.addEventListener('click', function () { setView('map'); });
  els.savedBtn.addEventListener('click', function () { setSavedView(!state.savedView); });
  els.loadMoreBtn.addEventListener('click', function () { if (state.cursor) loadFeedPage(1); });

  // search
  var searchTimer = null;
  els.searchInput.addEventListener('input', function () {
    var v = els.searchInput.value.trim();
    els.searchClear.hidden = !v;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      var q = v.length >= 2 ? v : '';
      if (q === state.q) return;
      state.q = q;
      if (state.savedView) setSavedView(false); else resetAndLoad();
    }, 350);
  });
  els.searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      var v = els.searchInput.value.trim();
      state.q = v.length >= 2 ? v : '';
      resetAndLoad();
    }
  });
  els.searchClear.addEventListener('click', function () {
    els.searchInput.value = ''; els.searchClear.hidden = true;
    if (state.q) { state.q = ''; resetAndLoad(); }
    els.searchInput.focus();
  });

  // card clicks (delegated)
  els.grid.addEventListener('click', function (e) {
    var heart = e.target.closest('[data-heart]');
    if (heart) {
      e.stopPropagation();
      var id = heart.getAttribute('data-heart');
      var g = findItem(id);
      toggleSave(id, g ? g.rep.r.title : '');
      if (state.savedView && !isSaved(id)) renderGrid();
      return;
    }
    var card = e.target.closest('.card[data-id]');
    if (card) {
      var grp = findItem(card.getAttribute('data-id'));
      if (grp) openDetail(grp);
    }
  });
  els.grid.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var card = e.target.closest('.card[data-id]');
    if (card) {
      e.preventDefault();
      var grp = findItem(card.getAttribute('data-id'));
      if (grp) openDetail(grp);
    }
  });
  // detail dialog save button (delegated — body is re-rendered per open)
  els.detailBody.addEventListener('click', function (e) {
    var heart = e.target.closest('[data-heart]');
    if (heart) toggleSave(heart.getAttribute('data-heart'), heart.getAttribute('data-save-title') || '');
  });

  // infinite scroll
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && !state.loading && state.cursor && !state.q && !state.savedView && state.view === 'grid') {
        loadFeedPage(1);
      }
    }, { rootMargin: '600px' }).observe(els.sentinel);
  }

  // back/forward: open or close the detail dialog to match the hash
  window.addEventListener('popstate', function () {
    var h = currentHash();
    if (h.e) openDetailById(h.e);
    else closeDetail();
  });

  // app banner
  try {
    if (!sessionStorage.getItem('hapsBannerHid')) els.appBanner.hidden = false;
  } catch (e) { els.appBanner.hidden = false; }
  els.bannerClose.addEventListener('click', function () {
    els.appBanner.hidden = true;
    try { sessionStorage.setItem('hapsBannerHid', '1'); } catch (e) { /* ok */ }
  });

  // keep the filter bar pinned right below the real topbar height
  function setTopbarVar() {
    document.documentElement.style.setProperty('--topbar-h',
      document.querySelector('.topbar').offsetHeight + 'px');
  }
  window.addEventListener('resize', setTopbarVar);
  setTopbarVar();

  // ---------- init ----------
  var initialHash = applyHash();
  renderCatChips();
  renderLocUi();
  els.sortSel.value = state.sort;
  els.freeChip.classList.toggle('is-on', state.freeOnly);
  els.freeChip.setAttribute('aria-pressed', String(state.freeOnly));
  els.timeChips.querySelectorAll('[data-when]').forEach(function (x) {
    x.classList.toggle('is-on', x.getAttribute('data-when') === state.when);
  });
  if (state.q) { els.searchInput.value = state.q; els.searchClear.hidden = false; }
  refreshSaveUi();
  if (state.savedView) {
    els.savedBtn.setAttribute('aria-pressed', 'true');
    els.savedNote.hidden = false;
    els.heroband.style.display = 'none';
    els.filterbar.style.display = 'none';
  }
  if (state.view === 'map') setView('map');
  resetAndLoad();
  if (initialHash.e) openDetailById(initialHash.e);
})();
