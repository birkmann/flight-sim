//! Autoflight: the flight control unit's selections, the autopilot and flight director modes, and the autothrust, as
//! a fly-by-wire airliner's work (a light aircraft's autopilot is the same laws without the autothrust).
//!
//! Modes (the flight mode annunciator's words):
//! - Autothrust: SPEED / MACH (the levers hold the target speed), THR CLB, THR IDLE (the pitch holds it), RETARD.
//! - Lateral: RWY (runway track on the take-off roll), HDG, NAV (the flight plan), LOC* / LOC, ROLL OUT.
//! - Vertical: SRS (take-off: V2 + 10), CLB / DES (managed: the plan's cruise level, the 3° descent path),
//!   OP CLB / OP DES (selected altitude, speed on pitch), ALT* / ALT, V/S, G/S* / G/S, FLARE.
//! APPR arms LOC and G/S; with both engaged the autopilot lands and rolls out on the centreline.
//!
//! Every law ends in the pilot's own controls: a stick deflection and pedal (`model::Input`), and a thrust lever.

use serde_json::{Value, json};

use super::model::Input;
use super::nav::{GLIDE, GS_DOT, Ils, Lnav, wrap};
use super::types::{FT, KT, Law, Type};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lat {
    Off,
    Rwy,
    Hdg,
    Nav,
    LocStar,
    Loc,
    Rollout,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Vert {
    Off,
    Srs,
    Clb,
    Des,
    OpClb,
    OpDes,
    AltStar,
    Alt,
    Vs,
    GsStar,
    Gs,
    Flare,
    Rollout,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Thr {
    Off,
    /// Armed on the ground and in the take-off, until the thrust reduction altitude.
    Armed,
    Speed,
    Mach,
    Clb,
    Idle,
    Retard,
}

/// The flight control unit: what the pilot selected.
#[derive(Clone, Debug)]
pub struct Fcu {
    pub spd: f32,
    pub spd_managed: bool,
    pub hdg: f32,
    pub alt: f32,
    pub vs: f32,
    pub ap: bool,
    pub athr: bool,
    pub fd: bool,
    pub loc: bool,
    pub appr: bool,
}

impl Default for Fcu {
    fn default() -> Self {
        Fcu { spd: 250.0, spd_managed: true, hdg: 0.0, alt: 5_000.0, vs: 0.0, ap: false, athr: true, fd: true, loc: false, appr: false }
    }
}

/// What the autoflight senses.
#[derive(Clone, Copy, Default)]
pub struct Sense {
    pub ias: f32,
    pub tas: f32,
    pub mach: f32,
    /// Altitude (ft), vertical speed (ft/min), radio altitude (ft).
    pub alt: f32,
    pub vs: f32,
    pub ra: f32,
    /// Flight path angle, track and heading (rad; courses true, clockwise from north), bank and pitch.
    pub fpa: f32,
    pub track: f32,
    pub heading: f32,
    pub bank: f32,
    pub pitch: f32,
    pub alpha: f32,
    pub alpha_stall: f32,
    /// Longitudinal acceleration along the path (m/s²).
    pub accel: f32,
    pub on_ground: bool,
    pub lever: f32,
}

/// What the flight management computes for the autoflight: the speed to fly and the altitudes of the plan.
#[derive(Clone, Copy, Default)]
pub struct Managed {
    pub speed: f32,
    pub mach: Option<f32>,
    /// The descent path's altitude here (ft), and its vertical speed at this ground speed (ft/min).
    pub path: Option<f32>,
    pub path_vs: f32,
}

#[derive(Clone)]
pub struct Autoflight {
    pub fcu: Fcu,
    pub lat: Lat,
    pub vert: Vert,
    pub thr: Thr,
    pub lat_armed: Option<Lat>,
    pub vert_armed: Option<Vert>,
    /// The flight director's commands: pitch (rad, relative to the current pitch) and bank (rad).
    pub fd_pitch: f32,
    pub fd_bank: f32,
    /// Speed target (kt), and whether it is a Mach number.
    pub target_speed: f32,
    pub target_mach: Option<f32>,
    alt_capture_from: f32,
    lever_i: f32,
    pitch_i: f32,
    /// Why the autopilot last disconnected (for the master warning), and seconds since.
    pub disconnect: Option<(&'static str, f32)>,
}

impl Default for Autoflight {
    fn default() -> Self {
        Autoflight {
            fcu: Fcu::default(),
            lat: Lat::Off,
            vert: Vert::Off,
            thr: Thr::Armed,
            lat_armed: None,
            vert_armed: None,
            fd_pitch: 0.0,
            fd_bank: 0.0,
            target_speed: 0.0,
            target_mach: None,
            alt_capture_from: 0.0,
            lever_i: 0.5,
            pitch_i: 0.0,
            disconnect: None,
        }
    }
}

/// The autopilot's hands on the controls, and the autothrust's on the levers (when they are engaged).
pub struct Out {
    pub input: Option<Input>,
    pub lever: Option<f32>,
}

fn smooth(x: f32, limit: f32) -> f32 {
    x.clamp(-limit, limit)
}

impl Autoflight {
    /// Commands from the flight control unit (the panel, or the keys): `{fcu: "ap" | "athr" | "loc" | "appr" | "spd" |
    /// "hdg" | "alt" | "vs" | "spdPush" | "hdgPush" | "altPush" | "altPull" | "vsPush", value?}`.
    pub fn command(&mut self, cmd: &Value, s: &Sense, has_route: bool, ty: &Type) {
        let what = cmd.get("fcu").and_then(Value::as_str).unwrap_or_default();
        let value = cmd.get("value").and_then(Value::as_f64).map(|v| v as f32);
        let delta = cmd.get("delta").and_then(Value::as_f64).map(|v| v as f32);
        let f = &mut self.fcu;
        match what {
            "ap" => {
                if f.ap {
                    self.disconnect = Some(("AP OFF", 0.0));
                }
                f.ap = !f.ap && !s.on_ground;
                if f.ap && self.lat == Lat::Off {
                    self.engage_basic(s, has_route);
                }
            }
            "athr" => f.athr = !f.athr && ty.law == Law::FlyByWire,
            "fd" => f.fd = !f.fd,
            "loc" => {
                f.loc = !f.loc;
                f.appr = false;
                self.lat_armed = f.loc.then_some(Lat::LocStar);
            }
            "appr" => {
                f.appr = !f.appr;
                f.loc = f.appr;
                self.lat_armed = f.appr.then_some(Lat::LocStar);
                if !f.appr && matches!(self.vert_armed, Some(Vert::GsStar)) {
                    self.vert_armed = None;
                }
            }
            "spd" => {
                f.spd = value.unwrap_or(f.spd + delta.unwrap_or(0.0)).clamp(90.0, 400.0).round();
                if delta.is_some() && f.spd_managed {
                    f.spd = s.ias.round();
                }
                f.spd_managed = false;
            }
            "spdPush" => f.spd_managed = true,
            "hdg" => {
                let base = if self.lat == Lat::Hdg { f.hdg } else { s.heading.to_degrees() };
                f.hdg = value.unwrap_or(base + delta.unwrap_or(0.0)).rem_euclid(360.0).round();
            }
            "hdgPull" => {
                if !matches!(self.lat, Lat::Loc | Lat::Rollout) {
                    self.lat = Lat::Hdg;
                }
            }
            "hdgPush" => {
                if has_route {
                    self.lat = Lat::Nav;
                }
            }
            "alt" => f.alt = value.unwrap_or(f.alt + delta.unwrap_or(0.0)).clamp(0.0, ty.ceiling).round(),
            // Pulled: open climb or descent to the selected altitude, speed on pitch.
            "altPull" => {
                if !matches!(self.vert, Vert::Gs | Vert::Flare | Vert::Rollout) {
                    self.vert = if f.alt > s.alt { Vert::OpClb } else { Vert::OpDes };
                    self.alt_capture_from = s.alt;
                }
            }
            // Pushed: managed climb or descent along the plan.
            "altPush" => {
                if !matches!(self.vert, Vert::Gs | Vert::Flare | Vert::Rollout) {
                    self.vert = if f.alt > s.alt { Vert::Clb } else { Vert::Des };
                    self.alt_capture_from = s.alt;
                }
            }
            "vs" => {
                f.vs = value.unwrap_or(f.vs + delta.unwrap_or(0.0)).clamp(-6_000.0, 6_000.0).round();
                if !matches!(self.vert, Vert::Gs | Vert::Flare | Vert::Rollout) {
                    self.vert = Vert::Vs;
                }
            }
            "vsPush" => {
                f.vs = 0.0;
                self.vert = Vert::Vs;
            }
            // A light aircraft's ALT button: hold the altitude it is at.
            "altHold" => {
                f.alt = (s.alt / 10.0).round() * 10.0;
                self.vert = Vert::Alt;
            }
            _ => {}
        }
    }

    /// The autopilot engaged with no mode active: hold the heading (or fly the plan) and the vertical speed.
    fn engage_basic(&mut self, s: &Sense, has_route: bool) {
        self.lat = if has_route { Lat::Nav } else { Lat::Hdg };
        if self.lat == Lat::Hdg {
            self.fcu.hdg = s.heading.to_degrees().round();
        }
        if matches!(self.vert, Vert::Off | Vert::Srs) {
            self.vert = Vert::Vs;
            self.fcu.vs = (s.vs / 100.0).round() * 100.0;
        }
    }

    /// Go-around: take-off pitch (SRS) and thrust, the approach modes dropped, and back along the plan (`has_route`) or
    /// on the heading flown.
    pub fn go_around(&mut self, s: &Sense, has_route: bool, alt: f32) {
        self.vert = Vert::Srs;
        self.lat = if has_route { Lat::Nav } else { Lat::Hdg };
        self.fcu.hdg = s.heading.to_degrees().round();
        self.fcu.appr = false;
        self.fcu.loc = false;
        self.lat_armed = None;
        self.vert_armed = None;
        self.fcu.alt = alt;
        self.fcu.spd_managed = true;
        if self.fcu.athr {
            self.thr = Thr::Armed;
        }
    }

    /// Takes the controls back from the autopilot (the stick moved, or the pilot pressed the button).
    pub fn disconnect_ap(&mut self, why: &'static str) {
        if self.fcu.ap {
            self.fcu.ap = false;
            self.disconnect = Some((why, 0.0));
        }
    }

    /// One frame: mode changes, then the laws. `lnav` and `ils` are the guidance there is (a plan, a runway).
    #[allow(clippy::too_many_arguments)]
    pub fn update(&mut self, ty: &Type, s: &Sense, m: &Managed, lnav: Option<&Lnav>, ils: Option<&Ils>, vapp: f32, v2: f32, runway_course: Option<f32>, dt: f32) -> Out {
        if let Some((_, t)) = self.disconnect.as_mut() {
            *t += dt;
            if *t > 6.0 {
                self.disconnect = None;
            }
        }
        let f = self.fcu.clone();
        let fbw = ty.law == Law::FlyByWire;

        // ---- mode logic ----
        if s.on_ground {
            match self.vert {
                // Rolled out: stays until the pilot takes over.
                Vert::Rollout | Vert::Flare => self.vert = Vert::Rollout,
                // Take-off thrust set: SRS and runway track, the autothrust armed.
                _ if s.lever > 0.85 && s.ias > 30.0 => {
                    self.vert = Vert::Srs;
                    self.lat = Lat::Rwy;
                    self.fcu.alt = self.fcu.alt.max(s.alt + 1_000.0);
                    if fbw && f.athr {
                        self.thr = Thr::Armed;
                    }
                }
                _ => {}
            }
            if self.lat == Lat::Loc || self.lat == Lat::Rollout {
                self.lat = Lat::Rollout;
            }
        } else {
            if self.lat == Lat::Rwy && s.ra > 30.0 {
                self.lat = if lnav.is_some() { Lat::Nav } else { Lat::Hdg };
                if self.lat == Lat::Hdg {
                    self.fcu.hdg = s.heading.to_degrees().round();
                }
            }
            // Thrust reduction at 1,500 ft: the autothrust takes the climb thrust, and SRS gives way to the climb.
            if s.ra > 1_500.0 && self.vert == Vert::Srs {
                self.vert = if lnav.is_some() { Vert::Clb } else { Vert::OpClb };
                self.alt_capture_from = s.alt;
                if fbw && f.athr {
                    self.thr = Thr::Clb;
                }
            }
            if self.thr == Thr::Armed && fbw && f.athr && s.ra > 1_500.0 {
                self.thr = Thr::Speed;
            }
            // Altitude capture: close enough to the selected (or, managed, the cruise) altitude to round out onto it.
            let to_go = f.alt - s.alt;
            let closing = matches!(self.vert, Vert::Clb | Vert::OpClb | Vert::Vs | Vert::Des | Vert::OpDes) && to_go * s.vs > 0.0;
            if closing && to_go.abs() < (s.vs.abs() / 60.0 * 8.0).max(60.0) && self.vert != Vert::Vs
                || self.vert == Vert::Vs && to_go.abs() < (s.vs.abs() / 60.0 * 8.0).max(60.0) && to_go * s.vs > 0.0
            {
                self.vert = Vert::AltStar;
            }
            if self.vert == Vert::AltStar && to_go.abs() < 25.0 && s.vs.abs() < 300.0 {
                self.vert = Vert::Alt;
            }
            // Localizer and glide slope capture.
            if let Some(i) = ils.filter(|i| i.loc_valid) {
                if matches!(self.lat_armed, Some(Lat::LocStar)) && i.loc.abs() < 1.8 && !matches!(self.lat, Lat::Loc | Lat::LocStar) {
                    self.lat = Lat::LocStar;
                    self.lat_armed = None;
                    if f.appr {
                        self.vert_armed = Some(Vert::GsStar);
                    }
                }
                if self.lat == Lat::LocStar && i.loc.abs() < 0.25 && wrap(f64::from(s.track) - i.course).abs() < 0.2 {
                    self.lat = Lat::Loc;
                }
                if matches!(self.vert_armed, Some(Vert::GsStar)) && i.gs_valid && i.gs.abs() < 1.0 && matches!(self.lat, Lat::Loc | Lat::LocStar) {
                    self.vert = Vert::GsStar;
                    self.vert_armed = None;
                }
                if self.vert == Vert::GsStar && i.gs.abs() < 0.25 {
                    self.vert = Vert::Gs;
                }
            }
            if f.appr && self.lat_armed.is_none() && !matches!(self.lat, Lat::Loc | Lat::LocStar | Lat::Rollout) {
                self.lat_armed = Some(Lat::LocStar);
            }
            if self.vert == Vert::Gs && s.ra < 50.0 {
                self.vert = Vert::Flare;
            }
            if self.vert == Vert::Flare && s.ra < 20.0 && self.thr != Thr::Off {
                self.thr = Thr::Retard;
            }
        }
        if !fbw || !self.fcu.athr {
            self.thr = if self.fcu.athr && fbw { self.thr } else { Thr::Off };
        } else if self.thr == Thr::Off {
            self.thr = if s.on_ground { Thr::Armed } else { Thr::Speed };
        }
        // Speed on pitch in the open and managed climbs and descents; the autothrust sets the thrust then.
        if self.fcu.athr && fbw && !s.on_ground {
            self.thr = match self.vert {
                Vert::Clb | Vert::OpClb => Thr::Clb,
                Vert::Des | Vert::OpDes => Thr::Idle,
                Vert::Srs => Thr::Armed,
                Vert::Flare if self.thr == Thr::Retard => Thr::Retard,
                _ => {
                    if m.mach.is_some() && f.spd_managed {
                        Thr::Mach
                    } else {
                        Thr::Speed
                    }
                }
            };
        }
        if s.on_ground && self.vert == Vert::Rollout {
            self.thr = if self.fcu.athr { Thr::Idle } else { Thr::Off };
        }

        // ---- targets ----
        let approach = matches!(self.vert, Vert::Gs | Vert::GsStar | Vert::Flare) || matches!(self.lat, Lat::Loc) && ils.is_some_and(|i| i.dist < 8.0 * 1852.0);
        self.target_mach = None;
        self.target_speed = match self.vert {
            Vert::Srs => v2 + 10.0,
            _ if approach => vapp,
            _ if f.spd_managed => {
                self.target_mach = m.mach;
                m.speed
            }
            _ => f.spd,
        };
        let target_ias = match self.target_mach {
            Some(mach) if s.mach > 0.1 => s.ias * mach / s.mach,
            _ => self.target_speed,
        };

        // ---- lateral law: a track (or a bank) to fly ----
        let bank_limit: f32 = 0.44;
        let track_cmd = match self.lat {
            Lat::Rwy => runway_course,
            Lat::Hdg => None,
            Lat::Nav => lnav.map(|l| l.track_cmd as f32),
            Lat::LocStar | Lat::Loc | Lat::Rollout => ils.map(|i| (i.course - (i.xtk / (f64::from(s.tas).max(40.0) * 18.0)).atan().clamp(-0.6, 0.6)) as f32),
            Lat::Off => None,
        };
        let bank_cmd = match self.lat {
            Lat::Hdg => smooth(wrap(f64::from(f.hdg.to_radians() - s.heading)) as f32 * 2.0, bank_limit),
            Lat::Off => 0.0,
            Lat::Rollout => 0.0,
            _ => track_cmd.map_or(0.0, |t| smooth(wrap(f64::from(t - s.track)) as f32 * 2.2, bank_limit)),
        };
        self.fd_bank = bank_cmd;

        // ---- vertical law: a flight path angle to fly ----
        let tas = s.tas.max(30.0);
        let fpa_of_vs = |vs_fpm: f32| (vs_fpm / FT / 60.0 / tas).clamp(-0.3, 0.3).asin();
        // Speed on pitch: change the path by the acceleration the speed error asks for (a total energy law).
        let speed_on_pitch = |target: f32| {
            let want = ((target - s.ias) / KT * 0.12).clamp(-1.0, 1.0);
            s.fpa + (s.accel - want) / 9.81
        };
        let alt_hold = |alt: f32| fpa_of_vs(((alt - s.alt) * 2.0).clamp(-1_500.0, 1_500.0));
        let fpa_cmd = match self.vert {
            Vert::Srs => speed_on_pitch(target_ias).clamp(0.02, 0.3).min(ty.srs_pitch - s.alpha),
            Vert::Clb | Vert::OpClb => speed_on_pitch(target_ias).clamp(0.0, 0.25),
            Vert::Des => {
                // Managed descent: the path while above it, speed on pitch at idle; below it, a shallow descent.
                // On the path (or below it) follow it, unless fast: then shallower, to slow down (idle thrust).
                match m.path {
                    Some(path) if s.alt < path + 150.0 => {
                        let on_path = fpa_of_vs(m.path_vs + (path - s.alt) * 2.0).clamp(-0.1, 0.0);
                        if s.ias > target_ias + 8.0 { on_path.max(speed_on_pitch(target_ias).min(0.0)) } else { on_path }
                    }
                    _ => speed_on_pitch(target_ias).clamp(-0.15, 0.0),
                }
                .max(fpa_of_vs(-6_000.0))
                .max(if s.alt - f.alt < 1_000.0 { alt_hold(f.alt) } else { -1.0 })
            }
            Vert::OpDes => speed_on_pitch(target_ias).clamp(-0.15, 0.0),
            Vert::AltStar | Vert::Alt => alt_hold(f.alt),
            Vert::Vs => fpa_of_vs(f.vs),
            // The glide path's sink rate for the ground speed, corrected by the height off it (below: sink less).
            Vert::GsStar | Vert::Gs => ils.map_or(s.fpa, |i| {
                let below = (i.gs * GS_DOT.to_radians() * (i.dist + 300.0).max(100.0)) as f32;
                fpa_of_vs((-(f64::from(s.tas) * GLIDE.tan()) as f32 + below * 0.12) * FT * 60.0)
            }),
            // The flare: sink ever more slowly toward the runway (in proportion to the height left), touching down at
            // about 2 ft/s.
            Vert::Flare => fpa_of_vs(-(s.ra / FT * 0.28 + 0.3).min(-s.vs / FT / 60.0) * FT * 60.0),
            Vert::Rollout => 0.0,
            Vert::Off => s.fpa,
        };
        self.fd_pitch = (fpa_cmd - s.fpa).clamp(-0.2, 0.2);

        // ---- autothrust ----
        let max_lever = if matches!(ty.engine, super::types::Engine::Fan { thrust_ab, .. } if thrust_ab > 0.0) { 0.9 } else { 1.0 };
        let lever = match self.thr {
            Thr::Off | Thr::Armed => None,
            Thr::Clb => Some(0.86 * max_lever),
            Thr::Idle | Thr::Retard => Some(0.0),
            Thr::Speed | Thr::Mach => {
                let err = (target_ias - s.ias) / KT;
                self.lever_i = (self.lever_i + err * 0.004 * dt).clamp(0.0, max_lever);
                Some((self.lever_i + err * 0.04 - s.accel * 0.12).clamp(0.0, max_lever))
            }
        };
        // Alpha floor: close to the stall, take-off thrust whatever the mode.
        let lever = if self.fcu.athr && fbw && !s.on_ground && s.alpha > s.alpha_stall - 0.02 { Some(1.0 * max_lever) } else { lever };
        if lever.is_none() {
            self.lever_i = s.lever;
        }

        // ---- the autopilot's hands ----
        let input = self.fcu.ap.then(|| {
            let pitch = if fbw {
                let q_up = ty.pitch_rate.min(ty.g_max * 9.81 / tas);
                let gain = if self.vert == Vert::Flare { 1.6 } else { 0.7 };
                ((fpa_cmd - s.fpa) * gain / q_up).clamp(-0.45, 0.6)
            } else {
                // Cables: the stick sets the angle of attack, so an integrator finds the trim.
                self.pitch_i = (self.pitch_i + (fpa_cmd - s.fpa) * 0.6 * dt).clamp(-0.6, 0.6);
                ((fpa_cmd - s.fpa) * 3.0 + self.pitch_i).clamp(-0.6, 0.6)
            };
            let roll = if s.on_ground { 0.0 } else { ((bank_cmd - s.bank) * 3.0).clamp(-0.8, 0.8) };
            // Rudder: on the runway, the centreline; in the flare, the de-crab onto the runway's heading.
            let yaw = match (self.lat, runway_course, ils) {
                // Pedal left (positive) turns left: toward the centreline from its right, back from a heading right of the
                // runway's.
                (Lat::Rollout, _, Some(i)) => {
                    let off = wrap(f64::from(s.heading) - i.course) as f32;
                    (off * 6.0 + (i.xtk as f32) * 0.05).clamp(-1.0, 1.0)
                }
                (_, _, Some(i)) if self.vert == Vert::Flare && s.ra < 35.0 => (wrap(f64::from(s.heading) - i.course) as f32 * 4.0).clamp(-1.0, 1.0),
                _ => 0.0,
            };
            Input { pitch: if self.vert == Vert::Rollout { 0.0 } else { pitch }, roll, yaw, tiller: 0.0 }
        });
        Out { input, lever: if self.fcu.athr && fbw { lever } else { None } }
    }

    pub fn to_json(&self) -> Value {
        let lat = match self.lat {
            Lat::Off => "",
            Lat::Rwy => "RWY",
            Lat::Hdg => "HDG",
            Lat::Nav => "NAV",
            Lat::LocStar => "LOC*",
            Lat::Loc => "LOC",
            Lat::Rollout => "ROLL OUT",
        };
        let vert = match self.vert {
            Vert::Off => "",
            Vert::Srs => "SRS",
            Vert::Clb => "CLB",
            Vert::Des => "DES",
            Vert::OpClb => "OP CLB",
            Vert::OpDes => "OP DES",
            Vert::AltStar => "ALT*",
            Vert::Alt => "ALT",
            Vert::Vs => "V/S",
            Vert::GsStar => "G/S*",
            Vert::Gs => "G/S",
            Vert::Flare => "FLARE",
            Vert::Rollout => "ROLL OUT",
        };
        let thr = match self.thr {
            Thr::Off => "",
            Thr::Armed => "A/THR",
            Thr::Speed => "SPEED",
            Thr::Mach => "MACH",
            Thr::Clb => "THR CLB",
            Thr::Idle => "THR IDLE",
            Thr::Retard => "RETARD",
        };
        let armed = |a: Option<Lat>| match a {
            Some(Lat::LocStar) => "LOC",
            Some(Lat::Nav) => "NAV",
            _ => "",
        };
        json!({
            "ap": self.fcu.ap, "athr": self.fcu.athr, "fd": self.fcu.fd, "loc": self.fcu.loc, "appr": self.fcu.appr,
            "spd": self.fcu.spd, "spdManaged": self.fcu.spd_managed, "hdg": self.fcu.hdg, "alt": self.fcu.alt, "vs": self.fcu.vs,
            "lat": lat, "vert": vert, "thr": thr, "latArmed": armed(self.lat_armed), "vertArmed": if matches!(self.vert_armed, Some(Vert::GsStar)) { "G/S" } else { "" },
            "fdPitch": self.fd_pitch, "fdBank": self.fd_bank, "target": self.target_speed, "targetMach": self.target_mach,
            "disconnect": self.disconnect.map(|(w, _)| w),
        })
    }
}

#[cfg(test)]
mod tests {
    use bevy::prelude::*;
    use serde_json::json;

    use super::super::airport::Runway;
    use super::super::model::{self, Aircraft, Env, Event};
    use super::super::nav;
    use super::super::types::{AIRLINER, FT, KT};
    use super::*;
    use crate::physics::attitude;

    const LAT0: f64 = 50.0;
    const TRACE: bool = false;
    const LON0: f64 = 8.0;

    /// A flat world around (LAT0, LON0): x east, z south, y the altitude.
    fn lat_lon(p: Vec3) -> nav::LatLon {
        (LAT0 - f64::from(p.z) / nav::EARTH_RADIUS * 57.295_78, LON0 + f64::from(p.x) / (nav::EARTH_RADIUS * LAT0.to_radians().cos()) * 57.295_78)
    }

    fn runway() -> Runway {
        // 3,000 m due east from (LAT0, LON0), at sea level.
        let east = nav::destination((LAT0, LON0), std::f64::consts::FRAC_PI_2, 3_000.0);
        Runway::from_json(&json!({
            "icao": "TEST", "width_ft": 148.0,
            "a": { "ident": "09", "lat": LAT0, "lon": LON0, "elev_ft": 0.0 },
            "b": { "ident": "27", "lat": east.0, "lon": east.1, "elev_ft": 0.0 },
        }))
        .unwrap()
    }

    /// From a 30° intercept 10 NM out at 3,000 ft, APPR armed: returns the touchdown and where the aircraft stopped.
    fn autoland(wind: Vec3) -> (Event, Vec3) {
        let rwy = runway();
        let mut ac = Aircraft::new(&AIRLINER, 5_000.0, 12_000.0, false);
        ac.flap_lever = 5;
        ac.flap = 5.0;
        ac.gear_lever = true;
        ac.gear = 1.0;
        ac.spoilers_armed = true;
        ac.autobrake = 1;
        ac.n1 = 0.6;
        ac.lever = 0.45;
        let vs = AIRLINER.vspeeds(ac.mass(), 0.0);
        // 10 NM west, 1.5 km south of the centreline, heading 060 to intercept.
        let hdg = 60f32.to_radians();
        let mut tf = Transform::from_xyz(-18_520.0, 914.0, 1_500.0).with_rotation(Quat::from_rotation_y(-hdg));
        let mut v = Vec3::new(hdg.sin(), 0.0, -hdg.cos()) * (vs.vapp + 10.0) / KT;
        let mut w = Vec3::ZERO;
        let mut af = Autoflight::default();
        af.fcu.ap = true;
        af.fcu.athr = true;
        af.fcu.appr = true;
        af.fcu.loc = true;
        af.fcu.alt = 3_000.0;
        af.fcu.hdg = 60.0;
        af.lat = Lat::Hdg;
        af.vert = Vert::Alt;
        af.thr = Thr::Speed;
        af.lat_armed = Some(Lat::LocStar);
        let dt = 0.02;
        let mut last_speed = v.length();
        let mut touchdown = None;
        for step_i in 0..(900.0 / dt) as usize {
            let p = lat_lon(tf.translation);
            let air = v - wind;
            let (pitch, bank) = attitude(tf.rotation);
            let fwd = tf.rotation * Vec3::NEG_Z;
            let speed = v.length();
            let accel = (speed - last_speed) / dt;
            last_speed = speed;
            let s = Sense {
                ias: ac.eas * KT,
                tas: air.length(),
                mach: air.length() / 340.0,
                alt: tf.translation.y * FT,
                vs: v.y * FT * 60.0,
                ra: (tf.translation.y * FT).max(0.0),
                fpa: (v.y / speed.max(1.0)).asin(),
                track: v.x.atan2(-v.z).rem_euclid(std::f32::consts::TAU),
                heading: fwd.x.atan2(-fwd.z).rem_euclid(std::f32::consts::TAU),
                bank,
                pitch,
                alpha: 0.0,
                alpha_stall: 0.3,
                accel,
                on_ground: ac.on_ground,
                lever: ac.lever,
            };
            let ils = nav::ils(&rwy, p, f64::from(tf.translation.y));
            let out = af.update(&AIRLINER, &s, &Managed { speed: vs.vapp, ..default() }, None, Some(&ils), vs.vapp, vs.v2, None, dt);
            if TRACE && (step_i % 250 == 0) {
                eprintln!("t={:.0} x={:.0} z={:.0} y={:.0} ias={:.0} {:?} {:?} {:?} loc={:.2} gs={:.2} vs={:.0} stick={:?} fdp={:.3} fpa={:.3} pitch={:.3} nz={:.2}", step_i as f32 * dt, tf.translation.x, tf.translation.z, tf.translation.y, s.ias, af.lat, af.vert, af.thr, ils.loc, ils.gs, s.vs, out.input.map(|i| i.pitch), af.fd_pitch, s.fpa, s.pitch, ac.nz);
            }
            let input = out.input.map(|i| model::Input { tiller: i.yaw, ..i }).unwrap_or_default();
            ac.lever = out.lever.unwrap_or(ac.lever);
            let env = Env { wind, alt: tf.translation.y, ground: 0.0, bottom: 0.0 };
            model::step(&mut ac, &mut tf, &mut v, &mut w, input, env, dt);
            for e in ac.events.drain(..) {
                match e {
                    Event::Touchdown { .. } => touchdown = Some((e, tf.translation)),
                    Event::Crash(why) => panic!("{why} at {:?}, {:?} {:?}", tf.translation, af.lat, af.vert),
                    _ => {}
                }
            }
            if ac.on_ground && v.length() < 3.0 {
                break;
            }
        }
        let (e, at) = touchdown.unwrap_or_else(|| panic!("never landed: {:?} {:?} {:?}", tf.translation, af.lat, af.vert));
        eprintln!("touchdown {e:?} at {at:?}; stopped at {:?}, modes {:?} {:?}, speed {}", tf.translation, af.lat, af.vert, v.length());
        assert_eq!(af.lat, Lat::Rollout);
        (e, at)
    }

    fn check(e: Event, at: Vec3) {
        let Event::Touchdown { sink, bank, .. } = e else { unreachable!() };
        let fpm = sink * FT * 60.0;
        assert!(fpm < 360.0, "sink {fpm} fpm");
        assert!(bank.abs() < 0.07, "bank {}", bank.to_degrees());
        // 300 m past the threshold is the aim; within the touchdown zone.
        assert!((100.0..900.0).contains(&at.x), "touched down {} m past the threshold", at.x);
        assert!(at.z.abs() < 6.0, "{} m off the centreline", at.z);
    }

    /// The light single's autopilot (no autothrust): a 90° turn onto a selected heading holding 3,000 ft.
    #[test]
    fn light_single_turns_and_holds_altitude() {
        use super::super::types::C172;
        let mut ac = Aircraft::new(&C172, 100.0, 200.0, false);
        ac.lever = 0.7;
        ac.n1 = 0.8;
        let mut tf = Transform::from_xyz(0.0, 914.0, 0.0);
        let mut v = Vec3::NEG_Z * 50.0;
        let mut w = Vec3::ZERO;
        let mut af = Autoflight::default();
        af.fcu.ap = true;
        af.fcu.athr = false;
        af.fcu.alt = 3_000.0;
        af.fcu.hdg = 90.0;
        af.lat = Lat::Hdg;
        af.vert = Vert::Alt;
        let dt = 0.02;
        let mut worst: f32 = 0.0;
        for i in 0..(150.0 / dt) as usize {
            let (pitch, bank) = attitude(tf.rotation);
            let fwd = tf.rotation * Vec3::NEG_Z;
            let speed = v.length();
            let s = Sense {
                ias: ac.eas * KT,
                tas: speed,
                mach: speed / 340.0,
                alt: tf.translation.y * FT,
                vs: v.y * FT * 60.0,
                ra: 3_000.0,
                fpa: (v.y / speed.max(1.0)).asin(),
                track: v.x.atan2(-v.z).rem_euclid(std::f32::consts::TAU),
                heading: fwd.x.atan2(-fwd.z).rem_euclid(std::f32::consts::TAU),
                bank,
                pitch,
                alpha: 0.0,
                alpha_stall: 0.3,
                accel: 0.0,
                on_ground: false,
                lever: ac.lever,
            };
            let out = af.update(&C172, &s, &Managed::default(), None, None, 65.0, 75.0, None, dt);
            assert!(out.lever.is_none(), "no autothrust in a light single");
            let env = Env { wind: Vec3::ZERO, alt: tf.translation.y, ground: -1e6, bottom: 0.0 };
            model::step(&mut ac, &mut tf, &mut v, &mut w, out.input.unwrap(), env, dt);
            if i as f32 * dt > 20.0 {
                worst = worst.max((tf.translation.y * FT - 3_000.0).abs());
            }
        }
        let fwd = tf.rotation * Vec3::NEG_Z;
        let hdg = fwd.x.atan2(-fwd.z).to_degrees().rem_euclid(360.0);
        assert!((hdg - 90.0).abs() < 4.0, "heading {hdg}");
        assert!(worst < 120.0, "altitude off by up to {worst} ft");
    }

    #[test]
    fn autolands_in_calm_air() {
        let (e, at) = autoland(Vec3::ZERO);
        check(e, at);
    }

    #[test]
    fn autolands_in_a_crosswind() {
        // 15 kt from the south (a right crosswind for runway 09).
        let (e, at) = autoland(Vec3::new(0.0, 0.0, -7.7));
        check(e, at);
    }
}
