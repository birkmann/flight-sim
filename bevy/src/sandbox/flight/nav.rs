//! Navigation over the globe: great-circle geometry, the flight plan's legs (lateral and vertical guidance, as a
//! flight management system flies them) and the instrument landing system of the destination runway.
//!
//! Positions are latitude and longitude (degrees) on a sphere of the mean Earth radius; courses are true, in radians
//! clockwise from north. The ILS is synthetic: every runway has one, on its centreline, with a 3° glide path.

use bevy::math::DVec3;
use serde_json::{Value, json};

use super::airport::Runway;

pub const EARTH_RADIUS: f64 = 6_371_000.0;
pub const NM: f64 = 1_852.0;
/// Glide path angle (rad) and its height gain per nautical mile (ft).
pub const GLIDE: f64 = 0.052_36;
pub const FT_PER_NM: f64 = 318.4;

pub type LatLon = (f64, f64);

pub fn normal(p: LatLon) -> DVec3 {
    let (lat, lon) = (p.0.to_radians(), p.1.to_radians());
    DVec3::new(lat.cos() * lon.cos(), lat.cos() * lon.sin(), lat.sin())
}

/// Great-circle distance (m).
pub fn distance(a: LatLon, b: LatLon) -> f64 {
    normal(a).angle_between(normal(b)) * EARTH_RADIUS
}

/// Initial course from one point to another (rad, 0..2π).
pub fn bearing(a: LatLon, b: LatLon) -> f64 {
    let (p1, p2) = (a.0.to_radians(), b.0.to_radians());
    let dl = (b.1 - a.1).to_radians();
    (dl.sin() * p2.cos()).atan2(p1.cos() * p2.sin() - p1.sin() * p2.cos() * dl.cos()).rem_euclid(std::f64::consts::TAU)
}

/// The point `d` metres from `a` along a course.
pub fn destination(a: LatLon, course: f64, d: f64) -> LatLon {
    let d = d / EARTH_RADIUS;
    let p1 = a.0.to_radians();
    let p2 = (p1.sin() * d.cos() + p1.cos() * d.sin() * course.cos()).asin();
    let l2 = a.1.to_radians() + (course.sin() * d.sin() * p1.cos()).atan2(d.cos() - p1.sin() * p2.sin());
    (p2.to_degrees(), (l2.to_degrees() + 540.0).rem_euclid(360.0) - 180.0)
}

/// Where `p` is against the great circle from `a` to `b`: metres right of it (negative left) and along it from `a`.
pub fn cross_track(a: LatLon, b: LatLon, p: LatLon) -> (f64, f64) {
    let (na, nb, np) = (normal(a), normal(b), normal(p));
    let n = na.cross(nb).normalize_or_zero();
    if n == DVec3::ZERO {
        return (0.0, distance(a, p));
    }
    let xtk = -np.dot(n).clamp(-1.0, 1.0).asin() * EARTH_RADIUS;
    let along = np.dot(n.cross(na)).atan2(np.dot(na)) * EARTH_RADIUS;
    (xtk, along)
}

/// Difference of two angles, wrapped to −π..π.
pub fn wrap(a: f64) -> f64 {
    (a + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// The departure runway (the route's start) and the destination runway's threshold (its end).
    Departure,
    Fix,
    Navaid,
    /// Approach: the initial and the final approach fix.
    Iaf,
    Faf,
    Arrival,
}

#[derive(Clone, Debug)]
pub struct Waypoint {
    pub id: String,
    pub pos: LatLon,
    /// An altitude constraint (ft): at or above on the way up, at or below on the way down.
    pub alt: Option<f64>,
    pub kind: Kind,
}

impl Waypoint {
    pub fn from_json(v: &Value) -> Option<Waypoint> {
        let kind = match v.get("kind").and_then(Value::as_str).unwrap_or("fix") {
            "dep" => Kind::Departure,
            "navaid" => Kind::Navaid,
            "iaf" => Kind::Iaf,
            "faf" => Kind::Faf,
            "arr" => Kind::Arrival,
            _ => Kind::Fix,
        };
        Some(Waypoint { id: v.get("id")?.as_str()?.to_owned(), pos: (v.get("lat")?.as_f64()?, v.get("lon")?.as_f64()?), alt: v.get("alt").and_then(Value::as_f64), kind })
    }
}

/// The flight plan being flown: waypoints, the leg to the active one, the cruise level, and the descent's shape.
pub struct Route {
    pub wpts: Vec<Waypoint>,
    pub active: usize,
    pub cruise_ft: f64,
    /// The height above the destination (ft) the descent levels at to meet the glide slope from below, and how far
    /// out (NM) it gets there: time to slow down and configure before the approach.
    pub intercept_ft: f64,
    pub level_nm: f64,
}

impl Default for Route {
    fn default() -> Self {
        Route { wpts: Vec::new(), active: 1, cruise_ft: 0.0, intercept_ft: 3_000.0, level_nm: 17.0 }
    }
}

/// Lateral guidance along the active leg.
#[derive(Clone, Copy, Default)]
pub struct Lnav {
    /// Desired track (rad), metres right of the leg, and the track to fly to get back onto it.
    pub dtk: f64,
    pub xtk: f64,
    pub track_cmd: f64,
    /// To the active waypoint: distance (m) and course (rad); along the rest of the route to the runway (m).
    pub to_wp: f64,
    pub brg_wp: f64,
    pub dtg: f64,
}

impl Route {
    pub fn active_wp(&self) -> Option<&Waypoint> {
        self.wpts.get(self.active)
    }

    /// Guidance from `p` at ground speed `gs` (m/s); moves on to the next leg in time to turn onto it (a 25° bank).
    pub fn lnav(&mut self, p: LatLon, gs: f64) -> Option<Lnav> {
        if self.wpts.len() < 2 {
            return None;
        }
        self.active = self.active.clamp(1, self.wpts.len() - 1);
        loop {
            let (a, b) = (self.wpts[self.active - 1].pos, self.wpts[self.active].pos);
            let (_, along) = cross_track(a, b, p);
            let to_go = distance(a, b) - along;
            let Some(next) = self.wpts.get(self.active + 1) else { break };
            let turn = wrap(bearing(b, next.pos) - bearing(a, b)).abs();
            let radius = gs * gs / (9.81 * 25f64.to_radians().tan());
            let lead = (radius * (turn / 2.0).tan()).clamp(150.0, 25_000.0);
            if to_go < lead || distance(p, b) < 150.0 {
                self.active += 1;
            } else {
                break;
            }
        }
        let (a, b) = (self.wpts[self.active - 1].pos, self.wpts[self.active].pos);
        let (xtk, along) = cross_track(a, b, p);
        let on_leg = destination(a, bearing(a, b), along.max(0.0));
        let dtk = bearing(on_leg, b);
        let intercept = (-xtk / (gs.max(40.0) * 25.0)).atan().clamp(-0.8, 0.8);
        let to_wp = distance(p, b);
        let rest: f64 = self.wpts[self.active..].windows(2).map(|w| distance(w[0].pos, w[1].pos)).sum();
        Some(Lnav { dtk, xtk, track_cmd: (dtk + intercept).rem_euclid(std::f64::consts::TAU), to_wp, brg_wp: bearing(p, b), dtg: to_wp + rest })
    }

    /// The descent path's altitude (ft) at a distance to go (m) to a runway at `elev` (ft): 3° down from cruise to the
    /// intercept altitude, reached `level_nm` out, then level to meet the glide slope from below. The top of descent is
    /// where it leaves the cruise level.
    pub fn path_ft(&self, dtg: f64, elev: f64) -> f64 {
        (elev + self.intercept_ft + (dtg / NM - self.level_nm).max(0.0) * FT_PER_NM).min(self.cruise_ft)
    }

    /// The path's descent gradient there (ft per NM; 0 where it is level).
    pub fn path_slope(&self, dtg: f64, elev: f64) -> f64 {
        if dtg / NM > self.level_nm && self.path_ft(dtg, elev) < self.cruise_ft { FT_PER_NM } else { 0.0 }
    }

    /// Distance to go (m) at the top of descent.
    pub fn tod_dtg(&self, elev: f64) -> f64 {
        (((self.cruise_ft - elev - self.intercept_ft) / FT_PER_NM).max(0.0) + self.level_nm) * NM
    }

    /// The point on the route `dtg` metres before the runway (for the map's TOD marker).
    pub fn point_at_dtg(&self, dtg: f64) -> Option<LatLon> {
        let mut left = dtg;
        for w in self.wpts.windows(2).rev() {
            let d = distance(w[0].pos, w[1].pos);
            if left <= d {
                return Some(destination(w[1].pos, bearing(w[1].pos, w[0].pos), left));
            }
            left -= d;
        }
        None
    }

    /// After a go-around: from here back round to the runway's final — downwind abeam the threshold, a base leg 14 NM
    /// out, the intermediate fix 10 NM out on the centreline (below the glide slope), then the plan's final approach
    /// fix and threshold.
    pub fn go_around(&mut self, rwy: &Runway, here: LatLon) {
        use std::f64::consts::{FRAC_PI_2, PI};
        let thr = rwy.threshold();
        let crs = rwy.course();
        let left = crs - FRAC_PI_2;
        let fix = |id: &str, pos: LatLon, kind: Kind| Waypoint { id: id.into(), pos, alt: None, kind };
        let tail: Vec<Waypoint> = self.wpts.iter().filter(|w| matches!(w.kind, Kind::Faf | Kind::Arrival)).cloned().collect();
        let mut wpts = vec![
            fix("T-P", here, Kind::Fix),
            fix("DW", destination(thr, left, 6.0 * NM), Kind::Fix),
            fix("BS", destination(destination(thr, crs + PI, 14.0 * NM), left, 5.0 * NM), Kind::Iaf),
            fix("IF", destination(thr, crs + PI, 10.0 * NM), Kind::Iaf),
        ];
        wpts.extend(tail);
        self.wpts = wpts;
        self.active = 1;
    }

    pub fn to_json(&self) -> Value {
        let wpts: Vec<Value> = self
            .wpts
            .iter()
            .map(|w| json!({ "id": w.id, "lat": w.pos.0, "lon": w.pos.1, "alt": w.alt, "kind": format!("{:?}", w.kind).to_lowercase() }))
            .collect();
        json!({ "wpts": wpts, "active": self.active })
    }
}

/// Where the aircraft is against a runway's ILS: localizer and glide slope deviations in dots (positive: the needle is
/// right of or above the centre, fly toward it), the course, and the distance to the threshold.
#[derive(Clone, Copy, Default)]
pub struct Ils {
    pub loc: f64,
    pub gs: f64,
    /// Received: in front of the localizer within 35° and 25 NM, and for the glide slope within 8° either side.
    pub loc_valid: bool,
    pub gs_valid: bool,
    pub course: f64,
    /// Metres right of the centreline, and to the threshold along it.
    pub xtk: f64,
    pub dist: f64,
}

/// Localizer: 0.8° a dot; glide slope: 0.35° a dot (two dots is full scale).
pub const LOC_DOT: f64 = 0.8;
pub const GS_DOT: f64 = 0.35;

pub fn ils(rwy: &Runway, p: LatLon, alt_msl_m: f64) -> Ils {
    let course = rwy.course();
    let thr = rwy.threshold();
    let far = destination(thr, course + std::f64::consts::PI, 30.0 * NM);
    let (xtk, along) = cross_track(far, thr, p);
    // Along the centreline to the threshold, and from the antennas: the localizer past the far end, the glide slope
    // abeam the touchdown zone.
    let dist = 30.0 * NM - along;
    let to_loc = dist + rwy.length() + 300.0;
    let to_gs = (dist + 300.0).max(1.0);
    let loc_deg = (xtk / to_loc).atan().to_degrees();
    let height = alt_msl_m - rwy.a.elev_m();
    let gs_deg = (height / to_gs).atan().to_degrees() - GLIDE.to_degrees();
    let bearing_off = wrap(bearing(p, thr) - course).abs();
    let loc_valid = dist > -rwy.length() && dist < 25.0 * NM && (bearing_off < 35f64.to_radians() || dist < 500.0);
    Ils {
        loc: (-loc_deg / LOC_DOT).clamp(-2.5, 2.5),
        gs: (gs_deg / GS_DOT).clamp(-2.5, 2.5) * -1.0,
        loc_valid,
        gs_valid: loc_valid && dist > 0.0 && gs_deg.abs() < 8.0,
        course,
        xtk,
        dist,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cross_track_sign_and_along() {
        // Eastbound along the equator: a point north of it is left.
        let (a, b) = ((0.0, 0.0), (0.0, 1.0));
        let (xtk, along) = cross_track(a, b, (0.01, 0.5));
        assert!((xtk + 1_112.0).abs() < 5.0, "{xtk}");
        assert!((along - 55_597.0).abs() < 50.0, "{along}");
        let (xtk, _) = cross_track(a, b, (-0.01, 0.5));
        assert!(xtk > 1_100.0);
    }

    #[test]
    fn sequences_legs_and_tracks_back() {
        let mut r = Route {
            wpts: vec![
                Waypoint { id: "A".into(), pos: (50.0, 8.0), alt: None, kind: Kind::Departure },
                Waypoint { id: "B".into(), pos: (50.0, 9.0), alt: None, kind: Kind::Fix },
                Waypoint { id: "C".into(), pos: (51.0, 9.0), alt: None, kind: Kind::Arrival },
            ],
            cruise_ft: 30_000.0,
            ..Route::default()
        };
        // Right of the first leg: steer left of its track to get back.
        let g = r.lnav((49.99, 8.5), 200.0).unwrap();
        assert!(g.xtk > 1_000.0 && wrap(g.track_cmd - g.dtk) < 0.0);
        assert_eq!(r.active, 1);
        // Just short of B, within the turn's lead: on to the leg north.
        r.lnav((50.0, 8.99), 200.0).unwrap();
        assert_eq!(r.active, 2);
        // 3° from FL300 to 3,000 ft, reached 17 NM out.
        let tod = r.tod_dtg(0.0) / NM;
        assert!((tod - 101.8).abs() < 0.5, "{tod}");
        assert!((r.path_ft(10.0 * NM, 100.0) - 3_100.0).abs() < 1.0);
        assert!((r.path_ft(30.0 * NM, 100.0) - 7_239.0).abs() < 1.0);
        assert_eq!(r.path_slope(10.0 * NM, 100.0), 0.0);
    }

    #[test]
    fn destination_and_bearing_agree() {
        let a = (52.36, 13.5);
        let b = destination(a, 1.0, 50_000.0);
        assert!((distance(a, b) - 50_000.0).abs() < 1.0);
        assert!((bearing(a, b) - 1.0).abs() < 1e-3);
    }
}
