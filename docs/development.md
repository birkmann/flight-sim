# Development and simulator details

[← Back to the README](../README.md)

## Production deployment

Production is hosted by the `flight-sim` Vercel project, connected to
`birkmann/flight-sim` on GitHub. Pushes to `main` deploy the committed `prebuilt/`
bundle and `bevy/assets/` using `npm run build:static`. Rebuild source changes before
pushing; static packaging does not compile Rust or bundle the flight deck.
The production `CESIUM_ION_TOKEN` is a sensitive server-only Vercel variable.
Multiplayer requires `KV_REST_API_URL` and `KV_REST_API_TOKEN`; these are not yet
configured for production. `.vercelignore` excludes local credentials and build caches
from CLI uploads.

## Work on the source

Install Rust, the wasm target, and Trunk once:

```sh
rustup target add wasm32-unknown-unknown
cargo install --locked trunk
```

Run these in separate terminals from this repository:

```sh
npm run dev:api
```

```sh
npm run dev
```

Open http://127.0.0.1:5198/. Trunk rebuilds the Rust app and proxies `/api` to port 5197.
Use the default ports for this development setup. `npm start` serves the committed build;
it does not recompile source changes.

```sh
npm run check:rust
npm run check:airports
npm test
npm run build           # Recompile into prebuilt/ for /
npm run build:static    # Package prebuilt/ plus assets into dist/
```

`Cargo.lock` preserves the original Rust dependency versions. A full release build can take
several minutes. Trunk obtains its wasm-bindgen tooling; wasm-opt is optional.
The static packaging command needs only Node, so the included Vercel configuration can use
the committed build. Configure the Cesium token in the hosting environment. Serverless
multiplayer additionally requires the Redis variables above. No deployment is performed
by these commands. Static-only hosting must supply the `/api` routes separately.

## Files

- `bevy/src/`: flight simulation, cockpit systems, navigation, weather and rendering.
- `bevy/*.js`, `bevy/index.html`: menus, instruments, flight planner and controls.
- `bevy/assets/`: civilian aircraft, thumbnails, flags, shaders and airport data.
- `bevy/tools/`: airport and geoid data regeneration tools.
- `bevy/vendor/`: Draco decoder shim and its provenance.
- `prebuilt/`: the current browser bundle, ready to serve.
- `server/`, `api/`: standalone Node server and serverless API entry point.
- `scenario.json`, `bench.js`, `summarize.mjs`: the rendering benchmark (`?bench`).

## Source and assets

Based on `birkmann/eu-ui`, commit `d3604ec7dac5091415c296dca712888c370b1098`,
with standalone server/build wiring and a civilian aircraft catalogue.
[The import manifest](import-manifest.json) records original source paths and hashes
for the retained imported files; current source files may differ from those originals.
The browser bundle is regenerated from this repository.

Aircraft provenance is in [model credits](../bevy/assets/models/CREDITS.md), and the flags
retain their [license](../bevy/assets/flags/LICENSE). Terrain comes from Cesium ion's Google
Photorealistic 3D Tiles asset. Provider attribution remains visible in the simulator.

## Detailed flight decks and weather

Press **V** or choose **Cockpit** to enter a detailed instrument panel. The C172 has
analogue flight instruments and a GPS navigator; the airliner has primary flight,
navigation and engine displays plus autopilot selectors. The new **Sailplane** uses
the procedural 15 m model and textured SVG cockpit from the local `dwd-hack-26`
project. Live SVG/canvas instruments are uploaded to the modeled dashboard surfaces.
The 3D canopy, cabin, controls and panel surrounds remain visible, and the camera
sits at each model's pilot-eye position. Perspective and occlusion follow head
look naturally; there is no screen-space cockpit panel. Right-drag looks around;
**I** toggles the optional autopilot control strip.

The flight view has no permanent header. Chase-view instruments sit at the corners;
cockpit view uses the instruments inside the aircraft. **Esc** (or the controller's
**Options/Start** button) opens the flight menu for cameras, weather, planning and
settings. The small menu button fades after four seconds; moving the pointer to the
top edge or focusing it reveals it again. The menu supports arrow keys, Tab and D-pad.

Choose **Instruments**, **Minimal**, or **Hide all UI** in the flight menu. **F10**
toggles the overlays; **Esc** always reopens the menu. Double-tapping the view also
restores hidden overlays. The display preference is saved locally. Clean view hides
visual alerts as well, but leaves cockpit instruments and the selected warning audio
working. Scenery-provider credits remain visible.

**Flight details** shows the active route, next waypoint, runway, distance, estimated
time, fuel and endurance when available. **Weather** shows simulated conditions and
a separate airport METAR with its observation time. Missing observations are labelled;
the widgets do not invent a forecast. The flight planner's Live METAR option applies
an observation to the simulation.

The sailplane has no engine or fuel consumption. Select an **airborne release** or
**final approach** in the planner, or select it in the local aircraft menu. It is a
manual gliding model: there is no tow/winch launch or dedicated thermal lift model.
Choose a nearby destination within gliding range. Performance and arrival estimates
are approximate, not a certified aircraft model.

To edit the React/SVG flight decks, install the development dependencies with `npm ci`
and run `npm run build:deck`; the full `npm run build` also bundles them. Generated
`bevy/deck.js` and `bevy/deck.css` are included for dependency-free serving. To regenerate
the model, run `npx playwright install chromium` once, then `npm run model:glider`.
`CHROMIUM_PATH` can specify an existing Chromium executable. Source and asset credits
are recorded in [model credits](../bevy/assets/models/CREDITS.md).

`npm run model:exteriors` applies the white-and-navy aircraft finish after importing
or regenerating the C172 and airliner. It resamples the airliner's fuselage stations,
smooths exterior normals while retaining creases, adds its swept fuselage stripe and
recessed engine fans, and preserves cockpit and control nodes. The sailplane generator
includes tapered outer wings, narrow curved winglets, a slimmer T-tail and blue accents.

The C172 asset includes a continuous cabin floor, closed footwells and firewall,
finished door inserts, sills, armrests and heel mats, plus the corrected cabin liner,
pilot-eye position and interior surface grain. The visible cabin has smoothly swept
window posts and seals, a padded dashboard lip, warm vinyl trim, and continuous cast
yokes with rounded grips. The oversized overhead compass housing is removed; heading
remains available on the live panel instrument. `npm run model:c172` reapplies these refinements after importing the
original C172 model; it leaves an already refined asset unchanged. `npm test` checks
that the cabin does not obscure the live instrument surface and that the surface
fits both portrait and landscape views at the default 50° field of view. Geometry
ray tests also check that scenery cannot show through the floor, firewall or lower doors.
Right-drag or the gamepad's right stick looks around the cockpit without moving
the flight controls; middle-click recentres the view, as does changing camera mode.

The C172 yokes and rudder pedals follow the flight controls. Their dashboard
bearings remain fixed, with sliding shafts extending behind the panel so they stay
connected throughout full pitch and roll travel. Its propeller transitions
to a translucent blur at running speed; wingtip strobes and the red tail beacon flash.
The radio stack shows live navigation, guidance and engine readings on the 3D panel.
The right-hand engine gauges display RPM, commanded power, and fuel mass; fuel is
shown as unavailable in local flights that do not simulate fuel. Analogue faces
receive cabin lighting with a small backlight contribution, while electronic
screens remain self-lit.
`npm run model:c172` also installs this animation rig and the radio display surface.

In flight, amber terrain cautions escalate to a red **PULL UP** alert and repeating
warning tones. Forward probes check the current flight path against loaded terrain
and scenery, with an approximate time to impact. Stall, excessive descent and landing
gear alerts also work in local flights. **Warning sounds** in the flight menu mutes
audio while keeping visual alerts (unless all overlays are hidden). Terrain that has not streamed in cannot be detected.

Validation: `npm run check:deck` type-checks the flight decks; `npm run test:deck`
checks live instrument pixel updates, absence of floating cockpit overlays,
mobile briefing, weather controls, flight planning and
autopilot commands in Chromium using deterministic telemetry and METAR fixtures.
It also checks terrain/stall alert transitions, warning tones, muting, radio updates,
menu focus, clean-view recovery and live cockpit textures with overlays hidden.
These UI checks do not substitute for a hardware WebGPU flight test.

The welcome dashboard, setup, loading state, planner and flight overlays share
`bevy/flight-ui.css`. The dashboard links to the world map, free flight, aircraft
selection, sailplane briefing and weather conditions. Destinations can be selected
on the map or in a responsive grid; searching places works in either view. A compact
departure summary and action bar stay visible while the content scrolls.

Menu artwork uses five locally shipped, photorealistic aviation illustrations in
`bevy/assets/ui/aviation/`: a textured Earth, aircraft in flight, and atmospheric
weather. The welcome background drifts slowly and the weather card has subtle light
movement; reduced-motion preferences disable both. The SVG brand mark and favicon
are in `bevy/assets/ui/brand.svg`. Images are illustrative, not gameplay screenshots
or live weather. See [artwork credits](../bevy/assets/ui/CREDITS.md) and the
[image generation prompts](../scripts/ui/artwork-prompts.json).

`npm run render:ui` still regenerates the legacy procedural gallery in `assets/ui/`
for model previews; it does not overwrite the active `aviation/` artwork.

`npm run model:finish` applies the civilian cabin finish: finer normal-map grain,
a clear airliner windshield without the unused head-up combiner assembly, and retained
physical display surfaces. The C172's VSI now distinguishes signed climb/descent and
its panel includes live warning, autopilot and gear lamps.

## Flight graphics

The existing terrain streaming defaults, 512 MB budget and adaptive coarsening
are retained. Ultra detail is available in Options; the capture script uses per-view
detail settings so terrain can finish streaming before capture.

The weather camera enables HDR, filmic tonemapping, dithering, restrained
energy-conserving bloom, richer saturation and a restrained midtone contrast
adjustment. Sun colour, intensity and smoothly adapting exposure follow solar elevation and cloud cover.
Cascaded sun shadows add depth to the aircraft; the photogrammetry remains unlit
because its photographs already contain illumination and shadows.

`clouds.wgsl` integrates a procedural 3D density field in 64 bounded steps with
footprint-filtered detail and three sunward density samples for self-shadowing. An opaque depth prepass clips
cloud integration against aircraft and terrain, including when the camera is
inside the layer. Seeded, overlapping cloud lobes create coherent gaps in broken
cloud, with gradient-noise erosion filtered to each ray step. Wind moves the field;
floating-origin offsets keep it stable.
The volume has a finite range and no temporal reconstruction or terrain cloud
shadow map. This is an affordable approximation, not a meteorological model.

Visibility now uses its actual distance continuously, including at 40 km. Clear
and few-cloud presets allow longer visibility; rain uses 12 km. Input patches
are bounded before reaching the renderer. Rain streaks use a maximum 1/120 s
shutter and lower opacity; lens highlights read the current daylight value.

Validation commands:

```sh
npm run check:rust
cargo test --manifest-path bevy/Cargo.toml --locked --features bevy/x11 weather::tests
npm test
HEADLESS=0 CHECK_WEATHER=1 npm run capture:flights
```

The X11 feature is needed only for native Linux tests, not the browser build.
See [capture provenance](screenshots/README.md#in-game-flights) for browser options.
