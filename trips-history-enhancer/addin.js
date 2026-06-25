/**
 * Trips History Enhancer — MyGeotab Button Add-in v4
 * Target: 11.130.494-0c2376cea2b9
 *
 * Auto-initializes by intercepting MyGeotab's own fetch/XHR calls to capture
 * session credentials and trip data — no button click required.
 *
 * Features:
 *   1. Second-precision timestamps on stop/zone/driving hover tooltips
 *   2. Address search → draggable OpenStreetMap mini-map overlay
 */
(function () {
  'use strict';

  // ── Session & trip storage ───────────────────────────────────────────────────
  let _creds      = null;   // { sessionId, database, userName }
  let _serverBase = null;   // e.g. "https://app.geotab.com"

  // Raw trips keyed "deviceId|dateStr" → array of trip objects (ISO strings)
  const _rawTrips = {};

  // Built timeMaps keyed "deviceId|dateStr|tz" → { "HH:MM": "HH:MM:SS" }
  const _timeMaps = {};

  // ── Fetch / XHR interception ─────────────────────────────────────────────────
  // The add-in iframe is same-origin with the parent. We patch both windows so we
  // capture MyGeotab's first authenticated API call regardless of which context
  // initiates it. All original behaviour is preserved — we only read, never modify.

  function onApiRequest(urlStr, body) {
    try {
      const req  = JSON.parse(body);
      const p    = req && req.params;
      if (!p) return;

      // Capture session credentials from any API call.
      if (!_creds && p.credentials && p.credentials.sessionId) {
        _creds      = p.credentials;
        _serverBase = urlStr.split('/apiv1')[0];
        console.log('[TripsEnhancer] Session captured');
      }
    } catch (_) {}
  }

  function onApiResponse(urlStr, body, resData) {
    try {
      const req = JSON.parse(body);
      const p   = req && req.params;
      if (!p || p.typeName !== 'Trip') return;

      const trips = resData && resData.result;
      if (!Array.isArray(trips) || !trips.length) return;

      const search   = p.search;
      const deviceId = search && search.deviceSearch && search.deviceSearch.id;
      const fromDate = search && search.fromDate;
      if (!deviceId || !fromDate) return;

      const dateStr = new Date(fromDate).toDateString();
      const cacheKey = `${deviceId}|${dateStr}`;
      if (!_rawTrips[cacheKey]) {
        _rawTrips[cacheKey] = trips;
        console.log(`[TripsEnhancer] Cached ${trips.length} trips for ${cacheKey}`);
      }
    } catch (_) {}
  }

  function patchFetch(win) {
    try {
      const orig = win.fetch;
      win.fetch = function (input, init) {
        const url  = typeof input === 'string' ? input : (input && input.url) || '';
        const body = init && init.body;
        if (body && url.includes('/apiv1')) {
          onApiRequest(url, body);
          const p = orig.apply(win, arguments);
          p.then(r => r.clone().json().then(d => onApiResponse(url, body, d)).catch(() => {})).catch(() => {});
          return p;
        }
        return orig.apply(win, arguments);
      };
    } catch (_) {}
  }

  function patchXHR(win) {
    try {
      const proto    = win.XMLHttpRequest.prototype;
      const origOpen = proto.open;
      const origSend = proto.send;
      proto.open = function (m, url) { this._triUrl = url; return origOpen.apply(this, arguments); };
      proto.send = function (body) {
        if (body && this._triUrl && this._triUrl.includes('/apiv1')) {
          const url = this._triUrl;
          onApiRequest(url, body);
          this.addEventListener('load', () => {
            try { onApiResponse(url, body, JSON.parse(this.responseText)); } catch (_) {}
          });
        }
        return origSend.apply(this, arguments);
      };
    } catch (_) {}
  }

  // Patch immediately — before any MyGeotab React component mounts and fires requests.
  patchFetch(window);
  patchXHR(window);
  try { patchFetch(window.parent); } catch (_) {}
  try { patchXHR(window.parent);  } catch (_) {}

  // ── Device ID detection ──────────────────────────────────────────────────────
  // Primary: parse from URL hash (same-origin parent location is readable).
  // Fallback: use whichever device we have cached trip data for.

  function getDeviceId() {
    try {
      const hash = window.parent.location.hash || window.location.hash || '';
      // Handles both "device:(id:b123)" and "device:b123" hash formats.
      const m = hash.match(/[Dd]evice[:(]+id:([^),\s]+)/);
      if (m) return m[1];
    } catch (_) {}
    // Fall back to first captured device key.
    const first = Object.keys(_rawTrips)[0];
    return first ? first.split('|')[0] : null;
  }

  // ── Time formatting ──────────────────────────────────────────────────────────

  function pad2(n) { return String(n).padStart(2, '0'); }

  function toTZParts(isoStr, tz) {
    try {
      const fmt  = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tz });
      const p    = Object.fromEntries(fmt.formatToParts(new Date(isoStr)).map(x => [x.type, x.value]));
      const h    = p.hour === '24' ? '00' : p.hour;
      return { key: `${h}:${p.minute}`, hhmmss: `${h}:${p.minute}:${p.second}` };
    } catch (_) {
      const d = new Date(isoStr);
      const h = pad2(d.getHours()), mi = pad2(d.getMinutes()), s = pad2(d.getSeconds());
      return { key: `${h}:${mi}`, hhmmss: `${h}:${mi}:${s}` };
    }
  }

  function getTimeMap(deviceId, dateStr, tz) {
    const mk = `${deviceId}|${dateStr}|${tz}`;
    if (_timeMaps[mk]) return _timeMaps[mk];

    const trips = _rawTrips[`${deviceId}|${dateStr}`];
    if (!trips) return null;

    const map = {};
    trips.forEach(trip => {
      ['Start', 'Stop', 'NextTripStart'].forEach(field => {
        if (!trip[field]) return;
        const { key, hhmmss } = toTZParts(trip[field], tz);
        if (!map[key]) map[key] = hhmmss;
      });
    });
    _timeMaps[mk] = map;
    return map;
  }

  // Fetch from API ourselves if we captured credentials but not this day's trips.
  async function ensureTrips(deviceId, date) {
    const dateStr = date.toDateString();
    if (_rawTrips[`${deviceId}|${dateStr}`]) return;
    if (!_creds || !_serverBase) return;

    const from = new Date(date); from.setHours(0, 0, 0, 0);
    const to   = new Date(date); to.setHours(23, 59, 59, 999);
    try {
      const res  = await fetch(`${_serverBase}/apiv1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'Get', params: {
          typeName: 'Trip',
          search: { deviceSearch: { id: deviceId }, fromDate: from.toISOString(), toDate: to.toISOString() },
          credentials: _creds,
        }}),
      });
      const data = await res.json();
      if (data.result) _rawTrips[`${deviceId}|${dateStr}`] = data.result;
    } catch (e) { console.error('[TripsEnhancer] Trip fetch error:', e); }
  }

  // ── Tooltip upgrade ──────────────────────────────────────────────────────────

  const TIME_RE       = /\b\d{1,2}:\d{2}\b/;
  const TIME_RE_NOSEC = /\b(\d{1,2}):(\d{2})\b(?!:\d{2})/g;
  const TIME_RE_12H   = /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi;
  const TZ_RE         = /\(([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\)/;
  const DATE_RE       = /\b(\d{2})\/(\d{2})\/(\d{2})\b/;

  function extractTZ(text)   { const m = text.match(TZ_RE);   return m ? m[1] : Intl.DateTimeFormat().resolvedOptions().timeZone; }
  function extractDate(text) { const m = text.match(DATE_RE); if (m) { const d = new Date(`20${m[3]}-${m[1]}-${m[2]}`); if (!isNaN(d)) return d; } return new Date(); }

  async function upgradeEl(el) {
    const text = el.textContent || '';
    if (!TIME_RE.test(text)) return;

    const tz       = extractTZ(text);
    const date     = extractDate(text);
    const dateStr  = date.toDateString();
    const deviceId = getDeviceId();
    if (!deviceId) return;

    await ensureTrips(deviceId, date);
    const timeMap = getTimeMap(deviceId, dateStr, tz);
    if (!timeMap || !Object.keys(timeMap).length) return;

    const tw = (el.ownerDocument || document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = tw.nextNode())) {
      let val = node.nodeValue;
      // Replace 12-hour times first
      val = val.replace(TIME_RE_12H, (match, hStr, mStr, ampm) => {
        let h = parseInt(hStr, 10);
        if (ampm.toLowerCase() === 'pm' && h < 12) h += 12;
        if (ampm.toLowerCase() === 'am' && h === 12) h = 0;
        return timeMap[`${pad2(h)}:${mStr}`] || match;
      });
      // Replace remaining 24-hour times (skips already-upgraded HH:mm:ss)
      val = val.replace(TIME_RE_NOSEC, (match, hStr, mStr) => timeMap[`${pad2(parseInt(hStr,10))}:${mStr}`] || match);
      if (val !== node.nodeValue) node.nodeValue = val;
      TIME_RE_12H.lastIndex = 0;
      TIME_RE_NOSEC.lastIndex = 0;
    }
  }

  // ── Observer setup ───────────────────────────────────────────────────────────

  function handleMouseover(e) {
    const t = e.target;
    if (!t || t.nodeType !== Node.ELEMENT_NODE || !TIME_RE.test(t.textContent)) return;
    let el = t;
    for (let i = 0; i < 8; i++) {
      const p = el.parentElement;
      if (!p || p.tagName === 'BODY' || p.tagName === 'HTML') break;
      el = p;
      if (el.children.length >= 2 && TIME_RE.test(el.textContent)) break;
    }
    upgradeEl(el).catch(() => {});
  }

  function attachTo(doc) {
    try {
      doc.addEventListener('mouseover', handleMouseover, { capture: true, passive: true });
      new MutationObserver(muts => {
        for (const mut of muts)
          for (const node of mut.addedNodes)
            if (node.nodeType === Node.ELEMENT_NODE && TIME_RE.test(node.textContent))
              upgradeEl(node).catch(() => {});
      }).observe(doc.body, { childList: true, subtree: true });
    } catch (_) {}
  }

  function init() {
    attachTo(document);
    try { const pd = window.parent.document; if (pd !== document) attachTo(pd); } catch (_) {}
    tryInjectSearch(30);
  }

  // ── Minimap ──────────────────────────────────────────────────────────────────

  const MINIMAP_ID = 'gia-trips-enhancer-minimap';

  function showMiniMap(lat, lng, label) {
    const existing = document.getElementById(MINIMAP_ID);
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = MINIMAP_ID;
    panel.style.cssText = 'position:fixed;top:80px;right:24px;width:380px;height:320px;background:#fff;border:1px solid #bbb;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.25);display:flex;flex-direction:column;z-index:99999;font-family:sans-serif;';

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#0078d4;color:#fff;border-radius:6px 6px 0 0;cursor:move;user-select:none;font-size:12px;gap:8px;';

    const titleEl = document.createElement('span');
    titleEl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
    titleEl.title = label;
    titleEl.textContent = label.split(',').slice(0, 2).join(',');

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:none;color:#fff;cursor:pointer;font-size:14px;padding:0 2px;';
    closeBtn.addEventListener('click', () => panel.remove());

    bar.appendChild(titleEl);
    bar.appendChild(closeBtn);

    const delta = 0.01;
    const frame = document.createElement('iframe');
    frame.src   = `https://www.openstreetmap.org/export/embed.html?bbox=${lng-delta},${lat-delta},${lng+delta},${lat+delta}&layer=mapnik&marker=${lat},${lng}`;
    frame.style.cssText = 'flex:1;border:none;border-radius:0 0 6px 6px;';

    panel.appendChild(bar);
    panel.appendChild(frame);
    document.body.appendChild(panel);

    let dragging = false, ox = 0, oy = 0;
    bar.addEventListener('mousedown', e => { dragging = true; const r = panel.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (!dragging) return; panel.style.left = (e.clientX - ox) + 'px'; panel.style.top = (e.clientY - oy) + 'px'; panel.style.right = 'auto'; });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ── Geocoding ────────────────────────────────────────────────────────────────

  async function geocode(query) {
    const res  = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q: query, format: 'json', limit: '1' }), {
      headers: { 'Accept-Language': 'en', 'User-Agent': 'GeotabTripsHistoryEnhancer/4.0 (michaelolsen@geotab.com)' },
    });
    const data = await res.json();
    if (!data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), label: data[0].display_name };
  }

  // ── Search widget ─────────────────────────────────────────────────────────────

  const WIDGET_ID = 'gia-trips-enhancer-search';

  const SEL_TOOLBAR = ['.page-action-bar','.trips-history-toolbar','.action-bar','.toolbar-container','[class*="actionBar"]','[class*="toolbar"]'].join(', ');

  function buildSearchWidget() {
    const wrap = document.createElement('div');
    wrap.id = WIDGET_ID;
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:14px;vertical-align:middle;';
    wrap.innerHTML = `
      <input id="${WIDGET_ID}-input" type="text" placeholder="Search address…"
        style="padding:3px 8px;border:1px solid #bbb;border-radius:3px;font-size:13px;width:215px;height:28px;box-sizing:border-box;" />
      <button id="${WIDGET_ID}-btn"
        style="padding:0 11px;height:28px;background:#0078d4;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:13px;">Go</button>
      <span id="${WIDGET_ID}-status"
        style="font-size:12px;color:#555;max-width:175px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title=""></span>`;

    const input  = wrap.querySelector(`#${WIDGET_ID}-input`);
    const btn    = wrap.querySelector(`#${WIDGET_ID}-btn`);
    const status = wrap.querySelector(`#${WIDGET_ID}-status`);

    async function run() {
      const q = input.value.trim();
      if (!q) return;
      status.textContent = 'Searching…'; btn.disabled = true;
      try {
        const r = await geocode(q);
        if (r) { status.title = r.label; status.textContent = '✓ Found'; showMiniMap(r.lat, r.lng, r.label); }
        else status.textContent = 'No results';
      } catch (e) { status.textContent = 'Error'; console.error('[TripsEnhancer]', e); }
      finally { btn.disabled = false; }
    }

    btn.addEventListener('click', run);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    return wrap;
  }

  function tryInjectSearch(n) {
    if (document.getElementById(WIDGET_ID)) return;
    const tb = document.querySelector(SEL_TOOLBAR);
    if (tb) { tb.appendChild(buildSearchWidget()); return; }
    if (n > 0) setTimeout(() => tryInjectSearch(n - 1), 400);
  }

  // ── Button entry point (required by MyGeotab to load this script) ────────────
  // The button itself does nothing — auto-init via fetch interception handles everything.

  geotab.customButtons['Trips+'] = function (event, api, state) {
    console.log('[TripsEnhancer] Button clicked. Credentials captured:', !!_creds, '| Trips cached:', Object.keys(_rawTrips).length);
  };

  // ── Boot ─────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}());
