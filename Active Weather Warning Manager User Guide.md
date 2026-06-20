# GR Active Warnings Dashboard — Full Feature Documentation

---

## Overview

GR Active Warnings is an Electron desktop app that monitors active severe weather warnings, watches, mesoscale discussions, and spotter reports in real time. It sits always-on-top of other windows, updates every second, and plays audio alerts for high-end events.

---

## Data Sources

| Source | What It Provides | Refresh Rate |
|---|---|---|
| `api.weather.gov` | Tornado & Severe Thunderstorm Warnings, Watches | Every 1 second (fast loop) |
| `weather.cod.edu` | COD warning feed (often faster than NWS API) | Every 1 second (fast loop) |
| `spc.noaa.gov` | Mesoscale Discussions, Day 1 Outlooks | Every 10 seconds |
| `spotternetwork.org` | Spotter Network tornado/funnel reports | Every 15 seconds |

---

## Fetch Architecture

The app runs two separate fetch loops to maximize warning speed:

**Fast loop (every 1 second):** Fetches warnings and watches only. As soon as new warning data arrives, the warnings list renders immediately — it does not wait for MDs, spotter reports, or outlooks to finish.

**Full loop (every 10 seconds):** Fetches everything including MDs, spotter reports, and SPC outlooks. These are slower endpoints that don't need sub-second updates.

On startup, the fast loop fires immediately and the full loop fires 500ms later so warnings show up before slower endpoints finish loading.

---

## Warning Classification

Warnings are classified into types and variants using tags from the NWS API (`tornadoDetection`, `thunderstormDamageThreat`, `tornadoDamageThreat`) and by scanning the full warning text.

### Tornado Warnings

| Variant | Label | Color | Rank | Trigger |
|---|---|---|---|---|
| `base` | TOR | Red `#FF0000` | 10 | Default tornado warning |
| `observed` | TOR OBSERVED | Bright Red `#FF3333` | 11 | `OBSERVED` tag detected |
| `pds` | TOR PDS | Magenta `#FF00FF` | 12 | `PARTICULARLY DANGEROUS SITUATION` in tags or text |
| `emergency` | TOR EMERGENCY | Pink `#FF69B4` | 13 | `CATASTROPHIC` or `EMERGENCY` tag detected |

### Severe Thunderstorm Warnings

| Variant | Label | Color | Rank | Trigger |
|---|---|---|---|---|
| `base` | SVR | Orange `#FFA500` | 4 | Default SVR |
| `considerable` | SVR CONSIDERABLE | Dark Orange `#FF6600` | 5 | `CONSIDERABLE` tag |
| `destructive` | SVR DESTRUCTIVE | Red-Orange `#FF4500` | 6 | `DESTRUCTIVE` tag |
| `tor_possible` | SVR TOR POSSIBLE | Yellow `#FFFF00` | 7 | `TORNADO POSSIBLE` tag |

### Watches

| Variant | Label | Color | Rank |
|---|---|---|---|
| TOR WATCH `base` | TOR WATCH | Yellow `#FFFF00` | 8 |
| TOR WATCH `pds` | TOR WATCH PDS | Magenta `#FF00FF` | 9 |
| SVR WATCH `base` | SVR WATCH | Red `#ff0000` | 3 |

---

## Dual Data Source: COD + NWS API

Warnings are pulled from **both** COD (weather.cod.edu) and the NWS API simultaneously, then merged:

1. COD warnings are parsed first — COD often receives and publishes warnings faster than the NWS API propagates them.
2. NWS API warnings are parsed separately.
3. Each COD warning is **enriched** by finding its matching NWS warning using office code, county overlap scoring, and time delta matching.
4. The enriched result keeps COD's timing advantage but gets NWS's full detail (headline, description, instruction, geometry).
5. Any NWS warnings that don't have a COD match are added as supplemental entries.

This dual-source approach means you typically see warnings 1–3 seconds faster than apps that only poll the NWS API.

---

## COD Warning Product Meta Fetch

For each COD warning, the app also fetches the raw warning product text page from COD. This text is parsed to extract:

- **Tornado detection** (`TORNADO...OBSERVED`, `TORNADO...RADAR INDICATED`)
- **Tornado damage threat** (`TORNADO DAMAGE THREAT...CONSIDERABLE/CATASTROPHIC`)
- **Thunderstorm damage threat** (`THUNDERSTORM DAMAGE THREAT...DESTRUCTIVE`)
- **Max hail size** (`MAX HAIL SIZE...`)
- **Max wind gust** (`MAX WIND GUST...`)
- **Emergency/PDS language** scanned directly in the text

If this meta fetch upgrades a warning's variant (e.g. `base` → `pds` or `pds` → `emergency`), the warning re-renders immediately and the appropriate audio alert fires.

---

## Warning Display & Sorting

### Sort Priority

Warnings are sorted by this logic in order:

1. Warnings expiring within 10 minutes are pushed to the **bottom** (fading out)
2. New/flashing warnings sort to the **top**
3. Then sorted by **rank** (highest severity first)
4. Then by **expires** time (longer-lasting first)

### Columns

The warnings panel splits into two columns:
- **TOR** column — all tornado warnings
- **SVR** column — all severe thunderstorm warnings

Each column shows its own count in the header.

### Warning Row Details

Each warning row shows:
- **Colored left border** matching the variant color
- **Blinking dot** for new warnings (pulses for 90 seconds after issue)
- **Label** (TOR, TOR PDS, SVR DESTRUCTIVE, etc.) in variant color
- **Radar site** (e.g. `KTLX`) or office code if radar lookup is still pending
- **Affected area** (county/parish list)
- **Tag pills** — HAIL size, WIND speed, DAMAGE THREAT, TOR POSSIBLE, TOR OBSERVED
- **Time bar** — shows issued time, expiry time, and a progress bar filling left to right as the warning ages
- **Time remaining** displayed as `Xh Ym` or `Xm`, colored green/yellow/red as it gets close

### Expand / Collapse

Clicking any warning row expands it to show:
- Full EAS-style headline in all caps
- Issued and expires timestamps
- Damage threat, hail size, wind gust, tornado detection details
- Full warning description text (up to 3000 characters)
- Precautionary/preparedness actions (up to 1500 characters)

Scroll position is preserved when the list re-renders so expanded warnings don't jump.

### Fading Near Expiry

Warnings within 10 minutes of expiry fade to 40% opacity to visually indicate they're almost done.

### Row Flash Animation

New warnings flash (step-start blink at 0.75s) until they are expanded or until 90 seconds have passed since issue.

---

## Radar Site Lookup

For every warning and spotter report, the app determines the **closest NWS radar site** by:

1. Computing the geographic center of the warning polygon (average of all coordinate points)
2. Calling `api.weather.gov/points/{lat},{lon}` to get the nearest radar station
3. Displaying the radar ID (e.g. `KTLX`, `KFWS`) next to the office code in the warning row

Results are **cached** by lat/lon (rounded to 3 decimal places) so the same area never triggers duplicate API calls.

For spotter reports, the same lookup runs using the report's exact lat/lon coordinates. The radar ID appears in the report row header.

---

## Watches Tab

Watches are fetched from the NWS API and displayed in two sections:
- **Tornado Watches** (including PDS detection)
- **Severe Thunderstorm Watches**

**PDS detection for watches:** The app fetches the full watch product page from SPC (`spc.noaa.gov/products/watch/wwNNNN.html`) and scans the text for "PARTICULARLY DANGEROUS SITUATION". If found, the watch is upgraded to the `pds` variant (magenta) and re-renders immediately.

**Duplicate filtering:** Watches with the same watch number are deduplicated even if the NWS API returns them multiple times (which it often does for multi-state watches).

Watch rows show: label, watch number, affected states, time bar, and expandable full text.

---

## Mesoscale Discussions (MDs) Tab

MDs are fetched from the SPC products page and displayed with:
- MD number
- Affected area description
- **CONCERNING** line (parsed from the product text, e.g. `CONCERNING...TORNADO WATCH POSSIBLE`)
- **Watch probability** percentage (parsed from `PROBABILITY OF WATCH ISSUANCE...XX PERCENT`)
- Full discussion text on expand (fetched on demand from SPC)

MDs are marked as new (flashing) when they first appear and settle after 90 seconds.

---

## Spotter Network (SN) Tab

Spotter reports are fetched from the Spotter Network feed every 15 seconds. Only reports from the **last 20 minutes** are shown.

Filtered report types displayed:
- **Tornado** — red theme
- **Funnel Cloud** — orange theme
- **Wall Cloud** — yellow theme

Each report row shows:
- Report type
- Time issued
- Closest radar site (async lookup)
- Lat/lon coordinates
- Reporter name
- Notes (on expand: full location, extras, notes)

Reports are marked new (flashing) for 90 seconds after they first appear.

---

## Map Tab

The map uses Leaflet with a dark CartoDB basemap. It displays toggleable layers:

| Layer | Default | Description |
|---|---|---|
| Warnings | On | Filled polygons for all active TOR/SVR warnings, colored by variant |
| Watches | On | Watch area polygons |
| MDs | On | MD area outlines |
| Reports | On | Circle markers for spotter reports |
| SPC D1 Cat | On | SPC Day 1 categorical outlook polygons |
| SPC D1 Tor | Off | Tornado probability polygons |
| SPC D1 Wind | Off | Wind probability polygons |
| SPC D1 Hail | Off | Hail probability polygons |

**Warning polygons** are colored by variant (red for TOR, orange for SVR, etc.) with reduced opacity fill and solid border.

**Auto-fit:** When new warnings arrive, the map auto-fits to show all warning polygons — unless the user has manually panned or zoomed, in which case their view is preserved.

**Polygon caching:** Warning geometry is cached by warning ID so polygons don't get re-parsed on every render cycle.

**Clicking a polygon** shows a popup with the warning label, area, and time remaining.

---

## SPC Outlooks (in Map + Renderer)

Day 1 categorical and probabilistic outlooks are loaded from SPC GeoJSON:
- `day1otlk_cat` — categorical (TSTM through HIGH)
- `day1otlk_torn` — tornado probabilities
- `day1otlk_wind` — wind probabilities
- `day1otlk_hail` — hail probabilities

Each outlook area is filled with its category color and labeled in a popup.

**High-risk sound alert:** When a HIGH or 45%+ tornado/wind/hail outlook is detected and is new, the **CD Thunderbolt civil defense siren** plays automatically.

---

## Audio Alerts

| Sound | File | Trigger |
|---|---|---|
| EAS Tone | `tore-eas.mp3` | New TOR PDS or TOR EMERGENCY warning |
| WEA Tone | `wea-sound.mp3` | New SVR DESTRUCTIVE warning |
| Spotter Alert | `spotter-network-new.mp3` | New tornado/funnel/wall cloud spotter report |
| CD Thunderbolt Siren | `cd-thunderbolt-siren.mp3` | HIGH risk or 45%+ outlook detected |
| Synth Siren (fallback) | Generated in-app | Plays if CD Thunderbolt audio file fails to load |

### EAS/WEA Toggle Buttons

The `🔊 EAS` and `🔊 WEA` buttons in the title bar toggle those alert sounds on/off independently. State is shown by button highlight.

### Sound Logic

- On first load, all currently active warnings are silently marked as already-sounded so the app doesn't blast audio for existing events.
- A warning only triggers sound if it is **new** (not seen before) OR if it **upgraded variant** (e.g. base → PDS).
- New arrivals have a 20-minute window from issued time. Upgrades have a 30-minute window (PDS upgrades can come in well after the original issue time).
- Each unique type+variant+issued combination is tracked in `soundedWarningKeys` so the same event never plays twice.

### Keyboard Hotkeys (Dev/Testing)

| Hotkey | Action |
|---|---|
| `Ctrl+1` | Toggle EAS tone |
| `Ctrl+2` | Toggle WEA tone |
| `Ctrl+3` | Toggle CD Thunderbolt siren |

---

## VROT Calculator Tab

A simple tool for computing **rotational velocity** from dual-pol radar data:

- Enter inbound velocity (negative) and outbound velocity (positive) in knots
- App computes `VROT = (|inbound| + |outbound|) / 2`
- Color-coded result with threat label:

| VROT | Color | Label |
|---|---|---|
| < 40 kt | Gray | WEAK — TORNADO UNLIKELY |
| 40–59 kt | Yellow | LOW-END TORNADO POSSIBLE |
| 60–79 kt | Orange | MODERATE TORNADO THREAT |
| 80–99 kt | Red | SIGNIFICANT TORNADO THREAT |
| 100+ kt | Magenta | VIOLENT TORNADO POSSIBLE |

Press Enter in either field to calculate.

---

## Status Bar

The status bar at the top shows:
- **Green LED + LIVE** — data is updating normally
- **Gray LED + NO ACTIVE WARNINGS** — connected but nothing active
- **Red LED + ERROR** — fetch failed, shows error message
- **Last update timestamp** (hours:minutes:seconds)
- The title bar dot also changes color to reflect TOR/emergency state

The status bar background turns red during any active tornado warning, and a brighter red/pink during PDS/Emergency warnings.

---

## Title Bar Controls

| Button | Function |
|---|---|
| `🔊 EAS` | Toggle EAS alert sound on/off |
| `🔊 WEA` | Toggle WEA alert sound on/off |
| `📌` | Toggle always-on-top (highlighted = on) |
| `─` | Minimize window |
| `✕` | Close app |

The window is **always-on-top by default** and stays above other windows including full-screen apps.

---

## Footer

Shows a live count: `XW XWT XMD XSN · 1.5s` (warnings, watches, MDs, spotter reports, and poll interval label).

When an auto-update is available, the footer changes to show download progress and a clickable install prompt.

---

## Dev Tab

Password-protected developer panel (password: `DEVTEST26`).

Features:
- **Inject test warnings** — any variant of TOR or SVR, including PDS and EMERGENCY
- **Remove individual test warnings** or clear all at once
- **Live stats** — count of warnings by source (COD / NWS / TEST), watches, MDs, spotter reports, last update time
- Test warning injections also trigger the appropriate audio alert so sounds can be tested without waiting for real events

---

## Auto-Updater

Uses `electron-updater` to check for new GitHub releases every 4 hours in production builds. When an update downloads, the footer shows a green "READY — CLICK TO INSTALL" prompt. Clicking it quits and installs the update immediately.

---

## Performance Notes

- **Render deduplication:** Every list (warnings, watches, MDs, reports) computes a hash of its current data before rendering. If the hash hasn't changed since the last render, the DOM is not touched — preventing unnecessary repaints on every fetch cycle.
- **Scroll preservation:** The scroll position of every expanded warning and the overall list scroll are saved before re-render and restored after, so the view never jumps.
- **Radar lookup caching:** NWS point API calls are cached by rounded coordinates so each unique location is only looked up once per session.
- **COD product caching:** Warning product text pages from COD are cached by URL so they're only fetched once even if the warning stays active across many cycles.
- **Polygon caching:** Warning polygon GeoJSON is cached by warning ID so the map doesn't re-parse geometry on every 1-second cycle.
