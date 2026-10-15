//! The piloted vehicle's shadow on the ground. The terrain is unlit photographs that receive no shadow (and cast none:
//! `paint.rs`), so a vehicle on the runway would float over it. A patch of ground under the vehicle, where its shadow
//! falls, reads the sun's shadow map and darkens the photograph by the sun's share of the light there
//! (`assets/shaders/ground_shadow.wgsl`): one small blended draw, only near the ground.

use bevy::light::{NotShadowCaster, NotShadowReceiver};
use bevy::prelude::*;
use bevy::render::render_resource::AsBindGroup;
use bevy::shader::ShaderRef;
use bevy::transform::TransformSystems;

use super::{NoHit, Pilot, Vehicle};

pub(super) struct ShadowPlugin;

impl Plugin for ShadowPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(MaterialPlugin::<GroundShadowMaterial>::default())
            .add_systems(Startup, setup)
            .add_systems(PostUpdate, place.before(TransformSystems::Propagate));
    }
}

#[derive(Asset, TypePath, AsBindGroup, Clone)]
struct GroundShadowMaterial {
    /// The shadow's darkness (0..1), unused ×3.
    #[uniform(0)]
    params: Vec4,
}

impl Material for GroundShadowMaterial {
    fn fragment_shader() -> ShaderRef {
        "shaders/ground_shadow.wgsl".into()
    }
    fn alpha_mode(&self) -> AlphaMode {
        AlphaMode::Blend
    }
    /// The patch lies on the ground the tiles' mesh only approximates: pulled forward (about 0.6 % of the distance to
    /// it) to stay in front of the runway's surface.
    fn depth_bias(&self) -> f32 {
        5.0e4
    }
    fn enable_prepass() -> bool {
        false
    }
    fn enable_shadows() -> bool {
        false
    }
}

#[derive(Component)]
struct GroundShadow;

/// Heights above the ground (m) over which the shadow fades out: it has gone soft and spread out by then.
const FADE: (f32, f32) = (60.0, 150.0);

/// The patch is lifted this far (m) off the ground found under the vehicle.
const LIFT: f32 = 0.04;

fn setup(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut materials: ResMut<Assets<GroundShadowMaterial>>) {
    commands.spawn((
        GroundShadow,
        NoHit,
        NotShadowCaster,
        NotShadowReceiver,
        Mesh3d(meshes.add(Plane3d::new(Vec3::Y, Vec2::splat(0.5)))),
        MeshMaterial3d(materials.add(GroundShadowMaterial { params: Vec4::ZERO })),
        Transform::default(),
        Visibility::Hidden,
    ));
}

/// The sun's share of the light on open ground (0..1): the direct sun on a level surface over that plus the sky's.
fn darkness(illuminance: f32, sin_elevation: f32) -> f32 {
    let sun = illuminance * sin_elevation.max(0.0);
    // The clear sky's light on level ground (lux), from about 12 klx with the sun high to nothing at dusk.
    let sky = 12_000.0 * smoothstep(-0.1, 0.3, sin_elevation);
    0.85 * sun / (sun + sky).max(1.0)
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn place(
    pilot: Res<Pilot>,
    vehicles: Query<(&Transform, &Vehicle), Without<GroundShadow>>,
    sun: Query<(&DirectionalLight, &Transform), Without<GroundShadow>>,
    mut patch: Single<(&mut Transform, &mut Visibility, &MeshMaterial3d<GroundShadowMaterial>), With<GroundShadow>>,
    mut materials: ResMut<Assets<GroundShadowMaterial>>,
) {
    let (tf, vis, material) = &mut *patch;
    let shown = (|| {
        let (v_tf, v) = vehicles.get(pilot.vehicle?).ok()?;
        let (light, sun_tf) = sun.iter().find(|(l, _)| l.shadow_maps_enabled)?;
        let to_sun = -sun_tf.forward();
        // Too low a sun throws a shadow too long and thin for the shadow map's texels.
        if !v.ground_found || to_sun.y < 0.12 || v.water.is_some() {
            return None;
        }
        let height = v_tf.translation.y - v.ground;
        if !(-2.0..FADE.1).contains(&height) {
            return None;
        }
        let (min, max) = v.bounds();
        let size = max - min;
        // Where the vehicle's middle throws its shadow, and how far the shadow reaches from there: the vehicle's
        // footprint, stretched along the sun's bearing by its height over the tangent of the sun's elevation.
        let middle = v_tf.transform_point((min + max) / 2.0);
        let ground = v.ground + LIFT;
        let at = middle + to_sun * ((ground - middle.y) / to_sun.y);
        let flat = Vec2::new(to_sun.x, to_sun.z).length().max(1e-3);
        let reach = 0.5 * Vec2::new(size.x, size.z).length() + 0.5 * size.y * flat / to_sun.y + 1.0;
        **tf = Transform::from_translation(at).with_scale(Vec3::new(2.0 * reach, 1.0, 2.0 * reach));
        Some(darkness(light.illuminance, to_sun.y) * (1.0 - smoothstep(FADE.0, FADE.1, height)))
    })();
    let strength = shown.unwrap_or(0.0);
    vis.set_if_neq(if strength > 0.01 { Visibility::Inherited } else { Visibility::Hidden });
    if strength > 0.01 {
        if let Some(m) = materials.get(&material.0) {
            if (m.params.x - strength).abs() > 0.005 {
                if let Some(mut m) = materials.get_mut(&material.0) {
                    m.params.x = strength;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn darkness_follows_the_sun() {
        let high = darkness(130_000.0, 0.85);
        let low = darkness(70_000.0, 0.17);
        let overcast = darkness(130_000.0 * 0.06, 0.85);
        assert!(high > 0.7 && high < 0.85, "{high}");
        assert!(low > 0.4 && low < high, "{low}");
        assert!(overcast < 0.35, "{overcast}");
        assert_eq!(darkness(0.3, -0.2), 0.0);
    }
}
