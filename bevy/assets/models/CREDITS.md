# Civilian aircraft assets

`c172.glb` and `airliner.glb`, with their thumbnails, were imported from
`birkmann/eu-ui` at commit `d3604ec7dac5091415c296dca712888c370b1098`.
These are procedural aircraft models exported by the original project with
THREE.GLTFExporter. The airliner's original logo decals and their embedded texture have been removed.
Both models have local exterior materials and white-and-navy liveries. The airliner
has a resampled smooth fuselage, crease-aware exterior normals and recessed engine fans.
Both models have local cabin refinements; the C172 also has an animated control rig,
a closed floor and footwell enclosure, and locally generated door trim and fittings.
The airliner's unused head-up combiner and support assembly are removed using an
exact vertex mask derived from the original `airlinerCockpit.ts` generator.
No new license is asserted here.

The country flags have their own license in `../flags/LICENSE`.

The 15 m sailplane (`glider.glb`) and its procedural generator in `bevy/tools/glider/`
come from `birkmann/dwd-hack-26`, commit
`e95943e4482875d9bc3f61d315f09c69e11a850d`, under
`apps/city-weather-simulator/src/flight/glider/`. The exporter converts the source
coordinate frame for Bevy and retains the control-surface hinge geometry. The
registration is D-1501. Local changes refine the wing taper, winglets, T-tail and paint. No new license is asserted for this imported work.

The SVG sailplane panel and instrument components in `bevy/deck/cockpit/` come from
the same repository's `src/flight/cockpit/` directory. The original demo route,
weather, airspace and thermal fixtures are replaced with adapters for this simulator.
The C172 and airliner panel compositions are specific to this repository.
