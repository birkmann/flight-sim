<div align="center">
  <img src="bevy/assets/ui/brand.svg" width="72" height="72" alt="Flight Simulator aircraft and horizon logo" />
  <h1>Flight Simulator</h1>
  <p><strong>Pick a place. Find your aircraft. Take the controls.</strong></p>
  <p>A civilian flight simulator for the browser, built with Rust, Bevy and WebGPU.</p>
  <p>
    <a href="https://flight-sim-eight.vercel.app/"><strong>Play in your browser ↗</strong></a>
    &nbsp; · &nbsp;
    <a href="#screenshots">Screenshots</a>
    &nbsp; · &nbsp;
    <a href="#run-locally">Run locally</a>
    &nbsp; · &nbsp;
    <a href="docs/development.md">Developer guide</a>
  </p>
</div>

[![Sailplane flying over streamed Alpine terrain near the Matterhorn with in-game clouds and lighting](docs/screenshots/flights/alpine-clouds.jpg)](https://flight-sim-eight.vercel.app/)

Fly above Google Photorealistic 3D Tiles in a C172, a sailplane or an A320-class airliner.
Explore a city, plan an airport-to-airport flight, or settle into the cockpit and enjoy the view.

**To play:** use a WebGPU-capable browser with internet access. The public site requires no login.

## The experience

- **A world to explore.** Choose a featured destination, search for a place, or travel with the free camera.
- **Three civilian aircraft.** Light-aircraft sightseeing, unpowered gliding and passenger flights.
- **Cockpits with depth.** Live 2D instruments mounted on 3D dashboards, moving controls, spinning propellers and flashing aircraft lights.
- **Plan your flight.** Pick airports, runways, weather and time of day; begin airborne, on a runway or on final approach.
- **Light and weather.** Volumetric clouds, aircraft shadows, atmospheric visibility, smooth exposure and subtle HDR bloom.
- **Room for the view.** Peripheral chase-view gauges, an on-demand flight menu and an option to hide the overlays.
- **Flight feedback.** Terrain, stall, descent and landing-gear alerts with optional warning sounds.

## Screenshots

| San Francisco in flight | Sydney in evening light |
| :--- | :--- |
| [![C172 flying over San Francisco with volumetric clouds](docs/screenshots/flights/san-francisco-afternoon.jpg)](docs/screenshots/flights/san-francisco-afternoon.jpg) | [![C172 over Sydney with warm evening lighting](docs/screenshots/flights/sydney-golden-hour.jpg)](docs/screenshots/flights/sydney-golden-hour.jpg) |

The Alpine flight above and these city views are **actual in-game captures** with streamed terrain, the shipped aircraft, and
in-game weather and post-processing. Provider attribution remains visible.

**Prepare for departure** — choose your aircraft, route, weather and time of day before launch.

[![Flight briefing menu with aircraft details, route, time of day and weather choices](docs/screenshots/briefing.jpg)](docs/screenshots/briefing.jpg)

The briefing shows the running app; its photographic card artwork is illustrative.
[Image provenance and capture instructions →](docs/screenshots/README.md)

## Choose your aircraft

| Aircraft | Best for | Flight deck |
| :--- | :--- | :--- |
| **C172** | Sightseeing and basic flight practice | Analogue gauges, navigation display, radios and animated yokes |
| **Sailplane** | Unpowered exploration from an airborne start | Variometer, airspeed, altitude and a glide navigator |
| **Airliner** | Airport routes and approach practice | Primary flight and navigation displays, engine instruments and autopilot controls |

## Controls at a glance

| Action | Keyboard / mouse |
| :--- | :--- |
| Pitch and roll | Mouse / arrow keys |
| Throttle | **W / S** |
| Rudder | **A / D** |
| Landing gear / brakes | **G / B** |
| Chase / cockpit view | **V** |
| Look around the cockpit | Right-drag |
| Flight planner / aircraft selection | **P / Tab** |
| Flight menu | **Esc** |
| Hide or restore overlays | **F10** |
| All controls | **H** |

A gamepad is also supported. **Options/Start** opens the flight menu; the D-pad navigates it.
Cockpit instruments keep working with overlays hidden. **Esc** always brings the menu back.

## Run locally

Requires **Node.js 22.12 or newer**. The committed browser build runs without installing npm dependencies.

```sh
git clone https://github.com/birkmann/flight-sim.git
cd flight-sim
cp .env.example .env
```

Set `CESIUM_ION_TOKEN` in `.env` to a Cesium ion token with access to Google Photorealistic
3D Tiles, asset `2275207`. The account credential stays on the server.

```sh
npm start
```

Open **[localhost:5197](http://127.0.0.1:5197/)**. Without the terrain token, menus load but
photorealistic scenery does not. Internet access is needed for terrain, place search and live weather.

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Purpose |
| :--- | :--- |
| `CESIUM_ION_TOKEN` | Server-side terrain credential; `CESIUM_API_KEY` is also accepted |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Optional shared Redis storage for multiplayer; required on serverless hosting |
| `HOST` / `PORT` | Override the local server's listening address and port |

Local multiplayer uses in-memory storage by default. Sessions disappear when the server restarts.

</details>

## Development

The app combines a **Rust / Bevy** simulation, **WebAssembly / WebGPU** rendering,
**React / TypeScript** cockpit instruments and a **Node.js** API for terrain, weather and multiplayer signaling.

```sh
npm ci
npm run dev:api  # Terminal 1: local API
npm run dev      # Terminal 2: source build and dev server; requires Rust + Trunk
```

See the [developer guide](docs/development.md) for Rust/Trunk setup, asset regeneration,
tests, cockpit details and deployment. `npm start` serves the committed build; it does not compile changes.

Production runs on **Vercel**, connected to this repository. Pushes to `main` deploy the
committed browser bundle. Run `npm run build` before publishing Rust or flight-deck changes.

## Current limits

- Multiplayer on the public deployment still needs shared Redis storage configured.
- The sailplane has no tow/winch launch or dedicated thermal lift model.
- Terrain warnings depend on loaded scenery. Flight performance and navigation estimates are approximate.
- Photogrammetry includes baked lighting; terrain cannot reproduce fully dynamic ground shadows, water reflections or changing seasons. Cloud lighting uses a bounded real-time approximation.
- Automated UI and geometry checks complement hands-on testing in a hardware WebGPU browser.

## Credits

Based on `birkmann/eu-ui`, with a standalone civilian aircraft catalogue and flight interface.
The sailplane and its instruments build on the local `dwd-hack-26` project.
Google Photorealistic 3D Tiles are accessed through Cesium ion; provider attribution stays visible in-game.

[Aircraft credits](bevy/assets/models/CREDITS.md) · [Artwork credits](bevy/assets/ui/CREDITS.md) ·
[Flag license](bevy/assets/flags/LICENSE) · [Import manifest](docs/import-manifest.json)
