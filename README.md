
# GR Active Warnings

A GR2Analyst-style active severe weather warnings window for Windows.
Displays live Tornado and Severe Thunderstorm warnings from the NWS, updating every 1.5 seconds.

---

## Warning Types

### Tornado Warnings
| Display        | Trigger                     | Color  |
|----------------|-----------------------------|--------|
| TOR            | Base tornado warning        | Red    |
| TOR OBSERVED   | Observed tornado            | Bright Red |
| TOR PDS        | Particularly Dangerous Situation | Magenta |
| TOR EMERGENCY  | Tornado Emergency           | Pink   |

### Severe Thunderstorm Warnings
| Display              | Trigger                        | Color  |
|----------------------|--------------------------------|--------|
| SVR                  | Base SVR warning               | Orange |
| SVR CONSIDERABLE     | Considerable damage threat     | Deep Orange |
| SVR DESTRUCTIVE      | Destructive damage threat      | Red-Orange |
| SVR TOR POSSIBLE     | Tornado possible tag           | Yellow |

---

## Features
- Updates every 1.5 seconds from api.weather.gov (NWS)
- New warnings blink until 90 seconds old
- Click any row to expand full EAS warning text
- Time bar shows elapsed/remaining time (turns red under 15 min)
- Always-on-top toggle (📌 button)
- Frameless window — drag anywhere on the title bar

---

## Build Instructions

### Requirements
- Windows 10/11 (64-bit)
- [Node.js](https://nodejs.org) v18 or newer (LTS recommended)
- Internet connection (to download Electron during build)

### Steps

**Option A — Double-click (easiest)**
1. Double-click `BUILD.bat`
2. Wait ~2 minutes
3. Your EXE files will be in the `dist/` folder

**Option B — Command line**
```
npm install
npm run build
```

### Output files in `dist/`
- `GR Active Warnings Setup.exe` — installer (creates Start Menu + Desktop shortcut)
- `GR Active Warnings.exe` — portable, runs without installing

---

## Run without building (for development)
```
npm install
npm start
```

---

## Data Source
NWS Public API — `api.weather.gov`  
No API key required. Data is public domain.

---

## Notes
- The `assets/icon.ico` placeholder must be replaced with a real `.ico` file before building,
  or remove the `"icon"` lines from `package.json` to use the default Electron icon.
- Warnings are filtered to: Tornado Warning, Severe Thunderstorm Warning only.
