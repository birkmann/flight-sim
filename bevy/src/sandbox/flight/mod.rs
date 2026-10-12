//! Flight mode: from one airport's runway to another's. The planner (`flight.js`) picks the airports, runways,
//! aircraft and route and sends them as a `flight` command; this module takes the world there, waits for the
//! scenery, puts the aircraft on the runway, and flies it — the flight model (`model.rs`), navigation (`nav.rs`),
//! the autopilot and autothrust (`autoflight.rs`), the runways and their lights (`airport.rs`), the beginners' flight
//! path guide (`guide.rs`) — and hands the
//! cockpit (`cockpit/*.js`) its state as the `flight` part of the HUD's.
//!
//! The aircraft is an ordinary sandbox `Vehicle` (the camera, the model's moving parts, the wreck and the network
//! treat it as one) with an `Aircraft` on it, which the sandbox's own `fly_aircraft` leaves to `fly` here.

mod airport;
mod autoflight;
mod guide;
mod model;
mod nav;
mod types;

use std::time::Duration;

use bevy::prelude::*;
use bevy_3d_tiles::{EcefOrigin, Tiles3dCamera, Tiles3dDecodeStats};
use serde_json::{Value, json};

pub use model::Aircraft;

use super::{Blast, Controls, Net, NoHit, Pad, Part, Pilot, Settings, Shell, Smoulder, Vehicle, VehicleMesh, View, globe, heading_of, look};
use crate::catalog;
use crate::origin::Frame;
use crate::physics::{self, AirData};
use crate::weather::{Sky, Weather};
use airport::{LightAssets, Runway, RunwayLights};
use autoflight::{Autoflight, Managed, Sense};
use model::{Env, Event, Input};
use nav::{NM, Route, Waypoint};
use types::{FT, KT, Law, Type, VSpeeds};

/// How far below the aircraft the flight model puts the ground when none was found under it (m): out of reach of any
/// step, and above a radio altimeter's range.
const UNSEEN_BELOW: f32 = 10_000.0;

pub struct FlightPlugin;

impl Plugin for FlightPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Inbox>()
            .init_resource::<HudOut>()
            .init_resource::<Session>()
            .init_resource::<guide::Guide>()
            .add_systems(Startup, setup)
            .add_systems(
                Update,
                (
                    session.after(super::apply_commands).before(super::fly_free),
                    fly.after(super::probe_ground).after(super::read_controls).before(super::place_camera),
                    cockpit_camera.after(super::place_camera),
                    lights.after(super::rebase).before(super::hud),
                    guide::place.after(fly).after(super::rebase).before(super::hud),
                ),
            );
    }
}

/// Commands for the flight from the page (`flight`, `flightend`, `fcu`, `simrate`, `fsys`), passed on by
/// `apply_commands`.
#[derive(Resource, Default)]
pub struct Inbox(pub Vec<Value>);

/// The flight's part of the HUD state, for `hud`.
#[derive(Resource, Default)]
pub struct HudOut(pub Value);

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
enum Phase {
    #[default]
    Idle,
    /// Waiting for the scenery at the start.
    Loading,
    /// The aircraft is in place and waiting for its model (its size puts the wheels on the ground).
    Ready,
    Flying,
    Landed,
    Crashed,
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum Start {
    #[default]
    Runway,
    Final,
    Cruise,
}

#[derive(Resource)]
struct Session {
    phase: Phase,
    start: Start,
    ty: &'static Type,
    aircraft: Option<Entity>,
    fuel: f32,
    payload: f32,
    dep: Option<Runway>,
    arr: Option<Runway>,
    route: Route,
    af: Autoflight,
    vspeeds: VSpeeds,
    waited: f32,
    rate: f32,
    lights: [bool; 2],
    measure_in: f32,
    /// Loading: how long (s) the start runway's measured surface has held still, and the scenery (no new tile); the
    /// offset and the count of tiles decoded when last looked at.
    settled: (f32, f32),
    settle_mark: (f64, u64),
    /// How close the destination runway was last measured from (0: not yet, 1..3: 15, 6, 2.5 km).
    arr_band: u8,
    /// Turbulence: the gust velocity now (m/s), the reported gusts (kt, from a METAR), a random generator's state.
    gust: Vec3,
    gust_kt: f32,
    rng: u32,
    /// The copilot: flaps, gear, spoilers and autobrake on schedule, the descent at the top of descent, the approach
    /// armed (the planner's "Copilot" option); and whether it has the speed brake out.
    assist: bool,
    copilot_brake: bool,
    /// Going around (until the next glide slope capture).
    go_around: bool,
    /// Where the flight path guide's climb starts.
    climb: guide::Climb,
    /// Speed last frame (m/s), for the acceleration; the flight's clock and distance.
    last_speed: f32,
    accel: f32,
    flight_time: f32,
    distance: f32,
    touchdown: Option<Value>,
    report: Option<Value>,
    notes: Vec<String>,
    /// Panel commands, for `fly`, which has the aircraft's state.
    pending: Vec<Value>,
}

impl Default for Session {
    fn default() -> Self {
        Session {
            phase: Phase::Idle,
            start: Start::Runway,
            ty: &types::AIRLINER,
            aircraft: None,
            fuel: 0.0,
            payload: 0.0,
            dep: None,
            arr: None,
            route: Route::default(),
            af: Autoflight::default(),
            vspeeds: VSpeeds::default(),
            waited: 0.0,
            rate: 1.0,
            lights: [false; 2],
            measure_in: 0.0,
            settled: (0.0, 0.0),
            settle_mark: (f64::NAN, 0),
            arr_band: 0,
            gust: Vec3::ZERO,
            gust_kt: 0.0,
            rng: 0x9e37_79b9,
            assist: false,
            copilot_brake: false,
            go_around: false,
            climb: guide::Climb::default(),
            last_speed: 0.0,
            accel: 0.0,
            flight_time: 0.0,
            distance: 0.0,
            touchdown: None,
            report: None,
            notes: Vec::new(),
            pending: Vec::new(),
        }
    }
}

impl Session {
    fn note(&mut self, s: impl Into<String>) {
        self.notes.push(s.into());
        if self.notes.len() > 6 {
            self.notes.remove(0);
        }
    }
}

/// Whether a flight is on: the sandbox's own keys (weapons, spawning, the gear key) stand aside.
pub fn flying(aircraft: &Query<(), With<Aircraft>>, e: Entity) -> bool {
    aircraft.contains(e)
}

fn setup(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut materials: ResMut<Assets<StandardMaterial>>) {
    commands.insert_resource(LightAssets::new(&mut meshes, &mut materials));
}

// ---- starting and ending ------------------------------------------------------------------------------------------

/// The world frame moved to a far place at once: centred on `(lat, lon)`, everything of ours cleared away (it would
/// be thousands of kilometres off), the tiles re-placed.
fn teleport(frame: &mut Frame, origin: &mut EcefOrigin, at: nav::LatLon) {
    let old = frame.clone();
    let mut next = Frame::new(at.0, at.1, old.elev);
    let new_from_old = next.world_from_ecef * old.ecef_from_world;
    next.world_from_start = new_from_old * old.world_from_start;
    origin.world_from_ecef = Some(next.world_from_ecef);
    *frame = next;
}

#[allow(clippy::too_many_arguments)]
fn session(
    mut commands: Commands,
    time: Res<Time<Real>>,
    (mut inbox, mut guide): (ResMut<Inbox>, ResMut<guide::Guide>),
    mut s: ResMut<Session>,
    world: (ResMut<Frame>, ResMut<EcefOrigin>, Res<Tiles3dDecodeStats>),
    mut pilot: ResMut<Pilot>,
    mut net: ResMut<Net>,
    mut travel: ResMut<globe::Travel>,
    mut cam: Single<&mut Transform, With<Tiles3dCamera>>,
    asset_server: Res<AssetServer>,
    mut ray_cast: MeshRayCast,
    filters: (Query<(), With<VehicleMesh>>, Query<(), With<NoHit>>),
    clear: Query<Entity, Or<(With<Shell>, With<Blast>, With<Smoulder>, With<RunwayLights>, With<Aircraft>)>>,
    light_assets: Res<LightAssets>,
    mut vtime: ResMut<Time<Virtual>>,
    vehicles: Query<(&Transform, &Vehicle, &Aircraft), Without<Tiles3dCamera>>,
) {
    let (vehicle_meshes, no_hit) = filters;
    let (mut frame, mut origin, decoded) = world;
    let s = &mut *s;
    let dt = time.delta_secs();
    for cmd in std::mem::take(&mut inbox.0) {
        match cmd.get("type").and_then(Value::as_str) {
            Some("flight") => {
                let Some(ty) = cmd.get("aircraft").and_then(Value::as_str).and_then(types::find) else { continue };
                let (Some(dep), arr) = (cmd.get("dep").and_then(Runway::from_json), cmd.get("arr").and_then(Runway::from_json)) else { continue };
                let mut start = match cmd.get("start").and_then(Value::as_str) {
                    Some("final") if arr.is_some() => Start::Final,
                    Some("cruise") if arr.is_some() => Start::Cruise,
                    _ => Start::Runway,
                };
                // A sailplane is released in the air; ground launches need a tug or winch.
                if ty.id == "glider" && start == Start::Runway {
                    if arr.is_none() { continue; }
                    start = Start::Cruise;
                }
                // Clear the world: the sandbox's own vehicles, shells and smoke, and any flight before this one.
                for e in pilot.spawned.drain(..).chain(clear.iter()) {
                    commands.entity(e).try_despawn();
                }
                if pilot.vehicle.is_some() {
                    pilot.leave();
                }
                pilot.aftermath = None;
                travel.command(&json!({ "type": "flycancel" }));
                let mut route = Route { wpts: cmd.get("route").and_then(Value::as_array).map(|a| a.iter().filter_map(Waypoint::from_json).collect()).unwrap_or_default(), ..Route::default() };
                // A light aircraft levels lower and closer in.
                if ty.panel == "ga" {
                    route.intercept_ft = 2_000.0;
                    route.level_nm = 9.0;
                }
                route.cruise_ft = cmd.get("cruise").and_then(Value::as_f64).unwrap_or(f64::from(ty.cruise_ft));
                let fuel = cmd.get("fuel").and_then(Value::as_f64).map_or(ty.fuel_max * 0.6, |f| f as f32);
                let payload = cmd.get("payload").and_then(Value::as_f64).map_or((ty.mtow - ty.oew - fuel) * 0.5, |p| p as f32);
                let mass = ty.oew + fuel + payload;
                let assist = ty.id != "glider" && cmd.get("assist").and_then(Value::as_bool).unwrap_or(true);
                *s = Session { phase: Phase::Loading, start, ty, fuel, payload, route, vspeeds: ty.vspeeds(mass, 0.0), assist, ..Session::default() };
                s.af.fcu.alt = s.route.cruise_ft as f32;
                // The guide climbs from the departure runway, once off it.
                s.climb = guide::Climb { from_ft: dep.a.elev_ft, at_m: dep.a.displaced.max(0.0) + guide::style(ty).roll, top_ft: s.route.cruise_ft };
                if let Some(on) = cmd.get("guide").and_then(Value::as_bool) {
                    guide.on = on;
                }
                // No autothrust in a light aircraft.
                s.af.fcu.athr = ty.law == Law::FlyByWire;
                // Where the camera waits for the scenery: behind the threshold, looking down the runway; or where
                // the aircraft will appear.
                let (at, course, height) = match start {
                    Start::Runway => (dep.along(-60.0), dep.course(), dep.a.elev_m() + 25.0),
                    Start::Final => {
                        let a = arr.as_ref().unwrap();
                        (nav::destination(a.threshold(), a.course() + std::f64::consts::PI, 10.0 * NM), a.course(), a.a.elev_m() + 10.0 * NM * nav::GLIDE.tan() + 15.0)
                    }
                    Start::Cruise => {
                        let total: f64 = s.route.wpts.windows(2).map(|w| nav::distance(w[0].pos, w[1].pos)).sum();
                        let p = s.route.point_at_dtg(total * 0.5).unwrap_or(dep.threshold());
                        let next = s.route.point_at_dtg(total * 0.5 - 1_000.0).unwrap_or(p);
                        (p, nav::bearing(p, next), s.route.cruise_ft / f64::from(FT))
                    }
                };
                teleport(&mut frame, &mut origin, at);
                cam.translation = frame.from_ecef(airport::ecef(at, height));
                pilot.yaw = -course as f32;
                pilot.pitch = if start == Start::Runway { -0.06 } else { -0.05 };
                cam.rotation = look(pilot.yaw, pilot.pitch);
                s.dep = Some(dep);
                s.arr = arr;
                s.note("LOADING SCENERY");
            }
            Some("flightend") => {
                for e in clear.iter().filter(|e| Some(*e) == s.aircraft) {
                    commands.entity(e).try_despawn();
                }
                if s.aircraft.is_some_and(|e| pilot.vehicle == Some(e)) {
                    pilot.leave();
                }
                *s = Session::default();
            }
            Some("simrate") => {
                let want = cmd.get("rate").and_then(Value::as_f64).unwrap_or(1.0) as f32;
                s.rate = allowed_rate(&s, want, &vehicles);
            }
            Some("fsys") if cmd.get("sys").and_then(Value::as_str) == Some("guide") => {
                guide.on = cmd.get("on").and_then(Value::as_bool).unwrap_or(!guide.on);
                pilot.say(if guide.on { "GUIDE ON · FLY THROUGH THE GATES" } else { "GUIDE OFF" });
            }
            Some("fcu" | "fsys") => s.pending.push(cmd),
            _ => {}
        }
    }
    // Time acceleration, for the long legs.
    if s.phase != Phase::Flying && s.rate != 1.0 {
        s.rate = 1.0;
    }
    let r = allowed_rate(&s, s.rate, &vehicles);
    if r != s.rate {
        s.rate = r;
        s.note(format!("SIM RATE {r}×"));
    }
    if (vtime.relative_speed() - s.rate).abs() > 1e-3 {
        vtime.set_relative_speed(s.rate);
        vtime.set_max_delta(Duration::from_secs_f32(0.25 * s.rate.max(1.0)));
    }

    let filter = |e: Entity| !vehicle_meshes.contains(e) && !no_hit.contains(e);
    // Only what is drawn: hidden coarser tiles stand metres above the ground the pilot sees.
    let settings = MeshRayCastSettings::default().with_filter(&filter).with_visibility(RayCastVisibility::Visible).always_early_exit();
    let mut ray = |top: Vec3| ray_cast.cast_ray(Ray3d::new(top, Dir3::NEG_Y), &settings).first().map(|(_, h)| h.point);
    match s.phase {
        Phase::Loading => {
            s.waited += dt;
            let frame_now = frame.clone();
            // The first tiles in are coarse, and can lie metres off the tarmac that replaces them: the runway is
            // measured until its surface holds still, and the scenery has stopped refining (or it has held a while).
            let rwy = match s.start {
                Start::Runway => s.dep.as_mut(),
                Start::Final => s.arr.as_mut(),
                Start::Cruise => None,
            };
            let ready = match rwy {
                Some(rwy) => {
                    airport::measure(rwy, &frame_now, &mut ray, 7);
                    let mark = (rwy.offset, decoded.tiles);
                    let (stable, quiet) = &mut s.settled;
                    *stable = if rwy.measured && (mark.0 - s.settle_mark.0).abs() < 0.2 { *stable + dt } else { 0.0 };
                    *quiet = if mark.1 == s.settle_mark.1 { *quiet + dt } else { 0.0 };
                    s.settle_mark = mark;
                    s.waited > 3.0 && (s.settled.0 > 1.5 && s.settled.1 > 1.5 || s.settled.0 > 5.0)
                }
                None => s.waited > 3.0,
            };
            // The scenery may never answer (the sea, a tile server's hiccup): go anyway on the published elevation.
            if ready || s.waited > 25.0 {
                let e = spawn_aircraft(&mut commands, s, &frame, &mut pilot, &mut net, &asset_server);
                s.aircraft = Some(e);
                s.phase = Phase::Ready;
                s.waited = 0.0;
                let dep = s.dep.clone().unwrap();
                airport::spawn_lights(&mut commands, &light_assets, &dep);
                s.lights[0] = true;
            }
        }
        Phase::Flying => {
            // The destination runway's own surface, measured once its tiles are in (on the way in).
            s.measure_in -= dt;
            let Some(e) = s.aircraft else { return };
            let Ok((tf, _, _)) = vehicles.get(e) else { return };
            let (lat, lon, _) = frame.geodetic(tf.translation);
            let frame_now = frame.clone();
            let lights_on = s.lights;
            // Lined up: the departure runway's surface still measured, as the tiles around the aircraft refine (the
            // aircraft rides it up or down).
            let lined_up = s.touchdown.is_none() && vehicles.get(e).is_ok_and(|(_, _, ac)| ac.on_ground);
            if let Some(dep) = s.dep.as_mut().filter(|_| lined_up && s.measure_in <= 0.0) {
                if dep.ground_at(&frame_now, tf.translation).is_some() {
                    airport::measure(dep, &frame_now, &mut ray, 7);
                    s.measure_in = 0.5;
                }
            }
            if let Some(arr) = s.arr.as_mut() {
                // Measured again at 15, 6 and 2.5 km, as finer tiles come in.
                let d = nav::distance((lat, lon), arr.threshold());
                let band = [15_000.0, 6_000.0, 2_500.0].iter().filter(|b| d < **b).count() as u8;
                if band > s.arr_band {
                    s.arr_band = band;
                    arr.restart();
                }
                if band > 0 && s.measure_in <= 0.0 && arr.samples() < 21 {
                    airport::measure(arr, &frame_now, &mut ray, 7);
                    s.measure_in = 0.5;
                }
                if !lights_on[1] && airport::within_lights(arr, (lat, lon)) {
                    let arr = arr.clone();
                    airport::spawn_lights(&mut commands, &light_assets, &arr);
                    s.lights[1] = true;
                }
            }
        }
        _ => {}
    }
}

/// Time acceleration within what is safe to leave to the aircraft: 4× hand-flown, up to 16× on the autopilot above
/// 10,000 ft; 1× on the ground and on the approach.
fn allowed_rate(s: &Session, want: f32, vehicles: &Query<(&Transform, &Vehicle, &Aircraft), Without<Tiles3dCamera>>) -> f32 {
    let want = [1.0f32, 2.0, 4.0, 8.0, 16.0].into_iter().filter(|r| *r <= want.max(1.0)).last().unwrap_or(1.0);
    let Some((_, v, ac)) = s.aircraft.and_then(|e| vehicles.get(e).ok()) else { return 1.0 };
    if s.phase != Phase::Flying || ac.on_ground || v.agl < 300.0 {
        return 1.0;
    }
    let high = v.agl > 3_000.0;
    if s.af.fcu.ap && high { want } else { want.min(4.0) }
}

fn spawn_aircraft(commands: &mut Commands, s: &mut Session, frame: &Frame, pilot: &mut Pilot, net: &mut Net, asset_server: &AssetServer) -> Entity {
    let ty = s.ty;
    let asset = catalog::find(ty.id).unwrap_or(&catalog::ASSETS[0]);
    let dep = s.dep.clone().unwrap();
    let airborne = s.start != Start::Runway;
    let (pos, course, alt, speed) = match s.start {
        Start::Runway => (dep.along(dep.a.displaced.max(0.0) + 20.0), dep.course(), 0.0, 0.0),
        Start::Final => {
            let a = s.arr.as_ref().unwrap();
            let p = nav::destination(a.threshold(), a.course() + std::f64::consts::PI, 10.0 * NM);
            let vs = ty.vspeeds(ty.oew + s.fuel + s.payload, 0.0);
            (p, a.course(), a.surface_elev(0.0) + 10.0 * NM * nav::GLIDE.tan() + 15.0, types::tas_of(vs.vapp + 15.0, 1_000.0))
        }
        Start::Cruise => {
            let total: f64 = s.route.wpts.windows(2).map(|w| nav::distance(w[0].pos, w[1].pos)).sum();
            let p = s.route.point_at_dtg(total * 0.5).unwrap_or(dep.threshold());
            let next = s.route.point_at_dtg(total * 0.5 - 1_000.0).unwrap_or(p);
            let alt = s.route.cruise_ft / f64::from(FT);
            let tas = if ty.is_jet() { ty.cruise * physics::atmosphere(alt as f32).1 } else { ty.cruise / KT };
            (p, nav::bearing(p, next), alt, tas)
        }
    };
    let ground = match s.start {
        Start::Runway => dep.surface_elev(0.02),
        _ => alt,
    };
    let at = frame.from_ecef(airport::ecef(pos, ground));
    let yaw = -course as f32;
    let mut vehicle = Vehicle::new(asset, yaw, airborne);
    vehicle.vid = net.vid();
    vehicle.ground = if airborne { at.y - 1_000.0 } else { at.y };
    vehicle.ground_found = !airborne;
    vehicle.velocity = Quat::from_rotation_y(yaw) * Vec3::NEG_Z * speed;
    let mut ac = Aircraft::new(ty, s.fuel, s.payload, !airborne);
    match s.start {
        Start::Runway => {
            // Held on the parking brake until the thrust levers go up.
            ac.park = true;
            s.af.fcu.alt = s.route.cruise_ft as f32;
        }
        Start::Final => {
            ac.flap_lever = ty.flaps_landing;
            ac.flap = ty.flaps_landing as f32;
            ac.gear_lever = true;
            ac.gear = 1.0;
            ac.spoilers_armed = ty.spoiler_cd > 0.0;
            ac.autobrake = if ty.autobrake { 1 } else { 0 };
            ac.lever = 0.45;
            ac.n1 = 0.6;
            s.af.fcu.ap = true;
            s.af.fcu.appr = true;
            s.af.fcu.loc = true;
            s.af.fcu.alt = (s.arr.as_ref().unwrap().a.elev_ft + 3_000.0).round() as f32;
            s.af.lat_armed = Some(autoflight::Lat::LocStar);
            s.af.lat = autoflight::Lat::Hdg;
            s.af.fcu.hdg = (course.to_degrees() as f32).rem_euclid(360.0);
            s.af.vert = autoflight::Vert::Vs;
            s.af.fcu.vs = -700.0;
            s.af.thr = autoflight::Thr::Speed;
            s.route.active = s.route.wpts.len().saturating_sub(1).max(1);
        }
        Start::Cruise => {
            ac.lever = 0.75;
            ac.n1 = 0.85;
            s.af.fcu.ap = true;
            s.af.lat = autoflight::Lat::Nav;
            s.af.vert = autoflight::Vert::Alt;
            s.af.fcu.alt = s.route.cruise_ft as f32;
            s.af.thr = autoflight::Thr::Mach;
            // The leg the aircraft is on.
            let total: f64 = s.route.wpts.windows(2).map(|w| nav::distance(w[0].pos, w[1].pos)).sum();
            let mut run = 0.0;
            for (i, w) in s.route.wpts.windows(2).enumerate() {
                run += nav::distance(w[0].pos, w[1].pos);
                if run >= total * 0.5 {
                    s.route.active = i + 1;
                    break;
                }
            }
        }
    }
    if ty.id == "glider" {
        ac.lever = 0.0; ac.n1 = 0.0; s.af.fcu.ap = false; s.af.fcu.athr = false;
    }
    let model = asset_server.load(GltfAssetLabel::Scene(0).from_asset(asset.model()));
    let e = commands
        .spawn((Transform::from_translation(at).with_rotation(Quat::from_rotation_y(yaw)), Visibility::default(), vehicle, ac))
        .with_children(|c| {
            // glTF noses point along +Z, Bevy's forward is −Z.
            c.spawn((WorldAssetRoot(model), Transform::from_rotation(Quat::from_rotation_y(std::f32::consts::PI))));
        })
        .id();
    pilot.vehicle = Some(e);
    pilot.view = View::Cockpit;
    pilot.yaw = yaw;
    pilot.pitch = -0.05;
    pilot.orbit = Vec2::ZERO;
    e
}

// ---- flying -------------------------------------------------------------------------------------------------------

/// Keys of the flight deck (on top of the sandbox's stick, rudder and throttle keys): flaps F5–F8, gear G, brakes `.`
/// (Ctrl: parking brake), throttle F1 idle / F2 less (held on the
/// ground: reverse) / F3 more / F4 take-off, autobrake 0–3, trim `[` `]`, autopilot Z (Shift: autothrust), sim rate
/// `-` `=`.
#[allow(clippy::too_many_arguments)]
fn flight_keys(keys: &ButtonInput<KeyCode>, pad: &Pad, throttle: f32, s: &mut Session, ac: &mut Aircraft, v: &mut Vehicle, pilot: &mut Pilot, sense: &Sense, dt: f32) {
    let shift = keys.pressed(KeyCode::ShiftLeft) || keys.pressed(KeyCode::ShiftRight);
    let ctrl = keys.pressed(KeyCode::ControlLeft) || keys.pressed(KeyCode::ControlRight);
    let ty = ac.ty;
    let flaps_max = ty.flaps.len() - 1;
    let say = |p: &mut Pilot, t: String| p.say(t);
    let flap = |ac: &mut Aircraft, to: usize, p: &mut Pilot| {
        if to != ac.flap_lever {
            ac.flap_lever = to;
            p.say(format!("FLAPS {}", ac.ty.flaps[to].label));
        }
    };
    if keys.just_pressed(KeyCode::F5) {
        flap(ac, 0, pilot);
    }
    // The controller: its alternate button steps the flaps down, with boost held up.
    if keys.just_pressed(KeyCode::F6) || pad.pressed("alt") && pad.boost {
        flap(ac, ac.flap_lever.saturating_sub(1), pilot);
    }
    if keys.just_pressed(KeyCode::F7) || pad.pressed("alt") && !pad.boost {
        flap(ac, (ac.flap_lever + 1).min(flaps_max), pilot);
    }
    if keys.just_pressed(KeyCode::F8) {
        flap(ac, flaps_max, pilot);
    }
    if (keys.just_pressed(KeyCode::KeyG) || pad.pressed("action")) && ty.gear_retracts {
        if ac.on_ground && ac.gear_lever {
            say(pilot, "GEAR: WEIGHT ON WHEELS".into());
        } else {
            ac.gear_lever = !ac.gear_lever;
            say(pilot, if ac.gear_lever { "GEAR DOWN".into() } else { "GEAR UP".into() });
        }
    }
    ac.brakes = if keys.pressed(KeyCode::Period) && !ctrl || keys.pressed(KeyCode::KeyB) || pad.brake { 1.0 } else { 0.0 };
    if keys.just_pressed(KeyCode::Period) && ctrl {
        ac.park = !ac.park;
        say(pilot, if ac.park { "PARKING BRAKE SET".into() } else { "PARKING BRAKE RELEASED".into() });
    }
    if ty.autobrake {
        for (key, mode) in [(KeyCode::Digit0, 0u8), (KeyCode::Digit1, 1), (KeyCode::Digit2, 2), (KeyCode::Digit3, 3)] {
            if keys.just_pressed(key) {
                ac.autobrake = mode;
                ac.autobrake_on = false;
                say(pilot, ["AUTOBRAKE OFF", "AUTOBRAKE LO", "AUTOBRAKE MED", "AUTOBRAKE MAX"][mode as usize].into());
            }
        }
    }
    if ty.law == Law::Direct {
        let trim = f32::from(u8::from(keys.pressed(KeyCode::BracketRight))) - f32::from(u8::from(keys.pressed(KeyCode::BracketLeft)));
        ac.trim = (ac.trim + trim * 0.03 * dt).clamp(-0.05, 0.2);
    }
    // Thrust levers (W/S and the controller's triggers move them in `read_controls`). Moving them takes the autothrust
    // off, as pulling them out of its detent would.
    let mut lever = throttle;
    let mut moved = false;
    if keys.just_pressed(KeyCode::F1) {
        lever = 0.0;
        moved = true;
    }
    if keys.pressed(KeyCode::F3) {
        lever += 0.4 * dt;
        moved = true;
    }
    if keys.just_pressed(KeyCode::F4) {
        lever = 1.0;
        moved = true;
    }
    let reverse = keys.pressed(KeyCode::F2) && ac.on_ground && lever < 0.05;
    if keys.pressed(KeyCode::F2) && !reverse {
        lever -= 0.4 * dt;
        moved = true;
    }
    if reverse != ac.reverse {
        ac.reverse = reverse;
        if reverse {
            say(pilot, "REVERSE".into());
        }
    }
    if keys.pressed(KeyCode::KeyW) || keys.pressed(KeyCode::KeyS) {
        moved = true;
    }
    v.throttle = lever.clamp(0.0, 1.0);
    if ac.park && ac.on_ground && v.throttle > 0.5 {
        ac.park = false;
        say(pilot, "PARKING BRAKE RELEASED".into());
    }
    if moved && s.af.fcu.athr && !sense.on_ground && matches!(s.af.thr, autoflight::Thr::Speed | autoflight::Thr::Mach | autoflight::Thr::Clb | autoflight::Thr::Idle) {
        s.af.fcu.athr = false;
        s.af.thr = autoflight::Thr::Off;
        say(pilot, "A/THR OFF".into());
    }
    if keys.just_pressed(KeyCode::KeyZ) {
        let what = if shift { "athr" } else { "ap" };
        let has_route = s.route.wpts.len() > 1;
        s.af.command(&json!({ "fcu": what }), sense, has_route, ty);
        say(pilot, match what {
            "ap" if s.af.fcu.ap => "AP1 ON".into(),
            "ap" => "AP OFF".into(),
            _ if s.af.fcu.athr => "A/THR ON".into(),
            _ => "A/THR OFF".into(),
        });
    }
    if keys.just_pressed(KeyCode::Equal) || keys.just_pressed(KeyCode::Minus) {
        let up = keys.just_pressed(KeyCode::Equal);
        let want = if up { s.rate * 2.0 } else { s.rate / 2.0 };
        s.rate = want.clamp(1.0, 16.0);
        say(pilot, format!("SIM RATE {}×", s.rate));
    }
}

/// The flight's aircraft: its systems and flight model, the autoflight, the guidance, and the state for the cockpit.
#[allow(clippy::too_many_arguments)]
fn fly(
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    pad: Res<Pad>,
    mut pilot: ResMut<Pilot>,
    settings: Res<Settings>,
    c: Res<Controls>,
    frame: Res<Frame>,
    weather: Res<Weather>,
    mut s: ResMut<Session>,
    mut hud: ResMut<HudOut>,
    mut vehicles: Query<(Entity, &mut Transform, &mut Vehicle, &mut Aircraft)>,
) {
    let s = &mut *s;
    let Some(e) = s.aircraft else {
        hud.0 = if s.phase == Phase::Loading {
            let place = if s.start == Start::Final { s.arr.as_ref() } else { s.dep.as_ref() };
            json!({ "phase": "loading", "waited": s.waited, "place": place.map(|r| format!("{} · RUNWAY {}", r.icao, r.a.ident)) })
        } else {
            Value::Null
        };
        return;
    };
    let Ok((_, mut tf, mut v, mut ac)) = vehicles.get_mut(e) else {
        // Not spawned yet (the commands apply after this frame), or the wreck is gone.
        if s.phase == Phase::Flying {
            s.phase = Phase::Crashed;
        }
        hud.0 = if s.phase == Phase::Crashed { json!({ "phase": "crashed", "report": s.report, "notes": s.notes }) } else { json!({ "phase": "loading" }) };
        return;
    };
    let ty = ac.ty;
    let dt = time.delta_secs().min(4.0);
    let (min, _) = v.bounds();
    // The runway under the wheels, if any: a flat surface instead of the mesh. Where the mesh below is not loaded
    // (out of view), the nearer airport's elevation stands in for the ground.
    let (lat, lon, _) = frame.geodetic(tf.translation);
    let rwy_ground = [s.dep.as_ref(), s.arr.as_ref()].into_iter().flatten().find_map(|r| r.ground_at(&frame, tf.translation));
    let nearest = [s.dep.as_ref(), s.arr.as_ref()].into_iter().flatten().min_by(|a, b| nav::distance((lat, lon), a.a.pos).total_cmp(&nav::distance((lat, lon), b.a.pos)));
    let fallback = nearest.map_or(v.ground, |r| frame.from_ecef(airport::ecef((lat, lon), r.surface_elev(0.0))).y);
    let ground = rwy_ground.unwrap_or(if v.ground_found { v.ground } else { fallback });
    // Off it, the mesh only where the rays found it below (`probe_ground`): out of view the tiles there are not loaded,
    // and the height last found elsewhere is nothing to touch down on, nor to measure a radio altitude from.
    let touchable = rwy_ground.is_some() || v.ground_found || ac.on_ground;

    // Ready: once the model's size is known, sit it on its wheels (it waits where it appeared until then).
    if s.phase == Phase::Ready {
        s.waited += time.delta_secs();
        if v.bounds.is_none() && s.waited < 8.0 {
            hud.0 = json!({ "phase": "loading" });
            return;
        }
        if ac.on_ground {
            tf.translation.y = ground - min.y;
        }
        s.phase = Phase::Flying;
        s.flight_time = 0.0;
        let (icao, rwy) = s.dep.as_ref().map_or_else(Default::default, |r| (r.icao.clone(), r.a.ident.clone()));
        s.note(format!("{} READY · {icao} {rwy}", ty.label));
        pilot.say(if ac.on_ground { format!("RUNWAY {rwy} · LINED UP") } else { "YOU HAVE CONTROL".into() });
    }
    if v.destroyed.is_some() {
        return;
    }

    // Where it is.
    let alt = frame.altitude(tf.translation);
    // The weather's wind is the surface wind: stronger higher up (a log profile through the boundary layer), and
    // gusty near the ground (random turbulence, filtered to gusts of a few seconds, stronger with the wind and with
    // the reported gusts).
    let height = (tf.translation.y + min.y - ground).max(0.0);
    let profile = ((height + 1.0) / 0.1).ln() / (10.0f32 / 0.1).ln();
    let surface = weather.wind();
    let sigma = (0.12 * surface.length() + 0.12 * s.gust_kt / KT + 0.3) * (1.0 - (height / 1_500.0).clamp(0.0, 0.7));
    let mut noise = || {
        s.rng ^= s.rng << 13;
        s.rng ^= s.rng >> 17;
        s.rng ^= s.rng << 5;
        s.rng as f32 / u32::MAX as f32 * 2.0 - 1.0
    };
    // First order, 2.5 s: the gust keeps a standard deviation of `sigma` whatever the frame rate.
    let (dt_g, tau) = (time.delta_secs().min(0.25), 2.5);
    let kick = Vec3::new(noise(), noise() * 0.5, noise()) * sigma * (3.0 * 2.0 * dt_g / tau).sqrt();
    s.gust += -s.gust * (dt_g / tau) + kick;
    let wind = surface * profile.clamp(0.5, 1.8) + s.gust;
    let air = v.velocity - wind;
    let tas = air.length();
    let mach = tas / physics::atmosphere(alt).1;
    // The radio altitude over unseen ground reads from the nearer airport's elevation (what the flare, the callouts and
    // the warnings need on an approach); the flight model still only touches ground that was found.
    let ra = (tf.translation.y + min.y - if touchable { ground } else { fallback }).max(0.0);
    let speed = v.velocity.length();
    if dt > 0.0 {
        let a = (speed - s.last_speed) / dt;
        s.accel += (a - s.accel) * (dt * 2.0).min(1.0);
    }
    s.last_speed = speed;
    let fpa = if speed > 1.0 { (v.velocity.y / speed).clamp(-1.0, 1.0).asin() } else { 0.0 };
    let (pitch, bank) = physics::attitude(tf.rotation);
    let track = if v.velocity.with_y(0.0).length() > 2.0 { v.velocity.x.atan2(-v.velocity.z).rem_euclid(std::f32::consts::TAU) } else { heading_of(tf.rotation) };
    let sense = Sense {
        ias: ac.eas * KT,
        tas,
        mach,
        alt: alt * FT,
        vs: v.velocity.y * FT * 60.0,
        ra: ra * FT,
        fpa,
        track,
        heading: heading_of(tf.rotation),
        bank,
        pitch,
        alpha: v.air.alpha,
        alpha_stall: ac.alpha_stall(),
        accel: s.accel,
        on_ground: ac.on_ground,
        lever: ac.lever,
    };

    // The pilot's hands, or nobody's (out of the aircraft: hands off, the fly-by-wire holds the path).
    let flown = pilot.vehicle == Some(e) && c.vehicle == Some(e) && !settings.menu_open;
    if flown {
        flight_keys(&keys, &pad, c.stick.throttle, s, &mut ac, &mut v, &mut pilot, &sense, time.delta_secs());
    }
    let pending = std::mem::take(&mut s.pending);
    let has_route = s.route.wpts.len() > 1;
    for cmd in pending {
        if cmd.get("fcu").and_then(Value::as_str) == Some("dirto") {
            // Direct to a waypoint of the plan, from here.
            if let Some(target) = cmd.get("index").and_then(Value::as_u64).map(|i| i as usize).filter(|i| *i < s.route.wpts.len()) {
                // The turning point replaces any earlier one.
                let id = s.route.wpts[target].id.clone();
                s.route.wpts.retain(|w| w.id != "T-P");
                let i = s.route.wpts.iter().position(|w| w.id == id).unwrap_or(target.min(s.route.wpts.len() - 1));
                s.route.wpts.insert(i, Waypoint { id: "T-P".into(), pos: (lat, lon), alt: None, kind: nav::Kind::Fix });
                s.route.active = i + 1;
                if s.af.lat == autoflight::Lat::Hdg || s.af.lat == autoflight::Lat::Off {
                    s.af.lat = autoflight::Lat::Nav;
                }
                pilot.say(format!("DIRECT {}", s.route.wpts[i + 1].id));
            }
        } else if cmd.get("type").and_then(Value::as_str) == Some("fcu") {
            s.af.command(&cmd, &sense, has_route, ty);
        } else {
            systems_command(&cmd, &mut ac, &mut pilot, &mut s.gust_kt);
        }
    }
    let mut input = if flown { Input { pitch: c.stick.pitch, roll: c.stick.roll, yaw: c.stick.yaw, tiller: c.stick.yaw } } else { Input::default() };
    if flown && (c.stick.pitch.abs() > 0.5 || c.stick.roll.abs() > 0.5) && s.af.fcu.ap {
        s.af.disconnect_ap("AP OFF · OVERRIDE");
        pilot.say("AUTOPILOT DISCONNECTED");
    }

    // Guidance: the plan's leg, the destination's ILS, the managed speed and path.
    let lnav = s.route.lnav((lat, lon), f64::from(v.velocity.with_y(0.0).length()));
    let arr_elev = s.arr.as_ref().map_or(0.0, |r| r.a.elev_ft);
    let ils = s.arr.as_ref().map(|r| nav::ils(r, (lat, lon), f64::from(alt)));
    let dtg = lnav.map(|l| l.dtg);
    let tod = s.route.tod_dtg(arr_elev);
    let descending = dtg.is_some_and(|d| d < tod);
    let path = if descending { dtg.map(|d| s.route.path_ft(d, arr_elev) as f32) } else { None };
    let gs_kt = v.velocity.with_y(0.0).length() * KT;
    let path_vs = dtg.map_or(0.0, |d| -(s.route.path_slope(d, arr_elev) as f32) * gs_kt / 60.0);
    let mass = ac.mass();
    let headwind = s.arr.as_ref().map_or(0.0, |r| {
        let crs = r.course() as f32;
        let dir = Vec3::new(crs.sin(), 0.0, -crs.cos());
        -wind.dot(dir) * KT
    });
    s.vspeeds = ty.vspeeds(mass, headwind.max(0.0));
    let vs = s.vspeeds;
    let mut managed = managed_speed(ty, &sense, descending, dtg, &vs, s.route.cruise_ft as f32);
    // Never faster than the flaps and the gear allow.
    let limit = if ac.flap_lever > 0 { ty.flaps[ac.flap_lever].vfe - 5.0 } else { ty.vmo - 10.0 };
    managed.speed = managed.speed.min(if ac.gear > 0.01 && ty.gear_retracts { limit.min(245.0) } else { limit });
    // Going around: flown past the runway without landing, or take-off thrust (F4) on the approach.
    let past = ils.is_some_and(|i| i.dist < -300.0);
    let toga = flown && keys.just_pressed(KeyCode::F4) && dtg.is_some_and(|d| d < 20.0 * NM);
    if ty.id != "glider" && !ac.on_ground && s.touchdown.is_none() && !s.go_around && (past && sense.ra > 100.0 || toga) && s.arr.is_some() {
        let arr = s.arr.clone().unwrap();
        s.route.go_around(&arr, (lat, lon));
        let alt = (arr.a.elev_ft + s.route.intercept_ft) as f32;
        s.af.go_around(&sense, true, (alt / 100.0).round() * 100.0);
        s.go_around = true;
        s.climb = guide::Climb { from_ft: f64::from(sense.alt), at_m: 0.0, top_ft: f64::from(alt) };
        s.touchdown = None;
        ac.lever = 1.0;
        v.throttle = 1.0;
        ac.flap_lever = ac.flap_lever.saturating_sub(1).max(ty.flaps_takeoff);
        ac.speedbrake = 0.0;
        s.note("GO AROUND");
        pilot.say("GO AROUND · FLAPS");
    }
    if s.go_around && matches!(s.af.vert, autoflight::Vert::Gs) {
        s.go_around = false;
    }
    let runway_course = s.dep.as_ref().map(|r| r.course() as f32);
    if s.assist && s.phase == Phase::Flying {
        copilot(s, &mut ac, &mut pilot, &sense, dtg, tod, arr_elev, path);
    }
    // The approach speed, but never under the lowest selectable speed of the flaps set now.
    let vapp = vs.vapp.max(ty.vs1g(mass, ac.flap_lever) * 1.23 + 5.0);
    let out = s.af.update(ty, &sense, &Managed { path, path_vs, ..managed }, lnav.as_ref(), ils.as_ref().filter(|i| i.loc_valid || ac.on_ground), vapp, vs.v2, runway_course, dt);
    if let Some(i) = out.input {
        input = Input { tiller: i.yaw, ..i };
    }
    ac.lever = out.lever.unwrap_or(v.throttle);
    if out.lever.is_some() {
        v.throttle = ac.lever;
    }
    // Reverse thrust on the reversers' own lever travel.
    if ac.reverse {
        ac.lever = 0.8;
    }

    // The flight model, in steps of at most 20 ms (more of them at a higher sim rate).
    let env = Env { wind, alt, ground: if touchable { ground } else { tf.translation.y + min.y - UNSEEN_BELOW }, bottom: min.y };
    let steps = (dt / 0.02).ceil().clamp(1.0, 240.0) as u32;
    let (mut velocity, mut omega) = (v.velocity, v.omega);
    let mut air_data = AirData::default();
    for _ in 0..steps {
        air_data = model::step(&mut ac, &mut tf, &mut velocity, &mut omega, input, env, dt / steps as f32);
        if ac.events.iter().any(|e| matches!(e, Event::Crash(_))) {
            break;
        }
    }
    if ac.reverse {
        ac.lever = 0.0;
    }
    v.velocity = velocity;
    v.omega = omega;
    v.air = air_data;
    v.surfaces = air_data.surfaces;
    v.gear_down = ac.gear > 0.5;
    v.on_ground = ac.on_ground;
    v.agl = (tf.translation.y + min.y - ground).max(0.0);
    v.rotor_rate = if matches!(ty.engine, types::Engine::Prop { .. }) { ac.n1 * 250.0 } else { 20.0 + 60.0 * ac.n1 };
    s.flight_time += dt;
    s.distance += v.velocity.with_y(0.0).length() * dt;
    s.fuel = ac.fuel;

    // What happened.
    for event in std::mem::take(&mut ac.events) {
        match event {
            Event::Liftoff => {
                s.note("LIFTOFF");
                if ty.spoiler_cd > 0.0 {
                    ac.spoilers_armed = false;
                }
                ac.autobrake = 0;
            }
            Event::TailStrike => {
                s.note("TAIL STRIKE");
                pilot.say("TAIL STRIKE");
            }
            Event::Crash(why) => {
                v.destroyed = Some(why);
                s.phase = Phase::Crashed;
                s.report = Some(json!({ "crash": why, "sink": -velocity.y * FT * 60.0, "ias": ac.eas * KT }));
                s.note(why);
            }
            Event::Touchdown { sink, bank, pitch, crab, ias } => {
                let at = [s.arr.as_ref(), s.dep.as_ref()].into_iter().flatten().find(|r| r.ground_at(&frame, tf.translation).is_some());
                let (xtk, past) = at.map_or((0.0, 0.0), |r| {
                    let (x, along) = nav::cross_track(r.a.pos, r.b.pos, (lat, lon));
                    (x, along - r.a.displaced)
                });
                let fpm = sink * FT * 60.0;
                let grade = match fpm {
                    f if f < 60.0 => "BUTTER",
                    f if f < 180.0 => "SMOOTH",
                    f if f < 360.0 => "FIRM",
                    f if f < 600.0 => "HARD",
                    _ => "VERY HARD",
                };
                let long = if past > 300.0 && past < 750.0 { 0.0 } else { ((past - 525.0).abs() - 225.0).max(0.0) / 15.0 };
                let score = (100.0 - ((fpm - 120.0).max(0.0) / 6.0) - xtk.abs() as f32 * 2.0 - long as f32 - crab.abs().to_degrees() * 3.0 - bank.abs().to_degrees() * 4.0).clamp(0.0, 100.0);
                let report = json!({
                    "runway": at.map(|r| format!("{} {}", r.icao, r.a.ident)), "sink": fpm, "grade": grade, "score": score.round(),
                    "ias": ias, "bank": bank.to_degrees(), "pitch": pitch.to_degrees(), "crab": crab.to_degrees(),
                    "past": past, "offCentre": xtk, "onRunway": at.is_some(),
                });
                s.note(format!("TOUCHDOWN {fpm:.0} FPM · {grade}"));
                if s.touchdown.is_none() {
                    s.touchdown = Some(report);
                }
            }
        }
    }
    // Stopped on the runway after a landing: the report.
    if s.phase == Phase::Flying && ac.on_ground && s.touchdown.is_some() && speed < 2.0 {
        s.phase = Phase::Landed;
        let mut r = s.touchdown.clone().unwrap();
        r["flightTime"] = json!(s.flight_time);
        r["distance"] = json!(s.distance / 1_852.0);
        r["fuelUsed"] = json!(ac.burned);
        s.report = Some(r);
        pilot.say("LANDED · PARKING BRAKE SET");
        ac.park = true;
    }
    if s.phase == Phase::Landed && speed > 3.0 {
        // Taxiing on (or taking off again).
        s.phase = Phase::Flying;
        s.touchdown = None;
    }

    hud.0 = flight_hud(&s, &ac, &v, &sense, ra, ground, (lat, lon), lnav.as_ref(), ils.as_ref(), tod, dtg, path, wind, mass, headwind);
}

/// The copilot's part, as a crew shares the work: after take-off the gear up and the flaps up on schedule; at the top
/// of descent, the descent (a lower altitude selected and pushed, as cleared); on the way in, the approach armed and
/// the aircraft configured — flaps as it slows, the gear and the ground spoilers, the autobrake. The pilot flies (or
/// the autopilot does) and can always move a lever back.
fn copilot(s: &mut Session, ac: &mut Aircraft, pilot: &mut Pilot, sense: &Sense, dtg: Option<f64>, tod: f64, arr_elev: f64, path_alt: Option<f32>) {
    let ty = ac.ty;
    let vs = s.vspeeds;
    let nm = dtg.map_or(f64::INFINITY, |d| d / NM);
    let call = |p: &mut Pilot, what: String| p.say(what);
    if ac.on_ground {
        return;
    }
    let climbing = sense.vs > 300.0 && s.touchdown.is_none() && (nm > 30.0 || s.go_around);
    // After take-off: positive climb, gear up; flaps up at their speeds.
    if climbing && ty.gear_retracts && ac.gear_lever && sense.ra > 80.0 {
        ac.gear_lever = false;
        call(pilot, "POSITIVE CLIMB · GEAR UP".into());
    }
    if climbing && sense.ra > 800.0 && ac.flap_lever > 0 {
        let up_at = if ac.flap_lever >= 2 { vs.f_speed } else { vs.s_speed };
        if sense.ias > up_at || ty.panel == "ga" && sense.ra > 1_000.0 {
            ac.flap_lever -= 1;
            call(pilot, format!("FLAPS {}", ty.flaps[ac.flap_lever].label));
        }
    }
    // The top of descent: down to the approach altitude, managed.
    let approach_alt = (((arr_elev + s.route.intercept_ft) / 100.0).round() * 100.0) as f32;
    if s.af.fcu.ap && nm * NM < tod + 1_000.0 && nm < 400.0 && matches!(s.af.vert, autoflight::Vert::Alt | autoflight::Vert::AltStar) && sense.alt > approach_alt + 1_500.0 {
        s.af.fcu.alt = approach_alt;
        s.af.command(&json!({ "fcu": "altPush" }), sense, true, ty);
        call(pilot, format!("T/D · DESCENDING TO {approach_alt:.0}"));
    }
    // High and fast on the descent path: the speed brake, until back on it.
    if ty.spoiler_cd > 0.0 && s.af.vert == autoflight::Vert::Des {
        if let Some(path) = path_alt {
            let fast = sense.ias > s.af.target_speed + 10.0;
            if !s.copilot_brake && sense.alt > path + 500.0 && fast {
                s.copilot_brake = true;
                ac.speedbrake = 1.0;
                call(pilot, "SPEED BRAKE".into());
            } else if s.copilot_brake && (sense.alt < path + 100.0 || !fast) {
                s.copilot_brake = false;
                ac.speedbrake = 0.0;
            }
        }
    } else if s.copilot_brake {
        s.copilot_brake = false;
        ac.speedbrake = 0.0;
    }
    // The approach: armed inside 25 NM.
    if s.af.fcu.ap && nm < 25.0 && !s.af.fcu.appr && s.arr.is_some() {
        s.af.command(&json!({ "fcu": "appr" }), sense, true, ty);
        call(pilot, "APPR ARMED".into());
    }
    // Configuration on the way in: each flap setting below its placard speed and as the distance closes (a light
    // aircraft's in its own way), the gear by 9 NM, the ground spoilers and the autobrake with the gear.
    if nm < 22.0 && s.touchdown.is_none() {
        let last = ty.flaps.len() - 1;
        let want = if ty.panel == "ga" {
            if nm < 3.0 { last } else if nm < 6.0 { 2.min(last) } else { 1.min(last) }
        } else {
            [(20.0, 1), (15.0, 2), (8.0, 3), (5.5, 5)].iter().filter(|(d, _)| nm < *d).map(|(_, f)| *f).max().unwrap_or(0).min(last)
        };
        let next = ac.flap_lever + 1;
        if want > ac.flap_lever && sense.ias < ty.flaps[next].vfe - 8.0 {
            ac.flap_lever = next;
            call(pilot, format!("FLAPS {}", ty.flaps[next].label));
        }
        if ty.gear_retracts && !ac.gear_lever && (nm < 9.0 || matches!(s.af.vert, autoflight::Vert::Gs | autoflight::Vert::GsStar)) {
            ac.gear_lever = true;
            call(pilot, "GEAR DOWN".into());
        }
        if ac.gear_lever && ty.spoiler_cd > 0.0 && !ac.spoilers_armed {
            ac.spoilers_armed = true;
            ac.speedbrake = 0.0;
        }
        if ty.autobrake && ac.autobrake == 0 {
            ac.autobrake = 2;
        }
    }
}

/// Panel commands for the aircraft's systems (the cockpit's levers and switches, `{type: "fsys", …}`).
fn systems_command(cmd: &Value, ac: &mut Aircraft, pilot: &mut Pilot, gust_kt: &mut f32) {
    let n = |k: &str| cmd.get(k).and_then(Value::as_f64).map(|v| v as f32);
    match cmd.get("sys").and_then(Value::as_str) {
        Some("flaps") => {
            if let Some(i) = n("value") {
                ac.flap_lever = (i as usize).min(ac.ty.flaps.len() - 1);
                pilot.say(format!("FLAPS {}", ac.ty.flaps[ac.flap_lever].label));
            }
        }
        Some("gear") => {
            if !(ac.on_ground && ac.gear_lever) && ac.ty.gear_retracts {
                ac.gear_lever = !ac.gear_lever;
            }
        }
        Some("speedbrake") => ac.speedbrake = n("value").unwrap_or(0.0).clamp(0.0, 1.0),
        // The speed brake key (`/`, which flight.js takes from the page's search).
        Some("speedbrakeToggle") if ac.ty.spoiler_cd > 0.0 => {
            ac.speedbrake = if ac.speedbrake > 0.1 { 0.0 } else { 1.0 };
            pilot.say(if ac.speedbrake > 0.1 { "SPEED BRAKE" } else { "SPEED BRAKE RETRACTED" });
        }
        Some("arm") if ac.ty.spoiler_cd > 0.0 => {
            ac.spoilers_armed = !ac.spoilers_armed;
            ac.speedbrake = 0.0;
            pilot.say(if ac.spoilers_armed { "GROUND SPOILERS ARMED" } else { "SPOILERS DISARMED" });
        }
        Some("autobrake") => ac.autobrake = n("value").unwrap_or(0.0).clamp(0.0, 3.0) as u8,
        Some("park") => ac.park = !ac.park,
        Some("trim") => ac.trim = (ac.trim + n("value").unwrap_or(0.0)).clamp(-0.05, 0.2),
        Some("gust") => *gust_kt = n("value").unwrap_or(0.0).clamp(0.0, 60.0),
        _ => {}
    }
}

/// The speed the flight management would fly now (kt, and Mach up high): 250 kt below 10,000 ft, the type's climb
/// and descent speeds (Mach above the crossover), the cruise Mach, slowing for the approach.
fn managed_speed(ty: &Type, s: &Sense, descending: bool, dtg: Option<f64>, vs: &VSpeeds, cruise_ft: f32) -> Managed {
    let near = dtg.map_or(f64::INFINITY, |d| d / NM);
    let low_limit = if ty.panel == "ga" { f32::INFINITY } else { 250.0 };
    let ias = if descending || near < 40.0 {
        if near < 12.0 {
            vs.green_dot.max(vs.vref + 30.0).min(180.0)
        } else if near < 25.0 {
            (vs.green_dot + 10.0).min(220.0)
        } else if s.alt < 10_500.0 {
            ty.descent_kt.min(low_limit)
        } else {
            ty.descent_kt
        }
    } else if s.alt < 10_000.0 && s.alt < cruise_ft - 500.0 {
        ty.climb_kt.min(low_limit)
    } else if s.alt >= cruise_ft - 500.0 {
        if ty.is_jet() { ty.climb_kt } else { types::ias_kt(ty.cruise / KT, s.alt / FT) }
    } else {
        ty.climb_kt
    };
    // Mach above the crossover altitude, where the climb speed would exceed the cruise Mach.
    let mach = if ty.is_jet() && s.mach > 0.1 {
        let at_ias = s.mach * ias / s.ias.max(1.0);
        (at_ias > ty.cruise || s.alt > cruise_ft - 500.0 && !descending).then_some(ty.cruise.min(if descending { ty.cruise - 0.02 } else { ty.cruise }))
    } else {
        None
    };
    Managed { speed: ias, mach, path: None, path_vs: 0.0 }
}

#[allow(clippy::too_many_arguments)]
fn flight_hud(
    s: &Session,
    ac: &Aircraft,
    v: &Vehicle,
    sense: &Sense,
    ra: f32,
    _ground: f32,
    pos: nav::LatLon,
    lnav: Option<&nav::Lnav>,
    ils: Option<&nav::Ils>,
    tod: f64,
    dtg: Option<f64>,
    path: Option<f32>,
    wind: Vec3,
    mass: f32,
    headwind: f32,
) -> Value {
    let ty = ac.ty;
    let phase = match s.phase {
        Phase::Idle => "idle",
        Phase::Loading | Phase::Ready => "loading",
        Phase::Flying if ac.on_ground && s.touchdown.is_none() => "takeoff",
        Phase::Flying if ac.on_ground => "rollout",
        Phase::Flying if dtg.is_some_and(|d| d < 15.0 * NM) => "approach",
        Phase::Flying if dtg.is_some_and(|d| d < tod) => "descent",
        Phase::Flying if (sense.alt - s.route.cruise_ft as f32).abs() < 500.0 => "cruise",
        Phase::Flying => "climb",
        Phase::Landed => "landed",
        Phase::Crashed => "crashed",
    };
    let wind_speed = wind.with_y(0.0).length();
    let wind_from = if wind_speed > 0.1 { (-wind.x).atan2(wind.z).to_degrees().rem_euclid(360.0) } else { 0.0 };
    let vs = s.vspeeds;
    let flap = &ty.flaps[ac.flap_lever];
    let next_vfe = ty.flaps.get(ac.flap_lever + 1).map(|f| f.vfe);
    let vmax = if ac.flap_lever > 0 { flap.vfe } else { ty.vmo.min(if sense.mach > 0.1 { ty.mmo / sense.mach * sense.ias } else { ty.vmo }) };
    let vmax = if ac.gear > 0.01 && ty.gear_retracts { vmax.min(280.0) } else { vmax };
    let (engine_n1, egt, rpm) = match ty.engine {
        types::Engine::Glider => (0.0, 0.0, 0.0),
        types::Engine::Fan { .. } => (ac.n1 * 100.0, ac.egt, 0.0),
        types::Engine::Prop { max_rpm, .. } => (0.0, ac.egt, ac.n1 * max_rpm),
    };
    let engines = match ty.engine {
        types::Engine::Glider => 0,
        types::Engine::Fan { count, .. } => count,
        _ => 1,
    };
    let warnings = warnings(s, ac, v, sense, ra, vmax);
    let arr = s.arr.as_ref();
    json!({
        "phase": phase, "type": ty.id, "label": ty.label, "panel": ty.panel, "law": if ty.law == Law::FlyByWire { "fbw" } else { "direct" },
        "ias": sense.ias, "tas": sense.tas * KT, "gs": v.velocity.with_y(0.0).length() * KT, "mach": sense.mach,
        "alt": sense.alt, "vs": sense.vs, "ra": ra * FT, "hdg": sense.heading.to_degrees(), "trk": sense.track.to_degrees(),
        "pitch": sense.pitch.to_degrees(), "bank": sense.bank.to_degrees(), "fpa": sense.fpa.to_degrees(), "alpha": v.air.alpha.to_degrees(),
        "beta": v.air.beta.to_degrees(), "g": v.air.g, "accel": s.accel * KT, "onGround": ac.on_ground,
        "lat": pos.0, "lon": pos.1,
        "wind": { "from": wind_from, "kt": wind_speed * KT, "head": headwind },
        "eng": { "count": engines, "n1": engine_n1, "rpm": rpm, "egt": egt, "ff": ac.ff * 3_600.0, "lever": ac.lever, "rev": ac.rev, "thrust": ac.thrust },
        "fuel": ac.fuel, "gw": mass, "mtow": ty.mtow,
        "flap": { "lever": ac.flap_lever, "label": flap.label, "pos": ac.flap, "max": ty.flaps.len() - 1, "labels": ty.flaps.iter().map(|f| f.label).collect::<Vec<_>>() },
        "spoiler": ac.spoiler, "speedbrake": ac.speedbrake, "armed": ac.spoilers_armed, "hasSpoilers": ty.spoiler_cd > 0.0,
        "gear": ac.gear, "gearLever": ac.gear_lever, "retracts": ty.gear_retracts, "brakes": ac.brakes, "park": ac.park,
        "autobrake": ac.autobrake, "autobrakeOn": ac.autobrake_on, "trim": ac.trim, "tailStrike": ac.tail_strike,
        "vspeeds": vs, "vmax": vmax, "vfeNext": next_vfe, "vls": ty.vs1g(mass, ac.flap_lever) * 1.23,
        "vstall": ty.vs1g(mass, ac.flap_lever) * v.air.g.max(0.5).sqrt(),
        "ap": s.af.to_json(),
        "route": s.route.to_json(), "dtg": dtg.map(|d| d / NM), "todDtg": tod / NM, "tod": s.route.point_at_dtg(tod).map(|p| [p.0, p.1]),
        "path": path, "cruise": s.route.cruise_ft,
        "wp": lnav.map(|l| json!({ "dist": l.to_wp / NM, "brg": l.brg_wp.to_degrees(), "dtk": l.dtk.to_degrees(), "xtk": l.xtk / NM, "id": s.route.active_wp().map(|w| w.id.clone()) })),
        "ils": ils.map(|i| json!({ "loc": i.loc, "gs": i.gs, "locValid": i.loc_valid, "gsValid": i.gs_valid, "crs": i.course.to_degrees(), "dme": i.dist / NM, "ident": arr.map(|r| format!("I{}", r.a.ident)) })),
        "dep": s.dep.as_ref().map(|r| json!({ "icao": r.icao, "name": r.name, "rwy": r.a.ident, "lat": r.a.pos.0, "lon": r.a.pos.1, "lat2": r.b.pos.0, "lon2": r.b.pos.1 })),
        "arr": arr.map(|r| json!({ "icao": r.icao, "name": r.name, "rwy": r.a.ident, "lat": r.a.pos.0, "lon": r.a.pos.1, "lat2": r.b.pos.0, "lon2": r.b.pos.1, "elev": r.a.elev_ft, "measured": r.measured, "offset": r.offset })),
        "rate": s.rate, "time": s.flight_time, "distance": s.distance / 1_852.0, "notes": s.notes, "warnings": warnings,
        "report": s.report, "touchdown": s.touchdown,
    })
}

/// Warnings and cautions, most urgent first: the ground proximity warning system's calls, the stall, overspeed, and
/// the configuration warnings.
fn warnings(s: &Session, ac: &Aircraft, v: &Vehicle, sense: &Sense, ra: f32, vmax: f32) -> Vec<&'static str> {
    let mut w = Vec::new();
    let ra_ft = ra * FT;
    let air = !ac.on_ground;
    if air && v.air.stalled {
        w.push("STALL");
    }
    // Mode 1: excessive sink rate for the height.
    if air && ra_ft < 2_500.0 && sense.vs < -(1_000.0 + ra_ft * 1.1) {
        w.push(if sense.vs < -(1_600.0 + ra_ft * 1.4) { "PULL UP" } else { "SINK RATE" });
    }
    let gear_down = ac.gear > 0.99;
    if air && ra_ft < 750.0 && !gear_down && sense.vs < 0.0 && sense.ias < 190.0 && s.touchdown.is_none() {
        w.push("TOO LOW GEAR");
    }
    if air && ra_ft < 200.0 && ac.flap_lever < ac.ty.flaps_landing.min(3) && sense.vs < 0.0 && gear_down && ac.ty.panel == "airliner" {
        w.push("TOO LOW FLAPS");
    }
    if air && sense.bank.abs() > 0.61 {
        w.push("BANK ANGLE");
    }
    if sense.ias > vmax + 4.0 {
        w.push("OVERSPEED");
    }
    if ac.on_ground && sense.lever > 0.8 && (ac.flap_lever == 0 && ac.ty.flaps_takeoff > 0 || ac.speedbrake > 0.1 || ac.park) {
        w.push("CONFIG");
    }
    if air && ra_ft < 1_000.0 && sense.vs < -300.0 && ac.speedbrake > 0.1 {
        w.push("SPEED BRAKE");
    }
    if ac.ty.fuel_max > 0.0 && ac.fuel < ac.ty.fuel_max * 0.05 {
        w.push("FUEL LOW");
    }
    if let Some((why, _)) = s.af.disconnect {
        w.push(why);
    }
    w
}

/// The cockpit view from the pilot's seat of the flight's aircraft (the sandbox puts the eye a fighter's way back).
fn cockpit_camera(pilot: Res<Pilot>, s: Res<Session>, vehicles: Query<(&Transform, &Vehicle, &Aircraft, &GlobalTransform), Without<Tiles3dCamera>>, parts: Query<(&Part, &GlobalTransform)>, mut cam: Single<&mut Transform, With<Tiles3dCamera>>) {
    let Some(e) = s.aircraft.filter(|e| pilot.vehicle == Some(*e) && matches!(pilot.view, View::Cockpit | View::HeadUp)) else { return };
    let Ok((tf, v, ac, was)) = vehicles.get(e) else { return };
    // The modelled flight deck's design eye point, and its screens instead of the panel over the view.
    if let Some((at, pitch)) = super::station::eye(&parts, e, was, tf) {
        cam.translation = at;
        cam.rotation = tf.rotation * look(pilot.orbit.x, pilot.orbit.y + pitch);
        return;
    }
    let (min, max) = v.bounds();
    let size = max - min;
    let [x, y, z] = ac.ty.eye;
    let eye = Vec3::new(min.x + size.x * x, min.y + size.y * y, min.z + size.z * z);
    cam.translation = tf.transform_point(eye);
    // Looking down over the nose (the panel covers the bottom of the screen, so the view's middle is above it, where a
    // pilot sees the runway on final); the right button looks around (the sandbox's orbit).
    cam.rotation = tf.rotation * look(pilot.orbit.x, pilot.orbit.y - 0.16);
}

/// The runways' lights, placed in the current frame (after any rebase), PAPI colours for the camera.
fn lights(
    frame: Res<Frame>,
    sky: Res<Sky>,
    assets: Res<LightAssets>,
    cam: Single<&Transform, With<Tiles3dCamera>>,
    mut q: Query<(&airport::Light, &mut Transform, &mut MeshMaterial3d<StandardMaterial>, &mut Visibility), Without<Tiles3dCamera>>,
) {
    airport::place_lights(&frame, &cam, sky.daylight, &assets, &mut q);
}
