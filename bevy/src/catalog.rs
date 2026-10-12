//! The sandbox's assets: the workspace's digital-twin catalogue (the original model catalogue) and the platform designs
//! it falls back to, each with its model, how it moves and what it carries. `ui.js` lists the same ids.

use crate::physics::{self, Airframe, Ground, TurretDrive, Vessel};

/// How a vehicle is flown or driven.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// Crewed fixed-wing aircraft.
    Jet,
    /// Uncrewed fixed-wing aircraft with a stabilised camera.
    Uav,
    /// Loitering munition.
    Munition,
    Heli,
    /// Tracked armour (the fire-control tank gun).
    Tank,
    Wheeled,
    Ship,
    /// Uncrewed underwater vehicle.
    Uuv,
}

impl Kind {
    pub fn flies(self) -> bool {
        matches!(self, Kind::Jet | Kind::Uav | Kind::Munition)
    }
    pub fn drives(self) -> bool {
        matches!(self, Kind::Tank | Kind::Wheeled)
    }
    pub fn sails(self) -> bool {
        matches!(self, Kind::Ship | Kind::Uuv)
    }
    /// The HUD layout.
    pub fn hud(self) -> &'static str {
        match self {
            Kind::Jet => "jet",
            Kind::Uav => "uav",
            Kind::Munition => "munition",
            Kind::Heli => "heli",
            Kind::Tank | Kind::Wheeled => "tank",
            Kind::Ship | Kind::Uuv => "ship",
        }
    }
}

/// Where a gun fires from and along.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mount {
    /// Fixed forward, from the nose.
    Nose,
    /// Where the pilot looks (a chin or door gun).
    Look,
    /// Down the bore of the model's gun node (`gun-recoil`).
    Turret,
}

#[derive(Clone, Copy)]
pub struct Gun {
    pub label: &'static str,
    pub rounds: u32,
    /// Seconds between tracers, rounds each tracer stands for.
    pub interval: f32,
    pub per_tracer: u32,
    pub muzzle: f32,
    pub damage: f32,
    pub splash: f32,
    pub mount: Mount,
    /// Fires while the trigger is held (automatic), or once per press.
    pub automatic: bool,
}

pub struct Asset {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: Kind,
    pub airframe: Option<&'static Airframe>,
    pub ground: Option<&'static Ground>,
    pub vessel: Option<&'static Vessel>,
    pub turret: Option<&'static TurretDrive>,
    pub gun: Option<Gun>,
    pub health: f32,
    /// Spawned in the air: height above the ground (m) and speed (m/s).
    pub airborne: (f32, f32),
    /// Swing wings: the model's `wing-sweep-*` and `pylon-swivel-*` nodes turn with them.
    pub sweep: Option<&'static Sweep>,
}

/// Variable-sweep wings: the sweep the model is built at and the range (deg), the positions Y steps through, and the
/// airframe fully swept (`airframe` is the spread one; the flight model blends between them).
pub struct Sweep {
    pub built_deg: f32,
    pub min_deg: f32,
    pub max_deg: f32,
    pub stops: &'static [f32],
    pub swept: &'static Airframe,
}

/// Sweep the wings take by themselves at a Mach number, as the automatic schedule: spread up to Mach 0.5, the 45° and
/// 58° stops on the way back, fully swept from Mach 0.94. A share of the range, 0 spread .. 1 swept.
pub fn auto_sweep(mach: f32) -> f32 {
    const KEYS: [(f32, f32); 4] = [(0.5, 0.0), (0.66, 20.0 / 42.0), (0.82, 33.0 / 42.0), (0.94, 1.0)];
    if mach <= KEYS[0].0 {
        return 0.0;
    }
    for w in KEYS.windows(2) {
        let ((m0, s0), (m1, s1)) = (w[0], w[1]);
        if mach <= m1 {
            return s0 + (s1 - s0) * (mach - m0) / (m1 - m0);
        }
    }
    1.0
}

impl Asset {
    pub fn model(&self) -> String {
        format!("models/{}.glb", self.id)
    }
    /// Missile launchers: E raises the erector, and the truck stands on its stabilisers while it is up.
    pub fn has_erector(&self) -> bool {
        matches!(self.id, "sam" | "patriot")
    }

}

const fn asset(id: &'static str, label: &'static str, kind: Kind, health: f32) -> Asset {
    Asset { id, label, kind, airframe: None, ground: None, vessel: None, turret: None, gun: None, health, airborne: (0.0, 0.0), sweep: None }
}

pub static ASSETS: [Asset; 3] = [
    Asset { airframe: Some(&physics::GLIDER), airborne: (1200.0, 30.0), ..asset("glider", "SAILPLANE", Kind::Jet, 15.0) },
    Asset { airframe: Some(&physics::C172), airborne: (300.0, 55.0), ..asset("c172", "C172", Kind::Jet, 15.0) },
    Asset { airframe: Some(&physics::AIRLINER), airborne: (600.0, 120.0), ..asset("airliner", "AIRLINER", Kind::Jet, 80.0) },
];

pub fn find(id: &str) -> Option<&'static Asset> {
    ASSETS.iter().find(|a| a.id == id)
}

/// Number-key shortcuts for the civilian aircraft menu.
pub const HOTKEYS: [&str; 3] = ["c172", "airliner", "glider"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aircraft_catalogue_is_civilian_and_unarmed() {
        assert_eq!(ASSETS.iter().map(|a| a.id).collect::<Vec<_>>(), ["glider", "c172", "airliner"]);
        assert!(ASSETS.iter().all(|a| a.gun.is_none()));
        assert!(HOTKEYS.iter().all(|id| find(id).is_some()));
        assert!(find("f35a").is_none());
    }
}
