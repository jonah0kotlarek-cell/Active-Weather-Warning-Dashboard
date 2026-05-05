'use strict';

// ── Map constants ─────────────────────────────────────────────────
const SPC_D1_URL      = 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson';
const SPC_D1_TOR_URL  = 'https://www.spc.noaa.gov/products/outlook/day1otlk_torn.nolyr.geojson';
const SPC_D1_WIND_URL = 'https://www.spc.noaa.gov/products/outlook/day1otlk_wind.nolyr.geojson';
const SPC_D1_HAIL_URL = 'https://www.spc.noaa.gov/products/outlook/day1otlk_hail.nolyr.geojson';

const SPC_COLORS = {
  'TSTM': { color: '#c1e9c1', label: 'GENERAL TSTM' },
  'MRGL': { color: '#66c57d', label: 'MARGINAL' },
  'SLGT': { color: '#f6f67d', label: 'SLIGHT' },
  'ENH':  { color: '#e8a83a', label: 'ENHANCED' },
  'MDT':  { color: '#e85454', label: 'MODERATE' },
  'HIGH': { color: '#ff00ff', label: 'HIGH' },
};

const TOR_COLORS = {
  '0.02': '#ffff00', '0.05': '#cc6600', '0.10': '#ff0000',
  '0.15': '#ff00ff', '0.30': '#ff66ff', '0.45': '#cc00cc',
  '0.60': '#ff69b4', 'SIGN': '#000080',
};
const WIND_HAIL_COLORS = {
  '0.15': '#99cc00', '0.25': '#ffcc00', '0.35': '#ff6600',
  '0.45': '#ff0000', '0.60': '#ff00ff', 'SIGN': '#000080',
};

const layerVisible = {
  warnings: true,
  watches:  true,
  mds:      true,
  reports:  true,
  spcD1:    true,
  spcTor:   false,
  spcWind:  false,
  spcHail:  false,
};

const layerGroups = {
  warnings: [],
  watches:  [],
  mds:      [],
  reports:  [],
  spcD1:    [],
  spcTor:   [],
  spcWind:  [],
  spcHail:  [],
};

let spcD1Cache       = null; let spcD1LastFetch   = 0;
let spcTorCache      = null; let spcTorLastFetch  = 0;
let spcWindCache     = null; let spcWindLastFetch = 0;
let spcHailCache     = null; let spcHailLastFetch = 0;
let mapControlsBuilt = false; let mapUserHasMoved = false;

// ── Init ──────────────────────────────────────────────────────────
function initMap() {
  if (mapInitialized) return;
  mapInitialized = true;

  mapInstance = L.map('map-container', {
    center: [38, -96],
    zoom: 4,
    zoomControl: true,
    attributionControl: true,
  });

  mapInstance.on('moveend zoomend', function() { mapUserHasMoved = true; });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    subdomains: 'abcd',
    maxZoom: 18,
  }).addTo(mapInstance);

  injectMapStyles();
  buildMapControls();
  setTimeout(function() { mapInstance.invalidateSize(); }, 50);
}

// ── Styles ────────────────────────────────────────────────────────
function injectMapStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .map-layer-control {
      background: rgba(5,5,5,0.92);
      border: 1px solid #1a1a1a;
      border-radius: 3px;
      padding: 6px 8px;
      font-family: 'Courier New', monospace;
      font-size: 10px;
      color: #666;
      min-width: 130px;
      user-select: none;
    }
    .ctrl-title {
      font-size: 8px;
      letter-spacing: 2px;
      color: #333;
      margin-bottom: 5px;
      border-bottom: 1px solid #111;
      padding-bottom: 3px;
    }
    .map-layer-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 0;
      cursor: pointer;
      transition: color 0.15s;
    }
    .map-layer-toggle:hover { color: #ccc; }
    .map-layer-toggle input[type=checkbox] {
      accent-color: #FFA500;
      cursor: pointer;
      width: 12px;
      height: 12px;
      flex-shrink: 0;
    }
    .ctrl-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      display: inline-block;
    }
    .spc-legend {
      margin-top: 6px;
      border-top: 1px solid #111;
      padding-top: 4px;
    }
    .spc-legend-row {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 1px 0;
      font-size: 9px;
      color: #888;
    }
    .spc-legend-swatch {
      width: 10px; height: 10px;
      border-radius: 1px;
      flex-shrink: 0;
      opacity: 0.85;
    }
    .map-popup {
      font-family: 'Courier New', monospace;
      font-size: 11px;
      color: #ccc;
      background: #111;
    }
    .map-popup b { color: #eee; }
    .map-popup small { color: #555; }
    .leaflet-popup-content-wrapper {
      background: #111 !important;
      color: #ccc !important;
      border: 1px solid #333 !important;
      border-radius: 2px !important;
    }
    .leaflet-popup-tip { background: #111 !important; }
  `;
  document.head.appendChild(style);
}

// ── Layer toggle controls ─────────────────────────────────────────
function buildMapControls() {
  if (mapControlsBuilt) return;
  mapControlsBuilt = true;

  const ControlClass = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function() {
      const div = L.DomUtil.create('div', 'map-layer-control');
      div.innerHTML = buildControlHTML();
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    },
  });

  new ControlClass().addTo(mapInstance);

  setTimeout(function() {
    document.querySelectorAll('.map-toggle-cb').forEach(function(cb) {
      cb.addEventListener('change', function() {
        const layer = cb.dataset.layer;
        layerVisible[layer] = cb.checked;
        applyLayerVisibility(layer);
        if (layer === 'spcD1'   && cb.checked) fetchAndDrawSpcD1();
        if (layer === 'spcTor'  && cb.checked) fetchAndDrawSpcHazard('tor');
        if (layer === 'spcWind' && cb.checked) fetchAndDrawSpcHazard('wind');
        if (layer === 'spcHail' && cb.checked) fetchAndDrawSpcHazard('hail');
        const legendBox = document.getElementById('spc-legend-box');
        if (legendBox) legendBox.style.display = layerVisible.spcD1 ? '' : 'none';
      });
    });
  }, 100);
}

function buildControlHTML() {
  const rows = [
    { key: 'warnings', label: 'WARNINGS',    color: '#FF0000' },
    { key: 'watches',  label: 'WATCHES',     color: '#FFFF00' },
    { key: 'mds',      label: 'MDs',         color: '#00AAFF' },
    { key: 'reports',  label: 'SN REPORTS',  color: '#66ffcc' },
    { key: 'spcD1',    label: 'SPC D1 CAT',  color: '#ff9900' },
    { key: 'spcTor',   label: 'SPC D1 TOR',  color: '#ff00ff' },
    { key: 'spcWind',  label: 'SPC D1 WIND', color: '#aaaaff' },
    { key: 'spcHail',  label: 'SPC D1 HAIL', color: '#00ff99' },
  ];

  const toggles = rows.map(function(r) {
    return '<label class="map-layer-toggle">' +
      '<input type="checkbox" class="map-toggle-cb" data-layer="' + r.key + '" ' + (layerVisible[r.key] ? 'checked' : '') + ' />' +
      '<span class="ctrl-dot" style="background:' + r.color + ';"></span>' +
      '<span>' + r.label + '</span>' +
      '</label>';
  }).join('');

  const legend = Object.entries(SPC_COLORS).map(function(entry) {
    return '<div class="spc-legend-row">' +
      '<span class="spc-legend-swatch" style="background:' + entry[1].color + ';"></span>' +
      '<span>' + entry[1].label + '</span>' +
      '</div>';
  }).join('');

  return '<div class="ctrl-title">LAYERS</div>' +
    toggles +
    '<div class="spc-legend" id="spc-legend-box" style="' + (layerVisible.spcD1 ? '' : 'display:none;') + '">' +
    '<div style="font-size:8px;letter-spacing:1px;color:#333;margin-bottom:3px;">SPC D1 OUTLOOK</div>' +
    legend + '</div>';
}

function applyLayerVisibility(key) {
  layerGroups[key].forEach(function(l) {
    if (layerVisible[key]) {
      if (!mapInstance.hasLayer(l)) l.addTo(mapInstance);
    } else {
      if (mapInstance.hasLayer(l)) mapInstance.removeLayer(l);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────
function addToGroup(key, leafletLayer) {
  layerGroups[key].push(leafletLayer);
  if (layerVisible[key]) leafletLayer.addTo(mapInstance);
}

function clearGroup(key) {
  layerGroups[key].forEach(function(l) {
    if (mapInstance.hasLayer(l)) mapInstance.removeLayer(l);
  });
  layerGroups[key] = [];
}

function makePopup(color, title, subtitle, hint) {
  return '<div class="map-popup">' +
    '<b style="color:' + color + ';">' + title + '</b>' +
    (subtitle ? '<br><span>' + subtitle + '</span>' : '') +
    (hint ? '<br><small>' + hint + '</small>' : '') +
    '</div>';
}

// ── SPC D1 Categorical ────────────────────────────────────────────
async function fetchAndDrawSpcD1() {
  const now = Date.now();
  if (spcD1Cache && (now - spcD1LastFetch) < 10 * 60000) {
    drawSpcD1(spcD1Cache);
    return;
  }
  try {
    const res = await fetch(SPC_D1_URL, { headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const geojson = await res.json();
    spcD1Cache = geojson;
    spcD1LastFetch = now;
    drawSpcD1(geojson);
  } catch(e) {
    console.warn('SPC D1 fetch error:', e.message);
  }
}

function drawSpcD1(geojson) {
  if (!mapInstance) return;
  clearGroup('spcD1');
  if (!geojson || !geojson.features || !geojson.features.length) return;

  const ORDER = ['TSTM', 'MRGL', 'SLGT', 'ENH', 'MDT', 'HIGH'];
  const sorted = geojson.features.slice().sort(function(a, b) {
    const al = String((a.properties && (a.properties.LABEL || a.properties.label || a.properties.LABEL2)) || '').toUpperCase();
    const bl = String((b.properties && (b.properties.LABEL || b.properties.label || b.properties.LABEL2)) || '').toUpperCase();
    return ORDER.indexOf(al) - ORDER.indexOf(bl);
  });

  sorted.forEach(function(feature) {
    const props = feature.properties || {};
    const label = String(props.LABEL || props.label || props.LABEL2 || '').toUpperCase().trim();
    const theme = SPC_COLORS[label];
    if (!theme) return;

    const layer = L.geoJSON(feature, {
      style: { color: theme.color, fillColor: theme.color, fillOpacity: 0.18, weight: 1.5, opacity: 0.7, dashArray: '4,3' },
      onEachFeature: function(feat, lyr) {
        lyr.bindPopup(makePopup(theme.color, 'SPC DAY 1 — ' + theme.label, 'Categorical Convective Outlook', null));
      },
    });
    addToGroup('spcD1', layer);
  });
}

// ── SPC D1 Hazard Outlooks ────────────────────────────────────────
async function fetchAndDrawSpcHazard(type) {
  const now = Date.now();
  const urls = { tor: SPC_D1_TOR_URL, wind: SPC_D1_WIND_URL, hail: SPC_D1_HAIL_URL };
  const groupKey = 'spc' + type.charAt(0).toUpperCase() + type.slice(1);

  const cache = type === 'tor' ? spcTorCache : type === 'wind' ? spcWindCache : spcHailCache;
  const lastFetch = type === 'tor' ? spcTorLastFetch : type === 'wind' ? spcWindLastFetch : spcHailLastFetch;

  if (cache && (now - lastFetch) < 10 * 60000) {
    drawSpcHazard(cache, groupKey, type);
    return;
  }
  try {
    const res = await fetch(urls[type], { headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const geojson = await res.json();
    if (type === 'tor')  { spcTorCache  = geojson; spcTorLastFetch  = now; }
    if (type === 'wind') { spcWindCache = geojson; spcWindLastFetch = now; }
    if (type === 'hail') { spcHailCache = geojson; spcHailLastFetch = now; }
    drawSpcHazard(geojson, groupKey, type);
  } catch(e) {
    console.warn('SPC D1 ' + type + ' fetch error:', e.message);
  }
}

function drawSpcHazard(geojson, groupKey, type) {
  if (!mapInstance) return;
  clearGroup(groupKey);
  if (!geojson || !geojson.features || !geojson.features.length) return;

  const colorMap = type === 'tor' ? TOR_COLORS : WIND_HAIL_COLORS;
  const typeLabel = type === 'tor' ? 'TORNADO' : type === 'wind' ? 'WIND' : 'HAIL';

  geojson.features.forEach(function(feature) {
    const props = feature.properties || {};
    const label = String(props.LABEL || props.label || props.DN || '').toUpperCase().trim();
    const color = colorMap[label] || '#888888';

    const layer = L.geoJSON(feature, {
      style: { color: color, fillColor: color, fillOpacity: 0.2, weight: 1.5, opacity: 0.8, dashArray: '3,3' },
      onEachFeature: function(feat, lyr) {
        lyr.bindPopup(makePopup(color, 'SPC D1 ' + typeLabel + ' — ' + label, 'Day 1 ' + typeLabel + ' Outlook', null));
      },
    });
    addToGroup(groupKey, layer);
  });
}

// ── Warning polygons ──────────────────────────────────────────────
async function fetchAndDrawPolygon(item, groupKey, color, fillOpacity, weight, dashArray) {
  // If cached with a valid geojson, draw it
  if (polygonCache.has(item.id)) {
    const cached = polygonCache.get(item.id);
    if (cached) drawGeoJsonOnMap(cached, item, groupKey, color, fillOpacity, weight, dashArray);
    return;
  }

  // Mark as in-progress
  polygonCache.set(item.id, null);

  try {
    const resolvedId = item.nwsId || item.id;
    let alertUrl = null;

    if (resolvedId.startsWith('https://api.weather.gov/alerts/')) {
      alertUrl = resolvedId;
    } else if (resolvedId.startsWith('urn:')) {
      alertUrl = 'https://api.weather.gov/alerts/' + encodeURIComponent(resolvedId);
    } else if (resolvedId.includes('api.weather.gov')) {
      alertUrl = resolvedId;
    }

    if (!alertUrl) { polygonCache.delete(item.id); return; }

    const res = await fetch(alertUrl, {
      headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0', 'Accept': 'application/geo+json' },
    });
    if (!res.ok) { polygonCache.delete(item.id); return; }

    const geojson = await res.json();
    if (!geojson || (!geojson.geometry && !geojson.features)) { polygonCache.delete(item.id); return; }

    polygonCache.set(item.id, geojson);
    if (activeTab === 'map' && mapInstance) {
      drawGeoJsonOnMap(geojson, item, groupKey, color, fillOpacity, weight, dashArray);
    }
  } catch(e) {
    polygonCache.delete(item.id);
  }
}

function drawGeoJsonOnMap(geojson, item, groupKey, color, fillOpacity, weight, dashArray) {
  if (!mapInstance) return;
  try {
    const tabName = groupKey === 'watches' ? 'watches'
                  : groupKey === 'mds'     ? 'mds'
                  : groupKey === 'reports' ? 'reports'
                  : 'warnings';
    const label = (item.cfg && item.cfg.label) || item.type || item.area || ('MD #' + item.number);
    const area  = (item.area || '').split(',').slice(0, 3).join(', ');

    const layer = L.geoJSON(geojson, {
      style: { color: color, fillColor: color, fillOpacity: fillOpacity, weight: weight, dashArray: dashArray || null, opacity: 0.9 },
      onEachFeature: function(feature, lyr) {
        lyr.bindPopup(makePopup(color, label, area, 'Double-click to open in tab'));
        lyr.on('dblclick', function() { jumpToTab(tabName, item); });
      },
    });

    addToGroup(groupKey, layer);

    if (groupKey === 'warnings' || groupKey === 'watches') {
      try {
        const b = layer.getBounds();
        if (b.isValid()) {
          mapBounds.push(b.getSouthWest());
          mapBounds.push(b.getNorthEast());
        }
      } catch(e) {}
    }
  } catch(e) { /* silent */ }
}

// ── MD markers ───────────────────────────────────────────────────
function parseSpcLatLon(text) {
  const match = text.match(/LAT\.\.\.LON\s+([\d\s]+?)(?=[A-Z]|$)/);
  if (!match) return null;
  const nums = match[1].trim().split(/\s+/).map(Number);
  if (nums.length < 3) return null;
  const coords = [];
  for (let i = 0; i < nums.length; i++) {
    const n = String(nums[i]).padStart(8, '0');
    const lat = parseInt(n.substring(0, 4)) / 100;
    let lon = -(parseInt(n.substring(4, 8)) / 100);
    if (lon > -10) lon -= 100;
    coords.push([lon, lat]);
  }
  if (coords.length > 0) coords.push(coords[0]);
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} };
}

function drawMdMarkers() {
  clearGroup('mds');
  mds.forEach(function(md) {
    const num = String(md.number).padStart(4, '0');
    fetch('https://www.spc.noaa.gov/products/md/md' + num + '.html', {
      headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' },
    })
      .then(function(res) { if (!res.ok) throw new Error('no page'); return res.text(); })
      .then(function(html) {
        const geojson = parseSpcLatLon(html);
        if (!geojson) throw new Error('no coords');
        const layer = L.geoJSON(geojson, {
          style: { color: '#00AAFF', fillColor: '#00AAFF', fillOpacity: 0.15, weight: 2, dashArray: '5,4', opacity: 0.9 },
          onEachFeature: function(feature, lyr) {
            lyr.bindPopup(makePopup(
              '#00AAFF',
              'MD #' + md.number,
              (md.area || '') + (md.watchProb ? ' | Watch Prob: ' + md.watchProb + '%' : ''),
              'Double-click to open in tab'
            ));
            lyr.on('dblclick', function() { jumpToTab('mds', md); });
          },
        });
        addToGroup('mds', layer);
      })
      .catch(function() {
        const marker = L.circleMarker([38, -96], {
          radius: 10, color: '#00AAFF', fillColor: '#00AAFF', fillOpacity: 0.3, weight: 2,
        });
        marker.bindPopup(makePopup('#00AAFF', 'MD #' + md.number,
          (md.area || '') + (md.watchProb ? ' | Watch Prob: ' + md.watchProb + '%' : ''),
          'Double-click to open in tab'));
        marker.on('dblclick', function() { jumpToTab('mds', md); });
        addToGroup('mds', marker);
      });
  });
}

// ── Spotter report markers ────────────────────────────────────────
function drawSpotterReports() {
  clearGroup('reports');
  spotterReports.forEach(function(report) {
    if (!report.lat || !report.lon) return;
    const color = report.type === 'Tornado' ? '#ff4d4d'
                : report.type === 'Funnel Cloud' ? '#ff9900'
                : '#ffd400';
    const marker = L.circleMarker([report.lat, report.lon], {
      radius: 7, color: color, fillColor: color, fillOpacity: 0.5, weight: 2,
    });
    marker.bindPopup(makePopup(
      color,
      report.type.toUpperCase(),
      (report.reporter || 'Unknown Spotter') + ' · ' + report.issued.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}),
      'Double-click to open in tab'
    ));
    marker.on('dblclick', function() { jumpToTab('reports', report); });
    addToGroup('reports', marker);
  });
}

// ── Jump to tab ───────────────────────────────────────────────────
function jumpToTab(tabName, item) {
  activeTab = tabName;
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
  document.querySelector('.tab[data-tab="' + tabName + '"]').classList.add('active');
  document.getElementById('panel-' + tabName).classList.add('active');

  const keyPrefix = tabName === 'warnings' ? 'w_' : tabName === 'watches' ? 'wt_' : tabName === 'mds' ? 'md_' : 'rp_';
  expanded[keyPrefix + item.id] = true;

  if (tabName === 'warnings')      renderWarnings();
  else if (tabName === 'watches')  renderWatches();
  else if (tabName === 'mds')      renderMDs();
  else if (tabName === 'reports')  renderReports();

  setTimeout(function() {
    const el = document.querySelector('[data-id="' + CSS.escape(item.id) + '"]');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 100);
}

// ── Draw helpers ──────────────────────────────────────────────────
function drawWarningPolygon(w) {
  const color = (w.cfg && w.cfg.color) || '#FFA500';
  const id = String(w.nwsId || w.id || '');
  if (id.includes('api.weather.gov') || id.startsWith('urn:')) {
    fetchAndDrawPolygon(w, 'warnings', color, 0.18, 2, null);
    return;
  }
  // No NWS ID available — show office marker as fallback
  if (!w.officeCode) return;
  const officeCoords = {
    'KDVN': [41.61, -90.58], 'KLSX': [38.70, -90.68], 'KIWX': [41.36, -85.70],
    'KGRR': [42.89, -85.54], 'KDTX': [42.70, -83.47], 'KBOU': [39.95, -105.02],
    'KFSD': [43.58, -96.73], 'KOMA': [41.32, -96.37], 'KTOP': [39.07, -95.63],
    'KICT': [37.65, -97.43], 'KSGF': [37.23, -93.40], 'KLZK': [34.84, -92.26],
    'KMAF': [31.94, -102.19],'KSJT': [31.37, -100.49],'KEWX': [29.70, -98.03],
    'KHGX': [29.47, -95.08], 'KLCH': [30.13, -93.22], 'KSHV': [32.45, -93.84],
    'KMOB': [30.68, -88.24], 'KBMX': [33.17, -86.77], 'KOHX': [36.25, -86.56],
    'KMRX': [36.17, -83.40], 'KFFC': [33.36, -84.57], 'KJAX': [30.49, -81.70],
    'KTBW': [27.71, -82.40], 'KMLB': [28.11, -80.65], 'KAMX': [25.61, -80.41],
  };
  const coords = officeCoords[w.officeCode];
  if (!coords) return;
  const marker = L.circleMarker(coords, {
    radius: 10, color: color, fillColor: color, fillOpacity: 0.4, weight: 2,
  });
  const label = (w.cfg && w.cfg.label) || w.type || 'Warning';
  marker.bindPopup(makePopup(color, label, w.area || '', 'Double-click to open in tab'));
  marker.on('dblclick', function() { jumpToTab('warnings', w); });
  addToGroup('warnings', marker);
}

// ── Refresh ───────────────────────────────────────────────────────
function refreshMap() {
  if (!mapInstance) return;

  mapBounds = [];

  // Clear polygon cache for warnings so stale/expired ones don't persist
  warnings.forEach(function(w) {
    if (!polygonCache.has(w.id) || polygonCache.get(w.id) === null) {
      polygonCache.delete(w.id);
    }
  });

  clearGroup('warnings');
  warnings.forEach(function(w) { drawWarningPolygon(w); });

  clearGroup('watches');
  watches.forEach(function(w) { drawWatchPolygon(w); });

  drawMdMarkers();
  drawSpotterReports();

  if (layerVisible.spcD1)   fetchAndDrawSpcD1();
  if (layerVisible.spcTor)  fetchAndDrawSpcHazard('tor');
  if (layerVisible.spcWind) fetchAndDrawSpcHazard('wind');
  if (layerVisible.spcHail) fetchAndDrawSpcHazard('hail');

  setTimeout(function() {
    if (mapBounds.length > 0 && !mapUserHasMoved) {
      try { mapInstance.fitBounds(L.latLngBounds(mapBounds), { padding: [20, 20], maxZoom: 8 }); } catch(e) {}
    }
    mapInstance.invalidateSize();
  }, 300);
}