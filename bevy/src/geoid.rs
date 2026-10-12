//! Height of the geoid (mean sea level) above the WGS84 ellipsoid, anywhere on Earth. The photorealistic tiles, and
//! so every world position, are on the ellipsoid, while altitudes shown to the pilot and airport elevations are above
//! sea level; the two differ by up to about 100 m (−107 m south of India, +85 m over New Guinea, +40 m in Germany).
//!
//! The values are EGM96, sampled every 1° from GeographicLib's 5′ grid into signed whole metres (`geoid_egm96.bin`,
//! 65 KB, made by `tools/geoid.mjs`) and interpolated bilinearly. Against the full grid that is within 0.5 m RMS and
//! within 4 m over all but 0.1% of the globe; the worst spots, up to 14 m, are the steep bumps over ocean trenches and
//! around Hawaii, not where anyone lands.

/// Grid spacing (degrees).
const STEP: f64 = 1.0;
/// Nodes from 90° N to 90° S.
const ROWS: usize = 181;
/// Nodes from 0° E eastwards, wrapping at 360°.
const COLS: usize = 360;
/// Row-major, north first: row `r` is latitude `90 − r·STEP`, column `c` is longitude `c·STEP`.
static GRID: &[u8; ROWS * COLS] = include_bytes!("geoid_egm96.bin");

fn node(r: usize, c: usize) -> f64 {
    GRID[r * COLS + c] as i8 as f64
}

/// Geoid undulation (m) at a latitude and longitude (degrees): mean sea level height = ellipsoidal height − this.
/// Longitude wraps; latitude is clamped to ±90°.
pub fn geoid(lat_deg: f64, lon_deg: f64) -> f64 {
    let r = ((90.0 - lat_deg) / STEP).clamp(0.0, (ROWS - 1) as f64);
    let c = (lon_deg.rem_euclid(360.0) / STEP) % COLS as f64;
    let r0 = (r.floor() as usize).min(ROWS - 2);
    let c0 = (c.floor() as usize).min(COLS - 1);
    let c1 = (c0 + 1) % COLS;
    let (fr, fc) = (r - r0 as f64, c - c0 as f64);
    let north = node(r0, c0) * (1.0 - fc) + node(r0, c1) * fc;
    let south = node(r0 + 1, c0) * (1.0 - fc) + node(r0 + 1, c1) * fc;
    north * (1.0 - fr) + south * fr
}

#[cfg(test)]
mod tests {
    use super::geoid;

    /// EGM96 from the full 5′ grid (bilinear), as printed by `tools/geoid.mjs`.
    const TRUTH: [(&str, f64, f64, f64); 10] = [
        ("Berlin", 52.5, 13.4, 39.58),
        ("Hamburg", 53.63, 9.99, 39.75),
        ("London Heathrow", 51.47, -0.45, 46.29),
        ("New York JFK", 40.64, -73.78, -32.58),
        ("San Francisco", 37.62, -122.38, -32.23),
        ("Tokyo Haneda", 35.55, 139.78, 35.72),
        ("Sydney", -33.95, 151.18, 22.18),
        ("Denver", 39.86, -104.67, -18.42),
        ("south of India", 5.0, 78.0, -104.68),
        ("New Guinea", -5.0, 145.0, 70.40),
    ];

    #[test]
    fn matches_full_resolution() {
        for (place, lat, lon, truth) in TRUTH {
            let g = geoid(lat, lon);
            assert!((g - truth).abs() < 4.0, "{place}: {g:.2} m, EGM96 {truth:.2} m");
        }
    }

    #[test]
    fn wraps_and_clamps() {
        assert_eq!(geoid(10.0, -180.0), geoid(10.0, 180.0));
        assert_eq!(geoid(10.0, -0.25), geoid(10.0, 359.75));
        assert_eq!(geoid(10.0, 725.0), geoid(10.0, 5.0));
        assert_eq!(geoid(95.0, 20.0), geoid(90.0, 20.0));
        assert_eq!(geoid(-95.0, 20.0), geoid(-90.0, 20.0));
        // The poles are single points: every longitude agrees.
        assert!((geoid(90.0, 0.0) - geoid(90.0, 123.0)).abs() < 1.0);
        assert!((geoid(-90.0, 0.0) - geoid(-90.0, 123.0)).abs() < 1.0);
        // Tiny negative longitudes wrap to exactly 360°, which must not index past the last column.
        assert_eq!(geoid(10.0, -1e-20), geoid(10.0, 0.0));
        assert!(geoid(f64::NAN, 0.0).is_nan());
    }
}
