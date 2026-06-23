/**
 * Trips History Enhancer — MyGeotab Button Add-in
 * Target: 11.130.494-0c2376cea2b9
 *
 * Features:
 *   1. Address search box injected into the trips history toolbar (auto-on, no API needed)
 *   2. Second-precision timestamps in stop hover tooltips (toggle via "Show Seconds" button)
 *
 * The "Show Seconds" button in the toolbar activates feature 2 and provides the api/state
 * objects needed to fetch trip data. Feature 1 is always active once the toolbar renders.
 *
 * SELECTOR MAINTENANCE
 * If a MyGeotab update breaks this add-in, open DevTools on the trips history page and
 * verify the four SEL_* constants below. They are the only version-sensitive pieces.
 */
(function () {
  'use strict';

  // ── Selector constants ──────────────────────────────────────────────────────
  // Verify these against the live DOM in DevTools if anything stops working.

  // Toolbar where we append the search widget.
  // Try each selector in DevTools console: document.querySelector('<sel>')
  const SEL_TOOLBAR = [
    '.page-action-bar',
    '.trips-history-toolbar',
    '.action-bar',
    '.toolbar-container',
    '[class*="actionBar"]',
    '[class*="toolbar"]',
  ].join(', ');

  // The stop/trip tooltip element that appears on map hover.
  // Leaflet popups are the most likely container in v11.
  const SEL_TOOLTIP = [
    '.leaflet-popup-content',
    '.geotab-tooltip',
    '.stop-details-popup',
    '[class*="popup-content"]',
  ].join(', ');

  // Leaflet map container — standard across all Leaflet versions.
  const SEL_MAP = '.leaflet-container';

  // ── Internal state ──────────────────────────────────────────────────────────
  const WIDGET_ID  = 'gia-trips-enhancer-search';
  let _api         = null;
  let _state       = null;
  let _observer    = null;
  let _secondsOn   = false;
  const _tripCache = {};   // "deviceId|dateString" → { "HH:MM": "HH:MM:SS" }

  // ── Map utilities ───────────────────────────────────────────────────────────

  function getLeafletMap() {
    const container = document.querySelector(SEL_MAP);
    if (!container) return null;

    // Predicate: does this value look like a Leaflet Map attached to our container?
    // Uses classList check rather than reference equality so nested/proxied
    // containers still match.
    function isMap(v) {
      return v
        && typeof v === 'object'
        && typeof v.setView === 'function'
        && typeof v.panTo  === 'function'
        && v._container
        && v._container.classList
        && v._container.classList.contains('leaflet-container');
    }

    // Strategy A: some Leaflet builds attach the instance directly to the element.
    if (isMap(container._leaflet)) return container._leaflet;

    // Strategy B: direct window property (works when map is a module-level var).
    const winKeys = Object.keys(window);
    for (let i = 0; i < Math.min(winKeys.length, 500); i++) {
      try {
        const v = window[winKeys[i]];
        if (isMap(v)) return v;
      } catch (_) { /* skip non-enumerable / getters that throw */ }
    }

    // Strategy C: one level deep into window objects.
    // MyGeotab stores the map inside a namespaced object, not directly on window.
    for (let i = 0; i < Math.min(winKeys.length, 300); i++) {
      try {
        const obj = window[winKeys[i]];
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
        const subKeys = Object.keys(obj);
        for (let j = 0; j < Math.min(subKeys.length, 60); j++) {
          try {
            const v = obj[subKeys[j]];
            if (isMap(v)) return v;
          } catch (_) {}
        }
      } catch (_) {}
    }

    return null;
  }

  function panMapTo(lat, lng) {
    const map = getLeafletMap();
    if (!map) return false;
    map.setView([lat, lng], Math.max(map.getZoom() || 14, 14));
    return true;
  }

  // ── Geocoding (Nominatim / OpenStreetMap — no API key required) ─────────────

  async function geocode(query) {
    const params = new URLSearchParams({
      q:      query,
      format: 'json',
      limit:  '1',
    });
    const res = await fetch('https://nominatim.openstreetmap.org/search?' + params, {
      headers: {
        'Accept-Language': 'en',
        'User-Agent': 'GeotabTripsHistoryEnhancer/1.0 (michaelolsen@geotab.com)',
      },
    });
    const data = await res.json();
    if (!data.length) return null;
    return {
      lat:   parseFloat(data[0].lat),
      lng:   parseFloat(data[0].lon),
      label: data[0].display_name,
    };
  }

  // ── Search widget ───────────────────────────────────────────────────────────

  function buildSearchWidget() {
    const wrap = document.createElement('div');
    wrap.id = WIDGET_ID;
    wrap.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:6px',
      'margin-left:14px',
      'vertical-align:middle',
    ].join(';');

    wrap.innerHTML = `
      <input id="${WIDGET_ID}-input" type="text" placeholder="Search address…"
        style="padding:3px 8px;border:1px solid #bbb;border-radius:3px;
               font-size:13px;width:215px;height:28px;box-sizing:border-box;
               outline:none;" />
      <button id="${WIDGET_ID}-btn"
        style="padding:0 11px;height:28px;background:#0078d4;color:#fff;
               border:none;border-radius:3px;cursor:pointer;font-size:13px;
               white-space:nowrap;">
        Go
      </button>
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
          const panned = panMapTo(result.lat, result.lng);
          status.title       = result.label;
          status.textContent = panned
            ? '✓ Found'
            : '✓ Found (map not detected — pan manually)';
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

  function injectSearchWidget() {
    if (document.getElementById(WIDGET_ID)) return;   // already present

    const toolbar = document.querySelector(SEL_TOOLBAR);
    if (!toolbar) {
      console.warn(
        '[TripsEnhancer] Toolbar not found. Open DevTools on the trips history page, '
        + 'inspect the toolbar element, and update SEL_TOOLBAR in addin.js.'
      );
      return;
    }
    toolbar.appendChild(buildSearchWidget());
  }

  // Retry until the toolbar renders (SPA pages mount asynchronously).
  function tryInjectSearch(attemptsLeft) {
    if (document.getElementById(WIDGET_ID)) return;
    if (document.querySelector(SEL_TOOLBAR)) {
      injectSearchWidget();
      return;
    }
    if (attemptsLeft > 0) {
      setTimeout(() => tryInjectSearch(attemptsLeft - 1), 400);
    } else {
      console.warn('[TripsEnhancer] Gave up waiting for toolbar after 12 s.');
    }
  }

  // ── Timestamp upgrader ──────────────────────────────────────────────────────

  function pad2(n) { return String(n).padStart(2, '0'); }

  // Parse a time string that may be HH:mm (24h) or H:mm AM/PM (12h).
  // Returns { h, min } in 24-hour values, or null.
  function parseDisplayedTime(text) {
    // 12-hour: "2:30 PM", "2:30PM", "2:30 am"
    let m = text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i);
    if (m) {
      let h = parseInt(m[1], 10);
      if (m[3].toLowerCase() === 'pm' && h < 12) h += 12;
      if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
      return { h, min: parseInt(m[2], 10) };
    }
    // 24-hour: "14:30" — skip if already has seconds ("14:30:00")
    m = text.match(/\b(\d{1,2}):(\d{2})\b(?!:\d{2})/);
    if (m) return { h: parseInt(m[1], 10), min: parseInt(m[2], 10) };
    return null;
  }

  function toHHMMSS(isoStr) {
    const d = new Date(isoStr);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  // Build "HH:MM" → "HH:MM:SS" lookup from a list of Trip records.
  // Trip.Start, Trip.Stop, and Trip.NextTripStart all carry stop-relevant times.
  function buildTimeMap(trips) {
    const map = {};
    trips.forEach(trip => {
      ['Start', 'Stop', 'NextTripStart'].forEach(field => {
        if (!trip[field]) return;
        const d   = new Date(trip[field]);
        const key = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
        if (!map[key]) map[key] = toHHMMSS(trip[field]);
      });
    });
    return map;
  }

  async function getTimeMap(deviceId, date) {
    const cacheKey = `${deviceId}|${date.toDateString()}`;
    if (_tripCache[cacheKey]) return _tripCache[cacheKey];

    const from = new Date(date); from.setHours(0, 0, 0, 0);
    const to   = new Date(date); to.setHours(23, 59, 59, 999);

    return new Promise(resolve => {
      _api.call('Get', {
        typeName: 'Trip',
        search: {
          deviceSearch: { id: deviceId },
          fromDate: from.toISOString(),
          toDate:   to.toISOString(),
        },
      },
      trips => {
        const m = buildTimeMap(trips || []);
        _tripCache[cacheKey] = m;
        resolve(m);
      },
      err => {
        console.error('[TripsEnhancer] Trip API error:', err);
        resolve({});
      });
    });
  }

  async function upgradeTooltipTimestamps(tooltipEl) {
    if (!_api || !_state) return;

    const st = _state.getState ? _state.getState() : {};

    // Uncomment to debug the state shape in your version:
    // console.debug('[TripsEnhancer] state:', JSON.stringify(st));

    // Pull device id — shape may vary; widen this if timestamps aren't upgrading.
    const deviceId = (st.device && (st.device.id || st.device))
                  || st.deviceId
                  || null;

    // Pull the viewed date — prefer the start of the selected range.
    const dateRaw  = (st.dates && st.dates[0]) || st.date || st.fromDate || null;

    if (!deviceId || !dateRaw) return;

    const contextDate = new Date(dateRaw);
    if (isNaN(contextDate.getTime())) return;

    const timeMap = await getTimeMap(deviceId, contextDate);
    if (!Object.keys(timeMap).length) return;

    // Walk every text node in the tooltip and replace matching HH:mm patterns.
    const walker = document.createTreeWalker(tooltipEl, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parsed = parseDisplayedTime(node.nodeValue);
      if (!parsed) continue;
      const key = `${pad2(parsed.h)}:${pad2(parsed.min)}`;
      if (!timeMap[key]) continue;
      // Replace the first HH:mm (±AM/PM) occurrence in this text node.
      node.nodeValue = node.nodeValue.replace(
        /\b\d{1,2}:\d{2}(?:\s*(?:am|pm))?\b/i,
        timeMap[key]
      );
    }
  }

  // ── MutationObserver ────────────────────────────────────────────────────────

  function startObserver() {
    if (_observer) return;
    _observer = new MutationObserver(mutations => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // Check the added node itself.
          if (node.matches && node.matches(SEL_TOOLTIP)) {
            upgradeTooltipTimestamps(node).catch(() => {});
          }

          // Also check descendants — Leaflet sometimes adds a wrapper + content together.
          node.querySelectorAll(SEL_TOOLTIP).forEach(child => {
            upgradeTooltipTimestamps(child).catch(() => {});
          });
        }
      }
    });
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (_observer) {
      _observer.disconnect();
      _observer = null;
    }
  }

  // ── Add-in entry point ──────────────────────────────────────────────────────
  // MyGeotab calls geotab.customButtons["Show Seconds"] when the toolbar button
  // is clicked. The key MUST match buttonName.en in config.json exactly.

  geotab.customButtons['Show Seconds'] = function (event, api, state) {
    _api   = api;
    _state = state;

    _secondsOn = !_secondsOn;

    if (_secondsOn) {
      // Clear stale cache when the user activates (they may have changed device/date).
      Object.keys(_tripCache).forEach(k => delete _tripCache[k]);
      injectSearchWidget();   // no-op if already present
      startObserver();
    } else {
      stopObserver();
    }
  };

  // ── Boot ────────────────────────────────────────────────────────────────────
  // Feature 1 (search box) starts automatically — no button click required.
  // Feature 2 (seconds) starts only after the button is clicked (needs api/state).

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => tryInjectSearch(30));
  } else {
    tryInjectSearch(30);   // up to 30 × 400 ms = 12 s retry window
  }

})();
