//! Rain and snow, in the scene rather than painted over it:
//! - Particles in the air around the camera (`assets/shaders/precipitation.wgsl`): one mesh of quads the vertex shader
//!   places in nested boxes of air that fall and drift with the wind and wrap around the camera. Flying through them
//!   streaks them by the camera's own speed, and the ground and vehicles hide the ones behind them.
//! - Water on the lens (`assets/shaders/lens_rain.wgsl`), a pass over the rendered view: beads land and dry, larger
//!   drops run down, each refracting the view. The lens wets up in rain (a little in snow, as flakes melt) and dries
//!   slowly after it, faster in a fast airflow.

use bevy::asset::RenderAssetUsages;
use bevy::camera::visibility::NoFrustumCulling;
use bevy::core_pipeline::fullscreen_material::{FullscreenMaterial, FullscreenMaterialPlugin};
use bevy::light::NotShadowCaster;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;
use bevy::render::extract_component::ExtractComponent;
use bevy::render::render_resource::{AsBindGroup, ShaderType};
use bevy::shader::ShaderRef;
use bevy_3d_tiles::Tiles3dCamera;

use super::{Sky, Weather, smoothstep};
use crate::origin::Frame;

/// Particles in all (at full precipitation).
const PARTICLES: u32 = 24_000;
/// The nested boxes of air: size (m) and share of the particles.
const LAYERS: [(f32, f32); 3] = [(8.0, 0.45), (24.0, 0.35), (70.0, 0.2)];

pub struct PrecipPlugin;

impl Plugin for PrecipPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins((MaterialPlugin::<PrecipMaterial>::default(), FullscreenMaterialPlugin::<LensRain>::default()))
            .init_resource::<Air>()
            .add_systems(PostStartup, setup)
            .add_systems(Update, (track_camera, fall, wet_lens).chain());
    }
}

#[derive(Resource, Default)]
struct Air {
    /// The camera's last position and its smoothed velocity (m/s).
    last: Option<Vec3>,
    velocity: Vec3,
    /// Each layer's drift (m), wrapped to its box.
    drift: [Vec3; 3],
    /// How much falls around the camera (0..1): the precipitation, below the cloud base.
    amount: f32,
    /// The lens: its clock and how wet it is.
    clock: f32,
    wet: f32,
    material: Option<Handle<PrecipMaterial>>,
}

#[derive(Component)]
struct Particles;

#[derive(Clone, Copy, ShaderType, Default)]
struct PrecipUniform {
    drift: [Vec4; 3],
    motion: Vec4,
    color: Vec4,
    params: Vec4,
}

#[derive(Asset, TypePath, AsBindGroup, Clone)]
struct PrecipMaterial {
    #[uniform(0)]
    u: PrecipUniform,
}

impl Material for PrecipMaterial {
    fn vertex_shader() -> ShaderRef {
        "shaders/precipitation.wgsl".into()
    }
    fn fragment_shader() -> ShaderRef {
        "shaders/precipitation.wgsl".into()
    }
    fn alpha_mode(&self) -> AlphaMode {
        AlphaMode::Blend
    }
}

/// The lens pass's settings, on the camera while the lens is wet.
#[derive(Component, ExtractComponent, Clone, Copy, ShaderType, Default)]
struct LensRain {
    /// Lens clock (s), wetness, running drops 0..1, airflow 0..1.
    a: Vec4,
    /// Light 0..1, unused.
    b: Vec4,
}

impl FullscreenMaterial for LensRain {
    fn fragment_shader() -> ShaderRef {
        "shaders/lens_rain.wgsl".into()
    }
}

/// A small deterministic generator, so the particle field is the same every run.
fn rng(seed: &mut u32) -> f32 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 17;
    *seed ^= *seed << 5;
    (*seed >> 8) as f32 / (1u32 << 24) as f32
}

fn setup(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut materials: ResMut<Assets<PrecipMaterial>>, mut air: ResMut<Air>) {
    let n = PARTICLES as usize;
    let mut spot = Vec::with_capacity(n * 4);
    let mut rnd = Vec::with_capacity(n * 4);
    let mut corner = Vec::with_capacity(n * 4);
    let mut indices = Vec::with_capacity(n * 6);
    let mut seed = 0x9E37_79B9u32;
    let mut first = 0usize;
    for (layer, &(_, share)) in LAYERS.iter().enumerate() {
        let count = if layer == LAYERS.len() - 1 { n - first } else { (n as f32 * share) as usize };
        for _ in 0..count {
            let s = [rng(&mut seed), rng(&mut seed), rng(&mut seed)];
            let r = [rng(&mut seed), rng(&mut seed), rng(&mut seed)];
            let base = spot.len() as u32;
            for (x, y) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)] {
                spot.push(s);
                rnd.push(r);
                corner.push([x + 2.0 * layer as f32, y]);
            }
            indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }
        first += count;
    }
    let mesh = Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::RENDER_WORLD)
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, spot)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, rnd)
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, corner)
        .with_inserted_indices(Indices::U32(indices));
    let material = materials.add(PrecipMaterial { u: PrecipUniform::default() });
    // The vertex shader places the particles around the camera: the mesh's own bounds mean nothing.
    commands.spawn((
        Particles,
        crate::sandbox::NoHit,
        NoFrustumCulling,
        NotShadowCaster,
        Mesh3d(meshes.add(mesh)),
        MeshMaterial3d(material.clone()),
        Transform::IDENTITY,
        Visibility::Hidden,
    ));
    air.material = Some(material);
}

/// The camera's velocity, from its movement. A re-centred frame moves everything at once: that frame keeps the last
/// estimate.
fn track_camera(time: Res<Time>, frame: Res<Frame>, cam: Single<&Transform, With<Tiles3dCamera>>, mut air: ResMut<Air>) {
    let dt = time.delta_secs();
    let at = cam.translation;
    if let Some(last) = air.last.filter(|_| dt > 0.0 && !frame.is_changed()) {
        let v = (at - last) / dt;
        if v.length() < 1500.0 {
            air.velocity = air.velocity.lerp(v, (dt * 12.0).min(1.0));
        }
    }
    air.last = Some(at);
}

fn fall(
    time: Res<Time>,
    weather: Res<Weather>,
    sky: Res<Sky>,
    cam: Single<&Transform, With<Tiles3dCamera>>,
    mut air: ResMut<Air>,
    mut materials: ResMut<Assets<PrecipMaterial>>,
    mut particles: Query<&mut Visibility, With<Particles>>,
) {
    let dt = time.delta_secs();
    // Nothing falls above the cloud base.
    let below = 1.0 - smoothstep(weather.cloud_base - 150.0, weather.cloud_base + 50.0, cam.translation.y);
    air.amount = if weather.precipitation > 0.01 { weather.precipitation * below } else { 0.0 };
    let shown = air.amount > 0.005;
    for mut vis in &mut particles {
        vis.set_if_neq(if shown { Visibility::Inherited } else { Visibility::Hidden });
    }
    if !shown {
        return;
    }
    // Rain falls at ~7 m/s, snow at ~1; both drift with the wind.
    let falling = weather.wind() - Vec3::Y * if weather.snow { 1.1 } else { 7.5 };
    for (drift, &(size, _)) in air.drift.iter_mut().zip(&LAYERS) {
        *drift = (*drift + falling * dt).rem_euclid(Vec3::splat(size));
    }
    let Some(mut m) = air.material.as_ref().and_then(|h| materials.get_mut(h)) else { return };
    let light = 0.12 + 0.88 * sky.daylight.max(sky.flash);
    // Rain is seen as streaks over the eye's ~1/30 s; flakes as flakes, streaking only at speed.
    let (color, opacity, exposure) = if weather.snow {
        (Vec3::new(1.0, 1.0, 1.03) * 1.6 * light, 1.0, 1.0 / 600.0)
    } else {
        (Vec3::new(0.8, 0.85, 0.92) * 1.2 * light, 0.8, 1.0 / 30.0)
    };
    m.u = PrecipUniform {
        drift: std::array::from_fn(|i| air.drift[i].extend(LAYERS[i].0)),
        motion: (falling - air.velocity).extend(exposure),
        color: (color + Vec3::splat(sky.flash * 0.8)).extend(opacity),
        params: Vec4::new(air.amount, if weather.snow { 1.0 } else { 0.0 }, time.elapsed_secs(), 0.0),
    };
}

fn wet_lens(time: Res<Time>, weather: Res<Weather>, sky: Res<Sky>, mut air: ResMut<Air>, cam: Single<(Entity, Option<&mut LensRain>), With<Tiles3dCamera>>, mut commands: Commands) {
    let dt = time.delta_secs();
    let airflow = smoothstep(8.0, 70.0, (weather.wind() - air.velocity).length());
    // Rain wets the lens; snow only as the odd flake melts on it. It dries slowly, faster in a fast airflow.
    let want = if air.amount <= 0.005 || sky.hide_cloud_layer {
        0.0
    } else if weather.snow {
        0.3 * air.amount
    } else {
        0.35 + 0.65 * air.amount
    };
    let rate = if want > air.wet { 0.25 * (0.3 + air.amount) } else { 0.04 * (1.0 + 3.0 * airflow) };
    air.wet += (want - air.wet).clamp(-rate * dt, rate * dt);
    air.clock += dt * (1.0 + 3.0 * airflow);
    let running = if weather.snow { 0.0 } else { (0.4 + 0.6 * weather.precipitation) * (1.0 - 0.5 * airflow) };
    let settings = LensRain { a: Vec4::new(air.clock, air.wet, running, airflow), b: Vec4::new(sky.daylight.max(sky.flash), 0.0, 0.0, 0.0) };
    let (entity, lens) = cam.into_inner();
    match (air.wet > 0.002, lens) {
        (true, Some(mut lens)) => *lens = settings,
        (true, None) => {
            commands.entity(entity).insert(settings);
        }
        (false, Some(_)) => {
            commands.entity(entity).remove::<LensRain>();
        }
        (false, None) => {}
    }
}
