//! The vehicles' finish in sunlight, set once per material when a model is spawned:
//! - exterior paint gets the clear coat of an aircraft's polyurethane topcoat: a sharp reflection of the sky and a
//!   glint of the sun over a softer pigment layer;
//! - window glass is a dielectric (F0 4 %), black inside but mirroring the sky at a glancing angle.
//!
//! Interiors keep their materials: under the roof they are lit by the sun through the windows (shadowed by the frames
//! and the roof) and by the sky; cutting the sky's share as well left a midday cockpit too dark to read.
//!
//! And the photographed terrain stays out of the sun's shadow maps: its tiles are unlit and never show a shadow, so
//! drawing them into the maps only cost time.

use std::collections::HashSet;

use bevy::gltf::GltfMaterialName;
use bevy::light::NotShadowCaster;
use bevy::prelude::*;
use bevy_3d_tiles::TileGeometry;

use super::VehicleMesh;

pub(super) struct PaintPlugin;

impl Plugin for PaintPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, (finish_paint, tiles_cast_no_shadow));
    }
}

fn tiles_cast_no_shadow(mut commands: Commands, tiles: Query<Entity, (Added<TileGeometry>, Without<NotShadowCaster>)>) {
    for e in &tiles {
        commands.entity(e).try_insert(NotShadowCaster);
    }
}

/// A model's materials are shared by every copy of it: each is finished once.
fn finish_paint(
    meshes: Query<(&MeshMaterial3d<StandardMaterial>, &GltfMaterialName), Added<VehicleMesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut done: Local<HashSet<AssetId<StandardMaterial>>>,
) {
    for (handle, name) in &meshes {
        if done.contains(&handle.id()) {
            continue;
        }
        // Read first: a material left as it is isn't marked changed (and re-uploaded).
        let Some(m) = materials.get(handle) else { continue };
        done.insert(handle.id());
        if let Some(finished) = finish(&name.0, m) {
            if let Some(mut m) = materials.get_mut(handle) {
                *m = finished;
            }
        }
    }
}

/// Whether a material is a vehicle's exterior paint, by its name in the model.
fn is_paint(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    if name.contains("interior") || name.contains("matte") || name.contains("radome") {
        return false;
    }
    name.starts_with("paint") || name.starts_with("exterior-") && !name.contains("titanium") && !name.contains("hub") && !name.contains("spinner")
        || matches!(name.as_str(), "white" | "whiteds" | "navy" | "red" | "blue" | "yellow" | "livery")
}

/// The finished material, when it changes.
fn finish(name: &str, m: &StandardMaterial) -> Option<StandardMaterial> {
    if m.unlit || name.starts_with("display-") || name.starts_with("hud-") {
        return None;
    }
    if name.eq_ignore_ascii_case("glass") || name.eq_ignore_ascii_case("glassout") {
        return Some(StandardMaterial { metallic: 0.0, perceptual_roughness: m.perceptual_roughness.min(0.06), reflectance: 0.5, ..m.clone() });
    }
    // Gloss paint only: a matte or weathered finish (tape, radomes, anti-glare panels) keeps its own.
    let plain = m.alpha_mode == AlphaMode::Opaque && m.emissive == LinearRgba::BLACK && m.metallic < 0.3 && m.perceptual_roughness < 0.55 && m.metallic_roughness_texture.is_none();
    if !plain || !is_paint(name) {
        return None;
    }
    Some(StandardMaterial {
        // The pigment layer under the coat: a soft sheen that spreads the sun's highlight across a curved panel.
        perceptual_roughness: m.perceptual_roughness.clamp(0.38, 0.5),
        metallic: 0.0,
        // The coat: a dielectric film (F0 4 %) that mirrors the sky and puts a sharp glint where the sun catches it.
        clearcoat: 0.9,
        clearcoat_perceptual_roughness: 0.12,
        ..m.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paints_are_coated() {
        let white = StandardMaterial { base_color: Color::srgb(0.86, 0.88, 0.9), perceptual_roughness: 0.28, ..default() };
        for name in ["paint-white", "exterior-pearl-white", "white", "whiteDS", "paint-ua-blue"] {
            let f = finish(name, &white).unwrap();
            assert!(f.clearcoat > 0.5 && (0.38..=0.5).contains(&f.perceptual_roughness), "{name}");
        }
        for name in ["paint-matte", "paint-matte|interior", "trim|interior", "cabin-sandstone-vinyl|interior", "metal", "rubber", "exterior-fan-titanium", "paint-radome", "display-ga", "hud-combiner"] {
            assert!(finish(name, &white).is_none(), "{name}");
        }
        let lamp = StandardMaterial { emissive: LinearRgba::RED, ..white.clone() };
        assert!(finish("paint-white", &lamp).is_none());
        let tape = StandardMaterial { perceptual_roughness: 0.75, ..white.clone() };
        assert!(finish("paint-tape|weathered", &tape).is_none());
    }

    #[test]
    fn glass_is_dielectric() {
        let glass = finish("glass", &StandardMaterial { metallic: 0.25, perceptual_roughness: 0.12, ..default() }).unwrap();
        assert!(glass.metallic == 0.0 && glass.perceptual_roughness <= 0.06);
    }
}
