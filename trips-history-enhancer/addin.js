/**
 * Trips History Enhancer — MyGeotab Button Add-in v3
 * Target: 11.130.494-0c2376cea2b9
 *
 * Loads as a button add-in so the user keeps the normal Trips History page.
 * Self-initializes on script load by reading api/state from the MyGeotab
 * window context — no button click required.
 *
 * Features:
 *   1. Second-precision timestamps on all stop/zone/driving hover dialogs
 *   2. Address search box → draggable OpenStreetMap mini-map overlay
 */
(function () {
  'use strict';

  // ── Selector constants ──────────────────────────────────────────────────────
  const SEL_TOOLBAR = [
    '.page-action-bar',
    '.trips-history-toolbar',
    '.action-bar',
    '.toolbar-container',
    '[class*="actionBar"]',
    '[class*="toolbar"]',
  ].join(', ');

  // ── State ───────────────────────────────────────────────────────────────────
  let _api        = null;
  let _state      = null;
  const _cache    = {};   // "deviceId|dateStr|tz" → { "HH:MM": "HH:MM:SS" }

  // ── Utility ──────────────────────────────────────────────────────────────────
  function pad2(n) { return String(n).padStart(2, '0'); }

  const TIME_RE       = /\b\d{1,2}:\d{2}\b/;
  const TIME_RE_NOSEC = /\b(\d{1,2}):(\d{2})\b(?!:\d{2})/g;
  const TIME_RE_12H   = /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi;
  const TZ_RE         = /\(([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\)/;
  const DATE_RE       = /\b(\d{2})\/(\d{2})\/(\d{2})\b/;

  function extractTZ(text) {
    const m = text.match(TZ_RE);
    return m ? m[1] : Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  function extractDate(text) {
    const m = text.match(DATE_RE);
    if (m) {
      const d = new Date(`20${m[3]}-${m[1]}-${m[2]}`);
      if (!isNaN(d)) return d;
    }
    return new Date();
  }

  function toTZParts(isoStr, tz) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, timeZone: tz,
      });
      const p = Object.fromEntries(fmt.formatToParts(new Date(isoStr)).map(x => [x.type, x.value]));
      const h = p.hour === '24' ? '00' : p.hour;
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

  function fetchTrips(deviceId, date, tz) {
    const key = `${deviceId}|${date.toDateString()}|${tz}`;
    if (_cache[key]) return Promise.resolve(_cache[key]);

    const from = new Date(date); from.setHours(0, 0, 0, 0);
    const to   = new Date(date); to.setHours(23, 59, 59, 999);

    return new Promise(resolve => {
      _api.call('Get', {
        typeName: 'Trip',
        search: { deviceSearch: { id: deviceId }, fromDate: from.toISOString(), toDate: to.toISOString() },
      }, trips => {
        const m = buildTimeMap(trips || [], tz);
        _cache[key] = m;
        resolve(m);
      }, err => {
        console.error('[TripsEnhancer] Trip fetch error:', err);
        resolve({});
      });
    });
  }

  // Pre-fetch using current page state so cache is warm before first hover.
  function prefetch() {
    if (!_api || !_state) return;
    try {
      const st = _state.getState ? _state.getState() : {};
      const deviceId = (st.device && (st.device.id || st.device)) || st.deviceId;
      const dateRaw  = (st.dates && st.dates[0]) || st.date || st.fromDate;
      if (!deviceId || !dateRaw) return;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      fetchTrips(deviceId, new Date(dateRaw), tz).catch(() => {});
    } catch (_) {}
  }

  // ── Timestamp upgrade ────────────────────────────────────────────────────────

  function upgradeEl(el) {
    if (!_api) return;
    const text = el.textContent || '';
    if (!TIME_RE.test(text)) return;

    const tz       = extractTZ(text);
    const date     = extractDate(text);
    const st       = _state && _state.getState ? _state.getState() : {};
    const deviceId = (st.device && (st.device.id || st.device)) || st.deviceId;
    if (!deviceId) return;

    fetchTrips(deviceId, date, tz).then(timeMap => {
      if (!Object.keys(timeMap).length) return;
      const ownerDoc = el.ownerDocument || document;
      const tw = ownerDoc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = tw.nextNode())) {
        let val = node.nodeValue;
        // Replace all HH:mm (12h with AM/PM)
        val = val.replace(TIME_RE_12H, (match, hStr, mStr, ampm) => {
          let h = parseInt(hStr, 10);
          if (ampm.toLowerCase() === 'pm' && h < 12) h += 12;
          if (ampm.toLowerCase() === 'am' && h === 12) h = 0;
          const k = `${pad2(h)}:${mStr}`;
          return timeMap[k] || match;
        });
        // Replace remaining HH:mm (24h, not already HH:mm:ss)
        val = val.replace(TIME_RE_NOSEC, (match, hStr, mStr) => {
          const k = `${pad2(parseInt(hStr, 10))}:${mStr}`;
          return timeMap[k] || match;
        });
        if (val !== node.nodeValue) node.nodeValue = val;
      }
      // Reset regex lastIndex after global flag use
      TIME_RE_12H.lastIndex = 0;
      TIME_RE_NOSEC.lastIndex = 0;
    }).catch(() => {});
  }

  // ── Event listeners ──────────────────────────────────────────────────────────

  function handleMouseover(e) {
    const t = e.target;
    if (!t || t.nodeType !== Node.ELEMENT_NODE) return;
    if (!TIME_RE.test(t.textContent)) return;
    // Walk up to find the tooltip container root (≥2 children, has a time).
    let el = t;
    for (let i = 0; i < 8; i++) {
      const p = el.parentElement;
      if (!p || p.tagName === 'BODY' || p.tagName === 'HTML') break;
      el = p;
      if (el.children.length >= 2 && TIME_RE.test(el.textContent)) break;
    }
    upgradeEl(el);
  }

  function attachTo(doc) {
    try {
      doc.addEventListener('mouseover', handleMouseover, { capture: true, passive: true });
      const obs = new MutationObserver(muts => {
        for (const mut of muts) {
          for (const node of mut.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && TIME_RE.test(node.textContent)) {
              upgradeEl(node);
            }
          }
        }
      });
      obs.observe(doc.body, { childList: true, subtree: true });
    } catch (_) {}
  }

  // ── Minimap ──────────────────────────────────────────────────────────────────

  const MINIMAP_ID = 'gia-trips-enhancer-minimap';

  function showMiniMap(lat, lng, label) {
    const existing = document.getElementById(MINIMAP_ID);
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = MINIMAP_ID;
    panel.style.cssText = [
      'position:fixed', 'top:80px', 'right:24px', 'width:380px', 'height:320px',
      'background:#fff', 'border:1px solid #bbb', 'border-radius:6px',
      'box-shadow:0 4px 16px rgba(0,0,0,.25)', 'display:flex',
      'flex-direction:column', 'z-index:99999', 'font-family:sans-serif',
    ].join(';');

    const bar = document.createElement('div');
    bar.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:6px 10px', 'background:#0078d4', 'color:#fff',
      'border-radius:6px 6px 0 0', 'cursor:move', 'user-select:none',
      'font-size:12px', 'gap:8px',
    ].join(';');

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
    const bbox  = `${lng-delta},${lat-delta},${lng+delta},${lat+delta}`;
    const frame = document.createElement('iframe');
    frame.src   = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
    frame.style.cssText = 'flex:1;border:none;border-radius:0 0 6px 6px;';

    panel.appendChild(bar);
    panel.appendChild(frame);
    document.body.appendChild(panel);

    let dragging = false, ox = 0, oy = 0;
    bar.addEventListener('mousedown', e => {
      dragging = true;
      const r = panel.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      panel.style.left  = (e.clientX - ox) + 'px';
      panel.style.top   = (e.clientY - oy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ── Geocoding ────────────────────────────────────────────────────────────────

  async function geocode(query) {
    const params = new URLSearchParams({ q: query, format: 'json', limit: '1' });
    const res = await fetch('https://nominatim.openstreetmap.org/search?' + params, {
      headers: {
        'Accept-Language': 'en',
        'User-Agent': 'GeotabTripsHistoryEnhancer/3.0 (michaelolsen@geotab.com)',
      },
    });
    const data = await res.json();
    if (!data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), label: data[0].display_name };
  }

  // ── Search widget ────────────────────────────────────────────────────────────

  const WIDGET_ID = 'gia-trips-enhancer-search';

  function buildSearchWidget() {
    const wrap = document.createElement('div');
    wrap.id = WIDGET_ID;
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:14px;vertical-align:middle;';
    wrap.innerHTML = `
      <input id="${WIDGET_ID}-input" type="text" placeholder="Search address…"
        style="padding:3px 8px;border:1px solid #bbb;border-radius:3px;
               font-size:13px;width:215px;height:28px;box-sizing:border-box;" />
      <button id="${WIDGET_ID}-btn"
        style="padding:0 11px;height:28px;background:#0078d4;color:#fff;
               border:none;border-radius:3px;cursor:pointer;font-size:13px;">Go</button>
      <span id="${WIDGET_ID}-status"
        style="font-size:12px;color:#555;max-width:175px;overflow:hidden;
               text-overflow:ellipsis;white-space:nowrap;" title=""></span>
    `;

    const input  = wrap.querySelector(`#${WIDGET_ID}-input`);
    const btn    = wrap.querySelector(`#${WIDGET_ID}-btn`);
    const status = wrap.querySelector(`#${WIDGET_ID}-status`);

    async function run() {
      const q = input.value.trim();
      if (!q) return;
      status.textContent = 'Searching…';
      btn.disabled = true;
      try {
        const result = await geocode(q);
        if (result) {
          status.title = result.label;
          status.textContent = '✓ Found';
          showMiniMap(result.lat, result.lng, result.label);
        } else {
          status.textContent = 'No results';
        }
      } catch (err) {
        status.textContent = 'Error';
        console.error('[TripsEnhancer] geocode error:', err);
      } finally {
        btn.disabled = false;
      }
    }

    btn.addEventListener('click', run);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    return wrap;
  }

  function tryInjectSearch(attemptsLeft) {
    if (document.getElementById(WIDGET_ID)) return;
    const toolbar = document.querySelector(SEL_TOOLBAR);
    if (toolbar) { toolbar.appendChild(buildSearchWidget()); return; }
    if (attemptsLeft > 0) setTimeout(() => tryInjectSearch(attemptsLeft - 1), 400);
  }

  // ── Button entry point (required by MyGeotab) ─────────────────────────────
  // The button exists only so MyGeotab loads this script. We don't need it clicked.
  // api/state come from window instead — see self-init below.

  geotab.customButtons['Trips+'] = function (event, api, state) {
    // If the self-init didn't find api/state on window, the button click is a fallback.
    if (!_api) { _api = api; _state = state; prefetch(); }
  };

  // ── Self-initialization ──────────────────────────────────────────────────────
  // MyGeotab button add-ins run in the main page context. The api and state objects
  // are typically accessible on window — find them without requiring a button click.

  function selfInit() {
    // Strategy: scan window for an object with .call() and .getSession() — the api shape.
    const keys = Object.keys(window);
    for (let i = 0; i < Math.min(keys.length, 400); i++) {
      try {
        const v = window[keys[i]];
        if (v && typeof v.call === 'function' && typeof v.getSession === 'function') {
          _api = v;
          break;
        }
      } catch (_) {}
    }

    // State is harder to find generically — use geotab.state if exposed.
    try {
      if (!_state && window.geotab && window.geotab.state) _state = window.geotab.state;
    } catch (_) {}

    if (_api) {
      console.log('[TripsEnhancer] Self-initialized — api found on window');
      attachTo(document);
      try {
        const pdoc = window.parent.document;
        if (pdoc !== document) attachTo(pdoc);
      } catch (_) {}
      prefetch();
    } else {
      console.log('[TripsEnhancer] api not found on window — waiting for button click as fallback');
      // Still attach listeners; upgrade calls will silently no-op until _api is set.
      attachTo(document);
      try {
        const pdoc = window.parent.document;
        if (pdoc !== document) attachTo(pdoc);
      } catch (_) {}
    }

    tryInjectSearch(30);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', selfInit);
  } else {
    selfInit();
  }

}());
