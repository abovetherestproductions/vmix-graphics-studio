# Companion & vMix Integration Guide

## Overview

Each graphic template is a separate URL loaded as a **vMix Web Browser input**.
Control happens via HTTP from Bitfocus Companion (or vMix scripting).
The server must be running before vMix loads the inputs.

---

## 1. Start the Server

```bash
cd /path/to/vmix-html-graphics-starter
npm start
```

Server starts on **http://127.0.0.1:3012**

---

## 2. vMix — One Web Browser Input Per Template

Add a Web Browser input in vMix for each graphic you use:

| Template         | URL                                               |
|------------------|---------------------------------------------------|
| Starting Order   | `http://127.0.0.1:3012/graphics/starting-order/` |
| Scoring Display  | `http://127.0.0.1:3012/graphics/scoring/`        |
| Lower Third      | `http://127.0.0.1:3012/graphics/lower-third/`    |
| Up Next          | `http://127.0.0.1:3012/graphics/up-next/`        |
| Standings        | `http://127.0.0.1:3012/graphics/standings/`      |
| Officials        | `http://127.0.0.1:3012/graphics/officials/`      |
| Elements Tracker | `http://127.0.0.1:3012/graphics/elements/`       |
| Skater Profile   | `http://127.0.0.1:3012/graphics/skater-profile/` |
| Operator Panel   | `http://127.0.0.1:3012/operator/`                |

**Web Browser input settings:**
- Width: 1920 / Height: 1080
- Background: Transparent (check "Enable Transparency" / "Custom CSS: body { background: transparent; }")
- Hardware Decode: Off
- Zoom: 100%

---

## 3. REST API Reference

All endpoints on `http://127.0.0.1:3012`

### Show a graphic
```
POST /api/graphics/{template}/show
```
Animates the graphic in. Optionally pass a `data` body to update content at the same time:
```json
{ "data": { "name": "Skater Name", "club": "Club" } }
```

### Hide a graphic
```
POST /api/graphics/{template}/hide
```

### Push new data (while already visible — triggers animateUpdate)
```
POST /api/graphics/{template}/update
Body: { "data": { ... } }
```

### Replace full payload (use for pre-loading data before showing)
```
POST /api/graphics/{template}/data
Body: { "meta": {...}, "control": {...}, "data": {...} }
```

### Normalize from Skate Canada feed (load + show in one step)
```
GET /api/normalize?source={url-or-path}&template={template}[&group=1][&maxRows=6]
```
Examples:
```
GET /api/normalize?source=http://scoring.site/startOrder.php&template=starting-order&group=2
GET /api/normalize?source=/Users/operator/officials.csv&template=officials
```

### Status check
```
GET /api/status
```

---

## 4. Bitfocus Companion Setup

### Module
Use the **Generic HTTP** module (or **HTTP Requests** module in Companion v3).

### Base URL
Set `http://127.0.0.1:3012` as the base URL.

### Button layout per template (example: Lower Third)

| Button Label | Action                | HTTP Method | Path                              |
|---|---|---|---|
| LT IN        | HTTP Request          | POST        | `/api/graphics/lower-third/show`  |
| LT OUT       | HTTP Request          | POST        | `/api/graphics/lower-third/hide`  |
| LT UPDATE    | HTTP Request          | POST        | `/api/graphics/lower-third/update`|

### Recommended Stream Deck layout

```
Row 1: [SO IN] [SO OUT] [SO UPDATE]   ← Starting Order
Row 2: [SC IN] [SC OUT]               ← Scoring
Row 3: [LT IN] [LT OUT]              ← Lower Third
Row 4: [UN IN] [UN OUT]              ← Up Next
Row 5: [ST IN] [ST OUT]              ← Standings
```

### Load Skate Canada start order (Companion HTTP action)
```
GET http://127.0.0.1:3012/api/normalize?source=http://YOUR-SCORING-SERVER/startOrder.php&template=starting-order&group=1
```
Then immediately show:
```
POST http://127.0.0.1:3012/api/graphics/starting-order/show
```

---

## 5. vMix Scripting (no Companion)

Use the **Script** function in vMix with VB.NET:

```vbnet
' Show Starting Order
Dim wc As New System.Net.WebClient
wc.UploadString("http://127.0.0.1:3012/api/graphics/starting-order/show", "POST", "")
```

Or use the vMix HTTP trigger action:
- Type: HTTP Request
- URL: `http://127.0.0.1:3012/api/graphics/starting-order/show`
- Method: POST

---

## 6. Data Payload Shapes

### Starting Order
```json
{
  "meta":    { "template": "starting-order", "revision": 1042, "updatedAt": "..." },
  "control": { "visible": true, "state": "animateIn", "durationMs": 700 },
  "data": {
    "title": "Short Program",
    "subtitle": "Group 1",
    "groupNumber": 1,
    "rowCount": 6,
    "rows": [
      { "position": 1, "name": "Skater Name", "club": "Club", "section": "BC/YT",
        "flagUrl": "/assets/flags/BC.png", "status": null }
    ]
  }
}
```

### Scoring Display
```json
{
  "data": {
    "segmentType": "SP",
    "name": "Skater Name", "club": "Club", "section": "BC",
    "rank": 1,
    "tes": 38.72, "pcs": 29.45, "deductions": 0.00, "total": 68.17
  }
}
```
`segmentType` values: `SP` (Short Program), `FS` (Free Skating), `FD` (Free Dance), `SD` (Rhythm Dance)

### Lower Third
```json
{
  "control": { "visible": true, "state": "animateIn", "holdMs": 5000 },
  "data": { "line1": "Skater Name", "line2": "Club · Section", "logoUrl": "" }
}
```
Set `holdMs` > 0 for auto-hide after that many milliseconds.

### Up Next
```json
{
  "data": {
    "mode": "up-next",
    "label": "UP NEXT",
    "startNumber": 3,
    "name": "Skater Name", "club": "Club", "section": "BC/YT",
    "event": "Women Short Program",
    "flagUrl": "/assets/flags/BC.png"
  }
}
```
`mode` values: `up-next`, `on-ice`

### Elements Tracker
```json
{
  "data": {
    "name": "Skater Name",
    "runningTotal": 14.80,
    "currentIndex": 2,
    "elements": [
      { "code": "3Lz", "baseValue": 5.90, "goe": 0.50 },
      { "code": "2A",  "baseValue": 3.30, "goe": 0.40 }
    ]
  }
}
```
Push a new payload each time an element is called. The most recently added element (at `currentIndex`) is highlighted.

---

## 7. Event Theming

Edit `public/data/event-config.json` to change colours for each event:

```json
{
  "eventName": "BC/YT Sectionals 2026",
  "theme": {
    "accentColor": "#C8102E",
    "headerGradientStart": "#8B0B20",
    "headerGradientEnd":   "#E8213F"
  }
}
```

Or use the **Operator Panel** at `http://127.0.0.1:3012/operator/` to edit and save from a browser.

---

## 8. Adding Province Flags

Drop PNG files into `public/assets/flags/` named by province code:
`AB.png BC.png MB.png NB.png NL.png NS.png NT.png NU.png ON.png PE.png QC.png SK.png YT.png`

Recommended size: 40×26 px at 2× (80×52 px), transparent background.
