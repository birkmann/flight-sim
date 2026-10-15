//! Crew stations: the flight deck, cab, bridge or hatch a vehicle's cockpit view looks out of (`crew-station` in its
//! model, from `CockpitDefinition` in packages/globe). From inside, the station is shown and the exterior parts that
//! would close in the eye are hidden; the camera sits on the `crew-eye` node; the screens (`display-*`) show pictures
//! the page draws (`window.__display`, displays.js), a few times a second; the head-up display's glass
//! (`hud-combiner`) goes to the HUD as its outline on screen, for the symbology to be drawn inside.

use std::collections::{HashMap, HashSet};

use bevy::asset::RenderAssetUsages;
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};

use super::{Part, Pilot, Role, Vehicle, View};

/// What a screen shows (`CockpitDisplay` in the model).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum Display {
    Pfd,
    Nd,
    Ewd,
    Sd,
    Ga,
    Glider,
    Radio,
    Engine,
    MfdNav,
    MfdStatus,
}

impl Display {
    pub(super) fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "pfd" => Display::Pfd,
            "nd" => Display::Nd,
            "ewd" => Display::Ewd,
            "sd" => Display::Sd,
            "ga" => Display::Ga,
            "glider" => Display::Glider,
            "radio" => Display::Radio,
            "engine" => Display::Engine,
            "mfd-nav" => Display::MfdNav,
            "mfd-status" => Display::MfdStatus,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Display::Pfd => "pfd",
            Display::Nd => "nd",
            Display::Ewd => "ewd",
            Display::Sd => "sd",
            Display::Ga => "ga",
            Display::Glider => "glider",
            Display::Radio => "radio",
            Display::Engine => "engine",
            Display::MfdNav => "mfd-nav",
            Display::MfdStatus => "mfd-status",
        }
    }

    /// The picture (px): as wide over its height as the screen built for it (`COCKPIT_DISPLAY_ASPECT`).
    fn size(self) -> UVec2 {
        match self {
            Display::Ga => UVec2::new(1280, 512),
            Display::Glider => UVec2::new(1024, 576),
            Display::Radio => UVec2::new(512, 1024),
            Display::Engine => UVec2::new(1024, 366),
            _ => UVec2::splat(512),
        }
    }
}

/// The head-up display's glass: its corners in the node's frame.
#[derive(Component)]
pub(super) struct Combiner(pub(super) [Vec3; 4]);

/// One picture per kind of screen, shared by every screen showing it.
#[derive(Resource, Default)]
pub(super) struct Screens {
    pictures: HashMap<Display, (Handle<Image>, Handle<StandardMaterial>)>,
    since: f32,
}

/// How often the screens are redrawn (Hz): the page draws them on the CPU and the pictures go up whole.
const REDRAW_HZ: f32 = 20.0;

/// Whether the vehicle has a crew station to look out of.
pub(super) fn has_station(parts: &Query<(&Part, &GlobalTransform)>, vehicle: Entity) -> bool {
    parts.iter().any(|(p, _)| p.vehicle == vehicle && p.role == Role::Station)
}

/// Where a point of a vehicle's model (world, as last drawn) is now: its nodes' transforms are a frame behind the
/// vehicle's, which a fast aircraft outruns by metres.
fn carried(vehicle_was: &GlobalTransform, vehicle: &Transform, p: Vec3) -> Vec3 {
    vehicle.transform_point(vehicle_was.affine().inverse().transform_point3(p))
}

/// The crew's eyes, where the vehicle is now, and the view's pitch at rest (rad).
pub(super) fn eye(parts: &Query<(&Part, &GlobalTransform)>, vehicle: Entity, was: &GlobalTransform, now: &Transform) -> Option<(Vec3, f32)> {
    parts.iter().find_map(|(p, g)| match p.role {
        Role::Eye(pitch) if p.vehicle == vehicle => Some((carried(was, now, g.translation()), pitch)),
        _ => None,
    })
}

/// The head-up display's outline in the view (normalised device coordinates), when all of it is ahead.
pub(super) fn combiner_outline(combiners: &Query<(&Part, &GlobalTransform, &Combiner)>, vehicle: Entity, was: &GlobalTransform, now: &Transform, cam: &Transform, fov: f32, aspect: f32) -> Option<Vec<[f32; 2]>> {
    let (_, g, c) = combiners.iter().find(|(p, _, _)| p.vehicle == vehicle)?;
    c.0.iter().map(|p| project_near(cam, fov, aspect, carried(was, now, g.transform_point(*p)))).collect()
}

/// `project`, for points within arm's reach (it drops anything nearer than half a metre).
fn project_near(cam: &Transform, fov: f32, aspect: f32, p: Vec3) -> Option<[f32; 2]> {
    let d = cam.rotation.inverse() * (p - cam.translation);
    if d.z > -0.01 {
        return None;
    }
    let t = (fov / 2.0).tan();
    Some([d.x / -d.z / (t * aspect), d.y / -d.z / t])
}

/// Inside, the station and not the shell around it; otherwise the other way round. Without a station (and through a
/// sight or a drone's camera) the whole vehicle is hidden: the HUD is the view.
pub(super) fn show_station(pilot: Res<Pilot>, mut vehicles: Query<(Entity, &mut Visibility), With<Vehicle>>, mut parts: Query<(&Part, &mut Visibility), Without<Vehicle>>) {
    let piloted = pilot.vehicle.filter(|_| pilot.view != View::Chase);
    let station = piloted.filter(|e| pilot.view == View::Cockpit && parts.iter().any(|(p, _)| p.vehicle == *e && p.role == Role::Station));
    for (e, mut vis) in &mut vehicles {
        let hidden = piloted == Some(e) && station != Some(e);
        vis.set_if_neq(if hidden { Visibility::Hidden } else { Visibility::Inherited });
    }
    for (p, mut vis) in &mut parts {
        let inside = station == Some(p.vehicle);
        let shown = match p.role {
            Role::Station => inside,
            Role::Exterior => !inside,
            _ => continue,
        };
        vis.set_if_neq(if shown { Visibility::Inherited } else { Visibility::Hidden });
    }
}

/// A new screen shows its kind's picture: made on first use, black until drawn.
pub(super) fn wire_screens(
    mut screens: ResMut<Screens>,
    mut images: ResMut<Assets<Image>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    added: Query<(Entity, &Part), Added<Part>>,
    children: Query<&Children>,
    mut surfaces: Query<&mut MeshMaterial3d<StandardMaterial>>,
) {
    for (e, part) in &added {
        let Role::Display(d) = part.role else { continue };
        let (_, material) = screens.pictures.entry(d).or_insert_with(|| {
            let size = d.size();
            let extent = Extent3d { width: size.x, height: size.y, depth_or_array_layers: 1 };
            // Kept on the CPU side as well: it is rewritten in place.
            let image = images.add(Image::new_fill(extent, TextureDimension::D2, &[4, 7, 10, 255], TextureFormat::Rgba8UnormSrgb, RenderAssetUsages::default()));
            // Analogue faceplates receive cabin light, plus a faint post-light of their own (alpha 0: in display
            // units, past the camera's exposure, so it reads the same under the midday sun and at night); electronic
            // displays emit it.
            let analogue = matches!(d, Display::Ga | Display::Engine);
            let material = materials.add(StandardMaterial {
                base_color_texture: Some(image.clone()),
                unlit: !analogue,
                perceptual_roughness: 0.78,
                emissive_texture: analogue.then(|| image.clone()),
                emissive: if analogue { LinearRgba::new(0.05, 0.047, 0.04, 0.0) } else { LinearRgba::BLACK },
                ..default()
            });
            (image, material)
        });
        let material = material.clone();
        // The node's primitives (or the node itself).
        for s in std::iter::once(e).chain(children.iter_descendants(e)) {
            if let Ok(mut m) = surfaces.get_mut(s) {
                m.0 = material.clone();
            }
        }
    }
}

/// The page redraws the pictures on the screens in view.
pub(super) fn draw_screens(time: Res<Time>, pilot: Res<Pilot>, mut screens: ResMut<Screens>, mut images: ResMut<Assets<Image>>, parts: Query<&Part>) {
    screens.since += time.delta_secs();
    if screens.since < 1.0 / REDRAW_HZ {
        return;
    }
    screens.since = 0.0;
    let Some(e) = pilot.vehicle.filter(|_| pilot.view == View::Cockpit) else { return };
    let shown: HashSet<Display> = parts.iter().filter(|p| p.vehicle == e).filter_map(|p| if let Role::Display(d) = p.role { Some(d) } else { None }).collect();
    for d in shown {
        let Some((handle, _)) = screens.pictures.get(&d) else { continue };
        // The page is asked first: a picture it hasn't redrawn (the same array as last time) is left alone, as taking
        // the image to write marks it changed, and it then goes up to the GPU whole again.
        let Some(picture) = page::picture(d.name()) else { continue };
        let Some(mut image) = images.get_mut(handle) else { continue };
        if let Some(data) = image.data.as_mut() {
            picture.copy_to(data);
        }
    }
}

/// The page's pictures for the screens (`window.__display(name)`, displays.js).
#[cfg(target_arch = "wasm32")]
mod page {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use wasm_bindgen::{JsCast, JsValue};

    thread_local! {
        /// The array each screen was last given: the page hands back the same one while its picture is unchanged.
        static LAST: RefCell<HashMap<&'static str, JsValue>> = RefCell::new(HashMap::new());
    }

    pub(super) struct Picture(js_sys::Uint8ClampedArray);

    impl Picture {
        pub(super) fn copy_to(&self, out: &mut [u8]) {
            if self.0.length() as usize == out.len() {
                self.0.copy_to(out);
            }
        }
    }

    /// A screen's picture, when the page has drawn a new one since it was last asked.
    pub(super) fn picture(name: &'static str) -> Option<Picture> {
        let win = web_sys::window()?;
        let f = js_sys::Reflect::get(&win, &JsValue::from_str("__display")).ok()?.dyn_into::<js_sys::Function>().ok()?;
        let pixels = f.call1(&JsValue::NULL, &JsValue::from_str(name)).ok()?;
        let same = LAST.with_borrow(|last| last.get(name).is_some_and(|was| js_sys::Object::is(was, &pixels)));
        if same {
            return None;
        }
        let array = pixels.clone().dyn_into::<js_sys::Uint8ClampedArray>().ok()?;
        LAST.with_borrow_mut(|last| last.insert(name, pixels));
        Some(Picture(array))
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod page {
    pub(super) struct Picture;

    impl Picture {
        pub(super) fn copy_to(&self, _out: &mut [u8]) {}
    }

    pub(super) fn picture(_name: &'static str) -> Option<Picture> {
        None
    }
}

/// The light a cabin's glareshield, floor and sills throw back into it from the sun and the sky. The renderer has no
/// bounced light, so under the roof only the sky's direct share lit the panel, and a midday cockpit read as dusk: a
/// soft, shadowless point above and behind the crew's eyes stands in for it, as strong as the daylight. None at night,
/// when the instruments' own lighting takes over.
#[derive(Component)]
pub(super) struct CabinFill;

/// The fill's output in full daylight (lm), set by eye: the panel and the cabin read as they do to eyes adapted to the
/// cabin, while the view outside keeps the exposure for the sunlit world.
const CABIN_FILL_LM: f32 = 4_000_000.0;

pub(super) fn cabin_fill(
    mut commands: Commands,
    pilot: Res<Pilot>,
    sky: Res<crate::weather::Sky>,
    parts: Query<(&Part, &GlobalTransform)>,
    vehicles: Query<(&GlobalTransform, &Transform), With<Vehicle>>,
    mut fill: Query<(&mut PointLight, &mut Transform, &mut Visibility), (With<CabinFill>, Without<Vehicle>)>,
) {
    let Ok((mut light, mut tf, mut vis)) = fill.single_mut() else {
        commands.spawn((
            CabinFill,
            PointLight { intensity: 0.0, range: 4.0, radius: 0.4, shadow_maps_enabled: false, color: Color::srgb(1.0, 0.96, 0.9), ..default() },
            Transform::default(),
            Visibility::Hidden,
        ));
        return;
    };
    let at = pilot
        .vehicle
        .filter(|_| pilot.view == View::Cockpit && sky.daylight > 0.01)
        .and_then(|e| {
            let (was, now) = vehicles.get(e).ok()?;
            has_station(&parts, e).then_some(())?;
            let (eye, _) = eye(&parts, e, was, now)?;
            Some(eye + now.rotation * Vec3::new(0.0, 0.25, 0.3))
        });
    match at {
        Some(p) => {
            tf.translation = p;
            light.intensity = CABIN_FILL_LM * sky.daylight;
            vis.set_if_neq(Visibility::Inherited);
        }
        None => {
            vis.set_if_neq(Visibility::Hidden);
        }
    }
}
