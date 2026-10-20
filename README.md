# FlyMaps

Fly over the real world in your browser. FlyMaps is a drone-style 3D explorer built with Vite and CesiumJS on top of Google's Photorealistic 3D Tiles.

## Features

- **Flight:** fly with a drone controller (acro/FPV) or the keyboard (airplane mode), three drone presets (sporty, relaxed, cinematic), adjustable camera tilt and FOV, optional stick overlay
- **Navigation:** place search, random location, nearby landmarks (from Wikidata), location banner, minimap, horizon indicator, favorites
- **Collision detection** with buildings and terrain
- **Looks:** analog FPV OSD, day/night mode with stars and moon, aspect ratios (16:9 to 1:1), and filters for contrast, saturation, brightness, sepia, blue tint, vignette, film grain, analog video noise, blur, fisheye and miniature (tilt-shift)
- **Sound:** drone and wind audio
- **Crash log** for diagnosing WebGL/render crashes

## Controls

There are two alternative ways to fly.

### Drone controller (FPV / acro)

Plug in a controller in USB joystick (HID) mode, e.g. the **TBS Tango 2**. FlyMaps detects it automatically and switches to the drone view (FPV camera tilt, wider FOV, 3:2 view, drone marker on the minimap).

- Acro/rate flight model: stick deflection sets the rotation rate, pitch is unlimited, so full loops and flips work
- Default axis mapping (Tango 2): throttle, roll, pitch, yaw on axes 0 to 3; a switch on axis 4 toggles landmarks (same as `C`)
- The drone presets (sporty, relaxed, cinematic) set the stick rates
- Other controllers may need a different mapping: adjust `CONTROLLER_AXIS` in `src/main.js`

### Keyboard (airplane mode)

Without a controller you fly a plane with limited pitch.

| Key | Action |
| --- | --- |
| `↑` `↓` | Pitch |
| `←` `→` | Roll |
| `W` `S` | Thrust up / down |
| `A` `D` | Yaw |

### Both modes

| Key | Action |
| --- | --- |
| `Space` | Open / close menu |
| `P` | Pause without menu |
| `R` | Fly to a random location |
| `Y` `X` | Previous / next nearby landmark |
| `C` | Toggle landmarks |

## Setup

```bash
npm install
npm run dev
```

second terminal

```bash
npm run pages:dev
```

Open <http://127.0.0.1:5173>.

### Google API key

On first start the app asks for your own Google API key. It is stored only in your browser (`localStorage`) and sent only to Google.

> **Important:** the billing address of your Google Cloud billing account must be **outside the European Economic Area (EEA)**, i.e. not in an EU country, Iceland, Liechtenstein or Norway. Under Google's EEA-specific terms (effective 8 July 2025), the Map Tiles API does not serve Photorealistic 3D Tiles to projects linked to an EEA billing account (requests fail with HTTP 403), so FlyMaps cannot load the world. See [Google's EEA notes for the Map Tiles API](https://developers.google.com/maps/comms/eea/map-tiles).

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/) and enable billing with a non-EEA billing address (a payment method is required; For each API, Google offers a monthly free quota that is more than sufficient.).
2. Enable the **Map Tiles API** and the **Geocoding API**.
3. Create one API key and restrict it to those two APIs. Do not set an HTTP referrer restriction, the Geocoding API does not support it.
4. Recommended: set a daily quota for the Map Tiles API and a budget alert.

### Development shortcuts

- `.env`: `VITE_GOOGLE_MAPS_API_KEY=...` pre-fills the key in `npm run dev`
- `.dev.vars`: `GEOCODING_API_KEY=...` is used by the local Cloudflare Pages function (`functions/api/geocode.js`) when no key has been entered in the app. Run `npm run pages:dev` and open <http://127.0.0.1:8788> to test it. Restart after changing the file.

## Data storage

- **Favorites:** with `npm run dev` / `npm run preview` they are written to `%LOCALAPPDATA%\FlyMaps\favorites.json`, otherwise to `localStorage`.
- **Preferences** (aspect ratio, flight feel, theme, menu layout) are kept in `localStorage`.
- **Camera position and filter settings** are kept per tab in `sessionStorage` and survive reloads.

## Credits

3D data: Google Photorealistic 3D Tiles. Minimap: © OpenStreetMap contributors © CARTO. Landmarks: Wikidata. OSD font: DotGothic16 (OFL).