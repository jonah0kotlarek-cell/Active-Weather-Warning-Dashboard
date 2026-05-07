'use strict';

// ── Warning config ──────────────────────────────────────────────
const CFG = {
  'Tornado Warning': {
    base:       { label: 'TOR',             color: '#FF0000', bg: '#200000', border: '#FF0000', rank: 10 },
    observed:   { label: 'TOR OBSERVED',    color: '#FF3333', bg: '#2e0000', border: '#FF3333', rank: 11 },
    pds:        { label: 'TOR PDS',         color: '#FF00FF', bg: '#200020', border: '#FF00FF', rank: 12 },
    emergency:  { label: 'TOR EMERGENCY',   color: '#FF69B4', bg: '#280015', border: '#FF69B4', rank: 13 },
  },
  'Severe Thunderstorm Warning': {
    base:         { label: 'SVR',               color: '#FFA500', bg: '#181000', border: '#FFA500', rank: 4 },
    considerable: { label: 'SVR CONSIDERABLE',  color: '#FF6600', bg: '#1e1000', border: '#FF6600', rank: 5 },
    destructive:  { label: 'SVR DESTRUCTIVE',   color: '#FF4500', bg: '#220c00', border: '#FF4500', rank: 6 },
    tor_possible: { label: 'SVR TOR POSSIBLE',  color: '#FFFF00', bg: '#181800', border: '#FFFF00', rank: 7 },
  },
};

const API_URL = 'https://api.weather.gov/alerts/active?status=actual&urgency=Immediate&severity=Severe,Extreme';

// ── State ───────────────────────────────────────────────────────
let warnings    = [];
let expanded    = {};
let knownIds    = new Set();
let alwaysOnTop = true;
let lastUpdate  = null;
let statusState = 'connecting';
let errorMsg    = '';

// ── Classification ──────────────────────────────────────────────
function classifyWarning(props) {
  const ev   = (props.event || '').toUpperCase();
  const tags = [
    ...(props.parameters?.tornadoDetection || []),
    ...(props.parameters?.thunderstormDamageThreat || []),
    ...(props.parameters?.tornadoDamageThreat || []),
  ].map(t => t.toUpperCase());

  if (ev.includes('TORNADO')) {
    if (tags.some(t => t.includes('CATASTROPHIC') || t.includes('EMERGENCY')))
      return { type: 'Tornado Warning', variant: 'emergency' };
    if (tags.some(t => t.includes('PARTICULARLY DANGEROUS') || t.includes('PDS')))
      return { type: 'Tornado Warning', variant: 'pds' };
    if (tags.some(t => t.includes('OBSERVED')))
      return { type: 'Tornado Warning', variant: 'observed' };
    return { type: 'Tornado Warning', variant: 'base' };
  }
  if (ev.includes('SEVERE THUNDERSTORM')) {
    if (tags.some(t => t.includes('DESTRUCTIVE')))
      return { type: 'Severe Thunderstorm Warning', variant: 'destructive' };
    if (tags.some(t => t.includes('CONSIDERABLE')))
      return { type: 'Severe Thunderstorm Warning', variant: 'considerable' };
    if (tags.some(t => t.includes('TORNADO POSSIBLE') || t.includes('TORNADOES POSSIBLE')))
      return { type: 'Severe Thunderstorm Warning', variant: 'tor_possible' };
    return { type: 'Severe Thunderstorm Warning', variant: 'base' };
  }
  return null;
}

function parseWarnings(geojson) {
  if (!geojson?.features) return [];
  const out = [];
  for (const feat of geojson.features) {
    const p  = feat.properties || {};
    const cl = classifyWarning(p);
    if (!cl) continue;
    const cfg     = CFG[cl.type][cl.variant];
    const issued  = new Date(p.sent || p.effective || Date.now());
    const expires = new Date(p.expires || Date.now() + 3_600_000);
    out.push({
      id:           p.id || feat.id || Math.random().toString(36),
      type:         cl.type,
      variant:      cl.variant,
      cfg,
      issued,
      expires,
      area:         p.areaDesc || 'Unknown Area',
      headline:     p.headline || `${cfg.label} until ${fmtTime(expires)}`,
      desc:         p.description || '',
      instruction:  p.instruction || '',
      rank:         cfg.rank,
      hailSize:     p.parameters?.maxHailSize?.[0] || null,
      windGust:     p.parameters?.maxWindGust?.[0]?.replace(/\D/g, '') || null,
      damageThreat: p.parameters?.thunderstormDamageThreat?.[0] || null,
      torDetect:    p.parameters?.tornadoDetection?.[0] || null,
    });
  }
  out.sort((a, b) => {
    const aExpiring = (a.expires - Date.now()) < 600000;
    const bExpiring = (b.expires - Date.now()) < 600000;
    if (aExpiring && !bExpiring) return 1;
    if (!aExpiring && bExpiring) return -1;
    if (a.isNew && !b.isNew) return -1;
    if (!a.isNew && b.isNew) return 1;
   return b.rank - a.rank || b.expires - a.expires;
  });
  return out;
}

// ── Fetch ────────────────────────────────────────────────────────
async function fetchWarnings() {
  try {
    let allFeatures = [];
    let url = API_URL;
    while (url) {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allFeatures = allFeatures.concat(data.features || []);
      url = data.pagination?.next || null;
    }
    const parsed = parseWarnings({ features: allFeatures });
    warnings = parsed.map(w => ({
      ...w,
      isNew: !knownIds.has(w.id) || (Date.now() - w.issued.getTime() < 90_000),
    }));
    knownIds    = new Set(parsed.map(w => w.id));
    lastUpdate  = new Date();
    statusState = parsed.length === 0 ? 'idle' : 'live';
    errorMsg    = '';
  } catch (e) {
    statusState = 'error';
    errorMsg    = e.message;
  }
  const list = document.getElementById('warn-list');
  const prevScroll = list ? list.scrollTop : 0;
  render();
  if (list) list.scrollTop = prevScroll;
}

// ── Helpers ──────────────────────────────────────────────────────
function fmtTime(d)    { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function fmtTimeSec(d) { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function minsLeft(exp) { return Math.max(0, Math.floor((exp - Date.now()) / 60_000)); }
function pctElapsed(iss, exp) {
  return Math.min(100, Math.max(0, ((Date.now() - iss) / (exp - iss)) * 100)).toFixed(1);
}
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Row HTML builder ─────────────────────────────────────────────
function buildRow(w) {
  const cfg       = w.cfg;
  const isExp     = !!expanded[w.id];
  const mins      = minsLeft(w.expires);
  const pct       = pctElapsed(w.issued.getTime(), w.expires.getTime());
  const minsClass = mins < 15 ? 'critical' : mins < 30 ? 'warning' : 'ok';
  const rowAnim   = w.isNew && !isExp ? 'animation:rowBlink 0.75s step-start infinite;' : '';
  const fading    = mins < 10 ? 'opacity:0.4;' : '';

  const dotHtml = w.isNew
    ? `<span class="blink-dot" style="background:${cfg.color};"></span>`
    : '';

  const bodyHtml = isExp ? (() => {
    const desc = (w.desc || '').slice(0, 3000);
    const inst = (w.instruction || '').slice(0, 1500);
    return `
      <div class="warn-body" style="border-top-color:${cfg.border}33;">
        <div class="warn-body-inner">
          <div class="eas-headline" style="color:${cfg.color};">...${esc(w.headline.slice(0, 120)).toUpperCase()}...</div>
          <div class="eas-times">ISSUED:  ${w.issued.toLocaleString().toUpperCase()}\nEXPIRES: ${w.expires.toLocaleString().toUpperCase()}</div>
          <div style="margin-bottom:6px;border-bottom:1px solid #1a1a1a;padding-bottom:6px;color:#ccc;">
            ${w.damageThreat ? `<div>THUNDERSTORM DAMAGE THREAT...${esc(w.damageThreat.toUpperCase())}</div>` : ''}
            ${w.hailSize     ? `<div>MAX HAIL SIZE...${esc(w.hailSize)} IN</div>` : ''}
            ${w.windGust     ? `<div>MAX WIND GUST...${esc(w.windGust)} MPH</div>` : ''}
            ${w.torDetect    ? `<div>TORNADO DETECTION...${esc(w.torDetect.toUpperCase())}</div>` : ''}
          </div>
          ${desc ? `<div class="eas-desc">${esc(desc)}</div>` : ''}
          ${inst ? `<div class="eas-action">PRECAUTIONARY/PREPAREDNESS ACTIONS...\n${esc(inst)}</div>` : ''}
        </div>
      </div>`;
  })() : '';

  return `
    <div class="warn-row" data-id="${esc(w.id)}"
         style="border-left:3px solid ${cfg.border};background:${isExp ? '#0e0e0e' : cfg.bg};${rowAnim}${fading}">
      <div class="warn-header">
        <div class="warn-top">
          ${dotHtml}
          <span class="warn-label" style="color:${cfg.color};">${esc(cfg.label)}</span>
          <span class="warn-area">${esc(w.area)}</span>
          <span class="warn-chevron">${isExp ? '▲' : '▼'}</span>
        </div>
        <div class="warn-tags">
          ${w.hailSize     ? `<span class="tag tag-hail">HAIL ${esc(w.hailSize)}"</span>` : ''}
          ${w.windGust     ? `<span class="tag tag-wind">WIND ${esc(w.windGust)} MPH</span>` : ''}
          ${w.damageThreat ? `<span class="tag tag-damage">${esc(w.damageThreat)}</span>` : ''}
          ${w.torDetect    ? `<span class="tag tag-tor">${esc(w.torDetect)}</span>` : ''}
        </div>
        <div class="timebar-labels">
          <span>ISS ${esc(fmtTime(w.issued))}</span>
          <span class="timebar-mins ${minsClass}">${mins}m LEFT</span>
          <span>EXP ${esc(fmtTime(w.expires))}</span>
        </div>
        <div class="timebar-track">
          <div class="timebar-fill" style="width:${pct}%;"></div>
        </div>
      </div>
      ${bodyHtml}
    </div>`;
}

// ── Main render ──────────────────────────────────────────────────
function render() {
  const led       = document.getElementById('status-led');
  const stText    = document.getElementById('status-text');
  const stTime    = document.getElementById('status-time');
  const statusbar = document.getElementById('statusbar');
  const tbDot     = document.getElementById('tb-dot');

  const hasTorEmerg = warnings.some(w => w.type === 'Tornado Warning' && ['pds', 'emergency'].includes(w.variant));
  const hasTor      = warnings.some(w => w.type === 'Tornado Warning');

  statusbar.className = hasTorEmerg ? 'tor-emerg' : hasTor ? 'tor' : '';

  if (statusState === 'live') {
    led.style.background = '#0f0';
    stText.textContent   = 'LIVE';
    stText.className     = '';
    tbDot.className      = '';
  } else if (statusState === 'idle') {
    led.style.background = '#444';
    stText.textContent   = 'NO ACTIVE WARNINGS';
    stText.className     = 'idle';
    tbDot.className      = 'idle';
  } else {
    led.style.background = '#f00';
    stText.textContent   = `ERROR: ${errorMsg}`;
    stText.className     = 'error';
    tbDot.className      = 'error';
  }
  stTime.textContent = lastUpdate ? fmtTimeSec(lastUpdate) : '';

  document.getElementById('footer-count').textContent =
    `${warnings.length} ACTIVE · 1.5s`;

  const torWarn = warnings.filter(w => w.type === 'Tornado Warning');
  const svrWarn = warnings.filter(w => w.type === 'Severe Thunderstorm Warning');
  const list    = document.getElementById('warn-list');

  if (warnings.length === 0) {
    list.innerHTML = `
      <div id="empty-state">
        <div class="es-icon">◉</div>
        <div class="es-label">NO ACTIVE WARNINGS</div>
      </div>`;
    return;
  }

  let html = '';

  if (torWarn.length) {
    html += `<div class="section-header" style="color:#FF0000;border-bottom:1px solid #FF000022;">
               ▸ TORNADO WARNINGS (${torWarn.length})</div>`;
    html += torWarn.map(buildRow).join('');
  }

  if (svrWarn.length) {
    if (torWarn.length) html += '<div style="height:5px;"></div>';
    html += `<div class="section-header" style="color:#FFA500;border-bottom:1px solid #FFA50022;">
               ▸ SEVERE THUNDERSTORM WARNINGS (${svrWarn.length})</div>`;
    html += svrWarn.map(buildRow).join('');
  }

  // Save scroll positions
  const prevScroll = list.scrollTop;
  const bodyScrolls = {};
  list.querySelectorAll('.warn-body-inner').forEach(el => {
    const row = el.closest('.warn-row');
    if (row) bodyScrolls[row.dataset.id] = el.scrollTop;
  });

  list.innerHTML = html;
  list.scrollTop = prevScroll;

  // Restore inner body scroll positions
  list.querySelectorAll('.warn-body-inner').forEach(el => {
    const row = el.closest('.warn-row');
    if (row && bodyScrolls[row.dataset.id]) {
      el.scrollTop = bodyScrolls[row.dataset.id];
    }
  });

  // Attach click handlers
  list.querySelectorAll('.warn-row').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.warn-body-inner')) return;
      const id = el.dataset.id;
      expanded[id] = !expanded[id];
      render();
    });
  });
}

// ── Window controls ──────────────────────────────────────────────
document.getElementById('btn-min').addEventListener('click', () => {
  window.electronAPI.minimize();
});

document.getElementById('btn-close').addEventListener('click', () => {
  window.electronAPI.close();
});

const btnOnTop = document.getElementById('btn-ontop');
btnOnTop.addEventListener('click', () => {
  alwaysOnTop = !alwaysOnTop;
  window.electronAPI.setAlwaysOnTop(alwaysOnTop);
  btnOnTop.classList.toggle('active', alwaysOnTop);
});
btnOnTop.classList.add('active');

// ── Boot ─────────────────────────────────────────────────────────
render();
fetchWarnings();
setInterval(fetchWarnings, 1500);
setInterval(() => {
  if (warnings.length > 0) {
    const list = document.getElementById('warn-list');
    const prevScroll = list.scrollTop;
    render();
    list.scrollTop = prevScroll;
  }
}, 30_000);