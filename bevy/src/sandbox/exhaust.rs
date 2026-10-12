//! Jet exhaust: the plume and afterburner flame behind each nozzle, a glowing volume the shader
//! (`assets/shaders/jet_flame.wgsl`) marches through.
//!
//! - The model's plume nodes (`jet-plume-N`) give the nozzle exit (local +X downstream) and its size; their own meshes
//!   (and the afterburner nodes') stay hidden. Beside each one sits a hull: a cylinder the gas stays within.
//! - The engine spools: the plume follows the throttle over a second or so, the afterburner lights in a fraction of one.
//! - Dry, the gas is nearly clear (a faint glow near the exit, the hot tailpipe seen through it). In afterburner the
//!   flame is blue-violet at the lip, then yellow-orange with shock diamonds, going ragged and red as it mixes out.

use bevy::camera::primitives::Aabb;
use bevy::light::{NotShadowCaster, NotShadowReceiver};
use bevy::mesh::MeshVertexBufferLayoutRef;
use bevy::pbr::{MaterialPipeline, MaterialPipelineKey};
use bevy::prelude::*;
use bevy::render::render_resource::{AsBindGroup, RenderPipelineDescriptor, ShaderType, SpecializedMeshPipelineError};
use bevy::shader::ShaderRef;

use super::{NoHit, Part, Role, Vehicle};

/// The hull, in nozzle radii: how far downstream and how far out the gas reaches.
const LENGTH: f32 = 11.0;
const WIDTH: f32 = 1.5;
/// The glow across the exit in the model's plume node, as a share of the nozzle radius (`jetExhaust` in exportGlb.ts).
const GLOW_RADIUS: f32 = 0.96;

pub struct ExhaustPlugin;

impl Plugin for ExhaustPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(MaterialPlugin::<FlameMaterial>::default()).add_systems(Update, (fit, burn).chain());
    }
}

/// A nozzle's flame: the vehicle whose engine lights it, and how far it has spooled up.
#[derive(Component)]
struct Flame {
    vehicle: Entity,
    material: Handle<FlameMaterial>,
    power: f32,
    afterburner: f32,
}

/// On a plume node once its flame is fitted.
#[derive(Component)]
struct Fitted;

#[derive(Clone, Copy, ShaderType, Default)]
struct FlameUniform {
    /// Nozzle radius (m), the hull's length and radius (nozzle radii), a random phase.
    shape: Vec4,
    /// Engine power over the dry range, afterburner (both 0..1), unused, unused.
    power: Vec4,
}

#[derive(Asset, TypePath, AsBindGroup, Clone)]
struct FlameMaterial {
    #[uniform(0)]
    u: FlameUniform,
}

impl Material for FlameMaterial {
    fn vertex_shader() -> ShaderRef {
        "shaders/jet_flame.wgsl".into()
    }
    fn fragment_shader() -> ShaderRef {
        "shaders/jet_flame.wgsl".into()
    }
    /// Light added over what is behind, which the flame's own gas dims a little.
    fn alpha_mode(&self) -> AlphaMode {
        AlphaMode::Premultiplied
    }
    /// Both faces: the far one draws the flame when the camera is inside the hull.
    fn specialize(_: &MaterialPipeline, descriptor: &mut RenderPipelineDescriptor, _: &MeshVertexBufferLayoutRef, _: MaterialPipelineKey<Self>) -> Result<(), SpecializedMeshPipelineError> {
        descriptor.primitive.cull_mode = None;
        Ok(())
    }
}

/// A flame beside each plume node, once the node's meshes have bounds to size it by.
fn fit(
    mut commands: Commands,
    nodes: Query<(Entity, &Part, &ChildOf), Without<Fitted>>,
    children: Query<&Children>,
    bounds: Query<&Aabb>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<FlameMaterial>>,
) {
    for (e, part, parent) in &nodes {
        if part.role != Role::Plume {
            continue;
        }
        // How far across the exit the node's meshes reach (in the node's frame, +X downstream).
        let reach = children.iter_descendants(e).filter_map(|c| bounds.get(c).ok()).map(|b| {
            let out = Vec3::from(b.center).abs() + Vec3::from(b.half_extents);
            out.y.max(out.z)
        });
        let r = reach.fold(0.0, f32::max) / GLOW_RADIUS;
        if r <= 0.0 {
            continue;
        }
        let phase = (e.to_bits() % 997) as f32 * 0.37;
        let material = materials.add(FlameMaterial { u: FlameUniform { shape: Vec4::new(r, LENGTH, WIDTH, phase), power: Vec4::ZERO } });
        // The hull along +X from the exit.
        let hull = Cylinder::new(WIDTH * r, LENGTH * r).mesh().resolution(24).build().rotated_by(Quat::from_rotation_z(-std::f32::consts::FRAC_PI_2)).translated_by(Vec3::X * LENGTH * r / 2.0);
        let flame = commands
            .spawn((
                Flame { vehicle: part.vehicle, material: material.clone(), power: 0.0, afterburner: 0.0 },
                NoHit,
                NotShadowCaster,
                NotShadowReceiver,
                Mesh3d(meshes.add(hull)),
                MeshMaterial3d(material),
                // The node's own scale is its hidden one.
                Transform { scale: Vec3::ONE, ..part.rest },
                Visibility::Hidden,
            ))
            .id();
        commands.entity(parent.parent()).add_child(flame);
        commands.entity(e).insert(Fitted);
    }
}

/// Each flame from its engine: the levers' dry range sets the power, the afterburner lights from 0.9.
fn burn(time: Res<Time>, vehicles: Query<&Vehicle>, mut flames: Query<(&mut Flame, &mut Visibility)>, mut materials: ResMut<Assets<FlameMaterial>>) {
    let dt = time.delta_secs();
    for (mut f, mut vis) in &mut flames {
        let Ok(v) = vehicles.get(f.vehicle) else { continue };
        // Any aircraft with a plume node is jet-powered: the fighters, and the CA-1 (an uncrewed jet, without reheat).
        let running = v.asset.airframe.is_some() && v.destroyed.is_none();
        let reheat = v.asset.airframe.is_some_and(|a| a.thrust_ab > 0.0);
        let dry = if !running { 0.0 } else if reheat { (v.throttle / 0.9).min(1.0) } else { v.throttle };
        // The afterburner lights at its minimum stage, then burns harder up to the stop.
        let ab = if running && reheat && v.throttle > 0.905 { 0.35 + 0.65 * ((v.throttle - 0.9) / 0.1).min(1.0) } else { 0.0 };
        let follow = |from: f32, to: f32, tau: f32| from + (to - from) * (1.0 - (-dt / tau).exp());
        f.power = follow(f.power, dry, 1.2);
        f.afterburner = follow(f.afterburner, ab, if ab > f.afterburner { 0.25 } else { 0.12 });
        let lit = f.power > 0.02 || f.afterburner > 0.01;
        vis.set_if_neq(if lit { Visibility::Inherited } else { Visibility::Hidden });
        let power = Vec4::new(f.power, f.afterburner, 0.0, 0.0);
        if lit && materials.get(&f.material).is_some_and(|m| m.u.power.distance_squared(power) > 1e-6) {
            if let Some(mut m) = materials.get_mut(&f.material) {
                m.u.power = power;
            }
        }
    }
}
