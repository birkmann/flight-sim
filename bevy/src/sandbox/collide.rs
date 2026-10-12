//! Collisions against the photorealistic mesh and the models in it, by ray casts, as the ground is found (there is
//! no physics world to put the streamed tiles into).
//! - The free camera sweeps each move and slides along what it meets, a little way off it, so it does not fly into
//!   buildings, models or the ground. If it ends up under the surface anyway (the tiles refine up around it, a flight
//!   or a scripted view puts it there), it is lifted back out on top.
//! - The chase camera keeps to this side of walls and other models between it and what it follows, while it eases
//!   as well as where it eases to.
//! - Vehicles take other vehicles' models as solid: their ground rays stand them on them, their wall rays stop at them.

use bevy::prelude::*;

use super::{NoHit, VehicleMesh};

/// How far the free camera keeps off surfaces (m): more than the near plane, so a wall never cuts into the view.
pub(super) const CLEARANCE: f32 = 1.5;
/// How far above the camera to look for the surface it is under (m): taller than the tallest buildings.
const BURIED_REACH: f32 = 2_000.0;
/// Slides along surfaces per move: into a corner takes two, the third is for luck.
const SLIDES: usize = 3;

/// What rays from `own` (a vehicle, or nothing for the free camera) may hit: the tiles, and every model but its own.
pub(super) fn solid_for<'a>(own: Option<Entity>, meshes: &'a Query<&VehicleMesh>, no_hit: &'a Query<(), With<NoHit>>) -> impl Fn(Entity) -> bool + 'a {
    move |e| !no_hit.contains(e) && meshes.get(e).map_or(true, |m| Some(m.0) != own)
}

/// Whether a ray hit a vehicle's model rather than the world.
pub(super) fn is_model(meshes: &Query<&VehicleMesh>, e: Entity) -> bool {
    meshes.contains(e)
}

/// Moves the free camera from `from` by `motion`: it stops short of whatever is in the way and slides along it, keeps
/// off the ground, and comes up out of the surface if it finds itself under it. Returns where it ends up.
pub(super) fn move_free_camera(ray_cast: &mut MeshRayCast, meshes: &Query<&VehicleMesh>, no_hit: &Query<(), With<NoHit>>, from: Vec3, motion: Vec3) -> Vec3 {
    let solid = solid_for(None, meshes, no_hit);
    let settings = MeshRayCastSettings::default().with_filter(&solid).with_visibility(RayCastVisibility::Visible).always_early_exit();
    let mut at = from;
    let mut left = motion;
    for _ in 0..SLIDES {
        let len = left.length();
        let Ok(dir) = Dir3::new(left) else { break };
        // Where along the move the camera stops: its clearance off the surface, measured square to it (further along
        // a glancing ray, up to a limit, so skimming along a wall does not stop dead).
        let stop = ray_cast.cast_ray(Ray3d::new(at, dir), &settings).first().and_then(|(_, h)| {
            let normal = h.normal.normalize_or_zero();
            let facing = -dir.dot(normal);
            Some((h.distance - CLEARANCE / facing.max(0.25), normal)).filter(|(stop, _)| *stop < len)
        });
        let Some((stop, normal)) = stop else {
            at += left;
            break;
        };
        let go = stop.max(0.0);
        at += *dir * go;
        // The rest of the move, less the part into the surface.
        left = *dir * (len - go);
        left -= normal * left.dot(normal).min(0.0);
    }
    unbury(ray_cast, meshes, no_hit, &settings, at)
}

/// Keeps a point `CLEARANCE` off the ground (or roof, or model) below it; lifts it on top of the surface when there is
/// none below but some above: then it is under the ground, or inside a building (the mesh is one skin, seen from
/// outside, so from inside a ray down finds nothing). Under a bridge there is the road or the river below.
fn unbury(ray_cast: &mut MeshRayCast, meshes: &Query<&VehicleMesh>, no_hit: &Query<(), With<NoHit>>, settings: &MeshRayCastSettings, at: Vec3) -> Vec3 {
    if let Some((_, h)) = ray_cast.cast_ray(Ray3d::new(at, Dir3::NEG_Y), settings).first() {
        return if h.distance < CLEARANCE { at + Vec3::Y * (CLEARANCE - h.distance) } else { at };
    }
    // Only the world buries: a model overhead (an aircraft passing over) is not something to be put on top of.
    let world = |e: Entity| !no_hit.contains(e) && !meshes.contains(e);
    let world = MeshRayCastSettings::default().with_filter(&world).with_visibility(RayCastVisibility::Visible).always_early_exit();
    match ray_cast.cast_ray(Ray3d::new(at + Vec3::Y * BURIED_REACH, Dir3::NEG_Y), &world).first() {
        Some((_, h)) if h.point.y > at.y => h.point + Vec3::Y * CLEARANCE,
        _ => at,
    }
}

/// Pulls a camera looking at `pivot` in to just short of anything between them (the world, and models but `own`).
pub(super) fn clear_line(ray_cast: &mut MeshRayCast, meshes: &Query<&VehicleMesh>, no_hit: &Query<(), With<NoHit>>, own: Entity, pivot: Vec3, eye: Vec3) -> Vec3 {
    let back = eye - pivot;
    let Ok(dir) = Dir3::new(back) else { return eye };
    let solid = solid_for(Some(own), meshes, no_hit);
    let settings = MeshRayCastSettings::default().with_filter(&solid).with_visibility(RayCastVisibility::Visible).always_early_exit();
    match ray_cast.cast_ray(Ray3d::new(pivot, dir), &settings).first() {
        Some((_, h)) if h.distance < back.length() => pivot + *dir * (h.distance - 1.0).max(1.0),
        _ => eye,
    }
}

#[cfg(test)]
mod tests {
    use bevy::camera::primitives::MeshAabb;
    use bevy::ecs::system::RunSystemOnce;

    use super::*;

    /// A world of meshes the rays can see, as the tiles and the models are.
    fn world(meshes: Vec<(Mesh, Vec3, Option<Entity>)>) -> App {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, AssetPlugin::default())).init_asset::<Mesh>();
        for (mesh, at, vehicle) in meshes {
            let aabb = mesh.compute_aabb().unwrap();
            let handle = app.world_mut().resource_mut::<Assets<Mesh>>().add(mesh);
            let tf = Transform::from_translation(at);
            let mut e = app.world_mut().spawn((Mesh3d(handle), tf, GlobalTransform::from(tf), aabb, InheritedVisibility::VISIBLE, ViewVisibility::default()));
            if let Some(v) = vehicle {
                e.insert(VehicleMesh(v));
            }
        }
        app
    }

    fn ground() -> (Mesh, Vec3, Option<Entity>) {
        (Plane3d::default().mesh().size(1_000.0, 1_000.0).build(), Vec3::ZERO, None)
    }

    /// A 10 m cube standing on the ground at x = 15..25.
    fn building() -> (Mesh, Vec3, Option<Entity>) {
        (Cuboid::new(10.0, 10.0, 10.0).into(), Vec3::new(20.0, 5.0, 0.0), None)
    }

    fn fly(app: &mut App, from: Vec3, motion: Vec3) -> Vec3 {
        app.world_mut()
            .run_system_once(move |mut ray_cast: MeshRayCast, meshes: Query<&VehicleMesh>, no_hit: Query<(), With<NoHit>>| move_free_camera(&mut ray_cast, &meshes, &no_hit, from, motion))
            .unwrap()
    }

    fn near(a: Vec3, b: Vec3) -> bool {
        a.distance(b) < 0.01
    }

    #[test]
    fn stops_above_the_ground() {
        let mut app = world(vec![ground()]);
        let at = fly(&mut app, Vec3::new(0.0, 10.0, 0.0), Vec3::new(0.0, -50.0, 0.0));
        assert!(near(at, Vec3::new(0.0, CLEARANCE, 0.0)), "{at}");
    }

    #[test]
    fn slides_along_the_ground() {
        let mut app = world(vec![ground()]);
        let at = fly(&mut app, Vec3::new(0.0, 10.0, 0.0), Vec3::new(100.0, -20.0, 0.0));
        assert!(near(at, Vec3::new(100.0, CLEARANCE, 0.0)), "{at}");
    }

    #[test]
    fn stops_at_a_wall_and_slides_along_it() {
        let mut app = world(vec![ground(), building()]);
        let at = fly(&mut app, Vec3::new(0.0, 3.0, 0.0), Vec3::new(50.0, 0.0, 0.0));
        assert!(near(at, Vec3::new(15.0 - CLEARANCE, 3.0, 0.0)), "{at}");
        let at = fly(&mut app, Vec3::new(0.0, 3.0, 0.0), Vec3::new(50.0, 0.0, 10.0));
        assert!((at.x - (15.0 - CLEARANCE)).abs() < 0.01 && (at.z - 10.0).abs() < 0.01, "{at}");
    }

    #[test]
    fn free_to_move_away_from_a_surface_it_is_close_to() {
        let mut app = world(vec![ground(), building()]);
        let at = fly(&mut app, Vec3::new(14.0, 3.0, 0.0), Vec3::new(-10.0, 0.0, 0.0));
        assert!(near(at, Vec3::new(4.0, 3.0, 0.0)), "{at}");
    }

    #[test]
    fn lifted_out_from_under_the_ground() {
        let mut app = world(vec![ground()]);
        let at = fly(&mut app, Vec3::new(0.0, -5.0, 0.0), Vec3::ZERO);
        assert!(near(at, Vec3::new(0.0, CLEARANCE, 0.0)), "{at}");
    }

    #[test]
    fn lifted_out_of_a_building_onto_its_roof() {
        // The photorealistic mesh has no ground inside a building: only its skin.
        let mut app = world(vec![building()]);
        let at = fly(&mut app, Vec3::new(20.0, 3.0, 0.0), Vec3::ZERO);
        assert!(near(at, Vec3::new(20.0, 10.0 + CLEARANCE, 0.0)), "{at}");
    }

    #[test]
    fn left_alone_under_a_bridge() {
        let deck = (Cuboid::new(10.0, 1.0, 40.0).into(), Vec3::new(0.0, 10.0, 0.0), None);
        let mut app = world(vec![ground(), deck]);
        let at = fly(&mut app, Vec3::new(0.0, 5.0, 0.0), Vec3::new(0.0, 0.0, 3.0));
        assert!(near(at, Vec3::new(0.0, 5.0, 3.0)), "{at}");
    }

    #[test]
    fn models_are_solid_but_not_ones_own() {
        let mut app = App::new();
        let own = app.world_mut().spawn_empty().id();
        let other = app.world_mut().spawn_empty().id();
        let tank = |v| (Mesh::from(Cuboid::new(10.0, 10.0, 10.0)), Vec3::new(20.0, 5.0, 0.0), Some(v));
        // The free camera stops at any model.
        let mut app = world(vec![ground(), tank(other)]);
        let at = fly(&mut app, Vec3::new(0.0, 3.0, 0.0), Vec3::new(50.0, 0.0, 0.0));
        assert!(near(at, Vec3::new(15.0 - CLEARANCE, 3.0, 0.0)), "{at}");
        // The chase camera is pulled in in front of another vehicle's model, not its own.
        let chase = |app: &mut App, own: Entity| {
            app.world_mut()
                .run_system_once(move |mut ray_cast: MeshRayCast, meshes: Query<&VehicleMesh>, no_hit: Query<(), With<NoHit>>| {
                    clear_line(&mut ray_cast, &meshes, &no_hit, own, Vec3::new(0.0, 3.0, 0.0), Vec3::new(40.0, 3.0, 0.0))
                })
                .unwrap()
        };
        assert!(near(chase(&mut app, own), Vec3::new(14.0, 3.0, 0.0)));
        assert!(near(chase(&mut app, other), Vec3::new(40.0, 3.0, 0.0)));
    }
}
