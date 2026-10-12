# README images

These files are stored in the repository so the README does not depend on temporary screenshot URLs.

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
