/* Haps events widget — https://thehaps.app/embed/
 *
 * Embed code:
 *   <div class="haps-widget" data-city="salt-lake-city" data-list="this-weekend" data-count="5">
 *     <a href="https://thehaps.app/events/salt-lake-city/this-weekend/">Things to do in Salt Lake City this weekend</a>
 *     · events by <a href="https://thehaps.app/">Haps</a>
 *   </div>
 *   <script async src="https://thehaps.app/embed/v1/widget.js"></script>
 *
 * The links inside the div are the no-JS fallback AND stay visible under the
 * list (slotted into the shadow root), so the host page always carries plain
 * HTML links to thehaps.app. The list renders in a shadow root so host CSS
 * can't break it. Data: static nightly JSON at /embed/v1/{city}/{list}.json
 * (no Supabase calls from host pages).
 *
 * Options (data-*): city (required), list (default "all"; any list in
 * /embed/v1/index.json), count 1–10 (default 5), theme light|dark|auto
 * (default light), title (override heading), images 0|1 (default 1).
 * A seasonal list that has gone away falls back to the city's "all" feed.
 */
(function () {
  'use strict';
  var BASE = 'https://thehaps.app';
  try {
    var me = document.currentScript && document.currentScript.src;
    // Same-origin testing (localhost builds): read feeds from where the script came from.
    if (me && !/^https:\/\/thehaps\.app\//.test(me)) BASE = me.replace(/\/embed\/v1\/widget\.js.*$/, '');
  } catch (e) { /* keep default */ }

  var CSS = [
    ':host{all:initial;display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
    '--bg:#fff;--ink:#17171a;--muted:#6b6b72;--line:#e6e5e1;--brand:#5530d8;--sunk:#f2f1ee;--mark:#ffe14d;color:var(--ink)}',
    ':host([data-theme-resolved=dark]){--bg:#1c1c1f;--ink:#f3f3f1;--muted:#a3a3aa;--line:#34343a;--brand:#a996ff;--sunk:#28282c}',
    '.w{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:14px 16px 10px;max-width:100%;box-sizing:border-box}',
    'h3{margin:0 0 10px;font-size:16px;line-height:1.25;font-weight:750;color:var(--ink)}',
    'h3 a{color:inherit;text-decoration:none}h3 a:hover{text-decoration:underline}',
    'ol{list-style:none;margin:0;padding:0}',
    'li{border-top:1px solid var(--line)}li:first-child{border-top:0}',
    'li a{display:flex;gap:12px;align-items:center;padding:9px 0;color:inherit;text-decoration:none}',
    'li a:hover .t{text-decoration:underline}',
    '.img{flex:0 0 56px;width:56px;height:56px;border-radius:6px;object-fit:cover;background:var(--sunk)}',
    '.b{min-width:0;display:flex;flex-direction:column;gap:2px}',
    '.d{font-size:12px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:var(--brand)}',
    '.t{font-size:15px;line-height:1.3;font-weight:650;color:var(--ink);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '.v{font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;background:var(--mark);color:#17171a;font-size:11px;font-weight:700;vertical-align:1px;text-transform:none;letter-spacing:0}',
    '.more{display:block;margin:8px 0 4px;font-size:14px;font-weight:650;color:var(--brand);text-decoration:none}.more:hover{text-decoration:underline}',
    '.by{display:block;margin-top:6px;padding-top:8px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}',
    '.empty{font-size:14px;color:var(--muted);padding:6px 0}'
  ].join('');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtWhen(it) {
    var d = new Date(it.s), tz = it.tz || 'America/Denver';
    try {
      var day = d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
      if (it.ad) return day;
      return day + ' · ' + d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    } catch (e) { return d.toDateString(); }
  }

  function getJSON(url) {
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }

  function render(host, data, opts) {
    var root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    root.textContent = '';
    var style = el('style'); style.textContent = CSS; root.appendChild(style);
    var w = el('div', 'w');
    var h = el('h3'), ha = el('a', null, opts.title || data.title);
    ha.href = data.url; ha.target = '_blank'; ha.rel = 'noopener';
    h.appendChild(ha); w.appendChild(h);

    // Feeds are rebuilt nightly; skip anything that already started today
    // more than 6h ago (multi-day all-day items stay).
    var now = Date.now();
    var items = (data.items || []).filter(function (it) {
      return it.ad || new Date(it.s).getTime() > now - 6 * 3600e3;
    }).slice(0, opts.count);

    if (!items.length) {
      w.appendChild(el('div', 'empty', 'Nothing listed right now — check back soon.'));
    } else {
      var ol = el('ol');
      items.forEach(function (it) {
        var li = el('li'), a = el('a');
        a.href = BASE + '/event/' + it.id + '/';
        a.target = '_blank'; a.rel = 'noopener';
        if (opts.images) {
          if (it.img) {
            var img = el('img', 'img'); img.src = it.img; img.alt = ''; img.loading = 'lazy';
            img.onerror = function () { this.replaceWith(el('span', 'img')); };
            a.appendChild(img);
          } else a.appendChild(el('span', 'img'));
        }
        var b = el('span', 'b');
        var d = el('span', 'd', fmtWhen(it));
        if (it.free) d.appendChild(el('span', 'tag', 'Free'));
        b.appendChild(d);
        b.appendChild(el('span', 't', it.t));
        var v = [it.v, it.c].filter(Boolean).join(' · ');
        if (v) b.appendChild(el('span', 'v', v));
        a.appendChild(b); li.appendChild(a); ol.appendChild(li);
      });
      w.appendChild(ol);
    }
    if (data.total > items.length) {
      var more = el('a', 'more', 'See all ' + data.total + ' →');
      more.href = data.url; more.target = '_blank'; more.rel = 'noopener';
      w.appendChild(more);
    }
    // The embed's own light-DOM links (the backlink) show here.
    var by = el('span', 'by'); by.appendChild(el('slot'));
    w.appendChild(by);
    root.appendChild(w);
  }

  function resolveTheme(host, t) {
    var dark = t === 'dark' || (t === 'auto' && window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
    host.setAttribute('data-theme-resolved', dark ? 'dark' : 'light');
  }

  function mount(host) {
    if (host.__haps) return;
    host.__haps = true;
    var ds = host.dataset;
    var city = (ds.city || '').replace(/[^a-z0-9-]/g, '');
    if (!city) return;
    var list = (ds.list || 'all').replace(/[^a-z0-9-]/g, '') || 'all';
    var count = Math.max(1, Math.min(10, parseInt(ds.count, 10) || 5));
    var opts = { count: count, title: ds.title || '', images: ds.images !== '0' };
    resolveTheme(host, ds.theme || 'light');
    var feed = function (l) { return BASE + '/embed/v1/' + city + '/' + l + '.json'; };
    getJSON(feed(list))
      .catch(function () { return list === 'all' ? Promise.reject() : getJSON(feed('all')); })
      .then(function (data) { render(host, data, opts); })
      .catch(function () { /* leave the plain links in place */ });
  }

  function scan() {
    var nodes = document.querySelectorAll('.haps-widget');
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
  window.HapsWidget = { scan: scan, mount: function (n) { n.__haps = false; mount(n); } };
})();
