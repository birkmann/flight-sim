//! The aircraft a flight can be made in, and their published-order performance: masses, wing, high lift per flap
//! setting, engines, landing gear and limits. `model.rs` flies them; V-speeds come from the stall speeds here, as an
//! aircraft manual's tables do.

use crate::physics::{atmosphere, G};

/// One flap lever position: the lift it adds at a given angle of attack, its maximum lift, its drag and its placard
/// speed (kt).
pub struct Flap {
    pub label: &'static str,
    pub cl0: f32,
    pub cl_max: f32,
    pub cd: f32,
    pub vfe: f32,
}

pub enum Engine {
    /// Unpowered sailplane: no thrust or fuel consumption.
    Glider,
    /// Turbofans: total sea-level static thrust (N), the afterburner's (0 without one), idle N1 (fraction), thrust
    /// specific fuel consumption (kg/N/s), the reversers' share of forward thrust (0 without), spool time (s).
    Fan { thrust: f32, thrust_ab: f32, idle: f32, tsfc: f32, reverse: f32, spool: f32, count: u8 },
    /// A piston engine and fixed-pitch propeller: rated power (W), static thrust at full power (N), propeller
    /// efficiency, brake specific fuel consumption (kg/J), idle and redline rpm.
    Prop { power: f32, static_thrust: f32, eta: f32, bsfc: f32, idle_rpm: f32, max_rpm: f32 },
}

/// How the controls fly it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Law {
    /// The stick commands pitch rate and load factor and holds the flight path when let go; the bank holds too.
    FlyByWire,
    /// Cables: the stick moves the surfaces, the aircraft seeks the angle of attack it is trimmed for, and a bank
    /// slowly deepens unless held.
    Direct,
}

pub struct Type {
    pub id: &'static str,
    pub label: &'static str,
    /// The cockpit layout: "airliner", "ga" or "fighter".
    pub panel: &'static str,
    pub law: Law,
    /// Operating empty mass, maximum take-off mass, usable fuel (kg).
    pub oew: f32,
    pub mtow: f32,
    pub fuel_max: f32,
    pub wing_area: f32,
    pub span: f32,
    pub cl_alpha: f32,
    pub cd0: f32,
    /// Induced drag factor k in CD = CD0 + k·CL².
    pub k: f32,
    pub cy_beta: f32,
    pub flaps: &'static [Flap],
    /// The lever position for take-off and for landing (index into `flaps`).
    pub flaps_takeoff: usize,
    pub flaps_landing: usize,
    pub cd_gear: f32,
    pub gear_retracts: bool,
    /// Drag of fully raised spoilers (or speed brake), and the share of the lift they spoil.
    pub spoiler_cd: f32,
    pub spoiler_dump: f32,
    pub engine: Engine,
    /// Rate limits (rad/s), load factor limits, how quickly the rates follow a command (s), the dynamic pressure of
    /// full control authority (Pa).
    pub pitch_rate: f32,
    pub roll_rate: f32,
    pub yaw_rate: f32,
    pub g_max: f32,
    pub g_min: f32,
    pub tau: f32,
    pub q_full: f32,
    /// Maximum operating speed (kt) and Mach number, service ceiling (ft).
    pub vmo: f32,
    pub mmo: f32,
    pub ceiling: f32,
    /// Cruise: Mach for jets, true airspeed (kt) for the light aircraft; and the usual cruise level (ft).
    pub cruise: f32,
    pub cruise_ft: f32,
    /// Climb and descent speeds (kt indicated), and the approach speed's addition over VREF.
    pub climb_kt: f32,
    pub descent_kt: f32,
    /// Pitch attitude on the wheels, and where the tail touches (rad).
    pub ground_pitch: f32,
    pub tail_strike: f32,
    /// Nose wheel to main gear (m), nose wheel steering with the tiller and with the pedals (rad).
    pub wheelbase: f32,
    pub tiller: f32,
    pub pedal_steer: f32,
    /// Wheel brakes' friction coefficient, and whether it has an autobrake.
    pub brake_mu: f32,
    pub autobrake: bool,
    /// The pilot's eye in the model's frame, as fractions of its bounding box (x across, y up, z nose to tail).
    pub eye: [f32; 3],
    /// Take-off target pitch (rad) the flight director shows after rotation.
    pub srs_pitch: f32,
}

impl Type {
    /// Lift coefficient limits and drag at a flap position between lever positions (fractional index).
    pub fn flap_at(&self, f: f32) -> (f32, f32, f32) {
        let i = (f.floor() as usize).min(self.flaps.len() - 1);
        let j = (i + 1).min(self.flaps.len() - 1);
        let t = f - i as f32;
        let (a, b) = (&self.flaps[i], &self.flaps[j]);
        (a.cl0 + (b.cl0 - a.cl0) * t, a.cl_max + (b.cl_max - a.cl_max) * t, a.cd + (b.cd - a.cd) * t)
    }

    /// 1-g stall speed (kt, equivalent airspeed) at a mass and flap lever position.
    pub fn vs1g(&self, mass: f32, flap: usize) -> f32 {
        let cl = self.flaps[flap.min(self.flaps.len() - 1)].cl_max;
        (2.0 * mass * G / (1.225 * self.wing_area * cl)).sqrt() * KT
    }

    /// V-speeds (kt) for a mass: take-off with the take-off flaps, approach with the landing flaps, `headwind` (kt)
    /// adding half to the approach speed (at least 5 kt more, at most 15).
    pub fn vspeeds(&self, mass: f32, headwind: f32) -> VSpeeds {
        let vs_to = self.vs1g(mass, self.flaps_takeoff);
        let vs_ldg = self.vs1g(mass, self.flaps_landing);
        let vs_clean = self.vs1g(mass, 0);
        let (v2, vr, vref) = match self.panel {
            // A light aircraft rotates a little above the stall and climbs at its best-rate speed.
            "ga" => (vs_clean * 1.5, vs_to * 1.1, vs_ldg * 1.3),
            _ => (vs_to * 1.13, vs_to * 1.13 - 4.0, vs_ldg * 1.23),
        };
        VSpeeds {
            v1: vr - 3.0,
            vr,
            v2,
            vref,
            vapp: vref + (headwind * 0.5).clamp(5.0, 15.0),
            // Flap retraction ("F" and "S" speeds) and the green dot: best lift over drag, clean.
            f_speed: vs_clean * 1.18,
            s_speed: vs_clean * 1.23,
            green_dot: vs_clean * 1.4,
            vs_clean,
        }
    }

    pub fn is_jet(&self) -> bool {
        matches!(self.engine, Engine::Fan { .. })
    }
}

pub const KT: f32 = 1.943_844;
pub const FT: f32 = 3.280_84;

#[derive(Clone, Copy, Default, serde::Serialize)]
pub struct VSpeeds {
    pub v1: f32,
    pub vr: f32,
    pub v2: f32,
    pub vref: f32,
    pub vapp: f32,
    pub f_speed: f32,
    pub s_speed: f32,
    pub green_dot: f32,
    pub vs_clean: f32,
}

/// Indicated (calibrated) airspeed (kt) of a true airspeed (m/s) at an altitude (m): the airspeed indicator reads
/// dynamic pressure, so up high it shows less than the aircraft's speed through the air.
pub fn ias_kt(tas: f32, alt: f32) -> f32 {
    let (rho, _) = atmosphere(alt);
    tas * (rho / 1.225).sqrt() * KT
}

/// True airspeed (m/s) of an indicated airspeed (kt) at an altitude (m).
pub fn tas_of(ias_kt: f32, alt: f32) -> f32 {
    let (rho, _) = atmosphere(alt);
    ias_kt / KT / (rho / 1.225).sqrt()
}

/// A320-class narrow-body airliner: CFM56-class engines, slats and flaps (CONF 1 to FULL), ground spoilers,
/// autobrake, a fly-by-wire normal law.
pub const AIRLINER: Type = Type {
    id: "airliner",
    label: "AIRLINER A320 CLASS",
    panel: "airliner",
    law: Law::FlyByWire,
    oew: 42_600.0,
    mtow: 78_000.0,
    fuel_max: 18_700.0,
    wing_area: 122.6,
    span: 34.1,
    cl_alpha: 5.5,
    cd0: 0.019,
    k: 0.04,
    cy_beta: 1.0,
    flaps: &[
        Flap { label: "0", cl0: 0.25, cl_max: 1.5, cd: 0.0, vfe: 350.0 },
        Flap { label: "1", cl0: 0.32, cl_max: 1.88, cd: 0.006, vfe: 230.0 },
        Flap { label: "1+F", cl0: 0.72, cl_max: 2.08, cd: 0.014, vfe: 215.0 },
        Flap { label: "2", cl0: 0.85, cl_max: 2.22, cd: 0.028, vfe: 200.0 },
        Flap { label: "3", cl0: 0.95, cl_max: 2.34, cd: 0.042, vfe: 185.0 },
        Flap { label: "FULL", cl0: 1.1, cl_max: 2.5, cd: 0.072, vfe: 177.0 },
    ],
    flaps_takeoff: 2,
    flaps_landing: 5,
    cd_gear: 0.019,
    gear_retracts: true,
    spoiler_cd: 0.07,
    spoiler_dump: 0.5,
    engine: Engine::Fan { thrust: 2.0 * 120_000.0, thrust_ab: 0.0, idle: 0.2, tsfc: 1.62e-5, reverse: 0.3, spool: 3.5, count: 2 },
    pitch_rate: 0.12,
    roll_rate: 0.26,
    yaw_rate: 0.08,
    g_max: 2.5,
    g_min: -1.0,
    tau: 0.6,
    q_full: 2_000.0,
    vmo: 350.0,
    mmo: 0.82,
    ceiling: 39_800.0,
    cruise: 0.78,
    cruise_ft: 35_000.0,
    climb_kt: 290.0,
    descent_kt: 290.0,
    ground_pitch: 0.0,
    tail_strike: 0.2,
    wheelbase: 12.6,
    tiller: 1.3,
    pedal_steer: 0.1,
    brake_mu: 0.55,
    autobrake: true,
    eye: [0.46, 0.63, 0.06],
    srs_pitch: 0.26,
};

/// C172-class light single: 180 hp, fixed-pitch propeller, fixed gear, manual flaps (0, 10, 20, 30°), cables.
pub const C172: Type = Type {
    id: "c172",
    label: "C172 LIGHT SINGLE",
    panel: "ga",
    law: Law::Direct,
    oew: 767.0,
    mtow: 1_157.0,
    fuel_max: 159.0,
    wing_area: 16.2,
    span: 11.0,
    cl_alpha: 4.9,
    cd0: 0.036,
    k: 0.054,
    cy_beta: 1.2,
    flaps: &[
        Flap { label: "0°", cl0: 0.3, cl_max: 1.6, cd: 0.0, vfe: 163.0 },
        Flap { label: "10°", cl0: 0.55, cl_max: 1.8, cd: 0.01, vfe: 110.0 },
        Flap { label: "20°", cl0: 0.78, cl_max: 1.98, cd: 0.028, vfe: 85.0 },
        Flap { label: "30°", cl0: 0.95, cl_max: 2.1, cd: 0.05, vfe: 85.0 },
    ],
    flaps_takeoff: 0,
    flaps_landing: 3,
    cd_gear: 0.0,
    gear_retracts: false,
    spoiler_cd: 0.0,
    spoiler_dump: 0.0,
    engine: Engine::Prop { power: 134_000.0, static_thrust: 2_700.0, eta: 0.66, bsfc: 8.5e-8, idle_rpm: 650.0, max_rpm: 2_700.0 },
    pitch_rate: 0.5,
    roll_rate: 1.2,
    yaw_rate: 0.5,
    g_max: 3.8,
    g_min: -1.5,
    tau: 0.25,
    q_full: 500.0,
    vmo: 163.0,
    mmo: 0.3,
    ceiling: 14_000.0,
    cruise: 120.0,
    cruise_ft: 6_500.0,
    climb_kt: 75.0,
    descent_kt: 110.0,
    ground_pitch: 0.0,
    tail_strike: 0.26,
    wheelbase: 1.65,
    tiller: 0.3,
    pedal_steer: 0.3,
    brake_mu: 0.45,
    autobrake: false,
    eye: [0.42, 0.66, 0.36],
    srs_pitch: 0.12,
};

/// Representative 15 m club sailplane; approximate performance, not a certified aircraft model.
pub const GLIDER: Type = Type {
    id: "glider", label: "15 M SAILPLANE", panel: "glider", engine: Engine::Glider,
    oew: 260.0, mtow: 525.0, fuel_max: 0.0, wing_area: 10.5, span: 15.0,
    cl_alpha: 5.7, cd0: 0.009, k: 0.019, cy_beta: 1.0,
    flaps: &[Flap { label: "CLEAN", cl0: 0.2, cl_max: 1.5, cd: 0.0, vfe: 135.0 }],
    flaps_takeoff: 0, flaps_landing: 0, cd_gear: 0.012, gear_retracts: true,
    spoiler_cd: 0.12, spoiler_dump: 0.25, pitch_rate: 0.45, roll_rate: 0.85,
    g_max: 5.3, g_min: -2.65, vmo: 135.0, mmo: 0.3, ceiling: 18000.0,
    cruise: 59.0, cruise_ft: 4500.0, climb_kt: 48.0, descent_kt: 59.0,
    wheelbase: 0.8, eye: [0.5, 0.65, 0.25], ..C172
};
pub static TYPES: [&Type; 3] = [&AIRLINER, &C172, &GLIDER];

pub fn find(id: &str) -> Option<&'static Type> {
    TYPES.iter().copied().find(|t| t.id == id)
}
