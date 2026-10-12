`shims.js` is copied unchanged from bevy_3d_tiles 0.4.4 (`wasm/shims.js`, commit 474ef4a, MIT OR Apache-2.0,
https://github.com/Arvikasoft/bevy_3d_tiles). It defines `window.__tt_draco_decode`, which lazy-loads Google's Draco
decoder from gstatic, and `window.__tt_ktx2_transcode`. The latter's `libktx_read.*` files are not vendored, because
Google's tiles don't use KTX2 textures.

`../assets/flags/` holds the country flags (4:3, one `<iso-3166-1 alpha-2>.svg` per country) from flag-icons 7.5.0
(`flags/4x3/`, MIT, https://github.com/lipis/flag-icons); the subdivision flags (`gb-eng`, `es-ct`, …) are left out.
The place card (`place.js`) shows the one for the country under the camera.
