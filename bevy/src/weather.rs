//! Sky and weather for the sandbox: Bevy's physically based atmosphere lit by the sun at its true position for the
//! place, date and time; a procedural cloud layer (`assets/shaders/clouds.wgsl`); fog; wind; lightning. The
//! photorealistic tiles are unlit photographs, so their brightness and tint follow the light here as well.
//! Rain and snow fall in the scene and wet the lens (`precip`).
//!
//! Bad weather greys and softens the view but keeps it readable: the photographs dim a little under a heavy
//! overcast, not by half, and the presets' visibility (`ui.js`) is what a pilot would still fly in.
//!
//! Seen from high up, the weather is below: the haze thins out and the cloud sheet fades between the lower
//! stratosphere and 30 km, and above `RAYMARCH_ABOVE` the atmosphere is raymarched, the mode Bevy provides for views
//! from orbit (its lookup tables assume a camera inside the air, and from above it they tinted the ground brown).

use bevy::camera::Exposure;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::light::atmosphere::ScatteringMedium;
use bevy::light::{Atmosphere, AtmosphereEnvironmentMapLight, light_consts::lux};
use bevy::mesh::VertexAttributeValues;
use bevy::pbr::{AtmosphereMode, AtmosphereSettings, DistanceFog, ExtractedAtmosphere, FogFalloff, GpuAtmosphereSettings};
use bevy::prelude::*;
use bevy::render::extract_component::DynamicUniformIndex;
use bevy::render::render_resource::{AsBindGroup, ShaderType};
use bevy::render::{Render, RenderApp, RenderSystems};
use bevy::shader::ShaderRef;
use bevy_3d_tiles::{TileGeometry, Tiles3dCamera};
use serde::Deserialize;

use crate::origin::Frame;

mod precip;

pub struct WeatherPlugin;

/// Above this height (m above sea level) the sky is raymarched rather than read from the lookup tables.
const RAYMARCH_ABOVE: f32 = 10_000.0;

/// How far the view has left the weather behind: 0 in the low air, 1 above 25 km.
fn above_weather(altitude: f32) -> f32 {
    smoothstep(2_000.0, 25_000.0, altitude)
}

/// How far the camera is inside the cloud: the layer is drawn as a thin sheet, so within this much of its base it
/// fades out and the fog closes in instead, rather than cutting the view in two along the horizon.
const IN_CLOUD: f32 = 60.0;

fn in_cloud(weather: &Weather, cam_y: f32) -> f32 {
    if !weather.cloud_layer {
        return 0.0;
    }
    (1.0 - smoothstep(0.0, IN_CLOUD, (cam_y - weather.cloud_base).abs())) * weather.clouds
}

impl Plugin for WeatherPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins((MaterialPlugin::<CloudMaterial>::default(), precip::PrecipPlugin))
            .init_resource::<Weather>()
            .init_resource::<Sky>()
            .add_systems(PostStartup, setup)
            .add_systems(Update, (advance_clock, light_the_scene, place_clouds, tint_tiles).chain());
        if let Some(render_app) = app.get_sub_app_mut(RenderApp) {
            render_app.add_systems(Render, forget_atmosphere.in_set(RenderSystems::Prepare));
        }
    }
}

/// Bevy (0.19.1) leaves a removed atmosphere's last state on the camera's render entity, and its sky pass (and the
/// environment map's) went on drawing with it: the sky and depth of the moment it went, frozen, turning with the view
/// as a flat band of ground over the overcast sky. Without the settings' uniform index neither pass runs.
fn forget_atmosphere(mut commands: Commands, views: Query<Entity, (With<DynamicUniformIndex<GpuAtmosphereSettings>>, Without<ExtractedAtmosphere>)>) {
    for e in &views {
        commands.entity(e).remove::<DynamicUniformIndex<GpuAtmosphereSettings>>();
    }
}

/// What the weather menu sets. Every field can arrive on its own (`#[serde(default)]` fills the rest from the
/// current state in `apply`).
#[derive(Resource, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Weather {
    /// Local solar time (h) and day of the year.
    pub hour: f32,
    pub day: f32,
    /// Clock speed: 0 stops the sun, 60 runs an hour a minute.
    pub time_rate: f32,
    /// Cloud cover 0..1 and the layer's base (m above the ground).
    pub clouds: f32,
    pub cloud_base: f32,
    /// Rain or snow 0..1.
    pub precipitation: f32,
    pub snow: bool,
    /// Meteorological visibility (m).
    pub visibility: f32,
    /// Wind speed (m/s) and the direction it blows from (degrees).
    pub wind_speed: f32,
    pub wind_from: f32,
    pub lightning: bool,
    /// Graphics switches that belong to the sky.
    pub atmosphere: bool,
    pub cloud_layer: bool,
}

impl Default for Weather {
    fn default() -> Self {
        Self {
            hour: 14.0,
            day: 180.0,
            time_rate: 0.0,
            clouds: 0.35,
            cloud_base: 1800.0,
            precipitation: 0.0,
            snow: false,
            visibility: 40_000.0,
            wind_speed: 4.0,
            wind_from: 250.0,
            lightning: false,
            atmosphere: true,
            cloud_layer: true,
        }
    }
}

impl Weather {
    /// Merges a partial update from the menu (JSON object with any of the fields).
    pub fn apply(&mut self, patch: &serde_json::Value) {
        let mut current = serde_json::to_value(WeatherView::from(&*self)).unwrap_or_default();
        if let (Some(cur), Some(p)) = (current.as_object_mut(), patch.as_object()) {
            for (k, v) in p {
                cur.insert(k.clone(), v.clone());
            }
        }
        if let Ok(next) = serde_json::from_value::<Weather>(current) {
            *self = next;
        }
    }

    /// The air's velocity (m/s, world frame: east +X, north −Z).
    pub fn wind(&self) -> Vec3 {
        // Blowing *from* `wind_from` degrees: moving toward the opposite bearing.
        let to = (self.wind_from + 180.0).to_radians();
        Vec3::new(to.sin(), 0.0, -to.cos()) * self.wind_speed
    }
}

/// The same fields, for serialising (the menu reads the clock back from the HUD state).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherView {
    hour: f32,
    day: f32,
    time_rate: f32,
    clouds: f32,
    cloud_base: f32,
    precipitation: f32,
    snow: bool,
    visibility: f32,
    wind_speed: f32,
    wind_from: f32,
    lightning: bool,
    atmosphere: bool,
    cloud_layer: bool,
}

impl From<&Weather> for WeatherView {
    fn from(w: &Weather) -> Self {
        Self {
            hour: w.hour,
            day: w.day,
            time_rate: w.time_rate,
            clouds: w.clouds,
            cloud_base: w.cloud_base,
            precipitation: w.precipitation,
            snow: w.snow,
            visibility: w.visibility,
            wind_speed: w.wind_speed,
            wind_from: w.wind_from,
            lightning: w.lightning,
            atmosphere: w.atmosphere,
            cloud_layer: w.cloud_layer,
        }
    }
}

/// Derived light state, shared with the HUD.
#[derive(Resource, Default)]
pub struct Sky {
    /// Sun elevation and azimuth (rad; azimuth clockwise from north).
    pub sun_elevation: f32,
    pub sun_azimuth: f32,
    /// Daylight 0 (night) .. 1 (full day), after clouds.
    pub daylight: f32,
    /// Lightning flash, decaying from 1.
    pub flash: f32,
    /// The cloud sheet is hidden while the command view looks down through it (set by the sandbox).
    pub hide_cloud_layer: bool,
    next_flash: f32,
    seed: u32,
    tint: Vec3,
    cloud: Option<Handle<CloudMaterial>>,
    medium: Handle<ScatteringMedium>,
}

impl Sky {
    fn random(&mut self) -> f32 {
        self.seed = self.seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (self.seed >> 8) as f32 / (1u32 << 24) as f32
    }
}

#[derive(Component)]
struct CloudLayer;

/// The planet's air (Bevy's `Atmosphere`). It is switched off by despawning it, as a camera without `AtmosphereSettings`
/// went on drawing the last one it had (its sky, and its bare ground past the tiles as a brown band along the horizon).
/// Even with none left, Bevy keeps drawing the last state: `forget_atmosphere` stops that.
#[derive(Component)]
struct Air;

#[derive(Clone, Copy, ShaderType, Default)]
pub struct CloudUniform {
    /// Coverage, darkness, the layer's base (m, world), opacity.
    pub params: Vec4,
    /// Wind drift (m) and the world frame's offset from the start frame (m), both on the ground plane.
    pub offset: Vec4,
    /// Lit and shaded colours.
    pub lit: Vec4,
    pub shade: Vec4,
    /// The haze the far cloud fades into (the fog's colour), and how much.
    pub haze: Vec4,
}

#[derive(Asset, TypePath, AsBindGroup, Clone)]
pub struct CloudMaterial {
    #[uniform(0)]
    pub u: CloudUniform,
}

impl Material for CloudMaterial {
    fn fragment_shader() -> ShaderRef {
        "shaders/clouds.wgsl".into()
    }
    fn alpha_mode(&self) -> AlphaMode {
        AlphaMode::Blend
    }
}

fn setup(
    mut commands: Commands,
    mut media: ResMut<Assets<ScatteringMedium>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<CloudMaterial>>,
    mut sky: ResMut<Sky>,
    camera: Single<Entity, With<Tiles3dCamera>>,
) {
    sky.medium = media.add(ScatteringMedium::earth(256, 256));
    commands.spawn((Air, Atmosphere::earth(sky.medium.clone())));
    commands.entity(*camera).insert((
        AtmosphereSettings::default(),
        Exposure { ev100: 13.0 },
        Tonemapping::TonyMcMapface,
        AtmosphereEnvironmentMapLight::default(),
        DistanceFog { color: Color::srgb(0.7, 0.72, 0.76), falloff: FogFalloff::from_visibility(1.0e6), ..default() },
    ));
    // The cloud layer: one sheet seen from below, one from above (built bent the other way, as it is turned over),
    // following the camera.
    let material = materials.add(CloudMaterial { u: CloudUniform::default() });
    for (flip, bend) in [(0.0, -1.0), (std::f32::consts::PI, 1.0)] {
        let sheet = meshes.add(cloud_sheet(bend));
        commands.spawn((CloudLayer, crate::sandbox::NoHit, Mesh3d(sheet), MeshMaterial3d(material.clone()), Transform::from_rotation(Quat::from_rotation_x(flip))));
    }
    sky.cloud = Some(material);
    sky.seed = 0x2F6E_2B1D;
    sky.tint = Vec3::ONE;
}

/// The cloud sheet: 500 km across and curved down with the Earth (by d²/2R), so that from under an overcast it
/// reaches the horizon all round. A flat one ended a fraction of a degree above it, over a strip of bare backdrop.
fn cloud_sheet(bend: f32) -> Mesh {
    const EARTH_RADIUS: f32 = 6_371_000.0;
    let mut mesh = Plane3d::new(Vec3::Y, Vec2::splat(250_000.0)).mesh().subdivisions(96).build();
    if let Some(VertexAttributeValues::Float32x3(points)) = mesh.attribute_mut(Mesh::ATTRIBUTE_POSITION) {
        for p in points {
            p[1] += bend * (p[0] * p[0] + p[2] * p[2]) / (2.0 * EARTH_RADIUS);
        }
    }
    mesh
}

fn advance_clock(time: Res<Time>, mut weather: ResMut<Weather>, mut sky: ResMut<Sky>) {
    let dt = time.delta_secs();
    if weather.time_rate > 0.0 {
        weather.hour = (weather.hour + weather.time_rate * dt / 3600.0).rem_euclid(24.0);
    }
    // Lightning: in heavy cloud, a flash every few seconds.
    sky.flash = (sky.flash - dt * 6.0).max(0.0);
    if weather.lightning && weather.clouds > 0.5 {
        sky.next_flash -= dt;
        if sky.next_flash <= 0.0 {
            sky.flash = 1.0;
            sky.next_flash = 2.0 + sky.random() * 9.0;
        }
    }
}

/// Solar elevation and azimuth (rad) at a latitude for a day of the year and a local solar time.
fn sun_position(lat: f32, day: f32, hour: f32) -> (f32, f32) {
    let decl = (23.44_f32).to_radians() * (std::f32::consts::TAU * (284.0 + day) / 365.0).sin();
    let h = (15.0 * (hour - 12.0)).to_radians();
    let lat = lat.to_radians();
    let elev = (lat.sin() * decl.sin() + lat.cos() * decl.cos() * h.cos()).clamp(-1.0, 1.0).asin();
    let az = h.sin().atan2(h.cos() * lat.sin() - decl.tan() * lat.cos()) + std::f32::consts::PI;
    (elev, az)
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[allow(clippy::too_many_arguments)]
fn light_the_scene(
    weather: Res<Weather>,
    mut sky: ResMut<Sky>,
    frame: Res<Frame>,
    mut sun: Query<(&mut DirectionalLight, &mut Transform), Without<Tiles3dCamera>>,
    mut cam: Single<(&Transform, &mut Exposure, &mut DistanceFog, &mut AtmosphereSettings), With<Tiles3dCamera>>,
    air: Query<Entity, With<Air>>,
    mut atmosphere: Query<&mut Visibility, With<CloudLayer>>,
    mut clear: ResMut<ClearColor>,
    mut commands: Commands,
) {
    let (lat, _, _) = frame.geodetic(Vec3::ZERO);
    let (elev, az) = sun_position(lat as f32, weather.day, weather.hour);
    sky.sun_elevation = elev;
    sky.sun_azimuth = az;
    let to_sun = Vec3::new(elev.cos() * az.sin(), elev.sin(), -elev.cos() * az.cos());
    let overcast = weather.clouds.powf(1.5);
    let day = smoothstep(-0.1, 0.2, elev);
    // Broken cloud dims the day as before; beyond that a full overcast and rain take off only a little more, since
    // the eye (and the camera) adapt to it.
    let dim = 0.45 * overcast.min(0.2) + 0.12 * (overcast - 0.2).max(0.0);
    sky.daylight = day * (1.0 - dim) * (1.0 - 0.06 * weather.precipitation);
    for (mut light, mut tf) in &mut sun {
        // Below the horizon the "sun" is the moon: a faint, cool light from high up.
        if elev > -0.05 {
            light.illuminance = lux::RAW_SUNLIGHT * (1.0 - 0.7 * overcast) * (1.0 - 0.2 * weather.precipitation) + sky.flash * 40_000.0;
            light.color = Color::WHITE;
            *tf = Transform::IDENTITY.looking_to(-to_sun, Vec3::Y);
        } else {
            light.illuminance = 0.3 + sky.flash * 400.0;
            light.color = Color::srgb(0.7, 0.78, 1.0);
            *tf = Transform::IDENTITY.looking_to(Vec3::new(0.3, -1.0, 0.2), Vec3::Y);
        }
    }
    let (cam_tf, exposure, fog, settings) = &mut *cam;
    let altitude = frame.altitude(cam_tf.translation);
    let above = above_weather(altitude);
    // Exposure follows the light, as an eye (or an auto-exposure camera) does.
    let ev_day = 13.0 - 1.2 * overcast;
    // From high up the air's glow over the ground drowned the land and sea in blue: stopping down dims that glow (and
    // the sky) while the tiles, unlit photographs, keep their brightness.
    let thin_haze = 1.5 * smoothstep(5_000.0, 80_000.0, altitude);
    exposure.ev100 = (7.5 + (ev_day - 7.5) * smoothstep(-0.2, 0.15, elev)) - sky.flash * 2.0 + thin_haze;
    // Fog: visibility, in the colour of the overcast sky at this hour.
    let grey = 0.55 + 0.25 * weather.clouds;
    let brightness = 0.08 + 0.92 * sky.daylight.max(sky.flash);
    let haze = Vec3::new(grey, grey + 0.02, grey + 0.06) * brightness;
    // The fog is the low air's haze: looking down from high up there is little of it on the way, so it fades out.
    fog.color = Color::srgba(haze.x, haze.y, haze.z, 1.0 - above);
    // Inside the cloud the fog closes in (eased in log space: from 1000 km a straight blend would stay clear until the
    // last metres).
    let clear_air = if weather.visibility >= 39_000.0 { 1.0e6 } else { weather.visibility.max(100.0) };
    let inside = if sky.hide_cloud_layer { 0.0 } else { in_cloud(&weather, cam_tf.translation.y) };
    fog.falloff = FogFalloff::from_visibility((clear_air.ln() + (80.0_f32.ln() - clear_air.ln()) * inside).exp());
    // Under a full overcast or in fog the sky is the cloud's grey all the way down: the physical sky (which fog
    // doesn't reach) would show its clear-air colours at the horizon. The backdrop takes the fog's colour instead,
    // until the view climbs out above the weather; toward space it darkens.
    let overcast_sky = (weather.clouds > 0.85 || weather.visibility < 6000.0) && above < 0.5;
    let want_atmosphere = weather.atmosphere && !overcast_sky;
    let space = smoothstep(30_000.0, 100_000.0, altitude);
    let backdrop = haze * (1.0 - space);
    clear.0 = Color::srgb(backdrop.x, backdrop.y, backdrop.z);
    let mode = if altitude > RAYMARCH_ABOVE { AtmosphereMode::Raymarched } else { AtmosphereMode::LookupTexture };
    if settings.rendering_method as u32 != mode as u32 {
        settings.rendering_method = mode;
    }
    if want_atmosphere == air.is_empty() {
        if want_atmosphere {
            commands.spawn((Air, Atmosphere::earth(sky.medium.clone())));
        } else {
            for e in &air {
                commands.entity(e).despawn();
            }
        }
    }
    for mut vis in &mut atmosphere {
        let shown = weather.cloud_layer && weather.clouds > 0.02 && !sky.hide_cloud_layer && above < 1.0;
        vis.set_if_neq(if shown { Visibility::Inherited } else { Visibility::Hidden });
    }
}

fn place_clouds(
    time: Res<Time>,
    weather: Res<Weather>,
    sky: Res<Sky>,
    frame: Res<Frame>,
    cam: Single<&Transform, (With<Tiles3dCamera>, Without<CloudLayer>)>,
    mut layers: Query<&mut Transform, With<CloudLayer>>,
    mut materials: ResMut<Assets<CloudMaterial>>,
    mut drift: Local<Vec2>,
) {
    let wind = weather.wind();
    *drift += Vec2::new(wind.x, wind.z) * time.delta_secs();
    for mut tf in &mut layers {
        tf.translation = Vec3::new(cam.translation.x, weather.cloud_base, cam.translation.z);
    }
    let Some(handle) = &sky.cloud else { return };
    let Some(mut m) = materials.get_mut(handle) else { return };
    // Noise in the start frame's coordinates, so the clouds stay put when the world frame moves under the camera.
    let start = frame.world_from_start.inverse().transform_point3(bevy::math::DVec3::ZERO);
    let warm = 1.0 - smoothstep(0.02, 0.35, sky.sun_elevation);
    let light = 0.12 + 0.88 * smoothstep(-0.12, 0.2, sky.sun_elevation);
    let lit = Vec3::new(1.0, 1.0 - 0.3 * warm, 1.0 - 0.5 * warm) * light * 1.3;
    let shade = Vec3::new(0.52, 0.56, 0.63) * light * (1.0 - 0.4 * weather.precipitation);
    let flash = sky.flash * 1.5;
    let grey = 0.55 + 0.25 * weather.clouds;
    let brightness = 0.08 + 0.92 * sky.daylight.max(sky.flash);
    let haze = Vec3::new(grey, grey + 0.02, grey + 0.06) * brightness;
    // The sheet is a thin shell 500 km wide: from high up it would lie over the ground as a milky veil, so it fades
    // out on the way up.
    let opacity = 0.95 * (1.0 - smoothstep(12_000.0, 25_000.0, frame.altitude(cam.translation))) * (1.0 - in_cloud(&weather, cam.translation.y));
    m.u = CloudUniform {
        params: Vec4::new(weather.clouds, (weather.precipitation * 0.8 + (weather.clouds - 0.7).max(0.0)).min(1.0), weather.cloud_base, opacity),
        offset: Vec4::new(drift.x, drift.y, start.x as f32, start.z as f32),
        lit: (lit + flash).extend(1.0),
        shade: (shade + flash * 0.6).extend(1.0),
        haze: haze.extend(0.5 + 0.5 * weather.clouds),
    };
}

/// The tiles are photographs: their brightness and colour follow the daylight (dim and blue at night, warm at
/// sunset, grey under overcast), and they flash with lightning.
fn tint_tiles(
    weather: Res<Weather>,
    mut sky: ResMut<Sky>,
    tiles: Query<&MeshMaterial3d<StandardMaterial>, With<TileGeometry>>,
    added: Query<(), Added<TileGeometry>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let warm = (1.0 - smoothstep(0.03, 0.3, sky.sun_elevation)) * smoothstep(-0.1, 0.02, sky.sun_elevation);
    let night = 1.0 - smoothstep(-0.12, 0.02, sky.sun_elevation);
    let b = 0.1 + 0.95 * sky.daylight + sky.flash * 1.2;
    let color = Vec3::ONE.lerp(Vec3::new(1.0, 0.8, 0.62), warm * (1.0 - weather.clouds * 0.7)).lerp(Vec3::new(0.55, 0.65, 1.0), night);
    let tint = color * b;
    let changed = tint.distance(sky.tint) > 0.004;
    if !changed && added.is_empty() {
        return;
    }
    sky.tint = tint;
    let c = Color::linear_rgb(tint.x, tint.y, tint.z);
    for handle in &tiles {
        if let Some(mut m) = materials.get_mut(&handle.0) {
            if m.base_color != c {
                m.base_color = c;
            }
        }
    }
}
