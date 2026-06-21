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
    base: { label: 'SVR WATCH', color: '#ff0000', bg: '#001a2a', border: '#ff0000', rank: 3 },
  },
};

const WARN_URLS = [
  'https://api.weather.gov/alerts/active?status=actual&event=Tornado%20Warning',
  'https://api.weather.gov/alerts/active?status=actual&event=Severe%20Thunderstorm%20Warning',
];
const COD_WARN_URL = 'https://weather.cod.edu/textserv/json/svr/active-2';
const WATCH_URL = 'https://api.weather.gov/alerts/active?status=actual&event=Tornado%20Watch,Severe%20Thunderstorm%20Watch';
const MD_URL    = 'https://www.spc.noaa.gov/products/md/mdlist.json';
const OUTLOOK_URL = 'https://www.spc.noaa.gov/products/outlook/';
const SPOTTER_REPORTS_URL = 'https://www.spotternetwork.org/feeds/reports.txt';
const TORE_SOUND_URL = '../assets/tore-eas.mp3';
const WEA_SOUND_URL  = '../assets/wea-sound.mp3';
const SPOTTER_SOUND_URL = '../assets/spotter-network-new.mp3';
const CD_THUNDERBOLT_SOUND_URL = '../assets/cd-thunderbolt-siren.mp3';
const WARNING_ENRICH_ISSUE_WINDOW_MS = 10 * 60_000;

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
let codWarningMetaLoading = new Set();
let reportRadarLoading = new Set();
let soundedWarningKeys = new Set();
let soundedReportIds = new Set();
let soundedHighOutlookIds = new Set();
let warningAudioPrimed = false;
let highOutlookAudioPrimed = false;
let easEnabled = true;
let weaEnabled = true;
// ── Map state ────────────────────────────────────────────────────
let mapInstance = null;
let mapLayers = [];
let mapInitialized = false;
const polygonCache = new Map();
let mapBounds = [];
const audioPlayers = new Map();
const warningRadarCache = new Map();
const codWarningProductCache = new Map();

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

function extractCodProductUrls(filesHtml) {
  return [...String(filesHtml || '').matchAll(/href=["']([^"']+)["']/gi)]
    .map(match => match[1])
    .filter(Boolean);
}

function extractCodProductUrl(filesHtml) {
  return extractCodProductUrls(filesHtml)[0] || '';
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

function warningIssuedMs(warning) {
  return new Date(warning?.issued).getTime();
}

function warningExpiresMs(warning) {
  return new Date(warning?.expires).getTime();
}

function warningIssueDeltaMs(a, b) {
  return Math.abs(warningIssuedMs(a) - warningIssuedMs(b));
}

function warningOfficeMatches(a, b) {
  const aOffice = String(a.officeCode || '').toUpperCase();
  const bOffice = String(b.officeCode || '').toUpperCase();
  return !aOffice || !bOffice || aOffice === bOffice;
}

function isOverlappingWarningArea(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (!warningOfficeMatches(a, b)) return false;
  return countyOverlapScore(a.area, b.area) > 0;
}

function isContinuationUpdateForWarning(baseWarning, updateWarning) {
  const baseIssued = warningIssuedMs(baseWarning);
  const baseExpires = warningExpiresMs(baseWarning);
  const updateIssued = warningIssuedMs(updateWarning);
  if (![baseIssued, baseExpires, updateIssued].every(Number.isFinite)) return false;
  return updateIssued >= baseIssued && updateIssued <= baseExpires;
}

function isSameWarningIssuance(a, b) {
  if (!isOverlappingWarningArea(a, b)) return false;
  return warningIssueDeltaMs(a, b) <= WARNING_ENRICH_ISSUE_WINDOW_MS || isContinuationUpdateForWarning(a, b);
}

function shouldSuppressStaleNwsWarning(codWarning, nwsWarning) {
  if (!isOverlappingWarningArea(codWarning, nwsWarning)) return false;
  if (isSameWarningIssuance(codWarning, nwsWarning)) return true;
  return warningIssuedMs(codWarning) > warningIssuedMs(nwsWarning);
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
    const productUrls = extractCodProductUrls(item.files);
    const productUrl = productUrls[0] || '';
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
  const matches = nwsWarnings
    .filter(nws => isSameWarningIssuance(codWarning, nws))
    .map(nws => ({
      nws,
      overlap: countyOverlapScore(codWarning.area, nws.area),
      issueDelta: warningIssueDeltaMs(codWarning, nws),
    }))
    .sort((a, b) => b.overlap - a.overlap || a.issueDelta - b.issueDelta);

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
    expires:      best.expires > codWarning.expires ? best.expires : codWarning.expires,
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
  await Promise.all([fetchWarnings(), fetchWatches(), fetchMDs(), fetchSpotterReports(), fetchOutlooks()]);
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

function preservePreviousWarningMeta(warning, previous) {
  if (!previous) return warning;
  const next = { ...warning };

  if (previous.codMetaApplied && warning.source === 'cod' && warning.type === 'Tornado Warning') {
    // Only carry forward the previous variant if the warning hasn't been reissued.
    // A new issued time means NWS pushed a fresh product — the old COD meta tags
    // are stale and should not override what the current cycle says.
    const sameIssuance = previous.issued instanceof Date && warning.issued instanceof Date
      && Math.abs(previous.issued.getTime() - warning.issued.getTime()) < 60_000;

    const previousRank = CFG[warning.type]?.[previous.variant]?.rank || previous.rank || 0;
    const nextRank = CFG[warning.type]?.[next.variant]?.rank || next.rank || 0;

    if (sameIssuance && previousRank >= nextRank) {
      next.variant = previous.variant;
      next.cfg = CFG[warning.type]?.[previous.variant] || previous.cfg || next.cfg;
      next.rank = next.cfg?.rank || previous.rank || next.rank;
      next.damageThreat = previous.damageThreat || next.damageThreat;
      next.torDetect = previous.torDetect || next.torDetect;
      next.hailSize = previous.hailSize || next.hailSize;
      next.windGust = previous.windGust || next.windGust;
      next.codMetaApplied = true;
    }
  }

  if (previous.expires instanceof Date && previous.expires > next.expires && previous.expires > new Date()) {
    next.expires = previous.expires;
  }

  return next;
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
      for (const nws of nwsWarnings) {
        if (shouldSuppressStaleNwsWarning(cod, nws)) {
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

      const preservedWarning = preservePreviousWarningMeta(w, previous);

      return {
        ...preservedWarning,
        radarId: preservedWarning.radarId || previous?.radarId || '',
        center: preservedWarning.center || previous?.center || null,
        flashUntil,
        isNew: now < flashUntil,
      };
    }).sort(compareWarningsByPriority);

    warnings.forEach(queueCodWarningMetaFetch);

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
    const allParsed = parseWatches(data);
const seenNumbers = new Set();
const parsed = allParsed.filter(w => {
  const key = w.watchNumber || w.id;
  if (seenNumbers.has(key)) return false;
  seenNumbers.add(key);
  return true;
});
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
function playCdThunderboltSiren(options = {}) {
  const { toggle = false } = options;
  const audio = getAudioPlayer(CD_THUNDERBOLT_SOUND_URL);
  if (toggle && !audio.paused) {
    stopAudio(CD_THUNDERBOLT_SOUND_URL);
    return;
  }
  audio.pause();
  audio.currentTime = 0;
  const played = audio.play();
  if (played && typeof played.catch === 'function') {
    played.catch(err => {
      console.warn('CD Thunderbolt siren audio failed:', err.message);
      playSynthThunderboltSiren();
    });
  }
}

function playSynthThunderboltSiren(durationMs = 9000) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const ctx = new AudioContext();
  const now = ctx.currentTime;
  const duration = durationMs / 1000;
  const carrier = ctx.createOscillator();
  const tremolo = ctx.createOscillator();
  const tremoloGain = ctx.createGain();
  const output = ctx.createGain();

  carrier.type = 'sawtooth';
  tremolo.type = 'sine';
  tremolo.frequency.value = 9;
  tremoloGain.gain.value = 0.18;
  output.gain.setValueAtTime(0.0001, now);
  output.gain.exponentialRampToValueAtTime(0.75, now + 0.25);
  output.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  for (let t = 0; t < duration; t += 3) {
    const start = now + t;
    const peak = Math.min(start + 1.35, now + duration);
    const end = Math.min(start + 3, now + duration);
    carrier.frequency.setValueAtTime(230, start);
    carrier.frequency.linearRampToValueAtTime(620, peak);
    carrier.frequency.linearRampToValueAtTime(230, end);
  }

  tremolo.connect(tremoloGain).connect(output.gain);
  carrier.connect(output).connect(ctx.destination);
  carrier.start(now);
  tremolo.start(now);
  carrier.stop(now + duration);
  tremolo.stop(now + duration);
  carrier.addEventListener('ended', () => ctx.close());
}


function warningSoundSignature(warning) {
  return [
    warning.type,
    warning.variant,
    warning.issued instanceof Date ? warning.issued.toISOString() : String(warning.issued || ''),
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
    const issuedRecently = (Date.now() - warning.issued.getTime()) <= 300_000;
    if ((!isNewArrival && !upgradedToTarget) || !issuedRecently) continue;
    if (shouldPlayEasForWarning(warning) && easEnabled) {
      soundedWarningKeys.add(soundKey);
      playAudio(TORE_SOUND_URL);
      continue;
    }
    if (shouldPlayWeaForWarning(warning) && weaEnabled) {
      console.log('WEA triggered for:', warning.area, warning.variant);
      soundedWarningKeys.add(soundKey);
      playAudio(WEA_SOUND_URL);
    } else if (shouldPlayWeaForWarning(warning) && !weaEnabled) {
      console.log('WEA suppressed (toggle off):', warning.area);
    } else {
      console.log('WEA not triggered:', warning.area, warning.variant, 'soundKey already seen:', soundedWarningKeys.has(soundKey));
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
  if (hasCtrl && (key === 'G3' || code === 'G3' || key === 'F15' || code === 'F15' || code === 'DIGIT3')) {
    event.preventDefault();
    playCdThunderboltSiren({ toggle: true });
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
async function fetchOutlooks() {
  try {
    const res = await fetch(OUTLOOK_URL, {
      headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    playHighOutlookSounds(parseCurrentOutlooks(html));
  } catch (e) {
    console.warn('Outlook fetch error:', e.message);
  }
}

function parseCurrentOutlooks(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const lines = (doc.body?.textContent || '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const outlooks = [];
  let current = null;

  for (const line of lines) {
    const dayMatch = line.match(/^Current Day\s+([\d-]+)\s+Outlook$/i);
    if (dayMatch) {
      current = { day: dayMatch[1], issued: '', valid: '', risk: '' };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('Issued:')) {
      current.issued = line.replace(/^Issued:\s*/i, '');
      continue;
    }
    if (line.startsWith('Valid:')) {
      current.valid = line.replace(/^Valid:\s*/i, '');
      continue;
    }
    if (line.startsWith('Forecast Risk of Severe Storms:')) {
      current.risk = line.replace(/^Forecast Risk of Severe Storms:\s*/i, '');
      outlooks.push(current);
      current = null;
    }
  }

  return outlooks;
}

function highOutlookId(outlook) {
  return [outlook.day, outlook.issued, outlook.valid, outlook.risk].join('|');
}

function isHighOutlook(outlook) {
  return /\bHigh Risk\b/i.test(outlook?.risk || '');
}

function playHighOutlookSounds(outlooks) {
  const highOutlooks = outlooks.filter(isHighOutlook);
  const activeIds = new Set(highOutlooks.map(highOutlookId));

  if (!highOutlookAudioPrimed) {
    highOutlookAudioPrimed = true;
    soundedHighOutlookIds = activeIds;
    return;
  }

  for (const outlook of highOutlooks) {
    const id = highOutlookId(outlook);
    if (soundedHighOutlookIds.has(id)) continue;
    soundedHighOutlookIds.add(id);
    playCdThunderboltSiren();
  }

  soundedHighOutlookIds = new Set([...soundedHighOutlookIds].filter(id => activeIds.has(id)));
}


function parseCodWarningProductMeta(text, warning) {
  const raw = String(text || '');
  const upper = raw.toUpperCase();
  const tornadoMatch = raw.match(/TORNADO\.\.\.([^\n\r]+)/i);
  const tornadoDamageMatch = raw.match(/TORNADO DAMAGE THREAT\.\.\.([^\n\r]+)/i);
  const thunderstormDamageMatch = raw.match(/THUNDERSTORM DAMAGE THREAT\.\.\.([^\n\r]+)/i);
  const hailMatch = raw.match(/MAX HAIL SIZE\.\.\.<?\s*([\d.]+)/i);
  const windMatch = raw.match(/MAX WIND GUST\.\.\.(\d+)/i);
  const isTornadoWarning = warning.type === 'Tornado Warning';
  const torDetect = isTornadoWarning && tornadoMatch ? tornadoMatch[1].trim() : warning.torDetect;
  const tornadoDamageThreat = isTornadoWarning && tornadoDamageMatch ? tornadoDamageMatch[1].trim() : '';
  const thunderstormDamageThreat = thunderstormDamageMatch ? thunderstormDamageMatch[1].trim() : '';
  const damageThreat = tornadoDamageThreat || thunderstormDamageThreat || warning.damageThreat;

  const props = {
    event: warning.type,
    parameters: {
      tornadoDetection: torDetect ? [torDetect] : [],
      tornadoDamageThreat: tornadoDamageThreat ? [tornadoDamageThreat] : [],
      thunderstormDamageThreat: thunderstormDamageThreat ? [thunderstormDamageThreat] : [],
    },
    headline: warning.headline || '',
    description: raw,
    instruction: raw,
  };
  const classified = classifyWarning(props);
  let variant = classified?.variant || warning.variant;
  if (isTornadoWarning && upper.includes('TORNADO EMERGENCY')) variant = 'emergency';
  if (isTornadoWarning && upper.includes('PARTICULARLY DANGEROUS SITUATION')) variant = variant === 'emergency' ? 'emergency' : 'pds';

  const cfg = CFG[warning.type]?.[variant] || warning.cfg;
  return {
    variant,
    cfg,
    rank: cfg?.rank || warning.rank,
    damageThreat,
    torDetect,
    hailSize: hailMatch ? hailMatch[1] : warning.hailSize,
    windGust: windMatch ? windMatch[1] : warning.windGust,
  };
}

async function fetchCodWarningMeta(warning) {
  const urls = Array.isArray(warning.codProductUrls) ? warning.codProductUrls : [];
  if (!urls.length) return;
  codWarningMetaLoading.add(warning.id);
  try {
    const texts = await Promise.all(urls.map(async url => {
      if (codWarningProductCache.has(url)) return codWarningProductCache.get(url);
      const res = await fetch(url, { headers: { 'User-Agent': 'GR-Warnings-Desktop/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      codWarningProductCache.set(url, text);
      return text;
    }));
    const meta = parseCodWarningProductMeta(texts.join('\n'), warning);
    const current = warnings.find(w => w.id === warning.id);
    if (!current) return;
    const changed = current.variant !== meta.variant
      || current.damageThreat !== meta.damageThreat
      || current.torDetect !== meta.torDetect
      || current.hailSize !== meta.hailSize
      || current.windGust !== meta.windGust;
    if (!changed) return;
    const updatedWarning = { ...current, ...meta };
    if (current.type === 'Tornado Warning' && updatedWarning.type === 'Tornado Warning' && !shouldPlayEasForWarning(current) && shouldPlayEasForWarning(updatedWarning) && easEnabled) {
      soundedWarningKeys.add(warningSoundSignature(updatedWarning));
      playAudio(TORE_SOUND_URL);
    }
    Object.assign(current, meta, { codMetaApplied: current.type === 'Tornado Warning' });
    lastWarnHash = '';
    if (activeTab === 'warnings') renderWarnings();
    updateBadges();
    if (mapInitialized) refreshMap();
  } catch (e) {
    console.warn(`COD warning product fetch error (${warning.id}):`, e.message);
  } finally {
    codWarningMetaLoading.delete(warning.id);
  }
}

function queueCodWarningMetaFetch(warning) {
  if (!warning || warning.source !== 'cod' || !warning.codProductUrls?.length || codWarningMetaLoading.has(warning.id)) return;
  void fetchCodWarningMeta(warning);
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
  return warnings.map(w => `${w.id}:${w.variant}:${w.radarId || ''}:${w.isNew ? 1 : 0}:${expanded['w_' + w.id] ? 1 : 0}`).join(',');
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
          ${w.torDetect && !/POSSIBLE/i.test(w.torDetect) ? `<span class="tag tag-tor">${esc(w.torDetect)}</span>` : ''}
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
  else if (activeTab === 'vrot') renderVrotTab();
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

// ── Models / Forecast Soundings ─────────────────────────────────
let modelsInitialized = false;
let modelsMapInstance = null;
let modelsPointMarker = null;
let modelsOverlayLayer = null;   // Leaflet GeoJSON contour layer
let modelsLegendControl = null;
let selectedModelPoint = { lat: 38.84, lon: -94.96 };

// NOMADS variable config: { nomadsVar, level, label, unit, thresholds, colors }
// Colors go from low→high; thresholds define the breakpoints between colors.
const MODEL_FIELDS = {
  mlcape: {
    label: 'MLCAPE', unit: 'J/kg',
    nomadsVar: 'var_CAPE',
    levelByModel: { RAP: 'lev_180-0_mb_above_ground', NAM: 'lev_90-0_mb_above_ground', HRRR: 'lev_180-0_mb_above_ground', GFS: 'lev_180-0_mb_above_ground' },
    thresholds: [100, 500, 1000, 1500, 2000, 3000, 4000],
    colors: ['#0a2a0a','#1a5c1a','#39b539','#f0e800','#ff8c00','#ff2200','#cc00cc','#ffffff'],
  },
  sbcape: {
    label: 'SBCAPE', unit: 'J/kg',
    nomadsVar: 'var_CAPE',
    levelByModel: { RAP: 'lev_surface', NAM: 'lev_surface', HRRR: 'lev_surface', GFS: 'lev_surface' },
    thresholds: [100, 500, 1000, 1500, 2000, 3000, 4000],
    colors: ['#0a2a0a','#1a5c1a','#39b539','#f0e800','#ff8c00','#ff2200','#cc00cc','#ffffff'],
  },
  mucape: {
    label: 'MUCAPE', unit: 'J/kg',
    nomadsVar: 'var_CAPE',
    levelByModel: { RAP: 'lev_255-0_mb_above_ground', NAM: 'lev_255-0_mb_above_ground', HRRR: 'lev_255-0_mb_above_ground', GFS: 'lev_255-0_mb_above_ground' },
    thresholds: [100, 500, 1000, 1500, 2000, 3000, 4000],
    colors: ['#0a2a0a','#1a5c1a','#39b539','#f0e800','#ff8c00','#ff2200','#cc00cc','#ffffff'],
  },
  cin: {
    label: 'CIN', unit: 'J/kg',
    nomadsVar: 'var_CIN',
    levelByModel: { RAP: 'lev_180-0_mb_above_ground', NAM: 'lev_90-0_mb_above_ground', HRRR: 'lev_180-0_mb_above_ground', GFS: 'lev_180-0_mb_above_ground' },
    thresholds: [-300, -200, -100, -50, -25, -10],
    colors: ['#440000','#8b0000','#cc2200','#ff6600','#ffcc00','#ffff99','#ffffff'],
  },
  srh01: {
    label: '0-1km SRH', unit: 'm2/s2',
    nomadsVar: 'var_HLCY',
    levelByModel: { RAP: 'lev_1000-0_m_above_ground', NAM: 'lev_1000-0_m_above_ground', HRRR: 'lev_1000-0_m_above_ground', GFS: 'lev_1000-0_m_above_ground' },
    thresholds: [50, 100, 150, 200, 300, 400, 500],
    colors: ['#0a0a2a','#1a1a6e','#2244cc','#00aaff','#00ffcc','#ffff00','#ff6600','#ff0000'],
  },
  srh03: {
    label: '0-3km SRH', unit: 'm2/s2',
    nomadsVar: 'var_HLCY',
    levelByModel: { RAP: 'lev_3000-0_m_above_ground', NAM: 'lev_3000-0_m_above_ground', HRRR: 'lev_3000-0_m_above_ground', GFS: 'lev_3000-0_m_above_ground' },
    thresholds: [50, 150, 250, 350, 500, 750],
    colors: ['#0a0a2a','#1a1a6e','#2244cc','#00aaff','#ffff00','#ff6600','#ff0000'],
  },
  shear06: {
    label: '0-6km Shear', unit: 'kt',
    nomadsVar: 'var_VUCSH',
    levelByModel: { RAP: 'lev_0-6000_m_above_ground', NAM: 'lev_0-6000_m_above_ground', HRRR: 'lev_0-6000_m_above_ground', GFS: 'lev_0-6000_m_above_ground' },
    isShear: true,
    thresholds: [20, 30, 40, 50, 60, 70],
    colors: ['#0a0a2a','#1a1a6e','#2244cc','#00aaff','#ffff00','#ff6600','#ff0000'],
  },
  stp: {
    label: 'SigTor (STP)', unit: '',
    nomadsVar: null,
    isStp: true,
    thresholds: [0.5, 1, 2, 4, 6, 8],
    colors: ['#111111','#2a2a2a','#ffff00','#ff8c00','#ff2200','#cc00cc','#ffffff'],
  },
  scp: {
    label: 'SCP', unit: '',
    nomadsVar: null,
    isScp: true,
    thresholds: [1, 2, 4, 8, 12],
    colors: ['#111111','#2244cc','#00aaff','#ffff00','#ff6600','#ff0000'],
  },
};

function renderModelsTab() {
  const panel = document.getElementById('models-panel');
  if (!panel) return;

  if (!modelsInitialized) {
    modelsInitialized = true;
    panel.innerHTML = `
      <div class="models-left">
        <div class="models-controls">
          <div class="section-header models-header">▸ MODELS / SOUNDINGS</div>
          <div class="models-control-row">
            <label for="models-model">MODEL</label>
            <select id="models-model">
              <option value="RAP">RAP</option>
              <option value="NAM">NAM</option>
              <option value="HRRR">HRRR</option>
            </select>
          </div>
          <div class="models-control-row">
            <label>FIELD</label>
            <div id="models-field-picker" class="models-field-picker">
              ${Object.entries(MODEL_FIELDS).map(([key, f]) => `
                <button class="models-field-btn${key === 'mlcape' ? ' active' : ''}" data-field="${key}">${f.label}</button>
              `).join('')}
            </div>
          </div>
          <div class="models-control-row">
            <label for="models-hour">F-HOUR</label>
            <input id="models-hour" type="number" min="0" max="48" step="1" value="0" />
          </div>
          <div class="models-control-row">
            <label for="models-parcel">PARCEL</label>
            <select id="models-parcel">
              <option value="ml">MEAN LAYER</option>
              <option value="sb">SURFACE BASED</option>
              <option value="mu">MOST UNSTABLE</option>
              <option value="eff">EFFECTIVE INFLOW</option>
            </select>
          </div>
          <div class="models-control-row">
            <label for="models-opacity">OPACITY</label>
            <input id="models-opacity" type="range" min="15" max="90" step="5" value="65" />
          </div>
          <div class="models-btn-row">
            <button id="models-overlay-btn" class="models-btn">▶ LOAD CONTOURS</button>
            <button id="models-load-btn" class="models-btn">LOAD SOUNDING</button>
            <button id="models-open-btn" class="models-btn">OPEN EXTERNAL</button>
          </div>
          <div class="models-note">LOAD CONTOURS renders filled contours natively on the map. Click the map for a point sounding (NAM/RAP in-app; HRRR opens externally).</div>
        </div>
        <div id="models-map"></div>
        <div id="models-status" class="models-status"></div>
      </div>
      <div class="models-right">
        <div class="models-frame-wrap">
          <iframe id="models-sounding-frame" title="Forecast sounding"></iframe>
          <div id="models-placeholder" class="models-placeholder">
            <div class="es-icon">◉</div>
            <div class="es-label">SELECT A POINT</div>
            <div class="es-sub">Pick a field, click LOAD CONTOURS, then click the map for a point sounding.</div>
          </div>
        </div>
      </div>`;

    initModelsMap();
    // Field picker buttons
    document.getElementById('models-field-picker').addEventListener('click', e => {
      const btn = e.target.closest('.models-field-btn');
      if (!btn) return;
      document.querySelectorAll('.models-field-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateModelsStatus();
    });
    ['models-model', 'models-hour', 'models-parcel'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', updateModelsStatus);
    });
    document.getElementById('models-overlay-btn').addEventListener('click', updateModelsOverlay);
    document.getElementById('models-load-btn').addEventListener('click', loadSelectedSounding);
    document.getElementById('models-open-btn').addEventListener('click', openSelectedSoundingExternal);
    document.getElementById('models-opacity').addEventListener('input', updateModelsOverlayOpacity);
  }

  updateModelsStatus();
  setTimeout(() => { if (modelsMapInstance) modelsMapInstance.invalidateSize(); }, 60);
}

function initModelsMap() {
  if (modelsMapInstance || typeof L === 'undefined') return;
  modelsMapInstance = L.map('models-map', {
    center: [38, -96],
    zoom: 4,
    zoomControl: true,
    attributionControl: true,
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    subdomains: 'abcd',
    maxZoom: 18,
  }).addTo(modelsMapInstance);
  modelsMapInstance.on('click', e => setModelPoint(e.latlng.lat, e.latlng.lng, true));
  setModelPoint(selectedModelPoint.lat, selectedModelPoint.lon, false);
}

function setModelPoint(lat, lon, shouldLoad) {
  selectedModelPoint = {
    lat: Math.max(-90, Math.min(90, Number(lat))),
    lon: Math.max(-180, Math.min(180, Number(lon))),
  };
  if (modelsMapInstance) {
    const ll = [selectedModelPoint.lat, selectedModelPoint.lon];
    if (!modelsPointMarker) {
      modelsPointMarker = L.circleMarker(ll, {
        radius: 7,
        color: '#b388ff',
        fillColor: '#b388ff',
        fillOpacity: 0.55,
        weight: 2,
      }).addTo(modelsMapInstance);
    } else {
      modelsPointMarker.setLatLng(ll);
    }
    modelsPointMarker.bindPopup(makePopup('#b388ff', 'SOUNDING POINT', formatModelPoint(), 'Click LOAD SOUNDING'));
  }
  updateModelsStatus();
  if (shouldLoad) loadSelectedSounding();
}

function formatModelPoint() {
  return `${selectedModelPoint.lat.toFixed(2)}, ${selectedModelPoint.lon.toFixed(2)}`;
}

function getSelectedField() {
  const active = document.querySelector('.models-field-btn.active');
  return active ? active.dataset.field : 'mlcape';
}

function getSelectedModelOptions() {
  const model = document.getElementById('models-model')?.value || 'RAP';
  const fieldKey = getSelectedField();
  const field = MODEL_FIELDS[fieldKey] || MODEL_FIELDS.mlcape;
  const hour = Math.max(0, Math.min(48, parseInt(document.getElementById('models-hour')?.value || '0', 10) || 0));
  const parcel = document.getElementById('models-parcel')?.value || 'ml';
  const opacity = Math.max(0.15, Math.min(0.9, Number(document.getElementById('models-opacity')?.value || 65) / 100));
  return { model, fieldKey, field, hour, parcel, opacity };
}

// ── NOMADS contour pipeline ──────────────────────────────────────

function buildNomadsUrl(opts, runHour, runDate) {
  const model = opts.model.toLowerCase();
  // NOMADS forecast hour padding
  const hourStr = String(opts.hour).padStart(2, '0');

  const baseUrls = {
    rap:  'https://nomads.ncep.noaa.gov/cgi-bin/filter_rap.pl',
    nam:  'https://nomads.ncep.noaa.gov/cgi-bin/filter_nam.pl',
    hrrr: 'https://nomads.ncep.noaa.gov/cgi-bin/filter_hrrr_2d.pl',
  };
  const base = baseUrls[model] || baseUrls.rap;

  const runStr = String(runHour).padStart(2, '0');
  const ymd = runDate.toISOString().slice(0, 10).replace(/-/g, '');

  // Correct directory and file name formats per NOMADS docs
  const dirMap = {
    rap:  `rap.${ymd}`,
    nam:  `nam.${ymd}`,
    hrrr: `hrrr.${ymd}/conus`,
  };
  // RAP: rap.tHHz.awp130pgrbfFF.grib2
  // NAM: nam.tHHz.conusnest.hiresf0FF.tm00.grib2 (conusnest has CAPE/SRH)
  // HRRR: hrrr.tHHz.wrfprsf0FF.grib2
  const fileMap = {
    rap:  `rap.t${runStr}z.awp130pgrbf${hourStr}.grib2`,
    nam:  `nam.t${runStr}z.conusnest.hiresf${hourStr}.tm00.grib2`,
    hrrr: `hrrr.t${runStr}z.wrfprsf${hourStr}.grib2`,
  };

  // Variable parameters — NOMADS uses exact parameter names
  let varParams;
  if (opts.field.isShear) {
    const shearLevel = (opts.field.levelByModel && opts.field.levelByModel[opts.model]) || 'lev_0-6000_m_above_ground';
    varParams = `var_VUCSH=on&var_VVCSH=on&${shearLevel}=on`;
  } else {
    const level = (opts.field.levelByModel && opts.field.levelByModel[opts.model]) || opts.field.level || 'lev_surface';
    varParams = `${opts.field.nomadsVar}=on&${level}=on`;
  }

  // subregion=on activates the leftlon/rightlon/toplat/bottomlat crop
  const subregion = 'subregion=&leftlon=-130&rightlon=-60&toplat=55&bottomlat=20';

  return `${base}?dir=%2F${dirMap[model]}&file=${fileMap[model]}&${varParams}&${subregion}`;
}

// Try recent runs newest-first; RAP/HRRR start 2h back, NAM uses latest posted cycle
async function fetchNomadsWithFallback(opts) {
  const model = opts.model.toLowerCase();
  const now = new Date();
  const candidates = [];

  if (model === 'nam') {
    // NAM runs 00/06/12/18z; skip current cycle until 90 min in
    let baseHour = Math.floor(now.getUTCHours() / 6) * 6;
    const minInCycle = (now.getUTCHours() % 6) * 60 + now.getUTCMinutes();
    if (minInCycle < 90) baseHour = ((baseHour - 6) + 24) % 24;
    for (let i = 0; i < 4; i++) {
      const h = ((baseHour - i * 6) + 48) % 24;
      const d = new Date(now);
      if (h > now.getUTCHours()) d.setUTCDate(d.getUTCDate() - 1);
      candidates.push({ h, d });
    }
  } else {
    // RAP/HRRR hourly; start 2h back to ensure posting, try up to 6 runs
    const startHour = now.getUTCHours() - 2;
    for (let i = 0; i < 6; i++) {
      const h = ((startHour - i) + 48) % 24;
      const d = new Date(now);
      if (h > now.getUTCHours()) d.setUTCDate(d.getUTCDate() - 1);
      candidates.push({ h, d });
    }
  }

  let lastErr;
  for (const { h, d } of candidates) {
    const url = buildNomadsUrl(opts, h, d);
    try {
      const result = await window.electronAPI.fetchAllowedBuffer(url);
      console.log(`[NOMADS] Loaded ${opts.model} run ${String(h).padStart(2,'0')}z ${d.toISOString().slice(0,10)}`);
      return result;
    } catch(e) {
      lastErr = e;
    }
  }
  throw new Error(`NOMADS unavailable after ${candidates.length} attempts: ${lastErr?.message}`);
}

// Lightweight GRIB2 reader — parses the binary section 5/6/7 for simple grid data
// This handles the most common GRIB2 packing (simple/complex) via a float32 approach.
// For our use case we decode the raw bytes passed back as base64 from main process.
async function fetchAndDecodeGrib2(opts) {
  const b64 = await fetchNomadsWithFallback(opts);
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);

  // Scan for GRIB messages (start with 'GRIB', end with '7777')
  const messages = [];
  let pos = 0;
  while (pos < buf.length - 4) {
    if (buf[pos] === 0x47 && buf[pos+1] === 0x52 && buf[pos+2] === 0x49 && buf[pos+3] === 0x42) {
      const msgLen = readUint32(buf, pos + 12);
      messages.push(buf.slice(pos, pos + msgLen));
      pos += msgLen;
    } else {
      pos++;
    }
  }
  if (!messages.length) throw new Error('No GRIB2 messages found in response');
  return messages.map(parseGrib2Message).filter(Boolean);
}

function readUint32(buf, off) {
  return ((buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]) >>> 0;
}
function readInt32(buf, off) {
  const u = readUint32(buf, off);
  return u >= 0x80000000 ? u - 0x100000000 : u;
}
function readUint16(buf, off) { return (buf[off] << 8) | buf[off+1]; }

function parseGrib2Message(msg) {
  try {
    const sec = findSections(msg);
    if (!sec[3] || !sec[5] || !sec[7]) return null;

    const s3 = sec[3];
    const gridTemplate = readUint16(msg, s3 + 12);

    let ni, nj, lats, lons;

    if (gridTemplate === 0) {
      // Lat/lon grid
      ni = readUint32(msg, s3 + 30);
      nj = readUint32(msg, s3 + 34);
      const la1 = readInt32(msg, s3 + 46) * 1e-6;
      const lo1 = (readUint32(msg, s3 + 50) * 1e-6);
      const la2 = readInt32(msg, s3 + 55) * 1e-6;
      const lo2 = (readUint32(msg, s3 + 59) * 1e-6);
      // Pre-compute lat/lon arrays
      lats = new Float32Array(nj);
      lons = new Float32Array(ni);
      for (let j = 0; j < nj; j++) lats[j] = la1 + j * (la2 - la1) / (nj - 1);
      for (let i = 0; i < ni; i++) lons[i] = lo1 + i * (lo2 - lo1) / (ni - 1);

    } else if (gridTemplate === 30) {
      // Lambert Conformal — used by RAP, NAM, HRRR
      ni = readUint32(msg, s3 + 30);
      nj = readUint32(msg, s3 + 34);
      const la1  = readInt32(msg, s3 + 38) * 1e-6;
      const lo1raw = readUint32(msg, s3 + 42);
      const lo1  = (lo1raw > 180000000 ? lo1raw - 360000000 : lo1raw) * 1e-6;
      const dx   = readUint32(msg, s3 + 55) * 1e-3; // mm → m
      const dy   = readUint32(msg, s3 + 59) * 1e-3;
      const lov  = (readUint32(msg, s3 + 47) > 180000000
                    ? readUint32(msg, s3 + 47) - 360000000
                    : readUint32(msg, s3 + 47)) * 1e-6;
      const latin1 = readInt32(msg, s3 + 65) * 1e-6;
      const latin2 = readInt32(msg, s3 + 69) * 1e-6;

      // Lambert Conformal forward/inverse projection
      const DEG = Math.PI / 180;
      const n = latin1 === latin2
        ? Math.sin(latin1 * DEG)
        : Math.log(Math.cos(latin1 * DEG) / Math.cos(latin2 * DEG)) /
          Math.log(Math.tan((45 + latin2 / 2) * DEG) / Math.tan((45 + latin1 / 2) * DEG));
      const F = Math.cos(latin1 * DEG) * Math.pow(Math.tan((45 + latin1 / 2) * DEG), n) / n;
      const rho1 = 6371229 * F / Math.pow(Math.tan((45 + la1 / 2) * DEG), n);
      const theta1 = n * (lo1 - lov) * DEG;
      const x1 = rho1 * Math.sin(theta1);
      const y1 = rho1 * Math.cos(theta1);  // note: sign convention — rho goes from pole

      // RAP/NAM/HRRR scan west→east, south→north (j=0 = SW corner, j increases northward)
      lats = new Float32Array(ni * nj);
      lons = new Float32Array(ni * nj);
      for (let j = 0; j < nj; j++) {
        for (let i = 0; i < ni; i++) {
          const x = x1 + i * dx;
          const y = y1 + j * dy;  // y increases northward (south-to-north scan)
          const rho = Math.sqrt(x * x + y * y);
          const theta = Math.atan2(x, y);
          const lat = 2 * Math.atan(Math.pow(6371229 * F / rho, 1 / n)) / DEG - 90;
          const lon = theta / (n * DEG) + lov;
          lats[j * ni + i] = lat;
          lons[j * ni + i] = lon < -180 ? lon + 360 : (lon > 180 ? lon - 360 : lon);
        }
      }
    } else {
      return null; // unsupported grid template
    }

    // Section 5: Data representation
    const s5 = sec[5];
    const packingType = readUint16(msg, s5 + 9);
    if (packingType !== 0) return null; // simple packing only

    const refVal = ieee754ToFloat([msg[s5+11], msg[s5+12], msg[s5+13], msg[s5+14]]);
    const binScale = Math.pow(2, readInt16(msg, s5 + 15));
    const decScale = Math.pow(10, -readInt16(msg, s5 + 17));
    const nBits = msg[s5 + 19];

    // Section 6: Bitmap
    const s6 = sec[6];
    let bitmap = null;
    if (s6 && msg[s6 + 5] === 0) {
      // Bitmap present
      bitmap = msg.slice(s6 + 6, s6 + readUint32(msg, s6) - 1);
    }

    // Section 7: Raw data
    const s7 = sec[7];
    const dataStart = s7 + 5;
    const nPoints = ni * nj;
    const values = new Float32Array(nPoints);

    if (nBits === 0) {
      values.fill(refVal * decScale);
    } else {
      const rawData = msg.slice(dataStart);
      let bitPos = 0;
      let bitmapIdx = 0;
      for (let i = 0; i < nPoints; i++) {
        // Skip bitmap-masked points
        if (bitmap) {
          const bmByte = Math.floor(bitmapIdx / 8);
          const bmBit  = 7 - (bitmapIdx % 8);
          bitmapIdx++;
          if (!((bitmap[bmByte] >> bmBit) & 1)) { values[i] = NaN; continue; }
        }
        let raw = 0;
        for (let b = 0; b < nBits; b++) {
          const byteIdx = bitPos >> 3;
          const bitIdx  = 7 - (bitPos & 7);
          raw = (raw << 1) | ((rawData[byteIdx] >> bitIdx) & 1);
          bitPos++;
        }
        values[i] = (refVal + raw * binScale) * decScale;
      }
    }

    return { ni, nj, gridTemplate, lats, lons, values };
  } catch(e) {
    return null;
  }
}

function findSections(msg) {
  const sections = {};
  let pos = 16;
  while (pos < msg.length - 4) {
    const secLen = readUint32(msg, pos);
    if (secLen < 5 || pos + secLen > msg.length) break;
    const secNum = msg[pos + 4];
    sections[secNum] = pos;
    pos += secLen;
    if (secNum === 7) break;
  }
  return sections;
}

function readInt16(buf, off) {
  const u = readUint16(buf, off);
  return u >= 0x8000 ? u - 0x10000 : u;
}

function ieee754ToFloat(bytes) {
  const sign = (bytes[0] >> 7) ? -1 : 1;
  const exp = ((bytes[0] & 0x7f) << 1) | (bytes[1] >> 7);
  const mantHi = bytes[1] & 0x7f;
  const mantissa = (((mantHi << 8) | bytes[2]) << 8) | bytes[3];
  if (exp === 0) return sign * mantissa * Math.pow(2, -149);
  if (exp === 255) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa * Math.pow(2, -23)) * Math.pow(2, exp - 127);
}

// Convert a Lambert Conformal (or lat/lon) grid to GeoJSON contours via D3
function gridToContourGeoJson(grid, field, opacity) {
  const { ni, nj, gridTemplate, lats, lons, values } = grid;

  if (gridTemplate === 30) {
    // For Lambert grids: scatter the data onto a regular lat/lon grid first,
    // then contour that. Use a ~0.2° resolution output grid for CONUS.
    const outLat0 = 20, outLat1 = 55, outLon0 = -130, outLon1 = -60;
    const outNi = 350, outNj = 175; // ~0.2° resolution
    const dLat = (outLat1 - outLat0) / (outNj - 1);
    const dLon = (outLon1 - outLon0) / (outNi - 1);

    // Build a regular grid by nearest-neighbor from Lambert points
    const outValues = new Float32Array(outNi * outNj).fill(NaN);
    const outCount  = new Uint16Array(outNi * outNj);

    for (let k = 0; k < ni * nj; k++) {
      if (isNaN(values[k])) continue;
      const lat = lats[k], lon = lons[k];
      if (lat < outLat0 || lat > outLat1 || lon < outLon0 || lon > outLon1) continue;
      const ci = Math.round((lon - outLon0) / dLon);
      const cj = Math.round((lat - outLat0) / dLat);
      const idx = cj * outNi + ci;
      if (outCount[idx] === 0) outValues[idx] = values[k];
      else outValues[idx] = (outValues[idx] * outCount[idx] + values[k]) / (outCount[idx] + 1);
      outCount[idx]++;
    }

    // Fill small NaN gaps by averaging neighbours
    for (let j = 1; j < outNj - 1; j++) {
      for (let i = 1; i < outNi - 1; i++) {
        const idx = j * outNi + i;
        if (!isNaN(outValues[idx])) continue;
        const neighbours = [
          outValues[(j-1)*outNi+i], outValues[(j+1)*outNi+i],
          outValues[j*outNi+(i-1)], outValues[j*outNi+(i+1)],
        ].filter(v => !isNaN(v));
        if (neighbours.length >= 2) outValues[idx] = neighbours.reduce((a,b)=>a+b,0)/neighbours.length;
      }
    }

    // Replace remaining NaNs with 0 for contour generator
    for (let k = 0; k < outValues.length; k++) if (isNaN(outValues[k])) outValues[k] = 0;

    const contourGen = d3.contours().size([outNi, outNj]).thresholds(field.thresholds);
    const contourData = contourGen(outValues);
    const features = [];
    // Each D3 contour band covers threshold[n] → ∞ (cumulative from bottom).
    // To show distinct color bands, render from highest to lowest so higher values
    // paint on top and visually "punch through" the lower-value polygons beneath.
    // We also skip the lowest band's fill entirely and use it only as a base.
    for (let idx = contourData.length - 1; idx >= 0; idx--) {
      const contour = contourData[idx];
      if (!contour.coordinates || contour.coordinates.length === 0) continue;
      const color = field.colors[idx + 1] || field.colors[field.colors.length - 1];
      const rescaled = {
        type: contour.type,
        value: contour.value,
        coordinates: contour.coordinates.map(ring =>
          ring.map(polygon =>
            polygon.map(([x, y]) => [
              outLon0 + x * dLon,
              outLat0 + y * dLat,
            ])
          )
        ),
      };
      features.push({ type: 'Feature', properties: { value: contour.value, color, opacity }, geometry: rescaled });
    }
    return { type: 'FeatureCollection', features };

  } else {
    // Lat/lon grid — lats/lons are 1D arrays
    const contourGen = d3.contours().size([ni, nj]).thresholds(field.thresholds);
    const safeValues = Array.from(values).map(v => isNaN(v) ? 0 : v);
    const contourData = contourGen(safeValues);
    const features = [];
    // Render highest threshold first — higher bands paint on top of lower ones
    for (let idx = contourData.length - 1; idx >= 0; idx--) {
      const contour = contourData[idx];
      if (!contour.coordinates || contour.coordinates.length === 0) continue;
      const color = field.colors[idx + 1] || field.colors[field.colors.length - 1];
      const rescaled = {
        type: contour.type,
        value: contour.value,
        coordinates: contour.coordinates.map(ring =>
          ring.map(polygon =>
            polygon.map(([x, y]) => [lons[Math.round(x)], lats[Math.round(y)]])
          )
        ),
      };
      features.push({ type: 'Feature', properties: { value: contour.value, color, opacity }, geometry: rescaled });
    }
    return { type: 'FeatureCollection', features };
  }
}

function buildContourLayer(geojson, opacity) {
  return L.geoJSON(geojson, {
    pane: 'contoursPane',
    style: f => ({
      fillColor: f.properties.color,
      fillOpacity: opacity * 0.85,
      color: 'none',
      weight: 0,
      fillRule: 'evenodd',
    }),
    interactive: false,
  });
}

function buildContourLegend(field, opts) {
  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = function() {
    const div = L.DomUtil.create('div', 'models-contour-legend');
    const items = field.thresholds.map((t, i) => {
      const color = field.colors[i + 1] || field.colors[field.colors.length - 1];
      return `<span class="legend-swatch" style="background:${color}"></span><span>${t}${field.unit ? ' ' + field.unit : ''}</span>`;
    });
    div.innerHTML = `<div class="legend-title">${opts.model} ${field.label} F${String(opts.hour).padStart(2,'0')}</div>${items.join('')}`;
    return div;
  };
  return legend;
}

async function updateModelsOverlay() {
  if (!modelsMapInstance) return;
  const opts = getSelectedModelOptions();

  // STP/SCP: fall back to COD image overlay since they're derived parameters
  if (opts.field.useCod) {
    updateModelsStatus(`${opts.field.label}: loading COD overlay (derived parameter)...`);
    await updateModelsCodOverlay(opts);
    return;
  }

  updateModelsStatus(`Loading ${opts.model} ${opts.field.label} from NOMADS (auto-finding latest run)...`);
  const btn = document.getElementById('models-overlay-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⌁ LOADING...'; }

  try {
    const grids = await fetchAndDecodeGrib2(opts);
    if (!grids.length) throw new Error('No decoded grid data');

    let values = grids[0].values;
    // Shear: combine U+V components → magnitude in knots
    if (opts.field.isShear && grids.length >= 2) {
      const u = grids[0].values;
      const v = grids[1].values;
      values = new Float32Array(u.length);
      for (let i = 0; i < u.length; i++) {
        values[i] = Math.sqrt(u[i]*u[i] + v[i]*v[i]) * 1.944; // m/s → kt
      }
    }

    const grid = { ...grids[0], values };
    const geojson = gridToContourGeoJson(grid, opts.field, opts.opacity);

    if (modelsOverlayLayer) modelsMapInstance.removeLayer(modelsOverlayLayer);
    modelsOverlayLayer = buildContourLayer(geojson, opts.opacity);
    modelsOverlayLayer.addTo(modelsMapInstance);
    modelsOverlayLayer.bringToBack();

    if (modelsLegendControl) modelsMapInstance.removeControl(modelsLegendControl);
    modelsLegendControl = buildContourLegend(opts.field, opts);
    modelsLegendControl.addTo(modelsMapInstance);

    updateModelsStatus(`Contours loaded: ${opts.model} ${opts.field.label} F${String(opts.hour).padStart(2,'0')}.`);
  } catch(e) {
    updateModelsStatus(`Contour load failed: ${e.message}. Try OPEN EXTERNAL for this field.`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '▶ LOAD CONTOURS'; }
  }
}

// Fallback COD raster overlay for derived fields (STP, SCP)
async function updateModelsCodOverlay(opts) {
  const codProductMap = { stp: 'stp', scp: 'scp' };
  const codProduct = codProductMap[opts.fieldKey] || opts.fieldKey;
  const listUrl = `https://weather.cod.edu/forecast/assets/php/scripts/get-files.php?parms=current-${opts.model}-US-con-${codProduct}-${opts.hour}-0-50`;
  try {
    const listText = await window.electronAPI.fetchAllowedUrl(listUrl);
    const list = JSON.parse(listText);
    if (list.err !== 'false') throw new Error(list.message || 'COD returned no data');
    const frameUrl = (list.files || []).find(u => String(u).endsWith(`_${String(opts.hour).padStart(3,'0')}.png`)) || (list.files || [])[0];
    if (!frameUrl) throw new Error('No matching frame');
    const dataUrl = await window.electronAPI.fetchAllowedDataUrl(frameUrl);

    // Parse bounds
    const parts = String(list.fsound || '').trim().split(/\s+/).map(Number);
    const bounds = (parts.length === 4 && parts.every(Number.isFinite))
      ? [[parts[3], parts[0]], [parts[1], parts[2]]]
      : [[20, -128], [57, -65]];

    if (modelsOverlayLayer) modelsMapInstance.removeLayer(modelsOverlayLayer);
    modelsOverlayLayer = L.imageOverlay(dataUrl, bounds, { opacity: opts.opacity, interactive: false });
    modelsOverlayLayer.addTo(modelsMapInstance);
    modelsOverlayLayer.bringToBack();

    if (modelsLegendControl) modelsMapInstance.removeControl(modelsLegendControl);
    modelsLegendControl = buildContourLegend(opts.field, opts);
    modelsLegendControl.addTo(modelsMapInstance);

    updateModelsStatus(`COD overlay loaded: ${opts.model} ${opts.field.label} F${String(opts.hour).padStart(2,'0')}.`);
  } catch(e) {
    updateModelsStatus(`COD overlay failed: ${e.message}`);
  }
}

function updateModelsOverlayOpacity() {
  const opts = getSelectedModelOptions();
  if (modelsOverlayLayer) {
    if (modelsOverlayLayer.setOpacity) modelsOverlayLayer.setOpacity(opts.opacity);
    else if (modelsOverlayLayer.setStyle) modelsOverlayLayer.setStyle({ fillOpacity: opts.opacity * 0.9, opacity: opts.opacity * 0.5 });
  }
  updateModelsStatus();
}

function buildSoundingSrcdoc(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const images = [...doc.querySelectorAll('img')];
  const soundingImages = images
    .filter(img => {
      const src = img.getAttribute('src') || '';
      const width = Number(img.getAttribute('width') || img.naturalWidth || 0);
      const height = Number(img.getAttribute('height') || img.naturalHeight || 0);
      return !/icon|button|close|compass|current|pending|ajax|loading/i.test(src) && (width >= 300 || height >= 300 || /sound|skew|fsound|\.png/i.test(src));
    })
    .map(img => img.outerHTML)
    .join('');

  const readableStyles = `
    <style>
      html, body { background: #050505 !important; color: transparent !important; }
      body { font-size: 0 !important; }
      body * { color: transparent !important; text-shadow: none !important; }
      p, pre, table, form, input, select, button, label, h1, h2, h3, h4, h5, h6, ul, ol, li, a, hr { display: none !important; }
      img, canvas, svg {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        max-width: 100% !important;
        height: auto !important;
        margin: 0 auto !important;
        background: transparent !important;
      }
    </style>`;
  if (soundingImages) {
    return `<!doctype html><html><head><base href="https://weather.cod.edu/forecast/fsound/">${readableStyles}</head><body>${soundingImages}</body></html>`;
  }
  const withBase = html.replace(/<head>/i, '<head><base href="https://weather.cod.edu/forecast/fsound/">');
  if (/<\/head>/i.test(withBase)) return withBase.replace(/<\/head>/i, readableStyles + '</head>');
  return readableStyles + withBase;
}

function buildCodSoundingUrl(opts) {
  // Map field key to a COD sounding product code
  const codSoundMap = { mlcape: 'mlcape', sbcape: 'sbcape', mucape: 'mucape', stp: 'stp', scp: 'scp', srh01: '1kmhel', srh03: '3kmhel', cin: 'mlcape', shear06: 'mlcape' };
  const codProduct = codSoundMap[opts.fieldKey] || 'mlcape';
  const type = [
    'current',
    opts.model,
    'US',
    'con',
    codProduct,
    String(opts.hour),
    `${selectedModelPoint.lat.toFixed(2)},${selectedModelPoint.lon.toFixed(2)}`,
    opts.parcel,
    'severe',
  ].join('|');
  return 'https://weather.cod.edu/forecast/fsound/index.php?type=' + encodeURIComponent(type);
}

function buildCodModelPageUrl(opts) {
  const codSoundMap = { mlcape: 'mlcape', sbcape: 'sbcape', stp: 'stp', scp: 'scp', srh01: '1kmhel', srh03: '3kmhel' };
  const codProduct = codSoundMap[opts.fieldKey] || 'mlcape';
  return `https://weather.cod.edu/forecast/?parms=current-${opts.model}-US-con-${codProduct}-${opts.hour}-0-50`;
}

function buildPivotalModelPageUrl(opts) {
  const pivotalMap = { mlcape: 'mlcape', sbcape: 'sbcape', stp: 'stp', scp: 'scp', srh01: 'srh01', srh03: 'srh03' };
  const pivotalProduct = pivotalMap[opts.fieldKey] || 'mlcape';
  return `https://www.pivotalweather.com/model.php?m=${opts.model.toLowerCase()}&p=${pivotalProduct}&r=conus&fh=${opts.hour}`;
}

function selectedSoundingUrl() {
  const opts = getSelectedModelOptions();
  if (opts.model === 'HRRR') return buildPivotalModelPageUrl(opts);
  return buildCodSoundingUrl(opts);
}

async function loadSelectedSounding() {
  const opts = getSelectedModelOptions();
  const frame = document.getElementById('models-sounding-frame');
  const placeholder = document.getElementById('models-placeholder');
  if (!frame) return;

  if (opts.model === 'HRRR') {
    frame.removeAttribute('src');
    if (placeholder) {
      placeholder.style.display = '';
      placeholder.innerHTML = `
        <div class="es-icon">HRRR</div>
        <div class="es-label">EXTERNAL SOUNDING REQUIRED</div>
        <div class="es-sub">COD marks HRRR forecast soundings unavailable. Click OPEN MODEL PAGE, then use Pivotal/COD's click-for-sounding tool near ${formatModelPoint()}.</div>`;
    }
    openSelectedModelPage();
    updateModelsStatus('HRRR model page opened externally for click-for-sounding.');
    return;
  }

  const url = buildCodSoundingUrl(opts);
  if (placeholder) {
    placeholder.style.display = '';
    placeholder.innerHTML = `
      <div class="es-icon">⌁</div>
      <div class="es-label">LOADING SOUNDING</div>
      <div class="es-sub">Fetching COD ${opts.model} severe sounding for ${formatModelPoint()}...</div>`;
  }
  try {
    const html = await window.electronAPI.fetchAllowedUrl(url);
    frame.removeAttribute('src');
    frame.srcdoc = buildSoundingSrcdoc(html);
    if (placeholder) placeholder.style.display = 'none';
    updateModelsStatus(`Loaded ${opts.model} severe sounding for ${formatModelPoint()}.`);
  } catch (e) {
    if (placeholder) {
      placeholder.style.display = '';
      placeholder.innerHTML = `
        <div class="es-icon">!</div>
        <div class="es-label">SOUNDING FETCH FAILED</div>
        <div class="es-sub">Could not load the COD sounding in-app. Use OPEN EXTERNAL for ${formatModelPoint()}.</div>`;
    }
    updateModelsStatus(`Sounding fetch failed: ${e.message || e}`);
  }
}

function openSelectedSoundingExternal() {
  const url = selectedSoundingUrl();
  if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
  else window.open(url, '_blank');
}

function openSelectedModelPage() {
  const opts = getSelectedModelOptions();
  const url = opts.model === 'HRRR' ? buildPivotalModelPageUrl(opts) : buildCodModelPageUrl(opts);
  if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
  else window.open(url, '_blank');
}

function updateModelsStatus(extra) {
  const status = document.getElementById('models-status');
  if (!status) return;
  const opts = getSelectedModelOptions();
  const mode = opts.model === 'HRRR' ? 'external model page' : 'in-app COD sounding';
  status.innerHTML = `
    <strong>${opts.model}</strong> · ${opts.field.label} · F${String(opts.hour).padStart(2, '0')} · ${formatModelPoint()}<br>
    MODE: ${mode}${extra ? `<br>${esc(extra)}` : ''}`;
}
// ── VROT Calculator ──────────────────────────────────────────────
let vrotInitialized = false;

function renderVrotTab() {
  const panel = document.getElementById('vrot-panel');
  if (!panel) return;
  if (vrotInitialized) return;
  vrotInitialized = true;

  panel.innerHTML = `
    <div style="padding:12px;">
      <div class="section-header" style="color:#00ffcc;border-bottom:1px solid #00ffcc22;margin-bottom:10px;">▸ VROT CALCULATOR</div>
      <div style="font-size:10px;color:#555;margin-bottom:10px;letter-spacing:1px;">ENTER INBOUND AND OUTBOUND VELOCITIES</div>

      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <label style="font-size:10px;color:#888;width:90px;letter-spacing:1px;">INBOUND (kt)</label>
          <input id="vrot-inbound" type="number" placeholder="e.g. -60"
            style="background:#111;border:1px solid #333;color:#ccc;font-family:monospace;
                   font-size:12px;padding:5px 8px;border-radius:2px;width:100px;outline:none;"/>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <label style="font-size:10px;color:#888;width:90px;letter-spacing:1px;">OUTBOUND (kt)</label>
          <input id="vrot-outbound" type="number" placeholder="e.g. 70"
            style="background:#111;border:1px solid #333;color:#ccc;font-family:monospace;
                   font-size:12px;padding:5px 8px;border-radius:2px;width:100px;outline:none;"/>
        </div>
      </div>

      <button id="vrot-calc-btn"
        style="background:#1a1a1a;border:1px solid #00ffcc44;color:#00ffcc;font-family:monospace;
               font-size:11px;padding:6px 18px;border-radius:2px;cursor:pointer;letter-spacing:1px;margin-bottom:14px;">
        CALCULATE
      </button>

      <div id="vrot-result" style="display:none;padding:10px;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:2px;">
        <div style="font-size:10px;color:#555;letter-spacing:1px;margin-bottom:6px;">RESULT</div>
        <div id="vrot-value" style="font-size:24px;font-weight:700;font-family:monospace;margin-bottom:4px;"></div>
        <div id="vrot-label" style="font-size:11px;font-family:monospace;"></div>
        <div id="vrot-details" style="font-size:10px;color:#555;margin-top:8px;line-height:1.8;"></div>
      </div>

      <div style="margin-top:14px;border-top:1px solid #111;padding-top:10px;">
        <div style="font-size:8px;color:#333;letter-spacing:1px;margin-bottom:6px;">REFERENCE</div>
        <div style="font-size:9px;color:#444;line-height:2;font-family:monospace;">
          &lt; 40 kt  — WEAK / NO TORNADO<br>
          40–59 kt — LOW-END TORNADO POSSIBLE<br>
          60–79 kt — MODERATE TORNADO THREAT<br>
          80–99 kt — SIGNIFICANT TORNADO THREAT<br>
          100+ kt  — VIOLENT TORNADO POSSIBLE
        </div>
      </div>
    </div>`;

  document.getElementById('vrot-calc-btn').addEventListener('click', calcVrot);
  document.getElementById('vrot-inbound').addEventListener('keydown', e => { if (e.key === 'Enter') calcVrot(); });
  document.getElementById('vrot-outbound').addEventListener('keydown', e => { if (e.key === 'Enter') calcVrot(); });
}

function calcVrot() {
  const inbound  = parseFloat(document.getElementById('vrot-inbound').value);
  const outbound = parseFloat(document.getElementById('vrot-outbound').value);
  if (isNaN(inbound) || isNaN(outbound)) return;

  const vrot = (Math.abs(inbound) + Math.abs(outbound)) / 2;

  let color, label;
  if (vrot < 40)       { color = '#888888'; label = 'WEAK — TORNADO UNLIKELY'; }
  else if (vrot < 60)  { color = '#ffff00'; label = 'LOW-END TORNADO POSSIBLE'; }
  else if (vrot < 80)  { color = '#ff9900'; label = 'MODERATE TORNADO THREAT'; }
  else if (vrot < 100) { color = '#ff4400'; label = 'SIGNIFICANT TORNADO THREAT'; }
  else                 { color = '#ff00ff'; label = 'VIOLENT TORNADO POSSIBLE'; }

  const result  = document.getElementById('vrot-result');
  const valEl   = document.getElementById('vrot-value');
  const labelEl = document.getElementById('vrot-label');
  const details = document.getElementById('vrot-details');

  result.style.display = '';
  result.style.borderColor = color + '44';
  valEl.textContent  = vrot.toFixed(1) + ' kt';
  valEl.style.color  = color;
  labelEl.textContent = label;
  labelEl.style.color = color;
  details.innerHTML  =
    `INBOUND: ${inbound} kt<br>OUTBOUND: +${outbound} kt<br>VROT: (${Math.abs(inbound)} + ${Math.abs(outbound)}) / 2 = ${vrot.toFixed(1)} kt`;
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
    else if (activeTab === 'vrot') renderVrotTab();

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

const btnEas = document.getElementById('btn-eas');
btnEas.classList.add('active');
btnEas.addEventListener('click', () => {
  easEnabled = !easEnabled;
  btnEas.classList.toggle('active', easEnabled);
  btnEas.textContent = easEnabled ? '🔊 EAS' : '🔇 EAS';
});

const btnWea = document.getElementById('btn-wea');
btnWea.classList.add('active');
btnWea.addEventListener('click', () => {
  weaEnabled = !weaEnabled;
  btnWea.classList.toggle('active', weaEnabled);
  btnWea.textContent = weaEnabled ? '🔊 WEA' : '🔇 WEA';
});
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
  if (shouldPlayEasForWarning(warning) && easEnabled) {
    playAudio(TORE_SOUND_URL);
    return;
  }
  if (shouldPlayWeaForWarning(warning) && weaEnabled) {
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