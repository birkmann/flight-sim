//! Sandbox mode: fly around in first person, spawn the workspace's assets, get in, and fly, drive, sail and fight
//! them. The assets and what they carry are in `catalog.rs`, their dynamics in `physics.rs`, sky and weather in
//! `weather.rs`; the menus (`ui.js`) send commands here, and the HUD (`hud.js`) draws the state `hud` sends back.
//!
//! - The ground is the photorealistic mesh itself, found by ray casts (it streams for what the camera sees, so for a
//!   vehicle out of view the last known ground is used).
//! - The world frame moves with the camera (`origin.rs`), so flights can leave Berlin.
//! - Models are the app's digital twins (`packages/globe`), exported by `../cesium-baseline/export.html` and loaded
//!   on first spawn; their moving parts are found by the node names and extras `exportGlb.ts` documents.

use std::collections::{HashMap, HashSet};
use std::f32::consts::{PI, TAU};
use std::sync::atomic::{AtomicU32, Ordering::Relaxed};

use bevy::asset::RenderAssetUsages;
use bevy::camera::primitives::{Aabb, Frustum};
use bevy::gltf::GltfExtras;
use bevy::input::mouse::{AccumulatedMouseMotion, AccumulatedMouseScroll, MouseScrollUnit};
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};
use bevy::window::{CursorGrabMode, CursorOptions, PrimaryWindow};
use bevy_3d_tiles::{EcefOrigin, TileSseMultiplier, Tiles3dCamera, Tiles3dSet};
use serde_json::{Value, json};

use crate::catalog::{self, Asset, Kind};
use crate::js;
use crate::origin::{self, Frame};
use crate::physics::{self, AirData, Cyclic, Stick, Surfaces};
use crate::weather::{Sky, Weather, WeatherView};

mod collide;
mod exhaust;
mod flight;
mod globe;
mod station;


pub struct SandboxPlugin;

impl Plugin for SandboxPlugin {
    fn build(&self, app: &mut App) {
        // PostStartup: the camera it places is spawned in Startup.
        app.init_resource::<Pilot>()
            .init_resource::<Controls>()
            .init_resource::<Settings>()
            .init_resource::<Pad>()
            .init_resource::<Net>()
            .init_resource::<globe::Travel>()
            .init_resource::<station::Screens>()
            .add_plugins(crate::weather::WeatherPlugin)
            .add_plugins(flight::FlightPlugin)
            .add_plugins(exhaust::ExhaustPlugin)
            .add_systems(PostStartup, setup)
            .add_systems(
                Update,
                (
                    (read_pad, globe::place_spawns.before(apply_commands), apply_commands, net_receive, grab_cursor, keys, spawn_hotkeys, tag_parts, measure_vehicles, read_controls),
                    // Land vehicles move, find the ground where they moved to, and settle on it in the same frame.
                    (fly_free, globe::fly_to.after(fly_free), probe_ground, fly_aircraft, wrecks),
                    (place_ghosts, animate_parts, animate_blasts, station::show_station, station::wire_screens, place_camera, station::draw_screens),
                    // Before the tiles' pass, so it re-places them for a new origin in the same frame (`rebase`).
                    (rebase.before(Tiles3dSet::Drive), globe::tile_detail, net_send, hud),
                )
                    .chain(),
            );
    }
}

/// Marks the tileset's anchor entity (for the detail setting's `TileSseMultiplier`).
#[derive(Component)]
pub struct TilesAnchor;

// ---- vehicles ---------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Ammo {
    Apfsds,
    He,
}

impl Ammo {
    fn muzzle(self) -> f32 {
        match self {
            Ammo::Apfsds => 1750.0,
            Ammo::He => 1100.0,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Ammo::Apfsds => "APFSDS",
            Ammo::He => "HE",
        }
    }
}

/// Which side a vehicle fights for: you command blue; red is the opposing force.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
enum Side {
    #[default]
    Blue,
    Red,
}

impl Side {
    fn label(self) -> &'static str {
        match self {
            Side::Blue => "blue",
            Side::Red => "red",
        }
    }
    fn parse(s: Option<&str>) -> Side {
        if s == Some("red") { Side::Red } else { Side::Blue }
    }
}

#[derive(Component)]
pub struct Vehicle {
    asset: &'static Asset,
    kind: Kind,
    side: Side,
    /// The vehicle whose shell hit this one last (for the return-fire stance).
    attacker: Option<Entity>,
    velocity: Vec3,
    /// Body rates: pitch up, yaw left, roll left (rad/s).
    omega: Vec3,
    throttle: f32,
    collective: f32,
    gear_down: bool,
    on_ground: bool,
    health: f32,
    destroyed: Option<&'static str>,
    air: AirData,
    lift_ratio: f32,
    // Ground under the vehicle, from the last rays.
    ground: f32,
    /// Whether the last rays down found that ground. Out of view the tiles are not loaded (under an aircraft high up,
    /// looking ahead), and `ground` is then only the height last found somewhere else: nothing to land or crash on.
    ground_found: bool,
    agl: f32,
    terrain_tti: Option<f32>,
    hazard_probe_in: f32,
    /// A land vehicle's running gear on the ground: where the rays found it under each track or wheel line (hull x
    /// and z, world height; left front, middle, rear, then right), and the plane through them.
    contacts: [Option<Vec3>; 6],
    ground_plane: Option<GroundPlane>,
    probe_in: f32,
    // Land and sea: forward speed, heading, hull attitude, steering.
    speed: f32,
    heading: f32,
    hull_pitch: f32,
    hull_bank: f32,
    fall: f32,
    blocked_for: f32,
    /// Wheel angle (rad, left positive), or the rudder (−1..1) of a ship.
    steer: f32,
    /// A ship's water level (m, world) and a submersible's depth below it.
    water: Option<f32>,
    depth: f32,
    /// The SAM launcher's erector, 0 stowed .. 1 raised, and where it is going.
    erector: f32,
    erector_up: bool,
    // Turret and gun lay relative to the hull, fire control.
    turret: f32,
    gun: f32,
    range: Option<f32>,
    ammo: Ammo,
    track_dist: [f32; 2],
    // Weapons and effects.
    rounds: u32,
    cooldown: f32,
    flash: f32,
    recoil: f32,
    rotor: f32,
    rotor_rate: f32,
    /// Where the flight-control surfaces are (following `air.surfaces` at the actuators' rates).
    surfaces: Surfaces,
    /// Swing wings: their sweep (deg), and the stop Y has set (`catalog::Sweep::stops`), or none for the automatic schedule.
    sweep_deg: f32,
    sweep_stop: Option<usize>,
    bounds: Option<(Vec3, Vec3)>,
    /// The extent of the meshes that reach down to the bottom (the running gear, without the gun barrel over the
    /// front or anything else that overhangs it).
    footprint: Option<(Vec3, Vec3)>,
    /// This player's number for it (unique per player, for the network), and, for another player's vehicle, what
    /// the network says about it.
    vid: u32,
    remote: Option<Box<Remote>>,
}

impl Vehicle {
    fn is_remote(&self) -> bool {
        self.remote.is_some()
    }
    /// Aircraft with a retractable landing gear (the drones that land on their belly or not at all have none).
    fn has_gear(&self) -> bool {
        self.asset.airframe.is_some_and(|a| a.cd_gear > 0.0)
    }
    fn new(asset: &'static Asset, heading: f32, airborne: bool) -> Self {
        let kind = asset.kind;
        let (_, speed) = asset.airborne;
        let rot = Quat::from_rotation_y(heading);
        Self {
            asset,
            kind,
            side: Side::Blue,
            attacker: None,
            velocity: if airborne { rot * Vec3::NEG_Z * speed } else { Vec3::ZERO },
            omega: Vec3::ZERO,
            throttle: if airborne && kind.flies() { 0.7 } else { 0.0 },
            collective: if airborne && kind == Kind::Heli { 1.0 / physics::HOVER_MARGIN } else { 0.0 },
            gear_down: !airborne,
            on_ground: !airborne,
            health: asset.health,
            destroyed: None,
            air: AirData::default(),
            lift_ratio: 0.0,
            ground: 0.0,
            ground_found: false,
            terrain_tti: None,
            hazard_probe_in: 0.0,
            agl: if airborne { asset.airborne.0 } else { 0.0 },
            contacts: [None; 6],
            ground_plane: None,
            probe_in: 0.0,
            speed: 0.0,
            heading,
            hull_pitch: 0.0,
            hull_bank: 0.0,
            fall: 0.0,
            blocked_for: 0.0,
            steer: 0.0,
            water: None,
            depth: 0.0,
            erector: 0.0,
            erector_up: false,
            turret: 0.0,
            gun: 0.0,
            range: None,
            ammo: Ammo::Apfsds,
            track_dist: [0.0; 2],
            rounds: asset.gun.map_or(0, |g| g.rounds),
            cooldown: 0.0,
            flash: 0.0,
            recoil: 0.0,
            rotor: 0.0,
            rotor_rate: if airborne && kind == Kind::Heli { 28.0 } else { 0.0 },
            surfaces: Surfaces::default(),
            sweep_deg: asset.sweep.map_or(0.0, |s| s.min_deg),
            sweep_stop: None,
            bounds: None,
            footprint: None,
            vid: 0,
            remote: None,
        }
    }
    fn bounds(&self) -> (Vec3, Vec3) {
        self.bounds.unwrap_or(match self.kind {
            Kind::Uav | Kind::Munition | Kind::Uuv => (Vec3::new(-1.4, -0.3, -1.0), Vec3::new(1.4, 0.3, 1.0)),
            Kind::Ship => (Vec3::new(-8.0, -4.0, -60.0), Vec3::new(8.0, 30.0, 60.0)),
            _ => (Vec3::new(-3.0, 0.0, -8.0), Vec3::new(3.0, 4.0, 8.0)),
        })
    }
    /// Where a land vehicle's rays look for the ground (hull frame, in `contacts` order): three along each track or
    /// wheel line, just inside the ends of the running gear.
    fn contact_points(&self) -> [Vec3; 6] {
        let (min, max) = self.footprint.unwrap_or_else(|| self.bounds());
        let (left, right) = (min.x * 0.85, max.x * 0.85);
        let (front, rear) = (min.z * 0.92, max.z * 0.92);
        let middle = (front + rear) / 2.0;
        [left, right].map(|x| [front, middle, rear].map(|z| Vec3::new(x, 0.0, z))).concat().try_into().unwrap()
    }
    /// The chase camera's default distance from what it looks at (m), and the closest it may come.
    fn chase_distance(&self) -> (f32, f32) {
        let (min, max) = self.bounds();
        (1.2 * (max.z - min.z) + 5.0, 0.5 * (max - min).length() + 1.0)
    }
    /// Heading about world up (rad, left positive).
    fn yaw(&self, tf: &Transform) -> f32 {
        if self.kind.drives() || self.kind.sails() { self.heading } else { yaw_of(tf.rotation) }
    }
}

/// A node of a vehicle's model that moves: found by name, animated from its rest pose.
#[derive(Component)]
struct Part {
    vehicle: Entity,
    role: Role,
    rest: Transform,
}

#[derive(Clone, Copy, PartialEq)]
enum Role {
    Turret,
    Gun,
    Recoil,
    MuzzleFlash,
    Sight,
    Rotor,
    RotorBlur,
    CockpitYoke(Vec3),
    CockpitPedal(f32),
    Lamp(f32),
    Scan,
    /// A jet nozzle's exit (`exhaust.rs` hangs its flame there).
    Plume,
    Gear,
    StowedGear,
    /// A jet's pylons and what hangs on them (`external-stores`, or `stores-*` groups such as a swing wing's).
    Stores,
    /// A swing wing (`wing-sweep-*`): turns about its pivot by the sweep less the sweep it is built at.
    Sweep,
    /// A swivelling pylon on a swing wing (`pylon-swivel-*`): turns back by as much, staying streamwise.
    Swivel,
    /// A launcher's erector: the angle it was built at (rad).
    Erector(f32),
    /// A steered wheel's share of the steering angle.
    Steer(f32),
    /// A road wheel: rolling radius (m), right side.
    Wheel(f32, bool),
    /// One phase of a track's links: right side, phase, phases, link pitch (m).
    Track(bool, u32, u32, f32),
    /// A flight-control surface: what moves it, its side (−1 port, +1 starboard, 0 centre), its full deflection (rad).
    Control(Surface, f32, f32),
    GliderHinge(Surface, f32, Vec3, Vec3),
    GliderBrake(Vec3),
    /// The crew station's interior, shown only from inside (`station.rs`).
    Station,
    /// The crew's eyes: the view's pitch at rest (rad).
    Eye(f32),
    /// A screen of the station and what it shows.
    Display(station::Display),
    /// A head-up display's glass.
    Combiner,
    /// An outside part hidden from inside (the shell around the station).
    Exterior,
}

/// What a control surface answers to (`ControlSurface.role` in the model).
#[derive(Clone, Copy, PartialEq)]
enum Surface {
    Elevator,
    Aileron,
    Flaperon,
    Flap,
    Rudder,
    Lef,
    Airbrake,
}

impl Role {
    fn of(name: &str, extras: Option<&Value>) -> Option<Role> {
        let num = |k: &str| extras.and_then(|e| e.get(k)).and_then(Value::as_f64).map(|v| v as f32);
        let vector = |k: &str| -> Option<Vec3> {
            let a = extras?.get(k)?.as_array()?;
            Some(Vec3::new(a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32))
        };
        Some(match name {
            "turret-traverse" => Role::Turret,
            "gun-elevation" => Role::Gun,
            "gun-recoil" => Role::Recoil,
            "muzzle-flash" => Role::MuzzleFlash,
            "gunner-sight" => Role::Sight,
            "landing-gear" => Role::Gear,
            "landing-gear-stowed" => Role::StowedGear,
            "external-stores" | "stores" => Role::Stores,
            "erector-elevation" => Role::Erector(num("builtDeg").unwrap_or(0.0).to_radians()),
            "crew-station" => Role::Station,
            "crew-eye" => Role::Eye(num("pitchDeg").unwrap_or(0.0).to_radians()),
            "hud-combiner" => Role::Combiner,
            n if n.starts_with("display-") => Role::Display(station::Display::parse(&n["display-".len()..])?),
            n if n.starts_with("stores-") => Role::Stores,
            n if n.starts_with("wing-sweep-") => Role::Sweep,
            n if n.starts_with("pylon-swivel-") => Role::Swivel,
            n if n.starts_with("rotor-disc-") => Role::RotorBlur,
            n if n.starts_with("cockpit-yoke-") => Role::CockpitYoke(vector("controlPivot")?),
            n if n.starts_with("cockpit-pedal-") => Role::CockpitPedal(num("side").unwrap_or(1.0)),
            n if n.starts_with("aircraft-lamp-") => Role::Lamp(num("phase").unwrap_or(-1.0)),
            n if n.starts_with("rotor-") => Role::Rotor,
            n if n.starts_with("scan-") => Role::Scan,
            n if n.starts_with("jet-plume-") => Role::Plume,
            n if n.starts_with("steer-") => Role::Steer(num("lock").unwrap_or(1.0)),
            n if n.starts_with("wheel-") => Role::Wheel(num("rollRadiusM")?, num("lateralM")? > 0.0),
            n if n.starts_with("track-") => Role::Track(num("lateralM")? > 0.0, num("phase")? as u32, num("phases")? as u32, num("pitchM")?),
            n if n.starts_with("glider-hinge-") => {
                let surface = match extras?.get("role")?.as_str()? {
                    "aileron" => Surface::Aileron, "elevator" => Surface::Elevator, "rudder" => Surface::Rudder, _ => return None,
                };
                Role::GliderHinge(surface, num("maxDeg")?.to_radians(), vector("axis")?.normalize_or_zero(), vector("pivot")?)
            }
            n if n.starts_with("glider-brake-") => Role::GliderBrake(vector("axis")?),
            n if n.starts_with("control-") => {
                let surface = match extras.and_then(|e| e.get("role")).and_then(Value::as_str)? {
                    "elevator" => Surface::Elevator,
                    "aileron" => Surface::Aileron,
                    "flaperon" => Surface::Flaperon,
                    "flap" => Surface::Flap,
                    "rudder" => Surface::Rudder,
                    "lef" => Surface::Lef,
                    "airbrake" => Surface::Airbrake,
                    _ => return None,
                };
                Role::Control(surface, num("side").unwrap_or(0.0), num("maxDeg")?.to_radians())
            }
            _ if extras.and_then(|e| e.get("cockpitHidden")).and_then(Value::as_bool) == Some(true) => Role::Exterior,
            _ => return None,
        })
    }
}

/// A mesh of a vehicle's model: what a shell can hit, and what the ground rays must ignore.
#[derive(Component)]
struct VehicleMesh(Entity);

/// Things the rays pass through (shells, blasts, clouds, benchmark units).
#[derive(Component)]
pub struct NoHit;

#[derive(Component)]
struct Shell {
    velocity: Vec3,
    owner: Entity,
    age: f32,
    damage: f32,
    splash: f32,
}

/// One piece of an explosion (`blast`): a soft billboard, a flying ember, the shock ring on the ground.
#[derive(Component)]
struct Blast {
    puff: Puff,
    /// Where it is; a billboard is drawn a little toward the camera from here, so walls do not slice it.
    pos: Vec3,
    /// Seconds; below zero it has not appeared yet.
    age: f32,
    life: f32,
    /// Radius at birth and at the end.
    from: f32,
    to: f32,
    velocity: Vec3,
    /// The billboard's roll (or a smoke puff's shade).
    spin: f32,
    /// A trail piece's length and direction (it is drawn along it).
    along: Vec3,
    material: Handle<StandardMaterial>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Puff {
    Flash,
    Fire,
    Smoke,
    Ember,
    Shock,
    /// A piece of a missile's smoke trail.
    Trail,
}

/// A big wreck's fire: a column of smoke rising for a while after the fireball.
#[derive(Component)]
struct Smoulder {
    size: f32,
    left: f32,
    next: f32,
}

/// After the flown vehicle is lost: the camera watches its end from above for a few seconds, until the player moves.
#[derive(Clone, Copy)]
struct Aftermath {
    at: Vec3,
    eye: Vec3,
    /// How far above the wreck the camera aims: the fireball and the smoke go up.
    lift: f32,
    age: f32,
}

// ---- the player -------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    Chase,
    /// The crew station (the pilot's seat, a cab, a ship's bridge, a commander's hatch); without one, a gunner's
    /// sight, the bridge, the munition's nose camera.
    Cockpit,
    /// The crew's eyes without the station: the whole vehicle hidden, the head-up symbology over the view (only for a
    /// vehicle with a modelled station; without one the cockpit view is already this).
    HeadUp,
    /// A gunner's sight, laid with the gun.
    Sight,
    /// An uncrewed aircraft's stabilised camera (its autopilot circles meanwhile).
    Gimbal,
}

#[derive(Resource)]
struct Pilot {
    vehicle: Option<Entity>,
    /// The player's soldier, when on foot (`infantry`): then the camera is in its head.
    foot: Option<Entity>,
    view: View,
    /// World look angles: the free camera's, the chase camera's orbit, a turret's aim, a gimbal's line of sight.
    yaw: f32,
    pitch: f32,
    /// Free-flight cruise speed (m/s), set with the mouse wheel.
    speed: f32,
    /// Aircraft chase orbit or seated head look (yaw, pitch from centre, rad), turned with right-drag.
    orbit: Vec2,
    /// The chase camera's distance, as a multiple of the vehicle's default; the mouse wheel sets it.
    chase_zoom: f32,
    /// Sight or gimbal magnification.
    zoom: f32,
    infrared: bool,
    /// Laser-designated point (a drone's), for its coordinates on the HUD.
    designated: Option<Vec3>,
    spawned: Vec<Entity>,
    aftermath: Option<Aftermath>,
    locked: bool,
    just_locked: bool,
    message: String,
    message_for: f32,
}

impl Default for Pilot {
    fn default() -> Self {
        Self {
            vehicle: None,
            foot: None,
            view: View::Chase,
            yaw: 0.0,
            pitch: -0.34,
            speed: 40.0,
            orbit: Vec2::ZERO,
            chase_zoom: 1.0,
            zoom: 1.0,
            infrared: false,
            designated: None,
            spawned: Vec::new(),
            aftermath: None,
            locked: false,
            just_locked: false,
            message: String::new(),
            message_for: 0.0,
        }
    }
}

impl Pilot {
    fn say(&mut self, text: impl Into<String>) {
        self.message = text.into();
        self.message_for = 2.5;
    }
    fn leave(&mut self) {
        self.vehicle = None;
        self.view = View::Chase;
        self.orbit = Vec2::ZERO;
        self.zoom = 1.0;
        self.infrared = false;
        js::set_class("canvas", "");
    }
}

/// The options menu's settings.
#[derive(Resource)]
struct Settings {
    fov: f32,
    sensitivity: f32,
    invert_y: bool,
    /// Tile detail: the refine threshold's multiplier (lower is sharper).
    detail: f32,
    menu_open: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { fov: 50f32.to_radians(), sensitivity: 1.0, invert_y: false, detail: 1.0, menu_open: false }
    }
}

/// This frame's input, for the vehicle being driven.
#[derive(Resource, Default)]
struct Controls {
    /// The vehicle these were read for (a vehicle spawned this frame has none yet, and must not get a blank stick).
    vehicle: Option<Entity>,
    stick: Stick,
    /// The aircraft stick's share from the mouse and from the arrow keys (x roll right, y pitch up), kept between
    /// frames: the mouse deflects it and it springs back, the keys move it at a hand's pace.
    mouse_stick: Vec2,
    key_stick: Vec2,
    cyclic: Cyclic,
    drive: f32,
    steer: f32,
    brake: bool,
    fire: bool,
    fire_pressed: bool,
    /// The munition's warhead: X, or the controller's action button (a click must not set it off).
    detonate: bool,
}

/// The controller this frame (pad.js applies the mapping, deadzone and curve): analogue actions −1..1, held buttons,
/// and the buttons pressed since the last frame. What each means depends on the vehicle, as with the keys.
#[derive(Resource, Default)]
struct Pad {
    stick: Vec2,
    look: Vec2,
    trigger: f32,
    bumper: f32,
    fire: bool,
    boost: bool,
    brake: bool,
    zoom: f32,
    pressed: Vec<String>,
}

impl Pad {
    fn pressed(&self, action: &str) -> bool {
        self.pressed.iter().any(|p| p == action)
    }
}

// ---- multiplayer ------------------------------------------------------------------------------------------------
//
// net.js carries the messages (the workspace gateway's rooms); here each player's vehicles are sent and the others'
// shown. Positions travel in Earth-fixed coordinates, since every player's world frame is centred elsewhere.

/// Another player's vehicle, as last heard: Earth-fixed position, velocity and orientation, and its moving parts.
struct Remote {
    name: String,
    ecef: bevy::math::DVec3,
    velocity: bevy::math::DVec3,
    rotation: Quat,
    heard: f64,
    shown: Option<bevy::math::DVec3>,
    parts: Value,
}

struct RemotePlayer {
    name: String,
    /// What they are in ("free" or an asset's label), and where their camera is (Earth-fixed).
    what: String,
    camera: Option<bevy::math::DVec3>,
}

#[derive(Resource, Default)]
struct Net {
    next_vid: u32,
    send_in: f32,
    inbox: Vec<(String, String, Value)>,
    /// "<player>:<vid>" -> the vehicle standing for it here.
    ghosts: HashMap<String, Entity>,
    players: HashMap<String, RemotePlayer>,
}

impl Net {
    fn vid(&mut self) -> u32 {
        self.next_vid += 1;
        self.next_vid
    }
}

fn dvec(v: &Value) -> Option<bevy::math::DVec3> {
    Some(bevy::math::DVec3::new(v.get(0)?.as_f64()?, v.get(1)?.as_f64()?, v.get(2)?.as_f64()?))
}

/// Messages from the other players: their vehicles (spawned here the first time, then updated), shots (flown here
/// too, so hits show; only the owner of what is hit counts the damage), losses, and departures.
#[allow(clippy::too_many_arguments)]
fn net_receive(
    mut commands: Commands,
    mut net: ResMut<Net>,
    time: Res<Time>,
    frame: Res<Frame>,
    asset_server: Res<AssetServer>,
    fx: Res<Effects>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut vehicles: Query<(Entity, &Transform, &mut Vehicle)>,
) {
    let now = time.elapsed_secs_f64();
    let inbox = std::mem::take(&mut net.inbox);
    for (from, name, msg) in inbox {
        match msg.get("k").and_then(Value::as_str) {
            Some("state") => {
                let what = msg.get("what").and_then(Value::as_str).unwrap_or("free").to_owned();
                net.players.insert(from.clone(), RemotePlayer { name: name.clone(), what, camera: msg.get("cam").and_then(dvec) });
                let mut seen = Vec::new();
                for v in msg.get("vehicles").and_then(Value::as_array).into_iter().flatten() {
                    let (Some(id), Some(asset), Some(p), Some(vel)) = (v.get("id").and_then(Value::as_u64), v.get("asset").and_then(Value::as_str).and_then(catalog::find), v.get("p").and_then(dvec), v.get("v").and_then(dvec)) else { continue };
                    let q = v.get("q").and_then(Value::as_array).map(|q| q.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect::<Vec<_>>()).filter(|q| q.len() == 4).map_or(Quat::IDENTITY, |q| Quat::from_xyzw(q[0], q[1], q[2], q[3]).normalize());
                    let key = format!("{from}:{id}");
                    seen.push(key.clone());
                    let remote = Remote { name: name.clone(), ecef: p, velocity: vel, rotation: q, heard: now, shown: None, parts: v.get("x").cloned().unwrap_or(Value::Null) };
                    match net.ghosts.get(&key).copied().and_then(|e| vehicles.get_mut(e).ok().map(|(e, _, v)| (e, v))) {
                        Some((_, mut vehicle)) => {
                            if let Some(r) = vehicle.remote.as_mut() {
                                let shown = r.shown;
                                **r = Remote { shown, ..remote };
                            }
                        }
                        None => {
                            let at = frame.from_ecef(p);
                            let mut vehicle = Vehicle::new(asset, 0.0, false);
                            vehicle.remote = Some(Box::new(remote));
                            let model = asset_server.load(GltfAssetLabel::Scene(0).from_asset(asset.model()));
                            let e = commands
                                .spawn((Transform::from_translation(at), Visibility::default(), vehicle))
                                .with_children(|c| {
                                    c.spawn((WorldAssetRoot(model), Transform::from_rotation(Quat::from_rotation_y(PI))));
                                })
                                .id();
                            net.ghosts.insert(key, e);
                        }
                    }
                }
                // Vehicles this player no longer has (removed, or lost off-screen) go.
                let gone: Vec<String> = net.ghosts.keys().filter(|k| k.starts_with(&format!("{from}:")) && !seen.contains(k)).cloned().collect();
                for k in gone {
                    if let Some(e) = net.ghosts.remove(&k) {
                        commands.entity(e).despawn();
                    }
                }
            }
            Some("destroyed") => {
                let Some(id) = msg.get("id").and_then(Value::as_u64) else { continue };
                if let Some(e) = net.ghosts.remove(&format!("{from}:{id}")) {
                    if let Ok((_, tf, v)) = vehicles.get(e) {
                        let size = if v.kind.sails() { 60.0 } else { 22.0 };
                        blast(&mut commands, &fx, &mut materials, tf.translation, size);
                    }
                    commands.entity(e).despawn();
                }
            }
            Some("leave") => {
                net.players.remove(&from);
                let gone: Vec<String> = net.ghosts.keys().filter(|k| k.starts_with(&format!("{from}:"))).cloned().collect();
                for k in gone {
                    if let Some(e) = net.ghosts.remove(&k) {
                        commands.entity(e).despawn();
                    }
                }
            }
            _ => {}
        }
    }
}

/// Other players' vehicles: dead reckoning from the last report, eased in, and their moving parts as reported.
fn place_ghosts(time: Res<Time>, frame: Res<Frame>, mut vehicles: Query<(&mut Transform, &mut Vehicle)>) {
    let now = time.elapsed_secs_f64();
    let k = (10.0 * time.delta_secs()).min(1.0);
    let rot = frame.world_rot_from_ecef();
    for (mut tf, mut v) in &mut vehicles {
        let Some(r) = v.remote.as_mut() else { continue };
        let ahead = (now - r.heard).clamp(0.0, 1.0);
        let predicted = r.ecef + r.velocity * ahead;
        let shown = r.shown.map_or(predicted, |s| s.lerp(predicted, f64::from(k)));
        r.shown = Some(shown);
        tf.translation = frame.from_ecef(shown);
        tf.rotation = tf.rotation.slerp(rot * r.rotation, k);
        let velocity = rot * r.velocity.as_vec3();
        let x = r.parts.clone();
        let num = |key: &str| x.get(key).and_then(Value::as_f64).unwrap_or(0.0) as f32;
        v.velocity = velocity;
        v.throttle = num("thr");
        v.gear_down = x.get("gear").and_then(Value::as_bool).unwrap_or(true);
        v.turret = num("tur");
        v.gun = num("gun");
        v.rotor_rate = num("rot");
        v.erector = num("er");
        v.steer = num("st");
        v.track_dist = [num("tl"), num("tr")];
        v.agl = num("agl");
        v.on_ground = x.get("og").and_then(Value::as_bool).unwrap_or(false);
        v.side = Side::parse(x.get("sd").and_then(Value::as_str));
        if let Some(cs) = x.get("cs").and_then(Value::as_array) {
            let mut a = [0.0; 6];
            for (a, c) in a.iter_mut().zip(cs) {
                *a = c.as_f64().unwrap_or(0.0) as f32;
            }
            v.air.surfaces = Surfaces::from_array(a);
        }
        if x.get("fl").and_then(Value::as_bool).unwrap_or(false) {
            v.flash = 0.06;
        }
    }
}

/// This player's vehicles and camera, 15 times a second, while in a session.
fn net_send(time: Res<Time>, mut net: ResMut<Net>, pilot: Res<Pilot>, frame: Res<Frame>, vehicles: Query<(&Transform, &Vehicle)>, cam: Single<&Transform, With<Tiles3dCamera>>) {
    if !js::net_active() {
        return;
    }
    net.send_in -= time.delta_secs();
    if net.send_in > 0.0 {
        return;
    }
    net.send_in = 1.0 / 15.0;
    let to_ecef = frame.world_rot_from_ecef().inverse();
    let list: Vec<Value> = vehicles
        .iter()
        .filter(|(_, v)| !v.is_remote())
        .take(40)
        .map(|(tf, v)| {
            let q = to_ecef * tf.rotation;
            let vel = to_ecef * v.velocity;
            json!({
                "id": v.vid, "asset": v.asset.id, "p": frame.to_ecef(tf.translation).to_array(), "v": vel.to_array(), "q": [q.x, q.y, q.z, q.w],
                "x": { "thr": v.throttle, "gear": v.gear_down, "tur": v.turret, "gun": v.gun, "rot": v.rotor_rate, "er": v.erector, "st": v.steer,
                       "tl": v.track_dist[0], "tr": v.track_dist[1], "agl": v.agl, "og": v.on_ground, "fl": v.flash > 0.0, "sd": v.side.label(),
                       "cs": v.air.surfaces.to_array() },
            })
        })
        .collect();
    let what = pilot.vehicle.and_then(|e| vehicles.get(e).ok()).map_or(if pilot.foot.is_some() { "on foot" } else { "free" }.to_owned(), |(_, v)| v.asset.label.to_owned());
    js::net_send(&json!({ "k": "state", "what": what, "cam": frame.to_ecef(cam.translation).to_array(), "vehicles": list }).to_string());
}

fn read_pad(mut pad: ResMut<Pad>, settings: Res<Settings>) {
    *pad = Pad::default();
    if settings.menu_open {
        return;
    }
    let Some(v) = js::pad_poll().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { return };
    let num = |v: &Value| v.as_f64().unwrap_or(0.0) as f32;
    let pair = |v: &Value| Vec2::new(num(&v[0]), num(&v[1]));
    let held = |k: &str| v["held"][k].as_bool().unwrap_or(false);
    pad.stick = pair(&v["stick"]);
    pad.look = pair(&v["look"]);
    pad.trigger = num(&v["trigger"]);
    pad.bumper = num(&v["bumper"]);
    pad.fire = held("fire");
    pad.boost = held("boost");
    pad.brake = held("brake");
    pad.zoom = f32::from(u8::from(held("zoomIn"))) - f32::from(u8::from(held("zoomOut")));
    pad.pressed = v["pressed"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
}

#[derive(Resource)]
struct Effects {
    shell: Handle<Mesh>,
    shell_material: Handle<StandardMaterial>,
    /// A 2 × 2 quad, for the explosions' billboards.
    puff: Handle<Mesh>,
    ember: Handle<Mesh>,
    /// A soft, lumpy, cloudy disc lit from above (fire and smoke) and a soft ring (the shock wave).
    soft: Handle<Image>,
    ring: Handle<Image>,
}

/// A 64 × 64 grey texture: `shape(p)` gives the brightness and the alpha at `p` (−1..1 across, y down).
fn effect_texture(shape: impl Fn(Vec2) -> (f32, f32)) -> Image {
    const N: u32 = 64;
    let mut data = Vec::with_capacity((N * N * 4) as usize);
    for y in 0..N {
        for x in 0..N {
            let (l, a) = shape((Vec2::new(x as f32, y as f32) + 0.5) / N as f32 * 2.0 - 1.0);
            let l = (l.clamp(0.0, 1.0) * 255.0) as u8;
            data.extend_from_slice(&[l, l, l, (a.clamp(0.0, 1.0) * 255.0) as u8]);
        }
    }
    let size = Extent3d { width: N, height: N, depth_or_array_layers: 1 };
    Image::new(size, TextureDimension::D2, data, TextureFormat::Rgba8UnormSrgb, RenderAssetUsages::RENDER_WORLD)
}

/// Smooth value noise, 0..1, varying over about a unit.
fn value_noise(p: Vec2) -> f32 {
    let hash = |x: f32, y: f32| ((x * 127.1 + y * 311.7).sin() * 43_758.547).rem_euclid(1.0);
    let (i, f) = (p.floor(), p.fract_gl());
    let u = f * f * (3.0 - 2.0 * f);
    let (a, b) = (hash(i.x, i.y), hash(i.x + 1.0, i.y));
    let (c, d) = (hash(i.x, i.y + 1.0), hash(i.x + 1.0, i.y + 1.0));
    (a + (b - a) * u.x) + ((c + (d - c) * u.x) - (a + (b - a) * u.x)) * u.y
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut images: ResMut<Assets<Image>>,
    mut cam: Single<&mut Transform, With<Tiles3dCamera>>,
    pilot: Res<Pilot>,
) {
    commands.insert_resource(Effects {
        shell: meshes.add(Cuboid::new(0.2, 0.2, 4.0)),
        shell_material: materials.add(StandardMaterial {
            base_color: Color::srgb(1.0, 0.85, 0.4),
            emissive: LinearRgba::rgb(40.0, 25.0, 8.0),
            unlit: true,
            ..default()
        }),
        puff: meshes.add(Rectangle::new(2.0, 2.0)),
        ember: meshes.add(Cuboid::new(1.0, 1.0, 1.0)),
        // Billowing edges (the radius wobbles with the angle), cloudy inside, lighter on top.
        soft: images.add(effect_texture(|p| {
            let a = p.y.atan2(p.x);
            let edge = 0.82 + 0.1 * (5.0 * a).sin() * (3.0 * a + 1.0).cos() + 0.05 * (11.0 * a).sin();
            let x = (p.length() / edge).min(1.0);
            let cloud = 0.6 * value_noise(p * 3.0 + 7.0) + 0.4 * value_noise(p * 7.0 + 3.0);
            (0.78 - 0.22 * p.y + 0.3 * (cloud - 0.5), (1.0 - x * x).powf(1.4) * (0.45 + 0.8 * cloud))
        })),
        ring: images.add(effect_texture(|p| (1.0, (-((p.length() - 0.82) / 0.09).powi(2)).exp() * f32::from(u8::from(p.length() < 1.0))))),
    });
    **cam = Transform::from_xyz(0.0, 250.0, 700.0).with_rotation(look(pilot.yaw, pilot.pitch));
    js::set_body_class("sandbox");
}

fn look(yaw: f32, pitch: f32) -> Quat {
    Quat::from_euler(EulerRot::YXZ, yaw, pitch, 0.0)
}

fn axis(keys: &ButtonInput<KeyCode>, pos: KeyCode, neg: KeyCode) -> f32 {
    f32::from(u8::from(keys.pressed(pos))) - f32::from(u8::from(keys.pressed(neg)))
}

fn wrap(a: f32) -> f32 {
    (a + PI).rem_euclid(TAU) - PI
}

/// Compass heading (rad, clockwise from north) of an orientation's forward axis.
fn heading_of(rot: Quat) -> f32 {
    let f = rot * Vec3::NEG_Z;
    f.x.atan2(-f.z).rem_euclid(TAU)
}

fn yaw_of(rot: Quat) -> f32 {
    rot.to_euler(EulerRot::YXZ).0
}

fn scroll_notches(scroll: &AccumulatedMouseScroll) -> f32 {
    match scroll.unit {
        MouseScrollUnit::Line => scroll.delta.y,
        MouseScrollUnit::Pixel => scroll.delta.y / 60.0,
    }
}

/// Mouse movement while the pointer is locked, with the sensitivity and inversion settings applied.
fn mouse(pilot: &Pilot, settings: &Settings, motion: &AccumulatedMouseMotion) -> Vec2 {
    if !pilot.locked || settings.menu_open {
        return Vec2::ZERO;
    }
    motion.delta * settings.sensitivity * Vec2::new(1.0, if settings.invert_y { -1.0 } else { 1.0 })
}

// ---- menus, spawning, keys --------------------------------------------------------------------------------------

/// Commands from the menus (`ui.js`): spawn an asset, change the weather or the settings, menu open or closed.
#[allow(clippy::too_many_arguments)]
fn apply_commands(
    mut commands: Commands,
    mut pilot: ResMut<Pilot>,
    mut settings: ResMut<Settings>,
    mut weather: ResMut<Weather>,
    asset_server: Res<AssetServer>,
    mut cam: Single<&mut Transform, With<Tiles3dCamera>>,
    mut ray_cast: MeshRayCast,
    vehicle_meshes: Query<(), With<VehicleMesh>>,
    no_hit: Query<(), With<NoHit>>,
    mut net: ResMut<Net>,
    mut anchor: Query<&mut TileSseMultiplier, With<TilesAnchor>>,
    anchors: Query<Entity, (With<TilesAnchor>, Without<TileSseMultiplier>)>,
    mut travel: ResMut<globe::Travel>,
    mut flight: ResMut<flight::Inbox>,
    frame: Res<Frame>,
) {
    let mut fly_to_height = None;
    // Spawns at a place that `globe::place_spawns` has placed, then the page's commands.
    let placed = travel.take_placed();
    for cmd in placed.into_iter().chain(js::take_commands().iter().filter_map(|raw| serde_json::from_str::<Value>(raw).ok())) {
        match cmd.get("type").and_then(Value::as_str) {
            Some("spawn") => {
                let Some(asset) = cmd.get("id").and_then(Value::as_str).and_then(catalog::find) else { continue };
                let ground = cmd.get("ground").and_then(Value::as_bool).unwrap_or(false);
                let side = Side::parse(cmd.get("side").and_then(Value::as_str));
                // At a place (the start screen's): once `globe::place_spawns` has found the ground there.
                if cmd.get("lat").is_some() && cmd.get("at").is_none() {
                    travel.spawn_at(cmd.clone());
                    continue;
                }
                let placed = cmd.get("at").and_then(dvec).map(|p| p.as_vec3());
                let yaw = cmd.get("yaw").and_then(Value::as_f64).map_or_else(|| yaw_of(cam.rotation), |y| y as f32);
                let hit = if placed.is_some() {
                    placed
                } else {
                    crosshair_ground(&mut ray_cast, &vehicle_meshes, &no_hit, &**cam)
                };
                // ground only loosely (from far out it can be kilometres above it), and with the crosshair on nothing
                // near the fallback is in the air ahead of the camera: then `globe::place_spawns` finds the ground
                // under that point first.
                let airborne = (asset.kind.flies() || asset.kind == Kind::Heli) && !ground;
                if !airborne && placed.is_none() && hit.is_none() {
                    let under = hit.unwrap_or(cam.translation + cam.forward().with_y(0.0).normalize_or_zero() * 80.0);
                    let (lat, lon, _) = frame.geodetic(under);
                    let mut cmd = cmd.clone();
                    cmd["lat"] = json!(lat);
                    cmd["lon"] = json!(lon);
                    cmd["yaw"] = json!(yaw);
                    travel.spawn_at(cmd);
                    continue;
                }
                if pilot.vehicle.is_some() {
                    pilot.leave();
                }
                let e = spawn(&mut commands, &mut pilot, &mut net, &asset_server, asset, &**cam, hit, yaw, ground, side);
                let enter = cmd.get("enter").and_then(Value::as_bool).unwrap_or(false);
                if enter {
                    pilot.vehicle = Some(e);
                    pilot.yaw = yaw;
                    pilot.pitch = -0.12;
                    pilot.view = View::Chase;
                }
            }
            Some("view") if pilot.vehicle.is_some() => {
                pilot.view = if cmd.get("view").and_then(Value::as_str) == Some("cockpit") { View::Cockpit } else { View::Chase };
                pilot.orbit = Vec2::ZERO;
            }
            Some("weather") => weather.apply(&cmd["weather"]),
            Some("settings") => {
                let s = &cmd["settings"];
                if let Some(v) = s.get("fov").and_then(Value::as_f64) {
                    settings.fov = (v as f32).clamp(30.0, 100.0).to_radians();
                }
                if let Some(v) = s.get("sensitivity").and_then(Value::as_f64) {
                    settings.sensitivity = (v as f32).clamp(0.2, 4.0);
                }
                if let Some(v) = s.get("invertY").and_then(Value::as_bool) {
                    settings.invert_y = v;
                }
                if let Some(v) = s.get("detail").and_then(Value::as_f64) {
                    settings.detail = (v as f32).clamp(0.4, 4.0);
                    for mut m in &mut anchor {
                        m.0 = settings.detail;
                    }
                    for e in &anchors {
                        commands.entity(e).insert(TileSseMultiplier(settings.detail));
                    }
                }
            }
            Some("menu") => settings.menu_open = cmd.get("open").and_then(Value::as_bool).unwrap_or(false),
            // A place from the search box (place.js), or the end of the flight there.
            Some("flyto" | "flycancel") => travel.command(&cmd),
            // A flight from the planner (flight.js), and the cockpit's panels.
            Some("flight" | "flightend" | "fcu" | "fsys" | "simrate") => flight.0.push(cmd),
            Some("net") => {
                let from = cmd.get("from").and_then(Value::as_str).unwrap_or_default().to_owned();
                let name = cmd.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
                net.inbox.push((from, name, cmd["msg"].clone()));
            }
            // Point the free camera (for scripted views and tests): yaw and pitch in degrees, height in metres.
            Some("camera") if pilot.vehicle.is_none() => {
                if let Some(v) = cmd.get("yaw").and_then(Value::as_f64) {
                    pilot.yaw = (v as f32).to_radians();
                }
                if let Some(v) = cmd.get("pitch").and_then(Value::as_f64) {
                    pilot.pitch = (v as f32).to_radians();
                }
                if let Some(v) = cmd.get("height").and_then(Value::as_f64) {
                    fly_to_height = Some(v as f32);
                }
            }
            _ => {}
        }
    }
    if let Some(h) = fly_to_height {
        cam.translation.y = h;
    }
}

fn crosshair_ground(ray_cast: &mut MeshRayCast, vehicle_meshes: &Query<(), With<VehicleMesh>>, no_hit: &Query<(), With<NoHit>>, cam: &Transform) -> Option<Vec3> {
    let filter = |e: Entity| !vehicle_meshes.contains(e) && !no_hit.contains(e);
    let settings = MeshRayCastSettings::default().with_filter(&filter).with_visibility(RayCastVisibility::Visible);
    ray_cast.cast_ray(Ray3d::new(cam.translation, cam.forward()), &settings).first().filter(|(_, h)| h.distance < 3000.0).map(|(_, h)| h.point)
}

/// Spawns an asset where the crosshair meets the mesh: land and sea craft on that spot, aircraft above it at speed
/// (or on it, with `on_ground`).
#[allow(clippy::too_many_arguments)]
fn spawn(commands: &mut Commands, pilot: &mut Pilot, net: &mut Net, asset_server: &AssetServer, asset: &'static Asset, cam: &Transform, hit: Option<Vec3>, yaw: f32, on_ground: bool, side: Side) -> Entity {
    let ground = hit.unwrap_or(cam.translation + Quat::from_rotation_y(yaw) * Vec3::NEG_Z * 80.0 - Vec3::Y * 50.0);
    let airborne = (asset.kind.flies() || asset.kind == Kind::Heli) && !on_ground;
    let at = ground + Vec3::Y * if airborne { asset.airborne.0 } else { 0.5 };
    let mut vehicle = Vehicle::new(asset, yaw, airborne);
    vehicle.ground = ground.y;
    // Without a hit that ground is a guess under the camera.
    vehicle.ground_found = hit.is_some();
    vehicle.vid = net.vid();
    vehicle.side = side;
    if asset.kind.sails() {
        vehicle.water = Some(ground.y);
    }
    let model = asset_server.load(GltfAssetLabel::Scene(0).from_asset(asset.model()));
    let e = commands
        .spawn((Transform::from_translation(if asset.kind.sails() { ground } else { at }).with_rotation(Quat::from_rotation_y(yaw)), Visibility::default(), vehicle))
        .with_children(|c| {
            // glTF noses point along +Z, Bevy's forward is −Z.
            c.spawn((WorldAssetRoot(model), Transform::from_rotation(Quat::from_rotation_y(PI))));
        })
        .id();
    pilot.spawned.push(e);
    let side = if side == Side::Red { " · RED" } else { "" };
    pilot.say(format!("{}{side} {}", asset.label, if airborne { "AIRBORNE" } else { "READY" }));
    e
}

#[allow(clippy::too_many_arguments)]
fn spawn_hotkeys(
    mut commands: Commands,
    mut pilot: ResMut<Pilot>,
    mut net: ResMut<Net>,
    settings: Res<Settings>,
    keys: Res<ButtonInput<KeyCode>>,
    asset_server: Res<AssetServer>,
    cam: Single<&Transform, With<Tiles3dCamera>>,
    mut ray_cast: MeshRayCast,
    vehicle_meshes: Query<(), With<VehicleMesh>>,
    no_hit: Query<(), With<NoHit>>,
) {
    if pilot.vehicle.is_some() || pilot.foot.is_some() || settings.menu_open {
        return;
    }
    const DIGITS: [KeyCode; 9] = [KeyCode::Digit1, KeyCode::Digit2, KeyCode::Digit3, KeyCode::Digit4, KeyCode::Digit5, KeyCode::Digit6, KeyCode::Digit7, KeyCode::Digit8, KeyCode::Digit9];
    let on_ground = keys.pressed(KeyCode::ShiftLeft) || keys.pressed(KeyCode::ShiftRight);
    for (key, id) in DIGITS.iter().zip(catalog::HOTKEYS) {
        if keys.just_pressed(*key) {
            let Some(asset) = catalog::find(id) else { continue };
            let hit = crosshair_ground(&mut ray_cast, &vehicle_meshes, &no_hit, &cam);
            spawn(&mut commands, &mut pilot, &mut net, &asset_server, asset, &cam, hit, yaw_of(cam.rotation), on_ground, Side::Blue);
        }
    }
}

fn grab_cursor(mut pilot: ResMut<Pilot>, settings: Res<Settings>, buttons: Res<ButtonInput<MouseButton>>, mut cursor: Single<&mut CursorOptions, With<PrimaryWindow>>) {
    let was = pilot.locked;
    // The browser releases the pointer on Esc (or when a menu opens) without telling the window: ask it.
    pilot.locked = cursor.grab_mode == CursorGrabMode::Locked && js::pointer_locked();
    if !pilot.locked && cursor.grab_mode == CursorGrabMode::Locked && (was || settings.menu_open) {
        cursor.grab_mode = CursorGrabMode::None;
        cursor.visible = true;
    }
    pilot.just_locked = false;
    if !pilot.locked && !settings.menu_open && buttons.just_pressed(MouseButton::Left) {
        cursor.grab_mode = CursorGrabMode::Locked;
        cursor.visible = false;
        pilot.just_locked = true;
    }
}

#[allow(clippy::too_many_arguments)]
fn keys(
    mut pilot: ResMut<Pilot>,
    settings: Res<Settings>,
    pad: Res<Pad>,
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    scroll: Res<AccumulatedMouseScroll>,
    mut vehicles: Query<(Entity, &Transform, &mut Vehicle)>,
    cam: Single<&Transform, (With<Tiles3dCamera>, Without<Vehicle>)>,
    parts: Query<(&Part, &GlobalTransform)>,
    mut ray_cast: MeshRayCast,
    vehicle_meshes: Query<&VehicleMesh>,
    no_hit: Query<(), With<NoHit>>,
    mut commands: Commands,
    flights: Query<(), With<flight::Aircraft>>,
) {
    if settings.menu_open {
        return;
    }
    let piloted = pilot.vehicle.and_then(|e| vehicles.get(e).ok()).map(|(_, _, v)| v.kind);
    let has_sight = pilot.vehicle.and_then(|e| vehicles.get(e).ok()).is_some_and(|(_, _, v)| v.kind.drives() && v.asset.turret.is_some());
    // A key, or the controller action standing for it.
    let hit = |key: KeyCode, action: &str| keys.just_pressed(key) || pad.pressed(action);
    if hit(KeyCode::KeyV, "view") && piloted.is_some() {
        let has_camera = matches!(piloted, Some(Kind::Uav));
        let has_station = pilot.vehicle.is_some_and(|e| station::has_station(&parts, e));
        pilot.view = match pilot.view {
            View::Chase => View::Cockpit,
            View::Cockpit if has_station => View::HeadUp,
            View::Cockpit | View::HeadUp if has_camera => View::Gimbal,
            View::Cockpit | View::HeadUp if has_sight => View::Sight,
            _ => View::Chase,
        };
        let name = match pilot.view {
            View::Chase => "CHASE VIEW",
            View::Cockpit => "COCKPIT VIEW",
            View::HeadUp => "HUD VIEW",
            View::Sight => "GUNNER'S SIGHT",
            View::Gimbal => "CAMERA VIEW",
        };
        pilot.say(name);
        pilot.orbit = Vec2::ZERO;
        if pilot.view == View::Gimbal {
            pilot.pitch = -0.6;
        }
        pilot.zoom = if pilot.view == View::Sight { 3.0 } else { 1.0 };
    }
    if (keys.just_pressed(KeyCode::KeyT) || pad.pressed("alt")) && pilot.view == View::Gimbal {
        pilot.infrared = !pilot.infrared;
        js::set_class("canvas", if pilot.infrared { "ir" } else { "" });
    }
    // Magnification in a gunner's sight and a drone's camera.
    if piloted.is_some() && matches!(pilot.view, View::Gimbal | View::Sight) {
        let notches = scroll_notches(&scroll) + pad.zoom * 4.0 * time.delta_secs();
        pilot.zoom = (pilot.zoom * 1.25_f32.powf(notches)).clamp(1.0, 30.0);
    }
    // (On foot, F is `infantry`'s: into a vehicle close by.)
    if hit(KeyCode::KeyF, "enter") && pilot.foot.is_none() {
        if let Some(e) = pilot.vehicle {
            // Out: the free camera carries on from where the view was; the vehicle carries on hands off.
            let (yaw, pitch, _) = cam.rotation.to_euler(EulerRot::YXZ);
            pilot.leave();
            pilot.yaw = yaw;
            pilot.pitch = pitch;
            if let Ok((_, _, v)) = vehicles.get(e) {
                pilot.say(format!("OUT OF {}", v.asset.label));
            }
        } else {
            // In: the vehicle nearest the crosshair (by angle) within 3 km.
            let nearest = vehicles
                .iter()
                .filter(|(_, tf, v)| !v.is_remote() && tf.translation.distance(cam.translation) < 3000.0)
                .map(|(e, tf, v)| (e, cam.forward().angle_between(tf.translation - cam.translation), v.asset.label, v.yaw(tf)))
                .min_by(|a, b| a.1.total_cmp(&b.1));
            if let Some((e, _, label, yaw)) = nearest {
                pilot.vehicle = Some(e);
                pilot.yaw = yaw;
                pilot.pitch = -0.12;
                pilot.orbit = Vec2::ZERO;
                pilot.view = View::Chase;
                pilot.say(label);
            }
        }
    }
    if keys.just_pressed(KeyCode::Backspace) && pilot.vehicle.is_none() {
        if let Some(e) = pilot.spawned.pop() {
            commands.entity(e).despawn();
        }
    }
    let Some(e) = pilot.vehicle else { return };
    // A flight's aircraft has its own flight deck keys (`flight::fly`).
    if flight::flying(&flights, e) {
        return;
    }
    let Ok((_, tf, mut v)) = vehicles.get_mut(e) else { return };
    match v.kind {
        // The controller's action button is the gear, except in a drone's camera view, where it designates.
        Kind::Jet | Kind::Uav if v.has_gear() && (keys.just_pressed(KeyCode::KeyG) || pad.pressed("action") && pilot.view != View::Gimbal) => {
            if v.on_ground {
                pilot.say("GEAR: WEIGHT ON WHEELS");
            } else {
                v.gear_down = !v.gear_down;
                pilot.say(if v.gear_down { "GEAR DOWN" } else { "GEAR UP" });
            }
        }
        // Y: the swing wings to the next stop, and from the last back to the automatic schedule.
        Kind::Jet if keys.just_pressed(KeyCode::KeyY) && v.asset.sweep.is_some() => {
            let sw = v.asset.sweep.unwrap();
            v.sweep_stop = match v.sweep_stop {
                None => Some(0),
                Some(i) if i + 1 < sw.stops.len() => Some(i + 1),
                Some(_) => None,
            };
            pilot.say(match v.sweep_stop {
                Some(i) => format!("WINGS {}°", sw.stops[i]),
                None => "WINGS AUTO".to_string(),
            });
        }
        Kind::Tank => {
            // 1/2 load a type; the controller's alternate button swaps.
            let swap = pad.pressed("alt").then_some(if v.ammo == Ammo::Apfsds { Ammo::He } else { Ammo::Apfsds });
            for (key, ammo) in [(KeyCode::Digit1, Ammo::Apfsds), (KeyCode::Digit2, Ammo::He)] {
                if (keys.just_pressed(key) || swap == Some(ammo)) && v.ammo != ammo {
                    v.ammo = ammo;
                    v.cooldown = 5.0;
                    pilot.say(format!("LOADING {}", ammo.label()));
                }
            }
        }
        Kind::Wheeled if v.asset.has_erector() && hit(KeyCode::KeyE, "action") => {
            v.erector_up = !v.erector_up;
            pilot.say(if v.erector_up { "ERECTOR UP · STABILISERS DOWN" } else { "ERECTOR STOWED" });
        }
        _ => {}
    }
    // Laser rangefinder (a gunner's sight) or designator (a drone's camera), along the line of sight.
    if (keys.just_pressed(KeyCode::KeyR) || pad.pressed("action")) && v.asset.turret.is_some() {
        let sight = parts.iter().find(|(p, _)| p.vehicle == e && p.role == Role::Sight).map_or(tf.translation + Vec3::Y * 2.5, |(_, g)| g.translation());
        let dir = look(v.heading + v.turret, v.hull_pitch + v.gun) * Vec3::NEG_Z;
        let filter = |x: Entity| !no_hit.contains(x) && vehicle_meshes.get(x).map_or(true, |m| m.0 != e);
        let settings = MeshRayCastSettings::default().with_filter(&filter).with_visibility(RayCastVisibility::Visible);
        v.range = Dir3::new(dir).ok().and_then(|d| ray_cast.cast_ray(Ray3d::new(sight, d), &settings).first().map(|(_, h)| h.distance)).filter(|r| *r < 8000.0);
        pilot.say(v.range.map_or("LASER: NO RETURN".into(), |r| format!("RANGE {r:.0} M")));
    }
    if (keys.just_pressed(KeyCode::KeyL) || pad.pressed("action") && pilot.view == View::Gimbal) && v.kind == Kind::Uav {
        let filter = |x: Entity| !vehicle_meshes.contains(x) && !no_hit.contains(x);
        let settings = MeshRayCastSettings::default().with_filter(&filter).with_visibility(RayCastVisibility::Visible);
        pilot.designated = ray_cast.cast_ray(Ray3d::new(cam.translation, cam.forward()), &settings).first().map(|(_, h)| h.point);
        let text = if pilot.designated.is_some() { "TARGET DESIGNATED" } else { "LASER: NO RETURN" };
        pilot.say(text);
    }
}

/// The vehicle an entity of a spawned model belongs to.
fn vehicle_of(mut e: Entity, parents: &Query<&ChildOf>, vehicles: &Query<(), With<Vehicle>>) -> Option<Entity> {
    for _ in 0..64 {
        if vehicles.contains(e) {
            return Some(e);
        }
        e = parents.get(e).ok()?.parent();
    }
    None
}

fn tag_parts(
    mut commands: Commands,
    named: Query<(Entity, &Name, &Transform, Option<&GltfExtras>), Added<Name>>,
    new_meshes: Query<Entity, (Added<Mesh3d>, Without<NoHit>)>,
    parents: Query<&ChildOf>,
    vehicles: Query<(), With<Vehicle>>,
) {
    for (e, name, tf, extras) in &named {
        let extras = extras.and_then(|x| serde_json::from_str::<Value>(&x.value).ok());
        let Some(role) = Role::of(name.as_str(), extras.as_ref()) else { continue };
        if let Some(vehicle) = vehicle_of(e, &parents, &vehicles) {
            commands.entity(e).insert(Part { vehicle, role, rest: *tf });
            let corners = extras.as_ref().and_then(|x| x.get("corners")).and_then(Value::as_array).map(|c| c.iter().filter_map(|p| Some(Vec3::new(p.get(0)?.as_f64()? as f32, p.get(1)?.as_f64()? as f32, p.get(2)?.as_f64()? as f32))).collect::<Vec<_>>());
            if let (Role::Combiner, Some(Ok(corners))) = (role, corners.map(<[Vec3; 4]>::try_from)) {
                commands.entity(e).insert(station::Combiner(corners));
            }
        }
    }
    for e in &new_meshes {
        if let Some(vehicle) = vehicle_of(e, &parents, &vehicles) {
            commands.entity(e).insert(VehicleMesh(vehicle));
        }
    }
}

/// Each vehicle's extent in its own frame, from its meshes' bounding boxes, once they have them, and the extent of
/// those that reach down to its bottom (its footprint on the ground).
fn measure_vehicles(mut vehicles: Query<(Entity, &GlobalTransform, &mut Vehicle)>, meshes: Query<(&VehicleMesh, &Aabb, &GlobalTransform)>) {
    let mut boxes: HashMap<Entity, Vec<(Vec3, Vec3)>> = HashMap::new();
    for (VehicleMesh(v), aabb, gt) in &meshes {
        let Ok((_, vgt, vehicle)) = vehicles.get(*v) else { continue };
        if vehicle.bounds.is_some() {
            continue;
        }
        let to_local = vgt.affine().inverse() * gt.affine();
        let (c, h) = (Vec3::from(aabb.center), Vec3::from(aabb.half_extents));
        let mut b = (Vec3::MAX, Vec3::MIN);
        for i in 0..8 {
            let s = Vec3::new(if i & 1 == 0 { -1.0 } else { 1.0 }, if i & 2 == 0 { -1.0 } else { 1.0 }, if i & 4 == 0 { -1.0 } else { 1.0 });
            let p = to_local.transform_point3(c + h * s);
            b = (b.0.min(p), b.1.max(p));
        }
        boxes.entry(*v).or_default().push(b);
    }
    for (e, _, mut vehicle) in &mut vehicles {
        if let Some(boxes) = boxes.remove(&e) {
            let union = |boxes: &mut dyn Iterator<Item = &(Vec3, Vec3)>| boxes.fold((Vec3::MAX, Vec3::MIN), |a, b| (a.0.min(b.0), a.1.max(b.1)));
            let all = union(&mut boxes.iter());
            vehicle.bounds = Some(all);
            vehicle.footprint = Some(union(&mut boxes.iter().filter(|b| b.0.y < all.0.y + 0.25)));
        }
    }
}

// ---- controls and free flight -----------------------------------------------------------------------------------

/// How far a helicopter's look may lead its nose (rad): the pedals hold the heading, so this sets how hard it turns.
const HELI_LEAD: f32 = 0.6;
/// Aircraft stick: deflection per pixel of mouse travel, how fast it springs back to the middle (1/s), and how fast the
/// arrow keys move it (full travel per second). A steady 2,000 px/s holds it fully over, as a hard flick would.
const MOUSE_STICK: f32 = 0.0025;
const STICK_RETURN: f32 = 5.0;
const KEY_STICK_RATE: f32 = 4.0;
/// How quickly the chase camera catches up with an aircraft's rotation (1/s): slow enough that a pull or a roll shows
/// on screen before the view follows it.
const CHASE_FOLLOW: f32 = 5.0;

#[allow(clippy::too_many_arguments)]
fn read_controls(
    pilot: Res<Pilot>,
    settings: Res<Settings>,
    pad: Res<Pad>,
    keys: Res<ButtonInput<KeyCode>>,
    buttons: Res<ButtonInput<MouseButton>>,
    motion: Res<AccumulatedMouseMotion>,
    time: Res<Time>,
    vehicles: Query<(&Vehicle, &Transform)>,
    mut c: ResMut<Controls>,
) {
    // Right-drag turns the camera in both external and seated aircraft views.
    // Looking around must never feed an unintended pitch/roll input to the stick.
    let m = if matches!(pilot.view, View::Chase | View::Cockpit | View::HeadUp) && buttons.pressed(MouseButton::Right) { Vec2::ZERO } else { mouse(&pilot, &settings, &motion) };
    let dt = time.delta_secs();
    let live = !settings.menu_open;
    // The controller needs no captured mouse.
    c.fire = live && (pilot.locked && !pilot.just_locked && buttons.pressed(MouseButton::Left) || pad.fire);
    c.fire_pressed = live && (pilot.locked && !pilot.just_locked && buttons.just_pressed(MouseButton::Left) || pad.pressed("fire"));
    c.detonate = live && (keys.just_pressed(KeyCode::KeyX) || pad.pressed("action"));
    c.vehicle = None;
    let Some((e, v, tf)) = pilot.vehicle.and_then(|e| vehicles.get(e).ok().map(|(v, tf)| (e, v, tf))) else { return };
    c.vehicle = Some(e);
    let k = |pos, neg| if live { axis(&keys, pos, neg) } else { 0.0 };
    match v.kind {
        Kind::Jet | Kind::Uav | Kind::Munition => {
            // Mouse movement pushes the stick, which springs back to the middle once the mouse rests: the faster it
            // moves, the harder the pull, measured in distance (so the same at any frame rate) and without the jerk
            // of a new stick every frame. The arrows move the stick at a hand's pace rather than slamming it over.
            // Controller: stick forward is nose down, the triggers move the throttle, the bumpers the rudder.
            c.mouse_stick = ((c.mouse_stick + Vec2::new(m.x, -m.y) * MOUSE_STICK) * (-STICK_RETURN * dt).exp()).clamp(Vec2::NEG_ONE, Vec2::ONE);
            let keys_want = Vec2::new(k(KeyCode::ArrowRight, KeyCode::ArrowLeft), k(KeyCode::ArrowDown, KeyCode::ArrowUp));
            let key_step = Vec2::splat(KEY_STICK_RATE * dt);
            c.key_stick = c.key_stick + (keys_want - c.key_stick).clamp(-key_step, key_step);
            // Finer about the middle, for small corrections.
            let mouse_stick = c.mouse_stick * (0.6 + 0.4 * c.mouse_stick * c.mouse_stick);
            let stick = mouse_stick + c.key_stick + Vec2::new(pad.stick.x, -pad.stick.y);
            c.brake = live && (keys.pressed(KeyCode::KeyB) || pad.brake);
            c.stick = Stick {
                pitch: stick.y.clamp(-1.0, 1.0),
                roll: stick.x.clamp(-1.0, 1.0),
                yaw: (k(KeyCode::KeyA, KeyCode::KeyD) - pad.bumper).clamp(-1.0, 1.0),
                throttle: (v.throttle + (k(KeyCode::KeyW, KeyCode::KeyS) + pad.trigger) * 0.45 * dt).clamp(0.0, 1.0),
                path_hold: true,
                speedbrake: if c.brake { 1.0 } else { 0.0 },
            };
        }
        Kind::Heli => {
            // The pedals turn the nose to where the pilot looks (the mouse, or Q/E: `fly_free`), so W flies that
            // way. In forward flight the cyclic banks into the turn, as a pilot would, rather than skidding round.
            let pedal = (wrap(pilot.yaw - yaw_of(tf.rotation)) * 3.0 - v.omega.y * 0.5).clamp(-1.0, 1.0);
            let speed = v.velocity.dot(tf.forward().with_y(0.0).normalize_or_zero()).max(0.0);
            let coordinated = -(speed * v.omega.y / physics::G).atan() / physics::NH90.max_bank;
            c.cyclic = Cyclic {
                forward: (k(KeyCode::KeyW, KeyCode::KeyS) + pad.stick.y).clamp(-1.0, 1.0),
                right: (k(KeyCode::KeyD, KeyCode::KeyA) + pad.stick.x + coordinated.clamp(-0.8, 0.8)).clamp(-1.0, 1.0),
                pedal,
                collective: (v.collective + (k(KeyCode::Space, KeyCode::KeyC) + pad.trigger) * 0.35 * dt).clamp(0.0, 1.0),
            };
        }
        Kind::Tank | Kind::Wheeled => {
            // Controller: the triggers drive (or the left stick, forward and back), the left stick steers.
            let pad_drive = if pad.trigger.abs() > 0.02 { pad.trigger } else { pad.stick.y };
            c.drive = (k(KeyCode::KeyW, KeyCode::KeyS) + pad_drive).clamp(-1.0, 1.0);
            c.steer = (k(KeyCode::KeyA, KeyCode::KeyD) - pad.stick.x).clamp(-1.0, 1.0);
            c.brake = live && (keys.pressed(KeyCode::Space) || pad.brake);
        }
        Kind::Ship | Kind::Uuv => {
            // Engine order and rudder are set and stay set, as on a ship's telegraph.
            let pad_order = if pad.trigger.abs() > 0.02 { pad.trigger } else { pad.stick.y };
            c.drive = (v.throttle + (k(KeyCode::KeyW, KeyCode::KeyS) + pad_order) * 0.4 * dt).clamp(-0.5, 1.0);
            c.steer = (k(KeyCode::KeyA, KeyCode::KeyD) - pad.stick.x).clamp(-1.0, 1.0);
            c.brake = false;
        }
    }
}

#[allow(clippy::too_many_arguments)]
/// How long the camera watches a lost vehicle's end before handing back free flight (s).
const AFTERMATH: f32 = 10.0;

fn fly_free(
    mut pilot: ResMut<Pilot>,
    settings: Res<Settings>,
    pad: Res<Pad>,
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    motion: Res<AccumulatedMouseMotion>,
    scroll: Res<AccumulatedMouseScroll>,
    buttons: Res<ButtonInput<MouseButton>>,
    vehicles: Query<(&Vehicle, &Transform), Without<Tiles3dCamera>>,
    mut cam: Single<&mut Transform, With<Tiles3dCamera>>,
    frame: Res<Frame>,
    mut ray_cast: MeshRayCast,
    meshes: Query<&VehicleMesh>,
    no_hit: Query<(), With<NoHit>>,
) {
    let m = mouse(&pilot, &settings, &motion);
    // The mouse looks when it is not flying something: free camera, chase orbit, turret aim, gimbal, head.
    let piloted = pilot.vehicle.and_then(|e| vehicles.get(e).ok()).map(|(v, _)| v.kind);
    let dt = time.delta_secs();
    // Just lost the vehicle: watch the explosion from above, circling slowly and drawing back, until the player moves,
    // looks or gets into something (or it is over).
    if let Some(a) = pilot.aftermath.as_mut() {
        a.age += dt;
        let moved = !settings.menu_open
            && ([KeyCode::KeyW, KeyCode::KeyA, KeyCode::KeyS, KeyCode::KeyD, KeyCode::Space, KeyCode::KeyC].iter().any(|k| keys.pressed(*k))
                || pad.stick.length() > 0.2
                || pad.trigger.abs() > 0.2
                || pad.look.length() > 0.2
                || m.length() > 2.0);
        if piloted.is_some() || moved || a.age > AFTERMATH {
            pilot.aftermath = None;
            let (yaw, pitch, _) = cam.rotation.to_euler(EulerRot::YXZ);
            pilot.yaw = yaw;
            pilot.pitch = pitch;
        } else {
            let offset = Quat::from_rotation_y(0.05 * a.age) * (a.eye - a.at) * (1.0 + 0.02 * a.age);
            cam.translation = a.at + offset;
            cam.look_at(a.at + Vec3::Y * a.lift, Vec3::Y);
            return;
        }
    }
    let mouse_looks = match piloted {
        Some(Kind::Jet | Kind::Munition) => false,
        Some(Kind::Uav) => pilot.view == View::Gimbal,
        _ => true,
    };
    // In a helicopter the look is where it flies (`read_controls` yaws it round to face it); with the right button
    // held the mouse looks around instead, and on letting go the view swings back.
    let free_look = piloted == Some(Kind::Heli) && buttons.pressed(MouseButton::Right) && !settings.menu_open;
    if piloted == Some(Kind::Heli) {
        if free_look {
            pilot.orbit.x = wrap(pilot.orbit.x - m.x * 0.0025);
            pilot.orbit.y = (pilot.orbit.y - m.y * 0.0025).clamp(-1.2, 1.2);
        } else {
            pilot.orbit *= 1.0 - (6.0 * dt).min(1.0);
        }
    }
    if mouse_looks && !free_look {
        // Mouse movement, plus the controller's right stick as a rate (up to ~130°/s at full deflection).
        let s = 0.0025 / pilot.zoom;
        let pad_rate = 2.3 * dt / pilot.zoom;
        pilot.yaw = wrap(pilot.yaw - m.x * s - pad.look.x * pad_rate);
        pilot.pitch = (pilot.pitch - m.y * s + pad.look.y * pad_rate).clamp(-1.55, 1.2);
    }
    // The chase camera: the wheel (or the controller's zoom) sets its distance. Around an aircraft, whose stick the
    // mouse is, the mouse turns it while the right button is held, and so does the right stick. The middle button
    // puts it back behind, at the default distance.
    if let Some((v, _)) = pilot.vehicle.and_then(|e| vehicles.get(e).ok())
        && pilot.view == View::Chase
        && !settings.menu_open
    {
        let (default, closest) = v.chase_distance();
        let notches = scroll_notches(&scroll) + pad.zoom * 4.0 * dt;
        pilot.chase_zoom = (pilot.chase_zoom * 1.15_f32.powf(-notches)).clamp(closest / default, 8.0);
        if matches!(v.kind, Kind::Jet | Kind::Uav | Kind::Munition) {
            let m = if buttons.pressed(MouseButton::Right) { m } else { Vec2::ZERO };
            pilot.orbit.x = wrap(pilot.orbit.x - m.x * 0.0025 - pad.look.x * 2.3 * dt);
            pilot.orbit.y = (pilot.orbit.y - m.y * 0.0025 + pad.look.y * 2.3 * dt).clamp(-1.4, 1.4);
        }
        if pilot.locked && buttons.just_pressed(MouseButton::Middle) {
            pilot.orbit = Vec2::ZERO;
            pilot.chase_zoom = 1.0;
        }
    }
    // Seated head look uses the same drag and gamepad stick as the chase orbit,
    // with comfortable neck limits and a middle-click to return to the instruments.
    if matches!(piloted, Some(Kind::Jet | Kind::Uav))
        && matches!(pilot.view, View::Cockpit | View::HeadUp)
        && !settings.menu_open
    {
        let drag = if buttons.pressed(MouseButton::Right) { m } else { Vec2::ZERO };
        pilot.orbit = cockpit_look(pilot.orbit, drag, pad.look, dt);
        if pilot.locked && buttons.just_pressed(MouseButton::Middle) {
            pilot.orbit = Vec2::ZERO;
        }
    }
    // The pedals (Q/E, the controller's bumpers) turn the look, and with it the helicopter. The look leads the nose
    // by no more than a turn's worth, so the helicopter answers at once when the mouse turns back.
    if let Some((v, tf)) = pilot.vehicle.and_then(|e| vehicles.get(e).ok())
        && v.kind == Kind::Heli
    {
        let pedal = if settings.menu_open { 0.0 } else { axis(&keys, KeyCode::KeyQ, KeyCode::KeyE) - pad.bumper };
        let heading = yaw_of(tf.rotation);
        let lead = wrap(pilot.yaw + pedal * physics::NH90.yaw_rate * dt - heading).clamp(-HELI_LEAD, HELI_LEAD);
        pilot.yaw = wrap(heading + lead);
    }
    // On foot the look is all: `infantry` walks.
    if piloted.is_some() || pilot.foot.is_some() || settings.menu_open {
        return;
    }
    // The wheel sets the cruise speed; so do the controller's bumpers.
    pilot.speed = (pilot.speed * 1.2_f32.powf(scroll_notches(&scroll)) * 3.0_f32.powf(pad.bumper * dt)).clamp(2.0, 3000.0);
    let rot = look(pilot.yaw, pilot.pitch);
    let dir = rot * Vec3::new(axis(&keys, KeyCode::KeyD, KeyCode::KeyA) + pad.stick.x, 0.0, -axis(&keys, KeyCode::KeyW, KeyCode::KeyS) - pad.stick.y)
        + Vec3::Y * (axis(&keys, KeyCode::Space, KeyCode::KeyC) + pad.trigger);
    let boost = if keys.pressed(KeyCode::ShiftLeft) || keys.pressed(KeyCode::ShiftRight) || pad.boost { 5.0 } else { 1.0 };
    let boost = boost * globe::speed_scale(frame.altitude(cam.translation));
    // Analogue: a half-pushed stick moves at half speed.
    let len = dir.length();
    // Solid: it slides along buildings, models and the ground rather than into them (`collide`).
    let step = if len > 1.0 { dir / len } else { dir } * pilot.speed * boost * dt;
    cam.translation = collide::move_free_camera(&mut ray_cast, &meshes, &no_hit, cam.translation, step);
    cam.rotation = rot;
}

// ---- ground, air, land and sea ----------------------------------------------------------------------------------

/// The ground under a land vehicle, as a plane in its hull frame (x right, z rear): the height under its middle and
/// the rise per metre to the right and to the rear.
#[derive(Clone, Copy, Debug, PartialEq)]
struct GroundPlane {
    height: f32,
    right: f32,
    back: f32,
}

impl GroundPlane {
    fn at(&self, x: f32, z: f32) -> f32 {
        self.height + self.right * x + self.back * z
    }
    /// The hull's pitch (nose up) and bank (left side up) lying on it, for the yaw, pitch, roll it is posed with.
    fn attitude(&self) -> (f32, f32) {
        let pitch = (-self.back).atan();
        (pitch, (-self.right * pitch.cos()).atan())
    }
    /// The least-squares plane through the points (hull x and z, height). With fewer than three, or all of them along
    /// one line, it keeps the slope of `last` (level without one) across what they do not span.
    fn fit(points: &[Option<Vec3>], last: Option<GroundPlane>) -> Option<GroundPlane> {
        let points: Vec<Vec3> = points.iter().flatten().copied().collect();
        if points.is_empty() {
            return None;
        }
        let (mut a, mut b) = (Mat3::ZERO, Vec3::ZERO);
        for p in &points {
            let row = Vec3::new(1.0, p.x, p.z);
            a += Mat3::from_cols(row * row.x, row * row.y, row * row.z);
            b += row * p.y;
        }
        if a.determinant().abs() > 1e-3 * points.len() as f32 {
            let s = a.inverse() * b;
            return Some(GroundPlane { height: s.x, right: s.y, back: s.z });
        }
        let (right, back) = last.map_or((0.0, 0.0), |l| (l.right, l.back));
        let height = points.iter().map(|p| p.y - right * p.x - back * p.z).sum::<f32>() / points.len() as f32;
        Some(GroundPlane { height, right, back })
    }
}

/// The plane of the ground under the running gear. The mesh has trees, cars and kerbs baked into it: a point more
/// than 1 m above the plane through the others, with the point across the hull from it not as high, is such a lone
/// bump and is dropped (twice at most). A crest under both tracks stays: the hull rides up on it.
fn ground_under(contacts: &mut [Option<Vec3>; 6], last: Option<GroundPlane>) -> Option<GroundPlane> {
    for _ in 0..2 {
        let plane = GroundPlane::fit(contacts, last)?;
        let Some((i, _)) = contacts.iter().enumerate().filter_map(|(i, p)| p.map(|p| (i, p.y - plane.at(p.x, p.z)))).max_by(|a, b| a.1.total_cmp(&b.1)) else { break };
        let mut others = *contacts;
        others[i] = None;
        let Some(without) = GroundPlane::fit(&others, last) else { break };
        let above = |p: Option<Vec3>| p.map_or(0.0, |p| p.y - without.at(p.x, p.z));
        let (bump, across) = (above(contacts[i]), above(contacts[(i + 3) % 6]));
        if bump <= 1.0 || across >= 0.5 * bump {
            return Some(plane);
        }
        contacts[i] = None;
    }
    GroundPlane::fit(contacts, last)
}

/// Rays down onto the mesh: one under an aircraft, six under a land vehicle's running gear (its suspension, which
/// `settle_ground` then sets on them). Parked vehicles are probed twice a second, moving ones every frame; ships keep
/// the water level they were launched on.
fn probe_ground(time: Res<Time>, mut vehicles: Query<(Entity, &Transform, &mut Vehicle)>, mut ray_cast: MeshRayCast, meshes: Query<&VehicleMesh>, no_hit: Query<(), With<NoHit>>) {
    for (e, tf, mut v) in &mut vehicles {
        if v.kind.sails() || v.is_remote() {
            continue;
        }
        // Other vehicles' models are ground too: a helicopter can set down on a ship, a jet crashes on a truck.
        let filter = collide::solid_for(Some(e), &meshes, &no_hit);
        let settings = MeshRayCastSettings::default().with_filter(&filter).with_visibility(RayCastVisibility::Visible).always_early_exit();
        let mut down = |from: Vec3| ray_cast.cast_ray(Ray3d::new(from, Dir3::NEG_Y), &settings).first().map(|(_, h)| h.point.y);
        v.probe_in -= time.delta_secs();
        let moving = v.velocity.length_squared() > 0.01 || v.speed.abs() > 0.05 || v.fall > 0.0;
        if !moving && v.probe_in > 0.0 {
            continue;
        }
        v.probe_in = 0.5;
        let (min, _) = v.bounds();
        if v.kind.drives() {
            let rot = Quat::from_rotation_y(v.heading);
            let mut contacts = [None; 6];
            for (i, p) in v.contact_points().into_iter().enumerate() {
                let at = tf.translation + rot * p;
                // From 2 m above where the ground was (the plane last found, else the hull's bottom), so canopies and
                // street furniture over it don't count, however steep the slope; higher up only if that misses (the
                // mesh refined upward, or it climbed a step).
                let expected = at.with_y(v.ground_plane.map_or(tf.translation.y + min.y, |g| g.at(p.x, p.z)));
                contacts[i] = down(expected + Vec3::Y * 2.0).or_else(|| down(expected + Vec3::Y * 8.0)).or_else(|| down(expected + Vec3::Y * 400.0)).map(|y| p.with_y(y));
            }
            if let Some(plane) = ground_under(&mut contacts, v.ground_plane) {
                v.contacts = contacts;
                v.ground_plane = Some(plane);
                v.ground = plane.height;
                v.ground_found = true;
            }
        } else {
            // Nothing below: the tiles there are out of view. The last ground found still holds up what stands on it.
            let g = down(tf.translation + Vec3::Y * (3.0 - min.y)).or_else(|| down(tf.translation + Vec3::Y * 400.0));
            v.ground_found = g.is_some();
            if let Some(g) = g {
                v.ground = g;
            }
        }
        v.agl = tf.translation.y + min.y - v.ground;
        v.hazard_probe_in -= time.delta_secs();
        if v.hazard_probe_in <= 0.0 {
            v.hazard_probe_in = 0.2;
            v.terrain_tti = None;
            let speed = v.velocity.length();
            if v.kind.flies() && !v.on_ground && speed > 15.0 {
                if let Ok(direction) = Dir3::new(v.velocity) {
                    let settings = MeshRayCastSettings::default().with_filter(&filter).with_visibility(RayCastVisibility::Visible);
                    let right = tf.rotation * Vec3::X;
                    for offset in [-2.0, 0.0, 2.0] {
                        let from = tf.translation + right * offset;
                        if let Some((_, hit)) = ray_cast.cast_ray(Ray3d::new(from, direction), &settings).first() {
                            // Allow a gentle gear-down touchdown on a nearly level surface.
                            let landing = v.gear_down && v.agl < 60.0 && v.velocity.y > -3.0 && hit.normal.y > 0.85;
                            let seconds = hit.distance / speed;
                            if !landing && seconds < 12.0 {
                                v.terrain_tti = Some(v.terrain_tti.map_or(seconds, |old| old.min(seconds)));
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Fixed-wing aircraft. The one being flown takes the controls; the others fly on hands off (holding the flight
/// path), and an uncrewed one circles while its camera is in use. Wind moves the air they fly in.
#[allow(clippy::too_many_arguments)]
fn fly_aircraft(
    time: Res<Time>,
    pilot: Res<Pilot>,
    c: Res<Controls>,
    frame: Res<Frame>,
    weather: Res<Weather>,
    mut vehicles: Query<(Entity, &mut Transform, &mut Vehicle), Without<flight::Aircraft>>,
    mut ray_cast: MeshRayCast,
    meshes: Query<&VehicleMesh>,
    no_hit: Query<(), With<NoHit>>,
) {
    let dt = time.delta_secs().min(0.05);
    let wind = weather.wind();
    for (e, mut tf, mut v) in &mut vehicles {
        let Some(spread) = v.asset.airframe else { continue };
        // A swing wing flies an airframe between its spread and swept figures.
        let af = &match v.asset.sweep {
            Some(sw) => physics::blend(spread, sw.swept, (v.sweep_deg - sw.min_deg) / (sw.max_deg - sw.min_deg)),
            None => *spread,
        };
        if v.is_remote() {
            continue;
        }
        let flown = pilot.vehicle == Some(e) && c.vehicle == Some(e);
        let mut stick = if flown { c.stick } else { Stick { throttle: v.throttle, path_hold: true, ..default() } };
        if flown && pilot.view == View::Gimbal {
            // Loiter: a 25° bank, holding the path, cruise power.
            let (_, bank) = physics::attitude(tf.rotation);
            stick = Stick { roll: ((0.44 - bank) * 2.0).clamp(-1.0, 1.0), throttle: 0.55, path_hold: true, ..default() };
        }
        v.throttle = stick.throttle;
        if v.on_ground && stick.throttle < 0.05 && v.velocity.length() < 0.5 {
            v.velocity = Vec3::ZERO;
            v.air = AirData::default();
            continue;
        }
        let alt = frame.altitude(tf.translation);
        let air_wind = if v.on_ground { Vec3::ZERO } else { wind };
        let (mut velocity, mut omega) = (v.velocity, v.omega);
        const STEPS: u32 = 4;
        for _ in 0..STEPS {
            v.air = physics::step_airframe(af, &mut tf, &mut velocity, &mut omega, stick, v.gear_down, alt, air_wind, dt / STEPS as f32);
        }
        v.velocity = velocity;
        v.omega = omega;
        if v.asset.id != "c172" { v.rotor_rate = 20.0 + 60.0 * stick.throttle; }

        // Ground: roll on the gear, or crash. Touchdown is judged once; rolling, the wheels follow the ground down
        // over kerbs and dips (a car or a lamp post under the fuselage lifts the ground ray for a moment) until the
        // wings lift the aircraft off or it runs off a real drop.
        let (min, _) = v.bounds();
        let bottom = tf.translation.y + min.y;
        v.agl = bottom - v.ground;
        let rolling = v.on_ground && v.velocity.y <= 0.0 && v.agl < 4.0;
        if (v.ground_found && bottom <= v.ground + 0.05) || rolling {
            let (pitch, bank) = physics::attitude(tf.rotation);
            let sink = -v.velocity.y;
            let lands = match v.kind {
                Kind::Munition => false,
                _ if v.on_ground => true,
                _ if v.asset.id == "vector" => v.velocity.length() < 14.0 && sink < 3.0,
                _ => v.gear_down && sink < 5.0 && bank.abs() < 0.35 && pitch > -0.15,
            };
            if !lands {
                v.destroyed = Some(if v.kind == Kind::Munition { "IMPACT" } else { "CRASHED" });
                continue;
            }
            v.on_ground = true;
            v.agl = 0.0;
            tf.translation.y = v.ground - min.y;
            let yaw = yaw_of(tf.rotation);
            let steer = if flown { stick.yaw * 0.5 * (v.velocity.length() / 15.0).min(1.0) * dt } else { 0.0 };
            tf.rotation = Quat::from_euler(EulerRot::YXZ, yaw + steer, pitch.clamp(0.0, 0.26), 0.0);
            v.omega = Vec3::new(v.omega.x.max(0.0), 0.0, 0.0);
            // Tyres: no sideways slip; rolling friction, or the wheel brakes, along the heading.
            let fwd = (tf.rotation * Vec3::NEG_Z).with_y(0.0).normalize_or_zero();
            let along = v.velocity.dot(fwd);
            let decel = if c.brake && flown { 4.5 } else { 0.25 } * dt;
            let along = if along.abs() <= decel { 0.0 } else { along - decel * along.signum() };
            v.velocity = fwd * along + Vec3::Y * v.velocity.y.max(0.0);
        } else if v.agl > 1.0 {
            v.on_ground = false;
        }
        // Walls ahead, when low: flying into a building (or another vehicle) is the end of it. The surface about to
        // be landed on is not a wall: an upward-facing hit level with the ground below is left to the touchdown above.
        // With no ground found below, the height is unknown: always look.
        if (v.agl < 600.0 || !v.ground_found) && !v.on_ground {
            let speed = v.velocity.length();
            let filter = collide::solid_for(Some(e), &meshes, &no_hit);
            let settings = MeshRayCastSettings::default().with_filter(&filter).with_visibility(RayCastVisibility::Visible).always_early_exit();
            if let Ok(dir) = Dir3::new(v.velocity) {
                let reach = speed * dt + (-min.z).max(1.0);
                let landing = (v.gear_down || !v.has_gear()) && v.kind != Kind::Munition;
                let ground = v.ground + 3.0;
                let hit = ray_cast.cast_ray(Ray3d::new(tf.translation, dir), &settings).first().map(|(_, h)| (h.distance, h.normal.y > 0.7 && h.point.y < ground));
                if hit.is_some_and(|(distance, runway)| distance < reach && !(landing && runway)) {
                    v.destroyed = Some(if v.kind == Kind::Munition { "IMPACT" } else { "CRASHED" });
                }
            }
        }
    }
}

/// Helicopters: the one flown takes the controls; the others hold a hover.
fn rnd() -> f32 {
    static SEED: AtomicU32 = AtomicU32::new(0x9E37_79B9);
    let mut x = SEED.load(Relaxed);
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    SEED.store(x, Relaxed);
    (x >> 8) as f32 / (1u32 << 24) as f32
}

/// A random direction: `up` 0 any, 0.5 the upper half, 1 straight up.
fn rnd_dir(up: f32) -> Vec3 {
    let (yaw, y) = (rnd() * TAU, 2.0 * up - 1.0 + rnd() * (2.0 - 2.0 * up));
    let r = (1.0 - y * y).max(0.0).sqrt();
    Vec3::new(r * yaw.cos(), y, r * yaw.sin())
}

/// One piece of an explosion; `delay` seconds before it appears.
#[allow(clippy::too_many_arguments)]
fn puff(commands: &mut Commands, fx: &Effects, materials: &mut Assets<StandardMaterial>, puff: Puff, at: Vec3, velocity: Vec3, life: f32, radius: (f32, f32), delay: f32) {
    let texture = match puff {
        Puff::Ember => None,
        Puff::Shock => Some(fx.ring.clone()),
        _ => Some(fx.soft.clone()),
    };
    // Light adds up (the flash, the embers, the shock's glow); fire and smoke cover what is behind them.
    let alpha_mode = if matches!(puff, Puff::Fire | Puff::Smoke) { AlphaMode::Blend } else { AlphaMode::Add };
    let material = materials.add(StandardMaterial { base_color: Color::NONE, base_color_texture: texture, alpha_mode, unlit: true, cull_mode: None, ..default() });
    let mesh = if puff == Puff::Ember { fx.ember.clone() } else { fx.puff.clone() };
    commands.spawn((
        Blast { puff, pos: at, age: -delay, life, from: radius.0, to: radius.1, velocity, spin: rnd(), along: Vec3::ZERO, material: material.clone() },
        NoHit,
        Mesh3d(mesh),
        MeshMaterial3d(material),
        Transform::from_translation(at).with_scale(Vec3::splat(1e-4)),
    ));
}

/// A piece of a missile's smoke trail, from one point to the next: white, spreading and drifting with the wind.
fn trail(commands: &mut Commands, fx: &Effects, materials: &mut Assets<StandardMaterial>, from: Vec3, to: Vec3) {
    let material = materials.add(StandardMaterial { base_color: Color::NONE, base_color_texture: Some(fx.soft.clone()), alpha_mode: AlphaMode::Blend, unlit: true, cull_mode: None, ..default() });
    let pos = (from + to) / 2.0;
    commands.spawn((
        Blast { puff: Puff::Trail, pos, age: 0.0, life: 3.0 + rnd(), from: 0.6, to: 4.0, velocity: Vec3::ZERO, spin: rnd(), along: to - from, material: material.clone() },
        NoHit,
        Mesh3d(fx.puff.clone()),
        MeshMaterial3d(material),
        Transform::from_translation(pos).with_scale(Vec3::splat(1e-4)),
    ));
}

/// An explosion about `size` metres across: a flash, a fireball rolling up into smoke, and for a big one embers,
/// the shock ring and a smoke column that goes on rising (`Smoulder`).
fn blast(commands: &mut Commands, fx: &Effects, materials: &mut Assets<StandardMaterial>, at: Vec3, size: f32) {
    // Bigger fireballs burn longer, but not in proportion.
    let slow = (size / 20.0).sqrt().clamp(0.4, 1.6);
    puff(commands, fx, materials, Puff::Flash, at, Vec3::ZERO, 0.2 + 0.12 * slow, (size * 0.5, size * 1.5), 0.0);
    // A bullet's strike is a few puffs; there are many of them.
    let fires = (1.0 + size * 0.6).min(18.0) as usize;
    for _ in 0..fires {
        let dir = rnd_dir(0.35);
        let speed = size * (0.6 + 1.2 * rnd()) / slow;
        let radius = (size * (0.2 + 0.1 * rnd()), size * (0.5 + 0.4 * rnd()));
        puff(commands, fx, materials, Puff::Fire, at + dir * size * 0.15, dir * speed + Vec3::Y * size * 0.4, slow * (1.1 + 1.0 * rnd()), radius, 0.05 * rnd());
    }
    let smokes = (1.0 + size * 0.45).min(14.0) as usize;
    for _ in 0..smokes {
        let dir = rnd_dir(0.6);
        let radius = (size * (0.3 + 0.2 * rnd()), size * (1.0 + 0.8 * rnd()));
        puff(commands, fx, materials, Puff::Smoke, at + dir * size * 0.3, dir * size * 0.5 + Vec3::Y * size * (0.5 + 0.5 * rnd()), slow * (4.5 + 3.5 * rnd()), radius, slow * (0.2 + 0.5 * rnd()));
    }
    if size < 8.0 {
        return;
    }
    for _ in 0..(size * 1.2).min(40.0) as usize {
        let dir = rnd_dir(0.5);
        let width = 0.08 * size.sqrt() * (0.5 + rnd());
        puff(commands, fx, materials, Puff::Ember, at, dir * size * (1.0 + 2.5 * rnd()), 1.0 + 1.8 * rnd(), (width, width), 0.0);
    }
    puff(commands, fx, materials, Puff::Shock, at + Vec3::Y * 0.5, Vec3::ZERO, 0.35, (size * 0.3, size * 2.2), 0.0);
    if size >= 15.0 {
        commands.spawn((Smoulder { size, left: SMOULDER, next: 0.4 }, Transform::from_translation(at)));
    }
}

/// How long a big wreck goes on smoking (s).
const SMOULDER: f32 = 14.0;

/// Damage around a burst: full at the centre, none at `radius`.
fn splash(vehicles: &mut Query<(Entity, &Transform, &mut Vehicle)>, at: Vec3, radius: f32, damage: f32) {
    if radius <= 0.0 {
        return;
    }
    for (_, tf, mut v) in vehicles.iter_mut() {
        // Another player's vehicle takes its damage on their side.
        if v.is_remote() {
            continue;
        }
        let d = tf.translation.distance(at);
        if d < radius {
            v.health -= damage * (1.0 - d / radius);
            if v.health <= 0.0 && v.destroyed.is_none() {
                v.destroyed = Some("DESTROYED");
            }
        }
    }
}

/// Destroyed and crashed vehicles: a fireball, and the pilot is out. A loitering munition's warhead goes off. The
fn wrecks(
    mut commands: Commands,
    fx: Res<Effects>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut pilot: ResMut<Pilot>,
    mut vehicles: Query<(Entity, &Transform, &mut Vehicle)>,
    mut ray_cast: MeshRayCast,
    vehicle_meshes: Query<(), With<VehicleMesh>>,
    no_hit: Query<(), With<NoHit>>,
) {
    let gone: Vec<(Entity, Vec3, Vec3, &'static Asset, &'static str, u32, Side)> =
        vehicles.iter().filter_map(|(e, tf, v)| v.destroyed.map(|why| (e, tf.translation, v.velocity, v.asset, why, v.vid, v.side))).collect();
    for (e, at, velocity, asset, why, vid, _side) in gone {
        if js::net_active() {
            js::net_send(&json!({ "k": "destroyed", "id": vid }).to_string());
        }
        let size = match asset.kind {
            Kind::Ship => 60.0,
            Kind::Tank | Kind::Wheeled => 18.0,
            Kind::Jet | Kind::Heli => 26.0,
            Kind::Munition => 20.0,
            Kind::Uav | Kind::Uuv => 6.0,
        };
        blast(&mut commands, &fx, &mut materials, at, size);
        if asset.kind == Kind::Munition {
            splash(&mut vehicles, at, 25.0, 150.0);
        }
        commands.entity(e).despawn();
        pilot.spawned.retain(|&s| s != e);
        if pilot.vehicle == Some(e) {
            pilot.leave();
            pilot.say(format!("{} {why}", asset.label));
            let eye = vantage(&mut ray_cast, &vehicle_meshes, &no_hit, at, velocity, size);
            pilot.aftermath = Some(Aftermath { at, eye, lift: size, age: 0.0 });

        }
    }
}

/// Where the camera watches a lost vehicle's end from: back along its approach and well up, far enough to take in
/// the fireball, with none of the mesh in the way (steeper until it is clear; straight above at worst).
fn vantage(ray_cast: &mut MeshRayCast, vehicle_meshes: &Query<(), With<VehicleMesh>>, no_hit: &Query<(), With<NoHit>>, at: Vec3, velocity: Vec3, size: f32) -> Vec3 {
    let back = (-velocity.with_y(0.0)).try_normalize().unwrap_or(Vec3::Z);
    let dist = (size * 7.0).clamp(90.0, 400.0);
    let filter = |x: Entity| !vehicle_meshes.contains(x) && !no_hit.contains(x);
    let settings = MeshRayCastSettings::default().with_filter(&filter).with_visibility(RayCastVisibility::Visible);
    // From just off the surface it hit, so the ray does not start inside it.
    let from = at + Vec3::Y * 3.0;
    for elevation in [35f32, 50.0, 65.0, 80.0] {
        let eye = at + (back * elevation.to_radians().cos() + Vec3::Y * elevation.to_radians().sin()) * dist;
        let to = eye - from;
        let blocked = Dir3::new(to).is_ok_and(|d| ray_cast.cast_ray(Ray3d::new(from, d), &settings).first().is_some_and(|(_, h)| h.distance < to.length()));
        if !blocked {
            return eye;
        }
    }
    at + Vec3::Y * dist
}

// ---- parts, weapons, effects ------------------------------------------------------------------------------------

/// How fast swing wings sweep (deg/s).
const SWEEP_RATE: f32 = 15.0;

fn animate_parts(time: Res<Time>, mut vehicles: Query<&mut Vehicle>, mut parts: Query<(&Part, &mut Transform)>) {
    let dt = time.delta_secs();
    let t = time.elapsed_secs();
    for mut v in &mut vehicles {
        if v.asset.id == "c172" {
            let target = if v.destroyed.is_some() { 0.0 } else { (800.0 + 1900.0 * v.throttle) * TAU / 60.0 };
            v.rotor_rate += (target - v.rotor_rate) * (dt * 3.0).min(1.0);
        }
        v.rotor = (v.rotor + v.rotor_rate * dt) % TAU;
        v.flash = (v.flash - dt).max(0.0);
        v.recoil *= 1.0 - (5.0 * dt).min(1.0);
        v.cooldown = (v.cooldown - dt).max(0.0);
        v.surfaces = v.surfaces.toward(v.air.surfaces, dt);
        if let Some(sw) = v.asset.sweep {
            // The stop Y set, or the automatic schedule on the Mach number (from the speed: other players' aircraft
            // have no air data here); the wings move at the actuators' rate.
            let goal = match v.sweep_stop {
                Some(i) => sw.stops[i.min(sw.stops.len() - 1)],
                None => sw.min_deg + (sw.max_deg - sw.min_deg) * catalog::auto_sweep(if v.on_ground { 0.0 } else { v.velocity.length() / 340.0 }),
            };
            v.sweep_deg += (goal - v.sweep_deg).clamp(-SWEEP_RATE * dt, SWEEP_RATE * dt);
        }
    }
    // Aircraft with airbrake panels; the others splay their rudders to brake.
    let airbrakes: HashSet<Entity> = parts.iter().filter(|(p, _)| matches!(p.role, Role::Control(Surface::Airbrake, ..))).map(|(p, _)| p.vehicle).collect();
    let shown = |rest: &Transform, scale: Vec3| Transform { scale, ..*rest };
    for (part, mut tf) in &mut parts {
        let Ok(v) = vehicles.get(part.vehicle) else { continue };
        let tucked = v.kind.flies() && !v.gear_down && !v.on_ground;
        // A launcher's stabilisers are its "landing gear": down while the erector is up. Other trucks with levelling
        // jacks (the radar trailer) stand on them whenever they stop.
        let gear_shown = if v.asset.has_erector() {
            v.erector > 0.02
        } else if v.kind == Kind::Wheeled {
            v.speed.abs() < 0.1
        } else {
            !tucked
        };
        *tf = match part.role {
            // The model's turret node traverses to the right on positive rotation.
            Role::Turret => part.rest * Transform::from_rotation(Quat::from_rotation_x(-v.turret)),
            Role::Gun => part.rest * Transform::from_rotation(Quat::from_rotation_x(v.gun)),
            Role::Rotor => {
                let mut pose = part.rest * Transform::from_rotation(Quat::from_rotation_x(v.rotor));
                if v.asset.id == "c172" && v.rotor_rate > 60.0 { pose.scale *= 0.0001; }
                pose
            }
            Role::RotorBlur => shown(&part.rest, part.rest.scale * if v.rotor_rate > 60.0 { 1.0 } else { 0.0001 }),
            Role::CockpitYoke(pivot) => part.rest * cockpit_yoke_pose(pivot, v.surfaces.pitch, v.surfaces.roll),
            Role::CockpitPedal(side) => part.rest * Transform::from_translation(Vec3::X * v.surfaces.yaw * side * 0.04),
            Role::Lamp(phase) => {
                let cycle = (t + phase.max(0.0)).rem_euclid(1.2);
                let lit = phase < 0.0 || cycle < 0.065 || (0.15..0.215).contains(&cycle);
                shown(&part.rest, part.rest.scale * if lit && v.destroyed.is_none() { 1.0 } else { 0.0001 })
            }
            Role::Scan => part.rest * Transform::from_rotation(Quat::from_rotation_x(t * 1.6)),
            Role::Recoil => part.rest * Transform::from_translation(Vec3::X * v.recoil),
            Role::MuzzleFlash if v.flash > 0.0 => shown(&part.rest, Vec3::ONE),
            Role::Gear => shown(&part.rest, Vec3::splat(if gear_shown { 1.0 } else { 1e-4 })),
            Role::StowedGear => shown(&part.rest, Vec3::splat(if gear_shown { 1e-4 } else { 1.0 })),
            // Built raised: stowed is the build angle back down.
            Role::Erector(built) => part.rest * Transform::from_rotation(Quat::from_rotation_x(-built * (1.0 - v.erector))),
            Role::Steer(lock) => part.rest * Transform::from_rotation(Quat::from_rotation_x(-v.steer * lock)),
            Role::Wheel(radius, right) => part.rest * Transform::from_rotation(Quat::from_rotation_x(v.track_dist[usize::from(right)] / radius)),
            Role::Track(right, phase, phases, pitch) => {
                let showing = ((v.track_dist[usize::from(right)] / pitch).rem_euclid(1.0) * phases as f32) as u32 % phases.max(1);
                shown(&part.rest, Vec3::splat(if phase == showing { 1.0 } else { 1e-4 }))
            }
            // Positive sweeps a wing back; a pylon's node turns the other way about the same angle.
            Role::Sweep | Role::Swivel => {
                let built = v.asset.sweep.map_or(v.sweep_deg, |sw| sw.built_deg);
                part.rest * Transform::from_rotation(Quat::from_rotation_x((v.sweep_deg - built).to_radians()))
            }
            // The node's +X runs along the hinge: positive turns what is aft of it down, or to port on a fin.
            Role::GliderHinge(surface, max, axis, pivot) => {
                let input = match surface { Surface::Aileron => v.surfaces.roll, Surface::Elevator => v.surfaces.pitch, Surface::Rudder => v.surfaces.yaw, _ => 0.0 };
                let rotation = Quat::from_axis_angle(axis, input.clamp(-1.0, 1.0) * max);
                part.rest * Transform::from_translation(pivot - rotation * pivot).with_rotation(rotation)
            }
            Role::GliderBrake(axis) => part.rest * Transform::from_translation(axis * v.surfaces.brake * 0.09),
            Role::Control(surface, side, max) => {
                let s = v.surfaces;
                let command = match surface {
                    // All-moving tails also move apart to help roll.
                    Surface::Elevator => -s.pitch - 0.4 * s.roll * side,
                    Surface::Aileron => -s.roll * side,
                    Surface::Flaperon => -s.roll * side + 0.6 * s.flap,
                    Surface::Flap => s.flap,
                    Surface::Rudder if airbrakes.contains(&part.vehicle) => s.yaw,
                    Surface::Rudder => s.yaw - 0.6 * s.brake * side,
                    Surface::Lef => s.droop,
                    Surface::Airbrake => s.brake,
                };
                part.rest * Transform::from_rotation(Quat::from_rotation_x(command.clamp(-1.0, 1.0) * max))
            }
            _ => part.rest,
        };
    }
}

/// The trigger fires the vehicle's gun (`catalog::Gun`): automatic ones while it is held (each tracer stands for a
/// burst), the tank's main gun once per press with its ammunition; the munition's warhead on demand (X, not the trigger). The player's
/// trigger in the vehicle they drive, the autopilot's in the others.
#[allow(clippy::too_many_arguments)]
fn animate_blasts(
    mut commands: Commands,
    time: Res<Time>,
    fx: Res<Effects>,
    weather: Res<Weather>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut blasts: Query<(Entity, &mut Blast, &mut Transform), Without<Tiles3dCamera>>,
    mut smoulders: Query<(Entity, &mut Smoulder, &Transform), (Without<Blast>, Without<Tiles3dCamera>)>,
    cam: Single<&Transform, With<Tiles3dCamera>>,
) {
    let dt = time.delta_secs();
    let wind = weather.wind();
    for (e, mut s, tf) in &mut smoulders {
        s.left -= dt;
        s.next -= dt;
        if s.left <= 0.0 {
            commands.entity(e).despawn();
            continue;
        }
        if s.next > 0.0 {
            continue;
        }
        // Dying down: fewer, smaller puffs, and the flames at its foot go out first.
        let strength = s.left / SMOULDER;
        s.next = 0.12 + 0.3 * (1.0 - strength);
        let base = tf.translation + rnd_dir(0.0).with_y(0.0) * s.size * 0.2;
        let rise = Vec3::Y * s.size * (0.6 + 0.3 * rnd());
        let radius = (s.size * 0.3, s.size * (1.2 + 0.8 * rnd()) * (0.5 + 0.5 * strength));
        puff(&mut commands, &fx, &mut materials, Puff::Smoke, base, rise, 6.0 + 4.0 * rnd(), radius, 0.0);
        if strength > 0.55 {
            let radius = (s.size * 0.12, s.size * 0.3 * strength);
            puff(&mut commands, &fx, &mut materials, Puff::Fire, base, rise * 0.8, 0.5 + 0.4 * rnd(), radius, 0.0);
        }
    }
    for (e, mut b, mut tf) in &mut blasts {
        b.age += dt;
        if b.age >= b.life {
            commands.entity(e).despawn();
            materials.remove(&b.material);
            continue;
        }
        if b.age < 0.0 {
            continue;
        }
        let t = b.age / b.life;
        let ease_out = 1.0 - (1.0 - t).powi(3);
        // Fire and smoke slow in the air and are carried off by the wind as they climb; embers fall.
        let drag = match b.puff {
            Puff::Fire => 2.2,
            Puff::Smoke | Puff::Trail => 0.9,
            _ => 0.3,
        };
        let carried = match b.puff {
            Puff::Smoke => wind + Vec3::Y * b.to * 0.22,
            Puff::Fire => wind * 0.5 + Vec3::Y * b.to * 0.4,
            Puff::Trail => wind + Vec3::Y * 0.4,
            _ => Vec3::ZERO,
        };
        b.velocity = b.velocity.lerp(carried, (drag * dt).min(1.0));
        if b.puff == Puff::Ember {
            b.velocity.y -= physics::G * dt;
        }
        let step = b.velocity * dt;
        b.pos += step;
        let radius = b.from + (b.to - b.from) * ease_out;
        let (color, scale) = match b.puff {
            Puff::Flash => (LinearRgba::new(9.0, 7.0, 4.5, (1.0 - t).powi(2)), Vec3::splat(b.from + (b.to - b.from) * t.powf(0.3))),
            Puff::Fire => {
                // White-yellow, orange, deep red, then soot; the last of it is smoke.
                let hot = LinearRgba::new(1.6, 0.62, 0.1, 1.0);
                let orange = LinearRgba::new(0.85, 0.16, 0.015, 1.0);
                let soot = LinearRgba::new(0.08, 0.065, 0.055, 1.0);
                let c = if t < 0.3 { hot.mix(&orange, t / 0.3) } else { orange.mix(&soot, ((t - 0.3) / 0.45).min(1.0)) };
                (c.with_alpha(0.95 * (1.0 - t).powf(0.6)), Vec3::splat(radius))
            }
            Puff::Smoke => {
                let shade = 0.09 + 0.11 * b.spin;
                let alpha = 0.88 * (t / 0.1).min(1.0) * (1.0 - t).powf(1.2);
                (LinearRgba::new(shade, shade * 0.97, shade * 0.94, alpha), Vec3::splat(b.from + (b.to - b.from) * t.sqrt()))
            }
            Puff::Ember => {
                let glow = (1.0 - t).powf(0.5);
                (LinearRgba::new(6.0, 2.4, 0.5, glow), Vec3::new(b.from, b.from, b.from * (1.0 + 0.08 * b.velocity.length())))
            }
            Puff::Shock => (LinearRgba::new(1.4, 1.2, 0.95, 0.4 * (1.0 - t).powi(2)), Vec3::new(radius, radius, 1.0)),
            Puff::Trail => {
                let r = b.from + (b.to - b.from) * t.sqrt();
                let shade = 0.78 + 0.1 * b.spin;
                (LinearRgba::new(shade, shade, shade, 0.5 * (t / 0.03).min(1.0) * (1.0 - t).powf(1.5)), Vec3::new(b.along.length() / 2.0 + r * 0.6, r, 1.0))
            }
        };
        // Smoke stays upright (its light is on top), mirrored for variety.
        let scale = if b.puff == Puff::Smoke && b.spin > 0.5 { scale * Vec3::new(-1.0, 1.0, 1.0) } else { scale };
        tf.scale = scale;
        let billboard = matches!(b.puff, Puff::Flash | Puff::Fire | Puff::Smoke);
        let toward = if billboard { (cam.translation - b.pos).normalize_or_zero() * scale.y * 0.8 } else { Vec3::ZERO };
        tf.translation = b.pos + toward;
        tf.rotation = match b.puff {
            // Streaks along their flight; the ring lies flat; the rest face the camera, each turned its own way.
            Puff::Ember => Transform::default().looking_to(b.velocity, Vec3::Y).rotation,
            Puff::Shock => Quat::from_rotation_x(-PI / 2.0),
            // Along the missile's path, turned about it to face the camera.
            Puff::Trail => {
                let x = b.along.normalize_or(Vec3::X);
                let to_cam = (cam.translation - b.pos).normalize_or(Vec3::Z);
                let z = (to_cam - x * to_cam.dot(x)).normalize_or(Vec3::Y.cross(x).normalize_or(Vec3::Z));
                Quat::from_mat3(&Mat3::from_cols(x, z.cross(x), z))
            }
            Puff::Smoke => cam.rotation * Quat::from_rotation_z((b.spin - 0.5) * (0.6 + 0.3 * b.age)),
            _ => cam.rotation * Quat::from_rotation_z(b.spin * TAU + (b.spin - 0.5) * b.age * 0.6),
        };
        if let Some(mut m) = materials.get_mut(&b.material) {
            m.base_color = color.into();
        }
    }
}

// ---- camera, origin, HUD ----------------------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn place_camera(
    time: Res<Time>,
    pilot: Res<Pilot>,
    settings: Res<Settings>,
    vehicles: Query<(Entity, &Transform, &Vehicle, &GlobalTransform), Without<Tiles3dCamera>>,
    parts: Query<(&Part, &GlobalTransform)>,
    mut cam: Single<(&mut Transform, &mut Projection), With<Tiles3dCamera>>,
    mut ray_cast: MeshRayCast,
    meshes: Query<&VehicleMesh>,
    no_hit: Query<(), With<NoHit>>,
    // The chase camera's offset from what it looks at, last frame.
    mut carried: Local<Option<(Entity, Vec3)>>,
    // The aircraft rotation the chase camera has caught up with.
    mut follow: Local<Option<(Entity, Quat)>>,
) {
    let (cam_tf, projection) = &mut *cam;
    let fov = settings.fov / pilot.zoom;
    if let Projection::Perspective(p) = &mut **projection {
        if (p.fov - fov).abs() > 1e-4 {
            p.fov = fov;
        }
    }
    let chase = pilot.view == View::Chase;
    let Some((e, tf, v, was)) = pilot.vehicle.and_then(|e| vehicles.get(e).ok()) else {
        *carried = None;
        *follow = None;
        return;
    };
    let dt = time.delta_secs();
    let followed = match *follow {
        Some((f, q)) if f == e && chase => q.slerp(tf.rotation, 1.0 - (-CHASE_FOLLOW * dt).exp()),
        _ => tf.rotation,
    };
    *follow = Some((e, followed));
    let (min, max) = v.bounds();
    let (len, height) = (max.z - min.z, max.y - min.y);
    // What the chase camera looks at: an aircraft's middle, or just over a vehicle's roof.
    let aircraft = matches!(v.kind, Kind::Jet | Kind::Uav | Kind::Munition);
    let pivot = if aircraft { tf.transform_point((min + max) / 2.0) } else { tf.translation + Vec3::Y * (max.y + 1.5) };
    let dist = v.chase_distance().0 * pilot.chase_zoom;
    // At the crew's eyes: an aircraft's view turns with it (the right button glances round), the others look where the
    // mouse does.
    let seat = station::eye(&parts, e, was, tf).filter(|_| matches!(pilot.view, View::Cockpit | View::HeadUp)).map(|(at, pitch)| {
        let rot = match v.kind {
            Kind::Jet | Kind::Uav => tf.rotation * look(pilot.orbit.x, pilot.orbit.y + pitch),
            _ => look(pilot.yaw + pilot.orbit.x, pilot.pitch + pilot.orbit.y + pitch),
        };
        Transform::from_translation(at).with_rotation(rot)
    });
    // The HUD view sits where the cockpit view would: it only differs in what is shown.
    let want = seat.unwrap_or_else(|| match (pilot.view, v.kind) {
        (View::Cockpit | View::HeadUp, Kind::Jet | Kind::Uav) => Transform::from_translation(tf.transform_point(Vec3::new(0.0, min.y + 0.74 * height, min.z + 0.3 * len))).with_rotation(tf.rotation),
        // The pilot's seat (right-hand side), free to look around.
        (View::Cockpit | View::HeadUp, Kind::Heli) => {
            Transform::from_translation(tf.transform_point(Vec3::new(0.6, min.y + 0.52 * height, min.z + 0.13 * len))).with_rotation(look(pilot.yaw + pilot.orbit.x, pilot.pitch + pilot.orbit.y))
        }
        (View::Cockpit | View::HeadUp | View::Sight, Kind::Tank | Kind::Wheeled) => {
            // The gunner's sight, laid with the gun; the driver's view for a vehicle without a turret.
            if v.asset.turret.is_some() {
                let sight = parts.iter().find(|(p, _)| p.vehicle == e && p.role == Role::Sight).map_or(tf.transform_point(Vec3::new(0.0, max.y, 0.0)), |(_, g)| g.translation());
                Transform::from_translation(sight + Vec3::Y * 0.3).with_rotation(look(v.heading + v.turret, v.hull_pitch + v.gun))
            } else {
                Transform::from_translation(tf.transform_point(Vec3::new(-0.6, min.y + 0.75 * height, min.z + 0.1 * len))).with_rotation(look(pilot.yaw, pilot.pitch))
            }
        }
        // The bridge, looking where the mouse does.
        (View::Cockpit | View::HeadUp, Kind::Ship | Kind::Uuv) => Transform::from_translation(tf.transform_point(Vec3::new(0.0, min.y + 0.62 * height, min.z + 0.3 * len))).with_rotation(look(pilot.yaw, pilot.pitch)),
        (View::Cockpit | View::HeadUp | View::Sight, _) => Transform::from_translation(tf.transform_point(Vec3::new(0.0, 0.0, min.z))).with_rotation(tf.rotation),
        (View::Gimbal, _) => Transform::from_translation(tf.transform_point(Vec3::new(0.0, min.y - 0.1, min.z * 0.4))).with_rotation(look(pilot.yaw, pilot.pitch)),
        // Behind and a little above, turning and banking with the aircraft a moment after it, unless orbited round it.
        (View::Chase, Kind::Jet | Kind::Uav | Kind::Munition) => {
            let rot = followed * look(pilot.orbit.x, pilot.orbit.y - 0.1);
            Transform::from_translation(pivot + rot * Vec3::new(0.0, 0.1 * dist, dist)).with_rotation(rot)
        }
        // Astern of the helicopter's nose, level (not rolling with it), tilted with the mouse; turned with the right
        // button held.
        (View::Chase, Kind::Heli) => {
            let rot = look(yaw_of(tf.rotation) + pilot.orbit.x, (pilot.pitch + pilot.orbit.y - 0.12).clamp(-1.45, 1.2));
            Transform::from_translation(pivot + rot * Vec3::Z * dist).with_rotation(rot)
        }
        (View::Chase, _) => {
            let rot = look(pilot.yaw, pilot.pitch - 0.12);
            Transform::from_translation(pivot + rot * Vec3::Z * dist).with_rotation(rot)
        }
    });
    // A chase camera stays on this side of walls and other models: pulled in to just short of whatever is between it
    // and the vehicle (here, and again once eased below, so easing out from a wall does not swing through it).
    let mut want = want;
    if pilot.view == View::Chase {
        want.translation = collide::clear_line(&mut ray_cast, &meshes, &no_hit, e, pivot, want.translation);
    }
    // The chase camera rides along with the vehicle and eases only toward its place around it, so it keeps its
    // distance at any speed (easing the position itself trailed a jet by a tenth of its speed: 35 m at 350 m/s).
    if chase && let Some((_, offset)) = carried.filter(|(c, _)| *c == e) {
        cam_tf.translation = pivot + offset;
    }
    let k = if pilot.view == View::Chase { (10.0 * dt).min(1.0) } else { 1.0 };
    cam_tf.translation = cam_tf.translation.lerp(want.translation, k);
    if pilot.view == View::Chase {
        cam_tf.translation = collide::clear_line(&mut ray_cast, &meshes, &no_hit, e, pivot, cam_tf.translation);
    }
    cam_tf.rotation = cam_tf.rotation.slerp(want.rotation, k);
    *carried = chase.then(|| (e, cam_tf.translation - pivot));
    // Buffet: the airframe shakes as the wing nears the stall, felt in the cockpit and seen from the chase camera.
    if let Some(af) = v.asset.airframe.filter(|_| v.kind == Kind::Jet && !v.on_ground && pilot.view != View::Gimbal) {
        let buffet = ((v.air.alpha.abs() / af.alpha_stall - 0.7) / 0.3).clamp(0.0, 1.0) * (v.velocity.length() / 150.0).min(1.0);
        if buffet > 0.0 {
            let t = time.elapsed_secs();
            let shake = buffet * 0.004 * Vec2::new((t * 31.0).sin() + (t * 47.0).sin(), (t * 37.0).sin() + (t * 53.0).sin());
            cam_tf.rotation *= Quat::from_euler(EulerRot::XYZ, shake.x, shake.y, 0.0);
        }
    }
}

/// Moves the world frame under the camera once it is a few kilometres out, so "down" stays down and the numbers
/// stay small; everything of ours moves with it, the tiles re-place themselves. They do in the crate's pass right
/// after this one, the same frame: a frame later, the next frame's rays would meet the tiles kilometres from where
/// they are drawn, and a vehicle crash into a mountainside that is not there.
#[allow(clippy::too_many_arguments)]
fn rebase(
    mut frame: ResMut<Frame>,
    mut origin: ResMut<EcefOrigin>,
    mut pilot: ResMut<Pilot>,
    cam: Single<(&mut Transform, &mut GlobalTransform, &mut Frustum, &Projection), With<Tiles3dCamera>>,
    mut vehicles: Query<(&mut Transform, &mut Vehicle), Without<Tiles3dCamera>>,
    mut shells: Query<(&mut Transform, &mut Shell), (Without<Tiles3dCamera>, Without<Vehicle>)>,
    mut blasts: Query<(&mut Transform, Option<&mut Blast>), (Or<(With<Blast>, With<Smoulder>)>, Without<Tiles3dCamera>, Without<Vehicle>, Without<Shell>)>,
) {
    let (mut cam, mut cam_global, mut frustum, projection) = cam.into_inner();
    let at = cam.translation;
    if at.with_y(0.0).length() < origin::REBASE_DISTANCE {
        return;
    }
    let (next, m) = frame.recentred(at);
    origin::rebase_transform(&m, &mut cam);
    // The crate picks the tiles from where the camera is and what it sees, which follow the transform only after
    // this frame: in the new frame now, or it would pick them for a camera kilometres away.
    *cam_global = GlobalTransform::from(*cam);
    *frustum = projection.compute_frustum(&cam_global);
    if pilot.vehicle.is_none() {
        let (yaw, pitch, _) = cam.rotation.to_euler(EulerRot::YXZ);
        pilot.yaw = yaw;
        pilot.pitch = pitch;
    }
    for (mut tf, mut v) in &mut vehicles {
        // Other players' vehicles are placed from Earth-fixed coordinates every frame.
        if v.is_remote() {
            continue;
        }
        let ground = m.transform_point3(tf.translation.with_y(v.ground).as_dvec3()).y as f32;
        if let Some(w) = v.water {
            v.water = Some(m.transform_point3(tf.translation.with_y(w).as_dvec3()).y as f32);
        }
        origin::rebase_transform(&m, &mut tf);
        v.velocity = origin::rebase_vector(&m, v.velocity);
        v.ground = ground;
        // Heights in the old frame: look again at once.
        v.contacts = [None; 6];
        v.ground_plane = None;
        v.probe_in = 0.0;
        if v.kind.drives() || v.kind.sails() {
            v.heading = yaw_of(tf.rotation);
        }
    }
    for (mut tf, mut s) in &mut shells {
        origin::rebase_transform(&m, &mut tf);
        s.velocity = origin::rebase_vector(&m, s.velocity);
    }
    for (mut tf, blast) in &mut blasts {
        origin::rebase_transform(&m, &mut tf);
        if let Some(mut b) = blast {
            b.pos = m.transform_point3(b.pos.as_dvec3()).as_vec3();
            b.velocity = origin::rebase_vector(&m, b.velocity);
        }
    }
    if let Some(a) = pilot.aftermath.as_mut() {
        a.at = m.transform_point3(a.at.as_dvec3()).as_vec3();
        a.eye = m.transform_point3(a.eye.as_dvec3()).as_vec3();
    }
    if let Some(d) = pilot.designated {
        pilot.designated = Some(m.transform_point3(d.as_dvec3()).as_vec3());
    }
    origin.world_from_ecef = Some(next.world_from_ecef);
    *frame = next;
}

/// Projects a world point into the view: normalised device coordinates (x right, y up, −1..1), or none behind.
fn project(cam: &Transform, fov: f32, aspect: f32, p: Vec3) -> Option<[f32; 2]> {
    let d = cam.rotation.inverse() * (p - cam.translation);
    if d.z > -0.5 {
        return None;
    }
    let t = (fov / 2.0).tan();
    Some([d.x / -d.z / (t * aspect), d.y / -d.z / t])
}

#[allow(clippy::too_many_arguments)]
fn hud(
    time: Res<Time>,
    net: Res<Net>,
    mut pilot: ResMut<Pilot>,
    frame: Res<Frame>,
    weather: Res<Weather>,
    sky: Res<Sky>,
    vehicles: Query<(Entity, &Transform, &Vehicle)>,
    cam: Single<(&Transform, &Projection), With<Tiles3dCamera>>,
    window: Single<&Window, With<PrimaryWindow>>,
    travel: Res<globe::Travel>,
    flight: Res<flight::HudOut>,
    (parts, combiners, globals): (Query<(&Part, &GlobalTransform)>, Query<(&Part, &GlobalTransform, &station::Combiner)>, Query<&GlobalTransform, With<Vehicle>>),
) {
    pilot.message_for -= time.delta_secs();
    let (cam_tf, projection) = *cam;
    let fov = if let Projection::Perspective(p) = projection { p.fov } else { 0.8 };
    let aspect = window.width() / window.height().max(1.0);
    let (lat, lon, _) = frame.geodetic(cam_tf.translation);
    let message = if pilot.message_for > 0.0 { pilot.message.clone() } else { String::new() };
    // Other vehicles in view, for the target boxes.
    let contacts: Vec<_> = vehicles
        .iter()
        .filter(|(e, _, _)| Some(*e) != pilot.vehicle)
        .filter_map(|(_, tf, v)| {
            let range = tf.translation.distance(cam_tf.translation);
            if range > 6000.0 {
                return None;
            }
            let label = v.remote.as_ref().map_or(v.asset.label.to_owned(), |r| format!("{} · {}", r.name, v.asset.label));
            project(cam_tf, fov, aspect, tf.translation).map(|xy| json!({ "xy": xy, "label": label, "range": range, "player": v.is_remote() }))
        })
        .take(40)
        .collect();
    // Players flying free (not in a vehicle) show where their camera is.
    let mut contacts = contacts;
    for p in net.players.values().filter(|p| p.what == "free") {
        if let Some(at) = p.camera.map(|c| frame.from_ecef(c)) {
            let range = at.distance(cam_tf.translation);
            if let Some(xy) = project(cam_tf, fov, aspect, at).filter(|_| range < 20_000.0) {
                contacts.push(json!({ "xy": xy, "label": format!("{} · free flight", p.name), "range": range, "player": true }));
            }
        }
    }
    let view = match pilot.view {
        View::Chase => "chase",
        View::Cockpit => "cockpit",
        View::HeadUp => "hud",
        View::Sight => "sight",
        View::Gimbal => "gimbal",
    };
    // From a crew station: its head-up display's outline, if it has one.
    let inside = pilot.vehicle.filter(|e| pilot.view == View::Cockpit && station::has_station(&parts, *e)).and_then(|e| Some((e, vehicles.get(e).ok()?.1, globals.get(e).ok()?)));
    let combiner = inside.and_then(|(e, now, was)| station::combiner_outline(&combiners, e, was, now, cam_tf, fov, aspect));
    // Lightning for the HUD's flash, and the weather for the menu (rain and snow are in the scene: weather/precip.rs).
    // The view's own attitude, for a head-up display's horizon.
    let (cam_pitch, cam_bank) = physics::attitude(cam_tf.rotation);
    let fx = json!({ "flash": sky.flash, "daylight": sky.daylight, "weather": WeatherView::from(&*weather) });
    let base = json!({
        "locked": pilot.locked, "message": message, "lat": lat, "lon": lon, "alt": frame.altitude(cam_tf.translation), "fov": fov, "aspect": aspect,
        "contacts": contacts, "view": view, "station": inside.is_some(), "combiner": combiner,
        "headLook": [pilot.orbit.x, pilot.orbit.y],
        "cam": [cam_pitch.to_degrees(), cam_bank.to_degrees()], "fx": fx, "travel": travel.hud(), "flight": flight.0,
    });
    let Some((e, tf, v)) = pilot.vehicle.and_then(|e| vehicles.get(e).ok()) else {
        let state = json!({
            "mode": "free", "base": base, "speed": pilot.speed * globe::speed_scale(frame.altitude(cam_tf.translation)), "alt": frame.altitude(cam_tf.translation),
            "heading": heading_of(cam_tf.rotation).to_degrees(), "spawned": pilot.spawned.len(),
        });
        js::hud(&state.to_string());
        return;
    };
    let (pitch, bank) = physics::attitude(tf.rotation);
    let fpm = if v.velocity.length() > 2.0 { project(cam_tf, fov, aspect, cam_tf.translation + v.velocity.normalize() * 1000.0) } else { None };
    let vs = v.velocity.y;
    let airspeed = (v.velocity - weather.wind()).length();
    let ias = airspeed * (physics::atmosphere(frame.altitude(tf.translation)).0 / 1.225).sqrt();
    let (vlat, vlon, _) = frame.geodetic(tf.translation);
    // The height above the ground only over ground the rays found: none (no radar altitude, no warnings) otherwise.
    let agl = (v.ground_found || v.on_ground).then(|| v.agl.max(0.0));
    let pull_up = v.terrain_tti.is_some_and(|t| t < 5.0) || agl.is_some_and(|agl| matches!(v.kind, Kind::Jet | Kind::Uav) && !v.on_ground && vs < -1.0 && agl / -vs < 5.0 && agl < 600.0 && !(v.gear_down && vs > -5.0));
    // Gear still up on the way down to land: low, slow and sinking.
    let gear_warning = agl.is_some_and(|agl| v.has_gear() && !v.gear_down && !v.on_ground && agl < 90.0 && vs < -1.0 && v.velocity.length() < 95.0);
    let target = pilot.designated.map(|d| {
        let (tlat, tlon, _) = frame.geodetic(d);
        json!({ "lat": tlat, "lon": tlon, "range": d.distance(tf.translation) })
    });
    // For the map screens: the others nearby, by bearing (deg from north) and range.
    let radar: Vec<_> = vehicles
        .iter()
        .filter(|(o, _, _)| *o != e)
        .filter_map(|(_, otf, ov)| {
            let d = otf.translation - tf.translation;
            let range = d.with_y(0.0).length();
            (range < 20_000.0).then(|| json!({ "brg": d.x.atan2(-d.z).to_degrees(), "range": range, "red": ov.side == Side::Red, "air": matches!(ov.kind, Kind::Jet | Kind::Uav | Kind::Heli | Kind::Munition) }))
        })
        .take(60)
        .collect();
    let reload = match (v.kind, v.asset.gun) {
        (Kind::Tank, Some(g)) => v.cooldown / g.interval,
        _ => 0.0,
    };
    let state = json!({
        "mode": v.kind.hud(), "id": v.asset.id, "base": base, "label": v.asset.label, "gun": v.asset.gun.map(|g| g.label),
        "tas": airspeed, "ias": ias, "lat": vlat, "lon": vlon, "track": v.velocity.x.atan2(-v.velocity.z).to_degrees().rem_euclid(360.0),
        "speed": v.velocity.length(), "gs": v.velocity.with_y(0.0).length(), "vs": vs, "alt": frame.altitude(tf.translation), "agl": agl,
        "heading": heading_of(tf.rotation).to_degrees(), "pitch": pitch.to_degrees(), "bank": bank.to_degrees(), "fpm": fpm,
        "g": v.air.g, "alpha": v.air.alpha.to_degrees(), "beta": v.air.beta.to_degrees(), "mach": v.air.mach, "stall": v.air.stalled && !v.on_ground,
        "throttle": v.throttle, "ab": v.asset.airframe.is_some_and(|a| a.thrust_ab > 0.0), "gear": v.gear_down, "hasGear": v.has_gear(),
        "wing": v.asset.sweep.map(|_| json!({ "deg": v.sweep_deg, "auto": v.sweep_stop.is_none() })),
        "speedbrake": v.surfaces.brake > 0.1 && v.asset.airframe.is_some_and(|a| a.cd_brake > 0.0), "gearWarning": gear_warning, "onGround": v.on_ground, "pullUp": pull_up,
        "terrainTti": v.terrain_tti, "rpm": v.rotor_rate * 60.0 / TAU, "surfaces": { "roll": v.surfaces.roll, "pitch": v.surfaces.pitch, "yaw": v.surfaces.yaw, "flap": v.surfaces.flap },
        "health": v.health / v.asset.health, "rounds": v.rounds, "reload": reload,
        "collective": v.collective, "lift": v.lift_ratio, "rotor": v.rotor_rate / 28.0,
        "tankSpeed": v.speed, "turret": v.turret.to_degrees(), "hasTurret": v.asset.turret.is_some(), "gunEl": v.gun.to_degrees(), "range": v.range,
        "ammo": if v.kind == Kind::Tank { v.ammo.label() } else { v.asset.gun.map_or("", |g| g.label) },
        "hullHeading": heading_of(Quat::from_rotation_y(v.heading)).to_degrees(), "steer": v.steer, "erector": v.erector, "hasErector": v.asset.has_erector(), "depth": v.depth,
        "zoom": pilot.zoom, "ir": pilot.infrared, "look": [heading_of(look(pilot.yaw, 0.0)).to_degrees(), pilot.pitch.to_degrees()],
        "target": target, "muzzle": v.flash > 0.0, "radar": radar,
    });
    js::hud(&state.to_string());
}

/// Relative head movement: preserve the last glance and limit it to the cabin.
fn cockpit_look(current: Vec2, drag: Vec2, stick: Vec2, dt: f32) -> Vec2 {
    let next = current - drag * 0.0025 + Vec2::new(-stick.x, stick.y) * (2.3 * dt);
    next.clamp(Vec2::new(-1.55, -1.05), Vec2::new(1.55, 0.8))
}

/// Imported cabin axes: +X forward, +Y up, +Z pilot's right.
/// Positive roll input banks right: the top of the yoke must move toward +Z.
/// Positive pitch pulls the shaft aft, toward the pilot, along -X.
fn cockpit_yoke_pose(pivot: Vec3, pitch: f32, roll: f32) -> Transform {
    let rotation = Quat::from_rotation_x(roll * 0.65);
    Transform::from_translation(pivot - rotation * pivot - Vec3::X * pitch * 0.055).with_rotation(rotation)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use bevy::camera::primitives::MeshAabb;
    use bevy::ecs::system::RunSystemOnce;

    use super::*;

    #[test]
    fn cockpit_right_drag_does_not_steer_the_aircraft() {
        let mut world = World::new();
        let mut time = Time::<()>::default();
        time.advance_by(Duration::from_millis(16));
        world.insert_resource(time);
        world.init_resource::<Settings>();
        world.init_resource::<Pad>();
        world.init_resource::<Controls>();
        world.init_resource::<ButtonInput<KeyCode>>();
        let mut buttons = ButtonInput::<MouseButton>::default();
        buttons.press(MouseButton::Right);
        world.insert_resource(buttons);
        world.insert_resource(AccumulatedMouseMotion { delta: Vec2::new(180.0, 90.0) });
        let aircraft = world.spawn((Vehicle::new(catalog::find("c172").unwrap(), 0.0, true), Transform::default())).id();
        world.insert_resource(Pilot { vehicle: Some(aircraft), view: View::Cockpit, locked: true, ..default() });
        for view in [View::Cockpit, View::HeadUp, View::Chase] {
            world.resource_mut::<Pilot>().view = view;
            world.run_system_once(read_controls).unwrap();
            let controls = world.resource::<Controls>();
            assert_eq!(controls.mouse_stick, Vec2::ZERO);
            assert_eq!(controls.stick.pitch, 0.0);
            assert_eq!(controls.stick.roll, 0.0);
        }
        world.resource_mut::<ButtonInput<MouseButton>>().release(MouseButton::Right);
        world.run_system_once(read_controls).unwrap();
        assert!(world.resource::<Controls>().stick.roll > 0.0);
        assert!(world.resource::<Controls>().stick.pitch < 0.0);
    }

    #[test]
    fn cockpit_head_look_stays_put_and_limits_neck_travel() {
        let glance = cockpit_look(Vec2::ZERO, Vec2::new(200.0, 120.0), Vec2::ZERO, 0.016);
        assert!(glance.x < 0.0 && glance.y < 0.0);
        assert_eq!(cockpit_look(glance, Vec2::ZERO, Vec2::ZERO, 1.0), glance);
        assert_eq!(cockpit_look(glance, Vec2::splat(10_000.0), Vec2::ZERO, 0.016), Vec2::new(-1.55, -1.05));
        let one_step = cockpit_look(Vec2::ZERO, Vec2::ZERO, Vec2::new(0.3, -0.2), 0.5);
        let mut many_steps = Vec2::ZERO;
        for _ in 0..50 { many_steps = cockpit_look(many_steps, Vec2::ZERO, Vec2::new(0.3, -0.2), 0.01); }
        assert!(one_step.distance(many_steps) < 1e-5);
    }

    #[test]
    fn yokes_follow_pilot_roll_and_pitch_input() {
        for side in [-1.0, 1.0] {
            let pivot = Vec3::new(0.57955, 1.30055, side * 0.27);
            for roll in [-1.0, 1.0] {
                let pose = cockpit_yoke_pose(pivot, 0.0, roll);
                let top = pose.transform_point(pivot + Vec3::Y * 0.2);
                // Viewed from the seat, the top follows the commanded turn.
                assert!((top.z - pivot.z) * roll > 0.0);
                // The right grip lowers for right roll, rises for left roll.
                let grip = pose.transform_point(pivot + Vec3::Z * 0.2);
                assert!((grip.y - pivot.y) * roll < 0.0);
                assert!(pose.transform_point(pivot).distance(pivot) < 1e-6);
            }
            for pitch in [-1.0, 0.0, 1.0] {
                let center = cockpit_yoke_pose(pivot, pitch, 0.0).transform_point(pivot);
                assert!((center.x - (pivot.x - pitch * 0.055)).abs() < 1e-6);
                assert!((center.y - pivot.y).abs() < 1e-6);
                assert!((center.z - pivot.z).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn crew_station_nodes_are_found_by_name_and_extras() {
        let eye = Role::of("crew-eye", Some(&json!({ "pitchDeg": -10.0 })));
        assert!(matches!(eye, Some(Role::Eye(p)) if (p + 10f32.to_radians()).abs() < 1e-6));
        assert!(Role::of("crew-station", None) == Some(Role::Station));
        assert!(Role::of("display-mfd-nav", None) == Some(Role::Display(station::Display::MfdNav)));
        assert!(Role::of("display-radar", None).is_none());
        assert!(Role::of("hud-combiner", None) == Some(Role::Combiner));
        assert!(Role::of("fuselage", Some(&json!({ "cockpitHidden": true }))) == Some(Role::Exterior));
        assert!(Role::of("fuselage", None).is_none());
        // A moving part keeps its role.
        assert!(Role::of("turret-traverse", Some(&json!({ "cockpitHidden": true }))) == Some(Role::Turret));
    }

    /// A C172 sinking at 15 m/s, 1 m above the ground last found under it, for two seconds, over a world whose only
    /// mesh (if any) is a plane at `floor`. Returns how it ended, if it did.
    fn sink(floor: Option<f32>) -> Option<&'static str> {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, AssetPlugin::default())).init_asset::<Mesh>();
        let mut time = Time::<()>::default();
        time.advance_by(Duration::from_millis(50));
        app.insert_resource(time).init_resource::<Pilot>().init_resource::<Controls>().init_resource::<Weather>().insert_resource(Frame::new(46.0, 7.7, 0.0));
        if let Some(y) = floor {
            let mesh = Plane3d::default().mesh().size(10_000.0, 10_000.0).build();
            let aabb = mesh.compute_aabb().unwrap();
            let handle = app.world_mut().resource_mut::<Assets<Mesh>>().add(mesh);
            let tf = Transform::from_xyz(0.0, y, 0.0);
            app.world_mut().spawn((Mesh3d(handle), tf, GlobalTransform::from(tf), aabb, InheritedVisibility::VISIBLE, ViewVisibility::default()));
        }
        let mut v = Vehicle::new(catalog::find("c172").unwrap(), 0.0, true);
        v.ground = 6_999.0;
        v.ground_found = true;
        v.velocity = Vec3::new(0.0, -15.0, -30.0);
        let e = app.world_mut().spawn((Transform::from_xyz(0.0, 7_000.0, 0.0), v)).id();
        for _ in 0..40 {
            app.world_mut().run_system_once(probe_ground).unwrap();
            app.world_mut().run_system_once(fly_aircraft).unwrap();
            if let Some(why) = app.world().get::<Vehicle>(e).unwrap().destroyed {
                return Some(why);
            }
        }
        None
    }

    #[test]
    fn no_crash_into_ground_the_rays_do_not_find() {
        // High up the tiles below are out of view: the height last found is no ground to hit.
        assert_eq!(sink(None), None);
    }

    #[test]
    fn crashes_into_ground_the_rays_find() {
        assert_eq!(sink(Some(6_990.0)), Some("CRASHED"));
    }

    #[test]
    fn the_ground_plane_is_fitted_and_the_hull_lies_along_it() {
        let truth = GroundPlane { height: 3.0, right: -0.4, back: 0.7 };
        let points = [(-1.5, -3.5), (-1.5, 0.0), (-1.5, 3.5), (1.5, -3.5), (1.5, 0.0), (1.5, 3.5)].map(|(x, z)| Some(Vec3::new(x, truth.at(x, z), z)));
        let fit = GroundPlane::fit(&points, None).unwrap();
        assert!((fit.height - 3.0).abs() < 1e-4 && (fit.right + 0.4).abs() < 1e-4 && (fit.back - 0.7).abs() < 1e-4);
        // The hull's sides and its length run along the plane.
        let (pitch, bank) = fit.attitude();
        let hull = Quat::from_rotation_x(pitch) * Quat::from_rotation_z(-bank);
        for axis in [hull * Vec3::X, hull * Vec3::Z] {
            assert!((axis.y - (fit.right * axis.x + fit.back * axis.z)).abs() < 1e-5, "{axis}");
        }
        // One track's points alone keep the last slope across.
        let left = [points[0], points[1], points[2], None, None, None];
        assert!((GroundPlane::fit(&left, Some(truth)).unwrap().right + 0.4).abs() < 1e-4);
    }

    #[test]
    fn a_lone_bump_is_dropped_but_a_crest_under_both_tracks_is_not() {
        let at = |x: f32, z: f32, y: f32| Some(Vec3::new(x, y, z));
        let mut bump = [at(-1.5, -3.5, 0.0), at(-1.5, 0.0, 0.0), at(-1.5, 3.5, 0.0), at(1.5, -3.5, 1.5), at(1.5, 0.0, 0.0), at(1.5, 3.5, 0.0)];
        let plane = ground_under(&mut bump, None).unwrap();
        assert!(bump[3].is_none() && plane.height.abs() < 1e-4 && plane.right.abs() < 1e-4);
        let crest = |z: f32| -0.5 * z.abs();
        let mut ridge = [-1.5, 1.5].map(|x| [-3.5, 0.0, 3.5].map(|z| at(x, z, crest(z)))).concat().try_into().unwrap();
        ground_under(&mut ridge, None).unwrap();
        assert!(ridge.iter().all(Option::is_some));
    }

}
