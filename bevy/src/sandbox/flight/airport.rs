//! Runways: where their thresholds are, the flat surface an aircraft rolls on, and their lights.
//!
//! The photorealistic mesh has an airport's runway in it, but as photogrammetry: bumps of a metre or two, parked
//! aircraft, and nothing a wheel can roll on straight. Within a runway's rectangle the aircraft rolls on a plane
//! between its two thresholds instead, at their published elevations. Those are above sea level, and the mesh is on
//! the ellipsoid, so the geoid (`geoid.rs`) puts them in place to a few metres; rays down onto the mesh along the
//! centreline measure what is left (`offset`), and the plane then lies on the visible tarmac.

use bevy::math::DVec3;
use bevy::prelude::*;
use bevy_3d_tiles::geodesy;
use serde_json::Value;

use super::nav::{self, LatLon, NM};
use super::types::FT;
use crate::geoid::geoid;
use crate::origin::Frame;

/// One end of a runway, as the planner sends it (from OurAirports).
#[derive(Clone, Debug)]
pub struct End {
    pub ident: String,
    pub pos: LatLon,
    pub elev_ft: f64,
    /// Displaced threshold (m): the landing starts this far in.
    pub displaced: f64,
}

impl End {
    pub fn elev_m(&self) -> f64 {
        self.elev_ft / f64::from(FT)
    }
}

/// A runway used in one direction: from end `a` toward end `b`.
#[derive(Clone, Debug)]
pub struct Runway {
    pub icao: String,
    pub name: String,
    pub a: End,
    pub b: End,
    pub width: f64,
    /// Mesh height over the published one (m), once measured.
    pub offset: f64,
    pub measured: bool,
    samples: Vec<f64>,
}

impl Runway {
    /// `{icao, name, width_ft, a: {ident, lat, lon, elev_ft, disp_ft}, b: {…}}`.
    pub fn from_json(v: &Value) -> Option<Runway> {
        let end = |e: &Value| -> Option<End> {
            Some(End {
                ident: e.get("ident")?.as_str()?.to_owned(),
                pos: (e.get("lat")?.as_f64()?, e.get("lon")?.as_f64()?),
                elev_ft: e.get("elev_ft").and_then(Value::as_f64).unwrap_or(0.0),
                displaced: e.get("disp_ft").and_then(Value::as_f64).unwrap_or(0.0) / f64::from(FT),
            })
        };
        Some(Runway {
            icao: v.get("icao")?.as_str()?.to_owned(),
            name: v.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
            a: end(v.get("a")?)?,
            b: end(v.get("b")?)?,
            width: v.get("width_ft").and_then(Value::as_f64).unwrap_or(150.0) / f64::from(FT),
            offset: 0.0,
            measured: false,
            samples: Vec::new(),
        })
    }

    /// True course from `a` to `b` (rad).
    pub fn course(&self) -> f64 {
        nav::bearing(self.a.pos, self.b.pos)
    }
    pub fn length(&self) -> f64 {
        nav::distance(self.a.pos, self.b.pos)
    }
    /// Where the landing starts (past a displaced threshold).
    pub fn threshold(&self) -> LatLon {
        nav::destination(self.a.pos, self.course(), self.a.displaced)
    }
    /// The point `d` metres along the centreline from end `a` (negative: before it).
    pub fn along(&self, d: f64) -> LatLon {
        if d >= 0.0 { nav::destination(self.a.pos, self.course(), d) } else { nav::destination(self.a.pos, self.course() + std::f64::consts::PI, -d) }
    }
    /// Published elevation (m above sea level) at a fraction along the runway, and the mesh's.
    fn elev_at(&self, t: f64) -> f64 {
        let t = t.clamp(0.0, 1.0);
        self.a.elev_m() + (self.b.elev_m() - self.a.elev_m()) * t
    }
    pub fn surface_elev(&self, t: f64) -> f64 {
        self.elev_at(t) + self.offset
    }

    /// The runway surface under a world point: its height (world y), when the point is over the runway (or within
    /// its overruns and shoulders).
    pub fn ground_at(&self, frame: &Frame, p: Vec3) -> Option<f32> {
        let (lat, lon, _) = frame.geodetic(p);
        let (xtk, along) = nav::cross_track(self.a.pos, self.b.pos, (lat, lon));
        let len = self.length();
        if xtk.abs() > self.width / 2.0 + 25.0 || along < -90.0 || along > len + 90.0 {
            return None;
        }
        let h = self.surface_elev(along / len);
        Some(frame.from_ecef(ecef((lat, lon), h)).y)
    }

    /// The runway surface's point `d` metres along the centreline (world).
    pub fn world_at(&self, frame: &Frame, d: f64, side: f64) -> Vec3 {
        let c = self.along(d);
        let p = if side.abs() > 0.01 { nav::destination(c, self.course() + std::f64::consts::FRAC_PI_2, side) } else { c };
        frame.from_ecef(ecef(p, self.surface_elev(d / self.length())))
    }

    /// Adds a ray's measurement of the mesh at `d` metres along; settles once enough agree.
    pub fn sample(&mut self, d: f64, mesh_elev: f64) {
        let expected = self.elev_at(d / self.length());
        let off = mesh_elev - expected;
        if off.abs() > 60.0 {
            return;
        }
        self.samples.push(off);
        if self.samples.len() > 40 {
            self.samples.remove(0);
        }
        // The median: a parked aircraft or a bridge on the line does not move it. A new measurement takes over from
        // the last once it has a few samples of its own.
        let mut s = self.samples.clone();
        s.sort_by(f64::total_cmp);
        if !self.measured || s.len() >= 5 {
            self.offset = s[s.len() / 2];
        }
        self.measured = self.measured || self.samples.len() >= 5;
    }
    /// Measures afresh (closer, where the tiles are finer), keeping the last offset until then.
    pub fn restart(&mut self) {
        self.samples.clear();
    }
    pub fn samples(&self) -> usize {
        self.samples.len()
    }
}

/// Earth-fixed point of a position and a height above sea level (m).
pub fn ecef(p: LatLon, alt_msl: f64) -> DVec3 {
    let (x, y, z) = geodesy::geodetic_to_ecef(p.0, p.1, alt_msl + geoid(p.0, p.1));
    DVec3::new(x, y, z)
}

/// Rays straight down (world) onto the mesh at points along the centreline, where the tiles have loaded. Returns how
/// many hit.
pub fn measure(rwy: &mut Runway, frame: &Frame, ray: &mut impl FnMut(Vec3) -> Option<Vec3>, points: usize) -> usize {
    let len = rwy.length();
    let mut hits = 0;
    for i in 0..points {
        let d = len * (0.08 + 0.84 * i as f64 / (points.max(2) - 1) as f64);
        let top = rwy.world_at(frame, d, 0.0) + Vec3::Y * 400.0;
        if let Some(hit) = ray(top) {
            let (_, _, h) = frame.geodetic(hit);
            let c = rwy.along(d);
            rwy.sample(d, h - geoid(c.0, c.1));
            hits += 1;
        }
    }
    hits
}

// ---- lights -------------------------------------------------------------------------------------------------------

/// A runway light: where it is on the Earth, and what kind (colour, and for the PAPI its angle).
#[derive(Component)]
pub struct Light {
    pub ecef: DVec3,
    pub kind: LightKind,
}

#[derive(Clone, Copy, PartialEq)]
pub enum LightKind {
    Edge,
    Threshold,
    End,
    Approach,
    Centre,
    /// Precision approach path indicator: red below this angle (rad) seen from the eye, white above.
    Papi(f32),
}

impl LightKind {
    fn color(self) -> LinearRgba {
        match self {
            LightKind::Edge | LightKind::Approach | LightKind::Centre => LinearRgba::rgb(9.0, 8.0, 6.0),
            LightKind::Threshold => LinearRgba::rgb(1.0, 9.0, 2.0),
            LightKind::End => LinearRgba::rgb(9.0, 0.6, 0.4),
            LightKind::Papi(_) => LinearRgba::rgb(9.0, 9.0, 9.0),
        }
    }
    /// Size (m) at 1 km: the lamps are small, but a pilot sees them from miles out.
    fn size(self) -> f32 {
        match self {
            LightKind::Papi(_) => 1.4,
            LightKind::Approach => 0.9,
            _ => 0.6,
        }
    }
}

/// Marks the lights of the runways in use, for despawning at the end of a flight.
#[derive(Component)]
pub struct RunwayLights;

#[derive(Resource)]
pub struct LightAssets {
    pub mesh: Handle<Mesh>,
    pub materials: Vec<(LightKind, Handle<StandardMaterial>)>,
    pub papi_red: Handle<StandardMaterial>,
    pub papi_white: Handle<StandardMaterial>,
}

impl LightAssets {
    pub fn new(meshes: &mut Assets<Mesh>, materials: &mut Assets<StandardMaterial>) -> Self {
        let mat = |materials: &mut Assets<StandardMaterial>, c: LinearRgba| materials.add(StandardMaterial { base_color: Color::BLACK, emissive: c, unlit: true, ..default() });
        let kinds = [LightKind::Edge, LightKind::Threshold, LightKind::End, LightKind::Approach, LightKind::Centre];
        LightAssets {
            mesh: meshes.add(Sphere::new(0.5).mesh().ico(1).unwrap()),
            materials: kinds.iter().map(|k| (*k, mat(materials, k.color()))).collect(),
            papi_red: mat(materials, LinearRgba::rgb(12.0, 0.5, 0.3)),
            papi_white: mat(materials, LinearRgba::rgb(9.0, 9.0, 9.0)),
        }
    }
    fn material(&self, kind: LightKind) -> Handle<StandardMaterial> {
        match kind {
            LightKind::Papi(_) => self.papi_white.clone(),
            k => self.materials.iter().find(|(m, _)| *m == k).map(|(_, h)| h.clone()).unwrap_or_default(),
        }
    }
}

/// The runway's lights, in the landing direction: edge lights every 60 m, green threshold bar, red end bar, centreline
/// lights, a 900 m approach light line with a crossbar, and the PAPI 300 m in on the left.
pub fn spawn_lights(commands: &mut Commands, assets: &LightAssets, rwy: &Runway) {
    let len = rwy.length();
    let course = rwy.course();
    let half = rwy.width / 2.0 + 1.5;
    let mut put = |p: LatLon, kind: LightKind, dh: f64| {
        let t = nav::cross_track(rwy.a.pos, rwy.b.pos, p).1 / len;
        let ecef = ecef(p, rwy.surface_elev(t) + dh);
        commands.spawn((Light { ecef, kind }, Mesh3d(assets.mesh.clone()), MeshMaterial3d(assets.material(kind)), Transform::default(), Visibility::default(), RunwayLights, crate::sandbox::NoHit));
    };
    let side = |c: LatLon, s: f64| nav::destination(c, course + std::f64::consts::FRAC_PI_2, s);
    let n = (len / 60.0).floor() as usize;
    for i in 0..=n {
        let c = rwy.along(len * i as f64 / n as f64);
        put(side(c, -half), LightKind::Edge, 0.3);
        put(side(c, half), LightKind::Edge, 0.3);
    }
    let m = (len / 30.0).floor() as usize;
    for i in 0..=m {
        put(rwy.along(len * i as f64 / m as f64), LightKind::Centre, 0.05);
    }
    let thr = rwy.a.displaced;
    for k in -6..=6 {
        let s = k as f64 * half / 6.0;
        put(side(rwy.along(thr), s), LightKind::Threshold, 0.2);
        put(side(rwy.along(len), s), LightKind::End, 0.2);
    }
    for i in 1..=30 {
        let c = rwy.along(thr - 30.0 * i as f64);
        put(c, LightKind::Approach, 0.5);
        if i == 10 {
            for s in [-12.0, -8.0, -4.0, 4.0, 8.0, 12.0] {
                put(side(c, s), LightKind::Approach, 0.5);
            }
        }
    }
    // PAPI: four boxes left of the runway, 300 m past the threshold; seen from the 3° path, two red and two white.
    let papi = side(rwy.along(thr + 300.0), -(half + 15.0));
    for (i, deg) in [3.5f32, 3.17, 2.83, 2.5].iter().enumerate() {
        put(nav::destination(papi, course - std::f64::consts::FRAC_PI_2, 9.0 * i as f64), LightKind::Papi(deg.to_radians()), 0.8);
    }
}

/// Places the lights in the current frame, scales them to stay visible from afar (brighter at night), and turns each
/// PAPI box red or white for the camera's angle above it.
pub fn place_lights(frame: &Frame, cam: &Transform, daylight: f32, assets: &LightAssets, lights: &mut Query<(&Light, &mut Transform, &mut MeshMaterial3d<StandardMaterial>, &mut Visibility), Without<bevy_3d_tiles::Tiles3dCamera>>) {
    let night = 1.0 - daylight.clamp(0.0, 1.0);
    for (light, mut tf, mut mat, mut vis) in lights {
        let p = frame.from_ecef(light.ecef);
        let dist = p.distance(cam.translation);
        // Edge and centre lights only show by night or in the last few kilometres; the approach lights and the PAPI
        // always.
        let shown = match light.kind {
            LightKind::Papi(_) | LightKind::Approach | LightKind::Threshold | LightKind::End => dist < 25_000.0,
            _ => dist < 3_000.0 + 12_000.0 * night,
        };
        vis.set_if_neq(if shown { Visibility::Inherited } else { Visibility::Hidden });
        if !shown {
            continue;
        }
        tf.translation = p;
        tf.scale = Vec3::splat(light.kind.size() * (dist / 1_000.0).clamp(0.4, 12.0) * (0.6 + 0.6 * night));
        if let LightKind::Papi(angle) = light.kind {
            let above = (cam.translation.y - p.y) / (cam.translation - p).with_y(0.0).length().max(1.0);
            let want = if above.atan() > angle { &assets.papi_white } else { &assets.papi_red };
            if mat.0 != *want {
                mat.0 = want.clone();
            }
        }
    }
}

/// Distance from the threshold (NM) at which a runway's lights are worth spawning.
pub const LIGHTS_FROM_NM: f64 = 40.0;
pub fn within_lights(rwy: &Runway, p: LatLon) -> bool {
    nav::distance(p, rwy.threshold()) < LIGHTS_FROM_NM * NM
}
