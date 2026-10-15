//! Bevy spike: Google Photorealistic 3D Tiles over Berlin, in two modes.
//! - Sandbox (default): fly around, spawn the app's vehicles and drive, fly and shoot them (`sandbox.rs`).
//! - Benchmark (`?bench`): N moving units and the scripted camera path of `../scenario.json`. The Cesium baseline in
//!   `../cesium-baseline` does the same; `../bench.js` measures both.
//!
//! Query params: `bench`: benchmark mode; `n`: number of moving units (default: scenario.json in the benchmark, none
//! in the sandbox); `falloff`: the crate's `detail_falloff_m` (default: the crate's 2000 m; 0 turns off the
//! distance-relaxed detail that Cesium does not apply); `loads`: tile loads in flight (default: 48 in the sandbox, the
//! crate's 16 in the benchmark); `lead`: seconds ahead of the camera the tiles stream for (default: 0.75 in the
//! sandbox, 0 in the benchmark); `view`: degrees past each edge of the screen the tiles are chosen for, 180 or more
//! for all round (default: all round in the sandbox, the screen in the benchmark); `floor=0`: leave the tiles' detail
//! floor at the world frame's plane instead of lowering it to the ground (`TileFloor`).

// The sandbox's HUD state is one large `json!` literal.
#![recursion_limit = "256"]

mod catalog;
mod geoid;
mod origin;
mod physics;
mod sandbox;
mod scenario;
mod weather;

use bevy::asset::AssetMetaCheck;
use bevy::camera::CameraProjection;
use bevy::camera::primitives::Frustum;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::prelude::*;
use bevy::window::PrimaryWindow;
use bevy::math::{DMat4, DVec3};
use bevy_3d_tiles::{
    EcefOrigin, P3dtParams, TileGeometry, Tiles3dAttach, Tiles3dCamera, Tiles3dConfig, Tiles3dDecodeStats, Tiles3dPlugin, Tiles3dSet, Tiles3dSets, Tiles3dTile, TilesetCredits,
};
use scenario::{Enu, Orbit, Scenario};

/// Cesium ion's external asset for Google Photorealistic 3D Tiles (`PHOTOREAL_ION_ASSET`, packages/geo/src/layers.ts).
#[cfg(target_arch = "wasm32")]
const PHOTOREAL_ION_ASSET: u32 = 2_275_207;

/// The `key` query parameter of the resolver's root URL. The crate opens Google's root itself and appends the key to
/// every request of the session.
#[cfg(target_arch = "wasm32")]
fn key_of(url: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    query.split('&').find_map(|p| p.strip_prefix("key=")).map(str::to_owned)
}

/// Symbol size on screen (px) and its lift above the unit, as in the baseline (billboard pixelOffset).
const SYMBOL_PX: f32 = 16.0;
const SYMBOL_LIFT_PX: f32 = 20.0;
const COLORS: [Color; 4] = [
    Color::srgb(0.90, 0.25, 0.20),
    Color::srgb(0.20, 0.55, 0.95),
    Color::srgb(0.95, 0.75, 0.15),
    Color::srgb(0.30, 0.80, 0.40),
];

/// What the page was opened with.
pub struct Options {
    pub bench: bool,
    pub units: Option<usize>,
    pub falloff: Option<f64>,
    pub loads: Option<usize>,
    pub lead: Option<f32>,
    pub view: Option<f32>,
    /// Lower the tiles' detail floor to the ground (`TileFloor`); `floor=0` turns it off.
    pub floor: bool,
    pub device_pixel_ratio: f64,
}

#[derive(Resource)]
struct Spike {
    key: String,
    bench: bool,
    sse_px: f64,
    orbits: Vec<Orbit>,
    /// `Time::elapsed_secs_f64` at scenario start (the first frame).
    start: Option<f64>,
    tiles_seen: u64,
    mem_timer: f32,
    /// The decode stats at the last `window.__tileStats` publish (for the per-second rates).
    stats_last: Tiles3dDecodeStats,
}

#[derive(Component)]
struct Unit(usize);

#[derive(Component)]
struct Symbol(usize);

/// ENU (east, north, up) → Bevy world (east +X, up +Y, north −Z), the frame `geodesy::world_from_ecef` sets up.
fn world(p: Enu) -> Vec3 {
    Vec3::new(p[0] as f32, p[2] as f32, -p[1] as f32)
}

fn run(key: String, o: Options) {
    let sc = scenario::load();
    let n = o.units.unwrap_or(if o.bench { sc.units } else { 0 });
    // Cesium's maximumScreenSpaceError is in CSS pixels, this crate's threshold in physical pixels.
    let sse_px = sc.sse * o.device_pixel_ratio;
    let (bench, falloff) = (o.bench, o.falloff);
    let defaults = Tiles3dConfig::default();
    // The sandbox streams wider and ahead: at a jet's 150–250 m/s, 16 loads (~50 tiles/s, each waiting ~0.3 s on
    // Google) left the ground below smeared for seconds. Measured on the same hands-off MiG-29 flight over Berlin
    // (variance of a Laplacian over the ground, two runs): 16 loads 445–584, 48 loads 586–618, 48 loads with 0.75 s
    // of lead 797; a 1.5 s lead was no sharper and cancelled twice the requests. The benchmark keeps the crate's
    // defaults, which its numbers in ../README.md were measured with.
    let (loads, lead) = if bench { (defaults.max_concurrent_loads, 0.0) } else { (48, 0.75) };
    // The sandbox chooses its tiles all round, not only on screen: the crate culls the tiles it streams to the view,
    // so a quick look round met ground that had never been asked for, and every hole in it showed the backdrop (the
    // atmosphere's beige ground and blue sky) until the tiles landed. Measured with backdrop-coloured pixels below the
    // horizon: spinning the free camera at 360°/s over Ludwigsfelde, holes in 6 of 33 frames before, none after; on
    // the hands-off MiG-29 flight over Berlin (holes at the screen's bottom edge even flying straight), 10–12 of 30
    // before, none after, for a resident 150 MB instead of 136 MB. The cost is detail in fast low flight: the ground
    // there was ~15% less sharp (Laplacian variance 790–845 against 960–970; a 60° margin was no sharper, 72 loads
    // no better); at rest it is the same.
    let view = if bench { 0.0 } else { ALL_ROUND_DEG };
    let mut app = App::new();
    app.insert_resource(Spike { key, bench, sse_px, orbits: scenario::units(sc.seed, n), start: None, tiles_seen: 0, mem_timer: 0.0, stats_last: default() })
        .insert_resource(Tiles3dConfig {
            sse_threshold_px: sse_px,
            // The crate's advice for wasm: a few hundred MB before the cut coarsens instead of running out of memory.
            memory_budget_bytes: 512 * 1024 * 1024,
            detail_falloff_m: falloff.unwrap_or(defaults.detail_falloff_m),
            max_concurrent_loads: o.loads.unwrap_or(loads),
            ..defaults
        })
        .insert_resource(Lead { secs: o.lead.unwrap_or(lead), margin_deg: o.view.unwrap_or(view), ..default() })
        .insert_resource(TileFloor { enabled: !bench && o.floor, ..default() })
        .insert_resource(sc)
        .insert_resource(ClearColor(Color::srgb(0.78, 0.84, 0.90)))
        .add_plugins(
            DefaultPlugins
                .set(WindowPlugin {
                    primary_window: Some(Window {
                        title: "Flight Simulator".into(),
                        canvas: Some("#canvas".into()),
                        fit_canvas_to_parent: true,
                        prevent_default_event_handling: true,
                        ..default()
                    }),
                    ..default()
                })
                // No .meta files next to the models: without this every load asks the server for one first.
                .set(AssetPlugin { meta_check: AssetMetaCheck::Never, ..default() }),
        )
        .add_plugins(Tiles3dPlugin)
        .add_systems(Startup, setup)
        .add_systems(Update, (start_bench, move_units, place_symbols, report).chain())
        .add_systems(
            Update,
            (
                (probe_ground, lead_tiles).chain().after(Tiles3dSet::Receive).before(Tiles3dSet::Drive),
                (unlead_tiles, lift_tiles).chain().after(Tiles3dSet::Drive),
            ),
        );
    if bench {
        app.add_systems(Update, drive_camera.before(move_units));
    } else {
        app.add_plugins(sandbox::SandboxPlugin);
    }
    app.run();
}

fn setup(
    mut commands: Commands,
    spike: Res<Spike>,
    sc: Res<Scenario>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut attach: MessageWriter<Tiles3dAttach>,
) {
    let c = &sc.center;
    let frame = origin::Frame::new(c.lat, c.lon, c.elev);
    commands.insert_resource(EcefOrigin { world_from_ecef: Some(frame.world_from_ecef) });
    commands.insert_resource(frame);
    // No tonemapping: the tiles' baked photo colours come through as they are.
    commands.spawn((
        Camera3d::default(),
        Transform::IDENTITY,
        Tiles3dCamera,
        Tonemapping::None,
        AmbientLight { brightness: 900.0, ..default() },
    ));
    // Light for the vehicle models only: the tiles are unlit.
    // It lights the on-foot view's weapon too (render layer 1, `sandbox/infantry/viewmodel.rs`).
    // Only the vehicles cast shadows (the tiles are kept out of the maps, `sandbox/paint.rs`), so the cascades hug the
    // camera: the near one holds the aircraft of the chase view (a light aircraft 15 m out, ~2 cm texels) and the
    // cockpit around the eye; the far one an airliner's 50 m chase, a zoomed-out view and the traffic nearby.
    commands.spawn((
        DirectionalLight { illuminance: 9_000.0, shadow_maps_enabled: !spike.bench, ..default() },
        bevy::light::CascadeShadowConfigBuilder {
            num_cascades: 2,
            minimum_distance: 0.1,
            first_cascade_far_bound: 30.0,
            maximum_distance: 400.0,
            overlap_proportion: 0.2,
        }
        .build(),
        Transform::from_rotation(Quat::from_euler(EulerRot::YXZ, 0.6, -0.9, 0.0)),
        bevy::camera::visibility::RenderLayers::from_layers(&[0, 1]),
    ));

    let anchor = commands.spawn((Transform::IDENTITY, Visibility::default(), sandbox::TilesAnchor)).id();
    attach.write(Tiles3dAttach {
        anchor,
        url: bevy_3d_tiles::GOOGLE_P3DT_ROOT_URL.into(),
        local: Transform::IDENTITY,
        owner_id: None,
        label: "google".into(),
        p3dt: Some(P3dtParams { api_key: spike.key.clone(), daily_request_cap: 2_000 }),
        sse_threshold_px: Some(spike.sse_px),
    });

    // One mesh and four materials for all units: Bevy batches them into a handful of instanced draws.
    let cone = meshes.add(Cone { radius: 6.0, height: 30.0 });
    let quad = meshes.add(Rectangle::new(1.0, 1.0));
    let mats: Vec<_> = COLORS.iter().map(|&base_color| materials.add(StandardMaterial { base_color, unlit: true, ..default() })).collect();
    for i in 0..spike.orbits.len() {
        let m = mats[i % mats.len()].clone();
        commands.spawn((Unit(i), sandbox::NoHit, Mesh3d(cone.clone()), MeshMaterial3d(m.clone()), Transform::default()));
        commands.spawn((Symbol(i), sandbox::NoHit, Mesh3d(quad.clone()), MeshMaterial3d(m), Transform::default()));
    }
}

/// Where the tiles stream for: the camera's position this many seconds ahead, so a fast jet flies into ground that
/// has already refined instead of ground that starts refining as it arrives. The crate has no look-ahead of its own.
/// And what they stream for: the view widened by `margin_deg` past each edge of the screen, so turning the camera
/// meets ground that is already there.
#[derive(Resource, Default)]
struct Lead {
    secs: f32,
    /// Degrees past each edge of the screen; `ALL_ROUND_DEG` or more chooses tiles all round the camera.
    margin_deg: f32,
    last: Option<Vec3>,
    /// Smoothed horizontal velocity (m/s).
    velocity: Vec3,
    /// The camera's own transform and frustum while the tiles see the lead, widened ones.
    real: Option<(GlobalTransform, Frustum)>,
}

/// The farthest ahead (m) the tiles stream for.
const MAX_LEAD_M: f32 = 1_500.0;

/// A view margin at least this wide chooses tiles all round the camera.
const ALL_ROUND_DEG: f32 = 180.0;

/// The frustum the crate streams tiles for: the camera's view from `at`, widened by `margin_deg` past each edge (each
/// half-angle capped short of 90°), or one that culls nothing (zero half-spaces) from `ALL_ROUND_DEG` on. Only
/// its sides matter: the crate tests without the far plane, and distant tiles coarsen by their screen-space error.
fn tile_frustum(at: &Transform, projection: &Projection, margin_deg: f32) -> Option<Frustum> {
    if margin_deg >= ALL_ROUND_DEG {
        return Some(Frustum::default());
    }
    let Projection::Perspective(p) = projection else { return None };
    let margin = margin_deg.to_radians();
    let cap = 89f32.to_radians();
    let half_v = (p.fov / 2.0 + margin).min(cap);
    let half_h = ((p.fov / 2.0).tan() * p.aspect_ratio).atan() + margin;
    let wide = PerspectiveProjection { fov: 2.0 * half_v, aspect_ratio: half_h.min(cap).tan() / half_v.tan(), ..p.clone() };
    let clip_from_world = wide.get_clip_from_view() * at.to_matrix().inverse();
    Some(Frustum(bevy::math::primitives::ViewFrustum::from_clip_from_world(&clip_from_world)))
}

/// The floor under the tiles' detail. The crate never measures a tile as nearer than the camera's height above the
/// world frame's ground plane (its guard against holes under a high camera, which sits inside its coarse tiles' tall
/// boxes), and that plane is the frame's ellipsoid height at the start (Berlin's 75 m) wherever the frame moves. Over
/// high ground the "height" therefore counted the mountain below too: over Zermatt at 2,760 m, 260 m above the
/// slope, every tile within 2.7 km was measured as 2.7 km away and chosen ~10× too coarse (44 MB resident, the loads
/// idle, slopes in blurred facets). For the crate's pass only, its world is dropped so that plane sits just under the
/// nearest ground found by a few rays; the tiles' root lifts them back to where they are drawn.
#[derive(Resource, Default)]
struct TileFloor {
    enabled: bool,
    /// How far (m) the crate's world sits below ours.
    drop: f32,
    /// The distance (m) to the tiles along each probe ray, and when it was measured (s).
    probes: [Option<(f32, f64)>; PROBES],
    next: usize,
    /// When the next probe is due (s), and the probes' cost (ms, count) for `__tileStats`.
    probe_at: f64,
    probe_ms: f64,
    probe_n: u32,
    /// When `drop` last changed (s): each change re-places every resident tile.
    changed: f64,
    /// The origin last handed to the crate, to tell it from one the sandbox wrote since (a rebase, a teleport).
    written: Option<DMat4>,
    /// The tileset's root entity, which the tiles hang from.
    root: Option<Entity>,
    /// When the crate's pass began this frame, and its total time (ms) and frames since the last `__tileStats`.
    drive_from: Option<bevy::platform::time::Instant>,
    drive_ms: f64,
    drive_max_ms: f64,
    drive_n: u32,
}

/// Probe rays: straight down, then 25° below the horizon ahead, left, behind and right.
const PROBES: usize = 5;
/// Seconds between probes (each direction is measured every `PROBES` of them), and how long (s) one counts.
const PROBE_EVERY: f64 = 0.2;
const PROBE_TTL: f64 = 3.0;

impl TileFloor {
    /// The crate's camera height for a camera at world height `cam_y`: just under the nearest ground. Hands the crate
    /// the origin dropped to match and returns the drop.
    fn lower(&mut self, now: f64, cam_y: f32, frame: &origin::Frame, origin: &mut EcefOrigin) -> f32 {
        if !self.enabled || self.root.is_none() {
            self.written = None;
            return 0.0;
        }
        let near = self.probes.iter().flatten().filter(|(_, at)| now - at < PROBE_TTL).fold(f32::INFINITY, |m, (d, _)| m.min(*d));
        // Only well off the mark, and not more than once a second: a change re-places every tile. Too low a floor
        // costs little (the far detail relaxes a little sooner), too high one blurs everything nearer than it.
        let floor = cam_y - self.drop;
        if near.is_finite() && now - self.changed > 1.0 && (floor > near * 1.25 + 20.0 || floor < near * 0.5 - 20.0) {
            let drop = (cam_y - 0.8 * near).max(0.0);
            if drop != self.drop {
                self.drop = drop;
                self.changed = now;
            }
        }
        let dropped = DMat4::from_translation(DVec3::new(0.0, -f64::from(self.drop), 0.0)) * frame.world_from_ecef;
        if origin.world_from_ecef != Some(dropped) {
            origin.world_from_ecef = Some(dropped);
        }
        self.written = Some(dropped);
        self.drop
    }
}

/// One probe ray from the camera to the tiles every `PROBE_EVERY`, round the `PROBES` directions.
fn probe_ground(
    time: Res<Time>,
    mut floor: ResMut<TileFloor>,
    cam: Single<&GlobalTransform, With<Tiles3dCamera>>,
    tiles: Query<(), With<TileGeometry>>,
    mut ray_cast: MeshRayCast,
) {
    if !floor.enabled || floor.root.is_none() {
        return;
    }
    // A ray against the tiles costs a broad pass over every tile mesh and a narrow one over the few it crosses: a
    // few a second are enough for a floor that only has to be within ~25% of the ground.
    let now = time.elapsed_secs_f64();
    if now < floor.probe_at {
        return;
    }
    floor.probe_at = now + PROBE_EVERY;
    let started = bevy::platform::time::Instant::now();
    let i = floor.next;
    floor.next = (i + 1) % PROBES;
    let ahead = cam.forward().with_y(0.0).normalize_or(Vec3::NEG_Z);
    let dir = if i == 0 {
        Vec3::NEG_Y
    } else {
        let (s, c) = 25f32.to_radians().sin_cos();
        Quat::from_rotation_y(std::f32::consts::FRAC_PI_2 * (i - 1) as f32) * ahead * c - Vec3::Y * s
    };
    let Ok(dir) = Dir3::new(dir) else { return };
    let filter = |e: Entity| tiles.contains(e);
    let settings = MeshRayCastSettings::default().with_filter(&filter).with_visibility(RayCastVisibility::Visible).always_early_exit();
    let d = ray_cast.cast_ray(Ray3d::new(cam.translation(), dir), &settings).first().map_or(f32::INFINITY, |(_, hit)| hit.distance);
    floor.probes[i] = Some((d, now));
    floor.probe_ms += started.elapsed().as_secs_f64() * 1e3;
    floor.probe_n += 1;
}

/// Moves the tile camera ahead and widens its view for the crate's streaming pass only (`unlead_tiles` puts both
/// back). Horizontal only, so the camera's height above the ground, which sets the detail right below it, stays
/// true; the drop of `TileFloor` lowers it with the crate's whole world.
fn lead_tiles(
    time: Res<Time>,
    mut lead: ResMut<Lead>,
    mut floor: ResMut<TileFloor>,
    frame: Res<origin::Frame>,
    mut origin: ResMut<EcefOrigin>,
    mut cam: Single<(&mut GlobalTransform, &mut Frustum, &Projection), With<Tiles3dCamera>>,
) {
    let (tf, frustum, projection) = &mut *cam;
    let at = tf.translation();
    let dt = time.delta_secs();
    if let Some(last) = lead.last
        && dt > 0.0
    {
        let v = (at - last).with_y(0.0) / dt;
        // The world re-centring under the camera (origin.rs) jumps it by kilometres: that is not motion.
        if v.length() < 3_000.0 {
            lead.velocity = lead.velocity.lerp(v, (dt * 4.0).min(1.0));
        }
    }
    lead.last = Some(at);
    floor.drive_from = Some(bevy::platform::time::Instant::now());
    let drop = floor.lower(time.elapsed_secs_f64(), at.y, &frame, &mut origin);
    if lead.secs <= 0.0 && lead.margin_deg <= 0.0 && drop == 0.0 {
        return;
    }
    let ahead = (lead.velocity * lead.secs.max(0.0)).clamp_length_max(MAX_LEAD_M);
    let mut t = tf.compute_transform();
    t.translation += ahead - Vec3::Y * drop;
    // The frustum from the lead position too: the one Bevy keeps is the real camera's, from the last frame.
    let wide = tile_frustum(&t, projection, lead.margin_deg.max(0.0)).unwrap_or_default();
    lead.real = Some((**tf, **frustum));
    **tf = GlobalTransform::from(t);
    **frustum = wide;
}

fn unlead_tiles(mut lead: ResMut<Lead>, mut cam: Single<(&mut GlobalTransform, &mut Frustum), With<Tiles3dCamera>>) {
    if let Some((tf, frustum)) = lead.real.take() {
        *cam.0 = tf;
        *cam.1 = frustum;
    }
}

/// Lifts the tiles back by the drop the crate placed them with: by `TileFloor`'s if it still had the origin handed
/// to it, by none if the sandbox wrote its own since (the tiles were then re-placed in the true frame).
fn lift_tiles(mut floor: ResMut<TileFloor>, origin: Res<EcefOrigin>, tiles: Query<&ChildOf, With<Tiles3dTile>>, mut transforms: Query<&mut Transform, Without<Tiles3dTile>>) {
    if let Some(from) = floor.drive_from.take() {
        let ms = from.elapsed().as_secs_f64() * 1e3;
        floor.drive_ms += ms;
        floor.drive_max_ms = floor.drive_max_ms.max(ms);
        floor.drive_n += 1;
    }
    if !floor.enabled {
        return;
    }
    if floor.root.is_none_or(|r| !transforms.contains(r)) {
        floor.root = tiles.iter().next().map(ChildOf::parent);
        floor.written = None;
    }
    let Some(mut root) = floor.root.and_then(|r| transforms.get_mut(r).ok()) else { return };
    let lift = if floor.written.is_some() && origin.world_from_ecef == floor.written { floor.drop } else { 0.0 };
    let want = Vec3::Y * lift;
    if root.translation != want {
        root.translation = want;
    }
}

fn scene_time(spike: &Spike, time: &Time) -> f64 {
    spike.start.map_or(0.0, |s| time.elapsed_secs_f64() - s)
}

fn start_bench(mut spike: ResMut<Spike>, time: Res<Time>) {
    if spike.start.is_none() {
        spike.start = Some(time.elapsed_secs_f64());
        if spike.bench {
            js::call("__benchStart", None);
        }
    }
}

fn drive_camera(spike: Res<Spike>, time: Res<Time>, mut cam: Single<&mut Transform, With<Tiles3dCamera>>) {
    let (eye, target) = scenario::camera(scene_time(&spike, &time));
    **cam = Transform::from_translation(world(eye)).looking_at(world(target), Vec3::Y);
}

fn move_units(spike: Res<Spike>, time: Res<Time>, frame: Res<origin::Frame>, mut units: Query<(&Unit, &mut Transform)>) {
    let t = scene_time(&spike, &time);
    // The cone's tip is +Y; turn it onto −Z, which `looking_to` points along the direction of travel.
    let tip_forward = Quat::from_rotation_x(-std::f32::consts::FRAC_PI_2);
    for (Unit(i), mut tf) in &mut units {
        let (p, v) = spike.orbits[*i].at(t);
        *tf = Transform::from_translation(world(p)).looking_to(world(v), Vec3::Y);
        tf.rotation *= tip_forward;
        // The units are defined in the first frame; the sandbox may have moved the origin since.
        origin::rebase_transform(&frame.world_from_start, &mut tf);
    }
}

/// Screen-facing squares of a constant pixel size, lifted above their unit: what a Cesium billboard does.
fn place_symbols(
    spike: Res<Spike>,
    time: Res<Time>,
    frame: Res<origin::Frame>,
    cam: Single<(&Transform, &Projection), (With<Tiles3dCamera>, Without<Symbol>)>,
    window: Single<&Window, With<PrimaryWindow>>,
    mut symbols: Query<(&Symbol, &mut Transform)>,
) {
    let t = scene_time(&spike, &time);
    let (cam_tf, projection) = *cam;
    let Projection::Perspective(p) = projection else { return };
    let per_px_at_1m = 2.0 * (p.fov / 2.0).tan() / window.height().max(1.0);
    let up = cam_tf.up();
    for (Symbol(i), mut tf) in &mut symbols {
        let (pos, _) = spike.orbits[*i].at(t);
        let at = frame.world_from_start.transform_point3(world(pos).as_dvec3()).as_vec3();
        let m_per_px = cam_tf.translation.distance(at) * per_px_at_1m;
        tf.translation = at + up * (SYMBOL_LIFT_PX * m_per_px);
        tf.rotation = cam_tf.rotation;
        tf.scale = Vec3::splat(SYMBOL_PX * m_per_px);
    }
}

/// Tile content decoded into the scene (the counterpart of Cesium's `tileLoad`), memory, and the provider's credits.
#[allow(clippy::too_many_arguments)]
fn report(
    mut spike: ResMut<Spike>,
    time: Res<Time>,
    stats: Res<Tiles3dDecodeStats>,
    sets: Res<Tiles3dSets>,
    config: Res<Tiles3dConfig>,
    credits: Res<TilesetCredits>,
    mut floor: ResMut<TileFloor>,
    drawn: Query<(&Mesh3d, &InheritedVisibility), With<TileGeometry>>,
    meshes: Res<Assets<Mesh>>,
) {
    while spike.bench && spike.tiles_seen < stats.tiles {
        spike.tiles_seen += 1;
        js::call("__benchTile", None);
    }
    spike.mem_timer += time.delta_secs();
    if spike.mem_timer >= 1.0 {
        let secs = f64::from(spike.mem_timer);
        spike.mem_timer = 0.0;
        if spike.bench {
            js::report_memory();
        }
        // The streaming state, once a second, for the console (`__tileStats`): tiles decoded per second, their
        // main-thread decode ms per tile over that second (prep, parse, geometry; the crate's texture span is wall
        // time around an await, so it is left out), and the resident bytes against the memory budget, whose overshoot
        // coarsens every tile (the crate's pressure valve, up to 8×) and past 1.5× stops new loads.
        let last = spike.stats_last;
        let n = (stats.tiles - last.tiles) as f64;
        let ms = |i: usize| if n > 0.0 { (stats.stage_ms[i] - last.stage_ms[i]) / n } else { 0.0 };
        let resident = sets.resident_content_bytes() as f64;
        let budget = config.memory_budget_bytes as f64;
        // What the cut draws: tile meshes shown and their triangles (thousands), the GPU's share of the detail.
        let (mut shown, mut tris) = (0u32, 0usize);
        for (mesh, vis) in &drawn {
            if vis.get() {
                shown += 1;
                tris += meshes.get(&mesh.0).map_or(0, |m| m.indices().map_or(m.count_vertices(), |i| i.len()) / 3);
            }
        }
        js::set_global(
            "__tileStats",
            &serde_json::json!({
                "tilesPerS": n / secs,
                "decodeMs": [ms(0), ms(1), ms(2)],
                "worstMs": stats.worst_ms,
                "tiles": stats.tiles,
                "residentMB": resident / 1_048_576.0,
                "pressure": if budget > 0.0 { (resident / budget).clamp(1.0, 8.0) } else { 1.0 },
                "halted": budget > 0.0 && resident > budget * 1.5,
                "falloffM": config.detail_falloff_m,
                // How far the crate's world is dropped (`TileFloor`), and the nearest ground the probes found.
                "floorDropM": floor.drop,
                // The crate's streaming pass (selection over its whole tile tree, scheduling, eviction): ms a frame.
                "driveMs": if floor.drive_n > 0 { floor.drive_ms / f64::from(floor.drive_n) } else { 0.0 },
                "driveMaxMs": floor.drive_max_ms,
                "probeMs": if floor.probe_n > 0 { floor.probe_ms / f64::from(floor.probe_n) } else { 0.0 },
                "shownMeshes": shown,
                "shownTrisK": tris / 1000,
                "nearM": floor.probes.iter().flatten().map(|p| p.0).fold(f32::INFINITY, f32::min).min(1e9),
            })
            .to_string(),
        );
        spike.stats_last = *stats;
        (floor.probe_ms, floor.probe_n, floor.drive_ms, floor.drive_max_ms, floor.drive_n) = (0.0, 0, 0.0, 0.0, 0);
    }
    if credits.is_changed() {
        js::set_attribution(&credits.lines.join(" · "));
    }
}

#[cfg(target_arch = "wasm32")]
mod js {
    use wasm_bindgen::{JsCast, JsValue};

    pub fn call(name: &str, arg: Option<f64>) {
        let Some(win) = web_sys::window() else { return };
        let Ok(f) = js_sys::Reflect::get(&win, &JsValue::from_str(name)) else { return };
        let Ok(f) = f.dyn_into::<js_sys::Function>() else { return };
        let _ = match arg {
            Some(a) => f.call1(&JsValue::NULL, &JsValue::from_f64(a)),
            None => f.call0(&JsValue::NULL),
        };
    }

    pub fn report_memory() {
        let mem: js_sys::WebAssembly::Memory = wasm_bindgen::memory().unchecked_into();
        let bytes = mem.buffer().unchecked_into::<js_sys::ArrayBuffer>().byte_length();
        call("__benchMem", Some(f64::from(bytes)));
    }

    fn element(id: &str) -> Option<web_sys::Element> {
        web_sys::window()?.document()?.get_element_by_id(id)
    }

    /// The tiles' own copyright lines (Google's data providers).
    pub fn set_attribution(text: &str) {
        if let Some(el) = element("attribution") {
            el.set_text_content(Some(text));
        }
    }

    /// The resolver's required credits (its own logo and Google's), trusted HTML from our gateway as in the app.
    pub fn set_resolver_credits(html: &str) {
        set_html("credits", html);
    }

    /// A JSON value as a global on the page (`window[name]`), for the console and tests.
    pub fn set_global(name: &str, json: &str) {
        let Some(win) = web_sys::window() else { return };
        if let Ok(v) = js_sys::JSON::parse(json) {
            let _ = js_sys::Reflect::set(&win, &JsValue::from_str(name), &v);
        }
    }

    /// Our own markup (the sandbox HUD).
    pub fn set_html(id: &str, html: &str) {
        if let Some(el) = element(id) {
            el.set_inner_html(html);
        }
    }

    pub fn set_class(id: &str, class: &str) {
        if let Some(el) = element(id) {
            el.set_class_name(class);
        }
    }

    pub fn set_body_class(class: &str) {
        if let Some(body) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.body()) {
            body.set_class_name(class);
        }
    }

    /// Commands the menus queued since the last frame (`window.__cmds`, JSON strings).
    pub fn take_commands() -> Vec<String> {
        let Some(win) = web_sys::window() else { return Vec::new() };
        let key = JsValue::from_str("__cmds");
        let Ok(queue) = js_sys::Reflect::get(&win, &key) else { return Vec::new() };
        if !js_sys::Array::is_array(&queue) {
            return Vec::new();
        }
        let queue = js_sys::Array::from(&queue);
        if queue.length() == 0 {
            return Vec::new();
        }
        let _ = js_sys::Reflect::set(&win, &key, &js_sys::Array::new());
        queue.iter().filter_map(|c| c.as_string()).collect()
    }

    /// The controller's state this frame (`window.__padPoll`, pad.js), as JSON.
    pub fn pad_poll() -> Option<String> {
        let win = web_sys::window()?;
        let f = js_sys::Reflect::get(&win, &JsValue::from_str("__padPoll")).ok()?.dyn_into::<js_sys::Function>().ok()?;
        f.call0(&JsValue::NULL).ok()?.as_string()
    }

    /// Whether a multiplayer session is open (net.js), and a message for the other players.
    pub fn net_active() -> bool {
        web_sys::window().and_then(|w| js_sys::Reflect::get(&w, &JsValue::from_str("__netActive")).ok()).is_some_and(|v| v.is_truthy())
    }
    pub fn net_send(json: &str) {
        call_str("__netSend", json);
    }
    fn call_str(name: &str, arg: &str) {
        let Some(win) = web_sys::window() else { return };
        let Ok(f) = js_sys::Reflect::get(&win, &JsValue::from_str(name)) else { return };
        if let Ok(f) = f.dyn_into::<js_sys::Function>() {
            let _ = f.call1(&JsValue::NULL, &JsValue::from_str(arg));
        }
    }

    /// Hands the sandbox HUD its state (JSON) for `hud.js` to draw.
    pub fn hud(state: &str) {
        let Some(win) = web_sys::window() else { return };
        let Ok(f) = js_sys::Reflect::get(&win, &JsValue::from_str("__hud")) else { return };
        if let Ok(f) = f.dyn_into::<js_sys::Function>() {
            let _ = f.call1(&JsValue::NULL, &JsValue::from_str(state));
        }
    }

    /// Whether the browser still holds the pointer lock (it drops it on Esc without telling the window).
    pub fn pointer_locked() -> bool {
        let doc = web_sys::window().and_then(|w| w.document());
        doc.and_then(|d| js_sys::Reflect::get(&d, &JsValue::from_str("pointerLockElement")).ok()).is_some_and(|el| !el.is_null() && !el.is_undefined())
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod js {
    pub fn call(_name: &str, _arg: Option<f64>) {}
    pub fn report_memory() {}
    pub fn set_global(_name: &str, _json: &str) {}
    pub fn set_attribution(text: &str) {
        if !text.is_empty() {
            bevy::log::info!("attribution: {text}");
        }
    }
    pub fn set_html(_id: &str, _html: &str) {}
    pub fn set_class(_id: &str, _class: &str) {}
    pub fn set_body_class(_class: &str) {}
    pub fn hud(_state: &str) {}
    pub fn take_commands() -> Vec<String> {
        Vec::new()
    }
    pub fn pad_poll() -> Option<String> {
        None
    }
    pub fn net_active() -> bool {
        false
    }
    pub fn net_send(_json: &str) {}
    pub fn pointer_locked() -> bool {
        true
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_futures::JsFuture;

    console_error_panic_hook::set_once();
    let win = web_sys::window().expect("window");
    let query = win.location().search().ok().and_then(|s| web_sys::UrlSearchParams::new_with_str(&s).ok());
    let param = |k: &str| query.as_ref().and_then(|q| q.get(k));
    let options = Options {
        bench: query.as_ref().is_some_and(|q| q.has("bench")),
        units: param("n").and_then(|n| n.parse().ok()),
        falloff: param("falloff").and_then(|f| f.parse().ok()),
        loads: param("loads").and_then(|n| n.parse().ok()),
        lead: param("lead").and_then(|s| s.parse().ok()),
        view: param("view").and_then(|s| s.parse().ok()),
        floor: param("floor").is_none_or(|f| f != "0"),
        device_pixel_ratio: win.device_pixel_ratio(),
    };
    // The tileset endpoint comes from the workspace gateway's tile resolver at runtime, as in the app's globe
    // (GlobeView's `photorealIon`): Google's root URL carrying the resolver account's key, plus required credits.
    // It uses the gateway's public, photoreal-only route (as the marketing site's Berlin view does), so no sign-in.
    wasm_bindgen_futures::spawn_local(async move {
        let endpoint: Result<(String, Vec<String>), JsValue> = async {
            let url = format!("/api/marketing/tiles/ion/{PHOTOREAL_ION_ASSET}");
            let res: web_sys::Response = JsFuture::from(win.fetch_with_str(&url)).await?.dyn_into()?;
            let body = JsFuture::from(res.json()?).await?;
            let get = |k: &str| js_sys::Reflect::get(&body, &JsValue::from_str(k));
            let url = get("url")?.as_string().ok_or_else(|| JsValue::from_str(&format!("tile resolver answered {}", res.status())))?;
            let credits = js_sys::Array::from(&get("attributions")?)
                .iter()
                .filter_map(|a| js_sys::Reflect::get(&a, &JsValue::from_str("html")).ok()?.as_string())
                .collect();
            Ok((url, credits))
        }
        .await;
        match endpoint.map(|(url, credits)| (key_of(&url), credits)) {
            Ok((Some(key), credits)) => {
                js::set_resolver_credits(&credits.join(" "));
                run(key, options);
            }
            Ok((None, _)) => panic!("the resolver's tileset URL carries no key"),
            Err(e) => {
                js::set_attribution(&format!("Tile endpoint unavailable: {e:?}. Is the baseline dev server running?"));
                panic!("tile endpoint unavailable: {e:?}");
            }
        }
    });
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let key = std::env::var("GOOGLE_MAPS_API_KEY").expect("set GOOGLE_MAPS_API_KEY");
    let bench = std::env::args().any(|a| a == "--bench");
    let units = std::env::args().skip(1).find_map(|n| n.parse().ok());
    run(key, Options { bench, units, falloff: None, loads: None, lead: None, view: None, floor: true, device_pixel_ratio: 1.0 });
}

#[cfg(test)]
mod tests {
    use bevy::camera::primitives::Sphere;
    use bevy::ecs::system::RunSystemOnce;
    use bevy::math::Vec3A;

    use super::*;

    fn seen(frustum: &Frustum, at: Vec3) -> bool {
        frustum.intersects_sphere(&Sphere { center: Vec3A::from(at), radius: 1.0 }, false)
    }

    /// The camera at 900 m looking north (−Z) and 25° down, as in the spin test over Ludwigsfelde.
    fn camera() -> (Transform, Projection) {
        let tf = Transform::from_xyz(0.0, 900.0, 0.0).with_rotation(Quat::from_rotation_x(-25f32.to_radians()));
        (tf, Projection::Perspective(PerspectiveProjection { aspect_ratio: 16.0 / 9.0, ..default() }))
    }

    #[test]
    fn all_round_chooses_ground_behind_and_beside() {
        let (tf, projection) = camera();
        let f = tile_frustum(&tf, &projection, ALL_ROUND_DEG).unwrap();
        for p in [Vec3::new(0.0, 0.0, 2_000.0), Vec3::new(3_000.0, 0.0, 0.0), Vec3::new(0.0, 0.0, 0.0), Vec3::new(0.0, 0.0, -5_000.0)] {
            assert!(seen(&f, p), "{p} culled");
        }
    }

    #[test]
    fn a_margin_widens_the_view_but_still_culls_behind() {
        let (tf, projection) = camera();
        // 70° right of the view's axis, on the ground: off screen (the half-width is ~39°), inside a 45° margin.
        let side = Vec3::new(2_000.0 * 70f32.to_radians().sin(), 0.0, -2_000.0 * 70f32.to_radians().cos());
        assert!(!seen(&tile_frustum(&tf, &projection, 0.0).unwrap(), side));
        let wide = tile_frustum(&tf, &projection, 45.0).unwrap();
        assert!(seen(&wide, side));
        assert!(!seen(&wide, Vec3::new(0.0, 0.0, 2_000.0)));
    }

    #[test]
    fn unlead_restores_the_camera() {
        let mut app = App::new();
        app.insert_resource(Time::<()>::default()).insert_resource(Lead { secs: 0.75, margin_deg: ALL_ROUND_DEG, velocity: Vec3::X * 200.0, ..default() });
        app.init_resource::<TileFloor>().init_resource::<EcefOrigin>().insert_resource(origin::Frame::new(52.5, 13.4, 75.0));
        let (tf, projection) = camera();
        let real_frustum = tile_frustum(&tf, &projection, 0.0).unwrap();
        let cam = app.world_mut().spawn((Tiles3dCamera, GlobalTransform::from(tf), real_frustum, projection)).id();
        app.world_mut().run_system_once(lead_tiles).unwrap();
        let during = *app.world().get::<GlobalTransform>(cam).unwrap();
        assert!(during.translation().x > 100.0, "the tiles stream ahead");
        assert!(seen(app.world().get::<Frustum>(cam).unwrap(), Vec3::new(0.0, 0.0, 2_000.0)), "and all round");
        app.world_mut().run_system_once(unlead_tiles).unwrap();
        assert_eq!(*app.world().get::<GlobalTransform>(cam).unwrap(), GlobalTransform::from(tf));
        assert!(!seen(app.world().get::<Frustum>(cam).unwrap(), Vec3::new(0.0, 0.0, 2_000.0)));
    }

    #[test]
    fn the_floor_drops_to_the_nearest_ground() {
        let frame = origin::Frame::new(45.98, 7.66, 75.0);
        let mut origin = EcefOrigin { world_from_ecef: Some(frame.world_from_ecef) };
        let mut floor = TileFloor { enabled: true, root: Some(Entity::PLACEHOLDER), changed: -10.0, ..default() };
        // Nothing found yet: the crate keeps the true frame.
        assert_eq!(floor.lower(0.0, 2_740.0, &frame, &mut origin), 0.0);
        assert_eq!(origin.world_from_ecef, Some(frame.world_from_ecef));
        // 260 m above the slope, 2,740 m above the frame's plane: the crate's camera ends up ~210 m above its plane.
        floor.probes = [260.0, 900.0, f32::INFINITY, 400.0, 700.0].map(|d| Some((d, 0.0)));
        let drop = floor.lower(0.5, 2_740.0, &frame, &mut origin);
        assert!((2_740.0 - drop - 208.0).abs() < 1.0, "{drop}");
        let world = origin.world_from_ecef.unwrap();
        let p = DVec3::new(6_378_137.0, 0.0, 0.0);
        assert!(((frame.world_from_ecef.transform_point3(p) - world.transform_point3(p)) - DVec3::Y * f64::from(drop)).length() < 1e-6);
        // Climbing 100 m keeps it (the floor rises with the camera): no re-placing every tile.
        floor.probes.iter_mut().flatten().for_each(|p| *p = (p.0 + 100.0, 2.0));
        assert_eq!(floor.lower(3.0, 2_840.0, &frame, &mut origin), drop);
        // Stale probes change nothing.
        assert_eq!(floor.lower(10.0, 6_000.0, &frame, &mut origin), drop);
    }
}
