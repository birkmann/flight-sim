# Menu artwork

The active menu photographs in `aviation/` were generated with the built-in
OpenAI image generation tool for this project. The five assets depict Earth from
orbit, a light aircraft above an alpine lake, an airliner over a coast, a sailplane
over a valley, and dramatic clouds/rain/sun shafts. They are illustrative artwork,
not photographs of a real location, live weather, or screenshots of the game.
Exact generation prompts are preserved in `scripts/ui/artwork-prompts.json`.
The SVG wing-and-horizon brand mark is original code-native artwork for this project.

## Legacy procedural artwork


The aircraft and hangar images are rendered locally by `scripts/render-ui-gallery.mjs`
using this game's aircraft models. Model licenses and origins are recorded in
`../models/CREDITS.md`. The hangar geometry is defined in `scripts/ui/gallery.js`.

The globe and world map use Natural Earth's public-domain country geometry, copied
from the locally cloned `dwd-hack-26/apps/city-weather-simulator/public/maps/`
(`world.geojson` and `europe.geojson`). Their combined geometry, without properties,
is preserved in `scripts/ui/world.json` for reproducible rendering.
The source repository's provenance records the Natural Earth 1:10m country dataset,
simplified and split at the European extract boundary.

These are menu illustrations, not screenshots of streamed terrain. No artwork from
the supplied Microsoft Flight Simulator reference screenshots is included.
