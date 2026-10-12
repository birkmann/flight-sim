//! The globe from high up, and getting around it.
//! - Tile detail: the crate relaxes detail with a tile's distance beyond the camera's height (`detail_falloff_m`).
//!   From high up that falloff grows with the altitude, so seas and coastlines toward the horizon stay readable.
//! - Free flight is faster the higher it is, so the globe can be crossed from orbit and a street still flown slowly.
//! - Fly-to: the search box (`place.js`) sends a place; the camera climbs, crosses along the great circle and comes
//!   down facing it, in a few seconds whatever the distance. Moving or looking takes the camera back.
//! - The start screen (`start.js`) flies to a city with `orbit`: the camera then circles it behind the menu. It
//!   spawns the chosen vehicle at a place (`lat`, `lon`, `heading`), on the ground found there (`place_spawns`).

use std::f64::consts::PI as PI64;

use bevy::input::mouse::AccumulatedMouseMotion;
use bevy::math::DVec3;
use bevy::prelude::*;
use bevy_3d_tiles::{Tiles3dCamera, Tiles3dConfig, geodesy};
use serde_json::{Value, json};

use super::{NoHit, Pad, Pilot, Settings, VehicleMesh, look, wrap, yaw_of};
use crate::origin::Frame;

/// Mean Earth radius (m), for great-circle distances.
pub(super) const EARTH_RADIUS: f64 = 6_371_000.0;
/// The highest a flight climbs (m): about where the whole of Europe fits in the view.
const MAX_PEAK: f64 = 2_500_000.0;
/// Points of the precomputed path (horizontal progress against time).
const SAMPLES: usize = 128;

/// Free flight's speed multiplier at an altitude (m): 1 up to 4 km, then in proportion.
pub(super) fn speed_scale(altitude: f32) -> f32 {
    (altitude / 4_000.0).max(1.0)
}

/// The tiles' detail falloff follows the altitude: from 167 km up, the crate's 2 km made everything past the
/// ground right below the camera ~80× coarser than asked for.
pub(super) fn tile_detail(frame: Res<Frame>, cam: Single<&Transform, With<Tiles3dCamera>>, mut config: ResMut<Tiles3dConfig>, mut base: Local<Option<f64>>) {
    let base = *base.get_or_insert(config.detail_falloff_m);
    // 0 is the benchmark's `?falloff=0` (no falloff at all): leave it.
    if base <= 0.0 {
        return;
    }
    let want = base.max(f64::from(frame.altitude(cam.translation)));
    if (config.detail_falloff_m - want).abs() > want * 0.05 {
        config.detail_falloff_m = want;
    }
}

/// A place to fly to, as the page sends it.
struct Request {
    lat: f64,
    lon: f64,
    /// The height (m) to arrive at above the ground: more for a country than for a street.
    height: f64,
    name: String,
    /// Keep circling the place after arriving (the start screen's backdrop).
    orbit: bool,
}

struct Flight {
    name: String,
    target: (f64, f64),
    /// Bearing (rad) from the place to where the camera arrives, and the horizontal distance (m) between them.
    back: f64,
    reach: f64,
    orbit: bool,
    /// Where the camera starts and where it arrives (unit vectors of geodetic latitude and longitude), and the angle
    /// between them.
    from: DVec3,
    to: DVec3,
    angle: f64,
    /// Altitudes (m above sea level): start, arrival over flat ground at sea level, and the climb's bulge (natural log).
    a0: f64,
    a1: f64,
    bulge: f64,
    /// The ground at the target (m above sea level), once the tiles there answer a ray.
    ground: Option<f64>,
    yaw0: f32,
    pitch0: f32,
    pitch1: f32,
    t: f32,
    duration: f32,
    /// Horizontal progress at evenly spaced points of the eased time: the camera crosses fast high up and slowly
    /// near the ground, so the view below moves at an even pace (van Wijk and Nuij's smooth zoom, simplified).
    progress: Vec<f64>,
}

impl Flight {
    fn new(req: &Request, lat: f64, lon: f64, altitude: f64, yaw0: f32, pitch0: f32) -> Self {
        let target = (req.lat, req.lon);
        let a0 = altitude.max(50.0);
        let a1 = req.height.clamp(300.0, MAX_PEAK);
        // Arrive looking at the place: steeper when arriving high.
        let pitch1 = -(35.0 + 40.0 * smoothstep(5_000.0, 800_000.0, a1)).to_radians() as f32;
        let start = normal(lat, lon);
        let distance = start.angle_between(normal(target.0, target.1)) * EARTH_RADIUS;
        // Back from the place, on the side the camera comes from, far enough to look down at it.
        let back = if distance > 1.0 { bearing(target, (lat, lon)) } else { -f64::from(yaw0) + PI64 };
        let reach = a1 / (-f64::from(pitch1)).tan();
        let to = destination(target, back, reach);
        let peak = (distance * 0.45).clamp(a0.max(a1), MAX_PEAK);
        let bulge = (peak.ln() - (a0.ln() + a1.ln()) / 2.0).max(0.0);
        // A few seconds whatever the distance: ~3.5 s for 10 km, 7.5 s for Berlin to Paris, 8 s across an ocean.
        let duration = (2.0 + 0.9 * (1.0 + distance / 2_000.0).ln()).clamp(2.5, 8.0) as f32;
        let mut flight = Flight { name: req.name.clone(), target, back, reach, orbit: req.orbit, from: start, to, angle: start.angle_between(to), a0, a1, bulge, ground: None, yaw0, pitch0, pitch1, t: 0.0, duration, progress: Vec::new() };
        // Cumulative altitude over the path: moving in proportion to it keeps the ground's apparent speed even.
        let mut sum = 0.0;
        flight.progress.push(0.0);
        for i in 1..=SAMPLES {
            let s = (i as f64 - 0.5) / SAMPLES as f64;
            sum += flight.altitude(s);
            flight.progress.push(sum);
        }
        for p in &mut flight.progress {
            *p /= sum.max(1e-9);
        }
        flight
    }

    /// Altitude over flat ground at `s` (0..1): up in log space, with a bulge in the middle for long flights.
    fn altitude(&self, s: f64) -> f64 {
        ((1.0 - s) * self.a0.ln() + s * self.a1.ln() + self.bulge * (PI64 * s).sin()).exp()
    }

    /// How high the middle of the flight is over the ends (0..1): the view looks down at the globe then.
    fn height_share(&self, s: f64) -> f64 {
        (PI64 * s).sin() * smoothstep(0.0, 1.5, self.bulge)
    }

    fn horizontal(&self, s: f64) -> f64 {
        let x = s * SAMPLES as f64;
        let i = (x.floor() as usize).min(SAMPLES - 1);
        let f = x - i as f64;
        self.progress[i] * (1.0 - f) + self.progress[i + 1] * f
    }
}

/// Circling a place after a flight there, looking at it, until the camera is taken back.
struct Orbit {
    target: (f64, f64),
    /// Bearing (rad) from the place to the camera, which turns; the horizontal distance (m); the camera's altitude.
    back: f64,
    reach: f64,
    altitude: f64,
    pitch: f32,
}

/// How fast the camera circles a place (rad/s): once around in 2.5 minutes.
const ORBIT_RATE: f64 = std::f64::consts::TAU / 150.0;
/// How long a spawn at a place waits for the tiles there to answer a ray (s) before it uses the page's height.
const SPAWN_WAIT: f32 = 3.0;

#[derive(Resource, Default)]
pub(super) struct Travel {
    pending: Option<Request>,
    flight: Option<Flight>,
    orbit: Option<Orbit>,
    /// Spawns at a place (`lat`, `lon`) waiting for the ground there, and how long each has waited (s).
    spawns: Vec<(Value, f32)>,
    /// The same spawns once placed: `at` (world point) and `yaw` added, for `apply_commands`.
    placed: Vec<Value>,
}

impl Travel {
    /// A `flyto` or `flycancel` command from the page.
    pub(super) fn command(&mut self, cmd: &Value) {
        if cmd.get("type").and_then(Value::as_str) == Some("flycancel") {
            self.pending = None;
            self.flight = None;
            self.orbit = None;
            return;
        }
        let num = |k: &str| cmd.get(k).and_then(Value::as_f64);
        let (Some(lat), Some(lon)) = (num("lat"), num("lon")) else { return };
        if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
            return;
        }
        let name = cmd.get("name").and_then(Value::as_str).unwrap_or("destination").to_owned();
        let orbit = cmd.get("orbit").and_then(Value::as_bool).unwrap_or(false);
        self.pending = Some(Request { lat, lon, height: num("height").unwrap_or(1_500.0), name, orbit });
    }

    /// A `spawn` with `lat` and `lon`: it waits for `place_spawns` to find the ground there.
    pub(super) fn spawn_at(&mut self, cmd: Value) {
        self.spawns.push((cmd, 0.0));
    }

    /// The spawns `place_spawns` has placed since the last call.
    pub(super) fn take_placed(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.placed)
    }

    /// For the HUD: where to and how far along.
    pub(super) fn hud(&self) -> Value {
        match &self.flight {
            Some(f) => json!({ "name": f.name, "progress": f.t / f.duration, "left": f.duration - f.t }),
            None => Value::Null,
        }
    }
}

/// Unit vector of a geodetic latitude and longitude (degrees), in Earth-fixed axes.
fn normal(lat: f64, lon: f64) -> DVec3 {
    let (lat, lon) = (lat.to_radians(), lon.to_radians());
    DVec3::new(lat.cos() * lon.cos(), lat.cos() * lon.sin(), lat.sin())
}

fn lat_lon(n: DVec3) -> (f64, f64) {
    (n.z.clamp(-1.0, 1.0).asin().to_degrees(), n.y.atan2(n.x).to_degrees())
}

/// Initial great-circle bearing (rad, clockwise from north) from one point to another.
fn bearing(from: (f64, f64), to: (f64, f64)) -> f64 {
    let (p1, p2) = (from.0.to_radians(), to.0.to_radians());
    let dl = (to.1 - from.1).to_radians();
    (dl.sin() * p2.cos()).atan2(p1.cos() * p2.sin() - p1.sin() * p2.cos() * dl.cos())
}

/// The point `distance` metres from `from` along a bearing, as a unit vector.
fn destination(from: (f64, f64), bearing: f64, distance: f64) -> DVec3 {
    let d = distance / EARTH_RADIUS;
    let p1 = from.0.to_radians();
    let p2 = (p1.sin() * d.cos() + p1.cos() * d.sin() * bearing.cos()).asin();
    let l2 = from.1.to_radians() + (bearing.sin() * d.sin() * p1.cos()).atan2(d.cos() - p1.sin() * p2.sin());
    normal(p2.to_degrees(), l2.to_degrees())
}

/// Earth-fixed position of a latitude, longitude and height above sea level.
fn ecef(lat: f64, lon: f64, altitude: f64) -> DVec3 {
    let (x, y, z) = geodesy::geodetic_to_ecef(lat, lon, altitude + crate::geoid::geoid(lat, lon));
    DVec3::new(x, y, z)
}

/// Orientation of the local east/up/south axes (the world frame's X/Y/Z where it touches the ground) at a place,
/// in the current world frame.
fn local_axes(frame: &Frame, lat: f64, lon: f64) -> Quat {
    let (p, l) = (lat.to_radians(), lon.to_radians());
    let east = DVec3::new(-l.sin(), l.cos(), 0.0);
    let up = normal(lat, lon);
    let north = DVec3::new(-p.sin() * l.cos(), -p.sin() * l.sin(), p.cos());
    let ecef_from_local = Quat::from_mat3(&Mat3::from_cols(east.as_vec3(), up.as_vec3(), (-north).as_vec3()));
    (frame.world_rot_from_ecef() * ecef_from_local).normalize()
}

fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Starts, flies and ends a flight to a place. It runs after free flight and takes the camera over while it lasts.
#[allow(clippy::too_many_arguments)]
pub(super) fn fly_to(
    time: Res<Time>,
    mut travel: ResMut<Travel>,
    mut pilot: ResMut<Pilot>,
    settings: Res<Settings>,
    pad: Res<Pad>,
    keys: Res<ButtonInput<KeyCode>>,
    motion: Res<AccumulatedMouseMotion>,
    frame: Res<Frame>,
    mut cam: Single<&mut Transform, With<Tiles3dCamera>>,
    mut ray_cast: MeshRayCast,
    vehicle_meshes: Query<(), With<VehicleMesh>>,
    no_hit: Query<(), With<NoHit>>,
) {
    if let Some(req) = travel.pending.take() {
        if pilot.vehicle.is_some() {
            pilot.leave();
        }
        pilot.aftermath = None;
        let (lat, lon, _) = frame.geodetic(cam.translation);
        let (yaw, pitch, _) = cam.rotation.to_euler(EulerRot::YXZ);
        let flight = Flight::new(&req, lat, lon, f64::from(frame.altitude(cam.translation)), yaw, pitch);
        pilot.say(format!("FLYING TO {}", req.name.to_uppercase()));
        travel.flight = Some(flight);
        travel.orbit = None;
    }
    if travel.flight.is_none() && travel.orbit.is_none() {
        return;
    }
    // Moving, looking or getting into something takes the camera back.
    // (Not while typing in a menu.)
    let moved = !settings.menu_open
        && ([KeyCode::KeyW, KeyCode::KeyA, KeyCode::KeyS, KeyCode::KeyD, KeyCode::Space, KeyCode::KeyC].iter().any(|k| keys.pressed(*k))
            || pad.stick.length() > 0.2
            || pad.trigger.abs() > 0.2
            || pad.look.length() > 0.2
            || (pilot.locked && motion.delta.length() > 2.0));
    if moved || pilot.vehicle.is_some() {
        let (yaw, pitch, _) = cam.rotation.to_euler(EulerRot::YXZ);
        pilot.yaw = yaw;
        pilot.pitch = pitch;
        travel.flight = None;
        travel.orbit = None;
        return;
    }
    let Some(f) = travel.flight.as_mut() else {
        // Circling after the flight: around the place, still looking at it.
        let Some(o) = travel.orbit.as_mut() else { return };
        o.back += ORBIT_RATE * f64::from(time.delta_secs());
        let (lat, lon) = lat_lon(destination(o.target, o.back, o.reach));
        cam.translation = frame.from_ecef(ecef(lat, lon, o.altitude));
        cam.rotation = local_axes(&frame, lat, lon) * look(-bearing((lat, lon), o.target) as f32, o.pitch);
        pilot.yaw = yaw_of(cam.rotation);
        pilot.pitch = cam.rotation.to_euler(EulerRot::YXZ).1;
        return;
    };
    f.t = (f.t + time.delta_secs()).min(f.duration);
    let x = f64::from(f.t / f.duration);
    let s = x * x * (3.0 - 2.0 * x);
    let u = f.horizontal(s);
    let here = if f.angle > 1e-9 { f.from.slerp(f.to, u) } else { f.to };
    let (lat, lon) = lat_lon(here);
    // The ground at the place, once its tiles are in: the arrival height is above it, not above sea level.
    if s > 0.35 {
        let top = frame.from_ecef(ecef(f.target.0, f.target.1, 9_000.0));
        let down = local_axes(&frame, f.target.0, f.target.1) * Vec3::NEG_Y;
        if top.distance(cam.translation) < 400_000.0
            && let Ok(dir) = Dir3::new(down)
        {
            let filter = |e: Entity| !vehicle_meshes.contains(e) && !no_hit.contains(e);
            let ray = MeshRayCastSettings::default().with_filter(&filter).with_visibility(RayCastVisibility::Any).always_early_exit();
            if let Some((_, hit)) = ray_cast.cast_ray(Ray3d::new(top, dir), &ray).first() {
                let ground = f64::from(frame.altitude(hit.point));
                let k = f64::from((3.0 * time.delta_secs()).min(1.0));
                f.ground = Some(f.ground.map_or(ground, |g| g + (ground - g) * k));
            }
        }
    }
    let altitude = f.altitude(s) + f.ground.unwrap_or(0.0).max(0.0) * smoothstep(0.35, 1.0, s);
    let position = frame.from_ecef(ecef(lat, lon, altitude));
    // Turn toward the place early, look down at the globe while high, and come down facing the place.
    let course = if here.angle_between(normal(f.target.0, f.target.1)) > 1e-7 { -bearing((lat, lon), f.target) as f32 } else { f.yaw0 };
    let turn = smoothstep(0.0, 0.25, s) as f32;
    let yaw = f.yaw0 + wrap(course - f.yaw0) * turn;
    let level = f.pitch0 + (f.pitch1 - f.pitch0) * smoothstep(0.0, 1.0, s) as f32;
    let pitch = level + (-80f32.to_radians() - level) * f.height_share(s) as f32;
    cam.translation = position;
    cam.rotation = local_axes(&frame, lat, lon) * look(yaw, pitch);
    if f.t >= f.duration {
        let name = f.name.to_uppercase();
        if f.orbit {
            travel.orbit = Some(Orbit { target: f.target, back: f.back, reach: f.reach, altitude, pitch: f.pitch1 });
        }
        travel.flight = None;
        pilot.yaw = yaw_of(cam.rotation);
        pilot.pitch = cam.rotation.to_euler(EulerRot::YXZ).1;
        pilot.say(name);
    }
}

/// Spawns at a place (the start screen's: `lat`, `lon`, `heading` in degrees from north; or a surface craft's that
/// `apply_commands` had no ground for, with `yaw`): the ground there, from a ray down through the tiles, becomes the
/// spawn's `at` (a world point) and `yaw`, for `apply_commands` in the same frame. While the tiles there are still streaming in it asks again each frame; after `SPAWN_WAIT` it uses the
/// page's height instead (`elev`, m above sea level), and the vehicle finds the ground itself.
pub(super) fn place_spawns(time: Res<Time>, mut travel: ResMut<Travel>, frame: Res<Frame>, mut ray_cast: MeshRayCast, vehicle_meshes: Query<(), With<VehicleMesh>>, no_hit: Query<(), With<NoHit>>) {
    if travel.spawns.is_empty() {
        return;
    }
    let filter = |e: Entity| !vehicle_meshes.contains(e) && !no_hit.contains(e);
    let mut waiting = Vec::new();
    for (mut cmd, waited) in std::mem::take(&mut travel.spawns) {
        let num = |k: &str| cmd.get(k).and_then(Value::as_f64);
        let (Some(lat), Some(lon)) = (num("lat"), num("lon")) else { continue };
        let heading = num("heading").unwrap_or(0.0).to_radians() as f32;
        let elev = num("elev").unwrap_or(0.0);
        let axes = local_axes(&frame, lat, lon);
        let top = frame.from_ecef(ecef(lat, lon, 9_000.0));
        // The tiles on screen first; hidden ones too once it has waited a while (the place may be out of view).
        let seen = if waited < SPAWN_WAIT / 2.0 { RayCastVisibility::Visible } else { RayCastVisibility::Any };
        let ray = MeshRayCastSettings::default().with_filter(&filter).with_visibility(seen);
        let hit = Dir3::new(axes * Vec3::NEG_Y).ok().and_then(|down| ray_cast.cast_ray(Ray3d::new(top, down), &ray).first().map(|(_, h)| h.point));
        let at = match hit {
            Some(p) => p,
            None if waited < SPAWN_WAIT => {
                waiting.push((cmd, waited + time.delta_secs()));
                continue;
            }
            None => frame.from_ecef(ecef(lat, lon, elev)),
        };
        cmd["at"] = json!([at.x, at.y, at.z]);
        // The page gives a heading; a spawn sent on from `apply_commands` keeps the camera's yaw.
        if cmd.get("yaw").is_none() {
            cmd["yaw"] = json!(yaw_of(axes * Quat::from_rotation_y(-heading)));
        }
        travel.placed.push(cmd);
    }
    travel.spawns = waiting;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn berlin_to(lat: f64, lon: f64, height: f64) -> Flight {
        let req = Request { lat, lon, height, name: "x".into(), orbit: false };
        Flight::new(&req, 52.5163, 13.3777, 600.0, 0.0, -0.3)
    }

    #[test]
    fn arrives_near_the_place_at_the_asked_height() {
        let f = berlin_to(48.8584, 2.2945, 1_500.0);
        let (lat, lon) = lat_lon(f.from.slerp(f.to, f.horizontal(1.0)));
        let off = normal(lat, lon).angle_between(normal(48.8584, 2.2945)) * EARTH_RADIUS;
        // Back from it by height / tan(35°), on the side the flight came from (the north-east).
        assert!((off - 1_500.0 / 35f64.to_radians().tan()).abs() < 50.0, "{off}");
        assert!(lat > 48.8584 && lon > 2.2945);
        assert!((f.altitude(1.0) - 1_500.0).abs() < 1.0);
        assert!((f.altitude(0.0) - 600.0).abs() < 1.0);
    }

    #[test]
    fn long_flights_climb_and_are_quick() {
        let paris = berlin_to(48.8584, 2.2945, 1_500.0);
        let peak = (0..=20).map(|i| paris.altitude(i as f64 / 20.0)).fold(0.0, f64::max);
        assert!(peak > 300_000.0 && peak < 450_000.0, "{peak}");
        assert!(paris.duration > 6.0 && paris.duration <= 8.0);
        let hop = berlin_to(52.52, 13.40, 1_500.0);
        assert!(hop.duration < 4.0);
    }

    #[test]
    fn crosses_slowly_near_the_ground_and_fast_high_up() {
        let f = berlin_to(40.7128, -74.006, 2_000.0);
        let early = f.horizontal(0.1) - f.horizontal(0.05);
        let middle = f.horizontal(0.525) - f.horizontal(0.475);
        assert!(middle > 20.0 * early, "{early} {middle}");
        assert!(f.horizontal(0.0) == 0.0 && (f.horizontal(1.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn bearings() {
        assert!((bearing((0.0, 0.0), (0.0, 10.0)) - PI64 / 2.0).abs() < 1e-9);
        assert!(bearing((0.0, 0.0), (10.0, 0.0)).abs() < 1e-9);
        let d = destination((0.0, 0.0), PI64 / 2.0, 111_195.0);
        let (lat, lon) = lat_lon(d);
        assert!(lat.abs() < 1e-6 && (lon - 1.0).abs() < 1e-3);
    }
}
