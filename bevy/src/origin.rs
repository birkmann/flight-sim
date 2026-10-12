//! Where the world frame sits on the Earth. The scene is a flat east/up/south frame tangent to the ellipsoid at an
//! origin; far from it the ground curves away below (at 350 km, by 9.5 km) and "down" tilts. The sandbox therefore
//! moves the origin under the camera every few kilometres (`bevy_3d_tiles` re-places its tiles when `EcefOrigin`
//! changes), and uses this to turn world positions into latitude, longitude and height for the HUD.

use bevy::math::{DMat4, DVec3};
use bevy::prelude::*;
use bevy_3d_tiles::geodesy;

use crate::geoid::geoid;

/// Re-centre once the camera is this far (m, horizontally) from the origin.
pub const REBASE_DISTANCE: f32 = 4_000.0;

#[derive(Resource, Clone)]
pub struct Frame {
    pub elev: f64,
    pub world_from_ecef: DMat4,
    pub ecef_from_world: DMat4,
    /// Maps the first frame (the benchmark scenario's, where the moving units are defined) into the current one.
    pub world_from_start: DMat4,
}

impl Frame {
    pub fn new(lat: f64, lon: f64, elev: f64) -> Self {
        let world_from_ecef = geodesy::world_from_ecef(lat, lon, elev);
        Self { elev, world_from_ecef, ecef_from_world: world_from_ecef.inverse(), world_from_start: DMat4::IDENTITY }
    }

    /// A frame centred under `at` (a point of this one); the matrix maps this frame's coordinates into the new one's.
    pub fn recentred(&self, at: Vec3) -> (Frame, DMat4) {
        let (lat, lon, _) = self.geodetic(at);
        let mut next = Frame::new(lat, lon, self.elev);
        let new_from_old = next.world_from_ecef * self.ecef_from_world;
        next.world_from_start = new_from_old * self.world_from_start;
        (next, new_from_old)
    }

    /// Latitude, longitude (degrees) and height above the ellipsoid (m) of a world point.
    pub fn geodetic(&self, p: Vec3) -> (f64, f64, f64) {
        let e = self.ecef_from_world.transform_point3(p.as_dvec3());
        ecef_to_geodetic(e)
    }

    /// Rotation from Earth-fixed (ECEF) axes to this frame's, for orientations and velocities.
    pub fn world_rot_from_ecef(&self) -> Quat {
        let (_, r, _) = self.world_from_ecef.to_scale_rotation_translation();
        r.as_quat()
    }

    /// A world point in Earth-fixed coordinates (m), and back.
    pub fn to_ecef(&self, p: Vec3) -> DVec3 {
        self.ecef_from_world.transform_point3(p.as_dvec3())
    }
    pub fn from_ecef(&self, e: DVec3) -> Vec3 {
        self.world_from_ecef.transform_point3(e).as_vec3()
    }

    /// Height above mean sea level (m) of a world point: tile heights are ellipsoidal, altitudes shown are above the
    /// geoid (`geoid.rs`).
    pub fn altitude(&self, p: Vec3) -> f32 {
        let (lat, lon, h) = self.geodetic(p);
        (h - geoid(lat, lon)) as f32
    }
}

/// WGS84 ECEF → latitude, longitude (degrees) and ellipsoidal height (m) (Bowring).
pub fn ecef_to_geodetic(e: DVec3) -> (f64, f64, f64) {
    const A: f64 = 6_378_137.0;
    const F: f64 = 1.0 / 298.257_223_563;
    let b = A * (1.0 - F);
    let e2 = F * (2.0 - F);
    let ep2 = (A * A - b * b) / (b * b);
    let p = e.x.hypot(e.y);
    let th = (A * e.z).atan2(b * p);
    let lat = (e.z + ep2 * b * th.sin().powi(3)).atan2(p - e2 * A * th.cos().powi(3));
    let n = A / (1.0 - e2 * lat.sin().powi(2)).sqrt();
    let h = p / lat.cos() - n;
    (lat.to_degrees(), e.y.atan2(e.x).to_degrees(), h)
}

/// Applies a frame change to a transform: position and orientation.
pub fn rebase_transform(m: &DMat4, tf: &mut Transform) {
    tf.translation = m.transform_point3(tf.translation.as_dvec3()).as_vec3();
    let (_, rot, _) = m.to_scale_rotation_translation();
    tf.rotation = (rot.as_quat() * tf.rotation).normalize();
}

/// Applies a frame change to a direction (a velocity).
pub fn rebase_vector(m: &DMat4, v: Vec3) -> Vec3 {
    m.transform_vector3(v.as_dvec3()).as_vec3()
}
