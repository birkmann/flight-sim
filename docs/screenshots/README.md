# README images

These files are stored in the repository so the README does not depend on temporary screenshot URLs.
The main README features eight in-game captures and one menu image, `briefing.jpg`.
The other menu captures and cockpit preview are retained here as development references.

| File | Source |
| --- | --- |
| `welcome.jpg` | Browser capture of the public welcome screen |
| `flight-modes.jpg` | Browser capture of the flight-mode selection screen |
| `aircraft.jpg` | Browser capture of the aircraft selection screen |
| `briefing.jpg` | Browser capture of the preflight briefing |
| `c172-cockpit-preview.png` | Development render of the shipped C172 GLB with the app's live instrument textures, sample telemetry and a simple preview background; not a live-terrain gameplay capture |

Captured on 12 October 2026. Menu captures use a 1920 × 1080 viewport with reduced motion.
The cockpit preview uses a 1440 × 1000 viewport. The screenshots are not generated artwork.
Photographic images *inside the menus* are illustrative assets; see the
[artwork credits](../../bevy/assets/ui/CREDITS.md).

To refresh the menu screenshots, start the local app and run:

```sh
npm ci
npx playwright install chromium
node scripts/capture-readme.mjs
```

Pass a URL to capture another deployment:

```sh
node scripts/capture-readme.mjs https://flight-sim-eight.vercel.app/
```

Set `CHROMIUM_PATH` to use an existing Chromium executable. The capture script updates only
menu images; the cockpit preview is recorded separately using the actual model and instrument renderer.

## In-game flights

The `flights/` images are 1920 × 1080 browser captures made on 13 October 2026
using the NVIDIA hardware WebGPU renderer. No scenery, aircraft, sky or lighting
is composited or generated outside the game. The accompanying `manifest.json`
records the simulated conditions, aircraft position and loaded terrain statistics.
These are selected simulated weather conditions, not live observations.

```sh
npm start
# In another terminal, using an installed Playwright Chromium:
npm run capture:flights
```

Set `CHROMIUM_PATH` for another Chromium executable. On Linux, `HEADLESS=0` runs
a visible browser with ANGLE OpenGL, which can expose a hardware WebGPU adapter
when headless Chromium selects SwiftShader. Set `SHOT` to one name or a comma-separated list:
`san-francisco-afternoon`, `sydney-golden-hour`, `alpine-clouds`, `berlin-tiergarten`,
`berlin-c172-cockpit`, `berlin-airliner`, `berlin-airliner-cockpit`, or `berlin-brandenburg-runway`.
The Berlin cockpit views use the game's live aircraft instruments and streamed scenery.
They use 55° (C172) and 60° (airliner) vertical fields of view for readable instruments.
The runway view starts a flight at EDDB using the bundled airport data and checks that the aircraft is on the ground.
`CHECK_WEATHER=1` also exercises every preset, night, and camera positions below,
inside and above a cloud bank; diagnostic images go to `/tmp/weather-*.png`.
The script fails on rendering errors or missing terrain instead of saving a
blank view as a gameplay screenshot. Press **F10** to hide overlays for manual
captures; click the view, then right-drag to orbit and scroll to frame the aircraft.
`CHECK_COCKPIT=1` checks seated head look, control isolation and recentering, and
saves wide, footwell and side-view inspection images under `/tmp/cockpit-*.jpg`.
