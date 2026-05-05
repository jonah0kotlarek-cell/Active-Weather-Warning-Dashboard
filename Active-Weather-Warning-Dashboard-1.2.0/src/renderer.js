'use strict';

// ── Warning config ──────────────────────────────────────────────
const CFG = {
  'Tornado Warning': {
    base:       { label: 'TOR',            color: '#FF0000', bg: '#200000', border: '#FF0000', rank: 10 },
    observed:   { label: 'TOR OBSERVED',   color: '#FF3333', bg: '#2e0000', border: '#FF3333', rank: 11 },
    pds:        { label: 'TOR PDS',        color: '#FF00FF', bg: '#200020', border: '#FF00FF', rank: 12 },
    emergency:  { label: 'TOR EMERGENCY',  color: '#FF69B4', bg: '#280015', border: '#FF69B4', rank: 13 },
  },
  'Severe Thunderstorm Warning': {
    base:         { label: 'SVR',              color: '#FFA500', bg: '#181000', border: '#FFA500', rank: 4 },
    considerable: { label: 'SVR CONSIDERABLE', color: '#FF6600', bg: '#1e1000', border: '#FF6600', rank: 5 },
    destructive:  { label: 'SVR DESTRUCTIVE',  color: '#FF4500', bg: '#220c00', border: '#FF4500', rank: 6 },
    tor_possible: { label: 'SVR TOR POSSIBLE', color: '#FFFF00', bg: '#181800', border: '#FFFF00', rank: 7 },
  },
};

const WATCH_CFG = {
  'Tornado Watch': {
    base: { label: 'TOR WATCH', color: '#FFFF00', bg: '#1a1a00', border: '#FFFF00', rank: 8 },
    pds:  { label: 'TOR WATCH PDS', color: '#FF00FF', bg: '#1a001a', border: '#FF00FF', rank: 9 },
  },
  'Severe Thunderstorm Watch': {
    base: { label: 'SVR WATCH', color: '#00AAFF', bg: '#001a2a', border: '#00AAFF', rank: 3 },
  },
};

const WARN_URLS = [
  'https://api.weather.gov/alerts/active?status=actual&event=Tornado%20Warning',
  'https://api.weather.gov/alerts/active?status=actual&event=Severe%20Thunderstorm%20Warning',
];
const COD_WARN_URL = 'https://weather.cod.edu/textserv/json/svr/active-2';
const WATCH_URL = 'https://api.weather.gov/alerts/active?status=actual&event=Tornado%20Watch,Severe%20Thunderstorm%20Watch';
const MD_URL    = 'https://www.spc.noaa.gov/products/md/mdlist.json';
const SPOTTER_REPORTS_URL = 'https://www.spotternetwork.org/feeds/reports.txt';
const TORE_SOUND_URL = '../assets/tore-eas.mp3';
const WEA_SOUND_URL  = '../assets/wea-sound.mp3';
const SPOTTER_SOUND_URL = '../assets/spotter-network-new.mp3';

// ── State ───────────────────────────────────────────────────────
let warnings    = [];
let watches     = [];
let mds         = [];
let spotterReports = [];
let expanded    = {};
let knownWarnIds = new Set();
let knownWatchIds = new Set();
let knownMdIds   = new Set();
let alwaysOnTop  = true;
let lastUpdate   = null;
let statusState  = 'connecting';
let errorMsg     = '';
let activeTab    = 'warnings';
let lastWarnHash = '';
let lastWatchHash = '';
let lastMdHash = '';
let lastReportHash = '';
let lastDevHash = '';
let lastSpotterFetch = 0;
let mdMetaLoading = new Set();
let watchMetaLoading = new Set();
let warningRadarLoading = new Set();
let reportRadarLoading = new Set();
let soundedWarningKeys = new Set();
let soundedReportIds = new Set();
let warningAudioPrimed = false;
// ── Map state ────────────────────────────────────────────────────
let mapInstance = null;
let mapLayers = [];
let mapInitialized = false;
const polygonCache = new Map();
let mapBounds = [];
const audioPlayers = new Map();
const warningRadarCache = new Map();

// ── Classification ──────────────────────────────────────────────
function tagsFromProps(props) {
  return [
    ...(props.parameters?.tornadoDetection || []),
    ...(props.parameters?.thunderstormDamageThreat || []),
    ...(props.parameters?.tornadoDamageThreat || []),
  ].map(t => String(t).toUpperCase());
}

function classifyWarning(props) {
  const ev   = (props.event || '').toUpperCase();
  const tags = tagsFromProps(props);
  const text = [
    props.headline || '',
    props.description || '',
    props.instruction || '',
  ].join(' ').toUpperCase();

  if (ev.includes('TORNADO') && !ev.includes('WATCH')) {
    if (tags.some(t => t.includes('CATASTROPHIC') || t.includes('EMERGENCY')))
      return { type: 'Tornado Warning', variant: 'emergency' };
    if (
      tags.some(t => t.includes('PARTICULARLY DANGEROUS') || t.includes('PDS') || t.includes('CONSIDERABLE')) ||
      text.includes('PARTICULARLY DANGEROUS SITUATION') ||
      text.includes('THIS IS A PARTICULARLY DANGEROUS SITUATION')
    )
      return { type: 'Tornado Warning', variant: 'pds' };
    if (tags.some(t => t.includes('OBSERVED')))
      return { type: 'Tornado Warning', variant: 'observed' };
    return { type: 'Tornado Warning', variant: 'base' };
  }
  if (ev.includes('SEVERE THUNDERSTORM') && !ev.includes('WATCH')) {
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

function classifyWatch(props) {
  const ev   = (props.event || '').toUpperCase();
  const tags = [...(props.parameters?.tornadoDamageThreat || [])].map(t => t.toUpperCase());
  const text = [
    props.headline || '',
    props.description || '',
    props.instruction || '',
  ].join(' ').toUpperCase();
  if (ev.includes('TORNADO WATCH')) {
    if (
      tags.some(t => t.includes('PARTICULARLY DANGEROUS') || t.includes('PDS')) ||
      text.includes('PARTICULARLY DANGEROUS SITUATION') ||
      text.includes('THIS IS A PARTICULARLY DANGEROUS SITUATION')
    )
      return { type: 'Tornado Watch', variant: 'pds' };
    return { type: 'Tornado Watch', variant: 'base' };
  }
  if (ev.includes('SEVERE THUNDERSTORM WATCH'))
    return { type: 'Severe Thunderstorm Watch', variant: 'base' };
  return null;
}

function extractOfficeCode(props) {
  const vtecEntries = props.parameters?.VTEC || props.parameters?.vtec || [];
  for (const entry of vtecEntries) {
    const match = String(entry).match(/\/O\.[A-Z]+\.(K[A-Z]{3})\./i);
    if (match) return match[1].toUpperCase();
  }
  const sender = String(props.senderName || props.sender || '').toUpperCase();
  const senderMatch = sender.match(/\b(K[A-Z]{3})\b/);
  return senderMatch ? senderMatch[1] : '';
}

function roundCoord(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function flattenCoordinates(coords, out = []) {
  if (!Array.isArray(coords)) return out;
  if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    out.push([Number(coords[0]), Number(coords[1])]);
    return out;
  }
  coords.forEach(part => flattenCoordinates(part, out));
  return out;
}

function warningCenter(geometry) {
  const points = flattenCoordinates(geometry?.coordinates);
  if (!points.length) return null;
  let lonSum = 0;
  let latSum = 0;
  for (const [lon, lat] of points) {
    lonSum += lon;
    latSum += lat;
  }
  return {
    lon: lonSum / points.length,
    lat: latSum / points.length,
  };
}

function extractRadarIdFromPointData(data) {
  const candidates = [
    data?.properties?.radarStation,
    data?.properties?.radarStationIdentifier,
    data?.properties?.nearestRadarStation,
    data?.radarStation,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'string') {
      const match = candidate.match(/\b[KTP][A-Z0-9]{3}\b/i) || candidate.match(/\/stations\/([A-Z0-9]+)$/i);
      if (match) return (match[1] || match[0]).toUpperCase();
    } else if (typeof candidate === 'object') {
      const raw = candidate.identifier || candidate.stationIdentifier || candidate.radarId || candidate['@id'] || candidate.id || '';
      const match = String(raw).match(/\b[KTP][A-Z0-9]{3}\b/i) || String(raw).match(/\/stations\/([A-Z0-9]+)$/i);
      if (match) return (match[1] || match[0]).toUpperCase();
    }
  }
  return '';
}

async function lookupRadarId(lat, lon) {
  const roundedLat = roundCoord(lat);
  const roundedLon = roundCoord(lon);
  const cacheKey = `${roundedLat},${roundedLon}`;
  let radarId = warningRadarCache.get(cacheKey);
  if (radarId !== undefined) return radarId || '';
  const res = await fetch(`https://api.weather.gov/points/${roundedLat},${roundedLon}`, {
    headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  radarId = extractRadarIdFromPointData(data);
  warningRadarCache.set(cacheKey, radarId || '');
  return radarId || '';
}

function extractCodProductUrl(filesHtml) {
  const match = String(filesHtml || '').match(/href=["']([^"']+)["']/i);
  return match ? match[1] : '';
}

function normalizeCountyName(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/\b(COUNTY|PARISH|BOROUGH|CENSUS AREA|MUNICIPALITY|CITY AND BOROUGH)\b/g, '')
    .replace(/\b[A-Z]{2}\b$/g, '')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countyNames(area) {
  return String(area || '')
    .replace(/;/g, ',')
    .split(',')
    .map(normalizeCountyName)
    .filter(Boolean);
}

function countyOverlapScore(a, b) {
  const aNames = countyNames(a);
  const bNames = countyNames(b);
  if (!aNames.length || !bNames.length) return 0;
  let score = 0;
  for (const nameA of aNames) {
    for (const nameB of bNames) {
      if (nameA === nameB || nameA.includes(nameB) || nameB.includes(nameA)) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

function classifyCodWarning(item) {
  const typeText = String(item?.warn_type || '').toUpperCase();
  const tornadoText = String(item?.tornado || '').toUpperCase();
  if (typeText === 'TORNADO') {
    if (tornadoText.includes('OBSERVED')) {
      return { type: 'Tornado Warning', variant: 'observed' };
    }
    return { type: 'Tornado Warning', variant: 'base' };
  }
  if (typeText === 'SEVERE THUNDERSTORM') {
    return { type: 'Severe Thunderstorm Warning', variant: 'base' };
  }
  return null;
}

function parseCodWarnings(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const item of items) {
    const cl = classifyCodWarning(item);
    if (!cl) continue;
    const cfg = CFG[cl.type][cl.variant];
    const issued = new Date((Number(item.time_begin_ts) || 0) * 1000 || Date.now());
    const expires = new Date((Number(item.time_end_ts) || 0) * 1000 || (Date.now() + 3_600_000));
    const counties = Array.isArray(item.counties) ? item.counties.filter(Boolean) : [];
    const area = counties.length ? counties.join(', ') : (item.office_plain || item.office || 'Unknown Area');
    const productUrl = extractCodProductUrl(item.files);
    const tornadoText = String(item.tornado || '').trim();
    const torPossible = /POSSIBLE/i.test(tornadoText);
    const torDetect = tornadoText && !torPossible ? tornadoText : null;
    const fallbackId = [
      cl.type,
      String(item.office || '').toUpperCase(),
      issued.getTime(),
      expires.getTime(),
      area,
      String(item.hail_size || item.hail || ''),
      String(item.wind_speed || item.wind || ''),
      tornadoText,
      String(item.files || ''),
    ].join('|');
    out.push({
      id: productUrl || fallbackId,
      type: cl.type,
      variant: cl.variant,
      cfg,
      issued,
      expires,
      area,
      officeCode: String(item.office || '').toUpperCase(),
      radarId: '',
      center: null,
      headline: `${cfg.label} until ${fmtTime(expires)}`,
      desc: '',
      instruction: '',
      rank: cfg.rank,
      hailSize: item.hail_size || item.hail || null,
      windGust: String(item.wind_speed || item.wind || '').replace(/\D/g, '') || null,
      damageThreat: null,
      torDetect,
      torPossible,
      source: 'cod',
    });
  }
  return out.sort(compareWarningsByPriority);
}

function enrichCodWarning(codWarning, nwsWarnings) {
  const office    = String(codWarning.officeCode || '').toUpperCase();
  const issuedMs  = codWarning.issued.getTime();
  const expiresMs = codWarning.expires.getTime();
  const matches   = nwsWarnings
    .filter(nws => nws.type === codWarning.type)
    .filter(nws => !office || String(nws.officeCode || '').toUpperCase() === office)
    .map(nws => ({
      nws,
      overlap:   countyOverlapScore(codWarning.area, nws.area),
      timeDelta: Math.abs(nws.issued.getTime() - issuedMs) + Math.abs(nws.expires.getTime() - expiresMs),
    }))
    .filter(c => c.overlap > 0 || c.timeDelta <= 10 * 60_000)
    .sort((a, b) => b.overlap - a.overlap || a.timeDelta - b.timeDelta);

  const best = matches[0]?.nws;
  if (!best) return codWarning;

  const combinedProps = {
    event: best.type,
    parameters: {
      thunderstormDamageThreat: best.damageThreat ? [best.damageThreat] : [],
      tornadoDetection:         best.torDetect    ? [best.torDetect]    : [],
      tornadoDamageThreat:      [],
    },
    headline:    best.headline    || '',
    description: best.desc        || '',
    instruction: best.instruction || '',
  };
  const reclassified = classifyWarning(combinedProps);

  const candidates = [
    codWarning,
    best,
    reclassified
      ? { variant: reclassified.variant, cfg: CFG[best.type][reclassified.variant], rank: CFG[best.type][reclassified.variant].rank }
      : null,
  ].filter(Boolean).sort((a, b) => (b.rank || 0) - (a.rank || 0));
  const winner = candidates[0];

  return {
    ...codWarning,
    variant:      winner.variant,
    cfg:          winner.cfg || CFG[best.type][winner.variant],
    rank:         winner.rank,
    radarId:      best.radarId      || codWarning.radarId      || '',
    center:       best.center       || codWarning.center       || null,
    headline:     best.headline     || codWarning.headline,
    desc:         best.desc         || codWarning.desc,
    instruction:  best.instruction  || codWarning.instruction,
    damageThreat: best.damageThreat || codWarning.damageThreat,
    torDetect:    best.torDetect    || codWarning.torDetect,
    torPossible:  Boolean(best.torPossible || codWarning.torPossible),
    nwsId:        best.id          || codWarning.nwsId,
    source:       codWarning.source,
  };
}

// ── Parse warnings ──────────────────────────────────────────────
function parseWarnings(geojson) {
  if (!geojson?.features) return [];
  const out = [];
  for (const feat of geojson.features) {
    const p  = feat.properties || {};
    const cl = classifyWarning(p);
    if (!cl) continue;
    const cfg     = CFG[cl.type][cl.variant];
    const issued  = new Date(p.effective || p.onset || p.sent || Date.now());
    const expires = new Date(p.expires || Date.now() + 3_600_000);
    out.push({
      id:           p.id || feat.id || Math.random().toString(36),
      type:         cl.type,
      variant:      cl.variant,
      cfg,
      issued,
      expires,
      area:         p.areaDesc || 'Unknown Area',
      officeCode:   extractOfficeCode(p),
      radarId:      '',
      center:       warningCenter(feat.geometry),
      headline:     p.headline || `${cfg.label} until ${fmtTime(expires)}`,
      desc:         p.description || '',
      instruction:  p.instruction || '',
      rank:         cfg.rank,
      hailSize:     p.parameters?.maxHailSize?.[0] || null,
      windGust:     p.parameters?.maxWindGust?.[0]?.replace(/\D/g, '') || null,
      damageThreat: p.parameters?.thunderstormDamageThreat?.[0] || null,
      torDetect:    p.parameters?.tornadoDetection?.[0] || null,
      torPossible:  tagsFromProps(p).some(t => t.includes('TORNADO POSSIBLE') || t.includes('TORNADOES POSSIBLE')),
    });
  }
  out.sort((a, b) => {
    const aExp = (a.expires - Date.now()) < 600000;
    const bExp = (b.expires - Date.now()) < 600000;
    if (aExp && !bExp) return 1;
    if (!aExp && bExp) return -1;
    if (a.isNew && !b.isNew) return -1;
    if (!a.isNew && b.isNew) return 1;
    return b.rank - a.rank || b.expires - a.expires;
  });
  return out;
}

function textFromNode(parent, selectors) {
  for (const selector of selectors) {
    const node = parent.querySelector(selector);
    if (node?.textContent) return node.textContent.trim();
  }
  return '';
}

function parseCapWarnings(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const entries = [...doc.querySelectorAll('entry')];
  const out = [];
  for (const entry of entries) {
    const event = textFromNode(entry, ['cap\\:event', 'event']);
    if (!event || !['TORNADO WARNING', 'SEVERE THUNDERSTORM WARNING'].includes(event.toUpperCase())) continue;
    const props = {
      event,
      headline: textFromNode(entry, ['cap\\:headline', 'headline']),
      description: textFromNode(entry, ['cap\\:summary', 'summary', 'cap\\:description', 'description']),
      instruction: textFromNode(entry, ['cap\\:instruction', 'instruction']),
      senderName: textFromNode(entry, ['cap\\:senderName', 'senderName', 'author name']),
      areaDesc: textFromNode(entry, ['cap\\:areaDesc', 'areaDesc']),
      effective: textFromNode(entry, ['cap\\:effective', 'effective']),
      onset: textFromNode(entry, ['cap\\:onset', 'onset']),
      expires: textFromNode(entry, ['cap\\:expires', 'expires']),
      sent: textFromNode(entry, ['published']),
      id: textFromNode(entry, ['id']),
      parameters: {},
    };
    const tornadoDetection = [];
    const thunderstormDamageThreat = [];
    const tornadoDamageThreat = [];
    entry.querySelectorAll('cap\\:parameter, parameter').forEach(param => {
      const valueName = textFromNode(param, ['valueName']);
      const value = textFromNode(param, ['value']);
      if (!valueName || !value) return;
      const key = valueName.toLowerCase();
      if (key.includes('tornadodetection')) tornadoDetection.push(value);
      if (key.includes('thunderstormdamagethreat')) thunderstormDamageThreat.push(value);
      if (key.includes('tornadodamagethreat')) tornadoDamageThreat.push(value);
    });
    if (tornadoDetection.length) props.parameters.tornadoDetection = tornadoDetection;
    if (thunderstormDamageThreat.length) props.parameters.thunderstormDamageThreat = thunderstormDamageThreat;
    if (tornadoDamageThreat.length) props.parameters.tornadoDamageThreat = tornadoDamageThreat;
    const cl = classifyWarning(props);
    if (!cl) continue;
    const cfg = CFG[cl.type][cl.variant];
    const issued = new Date(props.effective || props.onset || props.sent || Date.now());
    const expires = new Date(props.expires || Date.now() + 3_600_000);
    out.push({
      id: props.id || `cap-${event}-${issued.toISOString()}-${props.areaDesc}`,
      type: cl.type,
      variant: cl.variant,
      cfg,
      issued,
      expires,
      area: props.areaDesc || 'Unknown Area',
      officeCode: extractOfficeCode(props),
      radarId: '',
      center: null,
      headline: props.headline || `${cfg.label} until ${fmtTime(expires)}`,
      desc: props.description || '',
      instruction: props.instruction || '',
      rank: cfg.rank,
      hailSize: null,
      windGust: null,
      damageThreat: props.parameters?.thunderstormDamageThreat?.[0] || props.parameters?.tornadoDamageThreat?.[0] || null,
      torDetect: props.parameters?.tornadoDetection?.[0] || null,
      torPossible: tagsFromProps(props).some(t => t.includes('TORNADO POSSIBLE') || t.includes('TORNADOES POSSIBLE')),
      source: 'cap',
    });
  }
  return out;
}

function mergeWarnings(primaryWarnings, capWarnings) {
  const merged = new Map();
  for (const warning of [...capWarnings, ...primaryWarnings]) {
    const key = warningIdentityKey(warning);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, warning);
      continue;
    }
    const existingScore = (existing.source === 'api' ? 2 : 0) + existing.rank;
    const warningScore = (warning.source === 'api' ? 2 : 0) + warning.rank;
    if (warningScore > existingScore || (warningScore === existingScore && warning.issued > existing.issued)) {
      merged.set(key, { ...existing, ...warning });
    }
  }
  return [...merged.values()].sort(compareWarningsByPriority);
}

// ── Parse watches ──────────────────────────────────────────────
function parseWatches(geojson) {
  if (!geojson?.features) return [];
  const out = [];
  for (const feat of geojson.features) {
    const p  = feat.properties || {};
    const cl = classifyWatch(p);
    if (!cl) continue;
    const cfg     = WATCH_CFG[cl.type][cl.variant];
    const issued  = new Date(p.effective || p.onset || p.sent || Date.now());
    const expires = new Date(p.expires || Date.now() + 3_600_000);
    const watchNumber = extractWatchNumber(p);
    out.push({
      id:      p.id || feat.id || Math.random().toString(36),
      type:    cl.type,
      variant: cl.variant,
      cfg,
      watchNumber,
      issued,
      expires,
      area:    p.areaDesc || 'Unknown Area',
      headline: p.headline || `${cfg.label} until ${fmtTime(expires)}`,
      desc:    p.description || '',
      instruction: p.instruction || '',
      rank:    cfg.rank,
    });
  }
  out.sort((a, b) => {
    if (a.isNew && !b.isNew) return -1;
    if (!a.isNew && b.isNew) return 1;
    return b.rank - a.rank || b.expires - a.expires;
  });
  return out;
}

// ── Parse MDs ──────────────────────────────────────────────────
function parseMDs(data) {
  if (!Array.isArray(data)) return [];
  return data.map(md => ({
    id:        String(md.mdnum || md.id || Math.random()),
    number:    md.mdnum || md.id || '???',
    area:      md.areas || md.concerning || 'See full discussion',
    concerning: md.concerning || null,
    watchProb: md.watch_prob || md.wfop || null,
    issued:    md.utc_issue ? new Date(md.utc_issue) : new Date(),
    expires:   md.utc_expire ? new Date(md.utc_expire) : new Date(Date.now() + 3_600_000),
    text:      md.discussion || md.text || '',
    url:       md.url || null,
  })).sort((a, b) => b.issued - a.issued);
}

// ── Fetch all ──────────────────────────────────────────────────
async function fetchAll() {
  await Promise.all([fetchWarnings(), fetchWatches(), fetchMDs(), fetchSpotterReports()]);
  lastUpdate  = new Date();
  statusState = 'live';
  renderAll();
}

async function fetchWithPagination(startUrl, signal) {
  let allFeatures = [];
  let url = startUrl;
  while (url) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' },
      signal: signal || null,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allFeatures = allFeatures.concat(data.features || []);
    url = data.pagination?.next || null;
  }
  return { features: allFeatures };
}

async function fetchWarnings() {
  try {
    // ── Preserve test warnings across real API fetches ──────────
    const testWarnings = warnings.filter(w => w.source === 'test');

    const previousWarnings = new Map(warnings.map(w => [w.id, w]));
    const previousWarningsByKey = new Map(
      warnings.map(w => [warningIdentityKey(w), w])
    );

    const [codItems, warningSets] = await Promise.all([
      fetch(COD_WARN_URL, {
        headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' }
      }).then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      }),
      Promise.all(WARN_URLS.map(url => fetchWithPagination(url))),
    ]);
    const capRes = '';

    const featureMap = new Map();
    warningSets.forEach(set => {
      (set.features || []).forEach(feature => {
        const id = feature?.properties?.id || feature?.id;
        if (!id) return;
        featureMap.set(id, feature);
      });
    });

    const parsed = parseWarnings({
      features: [...featureMap.values()]
    }).map(w => ({ ...w, source: 'api' }));

    const capWarnings = capRes ? parseCapWarnings(capRes) : [];
    const nwsWarnings = mergeWarnings(parsed, capWarnings);
    const codWarnings = parseCodWarnings(codItems);
    const enrichedCodWarnings = codWarnings.map(w => enrichCodWarning(w, nwsWarnings));

    const matchedNwsWarnings = new Set();
    for (const cod of codWarnings) {
      const office = String(cod.officeCode || '').toUpperCase();
      for (const nws of nwsWarnings) {
        if (nws.type !== cod.type) continue;
        if (office && String(nws.officeCode || '').toUpperCase() !== office) continue;
        if (countyOverlapScore(cod.area, nws.area) > 0) {
          matchedNwsWarnings.add(nws.id);
        }
      }
    }
    const supplementalNwsWarnings = nwsWarnings.filter(w => !matchedNwsWarnings.has(w.id));
    const merged = [...enrichedCodWarnings, ...supplementalNwsWarnings];

    // Re-inject test warnings; skip any whose ID now exists in live data
    const liveIds = new Set(merged.map(w => w.id));
    const preserved = testWarnings.filter(w => !liveIds.has(w.id));

    const now = Date.now();

    warnings = [...merged, ...preserved].map(w => {
      // Test warnings are frozen — don't touch their state
      if (w.source === 'test') return { ...w, isNew: now < w.flashUntil };

      const previous =
        previousWarnings.get(w.id) ||
        previousWarningsByKey.get(warningIdentityKey(w));
      const issuedMs = new Date(w.issued).getTime();
      const flashUntil = previous?.flashUntil || (issuedMs + 90_000);

      return {
        ...w,
        radarId: w.radarId || previous?.radarId || '',
        center: w.center || previous?.center || null,
        flashUntil,
        isNew: now < flashUntil,
      };
    }).sort(compareWarningsByPriority);

    knownWarnIds = new Set(merged.map(w => w.id));

    playSpecialWarningSounds(previousWarnings, warnings);
  } catch (e) {
    statusState = 'error';
    errorMsg = e?.message || String(e);
    console.error('fetchWarnings error:', e);
  }
}

async function fetchWatches() {
  try {
    const previousById = new Map(watches.map(w => [w.id, w]));
    const previousByNumber = new Map(watches.filter(w => w.watchNumber).map(w => [w.watchNumber, w]));
    const previousWatchKeys = new Set(watches.map(warningIdentityKey));
    const controller = new AbortController();
    const watchTimeout = setTimeout(() => controller.abort(), 8000);
    const data = await fetchWithPagination(WATCH_URL, controller.signal).finally(() => clearTimeout(watchTimeout));
    const parsed = parseWatches(data);
    watches = parsed.map(w => {
      const existing = previousById.get(w.id) || (w.watchNumber ? previousByNumber.get(w.watchNumber) : null);
      const variant = existing?.variant === 'pds' && w.type === 'Tornado Watch' ? 'pds' : w.variant;
      const cfg = WATCH_CFG[w.type][variant];
      return {
        ...w,
        variant,
        cfg,
        isNew: !knownWatchIds.has(w.id) && !previousWatchKeys.has(warningIdentityKey(w)) && (Date.now() - w.issued.getTime() < 90_000),
      };
    });
    knownWatchIds = new Set(parsed.map(w => w.id));
    watches.forEach(queueWatchMetaFetch);
  } catch (e) {
    console.warn('Watch fetch error:', e.message);
  }
}

async function fetchMDs() {
  try {
    const res = await fetch('https://www.spc.noaa.gov/products/md/mdlist.json', {
      headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const parsed = parseMDs(data);
    mds = parsed.map(m => {
      const existing = mds.find(e => e.id === m.id);
      return {
        ...m,
        isNew: !knownMdIds.has(m.id),
        text:       existing ? existing.text       : '',
        concerning: existing ? existing.concerning : m.concerning,
        watchProb:  existing ? existing.watchProb  : null,
      };
    });
    knownMdIds = new Set(parsed.map(m => m.id));
    mds.forEach(queueMdMetaFetch);
  } catch (e) {
    console.warn('MD fetch error:', e.message);
  }
}

function normalizeReportType(type) {
  const upper = String(type || '').toUpperCase();
  if (upper.includes('TORNADO')) return 'Tornado';
  if (upper.includes('FUNNEL')) return 'Funnel Cloud';
  if (upper.includes('WALL CLOUD')) return 'Wall Cloud';
  return null;
}

function parseSpotterReports(feedText) {
  const matches = [...String(feedText || '').matchAll(/Icon:\s*([-\d.]+),([-\d.]+),\d+,(\d+),(\d+),"([\s\S]*?)"/g)];
  return matches.map(match => {
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    const lines = match[5].replace(/\\n/g, '\n').split('\n');
    const reporter = (lines.find(line => line.startsWith('Reported By:')) || '').replace('Reported By:', '').trim();
    const rawType = (lines[1] || '').trim();
    const type = normalizeReportType(rawType);
    if (!type) return null;
    const timeLine = lines.find(line => line.startsWith('Time:')) || '';
    const timeText = timeLine.replace('Time:', '').trim();
    const issued = timeText ? new Date(timeText) : new Date();
    const notesLine = lines.find(line => line.startsWith('Notes:'));
    const notes = notesLine ? notesLine.replace('Notes:', '').trim() : '';
    const extras = lines
      .filter(line => line && !line.startsWith('Reported By:') && !line.startsWith('Time:') && !line.startsWith('Notes:') && line.trim() !== rawType)
      .join('\n')
      .trim();
    return {
      id: `${type}|${timeText}|${lat}|${lon}|${reporter}`,
      type,
      rawType,
      reporter,
      issued,
      notes,
      extras,
      lat,
      lon,
      radarId: '',
      isNew: false,
    };
  }).filter(Boolean).sort((a, b) => b.issued - a.issued);
}

async function fetchSpotterReports() {
  if (Date.now() - lastSpotterFetch < 15_000) return;
  lastSpotterFetch = Date.now();
  try {
    const res = await fetch(SPOTTER_REPORTS_URL, {
      headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed = parseSpotterReports(text).filter(report => (Date.now() - report.issued.getTime()) <= 20 * 60_000);
    const knownIds = new Set(spotterReports.map(r => r.id));
    spotterReports = parsed.map(report => ({
      ...report,
      isNew: !knownIds.has(report.id) && (Date.now() - report.issued.getTime() < 90_000),
    }));
    playSpotterReportSounds(spotterReports);
  } catch (e) {
    console.warn('Spotter report fetch error:', e.message);
  }
}

// ── Helpers ──────────────────────────────────────────────────────
function fmtTime(d)    { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function fmtTimeSec(d) { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function minsLeft(exp) { return Math.max(0, Math.floor((exp - Date.now()) / 60_000)); }
function timeLeft(exp) {
  const total = Math.max(0, Math.floor((exp - Date.now()) / 60_000));
  const hrs  = Math.floor(total / 60);
  const mins = total % 60;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}
function pctElapsed(iss, exp) {
  return Math.min(100, Math.max(0, ((Date.now() - iss) / (exp - iss)) * 100)).toFixed(1);
}

function compareWarningsByPriority(a, b) {
  const aExpSoon = (a.expires - Date.now()) < 600000;
  const bExpSoon = (b.expires - Date.now()) < 600000;
  if (aExpSoon && !bExpSoon) return 1;
  if (!aExpSoon && bExpSoon) return -1;
  if (a.isNew && !b.isNew) return -1;
  if (!a.isNew && b.isNew) return 1;
  return b.rank - a.rank || b.expires - a.expires;
}

function normalizeAlertId(id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  return raw
    .replace(/^https?:\/\/api\.weather\.gov\/alerts\//i, '')
    .replace(/^urn:oid:/i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

function warningIdentityKey(item) {
  const normalizedId = normalizeAlertId(item.id);
  if (normalizedId) return normalizedId;
  return [
    item.type || '',
    item.area || '',
    item.issued instanceof Date ? item.issued.toISOString() : String(item.issued || ''),
    item.expires instanceof Date ? item.expires.toISOString() : String(item.expires || ''),
    item.headline || '',
  ].join('|');
}

function getAudioPlayer(url) {
  let audio = audioPlayers.get(url);
  if (!audio) {
    audio = new Audio(url);
    audio.preload = 'auto';
    audio.volume = 1;
    audio.addEventListener('ended', () => {
      audio.currentTime = 0;
    });
    audioPlayers.set(url, audio);
  }
  return audio;
}

function stopAudio(url) {
  const audio = audioPlayers.get(url);
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
}

function playAudio(url, options = {}) {
  const { toggle = false } = options;
  const audio = getAudioPlayer(url);
  if (toggle && !audio.paused) {
    stopAudio(url);
    return;
  }
  audio.pause();
  audio.currentTime = 0;
  const played = audio.play();
  if (played && typeof played.catch === 'function') {
    played.catch(err => console.warn('Audio playback failed:', err.message));
  }
}

function warningSoundSignature(warning) {
  return [
    warning.type,
    warning.variant,
    warning.area,
    warning.headline,
    warning.issued instanceof Date ? warning.issued.toISOString() : String(warning.issued || ''),
    warning.expires instanceof Date ? warning.expires.toISOString() : String(warning.expires || ''),
  ].join('|');
}

function shouldPlayEasForWarning(warning) {
  return (
    warning.type === 'Tornado Warning' &&
    ['pds', 'emergency'].includes(warning.variant)
  );
}

function shouldPlayWeaForWarning(warning) {
  return warning.type === 'Severe Thunderstorm Warning' && warning.variant === 'destructive';
}

function playSpecialWarningSounds(previousWarnings, nextWarnings) {
  if (!warningAudioPrimed) {
    warningAudioPrimed = true;
    soundedWarningKeys = new Set(nextWarnings.map(warningSoundSignature));
    return;
  }
  const activeSoundKeys = new Set();
  for (const warning of nextWarnings) {
    const previous = previousWarnings.get(warning.id);
    const soundKey = warningSoundSignature(warning);
    activeSoundKeys.add(soundKey);
    if (soundedWarningKeys.has(soundKey)) continue;
    const isNewArrival = !previous;
    const upgradedToTarget = previous && previous.variant !== warning.variant;
    const issuedRecently = (Date.now() - warning.issued.getTime()) <= 120_000;
    if ((!isNewArrival && !upgradedToTarget) || !issuedRecently) continue;
    if (shouldPlayEasForWarning(warning)) {
      soundedWarningKeys.add(soundKey);
      playAudio(TORE_SOUND_URL);
      continue;
    }
    if (shouldPlayWeaForWarning(warning)) {
      soundedWarningKeys.add(soundKey);
      playAudio(WEA_SOUND_URL);
    }
  }
  soundedWarningKeys = new Set([...soundedWarningKeys].filter(key => activeSoundKeys.has(key)));
}

function playSpotterReportSounds(nextReports) {
  const activeReportIds = new Set(nextReports.map(report => report.id));
  for (const report of nextReports) {
    if (!report.isNew || soundedReportIds.has(report.id)) continue;
    soundedReportIds.add(report.id);
    playAudio(SPOTTER_SOUND_URL);
  }
  soundedReportIds = new Set([...soundedReportIds].filter(id => activeReportIds.has(id)));
}

function handleSoundTestHotkeys(event) {
  const key = String(event.key || '').toUpperCase();
  const code = String(event.code || '').toUpperCase();
  const hasCtrl = event.ctrlKey;
  if (hasCtrl && (key === 'G1' || code === 'G1' || key === 'F13' || code === 'F13' || code === 'DIGIT1')) {
    event.preventDefault();
    playAudio(TORE_SOUND_URL, { toggle: true });
    return;
  }
  if (hasCtrl && (key === 'G2' || code === 'G2' || key === 'F14' || code === 'F14' || code === 'DIGIT2')) {
    event.preventDefault();
    playAudio(WEA_SOUND_URL, { toggle: true });
  }
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function saveScrolls(listEl) {
  const s = { list: listEl.scrollTop, bodies: {} };
  listEl.querySelectorAll('[data-id]').forEach(el => {
    const inner = el.querySelector('.warn-body-inner, .watch-body-inner, .md-body-inner');
    if (inner) s.bodies[el.dataset.id] = inner.scrollTop;
  });
  return s;
}

function restoreScrolls(listEl, s) {
  listEl.scrollTop = s.list;
  listEl.querySelectorAll('[data-id]').forEach(el => {
    const inner = el.querySelector('.warn-body-inner, .watch-body-inner, .md-body-inner');
    if (inner && Object.prototype.hasOwnProperty.call(s.bodies, el.dataset.id)) {
      inner.scrollTop = s.bodies[el.dataset.id];
    }
  });
}

function parseMDWatchProb(text) {
  const match = String(text || '').match(/PROBABILITY OF WATCH ISSUANCE[^\d]*(\d+)\s*PERCENT/i);
  return match ? match[1] : null;
}

function extractWatchNumber(props) {
  const raw = [
    props.id || '',
    props.headline || '',
    props.description || '',
  ].join(' ');
  const match = raw.match(/\bTO\.A\.(\d{4})\b/i)
    || raw.match(/\b(?:TORNADO|SEVERE THUNDERSTORM) WATCH(?: NUMBER)?\s+(\d{1,4})\b/i);
  return match ? match[1].padStart(4, '0') : null;
}

function isPDSWatchText(text) {
  const upper = String(text || '').toUpperCase();
  return upper.includes('THIS IS A PARTICULARLY DANGEROUS SITUATION')
    || upper.includes('PARTICULARLY DANGEROUS SITUATION');
}

async function fetchWatchMeta(watch) {
  if (!watch?.watchNumber) return;
  watchMetaLoading.add(watch.id);
  try {
    const res = await fetch(`https://www.spc.noaa.gov/products/watch/ww${watch.watchNumber}.html`, {
      headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const isPDS = isPDSWatchText(html);
    if (watch.type === 'Tornado Watch') {
      const nextVariant = isPDS ? 'pds' : 'base';
      if (watch.variant !== nextVariant) {
        watch.variant = nextVariant;
        watch.cfg = WATCH_CFG[watch.type][nextVariant];
        renderWatches();
      }
    }
  } catch (e) {
    console.warn(`Watch meta fetch error (${watch.watchNumber}):`, e.message);
  } finally {
    watchMetaLoading.delete(watch.id);
  }
}

function queueWatchMetaFetch(watch) {
  if (!watch || watch.type !== 'Tornado Watch' || !watch.watchNumber || watchMetaLoading.has(watch.id)) return;
  void fetchWatchMeta(watch);
}

function parseMDConcerning(text) {
  const match = String(text || '').match(/\bCONCERNING\.\.\.([^\n\r]+)/i);
  return match ? match[1].trim() : null;
}

async function fetchMDs() {
  try {
    const res = await fetch('https://www.spc.noaa.gov/products/md/', {
      headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const links = [...doc.querySelectorAll('a[href*="md"]')];
    const parsedById = new Map();
    for (const link of links) {
      const match = link.href.match(/md(\d{4})\.html/);
      if (!match) continue;
      const num = match[1];
      const text = link.textContent.trim();
      if (parsedById.has(num)) continue;
      parsedById.set(num, {
        id:        num,
        number:    num,
        area:      text || `Mesoscale Discussion ${num}`,
        concerning: null,
        watchProb: null,
        issued:    new Date(),
        expires:   new Date(Date.now() + 3_600_000),
        text:      '',
        url:       `https://www.spc.noaa.gov/products/md/md${num}.html`,
      });
    }
    const parsed = [...parsedById.values()];
    mds = parsed.map(m => {
      const existing = mds.find(e => e.id === m.id);
      return {
        ...m,
        isNew: !knownMdIds.has(m.id),
        text:       existing ? existing.text       : '',
        concerning: existing ? existing.concerning : m.concerning,
        watchProb:  existing ? existing.watchProb  : null,
      };
    });
    knownMdIds = new Set(parsed.map(m => m.id));
    mds.forEach(function(md) { if (typeof queueMdMetaFetch === 'function') queueMdMetaFetch(md); });
  } catch (e) {
    console.warn('MD fetch error:', e.message);
  }
}

async function fetchWarningRadar(warning) {
  if (!warning?.center) return;
  warningRadarLoading.add(warning.id);
  try {
    const radarId = await lookupRadarId(warning.center.lat, warning.center.lon);
    if (warning.radarId !== (radarId || '')) {
      warning.radarId = radarId || '';
      renderWarnings();
    }
  } catch (e) {
    console.warn(`Warning radar fetch error (${warning.id}):`, e.message);
  } finally {
    warningRadarLoading.delete(warning.id);
  }
}

function queueWarningRadarFetch(warning) {
  if (!warning || warning.radarId || !warning.center || warningRadarLoading.has(warning.id)) return;
  void fetchWarningRadar(warning);
}

async function fetchReportRadar(report) {
  if (!report) return;
  reportRadarLoading.add(report.id);
  try {
    const radarId = await lookupRadarId(report.lat, report.lon);
    if (report.radarId !== radarId) {
      report.radarId = radarId;
      renderReports();
    }
  } catch (e) {
    console.warn(`Report radar fetch error (${report.id}):`, e.message);
  } finally {
    reportRadarLoading.delete(report.id);
  }
}

function queueReportRadarFetch(report) {
  if (!report || report.radarId || reportRadarLoading.has(report.id)) return;
  void fetchReportRadar(report);
}

function warningRenderHash() {
  return warnings.map(w => `${w.id}:${w.radarId || ''}:${w.isNew ? 1 : 0}:${expanded['w_' + w.id] ? 1 : 0}`).join(',');
}

function watchRenderHash() {
  return watches.map(w => `${w.id}:${w.variant}:${w.isNew ? 1 : 0}:${expanded['wt_' + w.id] ? 1 : 0}`).join(',');
}

function mdRenderHash() {
  return mds.map(m => `${m.id}:${m.isNew ? 1 : 0}:${expanded['md_' + m.id] ? 1 : 0}:${m.concerning || ''}:${m.watchProb || ''}:${m.text}`).join(',');
}

function reportRenderHash() {
  return spotterReports.map(r => `${r.id}:${r.radarId || ''}:${r.isNew ? 1 : 0}:${expanded['rp_' + r.id] ? 1 : 0}`).join(',');
}

// ── Warning row builder ──────────────────────────────────────────
function buildWarningRow(w) {
  const cfg       = w.cfg;
  const isExp     = !!expanded['w_' + w.id];
  const mins      = minsLeft(w.expires);
  const pct       = pctElapsed(w.issued.getTime(), w.expires.getTime());
  const minsClass = mins < 15 ? 'critical' : mins < 30 ? 'warning' : 'ok';
  const rowAnim   = w.isNew && !isExp ? 'animation:rowBlink 0.75s step-start infinite;' : '';
  const fading    = mins < 10 ? 'opacity:0.4;' : '';
  const dotHtml   = w.isNew ? `<span class="blink-dot" style="background:${cfg.color};"></span>` : '';

  const bodyHtml = isExp ? (() => {
    const desc = (w.desc || '').slice(0, 3000);
    const inst = (w.instruction || '').slice(0, 1500);
    return `
      <div class="warn-body" style="border-top-color:${cfg.border}33;">
        <div class="warn-body-inner">
          <div class="eas-headline" style="color:${cfg.color};">...${esc(w.headline.slice(0,120)).toUpperCase()}...</div>
          <div class="eas-times">ISSUED:  ${w.issued.toLocaleString().toUpperCase()}\nEXPIRES: ${w.expires.toLocaleString().toUpperCase()}</div>
          <div style="margin-bottom:6px;border-bottom:1px solid #1a1a1a;padding-bottom:6px;color:#ccc;">
            ${w.damageThreat ? `<div>THUNDERSTORM DAMAGE THREAT...${esc(w.damageThreat.toUpperCase())}</div>` : ''}
            ${w.hailSize     ? `<div>MAX HAIL SIZE...${esc(w.hailSize)} IN</div>` : ''}
            ${w.windGust     ? `<div>MAX WIND GUST...${esc(w.windGust)} MPH</div>` : ''}
            ${w.torPossible  ? `<div>TORNADO POSSIBLE...YES</div>` : ''}
            ${w.torDetect    ? `<div>TORNADO DETECTION...${esc(w.torDetect.toUpperCase())}</div>` : ''}
          </div>
          ${desc ? `<div class="eas-desc">${esc(desc)}</div>` : ''}
          ${inst ? `<div class="eas-action">PRECAUTIONARY/PREPAREDNESS ACTIONS...\n${esc(inst)}</div>` : ''}
        </div>
      </div>`;
  })() : '';

  return `
    <div class="warn-row" data-id="${esc(w.id)}" data-kind="warn"
         style="border-left:3px solid ${cfg.border};background:${isExp ? '#0e0e0e' : cfg.bg};${rowAnim}${fading}">
      <div class="warn-header">
        <div class="warn-top">
          ${dotHtml}
          <span class="warn-label" style="color:${cfg.color};">${esc(cfg.label)}</span>
          ${(w.radarId || w.officeCode) ? `<span class="warn-office" style="color:${cfg.color};">${esc(w.radarId || w.officeCode)}</span>` : ''}
          <span class="warn-area">${esc(w.area)}</span>
          <span class="warn-chevron">${isExp ? '▲' : '▼'}</span>
        </div>
        <div class="warn-tags">
          ${w.hailSize     ? `<span class="tag tag-hail">HAIL ${esc(w.hailSize)}"</span>` : ''}
          ${w.windGust     ? `<span class="tag tag-wind">WIND ${esc(w.windGust)} MPH</span>` : ''}
          ${w.damageThreat ? `<span class="tag tag-damage">${esc(w.damageThreat)}</span>` : ''}
          ${w.torPossible  ? `<span class="tag tag-tor">TOR POSSIBLE</span>` : ''}
          ${w.torDetect    ? `<span class="tag tag-tor">${esc(w.torDetect)}</span>` : ''}
        </div>
        <div class="timebar-labels">
          <span>ISS ${esc(fmtTime(w.issued))}</span>
          <span class="timebar-mins ${minsClass}">${timeLeft(w.expires)} LEFT</span>
          <span>EXP ${esc(fmtTime(w.expires))}</span>
        </div>
        <div class="timebar-track">
          <div class="timebar-fill" style="width:${pct}%;"></div>
        </div>
      </div>
      ${bodyHtml}
    </div>`;
}

// ── Watch row builder ────────────────────────────────────────────
function buildWatchRow(w) {
  const cfg       = w.cfg;
  const isExp     = !!expanded['wt_' + w.id];
  const mins      = minsLeft(w.expires);
  const pct       = pctElapsed(w.issued.getTime(), w.expires.getTime());
  const minsClass = mins < 15 ? 'critical' : mins < 30 ? 'warning' : 'ok';
  const rowAnim   = w.isNew && !isExp ? 'animation:rowBlink 0.75s step-start infinite;' : '';
  const fading    = mins < 10 ? 'opacity:0.4;' : '';
  const dotHtml   = w.isNew ? `<span class="blink-dot" style="background:${cfg.color};"></span>` : '';
  const pdsTag    = w.variant === 'pds' ? '<span class="tag tag-pds">PDS</span>' : '';

  const bodyHtml = isExp ? (() => {
    const desc = (w.desc || '').slice(0, 3000);
    const inst = (w.instruction || '').slice(0, 1500);
    return `
      <div class="watch-body" style="border-top-color:${cfg.border}33;">
        <div class="watch-body-inner">
          <div class="eas-headline" style="color:${cfg.color};">...${esc(w.headline.slice(0,120)).toUpperCase()}...</div>
          <div class="eas-times">ISSUED:  ${w.issued.toLocaleString().toUpperCase()}\nEXPIRES: ${w.expires.toLocaleString().toUpperCase()}</div>
          ${desc ? `<div class="eas-desc">${esc(desc)}</div>` : ''}
          ${inst ? `<div class="eas-action">PRECAUTIONARY/PREPAREDNESS ACTIONS...\n${esc(inst)}</div>` : ''}
        </div>
      </div>`;
  })() : '';

  return `
    <div class="watch-row" data-id="${esc(w.id)}" data-kind="watch"
         style="border-left:3px solid ${cfg.border};background:${isExp ? '#0e0e0e' : cfg.bg};${rowAnim}${fading}">
      <div class="watch-header">
        <div class="watch-top">
          ${dotHtml}
          <span class="watch-label" style="color:${cfg.color};">${esc(cfg.label)}</span>
          ${w.watchNumber ? `<span class="watch-number" style="color:${cfg.color};">#${esc(String(Number(w.watchNumber)))}</span>` : ''}
          <span class="watch-area">${esc(w.area)}</span>
          <span class="watch-chevron">${isExp ? '▲' : '▼'}</span>
        </div>
        ${pdsTag ? `<div class="warn-tags">${pdsTag}</div>` : ''}
        <div class="timebar-labels">
          <span>ISS ${esc(fmtTime(w.issued))}</span>
          <span class="timebar-mins ${minsClass}">${timeLeft(w.expires)} LEFT</span>
          <span>EXP ${esc(fmtTime(w.expires))}</span>
        </div>
        <div class="timebar-track">
          <div class="timebar-fill" style="width:${pct}%;"></div>
        </div>
      </div>
      ${bodyHtml}
    </div>`;
}

// ── MD row builder ───────────────────────────────────────────────
function buildMDRow(md) {
  const isExp   = !!expanded['md_' + md.id];
  const dotHtml = md.isNew ? `<span class="blink-dot" style="background:#00aaff;"></span>` : '';
  const rowAnim = md.isNew && !isExp ? 'animation:rowBlink 0.75s step-start infinite;' : '';

  const bodyHtml = isExp ? `
    <div class="md-body">
      <div class="md-body-inner">
        <div style="color:#00aaff;font-weight:700;margin-bottom:5px;">SPC MESOSCALE DISCUSSION #${esc(String(md.number))}</div>
        <div style="color:#555;margin-bottom:5px;font-size:12px;">ISSUED: ${md.issued.toLocaleString().toUpperCase()}</div>
        ${md.watchProb ? `<div style="color:#ffaa00;margin-bottom:5px;">WATCH PROBABILITY: ${esc(String(md.watchProb))}%</div>` : ''}
        <div style="color:#aaa;">${esc(md.text || 'Full text not available. Visit spc.noaa.gov for details.')}</div>
      </div>
    </div>` : '';

  return `
    <div class="md-row" data-id="${esc(md.id)}" data-kind="md" style="${rowAnim}">
      <div class="md-header">
        <div class="md-top">
          ${dotHtml}
          <span class="md-number">MD #${esc(String(md.number))}</span>
          <span class="md-area">${esc(md.area)}</span>
          <span class="md-chevron">${isExp ? '▲' : '▼'}</span>
        </div>
        ${md.concerning ? `<div class="md-watch-prob">CONCERNING: ${esc(md.concerning.toUpperCase())}</div>` : ''}
        ${md.watchProb ? `<div class="md-watch-prob">WATCH PROB: ${esc(String(md.watchProb))}%</div>` : ''}
      </div>
      ${bodyHtml}
    </div>`;
}

function buildReportRow(report) {
  const isExp = !!expanded['rp_' + report.id];
  const rowAnim = report.isNew && !isExp ? 'animation:rowBlink 0.75s step-start infinite;' : '';
  const reportTheme = report.type === 'Tornado'
    ? { color: '#ff4d4d', border: '#ff0000', bg: '#220606' }
    : report.type === 'Funnel Cloud'
      ? { color: '#ff9900', border: '#ff9900', bg: '#221406' }
      : { color: '#ffd400', border: '#ffd400', bg: '#222006' };
  const dotHtml = report.isNew ? `<span class="blink-dot" style="background:${reportTheme.color};"></span>` : '';
  const bodyHtml = isExp ? `
    <div class="report-body" style="border-top-color:${reportTheme.border}33;">
      <div class="report-body-inner">
        <div class="eas-headline" style="color:${reportTheme.color};">${esc(report.type.toUpperCase())}</div>
        <div class="eas-times">TIME: ${report.issued.toLocaleString().toUpperCase()}</div>
        <div class="eas-desc">REPORTER: ${esc((report.reporter || 'UNKNOWN').toUpperCase())}</div>
        ${report.radarId ? `<div class="eas-desc">RADAR: ${esc(report.radarId)}</div>` : ''}
        <div class="eas-desc">LOCATION: ${esc(`${report.lat.toFixed(3)}, ${report.lon.toFixed(3)}`)}</div>
        ${report.extras ? `<div class="eas-desc">${esc(report.extras)}</div>` : ''}
        ${report.notes ? `<div class="eas-action">NOTES...\n${esc(report.notes)}</div>` : ''}
      </div>
    </div>` : '';
  return `
    <div class="report-row" data-id="${esc(report.id)}" data-kind="report" style="border-left:3px solid ${reportTheme.border};background:${reportTheme.bg};${rowAnim}">
      <div class="report-header">
        <div class="report-top">
          ${dotHtml}
          <span class="report-type" style="color:${reportTheme.color};">${esc(report.type.toUpperCase())}</span>
          <span class="report-time">${esc(fmtTime(report.issued))}</span>
          ${report.radarId ? `<span class="watch-number">${esc(report.radarId)}</span>` : ''}
          <span class="report-location">${esc(`${report.lat.toFixed(2)}, ${report.lon.toFixed(2)}`)}</span>
          <span class="watch-chevron">${isExp ? '▲' : '▼'}</span>
        </div>
        <div class="report-meta">${esc(report.reporter || 'Unknown Spotter')}${report.notes ? ` | ${esc(report.notes.slice(0, 120))}` : ''}</div>
      </div>
      ${bodyHtml}
    </div>`;
}

// ── Render all ──────────────────────────────────────────────────
function renderAll() {
  updateStatusBar();
  updateBadges();
  if (activeTab === 'warnings') renderWarnings();
  else if (activeTab === 'watches') renderWatches();
  else if (activeTab === 'mds') renderMDs();
  else if (activeTab === 'reports') renderReports();
  else if (activeTab === 'map') refreshMap();
  else if (activeTab === 'dev') renderDevTab();
}

function updateStatusBar() {
  const led       = document.getElementById('status-led');
  const stText    = document.getElementById('status-text');
  const stTime    = document.getElementById('status-time');
  const statusbar = document.getElementById('statusbar');
  const tbDot     = document.getElementById('tb-dot');

  const hasTorEmerg = warnings.some(w => w.type === 'Tornado Warning' && ['pds','emergency'].includes(w.variant));
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
    `${warnings.length}W ${watches.length}WT ${mds.length}MD ${spotterReports.length}SN · 1.5s`;
}

function updateBadges() {
  const bw  = document.getElementById('badge-warnings');
  const bwt = document.getElementById('badge-watches');
  const bm  = document.getElementById('badge-mds');
  const br  = document.getElementById('badge-reports');
  bw.textContent  = warnings.length;
  bwt.textContent = watches.length;
  bm.textContent  = mds.length;
  br.textContent  = spotterReports.length;
  bw.className  = 'tab-badge' + (warnings.length > 0 ? ' has-items' : '');
  bwt.className = 'tab-badge' + (watches.length  > 0 ? ' has-items' : '');
  bm.className  = 'tab-badge' + (mds.length      > 0 ? ' has-items' : '');
  br.className  = 'tab-badge' + (spotterReports.length > 0 ? ' has-items' : '');
}

function renderWarnings() {
  const columns = document.getElementById('warn-columns');
  const empty   = document.getElementById('warn-empty');
  const torList = document.getElementById('tor-warn-list');
  const svrList = document.getElementById('svr-warn-list');
  const torCount = document.getElementById('tor-count');
  const svrCount = document.getElementById('svr-count');
  warnings.forEach(queueWarningRadarFetch);
  const hash = warningRenderHash();
  if (hash === lastWarnHash) return;
  lastWarnHash = hash;

  const torWarn = warnings.filter(w => w.type === 'Tornado Warning').sort(compareWarningsByPriority);
  const svrWarn = warnings.filter(w => w.type === 'Severe Thunderstorm Warning').sort(compareWarningsByPriority);
  const torScrolls = saveScrolls(torList);
  const svrScrolls = saveScrolls(svrList);

  torCount.textContent = torWarn.length;
  svrCount.textContent = svrWarn.length;

  if (warnings.length === 0) {
    columns.style.display = 'none';
    empty.style.display = '';
    empty.innerHTML = `<div class="empty-state"><div class="es-icon">◉</div><div class="es-label">NO ACTIVE WARNINGS</div></div>`;
  } else {
    empty.style.display = 'none';
    columns.style.display = 'grid';
    torList.innerHTML = torWarn.length
      ? torWarn.map(buildWarningRow).join('')
      : `<div class="empty-state"><div class="es-icon">◉</div><div class="es-label">NO TOR WARNINGS</div></div>`;
    svrList.innerHTML = svrWarn.length
      ? svrWarn.map(buildWarningRow).join('')
      : `<div class="empty-state"><div class="es-icon">◉</div><div class="es-label">NO SVR WARNINGS</div></div>`;
    restoreScrolls(torList, torScrolls);
    restoreScrolls(svrList, svrScrolls);
    attachClickHandlers(torList);
    attachClickHandlers(svrList);
  }
}

function renderWatches() {
  const list = document.getElementById('watch-list');
  if (!list) return;
  lastWatchHash = '';

  const torWatch = watches.filter(w => w.type === 'Tornado Watch');
  const svrWatch = watches.filter(w => w.type === 'Severe Thunderstorm Watch');

  let html = '';
  if (watches.length === 0) {
    html = `<div class="empty-state"><div class="es-icon">◉</div><div class="es-label">NO ACTIVE WATCHES</div></div>`;
  } else {
    if (torWatch.length) {
      html += `<div class="section-header" style="color:#FFFF00;border-bottom:1px solid #FFFF0022;">▸ TORNADO WATCHES (${torWatch.length})</div>`;
      html += torWatch.map(buildWatchRow).join('');
    }
    if (svrWatch.length) {
      if (torWatch.length) html += '<div style="height:5px;"></div>';
      html += `<div class="section-header" style="color:#00AAFF;border-bottom:1px solid #00AAFF22;">▸ SEVERE THUNDERSTORM WATCHES (${svrWatch.length})</div>`;
      html += svrWatch.map(buildWatchRow).join('');
    }
  }
  list.innerHTML = html;
  attachClickHandlers(list);
}

function renderMDs() {
  const list = document.getElementById('md-list');
  if (!list) return;
  const newHash = mds.map(m => m.id + (m.text || '') + (m.watchProb || '')).join('|');
  if (newHash === lastMdHash) return;
  lastMdHash = newHash;

  const scrollTop = list.scrollTop;
  let html = '';
  if (mds.length === 0) {
    html = `<div class="empty-state"><div class="es-icon">◉</div><div class="es-label">NO ACTIVE MDs</div></div>`;
  } else {
    html = `<div class="section-header" style="color:#00AAFF;border-bottom:1px solid #00AAFF22;">▸ SPC MESOSCALE DISCUSSIONS (${mds.length})</div>`;
    html += mds.map(buildMDRow).join('');
  }
  list.innerHTML = html;
  list.scrollTop = scrollTop;
  attachClickHandlers(list);
}

function renderReports() {
  const list = document.getElementById('report-list');
  if (!list) return;
  spotterReports.forEach(queueReportRadarFetch);
  lastReportHash = '';

  let html = '';
  if (spotterReports.length === 0) {
    html = `<div class="empty-state"><div class="es-icon">◉</div><div class="es-label">NO SPOTTER REPORTS</div></div>`;
  } else {
    html = `<div class="section-header" style="color:#66ffcc;border-bottom:1px solid #66ffcc22;">▸ SPOTTER NETWORK REPORTS (${spotterReports.length})</div>`;
    html += spotterReports.map(buildReportRow).join('');
  }
  list.innerHTML = html;
  attachClickHandlers(list);
}

function attachClickHandlers(list) {
  list.querySelectorAll('[data-kind]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.warn-body-inner, .watch-body-inner, .md-body-inner, .report-body-inner')) return;
      const id   = el.dataset.id;
      const kind = el.dataset.kind;
      const key  = kind === 'warn' ? 'w_' + id : kind === 'watch' ? 'wt_' + id : kind === 'md' ? 'md_' + id : 'rp_' + id;
      expanded[key] = !expanded[key];
      if (kind === 'warn')   renderWarnings();
      if (kind === 'watch')  renderWatches();
      if (kind === 'report') renderReports();
      if (kind === 'md') {
        const md = mds.find(m => m.id === id);
        if (md && expanded[key] && !md.text) {
          md.text = 'LOADING...';
          renderMDs();
          fetch(`https://www.spc.noaa.gov/products/md/md${md.number}.html`, {
            headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' },
          }).then(r => r.text()).then(html => {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const pre = doc.querySelector('pre');
            md.text = pre ? pre.textContent.trim() : 'Text not found.';
            const wpMatch = md.text.match(/PROBABILITY OF WATCH ISSUANCE[^\d]*(\d+)\s*PERCENT/i);
            if (wpMatch) md.watchProb = wpMatch[1];
            renderMDs();
          }).catch(() => { md.text = 'Failed to load. Visit spc.noaa.gov'; renderMDs(); });
        } else {
          renderMDs();
        }
      }
    });
  });
}

// ── Tab switching ────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + activeTab).classList.add('active');
    if (activeTab === 'warnings') renderWarnings();
    else if (activeTab === 'watches') renderWatches();
    else if (activeTab === 'mds') renderMDs();
    else if (activeTab === 'reports') renderReports();
    else if (activeTab === 'map') {
      initMap();
      refreshMap();
    }
    else if (activeTab === 'dev') renderDevTab();

    // Hide map control when not on map tab
    const mapControl = document.querySelector('.map-layer-control');
    if (mapControl) mapControl.style.display = activeTab === 'map' ? '' : 'none';
  });
});

// ── Window controls ──────────────────────────────────────────────
document.getElementById('btn-min').addEventListener('click', () => window.electronAPI.minimize());
document.getElementById('btn-close').addEventListener('click', () => window.electronAPI.close());

const btnOnTop = document.getElementById('btn-ontop');
btnOnTop.addEventListener('click', () => {
  alwaysOnTop = !alwaysOnTop;
  window.electronAPI.setAlwaysOnTop(alwaysOnTop);
  btnOnTop.classList.toggle('active', alwaysOnTop);
});
btnOnTop.classList.add('active');

// ── Dev tab ──────────────────────────────────────────────────────
let devUnlocked = false;
const DEV_PASSWORD = 'DEVTEST26';

function renderDevTab() {
  const list = document.getElementById('dev-list');
  if (!list) return;

  // Don't re-render if user is typing the password
  const focused = document.activeElement;
  if (focused && focused.id === 'dev-password-input') return;

  // Only re-render unlocked view when data changes
  if (devUnlocked) {
    const hash = `${warnings.length}:${watches.length}:${mds.length}:${spotterReports.length}:${warnings.filter(w => w.source === 'test').length}`;
    if (hash === lastDevHash) return;
    lastDevHash = hash;
  }

  if (!devUnlocked) {
    list.innerHTML = `
      <div style="padding:20px;display:flex;flex-direction:column;align-items:center;gap:12px;">
        <div style="color:#555;font-size:12px;letter-spacing:2px;">DEV MODE LOCKED</div>
        <div style="font-size:28px;">🔒</div>
        <input id="dev-password-input" type="password" placeholder="Enter password"
          style="background:#111;border:1px solid #333;color:#ccc;font-family:monospace;
                 font-size:13px;padding:6px 10px;border-radius:3px;width:180px;outline:none;"/>
        <button id="dev-unlock-btn"
          style="background:#1a1a1a;border:1px solid #333;color:#aaa;font-family:monospace;
                 font-size:11px;padding:5px 16px;border-radius:3px;cursor:pointer;letter-spacing:1px;">
          UNLOCK
        </button>
        <div id="dev-error" style="color:#f55;font-size:10px;min-height:14px;"></div>
      </div>`;
    document.getElementById('dev-unlock-btn').addEventListener('click', attemptDevUnlock);
    document.getElementById('dev-password-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') attemptDevUnlock();
    });
    return;
  }

  list.innerHTML = `
    <div style="padding:10px;">
      <div class="section-header" style="color:#00ff88;border-bottom:1px solid #00ff8822;margin-bottom:8px;">▸ DEV MODE UNLOCKED</div>
      <div style="margin-bottom:12px;">
        <div style="font-size:10px;color:#555;letter-spacing:1px;margin-bottom:6px;">INJECT TEST WARNINGS</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          <button class="dev-btn" onclick="injectTestWarning('svr-base')">SVR BASE</button>
          <button class="dev-btn" onclick="injectTestWarning('svr-considerable')">SVR CONSIDERABLE</button>
          <button class="dev-btn" onclick="injectTestWarning('svr-destructive')">SVR DESTRUCTIVE</button>
          <button class="dev-btn" onclick="injectTestWarning('svr-tor-possible')">SVR TOR POSSIBLE</button>
          <button class="dev-btn" onclick="injectTestWarning('tor-base')">TOR BASE</button>
          <button class="dev-btn" onclick="injectTestWarning('tor-observed')">TOR OBSERVED</button>
          <button class="dev-btn" onclick="injectTestWarning('tor-pds')">TOR PDS</button>
          <button class="dev-btn" onclick="injectTestWarning('tor-emergency')">TOR EMERGENCY</button>
        </div>
      </div>
      <div style="margin-bottom:12px;">
        <div style="font-size:10px;color:#555;letter-spacing:1px;margin-bottom:6px;">ACTIVE TEST WARNINGS (${warnings.filter(w => w.source === 'test').length})</div>
        ${warnings.filter(w => w.source === 'test').map(w => `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span style="font-size:10px;color:${w.cfg.color};font-weight:700;">${w.cfg.label}</span>
            <span style="font-size:10px;color:#666;">${w.area}</span>
            <button class="dev-btn dev-btn-red" onclick="removeTestWarning('${w.id}')">✕</button>
          </div>`).join('') || '<div style="font-size:10px;color:#333;">None</div>'}
      </div>
      <div style="display:flex;gap:6px;margin-bottom:12px;">
        <button class="dev-btn dev-btn-red" onclick="clearTestWarnings()">CLEAR ALL TEST</button>
        <button class="dev-btn" onclick="devUnlocked=false;renderDevTab();">🔒 LOCK</button>
      </div>
      <div style="margin-bottom:8px;">
        <div style="font-size:10px;color:#555;letter-spacing:1px;margin-bottom:4px;">STATS</div>
        <div style="font-size:10px;color:#444;font-family:monospace;line-height:1.8;">
          WARNINGS: ${warnings.length} (${warnings.filter(w => w.source === 'cod').length} COD / ${warnings.filter(w => w.source === 'api').length} NWS / ${warnings.filter(w => w.source === 'test').length} TEST)<br>
          WATCHES: ${watches.length}<br>
          MDs: ${mds.length}<br>
          SPOTTER REPORTS: ${spotterReports.length}<br>
          LAST UPDATE: ${lastUpdate ? fmtTimeSec(lastUpdate) : 'N/A'}
        </div>
      </div>
    </div>`;
}

function attemptDevUnlock() {
  const input = document.getElementById('dev-password-input');
  const error = document.getElementById('dev-error');
  if (!input) return;
  if (input.value === DEV_PASSWORD) {
    devUnlocked = true;
    renderDevTab();
  } else {
    if (error) error.textContent = 'INCORRECT PASSWORD';
    input.value = '';
    setTimeout(() => { if (error) error.textContent = ''; }, 2000);
  }
}

function makeTestWarning(kind) {
  const now = Date.now();
  const base = {
    issued: new Date(now - 60000),
    expires: new Date(now + 1800000),
    officeCode: 'KTEST',
    radarId: 'KTES',
    center: null,
    desc: 'THIS IS A TEST WARNING INJECTED FROM DEV MODE.',
    instruction: 'THIS IS ONLY A TEST.',
    torDetect: null,
    torPossible: false,
    hailSize: null,
    windGust: null,
    damageThreat: null,
    source: 'test',
    isNew: true,
    flashUntil: now + 90000,
  };
  const map = {
    'svr-base':         { id: 'test-svr-base', type: 'Severe Thunderstorm Warning', variant: 'base',         area: 'TEST COUNTY TX', hailSize: '1.00', windGust: '60' },
    'svr-considerable': { id: 'test-svr-cons', type: 'Severe Thunderstorm Warning', variant: 'considerable', area: 'TEST COUNTY OK', hailSize: '1.75', windGust: '70', damageThreat: 'CONSIDERABLE' },
    'svr-destructive':  { id: 'test-svr-dest', type: 'Severe Thunderstorm Warning', variant: 'destructive',  area: 'TEST COUNTY KS', hailSize: '2.50', windGust: '80', damageThreat: 'DESTRUCTIVE' },
    'svr-tor-possible': { id: 'test-svr-torp', type: 'Severe Thunderstorm Warning', variant: 'tor_possible', area: 'TEST COUNTY MO', hailSize: '1.00', windGust: '60', torPossible: true },
    'tor-base':         { id: 'test-tor-base', type: 'Tornado Warning',             variant: 'base',         area: 'TEST COUNTY AL' },
    'tor-observed':     { id: 'test-tor-obs',  type: 'Tornado Warning',             variant: 'observed',     area: 'TEST COUNTY MS', torDetect: 'OBSERVED' },
    'tor-pds':          { id: 'test-tor-pds',  type: 'Tornado Warning',             variant: 'pds',          area: 'TEST COUNTY NE', torDetect: 'OBSERVED' },
    'tor-emergency':    { id: 'test-tor-emrg', type: 'Tornado Warning',             variant: 'emergency',    area: 'TEST COUNTY OK', torDetect: 'OBSERVED' },
  };
  const spec = map[kind];
  if (!spec) return null;
  const cfg = CFG[spec.type][spec.variant];
  return { ...base, ...spec, cfg, rank: cfg.rank, headline: `${cfg.label} until ${fmtTime(new Date(now + 1800000))}` };
}

function playTestWarningSounds(warning) {
  if (shouldPlayEasForWarning(warning)) {
    playAudio(TORE_SOUND_URL);
    return;
  }
  if (shouldPlayWeaForWarning(warning)) {
    playAudio(WEA_SOUND_URL);
  }
}

function injectTestWarning(kind) {
  const w = makeTestWarning(kind);
  if (!w) return;
  const isReplacing = warnings.some(x => x.id === w.id);
  warnings = warnings.filter(x => x.id !== w.id);
  warnings = [...warnings, w].sort(compareWarningsByPriority);
  lastWarnHash = '';
  lastDevHash = '';
  // Always play the sound on inject (even re-inject) so you can test it
  playTestWarningSounds(w);
  renderWarnings();
  updateBadges();
  renderDevTab();
}

function removeTestWarning(id) {
  warnings = warnings.filter(w => w.id !== id);
  lastWarnHash = '';
  renderWarnings();
  updateBadges();
  renderDevTab();
}

function clearTestWarnings() {
  warnings = warnings.filter(w => w.source !== 'test');
  lastWarnHash = '';
  lastDevHash = '';
  polygonCache.clear();
  renderWarnings();
  updateBadges();
  renderDevTab();
  if (mapInitialized) refreshMap();
}

// ── Auto-update banner ───────────────────────────────────────────
(function initUpdateBanner() {
  if (!window.electronAPI?.onUpdateStatus) return;
  window.electronAPI.onUpdateStatus(({ type, version }) => {
    const footerCount = document.getElementById('footer-count');
    if (!footerCount) return;
    if (type === 'downloading') {
      footerCount.textContent = `⬇ DOWNLOADING v${version}...`;
      footerCount.style.color = '#4dc3ff';
      footerCount.style.cursor = 'default';
      footerCount.onclick = null;
    }
    if (type === 'ready') {
      footerCount.textContent = `✓ v${version} READY — CLICK TO INSTALL`;
      footerCount.style.color = '#39ff14';
      footerCount.style.cursor = 'pointer';
      footerCount.onclick = () => window.electronAPI.installUpdate();
    }
  });
})();

// ── Boot ─────────────────────────────────────────────────────────
window.addEventListener('keydown', handleSoundTestHotkeys);
renderAll();
fetchAll();
setInterval(fetchAll, 1500);
setInterval(() => {
  if (warnings.length > 0 || watches.length > 0 || mds.length > 0 || spotterReports.length > 0) renderAll();
}, 30_000);