/**
 * Trips History Enhancer — MyGeotab Button Add-in v5
 * Target: 11.130.494-0c2376cea2b9
 *
 * Uses the documented geotab.customButtons mechanism for api/state.
 * Auto-clicks our own toolbar button after the page renders so the user
 * never has to interact with it manually.
 *
 * Features:
 *   1. Second-precision timestamps on all stop/zone/driving hover tooltips
 *   2. Address search → draggable OpenStreetMap mini-map overlay
 */
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────────
  let _api         = null;
  let _state       = null;
  let _initialized = false;

  // Raw trips:  "deviceId|dateStr"    → Trip[]
  // Time maps:  "deviceId|dateStr|tz" → { "HH:MM": "HH:MM:SS" }
  const _rawTrips = {};
  const _timeMaps = {};

  // ── Entry point called by MyGeotab when button is clicked ────────────────────
  // We auto-click the button after page load so this fires without user action.

  geotab.customButtons['Trips+'] = function (event, api, state) {
    _api   = api;
    _state = state;
    if (!_initialized) {
      _initialized = true;
      onReady();
    }
  };

  // ── Initialization ───────────────────────────────────────────────────────────

  function onReady() {
    attachTo(document);
    try { const pd = window.parent.document; if (pd !== document) attachTo(pd); } catch (_) {}
    prefetch();
    tryInjectSearch(30);
  }

  // ── Pre-fetch trips so cache is warm before first hover ──────────────────────

  function prefetch() {
    if (!_api || !_state) return;
    try {
      const st       = _state.getState ? _state.getState() : {};
      const deviceId = (st.device && (st.device.id || st.device)) || st.deviceId;
      const dateRaw  = (st.dates && st.dates[0]) || st.date || st.fromDate;
      if (deviceId && dateRaw) fetchTrips(deviceId, new Date(dateRaw)).catch(() => {});
    } catch (_) {}
  }

  function fetchTrips(deviceId, date) {
    const dateStr = date.toDateString();
    if (_rawTrips[`${deviceId}|${dateStr}`]) return Promise.resolve();

    const from = new Date(date); from.setHours(0, 0, 0, 0);
    const to   = new Date(date); to.setHours(23, 59, 59, 999);

    return new Promise(resolve => {
      _api.call('Get', {
        typeName: 'Trip',
        search: { deviceSearch: { id: deviceId }, fromDate: from.toISOString(), toDate: to.toISOString() },
      }, trips => {
        if (trips && trips.length) {
          _rawTrips[`${deviceId}|${dateStr}`] = trips;
          console.log(`[TripsEnhancer] Cached ${trips.length} trips for ${deviceId} on ${dateStr}`);
        }
        resolve();
      }, err => { console.error('[TripsEnhancer] Trip fetch error:', err); resolve(); });
    });
  }

  // ── Device / date helpers ────────────────────────────────────────────────────

  function getDeviceId() {
    // Primary: live state (always reflects current selection).
    try {
      const st = _state && _state.getState ? _state.getState() : {};
      const id = (st.device && (st.device.id || st.device)) || st.deviceId;
      if (id) return id;
    } catch (_) {}
    // Fallback: URL hash.
    try {
      const hash = window.parent.location.hash || window.location.hash || '';
      const m    = hash.match(/[Dd]evice[:(]+id:([^),\s]+)/);
      if (m) return m[1];
    } catch (_) {}
    // Last resort: first captured key.
    const first = Object.keys(_rawTrips)[0];
    return first ? first.split('|')[0] : null;
  }

  // ── Time formatting ──────────────────────────────────────────────────────────

  function pad2(n) { return String(n).padStart(2, '0'); }

  function toTZParts(isoStr, tz) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tz });
      const p   = Object.fromEntries(fmt.formatToParts(new Date(isoStr)).map(x => [x.type, x.value]));
      const h   = p.hour === '24' ? '00' : p.hour;
      return { key: `${h}:${p.minute}`, hhmmss: `${h}:${p.minute}:${p.second}` };
    } catch (_) {
      const d = new Date(isoStr);
      const h = pad2(d.getHours()), mi = pad2(d.getMinutes()), s = pad2(d.getSeconds());
      return { key: `${h}:${mi}`, hhmmss: `${h}:${mi}:${s}` };
    }
  }

  function buildTimeMap(trips, tz) {
    const map = {};
    trips.forEach(trip => {
      ['Start', 'Stop', 'NextTripStart'].forEach(field => {
        if (!trip[field]) return;
        const { key, hhmmss } = toTZParts(trip[field], tz);
        if (!map[key]) map[key] = hhmmss;
      });
    });
    return map;
  }

  function getTimeMap(deviceId, dateStr, tz) {
    const mk = `${deviceId}|${dateStr}|${tz}`;
    if (_timeMaps[mk]) return _timeMaps[mk];
    const trips = _rawTrips[`${deviceId}|${dateStr}`];
    if (!trips) return null;
    return (_timeMaps[mk] = buildTimeMap(trips, tz));
  }

  // ── Tooltip upgrade ──────────────────────────────────────────────────────────

  const TIME_RE       = /\b\d{1,2}:\d{2}\b/;
  const TIME_RE_NOSEC = /\b(\d{1,2}):(\d{2})\b(?!:\d{2})/g;
  const TIME_RE_12H   = /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi;
  const TZ_RE         = /\(([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\)/;
  const DATE_RE       = /\b(\d{2})\/(\d{2})\/(\d{2})\b/;

  function extractTZ(text)   { const m = text.match(TZ_RE);   return m ? m[1] : Intl.DateTimeFormat().resolvedOptions().timeZone; }
  function extractDate(text) { const m = text.match(DATE_RE); if (m) { const d = new Date(`20${m[3]}-${m[1]}-${m[2]}`); if (!isNaN(d)) return d; } return new Date(); }

  function applyTimeMap(el, timeMap) {
    const tw = (el.ownerDocument || document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = tw.nextNode())) {
      let val = node.nodeValue;
      val = val.replace(TIME_RE_12H, (match, hStr, mStr, ampm) => {
        let h = parseInt(hStr, 10);
        if (ampm.toLowerCase() === 'pm' && h < 12) h += 12;
        if (ampm.toLowerCase() === 'am' && h === 12) h = 0;
        return timeMap[`${pad2(h)}:${mStr}`] || match;
      });
      val = val.replace(TIME_RE_NOSEC, (match, hStr, mStr) => timeMap[`${pad2(parseInt(hStr, 10))}:${mStr}`] || match);
      if (val !== node.nodeValue) node.nodeValue = val;
      TIME_RE_12H.lastIndex = 0;
      TIME_RE_NOSEC.lastIndex = 0;
    }
  }

  async function upgradeEl(el) {
    const text = el.textContent || '';
    if (!TIME_RE.test(text)) return;

    const tz       = extractTZ(text);
    const date     = extractDate(text);
    const dateStr  = date.toDateString();
    const deviceId = getDeviceId();
    if (!deviceId) return;

    // Fast path: synchronous if cache is warm — no visible flash.
    const cached = getTimeMap(deviceId, dateStr, tz);
    if (cached) { applyTimeMap(el, cached); return; }

    // Slow path: fetch then apply (first hover on an uncached day).
    await fetchTrips(deviceId, date);
    const timeMap = getTimeMap(deviceId, dateStr, tz);
    if (timeMap) applyTimeMap(el, timeMap);
  }

  // ── Observers ────────────────────────────────────────────────────────────────

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

  // ── Auto-click ───────────────────────────────────────────────────────────────
  // Find our own "Trips+" button in the parent DOM and click it so MyGeotab
  // calls geotab.customButtons['Trips+'] with real api + state automatically.

  function tryAutoClick(n) {
    if (_initialized) return;
    const docs = [document];
    try { if (window.parent.document !== document) docs.push(window.parent.document); } catch (_) {}

    for (const doc of docs) {
      for (const el of doc.querySelectorAll('button, [role="button"], a')) {
        if (el.textContent.trim() === 'Trips+') {
          el.click();
          return;
        }
      }
    }
    if (n > 0) setTimeout(() => tryAutoClick(n - 1), 300);
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

  // ── Geocoding ─────────────────────────────────────────────────────────────────

  async function geocode(query) {
    const res  = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q: query, format: 'json', limit: '1' }), {
      headers: { 'Accept-Language': 'en', 'User-Agent': 'GeotabTripsHistoryEnhancer/5.0 (michaelolsen@geotab.com)' },
    });
    const data = await res.json();
    return data.length ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), label: data[0].display_name } : null;
  }

  // ── Search widget ─────────────────────────────────────────────────────────────

  const WIDGET_ID   = 'gia-trips-enhancer-search';
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

  // ── Boot ──────────────────────────────────────────────────────────────────────
  // Wait for DOM, then start looking for our button to auto-click.
  // 30 attempts × 300ms = 9 seconds max wait.

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => tryAutoClick(30));
  } else {
    tryAutoClick(30);
  }

}());
